'use strict';

// scripts/self-heal/self-heal-health-card.js
//
// PHASE 4b, item 1: the DAILY SELF-HEAL HEALTH CARD.
//
// A standalone briefing card so ExampleCo sees self-heal status WITHOUT opening logs.
// It reads two Phase 4a sources and nothing else:
//   1. the per-defect REPAIR LEDGER (scripts/self-heal/briefing-repair-ledger.js:
//      openDefects / attemptsForDefect / attemptRows) for attempted / cleared /
//      escalated counts and how fresh the ledger itself is, and
//   2. the EXECUTOR-HEALTH row (scripts/lib/executor-health-row.js) for the single
//      "can the self-heal executor run?" signal, sourced from the overnight
//      orchestrator's run-log (data/agent/overnight-self-heal-runs.jsonl) where the
//      pre-spawn auth preflight already persists exactly ONE executor row.
//
// Output is executive-crisp: a one-line FACE ("3 attempted, 2 cleared, 1
// escalated; executor healthy; ledger fresh") plus a DRILLDOWN detail (one line per
// open/escalated defect with its tried tactics, the executor runbook only when the
// executor is red). NO log-speak: no jsonl paths, no stage names, no PM2/session ids
// in the face copy.
//
// This module is the card's OWNING GENERATOR (one owner per card, Phase 3): it is
// declared as self_heal_health.owner in dev-plans/_domains.json and resolves to
// generateSelfHealHealthCard. It is pure + injectable (opts.dataDir, opts.date,
// opts.preflight, opts.executorRow, opts.nowMs) so tests never touch real run logs.

const fs = require('node:fs');
const path = require('node:path');

const ledger = require('./briefing-repair-ledger.js');
const { executorHealthRow } = require('../lib/executor-health-row.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FRESHNESS_MAX_AGE_HOURS = 24;

// The run log the overnight orchestrator appends to (appendRunLog -> RUNS_LOG_PATH).
// EC2-first so the card reads the always-on heal loop's log; falls back to desktop
// then repo, mirroring briefing-repair-ledger.defaultDataDir.
function runLogPath(opts = {}) {
  return path.join(
    opts.dataDir || ledger.defaultDataDir(),
    'agent',
    'overnight-self-heal-runs.jsonl',
  );
}

function readRunLogRows(opts = {}) {
  const p = opts.runLogPath || runLogPath(opts);
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // a corrupt line is skipped, never fatal: a health CARD must never crash the build
    }
  }
  return out;
}

// The single executor-health row. Preference order:
//   1. an explicitly injected built row (opts.executorRow) -- tests + a live caller
//      that already built it from the live preflight,
//   2. an injected preflight result (opts.preflight) -> executorHealthRow(),
//   3. the newest executor row persisted in the run log (the orchestrator logs a
//      stage:'system-health-row' source:'executor-health' row on auth failure and a
//      stage:'self-heal-health' row that ExampleCos executorHealthRow on red),
//   4. when nothing is recorded, treat the executor as healthy ONLY if a green
//      self-heal-health checkpoint exists; otherwise ExampleCo (no false green).
function resolveExecutorRow(rows, opts = {}) {
  if (opts.executorRow && opts.executorRow.label && opts.executorRow.status) {
    return opts.executorRow;
  }
  if (opts.preflight) return executorHealthRow(opts.preflight, opts.executorHealthSignals || {});
  // newest persisted executor row, newest-first
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i];
    if (!r) continue;
    if (r.executorHealthRow && r.executorHealthRow.label && r.executorHealthRow.status) {
      return r.executorHealthRow;
    }
    if (r.stage === 'system-health-row' && r.source === 'executor-health' && r.label) {
      return { label: r.label, status: r.status, detail: r.detail || '', runbook: r.runbook || '' };
    }
  }
  // no executor row recorded: infer from the newest self-heal-health checkpoint
  let checkpoint = null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i] && rows[i].stage === 'self-heal-health') {
      checkpoint = rows[i];
      break;
    }
  }
  if (checkpoint && String(checkpoint.status || '').toLowerCase() === 'green') {
    return executorHealthRow({}); // a green checkpoint means a successful run -> healthy
  }
  return {
    label: 'Self-Heal Executor',
    status: 'ExampleCo',
    detail: 'no executor health checkpoint recorded for this window.',
    runbook:
      'Runbook: run the overnight self-heal orchestrator so its pre-spawn auth preflight records one executor-health row.',
  };
}

