#!/usr/bin/env node
// session-coverage-health.mjs
//
// ExampleCo 2026-07-18: "we should have had a health check for that, why didn't you
// catch it? Latest activity from sessions in pc vs. reflecting in AWS."
//
// THE FAILURE THIS EXISTS TO CATCH, stated plainly: a machine stops uploading
// its finished sessions and nothing anywhere goes red.
//
// The critical design point (Codex, 2026-07-18): a coverage check that only
// audits the LOCAL disk cannot detect this. ExampleCoYPC has 24 local transcripts;
// the backlog ExampleCo is angry about lives on the OLD PC. A local-only audit here
// would be perfectly green while every old-PC session was absent, because S3
// cannot enumerate sessions that were never uploaded -- absence of a file is
// invisible unless someone who HAS the file says it should be there.
//
// So the contract is two-sided:
//   1. Every machine runs session-archive-audit.mjs against its OWN disk and
//      publishes a signed-by-existence receipt to s3://<bucket>/audits/<host>/latest.json.
//   2. This probe reads those receipts and holds every EXPECTED host accountable.
//
// An expected host that stops publishing goes RED here. That is the whole point:
// silence from a machine is a defect, not a green. The expected-host set is
// durable (audits/expected-hosts.json in the bucket, plus SB_EXPECTED_HOSTS),
// so a host going permanently dark can never be quietly forgotten -- which is
// exactly the "no hosts reporting, nothing to check, green" trap that let the
// old PC rot.
//
// Usage: node scripts/session-coverage-health.mjs [--json]

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

// A machine that has not audited itself in this long is not trustworthy.
const STALE_RECEIPT_MS = 26 * 60 * 60 * 1000; // 26h: one daily run may slip, two may not
// Gap between a host's newest local session activity and its newest verified
// archive. Beyond this the machine is writing sessions it is not uploading.
const LAG_YELLOW_MS = 6 * 60 * 60 * 1000;
const LAG_RED_MS = 24 * 60 * 60 * 1000;

// ----------------------------- pure helpers (unit-tested) -----------------------------

/**
 * Judge one host's receipt.
 * Order matters: absence and staleness outrank content, because a stale receipt
 * reporting "0 unresolved" is a claim about a world that no longer exists.
 */
export function judgeHost(host, receipt, nowMs, opts = {}) {
  const staleMs = opts.staleMs ?? STALE_RECEIPT_MS;
  const lagYellowMs = opts.lagYellowMs ?? LAG_YELLOW_MS;
  const lagRedMs = opts.lagRedMs ?? LAG_RED_MS;

  if (!receipt) {
    return { host, status: 'red', reason: 'never published an audit receipt' };
  }
  const completed = Date.parse(receipt.completedAt || '');
  if (!Number.isFinite(completed)) {
    return { host, status: 'red', reason: 'receipt has no valid completedAt' };
  }
  const ageMs = nowMs - completed;
  if (ageMs > staleMs) {
    return { host, status: 'red', reason: `last audited ${Math.round(ageMs / 3600000)}h ago (stale)`, ageMs };
  }
  if (receipt.receiptPublished === false) {
    return { host, status: 'red', reason: 'audit ran but could not publish its receipt', ageMs };
  }
  const unresolved = Number(receipt.unresolved) || 0;
  if (unresolved > 0) {
    return {
      host,
      status: 'red',
      reason: `${unresolved} session(s) not fully uploaded`,
      ageMs,
      unresolved,
    };
  }
  if (Number(receipt.repairFailures) > 0) {
    return { host, status: 'red', reason: `${receipt.repairFailures} repair upload(s) failed`, ageMs };
  }
  // Local activity vs what AWS actually reflects -- ExampleCo's literal ask.
  const newestLocal = Date.parse(receipt.newestLocalActivity || '');
  const newestArchived = Date.parse(receipt.newestVerifiedArchive || '');
  if (Number.isFinite(newestLocal) && Number.isFinite(newestArchived)) {
    const lagMs = newestLocal - newestArchived;
    if (lagMs > lagRedMs) {
      return { host, status: 'red', reason: `newest session is ${Math.round(lagMs / 3600000)}h ahead of AWS`, ageMs, lagMs };
    }
    if (lagMs > lagYellowMs) {
      return { host, status: 'yellow', reason: `newest session is ${Math.round(lagMs / 3600000)}h ahead of AWS`, ageMs, lagMs };
    }
  }
  const audited = Number(receipt.audited) || 0;
  return { host, status: 'green', reason: `${audited} sessions verified on S3`, ageMs, audited };
}

