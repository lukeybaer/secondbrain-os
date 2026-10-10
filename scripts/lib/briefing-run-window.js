'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CT_ZONE = 'America/Chicago';
const INPUT_START_HOUR_CT = 23;
const DELIVERY_HOUR_CT = 5;
const DELIVERY_MINUTE_CT = 30;
// ExampleCo, 2026-09-07: repair is done by 4:30 AM CT, whatever the board holds
// then is what the morning gets. The deadline path stops new repair at 4:30,
// the coordinator settles, freezes the evidence, and the hour to 5:30 belongs
// to one researched, peer-reviewed strategic report: synthesis, one Codex
// adversarial review, one revision, freeze, and delivery. The early path still
// closes admission as soon as the shared terminal coordinator enters settling.
const REPAIR_CUTOFF_HOUR_CT = 4;
const REPAIR_CUTOFF_MINUTE_CT = 30;
// When no model synthesis has passed the report validator by this clock, the
// report finalizes deterministically so the 5:30 send always has final bytes.
const DETERMINISTIC_FINALIZE_HOUR_CT = 5;
const DETERMINISTIC_FINALIZE_MINUTE_CT = 15;
// ExampleCo, 2026-09-24: the night finishes when it is finished, and Gmail goes out
// as soon as the report is final. The standing rule of no non-failure Telegram
// from 8 PM to 5 AM CT still holds, so the briefing's Telegram pointer waits
// for this one clock. No other literal 05:00 exists for the briefing send.
const TELEGRAM_QUIET_END_HOUR_CT = 5;
// Quiet hours start at 20:00 CT. A same-date resend at or after this hour is
// refused rather than held: the next briefing owns the next morning.
const TELEGRAM_QUIET_START_HOUR_CT = 20;
const TERMINAL_OVERNIGHT_OUTCOMES = new Set([
  'clean',
  'needs-attention',
  'time-budget-exhausted',
  'failed',
  'frozen-after-rollback',
  'frozen-recovery-failed',
]);
const HOST_CAPACITY_DEFERRED_CARD_OUTCOMES = new Set([
  'source-capacity-deferred',
  'stage-capacity-deferred',
]);

function dateKeyInCt(value = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CT_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function shiftDateKey(dateStr, days) {
  const [year, month, day] = String(dateStr || '')
    .split('-')
    .map(Number);
  if (![year, month, day].every(Number.isFinite)) return '';
  return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
}

function previousDateKey(dateStr) {
  return shiftDateKey(dateStr, -1);
}

function nextDateKey(dateStr) {
  return shiftDateKey(dateStr, 1);
}

function ctWallTimeToEpochMs(dateStr, hour, minute = 0) {
  const [year, month, day] = String(dateStr || '')
    .split('-')
    .map(Number);
  for (const offsetHours of [5, 6]) {
    const guess = Date.UTC(year, month - 1, day, hour + offsetHours, minute, 0, 0);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: CT_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(guess));
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (
      `${byType.year}-${byType.month}-${byType.day}` === dateStr &&
      Number(byType.hour) === hour &&
      Number(byType.minute) === minute
    ) {
      return guess;
    }
  }
  return Date.UTC(year, month - 1, day, hour + 6, minute, 0, 0);
}

// The canonical night for briefing date D: input from 23:00 CT on D-1, repair
// until 04:30, deterministic finalize at 05:15, delivery by 05:30 CT on D.
function canonicalNightClock(date) {
  const day = String(date || '').slice(0, 10);
  return {
    inputStartMs: ctWallTimeToEpochMs(previousDateKey(day), INPUT_START_HOUR_CT, 0),
    repairCutoffMs: ctWallTimeToEpochMs(day, REPAIR_CUTOFF_HOUR_CT, REPAIR_CUTOFF_MINUTE_CT),
    deterministicFinalizeMs: ctWallTimeToEpochMs(
      day,
      DETERMINISTIC_FINALIZE_HOUR_CT,
      DETERMINISTIC_FINALIZE_MINUTE_CT,
    ),
    deliveryDeadlineMs: ctWallTimeToEpochMs(day, DELIVERY_HOUR_CT, DELIVERY_MINUTE_CT),
  };
}

