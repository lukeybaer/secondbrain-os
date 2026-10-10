'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'secondbrain.overnight-capacity-night.v1';
const SAMPLE_SCHEMA = 'secondbrain.overnight-capacity-sample.v1';
const CURRENT_SAMPLE_SCHEMA = 'secondbrain.current-capacity-snapshot.v1';
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const T3_SURPLUS_CEILINGS = Object.freeze({
  't3.medium': 576,
  't3.large': 864,
  't3.xlarge': 2304,
});

const CT_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function ctParts(value = new Date()) {
  const instant = value instanceof Date ? value : new Date(value);
  const parts = Object.fromEntries(
    CT_FORMAT.formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function shiftDate(date, deltaDays) {
  const [year, month, day] = String(date).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + deltaDays)).toISOString().slice(0, 10);
}

function nightIdFor(value = new Date()) {
  const ct = ctParts(value);
  const minute = ct.hour * 60 + ct.minute;
  if (minute >= 22 * 60 + 35) return ct.date;
  if (minute < 5 * 60 + 35) return shiftDate(ct.date, -1);
  return '';
}

function mostRecentCompletedNight(value = new Date()) {
  const ct = ctParts(value);
  const minute = ct.hour * 60 + ct.minute;
  return minute >= 5 * 60 + 50 ? shiftDate(ct.date, -1) : shiftDate(ct.date, -2);
}

function inSamplingWindow(value = new Date()) {
  const ct = ctParts(value);
  const minute = ct.hour * 60 + ct.minute;
  return minute >= 22 * 60 + 50 || minute <= 5 * 60 + 25;
}

function parsePressure(text) {
  const out = {};
  for (const line of String(text || '').trim().split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const kind = parts.shift();
    if (!kind) continue;
    out[kind] = {};
    for (const token of parts) {
      const [key, value] = token.split('=');
      out[kind][key] = Number(value);
    }
  }
  return out;
}

function parseMemAvailableMiB(text) {
  const match = String(text || '').match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  return match ? Number(match[1]) / 1024 : null;
}

function parseVmstat(text) {
  const rows = Object.fromEntries(
    String(text || '')
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length === 2)
      .map(([key, value]) => [key, Number(value)]),
  );
  return {
    pswpin: Number(rows.pswpin || 0),
    pswpout: Number(rows.pswpout || 0),
    oom_kill: Number(rows.oom_kill || 0),
  };
}

function activeOtterQueue(dataDir, nowMs = Date.now(), fsApi = fs) {
  const directory = path.join(dataDir, 'agent', 'otter-call-healer-handoffs');
  let names = [];
  try {
    names = fsApi.readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return { active: 0, max_delay_ms: 0, unreadable: 0 };
  }
  let active = 0;
  let unreadable = 0;
  let maxDelayMs = 0;
  for (const name of names) {
    try {
      const row = JSON.parse(fsApi.readFileSync(path.join(directory, name), 'utf8').replace(/^\uFEFF/, ''));
      if (!['queued', 'deferred', 'advanced'].includes(String(row.state || ''))) continue;
      const lastTransition = Array.isArray(row.history) ? row.history[row.history.length - 1] : null;
      const deferredReason = String(lastTransition?.reason || row.deferred_reason || row.terminal_blocked_reason || '');
      if (
        row.terminal_blocked === true ||
        (row.state === 'deferred' && /pause|lock|fence|capacity|awaiting|scheduler|manual/i.test(deferredReason))
      ) continue;
      active += 1;
      const at = Date.parse(row.updated_at || row.created_at || row.history?.[0]?.at || '');
      if (Number.isFinite(at)) maxDelayMs = Math.max(maxDelayMs, Math.max(0, nowMs - at));
    } catch {
      unreadable += 1;
    }
  }
  return { active, max_delay_ms: maxDelayMs, unreadable };
}

function processLane(commandLine) {
  const cmd = String(commandLine || '').toLowerCase();
  if (/otter-derived-audio-retention/.test(cmd)) return 'otter_retention';
  if (/otter.*historical|historical.*otter|global-identity/.test(cmd)) return 'otter_historical';
  if (/otter/.test(cmd)) return 'otter_current';
  if (/briefing|card-controller|overnight-watch/.test(cmd)) return 'briefing';
  if (/sshd|systemd|amazon-ssm/.test(cmd)) return 'control';
  return 'other';
}

