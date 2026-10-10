'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { collectTokenSpendPareto } = require('./token-spend-pareto.js');
const { briefingRunWindow, dateKeyInCt, nextDateKey } = require('./briefing-run-window.js');
const { appendTerminalEvidenceEvent } = require('./overnight-report-event-ledger.js');

const CIRCUIT_SCHEMA = 'secondbrain.briefing-night-circuit.v1';
// 2026-09-02 night hotfix: ExampleCo approved raising the overnight circuit from
// 25M/30M to 600M for the night after the 25M nonessential cap starved every
// healer run ("deferred capacity"). The corpus is single-host (EC2
// ip-172-31-78-241, corpusScope: single-host): the 27.29M overnight spend
// was genuine agentic-healer-driver work on the EC2 briefing host itself
// (Codex 62.7M across 879 healer sessions, Claude 3.5M for that slice), not
// "same-UTC-day attended desktop sessions" as an earlier version of this
// comment claimed. Kept the report delivery reserve unchanged, so the
// derived nonessential cap is 595M.
const DEFAULT_TOKEN_CAP = 600_000_000;
const DEFAULT_REPORT_DELIVERY_RESERVE = 5_000_000;
const DEFAULT_LAUNCH_RESERVATION = 250_000;
// 2026-09-02 night hotfix: a static 10M/hr default no longer matches a
// raised cap, so the default now scales with it (see limitsFromEnv). This
// constant is kept only as the pre-hotfix historical value; nothing derives
// from it anymore. BRIEFING_NIGHT_SLOPE_LIMIT_PER_HOUR still overrides.
const DEFAULT_SLOPE_LIMIT_PER_HOUR = 10_000_000;
const NIGHT_WINDOW_HOURS = 6.5; // 23:00 to 05:30 CT
const DEFAULT_SLOPE_WINDOW_MINUTES = 30;
const DEFAULT_SLOPE_MIN_SPAN_MINUTES = 10;
const DEFAULT_SLOPE_WINDOW_MS = DEFAULT_SLOPE_WINDOW_MINUTES * 60_000;
const DEFAULT_SLOPE_MIN_SPAN_MS = DEFAULT_SLOPE_MIN_SPAN_MINUTES * 60_000;
const DEFAULT_MEASUREMENT_CACHE_MS = 60_000;
const DEFAULT_STORAGE_RESERVE_BYTES = 1024 * 1024 * 1024;
const ACTIVE_RESERVATION_MS = 20 * 60_000;
const SETTLED_RESERVATION_LAG_MS = 2 * 60_000;
const ESSENTIAL_PRIORITIES = new Set(['report', 'delivery']);
// 2026-09-02 night hotfix: a burst measured over 1-2 minutes and naively
// extrapolated to an hour tripped the slope guard 652 times overnight
// 2026-09-01/02 even though the sustained rate over the surrounding 25
// minutes (62,358,361 tokens at 10:03:43Z to 66,201,580 at 10:29:02Z) was
// only ~9.2M/hr. A 30-minute retention window at roughly one measurement
// per minute needs more than the old 24-row ring to stay populated.
const MEASUREMENT_RETENTION = 240;

// Terminal evidence dedupe window (2026-09-02): a single busy night denies
// hundreds of launches on the same (lane, reason) pair (652 on
// spend-slope-limit-crossed, 802 on report-delivery-reserve-protected the
// night of 2026-09-01/02); one report event row per (lane, reason) per this
// window keeps that a systemic cause the report can see, not a flood.
const NIGHT_CIRCUIT_EVIDENCE_DEDUPE_MS = 10 * 60_000;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function inferBriefingDate(nowMs = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(nowMs))
      .map((part) => [part.type, part.value]),
  );
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return Number(parts.hour) >= 23 ? nextDateKey(day) : day;
}

function circuitRoot(dataDir) {
  return path.join(dataDir, 'agent', 'briefing-night-circuit');
}

function circuitStatePath(dataDir, date) {
  return path.join(circuitRoot(dataDir), `${date}.json`);
}

function writeJsonAtomic(file, value, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fsApi.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fsApi.renameSync(temp, file);
}