// Owner-invoked catch-up run (ExampleCo, 2026-09-27): when a date's night never
// delivered, the same canonical night runs later that day with every clock
// shifted by one offset. One immutable record per date holds that offset
// (scripts/lib/briefing-catch-up-run.js writes it); every window below reads
// it, so the whole pipeline moves together and no stage needs its own bypass.
const RUN_SCHEDULE_SCHEMA = 'briefing-run-schedule@1';
// The shifted delivery must land before Telegram quiet hours (20:00 CT) and
// well before the next canonical input window at 23:00 CT.
const CATCH_UP_LATEST_DELIVERY_HOUR_CT = 19;
const CATCH_UP_LATEST_DELIVERY_MINUTE_CT = 45;

function runScheduleDir(dataDir) {
  return path.join(dataDir, 'agent', 'briefing-run-schedules');
}

function runSchedulePath(dataDir, date) {
  return path.join(runScheduleDir(dataDir), `${String(date || '').slice(0, 10)}.json`);
}

function scheduleDataDir(dataDir) {
  if (dataDir) return dataDir;
  if (process.env.SECONDBRAIN_DATA_DIR) return process.env.SECONDBRAIN_DATA_DIR;
  // A test that names no data dir must never pick up a live host's schedule.
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return null;
  return '/opt/secondbrain/data';
}

// Only an attended owner session may create a catch-up. The command proves a
// live SSH operator process (the same proof attended actions use) and signs
// the record with the attended-action secret; an unsigned or altered record is
// ignored, so no background process can move the night by writing a file.
const RUN_SCHEDULE_ISSUER = 'attended-ssh-catch-up';
const SIGNED_SCHEDULE_FIELDS = ['schema', 'kind', 'date', 'shiftMs', 'createdAt', 'requestedBy', 'reason', 'authorization'];

function runScheduleSignature(record, secret) {
  const body = JSON.stringify(SIGNED_SCHEDULE_FIELDS.map((key) => [key, record[key] ?? null]));
  return require('node:crypto').createHmac('sha256', String(secret)).update(body).digest('hex');
}

function attendedActionSecret(secret) {
  if (secret !== undefined) return String(secret || '');
  // Lazy: briefing-attended-action.js requires this module at load.
  return String(require('./briefing-attended-action.js').resolveAttendedActionSecret() || '');
}

// Validates the record against the canonical clock it claims to shift, so a
// hand-edited file cannot widen a window beyond one same-day catch-up.
function validRunSchedule(record, day, { secret } = {}) {
  if (!record || record.schema !== RUN_SCHEDULE_SCHEMA || record.date !== day) return null;
  if (record.kind !== 'catch-up') return null;
  const authorization = record.authorization || {};
  if (authorization.issuer !== RUN_SCHEDULE_ISSUER || !authorization.proof || !authorization.approvalId) return null;
  const key = attendedActionSecret(secret);
  if (!key || !/^[0-9a-f]{64}$/.test(String(record.signature || ''))) return null;
  const expected = Buffer.from(runScheduleSignature(record, key), 'hex');
  if (!require('node:crypto').timingSafeEqual(expected, Buffer.from(record.signature, 'hex'))) return null;
  const shiftMs = Number(record.shiftMs);
  if (!Number.isFinite(shiftMs) || shiftMs <= 0) return null;
  const canonical = canonicalNightClock(day);
  const shifted = Object.fromEntries(
    Object.entries(canonical).map(([key, value]) => [key, value + shiftMs]),
  );
  const latestDeliveryMs = ctWallTimeToEpochMs(
    day,
    CATCH_UP_LATEST_DELIVERY_HOUR_CT,
    CATCH_UP_LATEST_DELIVERY_MINUTE_CT,
  );
  if (shifted.deliveryDeadlineMs > latestDeliveryMs) return null;
  if (dateKeyInCt(shifted.inputStartMs) !== day) return null;
  return { ...record, shiftMs, canonical, shifted };
}

