'use strict';

// Pure helpers behind scripts/ops/aws-cost-actions-2026-10-23.sh (owner-run AWS
// cost actions H9-1, H9-2, H9-3, H9-6, H9-7 and M9). The shell script does the
// AWS calls; everything that can be decided from data lives here so it is
// testable without AWS:
//
//   - S3 lifecycle: transition-only rule sets per bucket, a merge that keeps
//     every foreign rule byte for byte (a PUT replaces the whole configuration),
//     and a before/after diff that proves nothing foreign changed.
//   - EBS: gp3 baseline decision from VolumeQueueLength and IOPS/throughput.
//   - EFS: bursting vs elastic vs provisioned throughput, with the cost math.
//   - ECR: lifecycle keep count that respects images still referenced by ECS
//     task definitions, and the policy JSON.
//   - CloudFront: the distribution config with only WebACLId cleared.
//   - Durable plan and receipt records for every block.
//
// Hard rules encoded here (owner decision):
//   - S3 lifecycle rules created by this file never expire, delete or abort
//     anything. They only move data to cheaper storage classes. See
//     validateOwnedRules().
//   - The one deletion policy built here is ecrLifecyclePolicy() (approved
//     deletion class h9-7-ecr-*, voice approval 2026-10-23). computeEcrKeep()
//     reports ok:false, and the script refuses, unless every ECS reference
//     matches an image and none of them would expire.

const fs = require('node:fs');

const OWNED_PREFIX = 'amy-cost-';
const IA_DAYS = 30;
const GIR_DAYS = 90;
const DEEP_ARCHIVE_DAYS = 180;
const MIN_OBJECT_SIZE = 'all_storage_classes_128K';

// Any of these in a rule this file creates is a deletion of data (or of unfinished
// upload parts) and is refused by validateOwnedRules().
const FORBIDDEN_RULE_KEYS = [
  'Expiration',
  'NoncurrentVersionExpiration',
  'AbortIncompleteMultipartUpload',
];

const ALLOWED_CLASSES = new Set(['STANDARD_IA', 'GLACIER_IR', 'DEEP_ARCHIVE']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

function sameJson(a, b) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

// ---------------------------------------------------------------------------
// S3 lifecycle
// ---------------------------------------------------------------------------

function currentTransitions(deepArchive) {
  const list = [
    { Days: IA_DAYS, StorageClass: 'STANDARD_IA' },
    { Days: GIR_DAYS, StorageClass: 'GLACIER_IR' },
  ];
  if (deepArchive) list.push({ Days: DEEP_ARCHIVE_DAYS, StorageClass: 'DEEP_ARCHIVE' });
  return list;
}

function noncurrentTransitions() {
  return [
    { NoncurrentDays: IA_DAYS, StorageClass: 'STANDARD_IA' },
    { NoncurrentDays: GIR_DAYS, StorageClass: 'GLACIER_IR' },
  ];
}

function makeRule(suffix, prefix, { current = false, deepArchive = false, noncurrent = false } = {}) {
  const rule = { ID: `${OWNED_PREFIX}${suffix}`, Filter: { Prefix: prefix }, Status: 'Enabled' };
  if (current) rule.Transitions = currentTransitions(deepArchive);
  if (noncurrent) rule.NoncurrentVersionTransitions = noncurrentTransitions();
  return rule;
}

// Cold archive prefixes in the backups bucket: nothing reads them on a timer, so
// they go all the way to Deep Archive at 180 days. The data-lake life-archive and
// runtime-current prefixes are live stores, so they stop at Glacier Instant
// Retrieval (still millisecond reads) and never reach Deep Archive.
const BUCKETS = {
  backups: {
    bucket: (account) => `${account}-secondbrain-backups`,
    rules: () => [
      makeRule('snapshots-cold-tier', 'snapshots/', { current: true, deepArchive: true }),
      makeRule('life-archive-cold-tier', 'data-lake/secondbrain/life-archive/', { current: true, noncurrent: true }),
      makeRule('runtime-current-noncurrent-tier', 'data-lake/secondbrain/runtime-current/', { noncurrent: true }),
      makeRule('timemachine-cold-tier', 'timemachine/', { current: true, deepArchive: true, noncurrent: true }),
      makeRule('pc-migration-cold-tier', 'pc-migration/', { current: true, deepArchive: true, noncurrent: true }),
      makeRule('git-archive-cold-tier', 'git-archive/', { current: true, deepArchive: true, noncurrent: true }),
      makeRule('retired-infrastructure-cold-tier', 'retired-infrastructure/', { current: true, deepArchive: true, noncurrent: true }),
    ],
  },
  sessions: {
    bucket: (account) => `secondbrain-sessions-${account}-us-east-1`,
    rules: () => [makeRule('transcripts-cold-tier', 'transcripts/', { current: true, noncurrent: true })],
  },
  // The ExampleCo data bucket holds 1.1 GB of live app state and 181 GB of old
  // versions of it. Live objects are read by the app, so only old versions move.
  pixdata: {
    bucket: (account) => `ExampleCo-data-prod-${account}`,
    rules: () => [makeRule('noncurrent-tier', '', { noncurrent: true })],
  },
};

function kindOrThrow(kind) {
  if (!Object.prototype.hasOwnProperty.call(BUCKETS, kind)) {
    throw new Error(`unknown bucket kind "${kind}" (expected one of ${Object.keys(BUCKETS).join(', ')})`);
  }
  return BUCKETS[kind];
}

function ownedRules(kind) {
  return kindOrThrow(kind).rules();
}

function bucketName(kind, account) {
  return kindOrThrow(kind).bucket(String(account));
}

function ruleDays(list, key) {
  return (list || []).map((t) => t[key]);
}

function validateOwnedRules(rules) {
  const problems = [];
  const seen = new Set();
  for (const rule of rules) {
    const id = rule.ID;
    if (typeof id !== 'string' || !id.startsWith(OWNED_PREFIX)) problems.push(`rule "${id}" must start with ${OWNED_PREFIX}`);
    if (seen.has(id)) problems.push(`duplicate rule id "${id}"`);
    seen.add(id);
    if (rule.Status !== 'Enabled') problems.push(`rule "${id}" must be Enabled`);
    for (const key of FORBIDDEN_RULE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(rule, key)) problems.push(`rule "${id}" has forbidden key ${key} (transition-only)`);
    }
    if (!rule.Filter || typeof rule.Filter.Prefix !== 'string') problems.push(`rule "${id}" needs Filter.Prefix`);
    const cur = rule.Transitions || [];
    const non = rule.NoncurrentVersionTransitions || [];
    if (!cur.length && !non.length) problems.push(`rule "${id}" has no transition action`);
    for (const [list, key, label] of [
      [cur, 'Days', 'Transitions'],
      [non, 'NoncurrentDays', 'NoncurrentVersionTransitions'],
    ]) {
      const days = ruleDays(list, key);
      for (const t of list) {
        if (!ALLOWED_CLASSES.has(t.StorageClass)) problems.push(`rule "${id}" ${label}: class ${t.StorageClass} is not allowed`);
      }
      for (let i = 1; i < days.length; i += 1) {
        if (!(days[i] > days[i - 1])) problems.push(`rule "${id}" ${label}: days must increase`);
      }
      const byClass = Object.fromEntries(list.map((t) => [t.StorageClass, t[key]]));
      if (byClass.STANDARD_IA !== undefined && byClass.STANDARD_IA < IA_DAYS) problems.push(`rule "${id}" ${label}: STANDARD_IA before ${IA_DAYS} days`);
      if (byClass.GLACIER_IR !== undefined && byClass.STANDARD_IA !== undefined && byClass.GLACIER_IR - byClass.STANDARD_IA < 30) {
        problems.push(`rule "${id}" ${label}: GLACIER_IR must follow STANDARD_IA by 30 days or more`);
      }
      if (byClass.DEEP_ARCHIVE !== undefined && byClass.GLACIER_IR !== undefined && byClass.DEEP_ARCHIVE - byClass.GLACIER_IR < 90) {
        problems.push(`rule "${id}" ${label}: DEEP_ARCHIVE must follow GLACIER_IR by 90 days or more`);
      }
    }
  }
  if (problems.length) throw new Error(`invalid cost lifecycle rules:\n  ${problems.join('\n  ')}`);
  return true;
}

