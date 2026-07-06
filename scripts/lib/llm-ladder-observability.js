// scripts/lib/llm-ladder-observability.js
//
// Observability rollup for the universal LLM ladder (scripts/lib/ask-ai.js).
//
// ask-ai.js writes one attempt line per rung tried to data/agent/ask-ai-rungs.jsonl
// (plus transient-retry lines and paid-floor budget-warning lines), but nothing
// has ever aggregated that ledger. The descent from the Claude/Codex
// subscriptions down to the paid OpenAI floor is therefore SILENT, which
// violates Amy's "fail loud, never silent" and "no surface dead when the
// subscription is down" rules: when both subscriptions are degraded we are
// quietly burning the paid floor with nobody told.
//
// This module turns the raw ledger into a health verdict the briefing System
// Health card / devops-health can surface. Pure over records (the summarize
// function never touches fs) so it is trivially testable with fixtures; only
// reportFromFile() reads disk.
//
// Attempt line shapes written by ask-ai.js askAI():
//   { ts, surface, rung, outcome, latencyMs }              -- a rung attempt
//   { ts, surface, retry, rung, outcome:'transient-retry:..', latencyMs }
//   { ts, surface, budgetWarning }                         -- paid-floor warn
// outcome is one of: 'answered' | 'null' | 'sentinel-failure' | 'threw:..'
//                    | 'transient-retry:..'

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..');
const RUNG_LOG_PATH = path.join(REPO, 'data', 'agent', 'ask-ai-rungs.jsonl');

// The first configured rung in ask-ai.js defaultRungOrder(); answering here is
// the healthy steady state. Paid rungs are the soft-capped last resort: any
// real answer from one means both subscriptions failed for that call.
const DEFAULT_FIRST_RUNG = 'codex';
const DEFAULT_PAID_RUNGS = ['openai-api'];

function parseRungLog(text) {
  if (!text) return [];
  const out = [];
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // a torn final line (crash mid-append) must not break the rollup
    }
  }
  return out;
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

function emptyRung() {
  return {
    count: 0,
    answered: 0,
    nullOut: 0,
    sentinel: 0,
    threw: 0,
    transientRetries: 0,
    _latencies: [],
  };
}

// Per-surface bucket. A "surface" is the caller label ask-ai.js stamps on every
// attempt line (briefing, otter, calls, video, ...). The by-rung rollup answers
// "is the ladder healthy"; the by-surface rollup answers "WHICH caller is
// descending to the paid floor / burning the ladder" -- the per-session cost
// attribution the 2026 agent-observability guidance calls out and the by-rung
// view cannot express.
function emptySurface() {
  return {
    count: 0,
    answered: 0,
    answeredByPaidFloor: 0,
    transientRetries: 0,
    budgetWarnings: 0,
    spendUsd: 0,
    _latencies: [],
  };
}

function classify(outcome) {
  if (outcome === 'answered') return 'answered';
  if (outcome === 'null') return 'nullOut';
  if (outcome === 'sentinel-failure') return 'sentinel';
  if (typeof outcome === 'string' && outcome.startsWith('transient-retry')) return 'transientRetry';
  if (typeof outcome === 'string' && outcome.startsWith('threw')) return 'threw';
  return 'other';
}