// Window functions run many times per pass; verify a record once per version.
const scheduleCache = new Map();

function readBriefingRunSchedule(date, { dataDir, secret } = {}) {
  const day = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const root = scheduleDataDir(dataDir);
  if (!root) return null;
  const file = runSchedulePath(root, day);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const version = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const cached = secret === undefined ? scheduleCache.get(file) : null;
  if (cached && cached.version === version) return cached.schedule;
  let schedule = null;
  try {
    schedule = validRunSchedule(JSON.parse(fs.readFileSync(file, 'utf8')), day, { secret });
  } catch {
    schedule = null;
  }
  if (secret === undefined) scheduleCache.set(file, { version, schedule });
  return schedule;
}

// The catch-up offset for `date` in ms, or 0 on an ordinary night. For code
// that keeps its own night-relative wall times.
function catchUpShiftMs(date, { dataDir } = {}) {
  const schedule = readBriefingRunSchedule(date, { dataDir });
  return schedule ? schedule.shiftMs : 0;
}

// ctWallTimeToEpochMs for a night checkpoint: the same CT wall time, moved by
// the catch-up offset of the briefing night it belongs to. A wall time at or
// after noon on day X belongs to the night of X+1 (23:00 input start); an
// earlier one belongs to the night of X (02:00 research, 05:00 checks). Code
// that keeps its own night checkpoints calls this so a catch-up run keeps the
// same spacing, with the same arguments it passed before.
function nightWallClockMs(wallDay, hour, minute = 0, { dataDir } = {}) {
  const day = String(wallDay || '').slice(0, 10);
  const nightOf = Number(hour) >= 12 ? nextDateKey(day) : day;
  return ctWallTimeToEpochMs(day, hour, minute) + catchUpShiftMs(nightOf, { dataDir });
}

// The night clock for `date`: canonical, or shifted by that date's catch-up.
function briefingNightClock(date, { dataDir } = {}) {
  const day = String(date || '').slice(0, 10);
  const schedule = readBriefingRunSchedule(day, { dataDir });
  return schedule ? { ...schedule.shifted, catchUp: true } : { ...canonicalNightClock(day), catchUp: false };
}

// The catch-up schedule whose run window (input start to delivery) contains
// `nowMs`, if any. Only the current CT date can hold one.
function activeCatchUpSchedule(nowMs = Date.now(), { dataDir } = {}) {
  const schedule = readBriefingRunSchedule(dateKeyInCt(nowMs), { dataDir });
  if (!schedule) return null;
  const now = Number(nowMs);
  return now >= schedule.shifted.inputStartMs && now < schedule.shifted.deliveryDeadlineMs
    ? schedule
    : null;
}

function briefingRunWindow(date, { dataDir } = {}) {
  const day = String(date || '').slice(0, 10);
  const clock = briefingNightClock(day, { dataDir });
  return {
    date: day,
    inputStartMs: clock.inputStartMs,
    deliveryDeadlineMs: clock.deliveryDeadlineMs,
  };
}

// No model synthesis may hold the report past this instant; the report then
// finalizes deterministically so delivery always has final bytes.
function deterministicFinalizeMs(date, { dataDir } = {}) {
  const day = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return Number.NaN;
  return briefingNightClock(day, { dataDir }).deterministicFinalizeMs;
}

// Wall-clock label for an epoch in CT, e.g. "5:15 AM CT".
function ctClockLabel(epochMs) {
  return `${new Intl.DateTimeFormat('en-US', {
    timeZone: CT_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(epochMs))} CT`;
}

// The earliest instant the briefing Telegram pointer may send for `date`:
// 05:00 CT on the briefing date itself. Returns NaN for an invalid date.
function briefingTelegramNotBeforeMs(date) {
  const day = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return Number.NaN;
  return ctWallTimeToEpochMs(day, TELEGRAM_QUIET_END_HOUR_CT, 0);
}

