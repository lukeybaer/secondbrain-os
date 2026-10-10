'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  isVerifiedAttendedActionCapability,
} = require('./briefing-attended-action.js');
const { CURRENT_SAMPLE_SCHEMA: CURRENT_CAPACITY_SCHEMA } = require('./overnight-capacity-measurement.js');
const {
  INPUT_START_HOUR_CT,
  DELIVERY_HOUR_CT,
  DELIVERY_MINUTE_CT,
  activeCatchUpSchedule,
} = require('./briefing-run-window.js');

const STATE_REL = path.join('agent', 'host-work-admission');
// Long-running healer and backfill subprocesses routinely outlive twenty
// minutes. A lease must cover their real wall-clock budget; dead-PID cleanup
// releases crashed workers without waiting for this bound.
const LEASE_MS = 75 * 60 * 1000;
const MIN_NORMAL_MEMORY_BYTES = 768 * 1024 ** 2;
const MIN_CRITICAL_MEMORY_BYTES = 384 * 1024 ** 2;
const IO_PRESSURE_AVG10_LIMIT = 10;
const COREDUMP_MIN_ELAPSED_SECONDS = 180;
const COREDUMP_CPU_PERCENT_LIMIT = 50;
const COREDUMP_WRITE_BYTES_LIMIT = 256 * 1024 ** 2;
const CPU_PRESSURE_AVG10_LIMIT = 20;
const DEFAULT_NIGHTLY_SESSION_CEILING = 20;
const DEFAULT_NIGHTLY_RESERVED_SESSION_COST = 2;
const DEFAULT_NIGHTLY_RESERVED_OUTCOME_IDS = Object.freeze([
  'ai_tech_news',
  'us_news',
  'world_news',
]);
// ExampleCo, 2026-08-24: "I don't even want a total cap, every card should have
// their 8-item budget but you don't even need that cap during the day."
// Neither nightly reason below may refuse a card for the rest of the night.
// Each is a soft, self-expiring traffic shape bounded by this constant and
// measured from the first time this exact night window observed the
// contention, never from any one caller's own retry clock.
const NIGHTLY_SOFT_DEFER_MAX_MS = 30 * 60 * 1000;
// A lock held by a still-live process is a real (possibly slow) critical
// section, not an abandoned one; reclaiming it purely on elapsed time let two
// processes read-modify-write the nightly usage ledger at once, which is how
// the night of 2026-08-30 admitted 24 sessions against a ceiling of 20. The
// soft bound below only reclaims a confirmed-dead holder; the hard bound is
// the final failsafe against a genuinely stuck lock.
const LOCK_SOFT_STALE_MS = 15_000;
const LOCK_HARD_STALE_MS = 5 * 60 * 1000;
const DEFAULT_LEASE_HEARTBEAT_MS = 30 * 1000;
const DEFAULT_PROVIDER_CONCURRENT_CEILINGS = Object.freeze({
  'subscription-cli': 2,
  codex: 2,
  claude: 2,
  phone: 1,
});
const BURSTABLE_CREDIT_FLOORS = Object.freeze({
  background: 36,
  normal: 24,
  critical: 12,
  controller: 12,
  delivery: 0,
});
const CAPACITY_SAMPLE_MAX_AGE_MS = 15 * 60 * 1000;

function statePaths(dataDir) {
  const root = path.join(dataDir, STATE_REL);
  return {
    root,
    lock: path.join(root, '.state-lock'),
    leases: path.join(root, 'leases.json'),
    events: path.join(root, 'events.jsonl'),
    pressure: path.join(root, 'pressure.json'),
    resizeDrain: path.join(root, 'resize-drain.json'),
    nightlyUsage: path.join(root, 'nightly-usage.json'),
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function appendEvent(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
  } catch {
    // Admission must fail from resource truth, never from optional telemetry.
  }
}

function linuxAvailableMemoryBytes(fsApi = fs) {
  try {
    const rows = String(fsApi.readFileSync('/proc/meminfo', 'utf8')).split(/\r?\n/);
    const entry = rows
      .map((line) => line.trim().split(/\s+/))
      .find((parts) => parts[0] === 'MemAvailable:');
    const kib = Number(entry && entry[1]);
    return Number.isFinite(kib) ? kib * 1024 : null;
  } catch {
    return null;
  }
}

function parseLinuxIoPressure(text) {
  const match = String(text || '').match(/^some\s+[^\n]*\bavg10=([\d.]+)/m);
  const value = Number(match && match[1]);
  return Number.isFinite(value) ? value : null;
}

function linuxIoPressureAvg10(fsApi = fs) {
  try {
    return parseLinuxIoPressure(fsApi.readFileSync('/proc/pressure/io', 'utf8'));
  } catch {
    return null;
  }
}

function linuxCpuPressureAvg10(fsApi = fs) {
  try {
    return parseLinuxIoPressure(fsApi.readFileSync('/proc/pressure/cpu', 'utf8'));
  } catch {
    return null;
  }
}

function freshCapacitySample(file, {
  fsApi = fs,
  nowMs = Date.now(),
  expectedSchema = '',
} = {}) {
  try {
    const row = JSON.parse(String(fsApi.readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''));
    if (expectedSchema && row?.schema !== expectedSchema) return null;
    const sampledAtMs = Date.parse(row?.sampled_at);
    const ageMs = nowMs - sampledAtMs;
    return Number.isFinite(sampledAtMs) && ageMs >= 0 && ageMs <= CAPACITY_SAMPLE_MAX_AGE_MS
      ? row
      : null;
  } catch {
    return null;
  }
}

function latestCurrentCapacitySample(dataDir, { fsApi = fs, nowMs = Date.now() } = {}) {
  if (!dataDir) return null;
  return freshCapacitySample(
    path.join(dataDir, 'agent', 'overnight-capacity', 'current-latest.json'),
    { fsApi, nowMs, expectedSchema: CURRENT_CAPACITY_SCHEMA },
  );
}

function latestNightCapacitySample(dataDir, { fsApi = fs, nowMs = Date.now() } = {}) {
  if (!dataDir) return null;
  const directory = path.join(dataDir, 'agent', 'overnight-capacity', 'samples');
  let names = [];
  try {
    names = fsApi.readdirSync(directory).filter((name) => name.endsWith('.jsonl')).sort().reverse();
  } catch {
    return null;
  }
  for (const name of names.slice(0, 2)) {
    try {
      const lines = String(fsApi.readFileSync(path.join(directory, name), 'utf8'))
        .split(/\r?\n/).filter(Boolean);
      const row = JSON.parse(lines[lines.length - 1]);
      const sampledAtMs = Date.parse(row.sampled_at);
      const ageMs = nowMs - sampledAtMs;
      if (
        Number.isFinite(sampledAtMs) &&
        ageMs >= 0 &&
        ageMs <= CAPACITY_SAMPLE_MAX_AGE_MS
      ) return row;
    } catch {
      // Continue to the prior night file.
    }
  }
  return null;
}

function latestCapacitySample(dataDir, options = {}) {
  return latestCurrentCapacitySample(dataDir, options) || latestNightCapacitySample(dataDir, options);
}

function imdsInstanceType({ spawnSyncFn = spawnSync } = {}) {
  try {
    const token = spawnSyncFn('curl', [
      '-fsS', '--max-time', '2', '-X', 'PUT',
      '-H', 'X-aws-ec2-metadata-token-ttl-seconds: 60',
      'http://169.254.169.254/latest/api/token',
    ], { encoding: 'utf8', timeout: 3_000, windowsHide: true });
    if (token.status !== 0 || !String(token.stdout || '').trim()) return '';
    const result = spawnSyncFn('curl', [
      '-fsS', '--max-time', '2',
      '-H', `X-aws-ec2-metadata-token: ${String(token.stdout).trim()}`,
      'http://169.254.169.254/latest/meta-data/instance-type',
    ], { encoding: 'utf8', timeout: 3_000, windowsHide: true });
    const value = String(result.stdout || '').trim().toLowerCase();
    return result.status === 0 && /^[a-z][a-z0-9.-]+$/.test(value) ? value : '';
  } catch {
    return '';
  }
}

function detectInstanceType({ dataDir, fsApi = fs, spawnSyncFn = spawnSync, nowMs = Date.now() } = {}) {
  const sample = latestCapacitySample(dataDir, { fsApi, nowMs });
  if (sample?.instance_type) return String(sample.instance_type).trim().toLowerCase();
  try {
    const dmi = String(
      fsApi.readFileSync('/sys/devices/virtual/dmi/id/product_name', 'utf8'),
    ).trim().toLowerCase();
    if (/^[a-z][a-z0-9.-]+$/.test(dmi)) return dmi;
  } catch {
    // IMDS is the bounded fallback.
  }
  if (process.platform !== 'linux') return '';
  return imdsInstanceType({ spawnSyncFn });
}

function burstableInstanceType(instanceType) {
  return /^t(?:2|3|3a|4g)\./.test(String(instanceType || '').toLowerCase());
}

function ctMinuteOfDay(value = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(value).map((part) => [part.type, part.value]),
  );
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function deliveryWindowState(value = new Date(), { dataDir } = {}) {
  const minute = ctMinuteOfDay(value);
  // A catch-up run protects its own shifted delivery half hour the same way.
  const catchUp = activeCatchUpSchedule(new Date(value).getTime(), { dataDir });
  const catchUpDelivery =
    !!catchUp &&
    new Date(value).getTime() >= catchUp.shifted.deliveryDeadlineMs - 30 * 60 * 1000;
  return {
    active: catchUpDelivery || (minute >= 5 * 60 && minute <= 5 * 60 + 30),
    minute,
    startsAtMinute: 5 * 60,
    endsAtMinute: 5 * 60 + 30,
  };
}

// The night-wide session ceiling guards the unattended overnight autonomous
// window, 23:00 to 05:30 CT, the same boundaries the briefing run window
// publishes. ExampleCo, 2026-08-24: "I don't even want a total cap, every card
// should have their 8-item budget but you don't even need that cap during
// the day." Outside this window the ceiling never refuses; per-card cycle
// ceilings stay the attended-day guardrail.
function overnightWindowState(value = new Date(), { dataDir } = {}) {
  const minute = ctMinuteOfDay(value);
  const startsAtMinute = INPUT_START_HOUR_CT * 60;
  const endsAtMinute = DELIVERY_HOUR_CT * 60 + DELIVERY_MINUTE_CT;
  // An owner-invoked catch-up run is that date's night, moved; the night-wide
  // ceiling guards it the same way.
  const catchUp = !!activeCatchUpSchedule(new Date(value).getTime(), { dataDir });
  return {
    active: catchUp || minute >= startsAtMinute || minute <= endsAtMinute,
    minute,
    startsAtMinute,
    endsAtMinute,
  };
}

function ctClockParts(value) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(value).map((part) => [part.type, part.value]),
  );
}

