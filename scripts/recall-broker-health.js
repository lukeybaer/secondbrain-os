#!/usr/bin/env node
'use strict';
// Recall Broker health probe (ExampleCo 2026-07-06: "add a metric in health checks
// so it never breeches and I can forget about the monitoring for cost").
// Surfaces the cost governor and endpoint health as a SYSTEM HEALTH row.
// Enforcement lives in the hook's spend path (recall-broker-inject.mjs);
// this probe is visibility: burn, throttle state, circuit state, and a
// fail-closed auth canary on the EC2 side. Design:
// memory/project_graphiti_prompt_time_retrieval.md.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const SOFT_TOKEN_CAP_PER_DAY = 100_000;
const HARD_TOKEN_CAP_PER_DAY = 250_000;

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readJsonlToday(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const day = today();
    return fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e) => e && String(e.ts || '').slice(0, 10) === day);
  } catch {
    return [];
  }
}

function fireThrottleAlertOnce(stateFile, state) {
  try {
    const { notifyWithFallback } = require('./lib/notify-with-fallback');
    state.alertPending = false;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    Promise.resolve(
      notifyWithFallback({
        text:
          'Recall Broker hit the 250k tokens/day hard cap and auto-throttled to static context until midnight CT. ' +
          'No action needed; injection resumes on the daily reset. Tune budgets in scripts/claude-hooks/recall-broker-inject.mjs if this recurs.',
        source: 'recall-broker-health',
        priority: 'normal',
        kind: 'security',
      }),
    ).catch(() => {});
  } catch {
    /* alerting is best-effort; the RED row still surfaces it */
  }
}

// Authenticated sealed round-trip against the production endpoint, sync so
// getHealthChecks() can call it inline. Proves the WHOLE read path (seal ->
// auth -> retrieval -> sealed response -> open), not just the 401 canary
// (Codex review 2026-07-06 #7). Injectable for tests.
function sealedRoundTrip(keyFile, endpoint) {
  try {
    const rbCrypto = require('./lib/recall-broker-crypto');
    const key = rbCrypto.deriveKey(fs.readFileSync(keyFile, 'utf8'));
    const envelope = rbCrypto.seal(key, { query: 'health canary round-trip', limit: 1, timeoutMs: 800, rid: `health-${Date.now()}` });
    const tmp = path.join(os.tmpdir(), `rb-canary-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(envelope));
    const started = Date.now();
    let raw;
    try {
      raw = execSync(`curl -s -m 6 -X POST -H "Content-Type: application/json" -d @"${tmp}" ${endpoint}`, {
        encoding: 'utf8',
        timeout: 10000,
      });
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
    const opened = rbCrypto.open(key, JSON.parse(raw));
    if (!opened.ok) return { ok: false, reason: `response envelope ${opened.reason}` };
    return { ok: true, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, reason: String(e.message || e).slice(0, 80) };
  }
}

function probeRecallBrokerHealth({
  home = os.homedir(),
  serverLedgerDir = '/opt/secondbrain/data/agent',
  runSync = execSync,
  endpoint = process.env.SB_RECALL_BROKER_URL || 'http://ExampleCo:3001/amy/memory/query',
  roundTrip = sealedRoundTrip,
} = {}) {
  const problems = [];
  const parts = [];
  let sawAnySide = false;

  // Client side (the PC running Claude Code hooks).
  const stateDir = path.join(home, '.secondbrain');
  const stateFile = path.join(stateDir, 'recall-broker-state.json');
  const keyFile = path.join(stateDir, 'recall-broker.key');
  if (fs.existsSync(stateDir) && (fs.existsSync(keyFile) || fs.existsSync(stateFile))) {
    sawAnySide = true;
    const entries = readJsonlToday(path.join(stateDir, 'recall-broker-usage.jsonl'));
    const injected = entries.filter((e) => e.outcome === 'injected' || e.outcome === 'cache');
    const errors = entries.filter((e) => e.outcome === 'error');
    const tokens = injected.reduce((s, e) => s + (e.tokens || 0), 0);
    let state = {};
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {}
    if (!fs.existsSync(keyFile)) problems.push({ status: 'yellow', why: 'no key on this machine, hook cannot query' });
    if (state.day === today() && state.throttled) {
      problems.push({ status: 'red', why: `auto-throttled at hard cap (${HARD_TOKEN_CAP_PER_DAY / 1000}k tokens/day)` });
      if (state.alertPending) fireThrottleAlertOnce(stateFile, state);
    } else if (tokens > SOFT_TOKEN_CAP_PER_DAY) {
      problems.push({ status: 'yellow', why: `soft cap passed: ${Math.round(tokens / 1000)}k tokens today` });
    }
    if ((state.circuitFailures || 0) >= 3) {
      problems.push({ status: 'red', why: `endpoint failing, circuit open (${state.circuitFailures} consecutive errors)` });
    }
    parts.push(`PC: ${injected.length} injections, ${Math.round(tokens / 1000)}k tokens, ${errors.length} errors today`);
    // Full authenticated round-trip from this machine to production: proves
    // the read path end to end, not just that nothing failed locally today.
    if (fs.existsSync(keyFile)) {
      const rt = roundTrip(keyFile, endpoint);
      if (rt.ok) parts.push(`round-trip ${rt.ms}ms`);
      else problems.push({ status: 'red', why: `endpoint round-trip failed: ${rt.reason}` });
    }
  }

  // Server side (EC2). Auth canary: an empty unauthenticated POST must be
  // rejected 401 (fail-closed working). 503 means the key is missing server
  // side; anything else means the route or listener is broken.
  if (fs.existsSync(serverLedgerDir)) {
    sawAnySide = true;
    const entries = readJsonlToday(path.join(serverLedgerDir, 'recall-broker-usage.jsonl'));
    const p95src = entries.map((e) => e.latency_ms || 0).sort((a, b) => a - b);
    const p95 = p95src.length ? p95src[Math.floor(p95src.length * 0.95)] : 0;
    parts.push(`EC2: ${entries.length} queries served today${entries.length ? `, p95 ${p95}ms` : ''}`);
    try {
      const code = String(
        runSync("curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST -d '{}' http://localhost:3001/amy/memory/query", {
          encoding: 'utf8',
          timeout: 8000,
        }),
      ).replace(/[^0-9]/g, '');
      if (code === '503') problems.push({ status: 'red', why: 'RECALL_BROKER_KEY missing on server (route fail-closed, hook gets nothing)' });
      else if (code !== '401') problems.push({ status: 'red', why: `auth canary expected 401, got ${code || 'no response'}` });
    } catch {
      problems.push({ status: 'red', why: 'auth canary could not reach localhost:3001' });
    }
  }

  if (!sawAnySide) {
    return { status: 'yellow', detail: 'Recall Broker: no state found on this machine (not yet configured here)' };
  }
  const status = problems.some((p) => p.status === 'red') ? 'red' : problems.some((p) => p.status === 'yellow') ? 'yellow' : 'green';
  const detail =
    `Recall Broker: ${parts.join(' · ')}` + (problems.length ? ` · ${problems.map((p) => p.why).join('; ')}` : ' · governor green');
  return { status, detail, problems: problems.map((p) => p.why) };
}

if (require.main === module) {
  console.log(JSON.stringify(probeRecallBrokerHealth(), null, 2));
}

module.exports = { probeRecallBrokerHealth, SOFT_TOKEN_CAP_PER_DAY, HARD_TOKEN_CAP_PER_DAY };