// Daytime unattended-healer blackout: 05:30 CT (the delivery checkpoint) to
// 23:00 CT (the next canonical input window). An UNATTENDED run may still
// probe and try deterministic mechanical/refresh tactics in this window; it
// may not open a new agentic model session. A person watching (supervised),
// holding a verified attended-action token, or driving the dashboard button
// is exempt. The overnight window and bounded terminal settlement tail sit
// entirely outside this window by construction.
const DAYTIME_BLACKOUT_START_HOUR_CT = DELIVERY_HOUR_CT;
const DAYTIME_BLACKOUT_START_MINUTE_CT = DELIVERY_MINUTE_CT;
const DAYTIME_BLACKOUT_END_HOUR_CT = INPUT_START_HOUR_CT;

function unattendedHealerBlackoutWindow(date) {
  const day = String(date || '').slice(0, 10);
  return {
    date: day,
    startMs: ctWallTimeToEpochMs(
      day,
      DAYTIME_BLACKOUT_START_HOUR_CT,
      DAYTIME_BLACKOUT_START_MINUTE_CT,
    ),
    endMs: ctWallTimeToEpochMs(day, DAYTIME_BLACKOUT_END_HOUR_CT, 0),
  };
}

// True when `nowMs` falls inside the daytime blackout window for the CT
// calendar date it derives from `date`, or from `nowMs` itself when `date` is
// absent/invalid. Callers pass the board date they already hold; during
// normal daytime operation that equals the current CT calendar date, so the
// fallback keeps this usable from an early CLI parse that has not resolved a
// board date yet.
function isUnattendedDaytimeBlackout({ date, nowMs = Date.now(), dataDir } = {}) {
  const requested = String(date || '').slice(0, 10);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : dateKeyInCt(nowMs);
  // A catch-up run is that date's night, moved: inside its window the night's
  // own rules apply, not the daytime blackout.
  const catchUp = activeCatchUpSchedule(nowMs, { dataDir });
  if (catchUp && catchUp.date === day) return false;
  const window = unattendedHealerBlackoutWindow(day);
  if (!Number.isFinite(window.startMs) || !Number.isFinite(window.endMs)) return false;
  return Number(nowMs) >= window.startMs && Number(nowMs) < window.endMs;
}

// The hard end of the repair window for one board date, as an epoch. Any
// controller budget is truncated here, so a longer budget can never push
// repair past the bounded 5:25 settlement boundary or delay delivery.
function repairAdmissionCutoffMs(date, { dataDir } = {}) {
  // A caller may hold no board date yet. Return NaN instead of throwing, so an
  // absent date degrades to "no cutoff ceiling" rather than killing the launch.
  const day = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return Number.NaN;
  return briefingNightClock(day, { dataDir }).repairCutoffMs;
}

// The scheduled night's admission ends at settlement/cutoff. Authorized exact
// live units have their own lifecycle; this window never freezes their board.
function briefingRepairFreezeWindow(date) {
  const day = String(date || '').slice(0, 10);
  return {
    date: day,
    startMs: repairAdmissionCutoffMs(day),
    endMs: null,
  };
}

function isBriefingRepairFrozen({ date, dataDir, nowMs = Date.now(), includeFixedCutoff = true } = {}) {
  const requested = String(date || '').slice(0, 10);
  // Mutation authority must fail closed when a caller cannot identify the
  // exact board date. Falling back to today's date could reopen an older
  // briefing after its immutable boundary.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) return true;
  const day = requested;
  if (dataDir) {
    const { repairAdmissionDecision } = require('./briefing-terminal-state.js');
    const admission = repairAdmissionDecision({
      dataDir,
      date: day,
      nowMs,
      fixedCutoffMs: includeFixedCutoff ? repairAdmissionCutoffMs(day, { dataDir }) : undefined,
    });
    return admission.allowed !== true;
  }
  const window = briefingRepairFreezeWindow(day);
  if (!Number.isFinite(window.startMs) || !Number.isFinite(Number(nowMs))) return true;
  return Number(nowMs) >= window.startMs;
}