// The plain CT calendar date. Daytime spend books here, never against a night
// window key: 05:30-23:00 CT never spans midnight, so one calendar day holds
// the whole uncapped day record.
function ctCalendarDayKey(value = new Date()) {
  const parts = ctClockParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function nightlyUsageKey(value = new Date()) {
  const dateParts = ctClockParts(value);
  const current = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  if (Number(dateParts.hour) >= 12) return current;
  const [year, month, day] = current.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

// The stored nightly budget belongs to exactly one CT night window, so the
// reader re-derives the window key from the clock on every read. A valid
// record left over from a finished night resets to zero instead of refusing
// the whole next day against dead spend (2026-08-24 incident: a stale 20/20
// record blocked every morning healer admission until an operator hand-edited
// the file). A file that exists but cannot be parsed, or whose shape cannot
// be trusted, counts as a full ceiling: the budget gates paid session spend,
// so an unreadable ledger fails closed instead of authorizing fresh sessions.
function readNightlyUsageForWindow(file, usageKey, ceiling = DEFAULT_NIGHTLY_SESSION_CEILING) {
  const fresh = { schemaVersion: 1, night: usageKey, sessions: 0, providers: {} };
  if (!fs.existsSync(file)) return fresh;
  const stored = readJson(file, null);
  const valid =
    stored !== null &&
    typeof stored === 'object' &&
    !Array.isArray(stored) &&
    typeof stored.night === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(stored.night) &&
    typeof stored.sessions === 'number' &&
    Number.isFinite(stored.sessions) &&
    stored.sessions >= 0;
  if (!valid) {
    // The nightly count is advisory telemetry now, never an admission gate,
    // so an unreadable or malformed ledger no longer needs to fail toward a
    // synthetic full count. It resets like any other rollover; the caller
    // logs a receipt (`resetReason`, stripped before persisting) so a manual
    // edit or real corruption stays auditable instead of silently vanishing
    // (2026-08-24: an operator hand-edited this file to clear a stuck
    // ceiling with no trace left; `.bak-*` siblings on EC2 are the only
    // surviving evidence of that edit).
    return { ...fresh, corrupt: true, resetReason: 'corrupt-or-unreadable' };
  }
  if (stored.night === usageKey) return stored;
  // A rollover zeroes only the bounded night counters. The uncapped day ledger
  // is a separate record and must survive the night key changing under it.
  return {
    ...(stored.daytime ? { ...fresh, daytime: stored.daytime } : fresh),
    resetReason: 'window-rollover',
    priorNight: stored.night,
    priorSessions: Number(stored.sessions || 0),
  };
}

function defaultReservedMemoryBytes(kind) {
  const value = String(kind || '').toLowerCase();
  if (value.includes('agentic-healer')) return 700 * 1024 ** 2;
  if (value.includes('otter') || value.includes('audio')) return 512 * 1024 ** 2;
  if (value.includes('stage')) return 384 * 1024 ** 2;
  if (value.includes('source')) return 256 * 1024 ** 2;
  return 256 * 1024 ** 2;
}

function linuxBootId(fsApi = fs) {
  try {
    return String(fsApi.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  } catch {
    return '';
  }
}

function linuxCoredumpPressure({ fsApi = fs, procRoot = '/proc', clockTicks = 100 } = {}) {
  try {
    const uptimeSeconds = Number(String(fsApi.readFileSync(path.join(procRoot, 'uptime'), 'utf8')).split(/\s+/)[0]);
    if (!Number.isFinite(uptimeSeconds)) throw new Error('uptime unavailable');
    const entries = fsApi.readdirSync(procRoot, { withFileTypes: true });
    const matches = [];
    for (const entry of entries) {
      const pid = String(typeof entry === 'string' ? entry : entry && entry.name);
      if (!/^\d+$/.test(pid)) continue;
      const root = path.join(procRoot, pid);
      let command = '';
      try {
        command = String(fsApi.readFileSync(path.join(root, 'comm'), 'utf8'));
      } catch {
        continue;
      }
      // Linux comm is capped at 15 visible characters, so systemd-coredump is
      // commonly exposed as "systemd-coredum". Match that stable prefix before
      // reading the heavier per-process files.
      if (!/coredum/i.test(command)) continue;
      try {
        command += ` ${fsApi.readFileSync(path.join(root, 'cmdline'), 'utf8').replace(/\0/g, ' ')}`;
      } catch {
        // comm already proved the process identity.
      }
      let stat = '';
      let io = '';
      try {
        stat = String(fsApi.readFileSync(path.join(root, 'stat'), 'utf8'));
        io = String(fsApi.readFileSync(path.join(root, 'io'), 'utf8'));
      } catch {
        continue;
      }
      const close = stat.lastIndexOf(')');
      const fields = close >= 0 ? stat.slice(close + 2).trim().split(/\s+/) : [];
      const userTicks = Number(fields[11]);
      const systemTicks = Number(fields[12]);
      const startTicks = Number(fields[19]);
      if (![userTicks, systemTicks, startTicks].every(Number.isFinite)) continue;
      const elapsedSeconds = Math.max(0, uptimeSeconds - startTicks / clockTicks);
      const cpuPercent = elapsedSeconds > 0
        ? (((userTicks + systemTicks) / clockTicks) / elapsedSeconds) * 100
        : 0;
      const writeMatch = io.match(/^write_bytes:\s*(\d+)/m);
      const writeBytes = Number(writeMatch && writeMatch[1]) || 0;
      const sustained =
        elapsedSeconds >= COREDUMP_MIN_ELAPSED_SECONDS &&
        (cpuPercent >= COREDUMP_CPU_PERCENT_LIMIT || writeBytes >= COREDUMP_WRITE_BYTES_LIMIT);
      matches.push({
        pid: Number(pid),
        command: compactCommand(command),
        elapsedSeconds: Math.round(elapsedSeconds),
        cpuPercent: Math.round(cpuPercent * 10) / 10,
        writeBytes,
        sustained,
      });
    }
    matches.sort(
      (a, b) => Number(b.sustained) - Number(a.sustained) || b.cpuPercent - a.cpuPercent || b.writeBytes - a.writeBytes,
    );
    return matches.length
      ? { active: true, sustained: matches.some((row) => row.sustained), ...matches[0] }
      : { active: false, sustained: false };
  } catch {
    return { active: false, sustained: false };
  }
}

function compactCommand(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function hostSnapshot({ osApi = os, fsApi = fs, dataDir, nowMs = Date.now(), spawnSyncFn } = {}) {
  const capacitySample = latestCapacitySample(dataDir, { fsApi, nowMs });
  const cpuCreditBalance = capacitySample?.cloudwatch?.cpu_credit_balance;
  const cpuUtilizationPercent = capacitySample?.cloudwatch?.cpu_utilization_percent;
  return {
    capturedAt: new Date().toISOString(),
    cpuCount: Math.max(1, (osApi.cpus() || []).length || 1),
    load1: Math.max(0, Number((osApi.loadavg() || [0])[0]) || 0),
    availableMemoryBytes:
      linuxAvailableMemoryBytes(fsApi) ?? Math.max(0, Number(osApi.freemem()) || 0),
    ioPressureAvg10: linuxIoPressureAvg10(fsApi),
    cpuPressureAvg10: linuxCpuPressureAvg10(fsApi),
    coredumpPressure: linuxCoredumpPressure({ fsApi }),
    instanceType:
      String(capacitySample?.instance_type || '').trim().toLowerCase() ||
      detectInstanceType({ dataDir, fsApi, spawnSyncFn, nowMs }),
    cpuCreditBalance:
      cpuCreditBalance !== null && cpuCreditBalance !== undefined && cpuCreditBalance !== '' &&
      Number.isFinite(Number(cpuCreditBalance))
      ? Number(cpuCreditBalance)
      : null,
    cpuUtilizationPercent:
      cpuUtilizationPercent !== null && cpuUtilizationPercent !== undefined &&
      cpuUtilizationPercent !== '' && Number.isFinite(Number(cpuUtilizationPercent))
      ? Number(cpuUtilizationPercent)
      : null,
  };
}

function processAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function sleepSync(ms) {
  if (ms <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function activeLeaseRows(rows, { nowMs = Date.now(), pidAlive = processAlive } = {}) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!row || !row.token) return false;
    if (Number(row.expiresAtMs || 0) <= nowMs) return false;
    return pidAlive(row.pid);
  });
}

function admissionDecision({
  snapshot,
  dataDir,
  activeLeases = [],
  priority = 'normal',
  weight = 1,
  kind = 'unspecified',
  memoryBytes,
  provider = '',
  providerConcurrentCeiling,
  agenticHealerConcurrentCeiling = 1,
  nightlySessionsUsed = 0,
  nightlySessionCeiling = DEFAULT_NIGHTLY_SESSION_CEILING,
  sessionCost = 0,
  nightlyOutcomeId = '',
  nightlyReservedOutcomeIds = [],
  nightlyOutcomeSessions = {},
  nightlyReservedSessionCost = DEFAULT_NIGHTLY_RESERVED_SESSION_COST,
  nightlySoftDeferSinceMs = null,
  attendedActionCapability = null,
  now = new Date(),
  env = process.env,
} = {}) {
  const metrics = snapshot || hostSnapshot();
  const cpuCount = Math.max(1, Number(metrics.cpuCount) || 1);
  const load1 = Math.max(0, Number(metrics.load1) || 0);
  const memory = Math.max(0, Number(metrics.availableMemoryBytes) || 0);
  const normalizedPriority = String(priority || 'normal').toLowerCase();
  const critical = ['critical', 'controller', 'delivery'].includes(normalizedPriority);
  const delivery = normalizedPriority === 'delivery';
  const configuredMax = Math.max(
    1,
    Number(env.SECONDBRAIN_HOST_WORK_SLOTS || cpuCount) || 1,
  );
  const minimumWeight = configuredMax >= 2 ? 0.5 : 1;
  const highLoad = load1 >= cpuCount * 1.5;
  const measuredCpuHigh = Number.isFinite(Number(metrics.cpuUtilizationPercent)) &&
    Number(metrics.cpuUtilizationPercent) >= 85;
  const cpuPressure = Number(metrics.cpuPressureAvg10) >= CPU_PRESSURE_AVG10_LIMIT;
  const coredumpPressure = metrics.coredumpPressure && metrics.coredumpPressure.sustained === true;
  const ioPressure = Number(metrics.ioPressureAvg10) >= IO_PRESSURE_AVG10_LIMIT;
  const pressureReason = coredumpPressure
    ? 'host-coredump-pressure'
    : ioPressure
      ? 'host-io-pressure'
      : highLoad || measuredCpuHigh || cpuPressure
        ? 'host-load-high'
        : '';
  const memoryFloor = critical ? MIN_CRITICAL_MEMORY_BYTES : MIN_NORMAL_MEMORY_BYTES;
  const activeWeight = activeLeases.reduce(
    (sum, row) => sum + Math.max(minimumWeight, Number(row && row.weight) || 1),
    0,
  );
  // Ordinary runs retain one model repair worker across controller processes.
  // The explicit attended heal-the-healer controller may supply a bounded
  // ceiling; CPU, memory, provider and pressure checks below still apply.
  const activeAgenticHealers = activeLeases.filter(
    (row) => row?.kind === 'briefing-agentic-healer',
  ).length;
  const agenticHealerCeiling = Math.max(
    1,
    Math.min(20, Math.floor(Number(agenticHealerConcurrentCeiling) || 1)),
  );
  if (kind === 'briefing-agentic-healer' && activeAgenticHealers >= agenticHealerCeiling) {
    return {
      admitted: false,
      reason: 'agentic-healer-busy',
      capacity: agenticHealerCeiling,
      activeAgenticHealers,
      activeWeight,
      snapshot: metrics,
    };
  }
  const activeCriticalWeight = activeLeases
    .filter((row) => ['critical', 'controller', 'delivery'].includes(String(row && row.priority)))
    .reduce(
      (sum, row) => sum + Math.max(minimumWeight, Number(row && row.weight) || 1),
      0,
    );
  // A half-weight lease is reserved for short, independently fenced exact-call
  // tails. Two may share the one normal background slot while the second host
  // slot remains available for critical work.
  const requestedWeight = Math.max(minimumWeight, Number(weight) || 1);
  const requestedMemoryBytes = Math.max(
    0,
    Number.isFinite(Number(memoryBytes)) ? Number(memoryBytes) : defaultReservedMemoryBytes(kind),
  );
  const reservedMemoryBytes = activeLeases.reduce(
    (sum, row) => sum + Math.max(0, Number(row && row.memoryBytes) || 0),
    0,
  );
  const deliveryWindow = deliveryWindowState(now, { dataDir });
  const overnightWindow = overnightWindowState(now, { dataDir });
  const attendedProof = isVerifiedAttendedActionCapability(attendedActionCapability, {
    nowMs: now instanceof Date ? now.getTime() : new Date(now).getTime(),
  });
  const attendedActionTelemetry = attendedProof
    ? {
        attendedActionIssuer: attendedActionCapability.issuer,
        attendedActionTokenHash: attendedActionCapability.tokenHash,
      }
    : {};
  const attendedDaytimeProof =
    attendedProof && !overnightWindow.active && !deliveryWindow.active;
  const providerName = String(provider || '').trim().toLowerCase();
  const providerActive = providerName
    ? activeLeases.filter((row) => String(row && row.provider || '').toLowerCase() === providerName)
        .length
    : 0;
  const providerCeiling = Math.max(
    1,
    Number(
      providerConcurrentCeiling ??
        DEFAULT_PROVIDER_CONCURRENT_CEILINGS[providerName] ??
        configuredMax,
    ) || 1,
  );
  const creditFloor = Number(BURSTABLE_CREDIT_FLOORS[normalizedPriority] ?? 24);
  let creditConstrainedCapacity = null;
  let creditTelemetry = 'measured';
  let attendedCreditOverride = false;

  if (deliveryWindow.active && !critical) {
    return {
      admitted: false,
      reason: 'delivery-window-drain',
      capacity: 0,
      activeWeight,
      deliveryWindow,
      snapshot: metrics,
      ...attendedActionTelemetry,
    };
  }

  if (burstableInstanceType(metrics.instanceType)) {
    const creditAvailable = metrics.cpuCreditBalance !== null &&
      metrics.cpuCreditBalance !== undefined && metrics.cpuCreditBalance !== '' &&
      Number.isFinite(Number(metrics.cpuCreditBalance));
    const creditBalance = creditAvailable ? Number(metrics.cpuCreditBalance) : null;
    if (!delivery && !creditAvailable) {
      // Unknown credits cannot authorize a burst, but they also must not halt
      // attended repair when the fifteen-minute sampler freshness lapses.
      creditConstrainedCapacity = 1;
      creditTelemetry = 'unknown-concurrency-one';
    }
    if (!delivery && creditAvailable && creditBalance < creditFloor) {
      // The floor protects unattended burst spend. A real operator action in
      // daytime may use the controller's existing one-slot critical escape
      // hatch, but cannot widen it or bypass memory/provider/pressure gates.
      if (critical && attendedDaytimeProof) {
        creditConstrainedCapacity = 1;
        creditTelemetry = 'attended-daytime-critical-slot';
        attendedCreditOverride = true;
      } else {
        return {
          admitted: false,
          reason: 'cpu-credit-floor',
          capacity: 0,
          activeWeight,
          creditFloor,
          cpuCreditBalance: creditBalance,
          snapshot: metrics,
          ...attendedActionTelemetry,
        };
      }
    }
  }

  if (providerName && providerActive >= providerCeiling) {
    return {
      admitted: false,
      reason: 'provider-concurrency-full',
      capacity: 0,
      provider: providerName,
      providerActive,
      providerCeiling,
      activeWeight,
      snapshot: metrics,
      ...attendedActionTelemetry,
    };
  }
  // Neither nightly reason below is a hard terminal gate any more. ExampleCo,
  // 2026-08-24: "I don't even want a total cap, every card should have their
  // 8-item budget but you don't even need that cap during the day."
  // MAX_PROCESS_CYCLES (8, per card) is the real spend cap. Both reasons are
  // soft, self-expiring traffic shaping bounded by NIGHTLY_SOFT_DEFER_MAX_MS
  // so delivery-critical news keeps priority ordering under contention
  // without any card ever being refused for the rest of the night.
  //
  // Caller-authored supervision labels and raw action tokens are deliberately
  // absent from this authority boundary.
  // The attended-action capability is intentionally a daytime-only capacity
  // exception. It never widens the autonomous overnight session budget.
  const nightlyCeilingBinds = overnightWindow.active;
  const normalizedOutcomeId = String(nightlyOutcomeId || '').trim().toLowerCase();
  const reservedOutcomeIds = [
    ...new Set(
      (Array.isArray(nightlyReservedOutcomeIds) ? nightlyReservedOutcomeIds : [])
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const chargedOutcomeIds = new Set(
    Object.entries(
      nightlyOutcomeSessions && typeof nightlyOutcomeSessions === 'object'
        ? nightlyOutcomeSessions
        : {},
    )
      .filter(([, charged]) => Number(charged || 0) > 0)
      .map(([outcomeId]) => String(outcomeId || '').trim().toLowerCase()),
  );
  const outstandingReservedOutcomeIds = reservedOutcomeIds.filter(
    (outcomeId) => !chargedOutcomeIds.has(outcomeId),
  );
  const requestOwnsOutstandingReservation =
    normalizedOutcomeId && outstandingReservedOutcomeIds.includes(normalizedOutcomeId);
  const outstandingReservedSessions =
    outstandingReservedOutcomeIds.length * Math.max(0, Number(nightlyReservedSessionCost) || 0);
  const reservedContention =
    nightlyCeilingBinds &&
    Number(sessionCost) > 0 &&
    !requestOwnsOutstandingReservation &&
    Number(nightlySessionsUsed) + Number(sessionCost) <= Number(nightlySessionCeiling) &&
    Number(nightlySessionsUsed) + Number(sessionCost) >
      Number(nightlySessionCeiling) - outstandingReservedSessions;
  const ceilingContention =
    nightlyCeilingBinds &&
    Number(sessionCost) > 0 &&
    Number(nightlySessionsUsed) + Number(sessionCost) > Number(nightlySessionCeiling);
  let softDeferEpisodeExpired = false;
  if (reservedContention || ceilingContention) {
    const nowEpochMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
    const since = Number.isFinite(nightlySoftDeferSinceMs)
      ? Number(nightlySoftDeferSinceMs)
      : nowEpochMs;
    const elapsedMs = Math.max(0, nowEpochMs - since);
    if (elapsedMs < NIGHTLY_SOFT_DEFER_MAX_MS) {
      return {
        admitted: false,
        reason: reservedContention ? 'nightly-capacity-reserved-for-news' : 'nightly-session-ceiling',
        capacity: 0,
        nightlySessionsUsed: Number(nightlySessionsUsed),
        nightlySessionCeiling: Number(nightlySessionCeiling),
        ...(reservedContention ? { outstandingReservedSessions, outstandingReservedOutcomeIds } : {}),
        softDeferSinceMs: since,
        softDeferElapsedMs: elapsedMs,
        softDeferBoundMs: NIGHTLY_SOFT_DEFER_MAX_MS,
        activeWeight,
        snapshot: metrics,
        ...attendedActionTelemetry,
      };
    }
    // The bound expired: fall through and admit. The advisory ledger still
    // records the charge below; nothing here blocks the rest of tonight.
    softDeferEpisodeExpired = true;
  }

  if (memory - reservedMemoryBytes - requestedMemoryBytes < memoryFloor) {
    return {
      admitted: false,
      reason: 'host-memory-low',
      capacity: 0,
      activeWeight,
      requestedMemoryBytes,
      reservedMemoryBytes,
      pressureReason,
      snapshot: metrics,
      ...attendedActionTelemetry,
    };
  }
  if (!critical && pressureReason) {
    return {
      admitted: false,
      reason: pressureReason,
      capacity: 0,
      activeWeight,
      pressureReason,
      snapshot: metrics,
      ...attendedActionTelemetry,
    };
  }

  // When the host is already above 1.5 runnable jobs per CPU, the controller
  // and watcher retain one emergency critical slot. A background lease that
  // was admitted before load rose cannot consume that reserved slot.
  const normalCapacity = pressureReason ? 1 : critical ? configuredMax : Math.max(1, configuredMax - 1);
  const capacity = creditConstrainedCapacity === null
    ? normalCapacity
    : Math.min(normalCapacity, creditConstrainedCapacity);
  const competingWeight = pressureReason && critical ? activeCriticalWeight : activeWeight;
  if (competingWeight + requestedWeight > capacity) {
    return {
      admitted: false,
      reason: critical ? 'critical-capacity-full' : 'capacity-reserved-for-critical-work',
      capacity,
      activeWeight,
      activeCriticalWeight,
      pressureReason,
      snapshot: metrics,
      ...attendedActionTelemetry,
    };
  }
  return {
    admitted: true,
    reason: 'admitted',
    softDeferEpisodeExpired,
    capacity,
    activeWeight,
    activeCriticalWeight,
    pressureReason,
    snapshot: metrics,
    requestedMemoryBytes,
    reservedMemoryBytes,
    provider: providerName || null,
    providerActive,
    providerCeiling: providerName ? providerCeiling : null,
    deliveryWindow,
    creditTelemetry,
    ...attendedActionTelemetry,
    ...(attendedCreditOverride
      ? {
          creditFloor,
          cpuCreditBalance: Number(metrics.cpuCreditBalance),
        }
      : {}),
  };
}

function recordPressureIncident(paths, decision, nowMs) {
  const reason = String(decision && decision.pressureReason || '');
  const prior = readJson(paths.pressure, { active: false, reason: '' });
  if (!reason) {
    if (prior.active) {
      writeJsonAtomic(paths.pressure, {
        schemaVersion: 1,
        active: false,
        reason: prior.reason,
        clearedAt: new Date(nowMs).toISOString(),
      });
    }
    return;
  }
  const startedAt = prior.active && prior.reason === reason
    ? prior.startedAt
    : new Date(nowMs).toISOString();
  if (!prior.active || prior.reason !== reason) {
    appendEvent(paths.events, {
      ts: new Date(nowMs).toISOString(),
      event: 'capacity-pressure',
      reason,
      snapshot: decision.snapshot,
    });
  }
  writeJsonAtomic(paths.pressure, {
    schemaVersion: 1,
    active: true,
    reason,
    startedAt,
    lastObservedAt: new Date(nowMs).toISOString(),
  });
}

function lockOwnerPath(lockDir) {
  return path.join(lockDir, 'owner.json');
}

function readLockOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(lockOwnerPath(lockDir), 'utf8'));
  } catch {
    return null;
  }
}

function writeLockOwner(lockDir, owner) {
  try {
    fs.writeFileSync(lockOwnerPath(lockDir), JSON.stringify(owner), 'utf8');
  } catch {
    // Best-effort: a missing marker only removes the liveness check below and
    // falls back to the existing age-only reclaim, never blocks acquisition.
  }
}

function withStateLock(paths, worker, {
  nowMs = Date.now(),
  staleMs = LOCK_SOFT_STALE_MS,
  hardStaleMs = LOCK_HARD_STALE_MS,
  pidAlive = processAlive,
  pid = process.pid,
} = {}) {
  fs.mkdirSync(paths.root, { recursive: true });
  try {
    fs.mkdirSync(paths.lock);
    writeLockOwner(paths.lock, { pid, acquiredAtMs: nowMs });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    let age = 0;
    try {
      age = nowMs - fs.statSync(paths.lock).mtimeMs;
    } catch {
      age = 0;
    }
    // A lock held by a still-live process is a real, possibly slow, critical
    // section, not an abandoned one. Reclaiming it on elapsed age alone let
    // two processes read-modify-write the nightly usage ledger at once,
    // which is how the night of 2026-08-30 admitted 24 sessions against a
    // ceiling of 20. Only reclaim early when the recorded owner PID is
    // confirmed dead; an unreadable/missing marker (legacy state, or a crash
    // before the marker was written) falls back to the prior age-only rule.
    // The hard bound is the final failsafe against a genuinely stuck lock.
    const owner = readLockOwner(paths.lock);
    const ownerPid = owner && Number.isFinite(Number(owner.pid)) ? Number(owner.pid) : null;
    const ownerConfirmedAlive = ownerPid !== null && pidAlive(ownerPid) === true;
    const reclaimEligible =
      age > hardStaleMs || (age > staleMs && !ownerConfirmedAlive);
    if (reclaimEligible) {
      try {
        fs.rmSync(paths.lock, { recursive: true, force: true });
        fs.mkdirSync(paths.lock);
        writeLockOwner(paths.lock, { pid, acquiredAtMs: nowMs });
      } catch {
        return { locked: false, reason: 'admission-state-lock-held' };
      }
    } else {
      return { locked: false, reason: 'admission-state-lock-held' };
    }
  }
  try {
    return { locked: true, value: worker() };
  } finally {
    try {
      fs.rmSync(paths.lock, { recursive: true, force: true });
    } catch {
      // A stale lock cleaner can win a race only after the bounded stale age.
    }
  }
}

function tryAcquireHostWorkLease({
  dataDir,
  kind = 'unspecified',
  priority = 'normal',
  weight = 1,
  memoryBytes,
  provider = '',
  providerConcurrentCeiling,
  agenticHealerConcurrentCeiling = 1,
  nightlySessionCeiling = DEFAULT_NIGHTLY_SESSION_CEILING,
  sessionCost = 0,
  nightlyOutcomeId = '',
  nightlyReservedOutcomeIds = [],
  nightlyReservedSessionCost = DEFAULT_NIGHTLY_RESERVED_SESSION_COST,
  attendedActionCapability = null,
  cardId = '',
  leaseMs = LEASE_MS,
  pid = process.pid,
  inheritToken = '',
  nowMs = Date.now(),
  snapshot = null,
  pidAlive = processAlive,
  currentBootId = linuxBootId(),
} = {}) {
  if (!dataDir) throw new Error('host work admission requires dataDir');
  const paths = statePaths(dataDir);
  const locked = withStateLock(
    paths,
    () => {
      const state = readJson(paths.leases, { schemaVersion: 1, leases: [] });
      const leases = activeLeaseRows(state.leases, { nowMs, pidAlive });
      const usageKey = nightlyUsageKey(new Date(nowMs));
      const nightWindow = overnightWindowState(new Date(nowMs), { dataDir });
      const currentUsage = readNightlyUsageForWindow(
        paths.nightlyUsage,
        usageKey,
        nightlySessionCeiling,
      );
      if (!currentUsage.providers || typeof currentUsage.providers !== 'object') {
        currentUsage.providers = {};
      }
      if (!currentUsage.outcomes || typeof currentUsage.outcomes !== 'object') {
        currentUsage.outcomes = {};
      }
      // The nightly ledger is advisory telemetry, so any reset it goes
      // through (a normal window rollover, or a corrupt/unreadable file)
      // still leaves a durable receipt. A manual hand-edit (2026-08-24: an
      // operator cleared a stuck ceiling with `.bak-*` files as the only
      // trace) now shows up here instead of disappearing without evidence.
      if (currentUsage.resetReason) {
        let priorRawExcerpt = '';
        if (currentUsage.resetReason === 'corrupt-or-unreadable') {
          try {
            priorRawExcerpt = String(fs.readFileSync(paths.nightlyUsage, 'utf8')).slice(0, 500);
          } catch {
            priorRawExcerpt = '';
          }
        }
        appendEvent(paths.events, {
          ts: new Date(nowMs).toISOString(),
          event: 'nightly-usage-reset',
          reason: currentUsage.resetReason,
          night: usageKey,
          priorNight: currentUsage.priorNight || null,
          priorSessions: Number.isFinite(currentUsage.priorSessions)
            ? currentUsage.priorSessions
            : null,
          ...(priorRawExcerpt ? { priorRawExcerpt } : {}),
        });
        delete currentUsage.resetReason;
        delete currentUsage.priorNight;
        delete currentUsage.priorSessions;
        // Persist the rollover immediately, even when this particular
        // admission is later deferred or carries no session cost. Otherwise
        // every poll re-reads the prior window, appends another reset event,
        // and can spin forever without reaching a stable admission decision.
        writeJsonAtomic(paths.nightlyUsage, currentUsage);
      }
      const inheritedLease = inheritToken
        ? leases.find((row) => row && row.token === String(inheritToken))
        : null;
      if (inheritToken) {
        if (!inheritedLease) {
          return {
            acquired: false,
            terminal: true,
            reason: 'host-admission-inheritance-invalid',
          };
        }
        // A delegated child is part of work already counted by the parent's
        // lease. Re-counting its source/stage subprocesses consumes a third
        // slot and deadlocks a two-slot host until the ten-minute admission
        // wait expires. The unguessable live token is the inheritance proof.
        return {
          acquired: true,
          inherited: true,
          lease: { ...inheritedLease, inherited: true },
          reason: 'inherited',
          capacity: null,
          activeWeight: leases.reduce(
            (sum, row) => sum + Math.max(0.5, Number(row && row.weight) || 1),
            0,
          ),
          snapshot: snapshot || hostSnapshot({ dataDir, nowMs }),
        };
      }
      const resizeDrain = readJson(paths.resizeDrain, null);
      const sameBoot = !currentBootId || !resizeDrain?.bootId || resizeDrain.bootId === currentBootId;
      if (
        resizeDrain?.active === true &&
        Number(resizeDrain.expiresAtMs || 0) > nowMs &&
        sameBoot
      ) {
        return {
          acquired: false,
          // A scheduled stop/start is imminent. Waiting inside a critical
          // acquisition loop would itself keep the host non-drained until the
          // timeout, so new roots terminate immediately; inherited children
          // above may finish the already-counted transaction.
          terminal: true,
          reason: 'host-resize-draining',
          drain: resizeDrain,
        };
      }
      const decision = admissionDecision({
        snapshot: snapshot || hostSnapshot({ dataDir, nowMs }),
        dataDir,
        activeLeases: leases,
        priority,
        weight,
        kind,
        memoryBytes,
        provider,
        providerConcurrentCeiling,
        agenticHealerConcurrentCeiling,
        nightlySessionsUsed: Number(currentUsage.sessions || 0),
        nightlySessionCeiling,
        sessionCost,
        nightlyOutcomeId,
        nightlyReservedOutcomeIds,
        nightlyOutcomeSessions: currentUsage.outcomes,
        nightlyReservedSessionCost,
        nightlySoftDeferSinceMs: Number.isFinite(currentUsage.softDeferSinceMs)
          ? currentUsage.softDeferSinceMs
          : null,
        attendedActionCapability,
        now: new Date(nowMs),
      });
      recordPressureIncident(paths, decision, nowMs);
      if (!decision.admitted) {
        // The soft-defer clock for the two nightly reasons is measured from
        // the ledger, not the caller's retry loop, so it survives a fresh
        // process retrying the wait. Persist only while this contention is
        // still the active reason; an unrelated refusal (memory, pressure,
        // provider concurrency) leaves the ledger untouched as before.
        if (
          (decision.reason === 'nightly-capacity-reserved-for-news' ||
            decision.reason === 'nightly-session-ceiling') &&
          Number.isFinite(decision.softDeferSinceMs) &&
          currentUsage.softDeferSinceMs !== decision.softDeferSinceMs
        ) {
          currentUsage.softDeferSinceMs = decision.softDeferSinceMs;
          currentUsage.updatedAt = new Date(nowMs).toISOString();
          writeJsonAtomic(paths.nightlyUsage, currentUsage);
        }
        writeJsonAtomic(paths.leases, {
          schemaVersion: 1,
          updatedAt: new Date(nowMs).toISOString(),
          leases,
        });
        return { acquired: false, ...decision };
      }
      // An admission without contention ends the episode: clear the stamp so
      // the next distinct episode starts its own clock. An admission that
      // only happened because the soft-defer bound expired keeps the stamp,
      // so every job that waited in the same episode is released together.
      // Clearing it here serialized eight waiters into 30-minute steps from
      // 1:06 to 4:30 AM CT on Sep 28 2026.
      // Only session-charging work takes part in the episode; zero-cost source
      // or integration admissions never end it (Codex review, Sep 28 2026).
      // A settlement refund can admit one ceiling waiter without contention.
      // When this charge puts the night back at its ceiling, every equal-cost
      // job still waiting is in the same episode, so it keeps its clock
      // (Oct 4 2026 review). currentUsage.sessions is still pre-charge here.
      const postChargeSessions = Number(currentUsage.sessions || 0) + Number(sessionCost);
      const ceilingStillFull =
        nightWindow.active &&
        postChargeSessions + Number(sessionCost) > Number(nightlySessionCeiling);
      if (
        currentUsage.softDeferSinceMs &&
        decision.softDeferEpisodeExpired !== true &&
        Number(sessionCost) > 0 &&
        !ceilingStillFull
      ) {
        delete currentUsage.softDeferSinceMs;
      }
      const lease = {
        token: crypto.randomBytes(12).toString('hex'),
        kind: String(kind || 'unspecified'),
        priority: String(priority || 'normal'),
        weight: Math.max(0.5, Number(weight) || 1),
        memoryBytes: decision.requestedMemoryBytes,
        provider: String(provider || '').trim().toLowerCase(),
        sessionCost: Math.max(0, Number(sessionCost) || 0),
        nightlyOutcomeId: String(nightlyOutcomeId || '').trim().toLowerCase(),
        pid: Number(pid),
        acquiredAt: new Date(nowMs).toISOString(),
        acquiredAtMs: nowMs,
        expiresAt: new Date(nowMs + leaseMs).toISOString(),
        expiresAtMs: nowMs + leaseMs,
        leaseMs: Math.max(1, Number(leaseMs) || LEASE_MS),
      };
      leases.push(lease);
      if (lease.sessionCost > 0) {
        if (nightWindow.active) {
          // The charge always stamps the currently derived window key so the
          // record can never carry a dead night forward past a window rollover.
          currentUsage.night = usageKey;
          currentUsage.sessions = Number(currentUsage.sessions || 0) + lease.sessionCost;
          if (lease.provider) {
            currentUsage.providers[lease.provider] =
              Number(currentUsage.providers[lease.provider] || 0) + lease.sessionCost;
          }
          if (lease.nightlyOutcomeId) {
            currentUsage.outcomes[lease.nightlyOutcomeId] =
              Number(currentUsage.outcomes[lease.nightlyOutcomeId] || 0) + lease.sessionCost;
          }
          // Name who spent the night's sessions, so an exhausted ceiling can
          // be traced to jobs instead of one opaque total.
          const jobKey = `${lease.kind}:${String(cardId || '').trim().toLowerCase() || 'unnamed'}`;
          const jobs =
            currentUsage.jobs && typeof currentUsage.jobs === 'object' ? currentUsage.jobs : {};
          jobs[jobKey] = Number(jobs[jobKey] || 0) + lease.sessionCost;
          currentUsage.jobs = jobs;
          // Release settles this reserve against exactly the window and job
          // it was charged to.
          lease.chargedWindow = 'night';
          lease.chargedKey = usageKey;
          lease.jobKey = jobKey;
        } else {
          // A daytime charge is recorded but uncapped, and the night key it
          // would otherwise stamp belongs to a window it never ran in. Booking
          // it there pre-spends the ceiling before 23:00 CT so unattended
          // overnight work starts nearly exhausted (measured 2026-08-24 13:09
          // CT: 18 attended afternoon sessions already charged that evening).
          // Day spend keeps its own CT calendar-day ledger, so the night
          // window still opens at zero.
          const dayKey = ctCalendarDayKey(new Date(nowMs));
          const priorDay =
            currentUsage.daytime && currentUsage.daytime.day === dayKey
              ? currentUsage.daytime
              : { day: dayKey, sessions: 0, providers: {} };
          const dayProviders =
            priorDay.providers && typeof priorDay.providers === 'object' ? { ...priorDay.providers } : {};
          if (lease.provider) {
            dayProviders[lease.provider] =
              Number(dayProviders[lease.provider] || 0) + lease.sessionCost;
          }
          currentUsage.daytime = {
            day: dayKey,
            sessions: Number(priorDay.sessions || 0) + lease.sessionCost,
            providers: dayProviders,
          };
          lease.chargedWindow = 'day';
          lease.chargedKey = dayKey;
        }
        currentUsage.updatedAt = lease.acquiredAt;
        writeJsonAtomic(paths.nightlyUsage, currentUsage);
      }
      writeJsonAtomic(paths.leases, {
        schemaVersion: 1,
        updatedAt: new Date(nowMs).toISOString(),
        leases,
      });
      appendEvent(paths.events, {
        ts: lease.acquiredAt,
        event: 'acquired',
        lease,
        snapshot: decision.snapshot,
        capacity: decision.capacity,
      });
      return { acquired: true, lease, ...decision };
    },
    { nowMs, pidAlive, pid },
  );
  if (!locked.locked) return { acquired: false, reason: locked.reason };
  return locked.value;
}

function renewHostWorkLease(lease, { dataDir, nowMs = Date.now() } = {}) {
  if (!lease || !lease.token || !dataDir || lease.inherited === true) return false;
  const paths = statePaths(dataDir);
  const locked = withStateLock(
    paths,
    () => {
      const state = readJson(paths.leases, { schemaVersion: 1, leases: [] });
      const leases = Array.isArray(state.leases) ? state.leases : [];
      const current = leases.find((row) =>
        row && row.token === lease.token && Number(row.pid) === Number(lease.pid));
      if (!current) return false;
      const renewalMs = Math.max(
        1,
        Number(current.leaseMs) ||
          (Number(current.expiresAtMs) - Number(current.acquiredAtMs)) ||
          LEASE_MS,
      );
      current.leaseMs = renewalMs;
      current.heartbeatAt = new Date(nowMs).toISOString();
      current.heartbeatAtMs = nowMs;
      current.expiresAt = new Date(nowMs + renewalMs).toISOString();
      current.expiresAtMs = nowMs + renewalMs;
      writeJsonAtomic(paths.leases, {
        schemaVersion: 1,
        updatedAt: current.heartbeatAt,
        leases,
      });
      return true;
    },
    { nowMs },
  );
  return Boolean(locked.locked && locked.value);
}

function createHostWorkLeaseHeartbeat(lease, {
  dataDir,
  intervalMs = Math.min(
    DEFAULT_LEASE_HEARTBEAT_MS,
    Math.max(1_000, Math.floor(Number(lease?.leaseMs || LEASE_MS) / 3)),
  ),
} = {}) {
  if (!lease || lease.inherited === true) return { stop() {} };
  const timer = setInterval(() => {
    renewHostWorkLease(lease, { dataDir });
  }, Math.max(1, Number(intervalMs) || DEFAULT_LEASE_HEARTBEAT_MS));
  if (timer.unref) timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

function refundCounter(counters, key, refund) {
  if (!key || !counters || typeof counters !== 'object') return;
  const current = Number(counters[key]);
  if (Number.isFinite(current)) counters[key] = Math.max(0, current - refund);
}

// Admission charges a session-bearing lease its full reserve up front so that
// concurrent admissions see the spend. Release settles that reserve to the
// sessions the worker actually started (Oct 3 2026: healers that exited with
// no model session still cost two). Settlement only refunds: an overrun is
// recorded, never charged. A missing or invalid count, a lease row without a
// charged-window stamp (acquired by older code), an unreadable ledger, or a
// window that has rolled over keeps the full reserve. The outcomes counter is
// deliberately not refunded, so an admitted delivery-critical news
// reservation stays satisfied for the rest of the night.
function settleLeaseSessionCharge(paths, row, settledSessionCost, nowMs) {
  if (
    typeof settledSessionCost !== 'number' ||
    !Number.isFinite(settledSessionCost) ||
    settledSessionCost < 0
  ) {
    return;
  }
  const reserved = Math.max(0, Number(row && row.sessionCost) || 0);
  if (!(reserved > 0)) return;
  const counted = Math.floor(settledSessionCost);
  const actual = Math.min(counted, reserved);
  const refund = reserved - actual;
  const overrun = Math.max(0, counted - reserved);
  const window = String(row.chargedWindow || '');
  const key = String(row.chargedKey || '');
  let applied = false;
  let skipped = '';
  if (refund > 0) {
    const stamped = ['night', 'day'].includes(window) && Boolean(key);
    const usage = stamped ? readJson(paths.nightlyUsage, null) : null;
    if (!stamped) {
      skipped = 'lease-not-stamped';
    } else if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
      skipped = 'usage-unreadable';
    } else if (window === 'night') {
      if (usage.night !== key) {
        skipped = 'window-rolled-over';
      } else if (typeof usage.sessions !== 'number' || !Number.isFinite(usage.sessions)) {
        skipped = 'usage-unreadable';
      } else {
        usage.sessions = Math.max(0, usage.sessions - refund);
        refundCounter(usage.providers, row.provider, refund);
        refundCounter(usage.jobs, row.jobKey, refund);
        applied = true;
      }
    } else {
      const daytime = usage.daytime;
      if (!daytime || typeof daytime !== 'object' || daytime.day !== key) {
        skipped = 'window-rolled-over';
      } else if (!Number.isFinite(Number(daytime.sessions))) {
        skipped = 'usage-unreadable';
      } else {
        daytime.sessions = Math.max(0, Number(daytime.sessions) - refund);
        refundCounter(daytime.providers, row.provider, refund);
        applied = true;
      }
    }
    if (applied) {
      usage.updatedAt = new Date(nowMs).toISOString();
      writeJsonAtomic(paths.nightlyUsage, usage);
    }
  }
  appendEvent(paths.events, {
    ts: new Date(nowMs).toISOString(),
    event: 'session-settled',
    token: row.token,
    kind: row.kind,
    jobKey: row.jobKey || null,
    window: window || null,
    key: key || null,
    reserved,
    actual,
    refund,
    overrun,
    applied,
    ...(skipped ? { skipped } : {}),
  });
}

function releaseHostWorkLease(lease, { dataDir, nowMs = Date.now(), settledSessionCost } = {}) {
  if (!lease || !lease.token || !dataDir) return false;
  // An inherited acquisition borrows the parent's already-counted capacity.
  // Only the parent that created the durable lease may remove it.
  if (lease.inherited === true) return true;
  const paths = statePaths(dataDir);
  // A release is capacity correctness, not optional telemetry. A concurrent
  // acquire can own the tiny state lock for a few milliseconds; retry that
  // transient race so a still-live controller PID cannot pin a finished lease
  // until its 75-minute expiry.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const locked = withStateLock(
      paths,
      () => {
        const state = readJson(paths.leases, { schemaVersion: 1, leases: [] });
        const before = Array.isArray(state.leases) ? state.leases : [];
        const removedRow = before.find((row) => row && row.token === lease.token) || null;
        const leases = before.filter((row) => row && row.token !== lease.token);
        writeJsonAtomic(paths.leases, {
          schemaVersion: 1,
          updatedAt: new Date(nowMs).toISOString(),
          leases,
        });
        const removed = leases.length !== before.length;
        if (removed) {
          appendEvent(paths.events, {
            ts: new Date(nowMs).toISOString(),
            event: 'released',
            token: lease.token,
            kind: lease.kind,
            pid: lease.pid,
          });
          // Settled under the same lock as the removal, so a lease row that
          // was already released or pruned can never be refunded.
          if (removedRow) {
            try {
              settleLeaseSessionCharge(paths, removedRow, settledSessionCost, nowMs);
            } catch {
              // A failed settlement keeps the full reserve; the release stands.
            }
          }
        }
        return removed;
      },
      { nowMs },
    );
    if (locked.locked) return Boolean(locked.value);
    sleepSync(25);
  }
  return false;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireHostWorkLease(options = {}) {
  const waitMs = Math.max(
    0,
    Number(
      options.waitMs ??
        (String(options.priority || '') === 'critical' ? 10 * 60 * 1000 : 0),
    ) || 0,
  );
  const pollMs = Math.max(25, Number(options.pollMs || 250) || 250);
  const started = Date.now();
  let last = null;
  const shouldAbort =
    typeof options.shouldAbort === 'function' ? options.shouldAbort : null;
  const abortReason = String(options.abortReason || 'admission-wait-aborted');
  const aborted = () => {
    if (!shouldAbort) return false;
    try {
      return shouldAbort() === true;
    } catch {
      // A broken cancellation probe must fail closed. Continuing a critical
      // wait after its owner can no longer prove that the surrounding
      // operation is safe risks holding the caller's coordination locks for
      // the entire wait budget.
      return true;
    }
  };
  do {
    if (aborted()) {
      return {
        acquired: false,
        terminal: true,
        aborted: true,
        reason: abortReason,
        waitedMs: Date.now() - started,
      };
    }
    last = tryAcquireHostWorkLease(options);
    if (last.acquired) {
      return { ...last, waitedMs: Date.now() - started };
    }
    if (last.terminal) break;
    if (Date.now() - started >= waitMs) break;
    await (options.sleep || defaultSleep)(Math.min(pollMs, waitMs - (Date.now() - started)));
  } while (Date.now() - started <= waitMs);
  return { ...(last || { acquired: false, reason: 'not-admitted' }), waitedMs: Date.now() - started };
}

