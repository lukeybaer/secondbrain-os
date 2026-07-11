// scripts/lib/ask-ai.js
//
// THE universal LLM ladder for all Amy text processing (ExampleCo's 2026-06-11
// policy, plan: dev-plans/llm-fallback-ladder-2026-06-11.html, Codex-reviewed;
// charged-floor policy updated per ExampleCo's 2026-07-11 voice dispatch).
//
// Rung order (defaultRungOrder):
//   1. codex         -- OpenAI subscription (Codex CLI), independent vendor
//   2. claude-proxy  -- Claude Max via the laptop SSH-tunnel proxy
//   3. claude-cli    -- Claude Max via the local `claude -p` CLI
//   4. bedrock       -- AWS Bedrock funded $20/mo lane (only where configured)
//   5. anthropic-api -- Anthropic API key floor (only if key set)
//   6. openai-api    -- OpenAI API key floor, standing-authorized charged floor
//
// Hard requirement: no surface dead when the Claude subscription is down.
// Therefore: every rung failure (null, throw, or sentinel auth-error output)
// DESCENDS to the next rung; BrainUnreachable throws only when ALL rungs fail.
// Charged floor policy (ExampleCo 2026-07-11 voice dispatch, "if it costs $10 to
// get the daily briefing, then do it"):
//   - openai-api runs under STANDING authorization once Codex is proven down
//     in this call path. Per-call approval (opts.allowChargedLlmApi) is
//     RETIRED for this rung (still accepted for backward compat, no longer
//     gates it); it is superseded by HARD caps enforced before the call:
//     $30 per CT month and $10 per night, night = the America/Chicago
//     calendar day (OPENAI_API_MONTHLY_CAP_USD / OPENAI_API_NIGHTLY_CAP_USD).
//   - anthropic-api and bedrock keep the old contract: Codex-down proof AND
//     per-call ExampleCo approval (opts.allowChargedLlmApi === true).
// The OpenAI provider canary is the separate approved diagnostic probe;
// answer generation is never allowed to burn paid API usage silently.
//
// Runs on EC2 and the PC (pure Node builtins). Surfaces inject per-call
// options; tests inject rung fns directly.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const https = require('node:https');
const { isCliFailureOutput, buildClaudeCliEnv } = require('./cli-output-guard.js');
const { withTransientRetry, isTransientError } = require('./transient-error.js');
const { withCodexAmyPrelude } = require('./codex-amy-prelude.js');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..');
const ATTEMPT_LOG = path.join(REPO, 'data', 'agent', 'ask-ai-rungs.jsonl');
const SPEND_FILE = path.join(REPO, 'data', 'agent', 'openai-api-spend.json');
const OPENAI_MONTHLY_CAP_USD = Number(process.env.OPENAI_API_MONTHLY_CAP_USD || 30);
const OPENAI_NIGHTLY_CAP_USD = Number(process.env.OPENAI_API_NIGHTLY_CAP_USD || 10);
const OPENAI_WARN_USD = Number(process.env.OPENAI_API_WARN_USD || 15);
// Conservative per-call estimate recorded when the API response has no usage
// block: overcounting toward the caps beats silently recording zero and
// letting an untelemetered loop burn past them.
const DEFAULT_OPENAI_CALL_EST_USD = 0.02;
const CHARGED_API_RUNGS = new Set(['openai-api', 'anthropic-api', 'bedrock']);

class BrainUnreachable extends Error {
  constructor(attempts) {
    super('All LLM rungs failed: ' + attempts.map((a) => `${a.rung}=${a.outcome}`).join(', '));
    this.name = 'BrainUnreachable';
    this.attempts = attempts;
  }
}

function appendJsonl(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  } catch {
    /* logging must never break the ladder */
  }
}

// ---- hard-capped spend ledger for the OpenAI API floor ---------------------
//
// State file shape: { month, spentUsd, calls, day, daySpentUsd, dayCalls,
// updatedAt }. Both buckets key off the America/Chicago calendar, not UTC:
// month is the yyyy-mm of the CT date, day is the CT date itself (the
// "night" of the nightly cap).

// CT calendar-day string (yyyy-mm-dd) for the given instant. The single place
// the CT boundary is computed, exported so tests can pin the boundary.
function ctDateString(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d);
}

