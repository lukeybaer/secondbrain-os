'use strict';

// First-pass scheduling for the 11 PM card controller (Top 15 item 4).
//
// Sources start four at a time, longest recent median first (longest-processing
// time ordering keeps the slowest card from starting last). Each source gets a
// time budget; a source that overruns it is released with a capacity-deferred
// result, which the controller already routes to the repair line (no repair
// attempt spent, the next deterministic source pass retries it under the
// 10 minute deferred budget). The in-flight tracker backs the "average cards in flight" line
// in the nightly receipt.

const fs = require('fs');
const path = require('path');

const FIRST_PASS_SLOTS = 4;
const MIN_BUDGET_MS = 6 * 60 * 1000;
const MAX_BUDGET_MS = 12 * 60 * 1000;
const DEFAULT_BUDGET_MS = 10 * 60 * 1000;
// A family that already overran tonight (deferred to the retry pass, or the late
// fresh refresh) gets this hard budget; a second overrun ends the card red.
const DEFERRED_SOURCE_BUDGET_MS = 10 * 60 * 1000;
const BUDGET_MULTIPLE = 2.5;
const UNKNOWN_MEDIAN_MS = 4 * 60 * 1000;
const HISTORY_KEEP = 9;
const SEED_TAIL_BYTES = 24 * 1024 * 1024;

function ledgerPath(dataDir) {
  return path.join(dataDir, 'agent', 'card-controller', 'first-pass-durations.json');
}