// AWS may return an empty prefix as Filter {} or Filter {Prefix:""}; compare both alike.
function normalizeRule(rule) {
  const out = clone(rule);
  if (!out.Filter || Object.keys(out.Filter).length === 0) out.Filter = { Prefix: out.Prefix || '' };
  delete out.Prefix;
  return out;
}

function rulePrefix(rule) {
  const n = normalizeRule(rule);
  return typeof n.Filter.Prefix === 'string' ? n.Filter.Prefix : null;
}

function hasTransitions(rule, noncurrent) {
  return noncurrent
    ? (rule.NoncurrentVersionTransitions || []).length > 0
    : (rule.Transitions || []).length > 0;
}

// Two rules overlap when one prefix starts with the other (or the filter is not a
// plain prefix, so it cannot be compared). Overlap only matters when both rules
// transition the same kind of version.
function overlapWarnings(foreignRules, owned) {
  const warnings = [];
  for (const f of foreignRules) {
    const fp = rulePrefix(f);
    for (const o of owned) {
      const op = rulePrefix(o);
      const overlaps = fp === null || op === null || fp.startsWith(op) || op.startsWith(fp);
      if (!overlaps) continue;
      for (const noncurrent of [false, true]) {
        if (hasTransitions(f, noncurrent) && hasTransitions(o, noncurrent)) {
          warnings.push(`existing rule "${f.ID}" and new rule "${o.ID}" both transition ${noncurrent ? 'noncurrent' : 'current'} versions under overlapping prefixes`);
        }
      }
    }
  }
  return warnings;
}

function mergeLifecycle(current, kind) {
  const owned = ownedRules(kind);
  validateOwnedRules(owned);
  const ownedIds = new Set(owned.map((r) => r.ID));
  const existing = Array.isArray(current && current.Rules) ? current.Rules : [];
  const foreign = existing.filter((r) => !ownedIds.has(r.ID)).map(clone);
  return { Rules: [...foreign, ...owned], warnings: overlapWarnings(foreign, owned) };
}

function putPayload(merged) {
  return { Rules: merged.Rules };
}

function diffLifecycle(before, after, kind) {
  const problems = [];
  const owned = ownedRules(kind);
  const ownedIds = new Set(owned.map((r) => r.ID));
  const afterRules = Array.isArray(after && after.Rules) ? after.Rules : [];
  for (const rule of (before && before.Rules) || []) {
    if (ownedIds.has(rule.ID)) continue;
    const found = afterRules.find((r) => r.ID === rule.ID);
    if (!found) problems.push(`existing rule "${rule.ID}" is missing after the change`);
    else if (!sameJson(normalizeRule(rule), normalizeRule(found))) problems.push(`existing rule "${rule.ID}" changed`);
  }
  for (const rule of owned) {
    const found = afterRules.find((r) => r.ID === rule.ID);
    if (!found) problems.push(`new rule "${rule.ID}" is missing after the change`);
    else if (!sameJson(normalizeRule(rule), normalizeRule(found))) problems.push(`new rule "${rule.ID}" differs from what was sent`);
  }
  const beforeSize = before && before.TransitionDefaultMinimumObjectSize;
  const afterSize = after && after.TransitionDefaultMinimumObjectSize;
  if (beforeSize && afterSize && beforeSize !== afterSize) {
    problems.push(`TransitionDefaultMinimumObjectSize changed from ${beforeSize} to ${afterSize}`);
  }
  return { ok: problems.length === 0, problems };
}

// Rollback without any delete call: put the previous rules back, or, when there
// were none, put the same new rules Disabled (a no-op configuration).
function rollbackPayload(before, kind) {
  const previous = Array.isArray(before && before.Rules) ? before.Rules : [];
  if (previous.length) return { Rules: clone(previous) };
  return { Rules: ownedRules(kind).map((r) => ({ ...clone(r), Status: 'Disabled' })) };
}

function describeRules(rules) {
  return rules.map((rule) => {
    const parts = [];
    if (rule.Transitions) parts.push(`current: ${rule.Transitions.map((t) => `${t.StorageClass}@${t.Days}d`).join(' -> ')}`);
    if (rule.NoncurrentVersionTransitions) parts.push(`noncurrent: ${rule.NoncurrentVersionTransitions.map((t) => `${t.StorageClass}@${t.NoncurrentDays}d`).join(' -> ')}`);
    const prefix = rulePrefix(rule);
    return `${rule.ID} | prefix ${prefix === '' ? '(whole bucket)' : prefix} | ${parts.join(' | ') || 'no transition'}`;
  });
}