function earlyFinalizationEligibility({ dataDir, date, nowMs = Date.now() } = {}) {
  const run = readValidOvernightRun({ dataDir, date, requireTerminal: true, nowMs });
  if (!run) return { allowed: false, reason: 'terminal-overnight-run-missing' };
  let board;
  try {
    board = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'agent', 'dashboard-qc-result.json'), 'utf8'),
    );
  } catch {
    return { allowed: false, reason: 'same-date-live-board-missing' };
  }
  const { briefingAggregateStatus, briefingUnitCounts } = require('./live-board-truth.js');
  const aggregate = briefingAggregateStatus(board);
  const units = briefingUnitCounts(board);
  if (
    String(board?.date || '') !== String(date || '').slice(0, 10) ||
    board?.ran !== true ||
    board?.retry === true ||
    typeof board?.ok !== 'boolean' ||
    aggregate.status === 'unverified' ||
    !units?.complete
  ) {
    return { allowed: false, reason: 'same-date-live-board-unverified' };
  }
  if (units.red === 0) return { allowed: true, reason: 'all-red-units-clear', run, board };
  // The same general settle rule as the coordinator: once the single night
  // owner's repair run finished, every still-red unit is red for the day.
  if (nightRepairRunFinished(run, { date, nowMs }).finished) {
    return { allowed: true, reason: 'night-repair-run-finished', run, board };
  }
  const { readReportEvents, latestReportEventsBySubject } = require('./overnight-report-event-ledger.js');
  const eventRead = readReportEvents({ dataDir, date });
  const latest = latestReportEventsBySubject(eventRead.rows, 'card-lifecycle');
  const redUnits = Array.isArray(units.redUnits) ? units.redUnits : [];
  if (units.red > 0 && redUnits.length === 0) {
    return { allowed: false, reason: 'same-date-live-board-red-units-unidentified' };
  }
  const { hasCurrentTerminalProof } = require('./briefing-card-report-evidence.js');
  const { deterministicOnly } = require('./briefing-healer-policy.js');
  // The same unit filter and proof predicate as the coordinator frontier
  // (briefing-night-coordinator.js actionableFrontier). A red row the night
  // can never schedule (actionable:false) or that has no coding repair owner
  // (deterministicOnly) is report evidence, not an open repair unit.
  const openRedUnits = redUnits.filter((unit) => {
    if (!unit || unit.actionable === false || deterministicOnly(unit.id)) return false;
    const event = latest.get(String(unit.id || '').toLowerCase());
    return !hasCurrentTerminalProof({ event, board, unitId: unit.id });
  });
  return openRedUnits.length === 0
    ? { allowed: true, reason: 'every-red-unit-has-current-terminal-proof', run, board }
    : {
        allowed: false,
        reason: 'healable-red-units-remain',
        openRedUnitIds: openRedUnits.map((unit) => unit.id),
      };
}

function hostWorkDeferredReason(value) {
  const match = String(value || '').match(/host-work-deferred:([a-z0-9-]+)/i);
  return match ? match[1].toLowerCase() : '';
}