function appendEvent(dataDir, row, fsApi = fs) {
  const file = path.join(circuitRoot(dataDir), 'events.jsonl');
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  fsApi.appendFileSync(file, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function readState(file, date, fsApi = fs) {
  try {
    const parsed = JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (parsed.schema !== CIRCUIT_SCHEMA || parsed.date !== date) {
      return { ok: false, error: 'circuit-state-schema-or-date-mismatch' };
    }
    return { ok: true, state: parsed };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        ok: true,
        state: {
          schema: CIRCUIT_SCHEMA,
          date,
          measurements: [],
          reservations: [],
          emergencyOverrideUsed: false,
        },
      };
    }
    return { ok: false, error: 'circuit-state-unreadable' };
  }
}

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withCircuitLock(dataDir, date, fn, fsApi = fs) {
  const root = circuitRoot(dataDir);
  fsApi.mkdirSync(root, { recursive: true });
  const lock = path.join(root, `${date}.lock`);
  const deadline = Date.now() + 2_000;
  let fd = null;
  while (fd == null) {
    try {
      fd = fsApi.openSync(lock, 'wx', 0o600);
    } catch (error) {
      if (!error || error.code !== 'EEXIST' || Date.now() >= deadline) {
        throw new Error('briefing-night-circuit-lock-unavailable');
      }
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fsApi.closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      fsApi.unlinkSync(lock);
    } catch {
      /* a failed unlock will make the next admission fail closed */
    }
  }
}

// 2026-09-02 night hotfix: a denial used to name only machine numbers, so a
// report reader could not tell WHO spent the tokens without a separate
// lookup. Pull the top consumers straight out of the same collector report
// the measurement itself came from (report.overnight.platforms.<platform>.
// topSessions), merged and ranked across every platform.
// FIX 5 (2026-09-23, token-tracking-fixes): a healer session's meta.process
// (scripts/lib/token-spend-pareto.js's healerRepairTarget(), the same
// classification token-spend-weekly.js's projectTag() already applies to the
// weekly rollup) names the actual repair target -- "Metric repair:
// system_health:<x>" / "Briefing repair: <card>" -- instead of the bare
// session title. Prefer it here so a denial or the token card names WHAT was
// being repaired, not just which anonymous session spent the tokens.
const REPAIR_TARGET_LABEL_RE = /^(?:Metric repair|Briefing repair|Card assembly repair):/;
function topConsumersFromReport(report) {
  const platforms = (report && report.overnight && report.overnight.platforms) || {};
  const rows = [];
  for (const [platform, data] of Object.entries(platforms)) {
    const topSessions = Array.isArray(data && data.topSessions) ? data.topSessions : [];
    for (const session of topSessions) {
      const process = String((session && session.meta && session.meta.process) || '');
      const label = REPAIR_TARGET_LABEL_RE.test(process)
        ? process
        : String((session && session.label) || (session && session.key) || 'unknown');
      rows.push({
        platform,
        label,
        tokens: Math.max(0, Number(session && session.tokens) || 0),
        turns: Math.max(0, Number(session && session.turns) || 0),
      });
    }
  }
  return rows.sort((left, right) => right.tokens - left.tokens).slice(0, 5);
}

function measurementFor({ date, dataDir, nowMs, collector, cacheMs }) {
  const outputPath = path.join(circuitRoot(dataDir), `${date}-token-snapshot.json`);
  const report = collector({
    nowMs,
    cacheMs,
    force: false,
    outputPath,
  });
  if (
    !report ||
    report.schema !== 'token-spend-pareto.v1' ||
    report.overnight?.date !== date ||
    !Number.isFinite(Number(report.overnight?.combinedTokens))
  ) {
    throw new Error('fork-aware-overnight-token-measurement-unavailable');
  }
  return {
    measuredAt: String(report.generatedAt || new Date(nowMs).toISOString()),
    measuredTokens: Math.max(0, Number(report.overnight.combinedTokens) || 0),
    source: 'token-spend-pareto.v1:overnight:fork-aware',
    topConsumers: topConsumersFromReport(report),
  };
}