// Keep whatever default minimum object size the bucket already has; a PUT without the flag
// would otherwise reset it.
function s3MinSize(current) {
  return (current && current.TransitionDefaultMinimumObjectSize) || MIN_OBJECT_SIZE;
}

// ---------------------------------------------------------------------------
// CloudWatch series helpers
// ---------------------------------------------------------------------------

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))];
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

// Reads <dir>/<metric>_<n>.json for n = 1..days (aws cloudwatch get-metric-statistics output).
function loadSeries(dir, metric, stat, days = 7) {
  const out = new Map();
  for (let n = 1; n <= days; n += 1) {
    const file = `${dir}/${metric}_${n}.json`;
    if (!fs.existsSync(file)) continue;
    for (const point of readJsonFile(file).Datapoints || []) {
      if (point[stat] !== undefined) out.set(point.Timestamp, point[stat]);
    }
  }
  return out;
}

// REDUCE only when every gate passes, because a shallow queue under today's higher limits does
// not by itself prove the lower limits can serve the load (fail closed; the reason names every
// gate that failed):
//   coverage       each of the five series has at least coverageMin of the window's minutes
//   queue          p95 VolumeQueueLength under queueLimit
//   iops-p99       p99 one-minute IOPS at or under headroom x baselineIops
//   mibps-p99      p99 one-minute MiB/s at or under headroom x baselineMibps
//   over-baseline  minutes over either baseline at most overBaselineMax of the observed minutes
function ebsSummary(
  dir,
  { days = 7, baselineIops = 3000, baselineMibps = 125, queueLimit = 1.0, coverageMin = 0.5, headroom = 0.8, overBaselineMax = 0.001 } = {},
) {
  const queue = [...loadSeries(dir, 'VolumeQueueLength', 'Average', days).values()];
  const ro = loadSeries(dir, 'VolumeReadOps', 'Sum', days);
  const wo = loadSeries(dir, 'VolumeWriteOps', 'Sum', days);
  const rb = loadSeries(dir, 'VolumeReadBytes', 'Sum', days);
  const wb = loadSeries(dir, 'VolumeWriteBytes', 'Sum', days);
  const stamps = [...new Set([...ro.keys(), ...wo.keys(), ...rb.keys(), ...wb.keys()])];
  const iops = stamps.map((t) => ((ro.get(t) || 0) + (wo.get(t) || 0)) / 60);
  const mibps = stamps.map((t) => ((rb.get(t) || 0) + (wb.get(t) || 0)) / 60 / 1048576);
  const queueP95 = percentile(queue, 95);
  const iopsP99 = percentile(iops, 99);
  const mibpsP99 = percentile(mibps, 99);
  const needed = Math.round(days * 1440 * coverageMin);
  const coverage = { needed, queue: queue.length, readOps: ro.size, writeOps: wo.size, readBytes: rb.size, writeBytes: wb.size };
  const short = [
    ['VolumeQueueLength', queue.length],
    ['VolumeReadOps', ro.size],
    ['VolumeWriteOps', wo.size],
    ['VolumeReadBytes', rb.size],
    ['VolumeWriteBytes', wb.size],
  ].filter(([, n]) => n < needed);
  const overEither = iops.filter((v, i) => v > baselineIops || mibps[i] > baselineMibps).length;
  const overLimit = stamps.length * overBaselineMax;
  const iopsLimit = headroom * baselineIops;
  const mibpsLimit = headroom * baselineMibps;
  const pct = (x) => `${Math.round(x * 1000) / 10} percent`;
  const gates = [
    {
      name: 'coverage',
      pass: short.length === 0,
      detail: short.length
        ? `only ${short.map(([m, n]) => `${n} ${m}`).join(', ')} one-minute datapoints; need at least ${needed} per series for a ${days}-day decision`
        : `every series has at least ${needed} one-minute datapoints`,
    },
    {
      name: 'queue',
      pass: queueP95 < queueLimit,
      detail:
        queueP95 < queueLimit
          ? `p95 queue length ${queueP95.toFixed(3)} is under ${queueLimit}`
          : `p95 queue length ${queueP95.toFixed(3)} is not under ${queueLimit}; the volume already queues at the current limits, so a lower baseline would add latency`,
    },
    {
      name: 'iops-p99',
      pass: iopsP99 <= iopsLimit,
      detail: `p99 one-minute IOPS ${iopsP99.toFixed(0)} is ${iopsP99 <= iopsLimit ? 'at or under' : 'over'} ${iopsLimit} (${pct(headroom)} of the ${baselineIops} IOPS baseline)`,
    },
    {
      name: 'mibps-p99',
      pass: mibpsP99 <= mibpsLimit,
      detail: `p99 one-minute throughput ${mibpsP99.toFixed(1)} MiB/s is ${mibpsP99 <= mibpsLimit ? 'at or under' : 'over'} ${mibpsLimit} MiB/s (${pct(headroom)} of the ${baselineMibps} MiB/s baseline)`,
    },
    {
      name: 'over-baseline',
      pass: overEither <= overLimit,
      detail: `${overEither} of ${stamps.length} minutes are over ${baselineIops} IOPS or ${baselineMibps} MiB/s; the limit is ${pct(overBaselineMax)} (${overLimit.toFixed(1)} minutes)`,
    },
  ];
  const failed = gates.filter((g) => !g.pass);
  const decision = failed.length ? 'SKIP' : 'REDUCE';
  const reason = failed.length ? failed.map((g) => g.detail).join('; ') : `every gate passed: ${gates.map((g) => g.detail).join('; ')}`;
  return {
    decision,
    reason,
    gates,
    failedGates: failed.map((g) => g.name),
    coverage,
    observedMinutes: stamps.length,
    minutesOverEitherBaseline: overEither,
    minutes: queue.length,
    queueP50: percentile(queue, 50),
    queueP95,
    queueP99: percentile(queue, 99),
    queueMax: queue.length ? Math.max(...queue) : 0,
    iops: {
      mean: mean(iops),
      p95: percentile(iops, 95),
      p99: percentile(iops, 99),
      max: iops.length ? Math.max(...iops) : 0,
      minutesOverBaseline: iops.filter((v) => v > baselineIops).length,
    },
    mibps: {
      mean: mean(mibps),
      p95: percentile(mibps, 95),
      p99: percentile(mibps, 99),
      max: mibps.length ? Math.max(...mibps) : 0,
      minutesOverBaseline: mibps.filter((v) => v > baselineMibps).length,
    },
    baselineIops,
    baselineMibps,
  };
}