function collectProcessRss({ procRoot = '/proc', fsApi = fs } = {}) {
  const lanes = {};
  let pids = [];
  try {
    pids = fsApi.readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch {
    return lanes;
  }
  for (const pid of pids) {
    try {
      const cmdline = fsApi.readFileSync(path.join(procRoot, pid, 'cmdline'), 'utf8').replace(/\0/g, ' ');
      const status = fsApi.readFileSync(path.join(procRoot, pid, 'status'), 'utf8');
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      const rssMiB = match ? Number(match[1]) / 1024 : 0;
      const lane = processLane(cmdline);
      const current = lanes[lane] || { processes: 0, rss_mib: 0, max_process_rss_mib: 0 };
      current.processes += 1;
      current.rss_mib += rssMiB;
      current.max_process_rss_mib = Math.max(current.max_process_rss_mib, rssMiB);
      lanes[lane] = current;
    } catch {
      // Process exited during the snapshot.
    }
  }
  return Object.fromEntries(
    Object.entries(lanes).map(([lane, row]) => [lane, {
      ...row,
      rss_mib: Math.round(row.rss_mib * 10) / 10,
      max_process_rss_mib: Math.round(row.max_process_rss_mib * 10) / 10,
    }]),
  );
}

function consecutiveBreach(samples, predicate, durationMs, maxStepMs = 6 * 60 * 1000) {
  let startedAt = null;
  let priorAt = null;
  for (const sample of samples) {
    const at = Date.parse(sample.sampled_at);
    if (priorAt !== null && (!Number.isFinite(at) || at - priorAt > maxStepMs)) startedAt = null;
    if (!Number.isFinite(at) || !predicate(sample)) {
      startedAt = null;
      priorAt = Number.isFinite(at) ? at : null;
      continue;
    }
    if (startedAt === null) startedAt = at;
    if (at - startedAt >= durationMs) return true;
    priorAt = at;
  }
  return false;
}

function vmActivity(samples, field) {
  for (let index = 1; index < samples.length; index += 1) {
    const prior = Number(samples[index - 1]?.vmstat?.[field] || 0);
    const current = Number(samples[index]?.vmstat?.[field] || 0);
    if (current > prior) return true;
  }
  return false;
}

function maxOf(samples, selector) {
  return samples.reduce((max, row) => Math.max(max, Number(selector(row)) || 0), 0);
}

function minimumOf(samples, selector) {
  const values = samples.map(selector).map(Number).filter(Number.isFinite);
  return values.length ? Math.min(...values) : null;
}

function threeSampleCreditRiseWithQueue(samples) {
  for (let index = 2; index < samples.length; index += 1) {
    const triple = samples.slice(index - 2, index + 1);
    const balances = triple.map((row) => Number(row.cloudwatch?.cpu_surplus_credit_balance));
    if (
      balances.every(Number.isFinite) &&
      balances[0] < balances[1] && balances[1] < balances[2] &&
      triple.some((row) => Number(row.otter_queue?.max_delay_ms || 0) > FIVE_MINUTES_MS)
    ) return true;
  }
  return false;
}

function samplingCoverage(samples, nightId) {
  if (!samples.length) {
    return {
      sufficient: false,
      max_gap_ms: null,
      expected_fraction: 0,
      start_boundary_observed: false,
      end_boundary_observed: false,
    };
  }
  let maxGapMs = 0;
  for (let index = 1; index < samples.length; index += 1) {
    maxGapMs = Math.max(
      maxGapMs,
      Date.parse(samples[index].sampled_at) - Date.parse(samples[index - 1].sampled_at),
    );
  }
  const expected = 80;
  const expectedFraction = Math.min(1, samples.length / expected);
  const first = ctParts(samples[0].sampled_at);
  const last = ctParts(samples[samples.length - 1].sampled_at);
  const firstMinute = first.hour * 60 + first.minute;
  const lastMinute = last.hour * 60 + last.minute;
  const startBoundaryObserved = first.date === nightId && firstMinute >= 22 * 60 + 50 && firstMinute <= 23 * 60 + 5;
  const endBoundaryObserved = last.date === shiftDate(nightId, 1) && lastMinute >= 5 * 60 + 10 && lastMinute <= 5 * 60 + 25;
  return {
    sufficient: expectedFraction >= 0.7 && maxGapMs <= 12 * 60 * 1000 && startBoundaryObserved && endBoundaryObserved,
    max_gap_ms: maxGapMs,
    expected_fraction: Math.round(expectedFraction * 1000) / 1000,
    start_boundary_observed: startBoundaryObserved,
    end_boundary_observed: endBoundaryObserved,
  };
}

function classifyNight({ nightId, samples = [], briefing = null } = {}) {
  const ordered = [...samples]
    .filter((row) => row?.schema === SAMPLE_SCHEMA && row?.night_id === nightId)
    .sort((a, b) => Date.parse(a.sampled_at) - Date.parse(b.sampled_at));
  const coverage = samplingCoverage(ordered, nightId);
  const cpuPsi = (row) => Number(row.psi?.cpu?.some?.avg10 || 0);
  const memorySome = (row) => Number(row.psi?.memory?.some?.avg10 || 0);
  const memoryFull = (row) => Number(row.psi?.memory?.full?.avg10 || 0);
  const ioSome = (row) => Number(row.psi?.io?.some?.avg10 || 0);

  const cpu = {
    load_and_psi_10m: consecutiveBreach(
      ordered,
      (row) => Number(row.load1 || 0) > 3 && cpuPsi(row) > 20,
      10 * 60 * 1000,
    ),
    queue_delay_over_5m_observed: ordered.some((row) => Number(row.otter_queue?.max_delay_ms || 0) > FIVE_MINUTES_MS),
    // A queue is not CPU evidence by itself: pause files, locks, and I/O can
    // produce delay. It becomes the CPU gate only when CPU PSI co-occurs.
    lane_queue_over_5m: ordered.some(
      (row) => Number(row.otter_queue?.max_delay_ms || 0) > FIVE_MINUTES_MS && cpuPsi(row) > 20,
    ),
    attributed_deadline_miss: briefing?.capacity_attribution === 'cpu' && briefing?.status === 'red',
  };
  cpu.failed = cpu.load_and_psi_10m || cpu.lane_queue_over_5m || cpu.attributed_deadline_miss;

  const memory = {
    mem_available_below_512m_5m: consecutiveBreach(
      ordered,
      (row) => Number(row.mem_available_mib) < 512,
      FIVE_MINUTES_MS,
    ),
    psi_some_over_10_10m: consecutiveBreach(ordered, (row) => memorySome(row) > 10, 10 * 60 * 1000),
    psi_full_over_1_5m: consecutiveBreach(ordered, (row) => memoryFull(row) > 1, FIVE_MINUTES_MS),
    oom_event: vmActivity(ordered, 'oom_kill'),
    active_swap_io: vmActivity(ordered, 'pswpin') || vmActivity(ordered, 'pswpout'),
    attributed_deadline_miss: briefing?.capacity_attribution === 'memory' && briefing?.status === 'red',
  };
  memory.failed = memory.mem_available_below_512m_5m || memory.psi_some_over_10_10m ||
    memory.psi_full_over_1_5m || memory.oom_event || memory.active_swap_io || memory.attributed_deadline_miss;

  const storage = {
    io_psi_some_over_10_10m: consecutiveBreach(ordered, (row) => ioSome(row) > 10, 10 * 60 * 1000),
  };
  storage.failed = storage.io_psi_some_over_10_10m;

  const instanceTypes = [...new Set(ordered.map((row) => row.instance_type).filter(Boolean))];
  const ceiling = T3_SURPLUS_CEILINGS['t3.large'];
  const credit = {
    cloudwatch_complete: ordered.length > 0 && ordered.every((row) => row.cloudwatch?.ok === true),
    t3_large_only: instanceTypes.length === 1 && instanceTypes[0] === 't3.large',
    surplus_balance_80_percent: ordered.some(
      (row) => Number(row.cloudwatch?.cpu_surplus_credit_balance || 0) >= ceiling * 0.8,
    ),
    rising_three_samples_with_queue: threeSampleCreditRiseWithQueue(ordered),
    surplus_charged: ordered.some((row) => Number(row.cloudwatch?.cpu_surplus_credits_charged || 0) > 0),
    status_check_failed: ordered.some((row) => Number(row.cloudwatch?.status_check_failed || 0) > 0),
  };
  credit.invalid =
    !coverage.sufficient ||
    !credit.cloudwatch_complete ||
    !credit.t3_large_only ||
    credit.surplus_balance_80_percent ||
    credit.rising_three_samples_with_queue ||
    credit.status_check_failed;

  return {
    schema: SCHEMA,
    night_id: nightId,
    generated_at: new Date().toISOString(),
    sample_count: ordered.length,
    coverage,
    instance_types: instanceTypes,
    valid_t3_night: !credit.invalid,
    gates: { cpu, memory, storage, credit },
    quality: { briefing: briefing || null },
    maxima: {
      load1: maxOf(ordered, (row) => row.load1),
      cpu_psi_some_avg10: maxOf(ordered, (row) => row.psi?.cpu?.some?.avg10),
      memory_psi_some_avg10: maxOf(ordered, (row) => row.psi?.memory?.some?.avg10),
      memory_psi_full_avg10: maxOf(ordered, (row) => row.psi?.memory?.full?.avg10),
      io_psi_some_avg10: maxOf(ordered, (row) => row.psi?.io?.some?.avg10),
      otter_queue_delay_ms: maxOf(ordered, (row) => row.otter_queue?.max_delay_ms),
      cpu_surplus_credit_balance: maxOf(ordered, (row) => row.cloudwatch?.cpu_surplus_credit_balance),
      ebs_queue_length: maxOf(ordered, (row) => row.cloudwatch?.ebs_queue_length),
    },
    minima: {
      mem_available_mib: minimumOf(ordered, (row) => row.mem_available_mib),
      cpu_credit_balance: minimumOf(ordered, (row) => row.cloudwatch?.cpu_credit_balance),
    },
    decision_route: storage.failed && !cpu.failed && !memory.failed
      ? 'storage-diagnosis'
      : cpu.failed || memory.failed
        ? 'capacity-candidate'
        : credit.invalid
          ? 'invalid-night-repeat-t3'
          : 'hold-t3-large',
  };
}

function capacityDecision(nights = []) {
  const valid = nights
    .filter((night) => night?.schema === SCHEMA && night.valid_t3_night === true)
    .sort((a, b) => String(a.night_id).localeCompare(String(b.night_id)))
    .slice(-3);
  const cpuMemoryFailures = valid.filter(
    (night) => night.gates?.cpu?.failed || night.gates?.memory?.failed,
  ).length;
  const canary = valid.some(
    (night) => night.gates?.cpu?.attributed_deadline_miss || night.gates?.memory?.attributed_deadline_miss,
  );
  const eligible = valid.length === 3 && cpuMemoryFailures >= 2;
  return {
    schema: 'secondbrain.overnight-capacity-decision.v1',
    generated_at: new Date().toISOString(),
    valid_nights: valid.map((night) => night.night_id),
    valid_night_count: valid.length,
    cpu_or_memory_failure_nights: cpuMemoryFailures,
    recommendation: eligible
      ? 'conditional-authorization-met:m7i.xlarge-night-window'
      : 'hold:t3.large-night-window',
    m7i_night_window_authorized: eligible,
    one_night_canary_authorized: canary,
    storage_only_nights: valid
      .filter((night) => night.gates?.storage?.failed && !night.gates?.cpu?.failed && !night.gates?.memory?.failed)
      .map((night) => night.night_id),
  };
}

module.exports = {
  CURRENT_SAMPLE_SCHEMA,
  SAMPLE_SCHEMA,
  SCHEMA,
  T3_SURPLUS_CEILINGS,
  activeOtterQueue,
  capacityDecision,
  classifyNight,
  collectProcessRss,
  consecutiveBreach,
  ctParts,
  inSamplingWindow,
  mostRecentCompletedNight,
  nightIdFor,
  parseMemAvailableMiB,
  parsePressure,
  parseVmstat,
  processLane,
  samplingCoverage,
  shiftDate,
};