/** Worst status wins. Silence from an expected host is red, never green. */
export function summarizeCoverageHealth(expectedHosts, receiptsByHost, nowMs, opts = {}) {
  const hosts = [...new Set(expectedHosts)].sort();
  if (hosts.length === 0) {
    // No expected hosts is itself a broken configuration, not a clean bill.
    return {
      status: 'yellow',
      detail: 'no expected hosts registered — coverage cannot be verified',
      hosts: [],
    };
  }
  const judged = hosts.map((h) => judgeHost(h, receiptsByHost[h], nowMs, opts));
  const red = judged.filter((j) => j.status === 'red');
  const yellow = judged.filter((j) => j.status === 'yellow');
  const status = red.length ? 'red' : yellow.length ? 'yellow' : 'green';
  const problems = [...red, ...yellow];
  const detail = problems.length
    ? problems.map((j) => `${j.host}: ${j.reason}`).join('; ')
    : `${judged.length} host(s) fully uploaded: ` + judged.map((j) => `${j.host} (${j.reason})`).join(', ');
  return { status, detail, hosts: judged };
}

// ----------------------------- side-effecting runtime -----------------------------

function awsBin() {
  if (process.env.SB_AWS_BIN) return process.env.SB_AWS_BIN;
  const candidates = [
    'aws',
    'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe',
    'C:\\Program Files (x86)\\Amazon\\AWSCLIV2\\aws.exe',
    path.join(HOME, 'AppData', 'Local', 'Programs', 'Amazon', 'AWSCLIV2', 'aws.exe'),
    '/usr/local/bin/aws',
    '/usr/bin/aws',
  ];
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 20000 });
    if (r.status === 0) return c;
  }
  return null;
}

function aws(bin, args, timeout = 90000) {
  return spawnSync(bin, args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
}

function sessionsBucket(bin) {
  if (process.env.SECONDBRAIN_SESSIONS_BUCKET) return process.env.SECONDBRAIN_SESSIONS_BUCKET;
  const acct = aws(bin, ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], 30000);
  const id = (acct.stdout || '').trim();
  if (id) return `secondbrain-sessions-${id}-${REGION}`;
  try {
    return readFileSync(path.join(HOME, '.secondbrain', 'sessions-bucket'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function s3GetJson(bin, bucket, key) {
  const tmp = path.join(os.tmpdir(), `sb-${key.replace(/[^\w.-]/g, '_')}`);
  const r = aws(bin, ['s3', 'cp', `s3://${bucket}/${key}`, tmp, '--quiet'], 60000);
  if (r.status !== 0) return null;
  try {
    return JSON.parse(readFileSync(tmp, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Expected hosts = the durable registry in the bucket, union any host that has
 * ever published, union SB_EXPECTED_HOSTS. Union, never intersection: a host
 * must not be able to remove itself from accountability by going silent.
 */
function expectedHosts(bin, bucket, seen) {
  const set = new Set(seen);
  const reg = s3GetJson(bin, bucket, 'audits/expected-hosts.json');
  for (const h of (reg && reg.hosts) || []) set.add(h);
  for (const h of (process.env.SB_EXPECTED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean)) set.add(h);
  return [...set];
}

export function probeSessionCoverage(nowMs = Date.now()) {
  const bin = awsBin();
  if (!bin) return { status: 'yellow', detail: 'aws CLI not found — coverage unverifiable', hosts: [] };
  const bucket = sessionsBucket(bin);
  if (!bucket) return { status: 'yellow', detail: 'cannot resolve sessions bucket — coverage unverifiable', hosts: [] };

  const ls = aws(bin, ['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', 'audits/', '--output', 'json'], 90000);
  const seen = new Set();
  if (ls.status === 0) {
    try {
      for (const o of JSON.parse(ls.stdout || '{}').Contents || []) {
        const m = String(o.Key).match(/^audits\/([^/]+)\/latest\.json$/);
        if (m) seen.add(m[1]);
      }
    } catch {
      /* fall through to registry */
    }
  }
  const hosts = expectedHosts(bin, bucket, seen);
  const receipts = {};
  for (const h of hosts) receipts[h] = s3GetJson(bin, bucket, `audits/${h}/latest.json`);
  return summarizeCoverageHealth(hosts, receipts, nowMs);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const r = probeSessionCoverage(Date.now());
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`[session-coverage-health] ${r.status.toUpperCase()}: ${r.detail}`);
    for (const h of r.hosts || []) console.log(`  ${h.status.padEnd(6)} ${h.host}: ${h.reason}`);
  }
  process.exit(r.status === 'red' ? 1 : 0);
}