const EFS_PRICE = { provisionedPerMibpsMonth: 6.0, elasticReadPerGb: 0.03, elasticWritePerGb: 0.06 };
const GIB = 1073741824;
const MIB = 1048576;

function seriesMin(values) {
  return values.length ? values.reduce((a, b) => (b < a ? b : a), values[0]) : 0;
}

function seriesMax(values) {
  return values.length ? values.reduce((a, b) => (b > a ? b : a), values[0]) : 0;
}

// standardBytes: the file system's Standard-class size. Bursting baseline is 50 KiB/s
// per GiB stored; a file system under 1 TiB bursts to 100 MiB/s while credits last.
// Fail closed: the decision is 'skip' (no mode change offered) unless MeteredIOBytes (Sum),
// BurstCreditBalance (Minimum) and PermittedThroughput (Minimum) each cover at least
// coverageMin of the window's minutes. Credits are the observed balance, never an assumed one.
function efsSummary(dir, { standardBytes, provisionedMibps, days = 7, coverageMin = 0.9 } = {}) {
  const metered = loadSeries(dir, 'MeteredIOBytes', 'Sum', days);
  const credits = loadSeries(dir, 'BurstCreditBalance', 'Minimum', days);
  const permitted = loadSeries(dir, 'PermittedThroughput', 'Minimum', days);
  const sum = (metric) => [...loadSeries(dir, metric, 'Sum', days).values()].reduce((a, b) => a + b, 0);
  const readBytes = sum('DataReadIOBytes');
  const writeBytes = sum('DataWriteIOBytes');
  const metadataBytes = sum('MetadataIOBytes');
  const totalMetered = [...metered.values()].reduce((a, b) => a + b, 0);
  const baselineMibps = (standardBytes / GIB) * 0.05;
  const burstMibps = Math.max(100, (standardBytes / (1024 * GIB)) * 100);
  // Mean over the minutes actually observed, so missing minutes cannot pull it down.
  const meanMibps = metered.size ? totalMetered / (metered.size * 60) / MIB : 0;
  const perMinute = [...metered.values()].map((v) => v / 60 / MIB);
  const maxMinuteMibps = seriesMax(perMinute);
  const p99MinuteMibps = percentile(perMinute, 99);

  const needed = Math.ceil(days * 1440 * coverageMin);
  const coverage = { needed, metered: metered.size, credit: credits.size, permitted: permitted.size };
  const gaps = [
    ['MeteredIOBytes (Sum)', metered.size],
    ['BurstCreditBalance (Minimum)', credits.size],
    ['PermittedThroughput (Minimum)', permitted.size],
  ].filter(([, n]) => n < needed);

  // Observed burst credits, in time order.
  const creditSeries = [...credits.entries()]
    .map(([t, v]) => [Date.parse(t), v])
    .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v))
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
  const creditFirstBytes = creditSeries.length ? creditSeries[0] : 0;
  const creditMinBytes = seriesMin(creditSeries);
  const creditMaxBytes = seriesMax(creditSeries);
  const permittedMinMibps = seriesMin([...permitted.values()]) / MIB;

  // Bursting projection over every minute of the window: start from the observed first-minute
  // balance, earn the baseline, spend metered I/O, never above the highest observed balance.
  let projectedMinBytes = creditFirstBytes;
  if (metered.size) {
    const byMinute = new Map([...metered.entries()].map(([t, v]) => [Math.floor(Date.parse(t) / 60000), v]));
    const minutes = [...byMinute.keys()].filter(Number.isFinite);
    const first = seriesMin(minutes);
    const last = seriesMax(minutes);
    let credit = creditFirstBytes;
    const baselinePerMinute = baselineMibps * MIB * 60;
    for (let m = first; m <= last; m += 1) {
      credit = Math.min(creditMaxBytes, credit + baselinePerMinute - (byMinute.get(m) || 0));
      if (credit < projectedMinBytes) projectedMinBytes = credit;
    }
  }
  const ofMax = (bytes) => (creditMaxBytes > 0 ? (bytes / creditMaxBytes) * 100 : 0);

  const provisionedBilledMibps = Math.max(0, (provisionedMibps || 0) - baselineMibps);
  const provisionedMonthly = provisionedBilledMibps * EFS_PRICE.provisionedPerMibpsMonth;
  const scale = 30 / days;
  // Metadata is counted at the read rate here: an assumption, stated in the report.
  const elasticMonthly = ((readBytes + metadataBytes) / GIB * EFS_PRICE.elasticReadPerGb + (writeBytes / GIB) * EFS_PRICE.elasticWritePerGb) * scale;

  // Every reason bursting would not fit; bursting is offered only when this list is empty.
  const misses = [];
  if (!(meanMibps <= 0.9 * baselineMibps)) misses.push(`mean metered ${meanMibps.toFixed(3)} MiB/s is over 90 percent of the ${baselineMibps.toFixed(3)} MiB/s baseline`);
  if (!(creditMaxBytes > 0)) misses.push('the observed burst credit balance is zero');
  if (!(creditMinBytes >= 0.5 * creditMaxBytes)) misses.push(`the observed credit balance fell to ${ofMax(creditMinBytes).toFixed(1)} percent of its observed maximum (rule: at least 50)`);
  if (!(projectedMinBytes >= 0.5 * creditMaxBytes)) misses.push(`the bursting projection falls to ${ofMax(projectedMinBytes).toFixed(1)} percent of the observed maximum (rule: at least 50)`);
  if (!(maxMinuteMibps <= burstMibps)) misses.push(`the busiest minute (${maxMinuteMibps.toFixed(2)} MiB/s) is over the ${burstMibps.toFixed(0)} MiB/s burst ceiling`);
  let decision = 'keep';
  let reason;
  if (gaps.length) {
    decision = 'skip';
    reason = `not enough evidence: ${gaps.map(([m, n]) => `${m} has ${n} one-minute datapoints`).join('; ')}; need at least ${needed} each (${Math.round(coverageMin * 100)} percent of ${days} days), so no mode change is offered`;
  } else if (misses.length === 0) {
    decision = 'bursting';
    reason = `mean metered ${meanMibps.toFixed(3)} MiB/s is at or under 90 percent of the ${baselineMibps.toFixed(3)} MiB/s bursting baseline, the observed credit balance never fell below ${ofMax(creditMinBytes).toFixed(1)} percent of its ${(creditMaxBytes / 1e12).toFixed(2)} TB maximum, the bursting projection stays at or above ${ofMax(projectedMinBytes).toFixed(1)} percent, and the busiest minute (${maxMinuteMibps.toFixed(2)} MiB/s) is under the ${burstMibps.toFixed(0)} MiB/s burst ceiling`;
  } else if (elasticMonthly < provisionedMonthly) {
    decision = 'elastic';
    reason = `bursting does not fit (${misses.join('; ')}) and elastic (about $${elasticMonthly.toFixed(2)}/month) is cheaper than provisioned (about $${provisionedMonthly.toFixed(2)}/month)`;
  } else {
    reason = `bursting does not fit (${misses.join('; ')}) and elastic (about $${elasticMonthly.toFixed(2)}/month) is not cheaper than provisioned (about $${provisionedMonthly.toFixed(2)}/month)`;
  }
  return {
    decision,
    reason,
    days,
    coverage,
    standardGiB: standardBytes / GIB,
    provisionedMibps: provisionedMibps || 0,
    baselineMibps,
    burstMibps,
    meanMibps,
    p99MinuteMibps,
    maxMinuteMibps,
    creditFirstBytes,
    creditMinBytes,
    creditMaxBytes,
    observedCreditMinPercent: ofMax(creditMinBytes),
    projectedCreditMinPercent: ofMax(projectedMinBytes),
    permittedMinMibps,
    readGiB: readBytes / GIB,
    writeGiB: writeBytes / GIB,
    metadataGiB: metadataBytes / GIB,
    provisionedBilledMibps,
    provisionedMonthly,
    elasticMonthly,
    burstingMonthly: 0,
  };
}