// 2026-09-02 night hotfix: the old algorithm always used the single nearest
// prior sample that was >=60s old, so a genuine 1-2 minute measurement
// cadence let a short burst get extrapolated to an hourly rate (400k tokens
// in 62 seconds reads as a ~23M/hr slope). It now always measures from the
// OLDEST sample within a bounded window, so a burst inside an otherwise flat
// window is diluted by the whole window instead of read off just its two
// nearest points, and refuses to report a rate at all across a span too
// short to trust (default: less than 10 minutes).
function slopeWindowStats(
  measurements = [],
  { windowMs = DEFAULT_SLOPE_WINDOW_MS, minSpanMs = DEFAULT_SLOPE_MIN_SPAN_MS } = {},
) {
  const rows = measurements
    .map((row) => ({
      at: Date.parse(String(row.measuredAt || '')),
      tokens: Math.max(0, Number(row.measuredTokens) || 0),
      measuredAt: String(row.measuredAt || ''),
    }))
    .filter((row) => Number.isFinite(row.at))
    .sort((left, right) => left.at - right.at);
  if (rows.length < 2) {
    return { slopePerHour: 0, spanMs: 0, oldest: null, latest: null, burstPerHour: 0 };
  }
  const latest = rows.at(-1);
  const withinWindow = rows.filter((row) => latest.at - row.at <= windowMs);
  const oldest = withinWindow[0];
  const spanMs = latest.at - oldest.at;
  // Short-window burst rate from the nearest settled sample at least one
  // minute older (Codex review 2026-09-02): before the minimum span exists
  // the trend slope is zero, so a separate, much higher burst fuse guards
  // the first minutes of the night against a runaway launch storm.
  // The nearest prior sample of any age counts, with the span floored at one
  // minute so a sub-minute jump is rated conservatively instead of ignored
  // (Codex follow-up 2026-09-02: the fuse must not be blind in its first minute).
  const burstPrior = rows.at(-2);
  const burstPerHour =
    burstPrior && latest.tokens > burstPrior.tokens
      ? Math.round(
          ((latest.tokens - burstPrior.tokens) * 3_600_000) /
            Math.max(60_000, latest.at - burstPrior.at),
        )
      : 0;
  if (withinWindow.length < 2 || spanMs < minSpanMs || latest.tokens <= oldest.tokens) {
    return { slopePerHour: 0, spanMs, oldest, latest, burstPerHour };
  }
  return {
    slopePerHour: Math.round(((latest.tokens - oldest.tokens) * 3_600_000) / spanMs),
    spanMs,
    oldest,
    latest,
    burstPerHour,
  };
}

function currentSlopePerHour(measurements = [], opts = {}) {
  return slopeWindowStats(measurements, opts).slopePerHour;
}

function activeReservationTokens(reservations = [], nowMs = Date.now()) {
  return reservations
    .filter((row) => Date.parse(String(row.expiresAt || '')) > nowMs)
    .reduce((sum, row) => sum + Math.max(0, Number(row.reservedTokens) || 0), 0);
}