// The spend ledger path. opts.spendFile (tests) beats the env override beats
// the repo default, mirroring how REPO resolves via SECONDBRAIN_ROOT.
function resolveSpendFile(opts) {
  return (opts && opts.spendFile) || process.env.OPENAI_API_SPEND_FILE || SPEND_FILE;
}

// Normalize a raw ledger object onto the current CT buckets: a month change
// resets both buckets, a day change inside the same month resets only the
// day bucket.
function rollSpendState(raw, now = new Date()) {
  const day = ctDateString(now);
  const month = day.slice(0, 7);
  const s = {
    month: raw.month,
    spentUsd: Number(raw.spentUsd) || 0,
    calls: Number(raw.calls) || 0,
    day: raw.day,
    daySpentUsd: Number(raw.daySpentUsd) || 0,
    dayCalls: Number(raw.dayCalls) || 0,
    updatedAt: raw.updatedAt,
  };
  if (s.month !== month) {
    s.month = month;
    s.spentUsd = 0;
    s.calls = 0;
  }
  if (s.day !== day) {
    s.day = day;
    s.daySpentUsd = 0;
    s.dayCalls = 0;
  }
  return s;
}

// Strict read for the cap gate. Distinguishes "no file yet" (first run, zero
// spend) from "file exists but is unreadable" (ExampleCo spend -> the caller
// blocks the openai-api rung, and ONLY that rung).
function loadSpendState(file, now = new Date()) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, state: rollSpendState({}, now) };
    return { ok: false };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ok: false };
    return { ok: true, state: rollSpendState(parsed, now) };
  } catch {
    return { ok: false };
  }
}

// Lenient read kept for existing callers (ec2-server health display): any
// unreadable state degrades to a zero counter instead of throwing. The cap
// gate uses loadSpendState() instead so corruption blocks spend, not reads.
function readSpend(file = resolveSpendFile()) {
  const loaded = loadSpendState(file);
  return loaded.ok ? loaded.state : rollSpendState({});
}

function recordSpend(estUsd, file = resolveSpendFile()) {
  const s = readSpend(file);
  s.spentUsd = Math.round((s.spentUsd + estUsd) * 10000) / 10000;
  s.calls += 1;
  s.daySpentUsd = Math.round((s.daySpentUsd + estUsd) * 10000) / 10000;
  s.dayCalls += 1;
  s.updatedAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(s, null, 1));
  } catch (e) {
    // The answer was already paid for: a lost ledger write must not crash the
    // caller, but it can never be silent either.
    appendJsonl(ATTEMPT_LOG, {
      ts: new Date().toISOString(),
      level: 'error',
      rung: 'openai-api',
      spendFile: file,
      error: 'spend-write-failed:' + String(e && e.message).slice(0, 80),
    });
  }
  return s;
}

// Settle one successful openai-api call into BOTH buckets (month + CT day).
// A response with no usage block records DEFAULT_OPENAI_CALL_EST_USD instead
// of zero so missing telemetry cannot starve the caps.
function settleOpenAiSpend(usage, opts = {}) {
  const estUsd = usage ? estimateOpenAiCostUsd(usage) : DEFAULT_OPENAI_CALL_EST_USD;
  const state = recordSpend(estUsd, resolveSpendFile(opts));
  return { estUsd, state };
}

// Warn-only visibility: returns a warning string past the warn threshold or
// the cap, never blocks. Blocking lives in chargedLlmApiGate.
function budgetWarning(budget) {
  const spent = budget.spentUsd;
  const cap = budget.capUsd;
  if (spent >= cap) {
    return `OpenAI API floor spend $${spent.toFixed(2)} has reached the hard $${cap} monthly cap; the gate blocks further paid-floor calls until the CT month rolls.`;
  }
  if (spent >= (budget.warnUsd ?? OPENAI_WARN_USD)) {
    return `OpenAI API floor spend $${spent.toFixed(2)} approaching the $${cap} monthly cap.`;
  }
  return null;
}

function isChargedApiRung(rung) {
  if (!rung) return false;
  return rung.paid === true || CHARGED_API_RUNGS.has(String(rung.name || ''));
}