// ---------------------------------------------------------------------------
// ECR
// ---------------------------------------------------------------------------

function parseEcrRef(ref) {
  const m = /^[0-9]+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/([^:@]+)(?::([^@]+))?(?:@(sha256:[0-9a-f]+))?$/.exec(String(ref).trim());
  return m ? { repo: m[1], tag: m[2] || null, digest: m[3] || null } : null;
}

// images: aws ecr describe-images imageDetails. refs: image strings from ECS task definitions.
function computeEcrKeep(repo, imagesInput, refs, { floor = 20, margin = 5, untaggedDays = 7, now = Date.now() } = {}) {
  const images = Array.isArray(imagesInput) ? imagesInput : (imagesInput && imagesInput.imageDetails) || [];
  const wanted = refs.map(parseEcrRef).filter((r) => r && r.repo === repo);
  const isTagged = (img) => Array.isArray(img.imageTags) && img.imageTags.length > 0;
  const pushed = (img) => Date.parse(img.imagePushedAt);
  const tagged = images.filter(isTagged).sort((a, b) => pushed(b) - pushed(a));
  const matches = (img) =>
    wanted.some((r) => (r.digest && r.digest === img.imageDigest) || (r.tag && (img.imageTags || []).includes(r.tag)));
  const inUse = images.filter(matches);
  const unmatchedRefs = wanted.filter(
    (r) => !images.some((img) => (r.digest && r.digest === img.imageDigest) || (r.tag && (img.imageTags || []).includes(r.tag))),
  );
  const blockers = inUse.filter((img) => !isTagged(img)).map((img) => img.imageDigest);
  const ranks = inUse
    .filter(isTagged)
    .map((img) => ({ digest: img.imageDigest, tags: img.imageTags, rank: tagged.findIndex((t) => t.imageDigest === img.imageDigest) + 1 }));
  const refName = (r) => `${r.repo}${r.tag ? `:${r.tag}` : ''}${r.digest ? `@${r.digest}` : ''}`;
  const maxRank = ranks.reduce((m, r) => Math.max(m, r.rank), 0);
  const keep = Math.max(floor, maxRank + margin);
  const cutoff = now - untaggedDays * 86400000;
  const expireTagged = tagged.slice(keep).map((img) => img.imageDigest);
  const expireUntagged = images.filter((img) => !isTagged(img) && pushed(img) < cutoff).map((img) => img.imageDigest);
  const expireSet = new Set([...expireTagged, ...expireUntagged]);
  const expireBytes = images.filter((img) => expireSet.has(img.imageDigest)).reduce((sum, img) => sum + (img.imageSizeInBytes || 0), 0);
  // Fail closed: any one of these refuses the policy. An unmatched ref is an image ECS uses that
  // the inventory cannot see, so its rank (and safety) is unknown.
  const notes = [];
  if (blockers.length > 0) notes.push('an in-use image is untagged and the untagged rule would delete it');
  if (wanted.length === 0) notes.push('no ECS task definition references this repository; refusing to guess what is in use');
  if (unmatchedRefs.length > 0) {
    notes.push(`ECS references ${unmatchedRefs.length} image(s) not found in the repository inventory: ${unmatchedRefs.map(refName).join(', ')}; refusing because their rank is unknown`);
  }
  return {
    repo,
    total: images.length,
    tagged: tagged.length,
    untagged: images.length - tagged.length,
    inUseDigests: inUse.map((img) => img.imageDigest),
    ranks,
    maxRank,
    keep,
    floor,
    margin,
    unmatchedRefs: unmatchedRefs.map(refName),
    blockers,
    ok: notes.length === 0,
    wouldExpire: expireTagged.length + expireUntagged.length,
    wouldExpireTagged: expireTagged.length,
    wouldExpireUntagged: expireUntagged.length,
    expireDigests: [...expireTagged, ...expireUntagged],
    // Sum of reported image sizes. Images share layers, so the real saving is lower: an upper bound.
    wouldExpireBytes: expireBytes,
    note: notes.join('; '),
  };
}