// summarizeLadder(records, opts) -> structured health rollup. Pure.
//   opts.now         ISO/epoch reference for the window (default: latest ts seen)
//   opts.windowHours window to include, anchored at opts.now (default 24)
//   opts.firstRung   the healthy steady-state rung (default 'codex')
//   opts.paidRungs   soft-capped floor rungs (default ['openai-api'])
function summarizeLadder(records, opts = {}) {
  const firstRung = opts.firstRung || DEFAULT_FIRST_RUNG;
  const paidRungs = opts.paidRungs || DEFAULT_PAID_RUNGS;
  const windowHours = Number.isFinite(opts.windowHours) ? opts.windowHours : 24;

  const all = Array.isArray(records) ? records : [];
  // Anchor the window at the explicit now, else the newest record, else skip.
  const timestamps = all
    .map((r) => r && r.ts && Date.parse(r.ts))
    .filter((t) => Number.isFinite(t));
  const anchor =
    opts.now != null ? Date.parse(new Date(opts.now).toISOString()) : Math.max(...timestamps, 0);
  const cutoff =
    Number.isFinite(anchor) && anchor > 0 && windowHours > 0
      ? anchor - windowHours * 3600 * 1000
      : -Infinity;

  const inWindow = all.filter((r) => {
    if (!r || typeof r !== 'object') return false;
    const t = r.ts ? Date.parse(r.ts) : NaN;
    if (!Number.isFinite(t)) return windowHours <= 0; // undated lines only when window disabled
    return t >= cutoff;
  });

  const byRung = {};
  const bySurface = {};
  let budgetWarnings = 0;
  let transientRetriesTotal = 0;
  let answeredTotal = 0;
  let answeredByFirstRung = 0;
  let answeredByPaidFloor = 0;
  let paidFloorSpendUsd = 0;

  const surfaceOf = (r) => {
    if (!bySurface[r.surface || 'ExampleCo']) bySurface[r.surface || 'ExampleCo'] = emptySurface();
    return bySurface[r.surface || 'ExampleCo'];
  };

  for (const r of inWindow) {
    if (r.budgetWarning) {
      budgetWarnings += 1;
      surfaceOf(r).budgetWarnings += 1;
      continue;
    }
    // A dedicated cost line ({ kind:'cost', estUsd }) ExampleCos the estimated USD
    // spend ask-ai.js incurred on a paid-floor call. It is NOT a terminal rung
    // attempt (no outcome) -- it only attributes dollars, overall and per surface.
    if (r.kind === 'cost') {
      if (Number.isFinite(r.estUsd)) {
        paidFloorSpendUsd += r.estUsd;
        surfaceOf(r).spendUsd += r.estUsd;
      }
      continue;
    }
    const rung = r.rung || 'ExampleCo';
    if (!byRung[rung]) byRung[rung] = emptyRung();
    const bucket = byRung[rung];
    const surf = surfaceOf(r);
    const kind = classify(r.outcome);

    if (kind === 'transientRetry') {
      bucket.transientRetries += 1;
      surf.transientRetries += 1;
      transientRetriesTotal += 1;
      continue; // a retry blip is not a terminal rung attempt
    }

    bucket.count += 1;
    surf.count += 1;
    if (Number.isFinite(r.latencyMs)) {
      bucket._latencies.push(r.latencyMs);
      surf._latencies.push(r.latencyMs);
    }

    if (kind === 'answered') {
      bucket.answered += 1;
      surf.answered += 1;
      answeredTotal += 1;
      if (rung === firstRung) answeredByFirstRung += 1;
      if (paidRungs.includes(rung)) {
        answeredByPaidFloor += 1;
        surf.answeredByPaidFloor += 1;
      }
    } else if (kind === 'nullOut') bucket.nullOut += 1;
    else if (kind === 'sentinel') bucket.sentinel += 1;
    else if (kind === 'threw') bucket.threw += 1;
  }

  // finalize per-rung latency percentiles, drop the internal scratch array
  for (const rung of Object.keys(byRung)) {
    const b = byRung[rung];
    const sorted = b._latencies.slice().sort((a, c) => a - c);
    b.latencyP50 = percentile(sorted, 50);
    b.latencyP95 = percentile(sorted, 95);
    delete b._latencies;
  }

  // finalize per-surface reliance + latency; identify the surface driving cost.
  let worstSurface = null;
  let worstPressure = 0;
  for (const name of Object.keys(bySurface)) {
    const s = bySurface[name];
    const sorted = s._latencies.slice().sort((a, c) => a - c);
    s.latencyP50 = percentile(sorted, 50);
    s.latencyP95 = percentile(sorted, 95);
    delete s._latencies;
    s.spendUsd = Math.round(s.spendUsd * 10000) / 10000;
    s.paidFloorRelianceRate = s.answered > 0 ? s.answeredByPaidFloor / s.answered : null;
    // Pressure = cost signals (paid-floor answers + budget warnings) this surface
    // contributed. The worst surface is the one to investigate first when the
    // ladder verdict is not healthy.
    const pressure = s.answeredByPaidFloor + s.budgetWarnings;
    if (pressure > worstPressure) {
      worstPressure = pressure;
      worstSurface = name;
    }
  }

  const terminalAttempts = Object.values(byRung).reduce((s, b) => s + b.count, 0);
  const firstRungAnswerRate = answeredTotal > 0 ? answeredByFirstRung / answeredTotal : null;
  const paidFloorRelianceRate = answeredTotal > 0 ? answeredByPaidFloor / answeredTotal : null;

  // Verdict, loudest-failure-wins. Aligns with "fail loud, never silent":
  //   critical  - brain went unreachable, OR we answered from the paid floor
  //               (both subscriptions failed for a real call), OR a paid-floor
  //               budget warning fired.
  //   degraded  - subscriptions are answering but we are falling back off the
  //               top rung more than occasionally.
  //   healthy   - the top rung is carrying the load.
  //   ExampleCo   - no terminal attempts in the window (nothing to judge).
  const reasons = [];
  let verdict = 'healthy';

  if (terminalAttempts === 0) {
    verdict = 'ExampleCo';
    reasons.push('no LLM ladder attempts in window');
  } else if (answeredTotal === 0) {
    verdict = 'critical';
    reasons.push(`brain unreachable: ${terminalAttempts} attempts, 0 answered`);
  } else {
    if (answeredByPaidFloor > 0) {
      verdict = 'critical';
      reasons.push(
        `${answeredByPaidFloor} answer(s) came from the paid floor (both subscriptions failed)`,
      );
    }
    if (budgetWarnings > 0) {
      verdict = 'critical';
      reasons.push(`${budgetWarnings} paid-floor budget warning(s)`);
    }
    if (verdict !== 'critical' && firstRungAnswerRate != null && firstRungAnswerRate < 0.9) {
      verdict = 'degraded';
      reasons.push(
        `top rung '${firstRung}' answered only ${Math.round(firstRungAnswerRate * 100)}% of calls`,
      );
    }
  }
  if (verdict === 'healthy') {
    reasons.push(`top rung '${firstRung}' carrying ${answeredTotal} answer(s)`);
  }

  return {
    windowHours,
    anchor: Number.isFinite(anchor) && anchor > 0 ? new Date(anchor).toISOString() : null,
    totalLinesInWindow: inWindow.length,
    terminalAttempts,
    answeredTotal,
    answeredByFirstRung,
    answeredByPaidFloor,
    transientRetriesTotal,
    budgetWarnings,
    firstRungAnswerRate,
    paidFloorRelianceRate,
    paidFloorSpendUsd: Math.round(paidFloorSpendUsd * 10000) / 10000,
    byRung,
    bySurface,
    worstSurface,
    verdict,
    reasons,
  };
}

