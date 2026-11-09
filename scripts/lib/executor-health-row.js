'use strict';

// scripts/lib/executor-health-row.js
//
// PHASE 4a, item 4: EXECUTOR-HEALTH -> SYSTEM HEALTH (one named row, not a cascade).
//
// The 2026-06-28 RED root cause: a dead Claude credential made the overnight fan-out
// spawn 12 heal workers that each hit "API Error: 401", and the failure surfaced as N
// card defects / a 12-session cascade instead of ONE honest "the executor cannot run"
// signal. The orchestrator already has a pre-spawn auth preflight
// (overnight-self-heal-orchestrator.preflightHealAuth) that returns
//   { ok:true }  |  { ok:false, probeDetail, refreshDetail, blocker }.
//
// THIS module converts that single preflight result (plus optionally-observed quota /
// latency signals) into exactly ONE System Health row for the briefing's System Health
// card, with a concrete runbook. It is the seam that guarantees executor health is a
// SINGLE named row, never re-derived per card.
//
// Row shape matches the rest of System Health: { label, status:'green'|'red', detail,
// runbook }. Pure + injectable; no spawn, no network.

const { defineStateMachine } = require('./ledger-state-machine.js');
const { watchedLimitMs } = require('./watched-work-limit');

const EXECUTOR_HEALTH_LABEL = 'Self-Heal Executor';

// The checkpoint stage every pass writes: phase 'started' at launch and phase
// 'completed' at every exit.
const CHECKPOINT_STAGE = 'self-heal-checkpoint';

// A pass that wrote 'started' and never 'completed' was killed or crashed, but
// only once it is past the longest time a live pass can legitimately run. The
// limit is the pass's own budget plus a grace:
//   - budget: the started row's budgetMs, else the driver default of 45 minutes
//     (scripts/agentic-healer-driver.js DEFAULT_BUDGET_MINUTES);
//   - grace: the wrapper hard-kills at budget + 5 minutes + 30 seconds
//     (scripts/overnight-agentic-healer.sh BACKSTOP_SECONDS, --kill-after=30s),
//     so 10 minutes covers the backstop and ledger lag.
// Measured on EC2, 119 finished driver passes 2026-10-20 to 2026-11-03: p99 23.9
// minutes, max 28.8 minutes, so no finished pass came near the 55-minute limit.
const DEFAULT_PASS_BUDGET_MS = watchedLimitMs(45 * 60 * 1000);
const PASS_KILL_GRACE_MS = 10 * 60 * 1000;

const HEALTHY_RUNBOOK =
  'Healthy: a pre-spawn authenticated probe passed, so the overnight heal fan-out can run.';

const AUTH_FAILED_RUNBOOK =
  'Runbook: on the owner laptop run `claude /login` to re-seed the Claude Code credentials file, then verify data/agent/claude-token-refresh.jsonl shows a recent "refreshed" or "fresh-skipped" row and that the pushed OAuth token file is recent. Re-run the overnight self-heal orchestrator once auth is restored.';

function clamp(text, n = 240) {
  return String(text == null ? '' : text).slice(0, n);
}

// Build the ONE executor System Health row from the preflight result. `extra` may
// carry cheaply-observable quota/latency signals when present:
//   extra.quotaExhausted (bool) + extra.quotaDetail
//   extra.latencyMs (number)    + extra.latencyBudgetMs (number)
// Any one of {auth dead, quota exhausted, latency over budget} makes the single row
// RED with a combined detail; none of them keeps it GREEN. We never emit a row per
// failing card and never let executor health fan out into N defects.
function executorHealthRow(preflight = {}, extra = {}) {
  const reasons = [];
  if (preflight && preflight.ok === false) {
    const probe = clamp(preflight.probeDetail || (preflight.blocker && preflight.blocker.evidence));
    const refresh = clamp(preflight.refreshDetail);
    reasons.push(
      `auth failed (probe: ${probe || 'auth probe failed'}${refresh ? `; refresh: ${refresh}` : ''})`,
    );
  }
  if (extra && extra.quotaExhausted) {
    reasons.push(
      `quota exhausted${extra.quotaDetail ? ` (${clamp(extra.quotaDetail, 160)})` : ''}`,
    );
  }
  const latencyMs = Number(extra && extra.latencyMs);
  const latencyBudgetMs = Number(extra && extra.latencyBudgetMs);
  if (
    Number.isFinite(latencyMs) &&
    Number.isFinite(latencyBudgetMs) &&
    latencyBudgetMs > 0 &&
    latencyMs > latencyBudgetMs
  ) {
    reasons.push(`latency ${Math.round(latencyMs)}ms over budget ${Math.round(latencyBudgetMs)}ms`);
  }
  if (reasons.length === 0) {
    const detail =
      preflight && preflight.probe
        ? `executor auth probe ok (${clamp(preflight.detail || preflight.probe, 160)})`
        : 'executor auth probe ok';
    return {
      label: EXECUTOR_HEALTH_LABEL,
      status: 'green',
      detail,
      runbook: HEALTHY_RUNBOOK,
    };
  }
  const authDead = preflight && preflight.ok === false;
  return {
    label: EXECUTOR_HEALTH_LABEL,
    status: 'red',
    detail: `Self-heal executor cannot run: ${reasons.join('; ')}. The worker fan-out was suppressed (no dead 401 sessions).`,
    runbook: authDead
      ? AUTH_FAILED_RUNBOOK
      : 'Runbook: wait for the rate-limit/latency window to recover or switch the executor to the Codex sub rung, then re-run the overnight self-heal orchestrator.',
  };
}