// Approved deletion class h9-7-ecr-* (voice approval 2026-10-23): both rules expire (delete)
// images. keepTagged must come from computeEcrKeep(), which protects every in-use image.
function ecrLifecyclePolicy(keepTagged, untaggedDays = 7) {
  return {
    rules: [
      {
        rulePriority: 1,
        description: `expire untagged images ${untaggedDays} days after push`,
        selection: { tagStatus: 'untagged', countType: 'sinceImagePushed', countUnit: 'days', countNumber: untaggedDays },
        action: { type: 'expire' },
      },
      {
        rulePriority: 2,
        description: `keep the newest ${keepTagged} tagged images`,
        selection: { tagStatus: 'tagged', tagPatternList: ['*'], countType: 'imageCountMoreThan', countNumber: keepTagged },
        action: { type: 'expire' },
      },
    ],
  };
}

// previewResults: aws ecr get-lifecycle-policy-preview output. Returns the in-use digests the
// previewed policy would expire (must be empty before the policy is stored).
function ecrPreviewConflicts(inUseDigests, preview) {
  const rows = (preview && preview.previewResults) || [];
  const protectedSet = new Set(inUseDigests);
  return rows.filter((row) => protectedSet.has(row.imageDigest)).map((row) => row.imageDigest);
}

// keep: computeEcrKeep() output; preview: get-lifecycle-policy-preview output. ok only when the
// keep computation itself was ok and the preview expires no in-use image (fail closed).
function ecrPreviewVerdict(keep, preview) {
  if (!keep || keep.ok !== true) {
    return { ok: false, lines: [`REFUSED keep computation is not ok: ${(keep && keep.note) || 'no keep result'}`] };
  }
  if (!preview || !Array.isArray(preview.previewResults)) {
    return { ok: false, lines: ['REFUSED preview output has no previewResults'] };
  }
  const conflicts = ecrPreviewConflicts(keep.inUseDigests || [], preview);
  if (conflicts.length) return { ok: false, lines: conflicts.map((d) => `CONFLICT in-use image would expire: ${d}`) };
  const expiring = (preview.summary && preview.summary.expiringImageTotalCount) || preview.previewResults.length;
  return { ok: true, lines: [`OK: preview expires ${expiring} images and none of the ${(keep.inUseDigests || []).length} in-use images`] };
}

// ---------------------------------------------------------------------------
// CloudFront
// ---------------------------------------------------------------------------

// Input: aws cloudfront get-distribution-config output. Output: the DistributionConfig with
// only WebACLId cleared, after proving nothing else differs.
function distributionWithoutAcl(getDistributionConfig) {
  const original = getDistributionConfig && getDistributionConfig.DistributionConfig;
  if (!original || typeof original !== 'object') throw new Error('get-distribution-config output has no DistributionConfig');
  const next = clone(original);
  next.WebACLId = '';
  const a = clone(original);
  const b = clone(next);
  delete a.WebACLId;
  delete b.WebACLId;
  if (!sameJson(a, b)) throw new Error('internal error: more than WebACLId differs');
  return { config: next, etag: getDistributionConfig.ETag || '', hadAcl: Boolean(original.WebACLId), previousAcl: original.WebACLId || '' };
}

// ---------------------------------------------------------------------------
// Human-readable text for the shell script
// ---------------------------------------------------------------------------

function fixed(n, d = 1) {
  return Number(n).toFixed(d);
}

function formatEbs(s) {
  return [
    `window: ${s.minutes} one-minute queue datapoints and ${s.observedMinutes} one-minute I/O datapoints over 7 days`,
    `VolumeQueueLength: p50 ${fixed(s.queueP50, 3)}  p95 ${fixed(s.queueP95, 3)}  p99 ${fixed(s.queueP99, 3)}  max ${fixed(s.queueMax, 3)}   (rule: reduce only if p95 < 1.0)`,
    `IOPS (read+write ops per second): mean ${fixed(s.iops.mean, 0)}  p95 ${fixed(s.iops.p95, 0)}  p99 ${fixed(s.iops.p99, 0)}  max ${fixed(s.iops.max, 0)}  minutes over ${s.baselineIops}: ${s.iops.minutesOverBaseline}`,
    `MiB/s (read+write): mean ${fixed(s.mibps.mean)}  p95 ${fixed(s.mibps.p95)}  p99 ${fixed(s.mibps.p99)}  max ${fixed(s.mibps.max)}  minutes over ${s.baselineMibps}: ${s.mibps.minutesOverBaseline}`,
    ...s.gates.map((g) => `gate ${g.name}: ${g.pass ? 'PASS' : 'FAIL'} ${g.detail}`),
    `DECISION: ${s.decision}. ${s.reason}`,
  ];
}

function formatEfs(s) {
  return [
    `standard-class size ${fixed(s.standardGiB, 2)} GiB; mode now provisioned at ${s.provisionedMibps} MiB/s`,
    `bursting baseline = ${fixed(s.standardGiB, 2)} GiB x 0.05 MiB/s per GiB = ${fixed(s.baselineMibps, 3)} MiB/s; burst ceiling ${fixed(s.burstMibps, 0)} MiB/s while credits last`,
    `coverage: MeteredIOBytes ${s.coverage.metered}, BurstCreditBalance ${s.coverage.credit}, PermittedThroughput ${s.coverage.permitted} one-minute datapoints (need at least ${s.coverage.needed} each)`,
    `${s.days}-day metered I/O: mean ${fixed(s.meanMibps, 3)} MiB/s over observed minutes, p99 minute ${fixed(s.p99MinuteMibps, 2)} MiB/s, busiest minute ${fixed(s.maxMinuteMibps, 2)} MiB/s`,
    `volume: reads ${fixed(s.readGiB)} GiB, writes ${fixed(s.writeGiB)} GiB, metadata ${fixed(s.metadataGiB)} GiB`,
    `observed burst credits (BurstCreditBalance Minimum): first ${fixed(s.creditFirstBytes / 1e12, 3)} TB, lowest ${fixed(s.creditMinBytes / 1e12, 3)} TB, highest ${fixed(s.creditMaxBytes / 1e12, 3)} TB; lowest is ${fixed(s.observedCreditMinPercent)} percent of highest (rule: at least 50)`,
    `bursting projection from the observed first balance (baseline earned, metered I/O spent, minute by minute): lowest ${fixed(s.projectedCreditMinPercent)} percent of the observed highest (rule: at least 50)`,
    `PermittedThroughput minimum observed: ${fixed(s.permittedMinMibps, 2)} MiB/s`,
    `cost now (provisioned): billed for the part above the baseline = (${s.provisionedMibps} - ${fixed(s.baselineMibps, 3)}) x $6.00 per MiB/s-month = $${fixed(s.provisionedMonthly, 2)} per month`,
    `cost bursting: $0.00 throughput charge (storage is billed the same in every mode)`,
    `cost elastic: about $${fixed(s.elasticMonthly, 2)} per month (reads and metadata at $0.03 per GB, writes at $0.06 per GB, scaled to 30 days)`,
    `DECISION: ${s.decision}. ${s.reason}`,
  ];
}