function limitsFromEnv(env = process.env) {
  const tokenCap = positiveInt(env.BRIEFING_NIGHT_TOKEN_CAP, DEFAULT_TOKEN_CAP);
  const reportDeliveryReserve = Math.min(
    tokenCap,
    positiveInt(env.BRIEFING_NIGHT_REPORT_DELIVERY_RESERVE, DEFAULT_REPORT_DELIVERY_RESERVE),
  );
  const nonessentialCap = Math.max(0, tokenCap - reportDeliveryReserve);
  const slopeLimitPerHour = positiveInt(
    env.BRIEFING_NIGHT_SLOPE_LIMIT_PER_HOUR,
    Math.round(nonessentialCap / NIGHT_WINDOW_HOURS),
  );
  return {
    tokenCap,
    reportDeliveryReserve,
    nonessentialCap,
    // 2026-09-02 night hotfix: with no explicit override, the slope limit
    // scales with whatever cap is actually configured (a 6.5-hour night,
    // 23:00-05:30 CT) instead of a stale hand-picked constant that no
    // longer matches the raised 600M/595M cap.
    slopeLimitPerHour,
    // Short-window burst fuse (Codex review 2026-09-02): three times the slope
    // limit unless overridden; it applies only before the trend window has
    // its minimum span.
    burstLimitPerHour: positiveInt(env.BRIEFING_NIGHT_BURST_LIMIT_PER_HOUR, slopeLimitPerHour * 3),
    slopeWindowMs:
      positiveInt(env.BRIEFING_NIGHT_SLOPE_WINDOW_MINUTES, DEFAULT_SLOPE_WINDOW_MINUTES) * 60_000,
    slopeMinSpanMs:
      positiveInt(env.BRIEFING_NIGHT_SLOPE_MIN_SPAN_MINUTES, DEFAULT_SLOPE_MIN_SPAN_MINUTES) *
      60_000,
    launchReservation: positiveInt(
      env.BRIEFING_NIGHT_LAUNCH_RESERVATION,
      DEFAULT_LAUNCH_RESERVATION,
    ),
    measurementCacheMs: positiveInt(
      env.BRIEFING_NIGHT_MEASUREMENT_CACHE_MS,
      DEFAULT_MEASUREMENT_CACHE_MS,
    ),
    storageReserveBytes: positiveInt(
      env.BRIEFING_REPORT_STORAGE_RESERVE_BYTES,
      DEFAULT_STORAGE_RESERVE_BYTES,
    ),
  };
}

function storageReserveStatus(dataDir, reserveBytes, fsApi = fs) {
  try {
    const stat = fsApi.statfsSync(dataDir);
    const blockSize = Number(stat.bsize || stat.frsize || 0);
    const availableBytes = blockSize * Number(stat.bavail ?? stat.bfree ?? 0);
    if (!Number.isFinite(availableBytes) || availableBytes < 0) {
      return { ok: false, availableBytes: null, reason: 'storage-measurement-unavailable' };
    }
    return {
      ok: availableBytes >= reserveBytes,
      availableBytes,
      reason:
        availableBytes >= reserveBytes ? 'storage-reserve-met' : 'storage-report-reserve-not-met',
    };
  } catch {
    return { ok: false, availableBytes: null, reason: 'storage-measurement-unavailable' };
  }
}

function outsideWindow(date, nowMs) {
  const window = briefingRunWindow(date);
  return nowMs < window.inputStartMs || nowMs > window.deliveryDeadlineMs;
}

// 2026-09-02 night hotfix: a "deferred capacity" verdict used to name only
// admitBriefingModelLaunch's machine reason code (e.g.
// 'report-delivery-reserve-protected'), with the guard, threshold, and
// observed value only present as separate unlabeled numeric fields on the
// admission object. A refusal receipt now names the guard, its threshold,
// the observed value that crossed it, and this source file in one string,
// so a report writer or an on-call read does not have to reconstruct which
// of five independent guards actually fired from raw numbers.
const GUARD_SOURCE_FILE = 'scripts/lib/briefing-night-circuit.js';