// Newest timestamp across ledger attempt rows + run-log rows = how fresh the
// self-heal signal is. Returns { ageHours, newestTs } or { ageHours:null } when
// nothing has ever been recorded.
function signalFreshness(attempts, rows, nowMs) {
  let newest = null;
  const consider = (ts) => {
    const t = ts ? Date.parse(ts) : NaN;
    if (Number.isFinite(t)) newest = newest == null ? t : Math.max(newest, t);
  };
  for (const a of attempts) consider(a && a.ts);
  for (const r of rows) consider(r && r.ts);
  if (newest == null) return { ageHours: null, newestTs: null };
  return { ageHours: (nowMs - newest) / 3.6e6, newestTs: new Date(newest).toISOString() };
}

// Distinct-defect counts from the per-defect ledger:
//   attempted = distinct defects with >= 1 attempt row today
//   cleared   = distinct defects whose LATEST attempt cleared
//   escalated = distinct defects still OPEN (latest attempt did not clear) ==
//               openDefects(date).length, so the card matches the Blockers card.
function defectCounts(date, opts = {}) {
  const attempts = ledger.attemptRows(date, opts);
  const byDefect = new Map();
  for (const row of attempts) {
    const key = ledger.normDefectKey(row.defect);
    const list = byDefect.get(key) || [];
    list.push(row);
    byDefect.set(key, list);
  }
  let cleared = 0;
  for (const list of byDefect.values()) {
    if (ledger.isClearedRow(list[list.length - 1])) cleared += 1;
  }
  const open = ledger.openDefects(date, opts);
  return {
    attempted: byDefect.size,
    cleared,
    escalated: open.length,
    open,
    totalAttempts: attempts.length,
    attempts,
  };
}

function clamp(text, n = 200) {
  return String(text == null ? '' : text).slice(0, n);
}

// Build the structured card record. Pure; no side effects.
function buildSelfHealHealthCard(opts = {}) {
  const date = ledger.safeDate
    ? ledger.safeDate(opts.date)
    : opts.date || new Date().toISOString().slice(0, 10);
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const counts = defectCounts(date, opts);
  const rows = readRunLogRows(opts);
  const executorRow = resolveExecutorRow(rows, opts);
  const fresh = signalFreshness(counts.attempts, rows, nowMs);
  const maxAgeHours = Number.isFinite(opts.maxAgeHours)
    ? opts.maxAgeHours
    : FRESHNESS_MAX_AGE_HOURS;
  // The ledger is STALE when no signal exists at all, or the newest signal is older
  // than the freshness floor. A stale ledger is itself a defect worth surfacing.
  const ledgerStale = fresh.ageHours == null || fresh.ageHours > maxAgeHours;
  const executorGreen = executorRow.status === 'green';
  const executorRed = executorRow.status === 'red';

  // The card is CLEAN only when the executor is PROVEN green, the ledger is fresh, and
  // nothing is still escalated. A red OR ExampleCo executor (no executor-health proof for
  // this window means we cannot claim self-heal ran) is unproven and must surface as a
  // defect, never a silent green pass. Cleared work alone is not a defect.
  const defect = !executorGreen || ledgerStale || counts.escalated > 0;

  const executorFace = executorGreen
    ? 'executor healthy'
    : executorRed
      ? 'executor cannot run'
      : 'executor status ExampleCo';
  const ledgerFace = ledgerStale
    ? fresh.ageHours == null
      ? 'no self-heal run recorded'
      : `ledger stale (${Math.round(fresh.ageHours)}h old)`
    : 'ledger fresh';
  const face = `${counts.attempted} attempted, ${counts.cleared} cleared, ${counts.escalated} escalated; ${executorFace}; ${ledgerFace}.`;

  // Drilldown rows: one per still-open/escalated defect, naming its tried tactics
  // and latest result -- never a jsonl path or stage name (executive-crisp).
  const openLines = counts.open.map((d, i) => ({
    index: i + 1,
    defect: d.defect,
    attempts: d.attempts,
    lastResult: d.lastQcResult,
    triedTactics: (d.triedTactics || []).slice(0, 5),
    text: `${i + 1}. ${d.defect}: ${d.attempts} attempt(s), latest ${d.lastQcResult}. Tried: ${
      (d.triedTactics || []).slice(0, 5).join('; ') || 'none recorded'
    }.`,
  }));

  return {
    cardId: 'self_heal_health',
    date,
    generatedAt: new Date(nowMs).toISOString(),
    attempted: counts.attempted,
    cleared: counts.cleared,
    escalated: counts.escalated,
    totalAttempts: counts.totalAttempts,
    executor: {
      label: executorRow.label,
      status: executorRow.status,
      detail: clamp(executorRow.detail, 240),
      runbook: executorRed ? clamp(executorRow.runbook, 400) : '',
    },
    freshness: {
      ageHours: fresh.ageHours == null ? null : Math.round(fresh.ageHours * 10) / 10,
      newestTs: fresh.newestTs,
      maxAgeHours,
      stale: ledgerStale,
    },
    defect,
    face,
    openDefects: openLines,
  };
}