function chargedLlmApiGate(opts, attempts, rungName) {
  const terminalCodexAttempt = attempts
    .slice()
    .reverse()
    .find(
      (a) =>
        a &&
        a.rung === 'codex' &&
        typeof a.outcome === 'string' &&
        !a.outcome.startsWith('transient-retry'),
    );
  const codexDown = terminalCodexAttempt && terminalCodexAttempt.outcome !== 'answered';
  if (!codexDown) {
    return { ok: false, outcome: 'charged-api-blocked:codex-not-proven-down' };
  }
  if (rungName !== 'openai-api') {
    // anthropic-api / bedrock (and any unnamed paid rung, fail-closed):
    // ExampleCo's 2026-07-11 standing authorization covers ONLY the OpenAI floor,
    // so these keep the per-call approval requirement.
    if (opts.allowChargedLlmApi !== true) {
      return { ok: false, outcome: 'charged-api-blocked:ExampleCo-approval-required' };
    }
    return { ok: true };
  }
  // openai-api: standing authorization (ExampleCo 2026-07-11) under HARD caps.
  // opts.allowChargedLlmApi is still accepted but no longer gates this rung.
  const file = resolveSpendFile(opts);
  const loaded = loadSpendState(file);
  if (!loaded.ok) {
    // Fail-closed for spend (ExampleCo ledger = no paid call), fail-safe for
    // the surface (only THIS rung is blocked; the ladder keeps descending).
    appendJsonl(ATTEMPT_LOG, {
      ts: new Date().toISOString(),
      surface: opts.surface || 'ExampleCo',
      level: 'error',
      rung: rungName,
      spendFile: file,
      error: 'spend-state-unreadable',
    });
    return { ok: false, outcome: 'charged-api-blocked:spend-state-unreadable' };
  }
  if (loaded.state.spentUsd >= OPENAI_MONTHLY_CAP_USD) {
    return { ok: false, outcome: 'charged-api-blocked:monthly-cap-exhausted' };
  }
  if (loaded.state.daySpentUsd >= OPENAI_NIGHTLY_CAP_USD) {
    return { ok: false, outcome: 'charged-api-blocked:nightly-cap-exhausted' };
  }
  return { ok: true };
}

// Estimate the USD cost of one OpenAI floor call from its usage block.
// gpt-4o-mini pricing: ~$0.15 / 1M input tokens, ~$0.60 / 1M output tokens.
// Pure and exported so the paid-floor cost accounting is unit-testable without
// a live HTTPS call, and so the formula lives in exactly one place.
function estimateOpenAiCostUsd(usage) {
  const u = usage || {};
  const est = ((u.prompt_tokens || 0) * 0.15 + (u.completion_tokens || 0) * 0.6) / 1e6;
  return Math.round(est * 1e6) / 1e6;
}

// ---- built-in rung implementations -----------------------------------------

function runCodexRung(question, opts) {
  return new Promise((resolve) => {
    // --output-last-message writes the FINAL assistant turn to a file; stdout
    // ExampleCos session narration (tool calls, sandbox notes) that must never be
    // returned as the answer. Temp file per call, removed in finally.
    const os = require('node:os');
    const outFile = path.join(os.tmpdir(), `ask-ai-codex-${process.pid}-${Date.now()}.txt`);
    const args = [
      'exec',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '--output-last-message',
      outFile,
    ];
    if (opts.codexImagePath) args.push('-i', opts.codexImagePath);
    try {
      const res = spawnSync('codex', args, {
        input: withCodexAmyPrelude(question),
        encoding: 'utf8',
        timeout: opts.rungTimeoutMs || 90000,
        env: { ...process.env, CLAUDECODE: '' },
        shell: process.platform === 'win32',
        maxBuffer: 10 * 1024 * 1024,
      });
      if (res.error || res.status !== 0) return resolve(null);
      let out = '';
      try {
        out = fs.readFileSync(outFile, 'utf8').trim();
      } catch {
        out = (res.stdout || '').trim();
      }
      if (!out || isCliFailureOutput(out)) return resolve(null);
      resolve(out);
    } finally {
      try {
        fs.unlinkSync(outFile);
      } catch {
        /* already gone */
      }
    }
  });
}