function describeCircuitDenial(admission) {
  if (!admission || admission.allowed !== false) return '';
  const reason = String(admission.reason || 'unknown-denial');
  const detail = {
    'hard-token-cap-crossed': {
      guard: 'hard token cap',
      threshold: `tokenCap=${admission.tokenCap}`,
      observed: `projectedTokens=${admission.projectedTokens}`,
    },
    'report-delivery-reserve-protected': {
      guard: 'report-delivery reserve',
      threshold: `nonessentialCap=${admission.nonessentialCap} (tokenCap ${admission.tokenCap} minus reportDeliveryReserve ${admission.reportDeliveryReserve})`,
      observed: `projectedTokens=${admission.projectedTokens} (measured ${admission.measuredTokens} + pending ${admission.pendingTokens} + reserved ${admission.reservedTokens})`,
    },
    'spend-slope-limit-crossed': {
      guard: 'spend slope limit',
      threshold: `slopeLimitPerHour=${admission.slopeLimitPerHour}`,
      observed: `slopePerHour=${admission.slopePerHour} over a ${admission.slopeSpanMinutes}m window (${admission.slopeOldestMeasuredTokens}@${admission.slopeOldestMeasuredAt} to ${admission.slopeLatestMeasuredTokens}@${admission.slopeLatestMeasuredAt})`,
    },
    'spend-burst-limit-crossed': {
      guard: 'spend burst limit (short window)',
      threshold: `burstLimitPerHour=${admission.burstLimitPerHour} (three times the slope limit) while the trend window is under ${admission.slopeMinSpanMinutes}m`,
      observed: `burstPerHour=${admission.burstPerHour} from the nearest settled samples`,
    },
    'token-measurement-unavailable': {
      guard: 'token measurement availability',
      threshold: 'a successful token-spend-pareto measurement',
      observed: admission.measurementError || 'measurement failed with no error text',
    },
    'storage-report-reserve-not-met': {
      guard: 'storage reserve',
      threshold: `storageReserveBytes=${admission.storageReserveBytes}`,
      observed: `storageAvailableBytes=${admission.storageAvailableBytes}`,
    },
    'storage-measurement-unavailable': {
      guard: 'storage reserve',
      threshold: `storageReserveBytes=${admission.storageReserveBytes}`,
      observed: 'storage measurement unavailable',
    },
    'circuit-state-schema-or-date-mismatch': {
      guard: 'circuit state integrity',
      threshold: 'a readable, schema- and date-matched circuit state file',
      observed: 'circuit-state-schema-or-date-mismatch',
    },
    'circuit-state-unreadable': {
      guard: 'circuit state integrity',
      threshold: 'a readable circuit state file',
      observed: 'circuit-state-unreadable',
    },
  }[reason] || { guard: reason, threshold: 'n/a', observed: 'n/a' };
  return `guard=${detail.guard}, threshold=${detail.threshold}, observed=${detail.observed}, source=${GUARD_SOURCE_FILE}`;
}