// A controller process can finish without settling its board. Capacity
// deferrals are explicit retry receipts, not successful terminal states. Keep
// that distinction in one dependency-light module so the EC2 supervisor and
// attended watcher cannot disagree about the same receipt again.
function controllerTerminalRecoveryNeed(row, { date = row?.date, nowMs = Date.now() } = {}) {
  const outcome = String(row?.outcome || '')
    .trim()
    .toLowerCase();
  const startedAtMs = Date.parse(row?.startedAt);
  const finishedAtMs = Date.parse(row?.finishedAt);
  const terminal = Boolean(
    TERMINAL_OVERNIGHT_OUTCOMES.has(outcome) &&
    Number.isFinite(startedAtMs) &&
    Number.isFinite(finishedAtMs) &&
    finishedAtMs >= startedAtMs &&
    finishedAtMs <= nowMs,
  );
  const hasFinalBoard =
    Array.isArray(row?.final?.nonCleanCards) ||
    Number.isFinite(Number(row?.final?.defectiveCardCount));
  const nonCleanCount = Array.isArray(row?.final?.nonCleanCards)
    ? row.final.nonCleanCards.length
    : Number.isFinite(Number(row?.final?.defectiveCardCount))
      ? Math.max(0, Number(row.final.defectiveCardCount))
      : null;
  if (!terminal) {
    return {
      terminal: false,
      settled: false,
      retryable: false,
      reason: 'controller-not-terminal',
      deferredReasons: [],
      nonCleanCount,
    };
  }
  if (outcome === 'clean' && hasFinalBoard && Number(nonCleanCount) === 0) {
    return {
      terminal: true,
      settled: true,
      retryable: false,
      reason: 'controller-terminal-settled',
      deferredReasons: [],
      nonCleanCount,
    };
  }

  const deferredReasons = new Set();
  const collectReason = (value) => {
    const reason = hostWorkDeferredReason(value);
    if (reason) deferredReasons.add(reason);
  };
  collectReason(row?.error);
  for (const source of Array.isArray(row?.sourceFamilies) ? row.sourceFamilies : []) {
    collectReason(source?.error);
    if (source?.capacityDeferred === true && !hostWorkDeferredReason(source?.error)) {
      deferredReasons.add('host-capacity-deferred');
    }
  }
  for (const card of Array.isArray(row?.cards) ? row.cards : []) {
    collectReason(card?.stage?.error);
    collectReason(card?.command?.error);
    collectReason(card?.agenticHealer?.error);
    collectReason(card?.agenticHealer?.verdictReason);
    if (HOST_CAPACITY_DEFERRED_CARD_OUTCOMES.has(String(card?.outcome || '').toLowerCase())) {
      const explicit =
        hostWorkDeferredReason(card?.stage?.error) ||
        hostWorkDeferredReason(card?.command?.error) ||
        hostWorkDeferredReason(card?.agenticHealer?.error);
      if (!explicit) deferredReasons.add('host-capacity-deferred');
    }
  }
  for (const healer of Array.isArray(row?.healers) ? row.healers : []) {
    collectReason(healer?.error);
    collectReason(healer?.verdictReason);
  }

  const reasons = [...deferredReasons].sort();
  const cutoffMs = repairAdmissionCutoffMs(date);
  const beforeRepairCutoff = !Number.isFinite(cutoffMs) || Number(nowMs) < cutoffMs;
  if (reasons.length && beforeRepairCutoff) {
    return {
      terminal: true,
      settled: false,
      retryable: true,
      reason: 'terminal-host-work-deferred',
      deferredReasons: reasons,
      nonCleanCount,
    };
  }
  if (!hasFinalBoard && beforeRepairCutoff) {
    return {
      terminal: true,
      settled: false,
      retryable: true,
      reason: 'terminal-settlement-unproven',
      deferredReasons: reasons,
      nonCleanCount,
    };
  }
  if (outcome === 'clean' && Number(nonCleanCount || 0) > 0 && beforeRepairCutoff) {
    return {
      terminal: true,
      settled: false,
      retryable: true,
      reason: 'terminal-clean-outcome-contradicts-board',
      deferredReasons: reasons,
      nonCleanCount,
    };
  }
  return {
    terminal: true,
    settled: true,
    retryable: false,
    reason: beforeRepairCutoff ? 'controller-terminal-settled' : 'repair-cutoff-reached',
    deferredReasons: reasons,
    nonCleanCount,
  };
}