function median(values) {
  const sorted = (values || []).filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// Seed from the host admission ledger: each source command holds a lease for
// its run time. Sum leases per family per first-pass night (04:00 to 08:59 UTC,
// the 11 PM to 3:59 AM CT window) so a multi-command family counts once.
function seedFromAdmissionEvents(eventsFile, { fsApi = fs, maxBytes = SEED_TAIL_BYTES } = {}) {
  const families = {};
  let text;
  try {
    const size = fsApi.statSync(eventsFile).size;
    const length = Math.min(size, maxBytes);
    const fd = fsApi.openSync(eventsFile, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fsApi.readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString('utf8');
    } finally {
      fsApi.closeSync(fd);
    }
  } catch {
    return families;
  }
  const open = new Map();
  const perNight = new Map();
  for (const line of text.split('\n')) {
    if (!line.includes('briefing-source:') && !line.includes('"released"')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(event.ts);
    if (event.event === 'acquired' && String(event.lease?.kind || '').startsWith('briefing-source:')) {
      const hour = new Date(at).getUTCHours();
      if (hour >= 4 && hour <= 8) open.set(event.lease.token, { family: event.lease.kind.slice(16), at });
    } else if (event.event === 'released') {
      const token = event.token || event.lease?.token;
      const row = open.get(token);
      if (!row) continue;
      open.delete(token);
      const key = `${row.family}|${new Date(row.at).toISOString().slice(0, 10)}`;
      perNight.set(key, (perNight.get(key) || 0) + Math.max(0, at - row.at));
    }
  }
  for (const [key, ms] of perNight) {
    const family = key.split('|')[0];
    (families[family] ||= []).push(ms);
  }
  for (const family of Object.keys(families)) families[family] = families[family].slice(-HISTORY_KEEP);
  return families;
}

function readLedger(dataDir, fsApi = fs) {
  try {
    const parsed = JSON.parse(fsApi.readFileSync(ledgerPath(dataDir), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      return { families: parsed.families || {}, overruns: parsed.overruns || {} };
    }
  } catch {
    /* absent or unreadable: treated as no history */
  }
  return null;
}

function writeLedger(dataDir, ledger, fsApi = fs) {
  const file = ledgerPath(dataDir);
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fsApi.writeFileSync(tmp, JSON.stringify(ledger));
  fsApi.renameSync(tmp, file);
}

// Never throws: scheduling history is advisory and must not stop the night.
function loadHistory(dataDir, { fsApi = fs } = {}) {
  const existing = readLedger(dataDir, fsApi);
  if (existing) return existing;
  const seeded = {
    families: seedFromAdmissionEvents(path.join(dataDir, 'agent', 'host-work-admission', 'events.jsonl'), { fsApi }),
    overruns: {},
  };
  try {
    writeLedger(dataDir, seeded, fsApi);
  } catch {
    /* advisory only */
  }
  return seeded;
}

function recordRun(dataDir, { date, durations = [], overruns = [] }, { fsApi = fs } = {}) {
  try {
    const ledger = readLedger(dataDir, fsApi) || { families: {}, overruns: {} };
    for (const { family, durationMs } of durations) {
      if (!family || !Number.isFinite(durationMs) || durationMs < 0) continue;
      ledger.families[family] = [...(ledger.families[family] || []), Math.round(durationMs)].slice(-HISTORY_KEEP);
    }
    if (overruns.length) {
      const today = new Set(ledger.overruns[date] || []);
      for (const family of overruns) today.add(family);
      ledger.overruns[date] = [...today];
    }
    for (const day of Object.keys(ledger.overruns).sort().slice(0, -7)) delete ledger.overruns[day];
    writeLedger(dataDir, ledger, fsApi);
    return true;
  } catch {
    return false;
  }
}

function medianMsFor(history, family) {
  return median((history && history.families && history.families[family]) || []);
}

// Longest recent median first; unknown families sit mid-pack; ties keep plan order.
function orderLongestFirst(rows, familyOf, history) {
  return rows
    .map((row, index) => ({ row, index, ms: medianMsFor(history, familyOf(row)) ?? UNKNOWN_MEDIAN_MS }))
    .sort((a, b) => b.ms - a.ms || a.index - b.index)
    .map((entry) => entry.row);
}

function overranTonight(history, family, date) {
  return ((history && history.overruns && history.overruns[date]) || []).includes(family);
}

function deferredSourceBudgetMs(env = process.env) {
  const forced = Number(env && env.AMY_DEFERRED_SOURCE_BUDGET_MS);
  return Number.isFinite(forced) && forced > 0 ? forced : DEFERRED_SOURCE_BUDGET_MS;
}

// Budget for one source's slot time. A family that already overran tonight is
// on the repair line and gets the hard deferred budget; it is never deferred twice.
function budgetMsFor(history, family, date, { override } = {}) {
  const forced = Number(override);
  if (Number.isFinite(forced) && forced > 0) return forced;
  if (overranTonight(history, family, date)) return deferredSourceBudgetMs();
  const med = medianMsFor(history, family);
  if (med == null) return DEFAULT_BUDGET_MS;
  return Math.min(MAX_BUDGET_MS, Math.max(MIN_BUDGET_MS, Math.round(med * BUDGET_MULTIPLE)));
}

// Distinct cards with at least one phase running. begin/end are depth counted
// per card so a card in its source and stage phases at once counts once.
function createInFlightTracker({ now = Date.now } = {}) {
  const depth = new Map();
  let active = 0;
  let max = 0;
  let areaMs = 0;
  let startMs = null;
  let lastMs = null;
  const advance = (at) => {
    if (lastMs != null) areaMs += active * (at - lastMs);
    lastMs = at;
  };
  return {
    begin(card, at = now()) {
      advance(at);
      if (startMs == null) startMs = at;
      const d = depth.get(card) || 0;
      depth.set(card, d + 1);
      if (d === 0) {
        active += 1;
        max = Math.max(max, active);
      }
    },
    end(card, at = now()) {
      const d = depth.get(card) || 0;
      if (d === 0) return;
      advance(at);
      depth.set(card, d - 1);
      if (d === 1) active -= 1;
    },
    summary(at = now()) {
      advance(at);
      const windowMs = startMs == null ? 0 : at - startMs;
      return {
        averageCardsInFlight: windowMs > 0 ? Math.round((areaMs / windowMs) * 100) / 100 : 0,
        maxCardsInFlight: max,
        windowMs,
        cardWorkMs: Math.round(areaMs),
      };
    },
  };
}

// FIRST-PASS STATE (Oct 5 2026). On Oct 5 a healer-initiated production deploy
// ran at 23:18 CT, in the middle of the night's first pass; it reinstalled
// systemd units and a memory-swap burst followed until midnight. The single
// night owner's controller records three moments: the pass started, every
// source refreshed (`sourcesFinishedAt`), and production settled (board and
// healers done, `finishedAt`). The healer deploy coordinator holds unattended
// deploys until production settles. A deploy from the same run's own healer is
// released once sources finish: the run waits for its healers to settle, so
// holding them to the end of the run would stall it on itself.
//
// Fail closed in the night window (23:00 to 05:30 CT): a missing, unreadable,
// corrupt or earlier-night marker counts as in flight, because the marker
// write is the only proof the pass is not running. The coordinator bounds
// every hold per row at FIRST_PASS_HOLD_MAX_MS, so nothing waits forever.
// Outside the night window a missing marker is no hold, as before.
const FIRST_PASS_HOLD_MAX_MS = 90 * 60 * 1000;
const NIGHT_START_MINUTE = 23 * 60;
const NIGHT_END_MINUTE = 5 * 60 + 30;

function firstPassStatePath(dataDir) {
  return path.join(dataDir, 'agent', 'card-controller', 'first-pass-state.json');
}

function writeFirstPassState(dataDir, value, fsApi) {
  const file = firstPassStatePath(dataDir);
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fsApi.writeFileSync(tmp, JSON.stringify(value));
  fsApi.renameSync(tmp, file);
}

function errorText(error) {
  return String((error && error.message) || error || 'unknown error').slice(0, 300);
}

// Never throws. Returns { ok, error } so the controller can put a failed
// write on its receipt; the reader then fails closed in the night window.
function markFirstPassStarted(dataDir, { date, runId = '', pid = process.pid, now = Date.now } = {}, { fsApi = fs } = {}) {
  try {
    writeFirstPassState(dataDir, {
      date: String(date || ''),
      runId: String(runId || ''),
      pid: Number(pid) || 0,
      startedAt: new Date(now()).toISOString(),
      sourcesFinishedAt: null,
      finishedAt: null,
    }, fsApi);
    return { ok: true, error: '' };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

function stampFirstPassState(dataDir, runId, field, now, fsApi) {
  try {
    const state = JSON.parse(fsApi.readFileSync(firstPassStatePath(dataDir), 'utf8'));
    if (!state || String(state.runId || '') !== String(runId || '')) {
      return { ok: false, error: 'marker belongs to another run' };
    }
    if (state[field]) return { ok: true, error: '' };
    writeFirstPassState(dataDir, { ...state, [field]: new Date(now()).toISOString() }, fsApi);
    return { ok: true, error: '' };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

function markFirstPassSourcesFinished(dataDir, { runId = '', now = Date.now } = {}, { fsApi = fs } = {}) {
  return stampFirstPassState(dataDir, runId, 'sourcesFinishedAt', now, fsApi);
}

// Production settled: the board and its healers are done (or the run ended).
function markFirstPassSettled(dataDir, { runId = '', now = Date.now } = {}, { fsApi = fs } = {}) {
  return stampFirstPassState(dataDir, runId, 'finishedAt', now, fsApi);
}

function defaultProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function ctMinute(nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(byType.hour) * 60 + Number(byType.minute);
}

// Start of the current 23:00 CT night window, or null outside it.
function nightWindowStartMs(nowMs) {
  const minute = ctMinute(nowMs);
  const since =
    minute >= NIGHT_START_MINUTE ? minute - NIGHT_START_MINUTE : minute < NIGHT_END_MINUTE ? minute + 60 : null;
  if (since == null) return null;
  return nowMs - (nowMs % 60000) - since * 60000;
}

// { inFlight, reason, runId, sourcesFinished, ... }. inFlight means unattended
// healer deploys wait (production not settled, or unknown at night).
function firstPassInFlight(dataDir, { nowMs = Date.now(), processAlive = defaultProcessAlive, maxHoldMs = FIRST_PASS_HOLD_MAX_MS, fsApi = fs } = {}) {
  const nightStart = nightWindowStartMs(nowMs);
  const unknown = (reason, extra = {}) =>
    nightStart == null
      ? { ...extra, inFlight: false, reason }
      : { ...extra, inFlight: true, reason: `${reason}-night-fail-closed`, sourcesFinished: false };
  let state;
  try {
    state = JSON.parse(fsApi.readFileSync(firstPassStatePath(dataDir), 'utf8'));
  } catch (error) {
    return unknown(error && error.code === 'ENOENT' ? 'no-first-pass-state' : 'unreadable-first-pass-state');
  }
  const startedMs = Date.parse(state && state.startedAt);
  if (!state || typeof state !== 'object' || !Number.isFinite(startedMs)) return unknown('invalid-first-pass-state');
  const base = {
    date: String(state.date || ''),
    runId: String(state.runId || ''),
    startedAt: state.startedAt,
    sourcesFinished: Boolean(state.sourcesFinishedAt),
  };
  // A marker from an earlier night proves nothing about tonight's pass.
  if (nightStart != null && startedMs < nightStart) return unknown('earlier-night-first-pass-state', base);
  if (state.finishedAt) return { ...base, inFlight: false, reason: 'production-settled', finishedAt: state.finishedAt };
  // No age-based release here: a row that arrived late in a long pass must
  // still wait. The 90 minute bound is per held row, in the coordinator.
  if (!processAlive(Number(state.pid))) return { ...base, inFlight: false, reason: 'first-pass-owner-gone' };
  return { ...base, inFlight: true, reason: base.sourcesFinished ? 'production-in-flight' : 'first-pass-in-flight' };
}

module.exports = {
  FIRST_PASS_HOLD_MAX_MS,
  firstPassStatePath,
  markFirstPassStarted,
  markFirstPassSourcesFinished,
  markFirstPassSettled,
  nightWindowStartMs,
  firstPassInFlight,
  FIRST_PASS_SLOTS,
  MIN_BUDGET_MS,
  MAX_BUDGET_MS,
  DEFAULT_BUDGET_MS,
  DEFERRED_SOURCE_BUDGET_MS,
  deferredSourceBudgetMs,
  overranTonight,
  BUDGET_MULTIPLE,
  UNKNOWN_MEDIAN_MS,
  ledgerPath,
  median,
  seedFromAdmissionEvents,
  loadHistory,
  recordRun,
  medianMsFor,
  orderLongestFirst,
  budgetMsFor,
  createInFlightTracker,
};