function admitBriefingModelLaunch({
  date = '',
  dataDir,
  lane = 'briefing-model',
  priority = 'nonessential',
  estimatedTokens = 0,
  overrideReason = '',
  nowMs = Date.now(),
  env = process.env,
  collector = collectTokenSpendPareto,
  fsApi = fs,
} = {}) {
  if (!dataDir) throw new Error('briefing night circuit requires dataDir');
  const day = String(date || inferBriefingDate(nowMs)).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('invalid briefing date');
  // STRATEGIC-4: a cache-only verification run must be able to prove that no
  // model launch was admitted, including launches attempted outside the usual
  // overnight window. This policy has no emergency override.
  if (String(env.BRIEFING_MODEL_LAUNCH_POLICY || '').toLowerCase() === 'deny') {
    const denied = {
      schema: CIRCUIT_SCHEMA,
      ts: new Date(nowMs).toISOString(),
      date: day,
      event: 'admission-denied',
      lane: String(lane || 'briefing-model'),
      priority: String(priority || 'nonessential'),
      reason: 'run-policy-denies-model-launch',
      zeroModelRunId: String(env.BRIEFING_ZERO_MODEL_RUN_ID || '').slice(0, 160),
    };
    appendEvent(dataDir, denied, fsApi);
    return { allowed: false, enforced: true, ...denied };
  }
  if (outsideWindow(day, nowMs)) {
    return { allowed: true, enforced: false, reason: 'outside-briefing-window', date: day };
  }
  const limits = limitsFromEnv(env);
  const storage = storageReserveStatus(dataDir, limits.storageReserveBytes, fsApi);
  const reservedTokens = positiveInt(estimatedTokens, limits.launchReservation);
  const essential = ESSENTIAL_PRIORITIES.has(String(priority));
  let measurement = null;
  let measurementError = '';
  try {
    measurement = measurementFor({
      date: day,
      dataDir,
      nowMs,
      collector,
      cacheMs: limits.measurementCacheMs,
    });
  } catch (error) {
    measurementError = String((error && error.message) || error);
  }

  return withCircuitLock(
    dataDir,
    day,
    () => {
      const file = circuitStatePath(dataDir, day);
      const loaded = readState(file, day, fsApi);
      const ts = new Date(nowMs).toISOString();
      if (!loaded.ok) {
        const denied = {
          schema: CIRCUIT_SCHEMA,
          ts,
          date: day,
          event: 'admission-denied',
          lane,
          priority,
          reason: loaded.error,
        };
        appendEvent(dataDir, denied, fsApi);
        return { allowed: false, enforced: true, ...denied };
      }
      // Token pressure is observational, but disk capacity is physical: once
      // report storage falls below its reserve, a new model process can make
      // the host unable to write its own receipts or delivery artifact. No
      // emergency/token override may bypass this guard.
      if (!storage.ok) {
        const denied = {
          schema: CIRCUIT_SCHEMA,
          ts,
          date: day,
          event: 'admission-denied',
          lane: String(lane || 'briefing-model'),
          priority: String(priority || 'nonessential'),
          reason: storage.reason,
          storageAvailableBytes: storage.availableBytes,
          storageReserveBytes: limits.storageReserveBytes,
          emergencyOverride: false,
        };
        appendEvent(dataDir, denied, fsApi);
        return { allowed: false, enforced: true, ...denied };
      }
      const state = loaded.state;
      state.measurements = Array.isArray(state.measurements) ? state.measurements : [];
      state.reservations = (Array.isArray(state.reservations) ? state.reservations : []).filter(
        (row) => Date.parse(String(row.expiresAt || '')) > nowMs,
      );
      if (measurement) {
        const duplicate = state.measurements.some(
          (row) =>
            row.measuredAt === measurement.measuredAt &&
            Number(row.measuredTokens) === Number(measurement.measuredTokens),
        );
        // The ring only needs measuredAt/measuredTokens/source to compute the
        // slope; topConsumers is per-call evidence for THIS decision, kept
        // off the persisted ring so 240 retained rows do not each carry a
        // copy of the collector's top-sessions list.
        if (!duplicate) {
          state.measurements.push({
            measuredAt: measurement.measuredAt,
            measuredTokens: measurement.measuredTokens,
            source: measurement.source,
          });
        }
        state.measurements = state.measurements.slice(-MEASUREMENT_RETENTION);
      }
      const measuredTokens = measurement
        ? measurement.measuredTokens
        : Number(state.measurements.at(-1)?.measuredTokens || 0);
      const pendingTokens = activeReservationTokens(state.reservations, nowMs);
      const slope = slopeWindowStats(state.measurements, {
        windowMs: limits.slopeWindowMs,
        minSpanMs: limits.slopeMinSpanMs,
      });
      const slopePerHour = slope.slopePerHour;
      const projectedTokens = measuredTokens + pendingTokens + reservedTokens;
      // ExampleCo's approved overhaul turns the 600M ceiling and its derivative
      // reserve/slope fuses into observability. Scheduled work must continue;
      // the circuit reports the condition instead of denying a launch.
      const observations = [];
      if (measurementError) observations.push('token-measurement-unavailable');
      if (projectedTokens > limits.tokenCap) observations.push('hard-token-cap-crossed');
      if (!essential && projectedTokens > limits.nonessentialCap)
        observations.push('report-delivery-reserve-protected');
      if (!essential && slopePerHour >= limits.slopeLimitPerHour)
        observations.push('spend-slope-limit-crossed');
      if (
        !essential &&
        slope.spanMs < limits.slopeMinSpanMs &&
        slope.burstPerHour >= limits.burstLimitPerHour
      )
        observations.push('spend-burst-limit-crossed');

      const emergencyOverride = false;

      const base = {
        schema: CIRCUIT_SCHEMA,
        ts,
        date: day,
        lane: String(lane || 'briefing-model'),
        priority: String(priority || 'nonessential'),
        measuredTokens,
        pendingTokens,
        reservedTokens,
        projectedTokens,
        slopePerHour,
        slopeWindowMinutes: Math.round(limits.slopeWindowMs / 60_000),
        slopeSpanMinutes: slope.spanMs ? Math.round(slope.spanMs / 60_000) : 0,
        slopeMinSpanMinutes: Math.round(limits.slopeMinSpanMs / 60_000),
        burstPerHour: slope.burstPerHour || 0,
        burstLimitPerHour: limits.burstLimitPerHour,
        slopeOldestMeasuredAt: slope.oldest?.measuredAt || '',
        slopeOldestMeasuredTokens: slope.oldest ? slope.oldest.tokens : null,
        slopeLatestMeasuredAt: slope.latest?.measuredAt || '',
        slopeLatestMeasuredTokens: slope.latest ? slope.latest.tokens : null,
        tokenCap: limits.tokenCap,
        nonessentialCap: limits.nonessentialCap,
        reportDeliveryReserve: limits.reportDeliveryReserve,
        slopeLimitPerHour: limits.slopeLimitPerHour,
        measurementSource: measurement?.source || '',
        measurementError,
        storageAvailableBytes: storage.availableBytes,
        storageReserveBytes: limits.storageReserveBytes,
        emergencyOverride,
        observations,
      };
      const reservationId = crypto.randomUUID();
      const reservation = {
        reservationId,
        lane: base.lane,
        priority: base.priority,
        reservedTokens,
        admittedAt: ts,
        expiresAt: new Date(nowMs + ACTIVE_RESERVATION_MS).toISOString(),
        status: 'active',
        emergencyOverride,
      };
      state.reservations.push(reservation);
      const admitted = {
        ...base,
        event: observations.length ? 'admission-observed' : 'admission-allowed',
        reason: observations.length ? 'observed-not-gated' : 'within-circuit',
        topConsumers: measurement?.topConsumers || [],
        reservationId,
      };
      state.updatedAt = ts;
      state.lastDecision = admitted;
      writeJsonAtomic(file, state, fsApi);
      appendEvent(dataDir, admitted, fsApi);
      return { allowed: true, enforced: true, ...admitted };
    },
    fsApi,
  );
}