const HOST_WORK_DEFERRED_PREFIX = 'host-work-deferred:';

// A deferral is not a failure. Admission refused to START the work, so nothing
// was tried and nothing was refuted: the caller must route the outcome to its
// retryable capacity-deferred path instead of spending a repair attempt or
// arming a same-evidence no-repeat guard.
//
// The predicate accepts an Error, a thrown value, or an already-stringified
// message or stack, because the deferral crosses process and receipt
// boundaries where `error.code` does not survive but the token in the text
// does.
function isHostWorkDeferralError(error) {
  if (!error) return false;
  if (error.code === 'HOST_WORK_DEFERRED') return true;
  const message = String((error && error.message) || error || '');
  if (!message) return false;
  return /(^|[\s:>\]"'])host-work-deferred:/i.test(message);
}

async function withHostWorkAdmission(options, worker) {
  const admission = await acquireHostWorkLease(options);
  if (!admission.acquired) {
    if (typeof options.onDeferred === 'function') return options.onDeferred(admission);
    const error = new Error(`${HOST_WORK_DEFERRED_PREFIX}${admission.reason || 'not-admitted'}`);
    error.code = 'HOST_WORK_DEFERRED';
    error.admission = admission;
    throw error;
  }
  const heartbeat = createHostWorkLeaseHeartbeat(admission.lease, {
    dataDir: options.dataDir,
    ...(Number.isFinite(options.heartbeatMs) ? { intervalMs: options.heartbeatMs } : {}),
  });
  // A caller may report how many sessions its worker actually started, read
  // from the worker's own result. A throwing worker or a throwing reader
  // passes nothing, so release keeps the full reserve.
  let settledSessionCost;
  try {
    const result = await worker(admission);
    if (typeof options.settleSessionCost === 'function') {
      try {
        settledSessionCost = options.settleSessionCost(result);
      } catch {
        settledSessionCost = undefined;
      }
    }
    return result;
  } finally {
    heartbeat.stop();
    releaseHostWorkLease(admission.lease, { dataDir: options.dataDir, settledSessionCost });
  }
}

module.exports = {
  STATE_REL,
  LEASE_MS,
  BURSTABLE_CREDIT_FLOORS,
  DEFAULT_NIGHTLY_SESSION_CEILING,
  DEFAULT_NIGHTLY_RESERVED_SESSION_COST,
  DEFAULT_NIGHTLY_RESERVED_OUTCOME_IDS,
  NIGHTLY_SOFT_DEFER_MAX_MS,
  LOCK_SOFT_STALE_MS,
  LOCK_HARD_STALE_MS,
  DEFAULT_LEASE_HEARTBEAT_MS,
  DEFAULT_PROVIDER_CONCURRENT_CEILINGS,
  statePaths,
  linuxAvailableMemoryBytes,
  parseLinuxIoPressure,
  linuxIoPressureAvg10,
  linuxCpuPressureAvg10,
  latestCapacitySample,
  latestCurrentCapacitySample,
  latestNightCapacitySample,
  imdsInstanceType,
  detectInstanceType,
  burstableInstanceType,
  deliveryWindowState,
  overnightWindowState,
  nightlyUsageKey,
  ctCalendarDayKey,
  defaultReservedMemoryBytes,
  linuxBootId,
  linuxCoredumpPressure,
  hostSnapshot,
  processAlive,
  sleepSync,
  activeLeaseRows,
  admissionDecision,
  tryAcquireHostWorkLease,
  acquireHostWorkLease,
  createHostWorkLeaseHeartbeat,
  releaseHostWorkLease,
  renewHostWorkLease,
  withHostWorkAdmission,
  HOST_WORK_DEFERRED_PREFIX,
  isHostWorkDeferralError,
};