function runClaudeProxyRung(question, opts) {
  return new Promise((resolve) => {
    const proxyUrl = opts.proxyUrl || process.env.CLAUDE_PROXY_URL || 'http://localhost:3456';
    let u;
    try {
      u = new URL('/v1/chat/completions', proxyUrl);
    } catch {
      return resolve(null);
    }
    const body = JSON.stringify({
      model: 'claude',
      stream: false,
      messages: [
        ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
        { role: 'user', content: question },
      ],
    });
    const lib = u.protocol === 'https:' ? https : require('node:http');
    const req = lib.request(
      u,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: opts.rungTimeoutMs || 45000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try {
            const text = String(JSON.parse(raw).choices?.[0]?.message?.content || '').trim();
            if (!text || isCliFailureOutput(text)) return resolve(null);
            resolve(text);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

function runClaudeCliRung(question, opts) {
  return new Promise((resolve) => {
    const res = spawnSync('claude', ['-p', question], {
      encoding: 'utf8',
      timeout: opts.rungTimeoutMs || 120000,
      env: buildClaudeCliEnv(),
      shell: process.platform === 'win32',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (res.error || res.status !== 0) return resolve(null);
    const out = (res.stdout || '').trim();
    if (!out || isCliFailureOutput(out)) return resolve(null);
    resolve(out);
  });
}

function runOpenAiApiRung(question, opts) {
  return new Promise((resolve) => {
    const apiKey = process.env.OPENAI_API_KEY || '';
    if (!apiKey || apiKey.length < 20) return resolve(null);
    const body = JSON.stringify({
      model: opts.openaiModel || process.env.OPENAI_API_MODEL || 'gpt-4o-mini',
      messages: [
        ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
        { role: 'user', content: question },
      ],
      max_tokens: opts.maxTokens || 1500,
      stream: false,
    });
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: opts.rungTimeoutMs || 45000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try {
            const parsed = JSON.parse(raw);
            const text = String(parsed.choices?.[0]?.message?.content || '').trim();
            // Settle the actual estimated cost into BOTH cap buckets (month +
            // CT day); a missing usage block records the conservative default.
            const { estUsd: est, state: s } = settleOpenAiSpend(parsed.usage, opts);
            // Attribute the estimated dollar cost to the calling surface so the
            // ladder observability rollup can answer "which surface burned the
            // paid floor, and for how much" -- not just the reliance rate. A
            // dedicated cost line (kind:'cost') never counts as a terminal rung
            // attempt; it only ExampleCos dollars.
            if (est > 0) {
              appendJsonl(ATTEMPT_LOG, {
                ts: new Date().toISOString(),
                surface: opts.surface || 'ExampleCo',
                rung: 'openai-api',
                kind: 'cost',
                estUsd: est,
              });
            }
            const warn = budgetWarning({ spentUsd: s.spentUsd, capUsd: OPENAI_MONTHLY_CAP_USD });
            if (warn)
              appendJsonl(ATTEMPT_LOG, { ts: new Date().toISOString(), budgetWarning: warn });
            resolve(text || null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

function defaultRungOrder() {
  return ['codex', 'claude-proxy', 'claude-cli', 'openai-api'];
}

function builtinRungs(opts) {
  const all = {
    codex: { name: 'codex', fn: (q) => runCodexRung(q, opts) },
    'claude-proxy': { name: 'claude-proxy', fn: (q) => runClaudeProxyRung(q, opts) },
    'claude-cli': { name: 'claude-cli', fn: (q) => runClaudeCliRung(q, opts) },
    'openai-api': { name: 'openai-api', fn: (q) => runOpenAiApiRung(q, opts), paid: true },
  };
  const order = opts.rungOrder || defaultRungOrder();
  return order.map((n) => all[n]).filter(Boolean);
}

// ---- the ladder -------------------------------------------------------------
//
// askAI(question, opts) -> { text, rung, latencyMs, attempts }
//   opts.rungs       inject rung objects [{name, fn(question), paid?}] (tests)
//   opts.surface     caller label for the attempt log
//   opts.system      optional system prompt
//   opts.onAttempt   callback per attempt {rung, outcome, latencyMs}
//   opts.budget      inject {spentUsd, capUsd, warnUsd, warn(msg)} (tests)
//   opts.spendFile   inject the spend ledger path (tests); defaults to the
//                    OPENAI_API_SPEND_FILE env override, then SPEND_FILE
//   opts.silent      return null instead of throwing BrainUnreachable
//   opts.rungRetries extra same-rung retries on a TRANSIENT throw before
//                    descending (default 1). A blip on the Claude rung must not
//                    bounce Amy to a paid floor; a non-transient failure (auth,
//                    null, sentinel) still descends immediately.
//   opts.sleep       injectable backoff delay (tests pass a noop)
async function askAI(question, opts = {}) {
  const rungs = opts.rungs || builtinRungs(opts);
  const attempts = [];
  for (const r of rungs) {
    const started = Date.now();
    let text = null;
    let outcome = 'null';
    if (isChargedApiRung(r)) {
      const gate = chargedLlmApiGate(opts, attempts, r.name);
      if (!gate.ok) {
        const attempt = { rung: r.name, outcome: gate.outcome, latencyMs: 0 };
        attempts.push(attempt);
        if (typeof opts.onAttempt === 'function') opts.onAttempt(attempt);
        appendJsonl(ATTEMPT_LOG, {
          ts: new Date().toISOString(),
          surface: opts.surface || 'ExampleCo',
          ...attempt,
        });
        continue;
      }
    }
    // Warn-only visibility before a paid rung; the HARD caps were already
    // enforced by the gate above.
    if (isChargedApiRung(r)) {
      const b = opts.budget || {
        spentUsd: readSpend(resolveSpendFile(opts)).spentUsd,
        capUsd: OPENAI_MONTHLY_CAP_USD,
      };
      const warn = budgetWarning(b);
      if (warn) {
        if (typeof b.warn === 'function') b.warn(warn);
        appendJsonl(ATTEMPT_LOG, {
          ts: new Date().toISOString(),
          surface: opts.surface || 'ExampleCo',
          budgetWarning: warn,
        });
      }
    }
    const rungRetries = Number.isInteger(opts.rungRetries) ? opts.rungRetries : 1;
    try {
      const out = await withTransientRetry(() => r.fn(question), {
        retries: rungRetries,
        sleep: opts.sleep,
        isTransient: isTransientError,
        // Record each absorbed blip so the attempt log shows the rung held
        // through a transient failure instead of silently descending.
        onRetry: ({ attempt, error, delayMs }) => {
          const retryAttempt = {
            rung: r.name,
            outcome: 'transient-retry:' + String(error && error.message).slice(0, 48),
            latencyMs: delayMs,
          };
          attempts.push(retryAttempt);
          if (typeof opts.onAttempt === 'function') opts.onAttempt(retryAttempt);
          appendJsonl(ATTEMPT_LOG, {
            ts: new Date().toISOString(),
            surface: opts.surface || 'ExampleCo',
            retry: attempt,
            ...retryAttempt,
          });
        },
      });
      if (typeof out === 'string' && out.trim()) {
        if (isCliFailureOutput(out)) {
          outcome = 'sentinel-failure';
        } else {
          text = out.trim();
          outcome = 'answered';
        }
      }
    } catch (e) {
      outcome = 'threw:' + String(e && e.message).slice(0, 60);
    }
    const attempt = { rung: r.name, outcome, latencyMs: Date.now() - started };
    attempts.push(attempt);
    if (typeof opts.onAttempt === 'function') opts.onAttempt(attempt);
    appendJsonl(ATTEMPT_LOG, {
      ts: new Date().toISOString(),
      surface: opts.surface || 'ExampleCo',
      ...attempt,
    });
    if (text) return { text, rung: r.name, latencyMs: attempt.latencyMs, attempts };
  }
  if (opts.silent) return null;
  throw new BrainUnreachable(attempts);
}

module.exports = {
  askAI,
  BrainUnreachable,
  defaultRungOrder,
  budgetWarning,
  chargedLlmApiGate,
  ctDateString,
  estimateOpenAiCostUsd,
  readSpend,
  recordSpend,
  settleOpenAiSpend,
  DEFAULT_OPENAI_CALL_EST_USD,
  ATTEMPT_LOG,
  SPEND_FILE,
};