function settleBriefingModelLaunch({
  date,
  dataDir,
  reservationId,
  outcome = 'completed',
  nowMs = Date.now(),
  fsApi = fs,
} = {}) {
  if (!dataDir || !date || !reservationId) return { settled: false, reason: 'not-reserved' };
  return withCircuitLock(
    dataDir,
    date,
    () => {
      const file = circuitStatePath(dataDir, date);
      const loaded = readState(file, date, fsApi);
      if (!loaded.ok) return { settled: false, reason: loaded.error };
      const state = loaded.state;
      const reservation = (state.reservations || []).find(
        (row) => row.reservationId === reservationId,
      );
      if (!reservation) return { settled: false, reason: 'reservation-not-found' };
      reservation.status = String(outcome || 'completed').slice(0, 80);
      reservation.settledAt = new Date(nowMs).toISOString();
      reservation.expiresAt = new Date(nowMs + SETTLED_RESERVATION_LAG_MS).toISOString();
      state.updatedAt = reservation.settledAt;
      writeJsonAtomic(file, state, fsApi);
      appendEvent(
        dataDir,
        {
          schema: CIRCUIT_SCHEMA,
          ts: reservation.settledAt,
          date,
          event: 'reservation-settled',
          reservationId,
          lane: reservation.lane,
          outcome: reservation.status,
          telemetryLagReserveUntil: reservation.expiresAt,
        },
        fsApi,
      );
      return { settled: true, reservation };
    },
    fsApi,
  );
}

module.exports = {
  CIRCUIT_SCHEMA,
  DEFAULT_TOKEN_CAP,
  DEFAULT_REPORT_DELIVERY_RESERVE,
  DEFAULT_LAUNCH_RESERVATION,
  DEFAULT_SLOPE_LIMIT_PER_HOUR,
  DEFAULT_STORAGE_RESERVE_BYTES,
  ESSENTIAL_PRIORITIES,
  activeReservationTokens,
  admitBriefingModelLaunch,
  circuitStatePath,
  currentSlopePerHour,
  describeCircuitDenial,
  inferBriefingDate,
  limitsFromEnv,
  storageReserveStatus,
  settleBriefingModelLaunch,
};