// started -> completed is the normal pass; started -> killed is a pass that
// never reported within its limit.
function passMachine(ttlMs) {
  return defineStateMachine({
    name: 'executor-pass',
    transitions: { '': ['started'], started: ['completed', 'killed'] },
    terminal: ['completed', 'killed'],
    inFlight: { started: { ttlMs } },
  });
}

function passTtlMs(startedRow) {
  const budget = Number(startedRow && startedRow.budgetMs);
  return (Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_PASS_BUDGET_MS) + PASS_KILL_GRACE_MS;
}

// The LATEST pass in the run log, not the latest completed one. Rows are in
// append order. The driver lane pairs started with completed by runId, because
// two runs can interleave; a row without a runId (the orchestrator lane) pairs
// within its own lane. A later pass hides an earlier one, so a green 11:30 PM
// pass followed by a hard-killed 2 AM pass reads killed, and a later green pass
// reads healthy again. Returns null when no checkpoint exists, else
//   { state: 'completed'|'running'|'killed', status, row, startIndex, ... }.
function latestExecutorPass(rows, nowMs = Date.now()) {
  const passes = [];
  const open = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row, index) => {
    if (!row || row.stage !== CHECKPOINT_STAGE) return;
    const lane = row.runId ? `run:${row.runId}` : 'lane:orchestrator';
    if (row.phase === 'started') {
      const pass = { lane, started: row, startIndex: index, completed: null, completedIndex: -1 };
      passes.push(pass);
      open.set(lane, pass);
    } else if (row.phase === 'completed') {
      const pass = open.get(lane);
      if (pass) {
        pass.completed = row;
        pass.completedIndex = index;
        open.delete(lane);
      } else {
        passes.push({ lane, started: null, startIndex: -1, completed: row, completedIndex: index });
      }
    }
  });
  const last = passes[passes.length - 1];
  if (!last) return null;
  if (last.completed) {
    const red = String(last.completed.status || '').toLowerCase() === 'red';
    return { state: 'completed', status: red ? 'red' : 'green', ...last, row: last.completed };
  }
  const ttlMs = passTtlMs(last.started);
  const startedMs = Date.parse(last.started.ts || '');
  const killed = passMachine(ttlMs).isExpired('started', last.started.ts, nowMs);
  return {
    state: killed ? 'killed' : 'running',
    status: killed ? 'red' : 'running',
    ...last,
    row: last.started,
    ttlMs,
    ageMs: Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : null,
  };
}

const KILLED_RUNBOOK =
  'Runbook: check the overnight self-heal wrapper log and the host for a killed process (timeout, out-of-memory or restart), then re-run the overnight self-heal orchestrator.';

// The ONE executor row for a pass that has not completed. Null when the latest
// pass completed (the caller reads its status) or there is none.
function executorRowForOpenPass(pass) {
  if (!pass || pass.state === 'completed') return null;
  const minutes = (ms) => Math.round(ms / 60000);
  if (pass.state === 'running') {
    return {
      label: EXECUTOR_HEALTH_LABEL,
      status: 'running',
      detail: `a self-heal pass started ${minutes(pass.ageMs)}m ago and is still inside its ${minutes(pass.ttlMs)}m limit, so its result is not known yet.`,
      runbook: '',
    };
  }
  const started = pass.ageMs == null ? 'at an unrecorded time' : `${minutes(pass.ageMs)}m ago`;
  return {
    label: EXECUTOR_HEALTH_LABEL,
    status: 'red',
    detail: `the latest self-heal pass started ${started} and never finished within ${minutes(pass.ttlMs)}m, so it was killed or crashed.`,
    runbook: KILLED_RUNBOOK,
  };
}

// Format the row for the markdown System Health card (one line, checkmark/cross prefix
// matching system-health-tests-row.js). Accepts EITHER an already-built row (has
// label+status) OR a raw preflight result (built into a row here).
function isBuiltRow(x) {
  return !!(
    x &&
    typeof x === 'object' &&
    typeof x.label === 'string' &&
    typeof x.status === 'string'
  );
}

function formatExecutorHealthRow(rowOrPreflight) {
  const r = isBuiltRow(rowOrPreflight) ? rowOrPreflight : executorHealthRow(rowOrPreflight || {});
  const mark = r.status === 'red' ? '✗' : r.status === 'running' ? '…' : '✓';
  return `${mark} ${r.label}: ${r.detail} ${r.runbook}`.trim();
}

module.exports = {
  CHECKPOINT_STAGE,
  DEFAULT_PASS_BUDGET_MS,
  PASS_KILL_GRACE_MS,
  EXECUTOR_HEALTH_LABEL,
  AUTH_FAILED_RUNBOOK,
  HEALTHY_RUNBOOK,
  executorHealthRow,
  formatExecutorHealthRow,
  latestExecutorPass,
  executorRowForOpenPass,
};