function formatEcr(k) {
  const gib = (k.wouldExpireBytes || 0) / GIB;
  return [
    `repository ${k.repo}: ${k.total} images (${k.tagged} tagged, ${k.untagged} untagged)`,
    `in use by ECS (task definitions, services, running tasks): ${k.inUseDigests.length} images; newest-first rank among tagged images: ${k.ranks.map((r) => `${r.tags[0]} = #${r.rank}`).join(', ') || 'none'}`,
    `keep count: max(${k.floor}, deepest in-use rank ${k.maxRank} + ${k.margin} margin) = ${k.keep}`,
    `would expire: ${k.wouldExpire} images (${k.wouldExpireTagged} tagged beyond the newest ${k.keep}, ${k.wouldExpireUntagged} untagged older than 7 days); untagged children of a kept image index are held by ECR until the index goes`,
    `reported size of those images: ${fixed(gib, 1)} GiB, at most $${fixed(gib * 0.1, 2)} per month at $0.10 per GB-month (layers are shared, so the real saving is lower)`,
    k.note ? `NOTE: ${k.note}` : 'safe: every in-use image ranks inside the kept set',
  ];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function pick(obj, field) {
  return field.split('.').reduce((acc, key) => (acc === undefined || acc === null ? acc : acc[key]), obj);
}

function emit(value, argv) {
  const at = argv.indexOf('--field');
  if (at >= 0) {
    const v = pick(value, argv[at + 1]);
    process.stdout.write(`${typeof v === 'object' ? JSON.stringify(v) : String(v)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }
}

function numberOf(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${value}"`);
  return n;
}

function windowFor(n, nowIso, days = 7) {
  const end = Date.parse(nowIso) - (n - 1) * 86400000;
  const start = end - 86400000;
  return `${new Date(start).toISOString().slice(0, 19)}Z ${new Date(end).toISOString().slice(0, 19)}Z`;
}

// Durable plan and receipt records. pairs: key=value strings. command, pre and evidence repeat;
// summary=<file> embeds that decision file. A receipt is complete only when it names the
// command(s) run, the post-state call, a readable post-state and the rollback; the CLI writes it
// either way and exits 1 when it is not complete.
const RECORD_KEYS = new Set(['block', 'mode', 'decision', 'reason', 'summary', 'command', 'pre', 'evidence', 'postCall', 'postFile', 'rollback', 'note']);

function buildRecord(kind, pairs, { now = new Date().toISOString() } = {}) {
  if (kind !== 'plan' && kind !== 'receipt') throw new Error(`record kind must be plan or receipt, got "${kind}"`);
  const fields = {};
  const lists = { command: [], pre: [], evidence: [] };
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) throw new Error(`record field must be key=value, got "${pair}"`);
    const key = pair.slice(0, at);
    const value = pair.slice(at + 1);
    if (!RECORD_KEYS.has(key)) throw new Error(`unknown record field "${key}"`);
    if (key in lists) {
      if (value) lists[key].push(value);
    } else fields[key] = value;
  }
  if (!fields.block) throw new Error('record needs block=<id>');
  const base = { kind, block: fields.block, mode: fields.mode || '', evidenceFiles: lists.evidence };
  if (fields.summary) {
    base.summaryFile = fields.summary;
    try {
      base.summary = readJsonFile(fields.summary);
    } catch (error) {
      base.summaryError = `summary file unreadable: ${error.message}`;
    }
  }
  if (fields.note) base.note = fields.note;
  if (kind === 'plan') {
    return { ...base, plannedAt: now, decision: fields.decision || '', reason: fields.reason || '' };
  }
  let postState = null;
  let postStateError = '';
  if (!fields.postFile) postStateError = 'no post-state file';
  else {
    try {
      const text = fs.readFileSync(fields.postFile, 'utf8').replace(/^﻿/, '');
      try {
        postState = JSON.parse(text);
      } catch {
        postState = text;
      }
      if (postState === null || (typeof postState === 'string' && !postState.trim())) postStateError = 'post-state file is empty';
    } catch (error) {
      postStateError = `post-state file unreadable: ${error.message}`;
    }
  }
  const problems = [];
  if (!lists.command.length) problems.push('no command recorded');
  if (!fields.postCall) problems.push('no post-state call recorded');
  if (postStateError) problems.push(postStateError);
  if (!fields.rollback) problems.push('no rollback command recorded');
  return {
    ...base,
    appliedAt: now,
    commands: lists.command,
    preStateFiles: lists.pre,
    postStateCall: fields.postCall || '',
    postStateFile: fields.postFile || '',
    postState,
    rollback: fields.rollback || '',
    complete: problems.length === 0,
    problems,
  };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'buckets': {
      const account = rest[0];
      if (!account) throw new Error('usage: buckets <account>');
      for (const kind of Object.keys(BUCKETS)) process.stdout.write(`${kind} ${bucketName(kind, account)}\n`);
      return 0;
    }
    case 's3-merge': {
      const merged = mergeLifecycle(readJsonFile(rest[1]), rest[0]);
      for (const w of merged.warnings) process.stderr.write(`WARN ${w}\n`);
      process.stdout.write(`${JSON.stringify(putPayload(merged), null, 2)}\n`);
      return 0;
    }
    case 's3-plan': {
      const current = readJsonFile(rest[1]);
      const merged = mergeLifecycle(current, rest[0]);
      const owned = ownedRules(rest[0]);
      const ownedIds = new Set(owned.map((r) => r.ID));
      process.stdout.write(`existing rules kept unchanged (${merged.Rules.length - owned.length}):\n`);
      for (const line of describeRules(merged.Rules.filter((r) => !ownedIds.has(r.ID)))) process.stdout.write(`  ${line}\n`);
      process.stdout.write(`new transition-only rules (${owned.length}), no expiration of any kind:\n`);
      for (const line of describeRules(owned)) process.stdout.write(`  ${line}\n`);
      for (const w of merged.warnings) process.stdout.write(`WARN ${w}\n`);
      return 0;
    }
    case 's3-diff': {
      const result = diffLifecycle(readJsonFile(rest[1]), readJsonFile(rest[2]), rest[0]);
      if (result.ok) process.stdout.write('OK: every existing rule is unchanged and every new rule is present exactly as sent\n');
      else for (const p of result.problems) process.stdout.write(`PROBLEM: ${p}\n`);
      return result.ok ? 0 : 1;
    }
    case 's3-rollback': {
      process.stdout.write(`${JSON.stringify(rollbackPayload(readJsonFile(rest[1]), rest[0]), null, 2)}\n`);
      return 0;
    }
    case 's3-min-size': {
      process.stdout.write(s3MinSize(readJsonFile(rest[0])) + String.fromCharCode(10));
      return 0;
    }
    case 'cf-restore': {
      const cfg = readJsonFile(rest[0]);
      if (!cfg || !cfg.DistributionConfig) throw new Error('get-distribution-config output has no DistributionConfig');
      process.stdout.write(JSON.stringify(cfg.DistributionConfig, null, 2) + String.fromCharCode(10));
      return 0;
    }
    case 'ecr-preview-check': {
      const verdict = ecrPreviewVerdict(readJsonFile(rest[0]), readJsonFile(rest[1]));
      for (const line of verdict.lines) process.stdout.write(line + String.fromCharCode(10));
      return verdict.ok ? 0 : 1;
    }
    case 'record': {
      const [kind, outFile, ...pairs] = rest;
      if (!outFile) throw new Error('usage: record <plan|receipt> <out.json> key=value...');
      const rec = buildRecord(kind, pairs);
      fs.writeFileSync(outFile, `${JSON.stringify(rec, null, 2)}\n`);
      if (kind === 'receipt' && !rec.complete) {
        process.stderr.write(`INCOMPLETE receipt ${outFile}: ${rec.problems.join('; ')}\n`);
        return 1;
      }
      return 0;
    }
    case 'ebs-text': {
      process.stdout.write(formatEbs(ebsSummary(rest[0])).join(String.fromCharCode(10)) + String.fromCharCode(10));
      return 0;
    }
    case 'efs-text': {
      process.stdout.write(
        formatEfs(efsSummary(rest[0], { standardBytes: numberOf(rest[1], 'standardBytes'), provisionedMibps: numberOf(rest[2], 'provisionedMibps') })).join(String.fromCharCode(10)) + String.fromCharCode(10),
      );
      return 0;
    }
    case 'ecr-text': {
      const [repo, imagesFile, refsFile] = rest;
      const refs = fs.readFileSync(refsFile, 'utf8').split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
      const floor = process.env.ECR_KEEP_FLOOR ? numberOf(process.env.ECR_KEEP_FLOOR, 'ECR_KEEP_FLOOR') : 20;
      const margin = process.env.ECR_KEEP_MARGIN ? numberOf(process.env.ECR_KEEP_MARGIN, 'ECR_KEEP_MARGIN') : 5;
      process.stdout.write(formatEcr(computeEcrKeep(repo, readJsonFile(imagesFile), refs, { floor, margin })).join(String.fromCharCode(10)) + String.fromCharCode(10));
      return 0;
    }
    case 'field': {
      emit(readJsonFile(rest[0]), ['--field', rest[1]]);
      return 0;
    }
    case 'ebs': {
      emit(ebsSummary(rest[0]), rest);
      return 0;
    }
    case 'efs': {
      emit(efsSummary(rest[0], { standardBytes: numberOf(rest[1], 'standardBytes'), provisionedMibps: numberOf(rest[2], 'provisionedMibps') }), rest);
      return 0;
    }
    case 'ecr-keep': {
      const [repo, imagesFile, refsFile] = rest;
      const refs = fs.readFileSync(refsFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const floor = process.env.ECR_KEEP_FLOOR ? numberOf(process.env.ECR_KEEP_FLOOR, 'ECR_KEEP_FLOOR') : 20;
      const margin = process.env.ECR_KEEP_MARGIN ? numberOf(process.env.ECR_KEEP_MARGIN, 'ECR_KEEP_MARGIN') : 5;
      emit(computeEcrKeep(repo, readJsonFile(imagesFile), refs, { floor, margin }), rest);
      return 0;
    }
    case 'ecr-policy': {
      process.stdout.write(`${JSON.stringify(ecrLifecyclePolicy(numberOf(rest[0], 'keep')), null, 2)}\n`);
      return 0;
    }
    case 'cf-drop-acl': {
      const result = distributionWithoutAcl(readJsonFile(rest[0]));
      if (rest[1] === '--etag') process.stdout.write(`${result.etag}\n`);
      else if (rest[1] === '--previous') process.stdout.write(`${result.previousAcl}\n`);
      else process.stdout.write(`${JSON.stringify(result.config, null, 2)}\n`);
      return 0;
    }
    case 'window': {
      process.stdout.write(`${windowFor(numberOf(rest[0], 'n'), rest[1])}\n`);
      return 0;
    }
    default:
      process.stderr.write('commands: field buckets s3-merge s3-plan s3-diff s3-rollback s3-min-size ebs ebs-text efs efs-text ecr-keep ecr-text ecr-policy ecr-preview-check cf-drop-acl cf-restore record window\n');
      return 2;
  }
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ERROR ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  BUCKETS,
  DEEP_ARCHIVE_DAYS,
  EFS_PRICE,
  GIR_DAYS,
  IA_DAYS,
  MIN_OBJECT_SIZE,
  OWNED_PREFIX,
  bucketName,
  buildRecord,
  computeEcrKeep,
  describeRules,
  diffLifecycle,
  distributionWithoutAcl,
  ebsSummary,
  ecrLifecyclePolicy,
  ecrPreviewConflicts,
  ecrPreviewVerdict,
  efsSummary,
  formatEbs,
  formatEcr,
  formatEfs,
  mergeLifecycle,
  overlapWarnings,
  ownedRules,
  parseEcrRef,
  percentile,
  putPayload,
  rollbackPayload,
  s3MinSize,
  validateOwnedRules,
  windowFor,
};