// ExampleCo, 2026-09-24: "if it's terminal and can't heal then just call it a
// night." The single night owner runs exactly one controller per night and
// never relaunches it once production settled (amy-night-run.js), so when that
// run has finished with no host-deferred work and no healer or card still in
// flight, no in-night action remains for any still-red unit. The night may
// settle at once; every such unit is red for the day. This is one general
// rule, independent of per-class terminal proof. Attended, daytime, or legacy
// runs (no nightOwner stamp) never qualify and keep the frontier and 04:30
// cutoff rules.
function nightRepairRunFinished(row, { date = row?.date, nowMs = Date.now() } = {}) {
  if (!row || row.nightOwner !== 'single' || row.mode !== 'overnight') {
    return { finished: false, reason: 'not-single-night-owner-run' };
  }
  const recovery = controllerTerminalRecoveryNeed(row, { date, nowMs });
  if (recovery.settled !== true) return { finished: false, reason: recovery.reason };
  const healers = Array.isArray(row.healers) ? row.healers : [];
  if (
    recovery.deferredReasons.length ||
    healers.some(
      (healer) =>
        healer && (healer.capacityDeferred === true || healer.disposition === 'deferred_capacity'),
    )
  ) {
    return { finished: false, reason: 'host-capacity-deferred-work' };
  }
  if (healers.some((healer) => healer && healer.triggered === true && !healer.finishedAt)) {
    return { finished: false, reason: 'healer-in-flight' };
  }
  if ((Array.isArray(row.cards) ? row.cards : []).some((card) => card && !card.finishedAt)) {
    return { finished: false, reason: 'card-in-flight' };
  }
  return { finished: true, reason: 'night-repair-run-finished' };
}

function overnightStartGate({ date, now = new Date() } = {}) {
  const instant = now instanceof Date ? now : new Date(now);
  const nowMs = instant.getTime();
  const requestedDate = String(date || '').slice(0, 10);
  if (!Number.isFinite(nowMs) || !requestedDate) {
    return { allowed: false, reason: 'invalid-briefing-clock-or-date' };
  }
  const ctDate = dateKeyInCt(nowMs);
  const nextDate = nextDateKey(ctDate);
  const window = briefingRunWindow(requestedDate);
  if (requestedDate > nextDate) {
    return { allowed: false, reason: 'briefing-date-too-far-ahead', ctDate, ...window };
  }
  if (requestedDate === nextDate && nowMs < window.inputStartMs) {
    return { allowed: false, reason: 'before-11pm-input-window', ctDate, ...window };
  }
  return { allowed: true, reason: null, ctDate, ...window };
}

// The operational dashboard may show the next briefing date only after that
// date's canonical 11 PM CT input window opens. This predicate intentionally
// uses only the window boundary, not the controller's broader admission gate.
function operationalBriefingDates(dates, { nowMs = Date.now() } = {}) {
  return [...new Set(Array.isArray(dates) ? dates.map((date) => String(date || '')) : [])]
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .filter((date) => nowMs >= briefingRunWindow(date).inputStartMs)
    .sort((a, b) => b.localeCompare(a));
}

function controllerRunDir(dataDir, date) {
  return path.join(dataDir, 'agent', 'card-controller', 'runs', date);
}

function readValidOvernightRun({
  dataDir,
  date,
  requireTerminal = false,
  nowMs = Date.now(),
} = {}) {
  const window = briefingRunWindow(date, { dataDir });
  let files = [];
  try {
    files = fs
      .readdirSync(controllerRunDir(dataDir, date))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const name of files) {
    let row;
    try {
      row = JSON.parse(fs.readFileSync(path.join(controllerRunDir(dataDir, date), name), 'utf8'));
    } catch {
      continue;
    }
    const startedAtMs = Date.parse(row && row.startedAt);
    const terminal =
      Number.isFinite(Date.parse(row && row.finishedAt)) &&
      !['running', 'lease-held', 'shadow-planned', 'blocked-before-input-window'].includes(
        String((row && row.outcome) || ''),
      );
    if (
      row &&
      row.date === date &&
      row.mode === 'overnight' &&
      (row.bootstrapRequested === true || !!row.bootstrap) &&
      Number.isFinite(startedAtMs) &&
      startedAtMs >= window.inputStartMs &&
      startedAtMs <= nowMs &&
      (!requireTerminal || terminal)
    ) {
      return row;
    }
  }
  return null;
}

