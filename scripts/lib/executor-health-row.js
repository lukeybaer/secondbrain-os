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

const EXECUTOR_HEALTH_LABEL = 'Self-Heal Executor';

const HEALTHY_RUNBOOK =
  'Healthy: a pre-spawn authenticated probe passed, so the overnight heal fan-out can run.';

const AUTH_FAILED_RUNBOOK =
  'Runbook: on ExampleCo laptop run `claude /login` to re-seed ~/.claude/.credentials.json, then verify data/agent/claude-token-refresh.jsonl shows a recent "refreshed" or "fresh-skipped" row and that ~/.claude-oauth-token is recent. Re-run the overnight self-heal orchestrator once auth is restored.';

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
  const mark = r.status === 'red' ? '✗' : '✓';
  return `${mark} ${r.label}: ${r.detail} ${r.runbook}`.trim();
}

module.exports = {
  EXECUTOR_HEALTH_LABEL,
  AUTH_FAILED_RUNBOOK,
  HEALTHY_RUNBOOK,
  executorHealthRow,
  formatExecutorHealthRow,
};
