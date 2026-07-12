'use strict';

// scripts/lib/briefing-cutover-gate.js
//
// W5 Stage 2 of the cloud cutover (ExampleCo 2026-07-11: "Amy lives in the cloud,
// the PC is an optional accessory"). The parity runner
// (scripts/briefing-parity-run.js) appends one row per morning comparison to
// data/agent/briefing-parity-runs.jsonl; this module owns the CUTOVER GATE
// derived from those rows: after 3 consecutive CT calendar days of PARITY
// between the desktop-built and EC2-built briefings, the gate flips
// eligible=true and the desktop briefing triggers (Windows task
// SecondBrain-DailyBriefing via daily-briefing.bat, and the Electron
// scheduler's 5:29 sendDailyBriefing entry) become no-ops with a log line.
// EC2 cron (ec2-morning-briefing-run.sh) proved live ownership of 5:30 on
// 2026-07-12; the gate is what lets the desktop stand down safely.
//
// LATCH SEMANTICS: once flipped eligible, the gate STAYS eligible. After the
// cutover the desktop stops producing artifacts, so the parity streak
// naturally decays to zero; un-flipping on a decayed streak would resurrect
// the dueling-writer problem the cutover exists to kill. Re-enabling the
// desktop triggers is a deliberate human action: delete the gate file or run
// scripts/briefing-parity-run.js --reset-gate.
//
// Pure logic is exported separately from file IO so the gate rules are unit
// tested without disk (feedback_frugal_regression_tests.md: encode the
// category, consecutive-day proof before retiring a redundant trigger).

const fs = require('node:fs');
const path = require('node:path');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..');
const PARITY_RUNS_FILE = path.join(REPO, 'data', 'agent', 'briefing-parity-runs.jsonl');
const GATE_FILE = path.join(REPO, 'data', 'agent', 'briefing-cutover-gate.json');
const REQUIRED_CONSECUTIVE_PARITY_DAYS = 3;

// yyyy-mm-dd string one calendar day before the given yyyy-mm-dd string.
// Date math on the DATE STRING (UTC-noon anchor) so DST shifts in
// America/Chicago can never make "consecutive" skip or repeat a day.
function previousDateString(day) {
  const [y, m, d] = String(day)
    .split('-')
    .map((n) => Number(n));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return new Date(Date.UTC(y, m - 1, d - 1, 12)).toISOString().slice(0, 10);
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Read every row of the parity-runs ledger. ENOENT is an empty history, a
// torn/unparseable line is skipped (append-only jsonl can carry a torn tail
// after a crash; one bad line must not wedge the gate).
function readParityRuns(file = PARITY_RUNS_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object') rows.push(parsed);
    } catch {
      /* torn line, skip */
    }
  }
  return rows;
}

// Pure gate computation from ledger rows. Only rows with status 'compared'
// and a valid ISO date participate; skipped rows (an artifact was missing)
// neither extend nor break a streak by themselves, but a MISSING CALENDAR DAY
// between compared days breaks consecutiveness, so a skipped morning still
// costs the streak its continuity. The LAST row per date wins (a manual
// re-run after a fix supersedes the earlier row for that date).
//
// Codex review 2026-07-12 (findings 1 and 6, adopted): the gate also ExampleCos
// CLOUD CONTACT PROOF. lastCloudContactAt is the newest row timestamp where
// the runner actually READ a cloud-built artifact (every compared row, plus
// skipped rows that flag cloudContact=true). The trigger decision requires
// this to be FRESH: an eligible gate with a dead/unreachable EC2 must NOT
// no-op the desktop, or a broken cloud morning goes unbuilt. It also ExampleCos
// lastComparedParity/lastComparedAt so a fresh post-cutover divergence
// SUSPENDS the no-op until a parity day proves the cloud build again.
function computeCutoverGate(runs, opts = {}) {
  const required = Number.isInteger(opts.requiredConsecutiveDays)
    ? opts.requiredConsecutiveDays
    : REQUIRED_CONSECUTIVE_PARITY_DAYS;
  const byDate = new Map();
  let lastCloudContactAt = null;
  let lastComparedAt = null;
  let lastComparedParity = null;
  for (const row of Array.isArray(runs) ? runs : []) {
    if (!row || typeof row !== 'object') continue;
    const ts = typeof row.ts === 'string' ? row.ts : null;
    const isCompared = row.status === 'compared' && isIsoDate(row.date);
    if (ts && (isCompared || row.cloudContact === true)) {
      if (!lastCloudContactAt || ts > lastCloudContactAt) lastCloudContactAt = ts;
    }
    if (!isCompared) continue;
    byDate.set(row.date, row); // later rows overwrite earlier ones for the date
    if (ts && (!lastComparedAt || ts >= lastComparedAt)) {
      lastComparedAt = ts;
      lastComparedParity = row.parity === true;
    }
  }
  const dates = [...byDate.keys()].sort().reverse();
  let streak = 0;
  let expected = dates.length ? dates[0] : null;
  for (const date of dates) {
    if (date !== expected) break; // calendar gap: consecutiveness broken
    if (byDate.get(date).parity !== true) break; // divergence ends the streak
    streak += 1;
    expected = previousDateString(date);
  }
  return {
    eligible: streak >= required,
    consecutiveParityDays: streak,
    requiredConsecutiveDays: required,
    lastComparedDate: dates.length ? dates[0] : null,
    comparedDayCount: byDate.size,
    lastCloudContactAt,
    lastComparedAt,
    lastComparedParity,
  };
}