// Read the newest eligible run by its authenticated start time, not filename
// order and not "newest terminal" order. Watcher/report gates use this so an
// older terminal receipt can never hide a newer running retry.
function readLatestValidOvernightRun({ dataDir, date, nowMs = Date.now() } = {}) {
  const window = briefingRunWindow(date, { dataDir });
  let files = [];
  try {
    files = fs
      .readdirSync(controllerRunDir(dataDir, date))
      .filter((name) => name.endsWith('.json'));
  } catch {
    return null;
  }
  const eligible = [];
  for (const name of files) {
    let row;
    try {
      row = JSON.parse(fs.readFileSync(path.join(controllerRunDir(dataDir, date), name), 'utf8'));
    } catch {
      continue;
    }
    const startedAtMs = Date.parse(row?.startedAt);
    if (
      row?.date === date &&
      row?.mode === 'overnight' &&
      (row.bootstrapRequested === true || !!row.bootstrap) &&
      Number.isFinite(startedAtMs) &&
      startedAtMs >= window.inputStartMs &&
      startedAtMs <= nowMs
    ) {
      eligible.push({ row, name, startedAtMs });
    }
  }
  eligible.sort(
    (a, b) => b.startedAtMs - a.startedAtMs || String(b.name).localeCompare(String(a.name)),
  );
  return eligible[0]?.row || null;
}

function isTerminalOvernightRun(row, nowMs = Date.now()) {
  const startedAtMs = Date.parse(row?.startedAt);
  const finishedAtMs = Date.parse(row?.finishedAt);
  return Boolean(
    row &&
    TERMINAL_OVERNIGHT_OUTCOMES.has(
      String(row.outcome || '')
        .trim()
        .toLowerCase(),
    ) &&
    row.final &&
    typeof row.final === 'object' &&
    Array.isArray(row.final.nonCleanCards) &&
    Number.isFinite(startedAtMs) &&
    Number.isFinite(finishedAtMs) &&
    finishedAtMs >= startedAtMs &&
    finishedAtMs <= nowMs,
  );
}

module.exports = {
  CT_ZONE,
  INPUT_START_HOUR_CT,
  DELIVERY_HOUR_CT,
  DELIVERY_MINUTE_CT,
  TERMINAL_OVERNIGHT_OUTCOMES,
  dateKeyInCt,
  previousDateKey,
  nextDateKey,
  ctWallTimeToEpochMs,
  REPAIR_CUTOFF_HOUR_CT,
  REPAIR_CUTOFF_MINUTE_CT,
  DETERMINISTIC_FINALIZE_HOUR_CT,
  DETERMINISTIC_FINALIZE_MINUTE_CT,
  TELEGRAM_QUIET_END_HOUR_CT,
  TELEGRAM_QUIET_START_HOUR_CT,
  briefingTelegramNotBeforeMs,
  repairAdmissionCutoffMs,
  briefingRepairFreezeWindow,
  isBriefingRepairFrozen,
  earlyFinalizationEligibility,
  DAYTIME_BLACKOUT_START_HOUR_CT,
  DAYTIME_BLACKOUT_START_MINUTE_CT,
  DAYTIME_BLACKOUT_END_HOUR_CT,
  unattendedHealerBlackoutWindow,
  isUnattendedDaytimeBlackout,
  hostWorkDeferredReason,
  controllerTerminalRecoveryNeed,
  nightRepairRunFinished,
  briefingRunWindow,
  briefingNightClock,
  canonicalNightClock,
  deterministicFinalizeMs,
  ctClockLabel,
  RUN_SCHEDULE_SCHEMA,
  RUN_SCHEDULE_ISSUER,
  runScheduleSignature,
  CATCH_UP_LATEST_DELIVERY_HOUR_CT,
  CATCH_UP_LATEST_DELIVERY_MINUTE_CT,
  runScheduleDir,
  runSchedulePath,
  readBriefingRunSchedule,
  activeCatchUpSchedule,
  catchUpShiftMs,
  nightWallClockMs,
  overnightStartGate,
  operationalBriefingDates,
  controllerRunDir,
  isTerminalOvernightRun,
  readLatestValidOvernightRun,
  readValidOvernightRun,
};