// Render the card as a legacy "TITLE:\n\nbody" markdown section the briefing
// assembly + ec2-server.js render both consume. A leading status glyph keeps the
// row self-describing; the FACE is the one-line summary; the drilldown lists open
// defects and (only when red) the executor runbook. No log-speak.
const SELF_HEAL_HEALTH_TITLE = 'SELF-HEAL HEALTH';

function renderSelfHealHealthSection(opts = {}) {
  const card = opts.card || buildSelfHealHealthCard(opts);
  const glyph = card.defect ? '✗' : '✓'; // cross / check, no em/en dashes anywhere
  const lines = [];
  lines.push(`${glyph} ${card.face}`);
  lines.push('');
  lines.push(`Attempted: ${card.attempted}`);
  lines.push(`Cleared: ${card.cleared}`);
  lines.push(`Escalated: ${card.escalated}`);
  lines.push(
    `Executor: ${card.executor.status} -- ${card.executor.detail || 'no detail'}`.replace(
      / -- /g,
      ': ',
    ),
  );
  if (card.executor.runbook) lines.push(`Executor next step: ${card.executor.runbook}`);
  lines.push(
    card.freshness.ageHours == null
      ? 'Ledger freshness: no self-heal run recorded yet.'
      : `Ledger freshness: newest signal ${card.freshness.ageHours}h old (floor ${card.freshness.maxAgeHours}h, ${
          card.freshness.stale ? 'STALE' : 'fresh'
        }).`,
  );
  if (card.openDefects.length) {
    lines.push('');
    lines.push('Open repair defects:');
    for (const d of card.openDefects) lines.push(`  ${d.text}`);
  }
  return `${SELF_HEAL_HEALTH_TITLE}:\n\n${lines.join('\n').trim()}`;
}

// The OWNING GENERATOR (Phase 3 one-owner-per-card seam). Resolvable + callable so
// verify-heal-ladder-refs.js / validateCardOwners pass. Writes a dated artifact so
// the freshness acceptance has a run-receipt, then returns the rendered section.
function generateSelfHealHealthCard(opts = {}) {
  const card = buildSelfHealHealthCard(opts);
  const section = renderSelfHealHealthSection({ card });
  if (opts.write !== false) {
    try {
      const outDir = path.join(
        opts.dataDir || ledger.defaultDataDir(),
        'agent',
        'self-heal-health',
      );
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(
        path.join(outDir, `${card.date}.json`),
        `${JSON.stringify(card, null, 2)}\n`,
      );
    } catch {
      // best-effort artifact: a read-only fs must not break the briefing build
    }
  }
  return { card, section };
}

module.exports = {
  SELF_HEAL_HEALTH_TITLE,
  FRESHNESS_MAX_AGE_HOURS,
  runLogPath,
  readRunLogRows,
  resolveExecutorRow,
  signalFreshness,
  defectCounts,
  buildSelfHealHealthCard,
  renderSelfHealHealthSection,
  generateSelfHealHealthCard,
};

if (require.main === module) {
  const { section } = generateSelfHealHealthCard({});
  process.stdout.write(`${section}\n`);
}