// Merge a fresh computation with the previously written gate, honoring the
// latch: an already-eligible gate never flips back on streak decay or a
// post-cutover divergence (that state is recorded honestly, not acted on).
function resolveGate(prevGate, computed, now = new Date()) {
  const nowIso = now.toISOString();
  if (prevGate && prevGate.eligible === true) {
    return {
      ...computed,
      eligible: true,
      latched: true,
      flippedAt: prevGate.flippedAt || nowIso,
      updatedAt: nowIso,
      note:
        computed.eligible === false
          ? 'latched eligible: current streak below threshold, gate holds (reset requires --reset-gate)'
          : undefined,
    };
  }
  return {
    ...computed,
    latched: false,
    flippedAt: computed.eligible ? nowIso : null,
    updatedAt: nowIso,
  };
}

function readGate(file = GATE_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeGate(gate, file = GATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const clean = JSON.parse(JSON.stringify(gate)); // drop undefined fields
  fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

// Recompute the gate from the ledger and persist it. The single entry point
// the parity runner calls after appending its row.
function updateGateFromRuns({ runsFile = PARITY_RUNS_FILE, gateFile = GATE_FILE, now } = {}) {
  const runs = readParityRuns(runsFile);
  const computed = computeCutoverGate(runs);
  const gate = resolveGate(readGate(gateFile), computed, now || new Date());
  return writeGate(gate, gateFile);
}

// Freshness horizon for the cloud contact proof: one briefing cycle plus
// slack (mirrors deploy-parity-row's STALE_HOURS posture).
const CLOUD_CONTACT_MAX_AGE_HOURS = 26;
// A divergence older than this no longer suspends the no-op (the desktop was
// building again in the interim and newer rows exist, or the signal is stale).
const DIVERGENCE_SUSPEND_HOURS = 7 * 24;

function hoursSince(iso, nowMs) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(t)) return Infinity;
  return (nowMs - t) / 3600000;
}

// The one decision both desktop triggers consult (mirrored in
// src/main/briefing-cutover.ts; the two must never disagree, locked by
// src/main/__tests__/briefing-cutover.test.ts). Missing/unreadable gate =
// desktop keeps running (fail toward the proven-safe redundant state, never
// toward silently losing the morning briefing). Codex review 2026-07-12
// findings 1, 2, 6 (adopted): a no-op additionally requires FRESH cloud
// contact proof and no fresh divergence, so a dead EC2 or a regressed cloud
// build automatically re-opens the desktop fallback without un-flipping the
// gate itself.
function desktopBriefingTriggerAllowed(gate, opts = {}) {
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : opts.now || Date.now();
  if (!gate || gate.eligible !== true) {
    return { allowed: true, reason: 'cutover gate ineligible or absent: desktop trigger active' };
  }
  const contactAgeH = hoursSince(gate.lastCloudContactAt, nowMs);
  if (contactAgeH > CLOUD_CONTACT_MAX_AGE_HOURS) {
    return {
      allowed: true,
      reason:
        'cutover gate eligible BUT no fresh cloud contact (last ' +
        (gate.lastCloudContactAt || 'never') +
        '): desktop fallback re-opened until EC2 is reachable again',
    };
  }
  if (
    gate.lastComparedParity === false &&
    hoursSince(gate.lastComparedAt, nowMs) <= DIVERGENCE_SUSPEND_HOURS
  ) {
    return {
      allowed: true,
      reason:
        'cutover gate eligible BUT the most recent comparison (' +
        (gate.lastComparedAt || 'ExampleCo') +
        ') was a DIVERGENCE: desktop fallback re-opened until a parity day proves the cloud build',
    };
  }
  return {
    allowed: false,
    reason:
      'cloud cutover gate eligible (' +
      (gate.flippedAt || 'flip time ExampleCo') +
      ') with fresh cloud contact: EC2 cron owns 5:30, desktop briefing trigger is a no-op',
  };
}

module.exports = {
  PARITY_RUNS_FILE,
  GATE_FILE,
  REQUIRED_CONSECUTIVE_PARITY_DAYS,
  CLOUD_CONTACT_MAX_AGE_HOURS,
  DIVERGENCE_SUSPEND_HOURS,
  previousDateString,
  readParityRuns,
  computeCutoverGate,
  resolveGate,
  readGate,
  writeGate,
  updateGateFromRuns,
  desktopBriefingTriggerAllowed,
};
