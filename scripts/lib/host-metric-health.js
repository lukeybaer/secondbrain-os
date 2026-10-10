'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { writeJsonAtomic } = require('./briefing-cards/card-format');
const { releaseShaFromPhysicalRoot } = require('./release-identity');
const { graphitiIngestionAdmission } = require('./graphiti-ingestion-policy');
const { evaluatePm2FleetHealth } = require('./pm2-fleet-verdict');
const { freeSpaceStatus } = require('./storage-pressure-maintenance');
const ROOT = path.resolve(__dirname, '../..');
const MAX_AGE_MS = 8 * 60 * 1000;
const GATEWAY = 'graphiti-subscription-gateway';
const REQUIRED = [
  'secondbrain-backend',
  ...require('./atomic-release-transaction').DEFAULT_PM2_FOLLOWERS.split(/\s+/),
].filter((name) => name !== GATEWAY);
// Open SSH logins above this count are a leak. Normal operation holds a handful;
// on 2026-10-03 one client held 4,870 open and they filled swap.
const SSH_SESSION_LIMIT = 300;
const SSH_FACT_KEYS = ['established', 'maxPerSource', 'sources'];
const hash = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function receiptPath(dataDir, metric) {
  if (!['ec2-disk', 'backend-pm2-fleet', 'ec2-ssh-sessions'].includes(metric))
    throw new Error('Unknown host metric');
  return path.join(dataDir, 'agent', `host-metric-${metric}.json`);
}
// Counts established sshd sockets from `ss -tnH state established` output
// (Recv-Q, Send-Q, local, peer). Only counts leave this function: the peer
// address is used to group sockets and is never stored or shown.
function countSshSessions(raw) {
  const perSource = new Map();
  for (const line of String(raw).split('\n')) {
    if (!line.trim()) continue;
    const peerColumn = line.trim().split(/\s+/)[3] || '';
    const split = peerColumn.lastIndexOf(':');
    if (split <= 0 || !/^\d+$/.test(peerColumn.slice(split + 1))) throw new Error('Invalid ss evidence');
    const source = peerColumn.slice(0, split).replace(/^\[|\]$/g, '');
    perSource.set(source, (perSource.get(source) || 0) + 1);
  }
  const counts = [...perSource.values()];
  return {
    established: counts.reduce((sum, count) => sum + count, 0),
    sources: counts.length,
    maxPerSource: Math.max(0, ...counts),
  };
}
function physicalSha(root) {
  try {
    return releaseShaFromPhysicalRoot(fs.realpathSync(root));
  } catch {
    return '';
  }
}
function verdict(metric, facts, now) {
  if (metric === 'ec2-disk') {
    const f = facts || {};
    if (
      !Number.isInteger(f.usedPercent) ||
      f.usedPercent < 0 ||
      f.usedPercent > 100 ||
      !Number.isFinite(f.totalKb) ||
      f.totalKb <= 0 ||
      !Number.isFinite(f.availableKb) ||
      f.availableKb < 0 ||
      !Number.isFinite(f.usedKb) ||
      f.usedKb < 0 ||
      f.usedKb > f.totalKb ||
      f.availableKb > f.totalKb ||
      !f.mount ||
      f.usedPercent !== Math.ceil((100 * f.usedKb) / (f.usedKb + f.availableKb))
    )
      throw new Error('Invalid df evidence');
    // Use the same absolute free-space safety floor as the storage-pressure
    // maintenance authority. A percentage-only threshold becomes misleading
    // when the gp3 volume grows: 90% used on the current 180 GiB volume still
    // leaves more safe headroom than 85% used did on the former 100 GiB volume.
    const capacity = freeSpaceStatus(f.availableKb * 1024);
    return {
      status: capacity.status === 'green' ? 'green' : 'red',
      detail: `${f.usedPercent}% used of ${(f.totalKb / 1048576).toFixed(1)} GiB; ${(f.availableKb / 1048576).toFixed(1)} GiB available (${f.mount}).`,
    };
  }
  if (metric === 'ec2-ssh-sessions') {
    const f = facts || {};
    const counts = SSH_FACT_KEYS.map((key) => f[key]);
    if (
      Object.keys(f).sort().join(',') !== SSH_FACT_KEYS.join(',') ||
      counts.some((n) => !Number.isInteger(n) || n < 0) ||
      f.sources > f.established ||
      f.maxPerSource > f.established ||
      (f.established > 0) !== (f.sources > 0) ||
      f.maxPerSource * f.sources < f.established
    )
      throw new Error('Invalid ss evidence');
    return {
      status: f.established <= SSH_SESSION_LIMIT ? 'green' : 'red',
      detail: `${f.established} open SSH logins from ${f.sources} ${f.sources === 1 ? 'source' : 'sources'}, at most ${f.maxPerSource} from one source; red above ${SSH_SESSION_LIMIT}.`,
    };
  }
  if (
    !facts ||
    !Array.isArray(facts.procs) ||
    !facts.procs.length ||
    typeof facts.ownerDisabled !== 'boolean' ||
    !Array.isArray(facts.recentIncidents)
  )
    throw new Error('Invalid fleet evidence');
  if (
    facts.procs.some(
      (p) =>
        !p ||
        typeof p.name !== 'string' ||
        !p.name ||
        !p.pm2_env ||
        typeof p.pm2_env.status !== 'string' ||
        !Number.isInteger(p.pm2_env.unstable_restarts) ||
        p.pm2_env.unstable_restarts < 0,
    )
  )
    throw new Error('Incomplete PM2 live facts');
  const excluded = facts.procs.filter(
    (p) => p.name === GATEWAY && p.pm2_env.status === 'stopped' && facts.ownerDisabled,
  );
  const procs = facts.procs.filter((p) => !excluded.includes(p));
  const missing = REQUIRED.filter((name) => !procs.some((p) => p.name === name));
  if (!facts.ownerDisabled && !procs.some((p) => p.name === GATEWAY)) missing.push(GATEWAY);
  const age = Number(now) - facts.guardTs;
  const guardHeartbeat = {
    ok:
      Number.isFinite(facts.guardTs) &&
      facts.guardTs > 0 &&
      Number.isFinite(age) &&
      age >= 0 &&
      age <= MAX_AGE_MS,
    note: ' Storm guard heartbeat missing, stale, or future-dated.',
  };
  const result = evaluatePm2FleetHealth({
    procs,
    guardHeartbeat,
    recentIncidents: facts.recentIncidents,
    now: Number(now),
  });
  return {
    status: result.glyph === 'ok' && !missing.length ? 'green' : 'red',
    detail:
      result.text +
      (missing.length ? ` Missing required services: ${missing.join(', ')}.` : '') +
      (excluded.length ? ` ${GATEWAY} intentionally stopped under owner OFF policy.` : ''),
  };
}
function collectHostMetric({
  metric,
  dataDir,
  repoRoot = ROOT,
  now = new Date(),
  sourceSha,
  run = execFileSync,
} = {}) {
  const file = receiptPath(dataDir, metric);
  let receipt = {
    schemaVersion: 1,
    metric,
    checkedAt: new Date(now).toISOString(),
    sourceSha: sourceSha || physicalSha(repoRoot),
  };
  try {
    if (!receipt.sourceSha)
      receipt.sourceSha = run('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 10000,
      }).trim();
    if (!/^[a-f0-9]{40}$/.test(receipt.sourceSha)) throw new Error('Unproved release identity');
    let facts;
    if (metric === 'ec2-disk') {
      const raw = run('df', ['-Pk', '/opt/secondbrain'], { encoding: 'utf8', timeout: 8000 });
      const c = raw.trim().split('\n').pop().trim().split(/\s+/);
      facts = {
        filesystem: c[0],
        totalKb: Number(c[1]),
        usedKb: Number(c[2]),
        availableKb: Number(c[3]),
        usedPercent: /^\d+%$/.test(c[4]) ? Number(c[4].slice(0, -1)) : NaN,
        mount: c[5],
      };
    } else if (metric === 'ec2-ssh-sessions') {
      // Full path because cron's PATH has no /usr/sbin. No sudo and no -p:
      // counting sockets needs neither root nor process owners.
      facts = countSshSessions(
        run('/usr/sbin/ss', ['-tnH', 'state', 'established', '( sport = :22 )'], {
          encoding: 'utf8',
          timeout: 8000,
          maxBuffer: 64 * 1024 * 1024,
        }),
      );
    } else {
      const procs = JSON.parse(
        run('pm2', ['jlist'], { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 }),
      );
      let guardTs = null;
      try {
        guardTs = Number(
          JSON.parse(fs.readFileSync(path.join(dataDir, 'agent', 'pm2-storm-state.json'), 'utf8'))
            .ts,
        );
      } catch {}
      let recentIncidents = [];
      try {
        recentIncidents = fs
          .readFileSync(path.join(dataDir, 'agent', 'pm2-storm-incidents.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .slice(-50)
          .flatMap((line) => {
            try {
              const e = JSON.parse(line);
              const t = new Date(e.ts).getTime();
              return t <= Number(now) && t >= Number(now) - 86400000 && Array.isArray(e.incidents)
                ? [e]
                : [];
            } catch {
              return [];
            }
          });
      } catch {}
      facts = {
        procs: procs.map((p) => ({
          name: p.name,
          pm2_env: {
            status: p.pm2_env?.status,
            unstable_restarts: p.pm2_env?.unstable_restarts,
            pm_uptime: p.pm2_env?.pm_uptime,
          },
        })),
        guardTs,
        recentIncidents,
        ownerDisabled: graphitiIngestionAdmission({
          policyPath: path.join(repoRoot, 'config', 'graphiti-runtime-policy.json'),
        }).ownerDisabled,
      };
    }
    receipt = { ...receipt, facts, inputDigest: hash(facts), ...verdict(metric, facts, now) };
  } catch (error) {
    receipt = {
      ...receipt,
      status: 'red',
      detail: `${metric} source proof failed: ${String(error.message).slice(0, 240)}`,
    };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, receipt);
  return receipt;
}
function readHostMetric({
  metric,
  dataDir,
  repoRoot = ROOT,
  now = new Date(),
  sourceSha = physicalSha(repoRoot),
} = {}) {
  const failed = (reason) => ({
    status: 'red',
    detail: `${metric} source proof unavailable: ${reason}.`,
  });
  try {
    const r = JSON.parse(fs.readFileSync(receiptPath(dataDir, metric), 'utf8'));
    const age = Number(now) - Date.parse(r.checkedAt);
    if (
      r.schemaVersion !== 1 ||
      r.metric !== metric ||
      !sourceSha ||
      r.sourceSha !== sourceSha ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > MAX_AGE_MS
    )
      return failed('wrong release, stale, or future receipt');
    if (!r.facts || r.inputDigest !== hash(r.facts))
      return failed('missing or corrupt measured facts');
    return { ...r, ...verdict(metric, r.facts, now) };
  } catch {
    return failed('missing or invalid receipt');
  }
}
/**
 * Read the metric, and re-measure first when the stored receipt cannot be
 * trusted.
 *
 * A receipt is valid for MAX_AGE_MS (8 minutes) and only against the release
 * that wrote it. Both renderers call readHostMetric at RENDER time, while the
 * receipt is written back at card-REFRESH time, so any gap longer than eight
 * minutes between the two, or any release swap in between, turns a perfectly
 * healthy disk or fleet into "source proof unavailable: wrong release, stale,
 * or future receipt". That is not a measurement of anything. Measured on
 * 2026-09-16: the 04:05:30Z collect was rendered and QC'd at 04:38:51Z, 33
 * minutes later, so EC2 disk reported a defect while sitting at 25.4 GiB free
 * against a 15 GiB floor, and Backend PM2 fleet reported one with all seven
 * services online. Each deploy and each reboot re-reddened both rows the same
 * way, three times in one attended session.
 *
 * Re-measuring here is cheap and side-effect free: one `df`, `pm2 jlist` or
 * `ss`, each sub-second, through the same collector the source contract
 * already calls. A genuinely measured red still renders red, because the
 * verdict is computed from the fresh facts exactly as before.
 */
function readOrCollectHostMetric({
  metric,
  dataDir,
  repoRoot = ROOT,
  now = new Date(),
  sourceSha,
  collect = collectHostMetric,
  read = readHostMetric,
} = {}) {
  const args = { metric, dataDir, repoRoot, now };
  const first = read({ ...args, ...(sourceSha ? { sourceSha } : {}) });
  if (first && first.status === 'green') return first;
  // Only a provenance or freshness failure is worth re-measuring. A measured
  // red is a real answer and must not be retried into a different one.
  if (!/source proof (unavailable|failed)/i.test(String(first && first.detail))) return first;
  try {
    collect({ ...args, ...(sourceSha ? { sourceSha } : {}) });
  } catch {
    return first;
  }
  return read({ ...args, ...(sourceSha ? { sourceSha } : {}) });
}

module.exports = {
  collectHostMetric,
  readHostMetric,
  readOrCollectHostMetric,
  receiptPath,
  verdict,
  MAX_AGE_MS,
  REQUIRED,
  SSH_SESSION_LIMIT,
};