function reportFromFile(filePath = RUNG_LOG_PATH, opts = {}) {
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    // missing ledger is itself a signal: nothing has called the ladder
    return summarizeLadder([], opts);
  }
  return summarizeLadder(parseRungLog(text), opts);
}

function oneLine(summary) {
  const pf = summary.paidFloorRelianceRate;
  const tail =
    summary.terminalAttempts === 0
      ? 'no attempts'
      : `${summary.answeredTotal}/${summary.terminalAttempts} answered, paid-floor=${pf == null ? 'n/a' : Math.round(pf * 100) + '%'}`;
  const spend =
    summary.paidFloorSpendUsd > 0 ? `, floor-spend=$${summary.paidFloorSpendUsd.toFixed(4)}` : '';
  // When the ladder is not healthy, name the surface to investigate first.
  const worst =
    summary.verdict !== 'healthy' && summary.worstSurface
      ? ` [worst surface: ${summary.worstSurface}]`
      : '';
  return `LLM ladder [${summary.verdict}] ${tail}${spend} - ${summary.reasons[0] || ''}${worst}`;
}

module.exports = {
  RUNG_LOG_PATH,
  DEFAULT_FIRST_RUNG,
  DEFAULT_PAID_RUNGS,
  parseRungLog,
  summarizeLadder,
  reportFromFile,
  oneLine,
};

if (require.main === module) {
  const { compareWindows } = require('./llm-ladder-anomaly.js');
  const summary = reportFromFile();
  // Persist a rolling baseline so the NEXT run can flag a rising trend even if
  // each individual window looks acceptable (cost-anomaly detection). The
  // baseline is a runtime artifact under data/agent (durable, not git-tracked).
  const BASELINE_PATH = path.join(REPO, 'data', 'agent', 'ask-ai-ladder-baseline.json');
  let anomaly = { regression: false, flags: ['no baseline to compare against'], deltas: {} };
  try {
    const prev = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    anomaly = compareWindows(summary, prev);
  } catch {
    /* first run: no baseline yet */
  }
  try {
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(summary, null, 1));
  } catch {
    /* never block the report on a persistence failure */
  }
  // eslint-disable-next-line no-console
  console.log(oneLine(summary));
  if (anomaly.regression) {
    // eslint-disable-next-line no-console
    console.log('ANOMALY vs baseline: ' + anomaly.flags.join('; '));
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ summary, anomaly }, null, 2));
  process.exit(summary.verdict === 'critical' ? 1 : 0);
}
