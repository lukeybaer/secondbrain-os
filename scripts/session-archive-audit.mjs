#!/usr/bin/env node
// session-archive-audit.mjs
//
// ExampleCo 2026-07-18: "I need the other PC to go through the last 300 sessions and
// make sure they're all 100% uploaded... we should have had a health check for
// that, why didn't you catch it? Latest activity from sessions in pc vs.
// reflecting in AWS."
//
// WHY THIS EXISTS (the gap it closes):
//   session-archive-health.mjs only classifies LIVE sessions -- it `continue`s
//   past anything whose transcript mtime is older than 30 min. So a session that
//   ENDED without being fully swept silently drops out of health forever, and
//   nobody ever verifies that finished sessions are 100% uploaded. Worse, that
//   probe reads the spine's own `archive.lastOffset` pointer, which is written
//   BY the sweep -- it is self-referential and makes no AWS call at all. If the
//   sweep never selected a session, there is no pointer and therefore no
//   complaint. That is precisely how 300 sessions can rot unnoticed.
//
// This audit is the opposite: the expected inventory comes from the LOCAL disk
// and the evidence comes from S3 objects. Neither side can vouch for itself.
//
// Design constraints learned from the Codex adversarial review (2026-07-18):
//   - S3 is archive truth, NOT the EC2 session-fts sqlite `parts` table. FTS
//     indexing happens after the S3 put and is deliberately non-blocking, and it
//     skips deltas with no extractable text. A sqlite-based check yields both
//     false red (S3 fine, FTS write failed) and false green (stale row, object
//     deleted or overwritten).
//   - max(byte_end) is NOT coverage. Parts 0-100 and 200-300 give a max end of
//     300 while bytes 100-200 are missing. Coverage must be a contiguous union
//     from byte zero.
//   - BOTH layouts are legitimate completion. The Stop hook and
//     backfill-sessions-to-s3.py write whole files at
//     transcripts/<repo>/<date>/<session>.jsonl; the sweep writes ranges at
//     transcripts/<repo>/<date>/<session>/part-<start>-<end>.jsonl. A parts-only
//     check reports every Stop-hook-archived session as missing.
//   - The same session appears under MULTIPLE date prefixes (verified in the
//     live bucket): the Stop hook re-uploads the whole file at each stop as it
//     grows. Group by session id across all dates and take the max whole size.
//   - A live session is legitimately larger on disk than in S3: the sweep never
//     ships a partial trailing JSONL line. Live sessions get a grace period and
//     are never counted as loss.
//   - Object Size must equal (end - start) for a part, or the upload truncated.
//   - "Newest 300" is a rolling blind spot: a still-missing session becomes #301
//     and vanishes. Anything unresolved is persisted to a durable set and
//     re-checked every run regardless of how old it gets.
//
// Usage:
//   node scripts/session-archive-audit.mjs                  # verify newest 300
//   node scripts/session-archive-audit.mjs --limit 1000     # verify newest 1000
//   node scripts/session-archive-audit.mjs --all            # verify everything
//   node scripts/session-archive-audit.mjs --repair         # upload what's short
//   node scripts/session-archive-audit.mjs --json           # machine readable
//   node scripts/session-archive-audit.mjs --no-receipt     # skip S3 receipt
//
// On completion it publishes a receipt to
//   s3://<bucket>/audits/<host>/latest.json   (and /<jobId>.json)
// so ANOTHER machine can verify this one actually did the work. The receipt is
// what session-coverage-health.mjs consumes. An email or a friendly "done" is
// not a receipt; this is.

import { readFileSync, writeFileSync, statSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const PROJECTS_DIR = process.env.SB_PROJECTS_DIR || path.join(HOME, '.claude', 'projects');
const STATE_DIR = path.join(HOME, '.secondbrain');
const UNRESOLVED_FILE = path.join(STATE_DIR, 'session-audit-unresolved.json');
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

const DEFAULT_LIMIT = 300;
// A session whose transcript changed within this window is still being written.
// The sweep intentionally withholds the trailing partial line, so a shortfall
// here is expected behavior, not data loss.
const LIVE_GRACE_MS = 30 * 60 * 1000;

// ----------------------------- pure helpers (unit-tested) -----------------------------

/**
 * Parse an S3 transcript key into archive evidence.
 * Whole file: transcripts/<repo>/<date>/<sessionId>.jsonl
 * Range part: transcripts/<repo>/<date>/<sessionId>/part-<start>-<end>.jsonl
 * Returns null for anything else (meta/, malformed keys, directory markers).
 */
export function parseTranscriptKey(key) {
  if (typeof key !== 'string') return null;
  const part = key.match(/^transcripts\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/([^/]+)\/part-(\d+)-(\d+)\.jsonl$/);
  if (part) {
    const start = Number(part[4]);
    const end = Number(part[5]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    return { kind: 'part', repo: part[1], date: part[2], sessionId: part[3], start, end };
  }
  const whole = key.match(/^transcripts\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/([^/]+)\.jsonl$/);
  if (whole) {
    return { kind: 'whole', repo: whole[1], date: whole[2], sessionId: whole[3] };
  }
  return null;
}

/**
 * Merge [start,end) ranges and return the contiguous span reachable from byte 0.
 * Deliberately NOT max(end): a gap must stop the count dead, because bytes after
 * a hole are unrecoverable context even though they exist in the bucket.
 * Returns { contiguousEnd, gaps } where gaps are the holes before the last byte.
 */
export function contiguousCoverage(ranges) {
  const sorted = [...ranges].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  let end = 0;
  const gaps = [];
  for (const r of sorted) {
    if (r.start > end) {
      gaps.push([end, r.start]);
      break; // everything past the first hole is unreachable; stop counting
    }
    if (r.end > end) end = r.end;
  }
  return { contiguousEnd: end, gaps };
}

/**
 * Classify one session's archive state from S3 evidence vs the local file.
 *
 * objects: [{ kind:'whole'|'part', size, start?, end? }]  (size = S3 object Size)
 * localSize: bytes on disk right now
 *
 * States:
 *   sealed  - a whole-file object at least as large as local (Stop hook / backfill)
 *   covered - contiguous range parts from byte 0 through localSize
 *   short   - some evidence, but a gap or a shortfall
 *   missing - no evidence at all
 *
 * A part whose object Size !== (end - start) is a truncated upload and is
 * discarded rather than trusted; that is a silent-corruption path the old
 * offset-pointer check could never see.
 */
export function coverageForSession(objects, localSize) {
  const list = Array.isArray(objects) ? objects : [];
  if (list.length === 0) {
    return { state: 'missing', verifiedBytes: 0, localSize, gaps: [], reason: 'no S3 objects' };
  }
  const wholes = list.filter((o) => o.kind === 'whole');
  const bestWhole = wholes.reduce((m, o) => Math.max(m, Number(o.size) || 0), 0);
  if (bestWhole >= localSize && localSize > 0) {
    return { state: 'sealed', verifiedBytes: bestWhole, localSize, gaps: [], reason: 'whole-file object' };
  }
  const parts = list.filter((o) => o.kind === 'part');
  const intact = parts.filter((o) => Number(o.size) === o.end - o.start);
  const truncated = parts.length - intact.length;
  const { contiguousEnd, gaps } = contiguousCoverage(intact);
  const verifiedBytes = Math.max(contiguousEnd, bestWhole);
  if (verifiedBytes >= localSize && localSize > 0) {
    return { state: 'covered', verifiedBytes, localSize, gaps: [], reason: 'contiguous parts' };
  }
  if (verifiedBytes <= 0) {
    return {
      state: 'missing',
      verifiedBytes: 0,
      localSize,
      gaps,
      reason: truncated ? `${truncated} truncated part(s), nothing usable` : 'no usable coverage from byte 0',
    };
  }
  const shortfall = localSize - verifiedBytes;
  return {
    state: 'short',
    verifiedBytes,
    localSize,
    gaps,
    reason: gaps.length
      ? `gap at byte ${gaps[0][0]}, ${shortfall} bytes unverified`
      : `${shortfall} bytes never uploaded`,
  };
}

/**
 * Roll per-session results into a status + detail line.
 * Live sessions are reported but never drive red: the sweep withholds the
 * trailing partial line by design, so a live shortfall is not loss.
 * Anything finished and not sealed/covered is a defect, full stop.
 */
export function summarizeAudit(results) {
  const counts = { total: 0, sealed: 0, covered: 0, short: 0, missing: 0, live: 0 };
  const unresolved = [];
  for (const r of results) {
    counts.total++;
    if (r.live) {
      counts.live++;
      continue; // graced, not counted as complete or defective
    }
    if (r.state === 'sealed') counts.sealed++;
    else if (r.state === 'covered') counts.covered++;
    else {
      if (r.state === 'short') counts.short++;
      else counts.missing++;
      unresolved.push({ sessionId: r.sessionId, repo: r.repo, state: r.state, reason: r.reason });
    }
  }
  const complete = counts.sealed + counts.covered;
  const broken = counts.short + counts.missing;
  const status = broken > 0 ? 'red' : 'green';
  const detail =
    `${counts.total} sessions audited: ${complete} verified on S3, ${counts.missing} missing, ` +
    `${counts.short} partial, ${counts.live} live (graced)`;
  return { status, detail, counts, unresolved };
}

/** Newest-first census entries, plus any durably unresolved id regardless of age. */
export function selectAuditSet(census, unresolvedIds, limit) {
  const byRecency = [...census].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const picked = byRecency.slice(0, limit);
  const have = new Set(picked.map((c) => c.sessionId));
  // Sessions still unresolved from a previous run never age out of the audit.
  for (const c of byRecency.slice(limit)) {
    if (unresolvedIds.has(c.sessionId) && !have.has(c.sessionId)) {
      picked.push(c);
      have.add(c.sessionId);
    }
  }
  return picked;
}

// ----------------------------- side-effecting runtime -----------------------------

/**
 * Resolve the AWS CLI. ExampleCoYPC has aws.exe installed but NOT on the PATH that a
 * spawned shell inherits, which would make every `aws` call fail with ENOENT and
 * this auditor lie by omission. Fail loud instead: probe the known install
 * locations and error if none work.
 */
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

function aws(bin, args, timeout = 120000) {
  return spawnSync(bin, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
}

function sessionsBucket(bin) {
  if (process.env.SECONDBRAIN_SESSIONS_BUCKET) return process.env.SECONDBRAIN_SESSIONS_BUCKET;
  const cacheFile = path.join(STATE_DIR, 'sessions-bucket');
  const acct = aws(bin, ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], 30000);
  const id = (acct.stdout || '').trim();
  if (id) return `secondbrain-sessions-${id}-${REGION}`;
  try {
    const cached = readFileSync(cacheFile, 'utf8').trim();
    if (cached) return cached;
  } catch {
    /* no cache */
  }
  return null;
}

/** Recursively count nested transcripts (subagent / workflow runs) under a slug. */
function countNestedTranscripts(dir) {
  let n = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.isDirectory()) n += countNestedTranscripts(path.join(dir, e.name));
    else if (e.name.endsWith('.jsonl')) n++;
  }
  return n;
}

/**
 * Walk local transcripts. The repo slug is the directory name Claude Code uses.
 *
 * Scope note (deliberate, and REPORTED rather than silent): only top-level
 * <slug>/<sessionId>.jsonl files are sessions. Nested files under
 * <slug>/<sessionId>/subagents/... are subagent and workflow transcripts, which
 * neither the sweep nor the Stop hook has ever archived. Counting them here
 * would flood the audit red for a gap this script does not fix, but hiding them
 * would repeat the exact sin this whole file exists to correct. So they are
 * counted and surfaced in the receipt as a known uncovered class.
 */
function localCensus() {
  const out = [];
  let nestedExcluded = 0;
  if (!existsSync(PROJECTS_DIR)) return { sessions: out, nestedExcluded };
  for (const slug of readdirSync(PROJECTS_DIR)) {
    const dir = path.join(PROJECTS_DIR, slug);
    let files;
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      const p = path.join(dir, f);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        nestedExcluded += countNestedTranscripts(p);
        continue;
      }
      if (!f.endsWith('.jsonl') || !st.isFile()) continue;
      out.push({
        sessionId: f.replace(/\.jsonl$/, ''),
        slug,
        file: p,
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  }
  return { sessions: out, nestedExcluded };
}

/**
 * Walk every page of a ListObjectsV2 result and group evidence by session id.
 *
 * `fetchPage(continuationToken)` returns the parsed s3api response body. Kept
 * injectable so pagination is unit-testable without AWS -- the bug below shipped
 * precisely because this logic had no test.
 *
 * THE 2026-07-18 FALSE-RED BUG (why this is written so defensively):
 *   The first version passed `--max-keys 1000` and then advanced on
 *   `body.NextToken`. That field only exists when the CLI paginates for you via
 *   `--max-items`. With `--max-keys` the API returns `IsTruncated` +
 *   `NextContinuationToken` instead, so `NextToken` was always undefined, the
 *   loop exited after ONE page, and the audit saw 1000 of 10416 objects. Every
 *   session outside that first page was reported "no S3 objects" -- 291 of 300
 *   on the machine ExampleCo ran it on, all of them false, and `--repair` would have
 *   re-uploaded them for nothing.
 *
 *   A verifier that silently sees less than the truth is worse than no verifier:
 *   it burns the credibility of every real red it will ever report. So this now
 *   fails CLOSED. If the response says truncated but hands back no token, we
 *   throw rather than return a partial picture that would read as data loss.
 */
export function collectEvidence(fetchPage, opts = {}) {
  const maxPages = opts.maxPages || 5000;
  const bySession = new Map();
  let token = null;
  let pages = 0;
  let objects = 0;
  do {
    const body = fetchPage(token) || {};
    for (const obj of body.Contents || []) {
      objects++;
      const meta = parseTranscriptKey(obj.Key);
      if (!meta) continue;
      const entry = {
        kind: meta.kind,
        size: Number(obj.Size) || 0,
        start: meta.start,
        end: meta.end,
        key: obj.Key,
        lastModified: obj.LastModified,
      };
      if (!bySession.has(meta.sessionId)) bySession.set(meta.sessionId, []);
      bySession.get(meta.sessionId).push(entry);
    }
    pages++;
    const truncated = body.IsTruncated === true;
    const next = body.NextContinuationToken || body.NextToken || null;
    if (truncated && !next) {
      throw new Error(
        `s3 list reported IsTruncated with no continuation token after ${pages} page(s); ` +
          `refusing to audit against a partial object listing`,
      );
    }
    token = truncated ? next : null;
  } while (token && pages < maxPages);
  if (token) {
    throw new Error(`s3 list still truncated after ${maxPages} pages; refusing to audit partial evidence`);
  }
  bySession.set('__meta__', { pages, objects });
  return bySession;
}

/** One fully paginated ListObjectsV2 over transcripts/, grouped by session id. */
function s3Evidence(bin, bucket) {
  return collectEvidence((token) => {
    const args = [
      's3api', 'list-objects-v2',
      '--bucket', bucket,
      '--prefix', 'transcripts/',
      '--max-keys', '1000',
      '--output', 'json',
    ];
    // ListObjectsV2 resumes with --continuation-token. NOT --starting-token,
    // which belongs to the CLI's own --max-items paginator and is ignored here.
    if (token) args.push('--continuation-token', token);
    const r = aws(bin, args, 180000);
    if (r.status !== 0) {
      throw new Error(`s3 list failed: ${(r.stderr || '').trim().slice(0, 300)}`);
    }
    try {
      return JSON.parse(r.stdout || '{}');
    } catch (e) {
      throw new Error(`s3 list returned unparseable JSON: ${e.message}`);
    }
  });
}

function loadUnresolved() {
  try {
    const j = JSON.parse(readFileSync(UNRESOLVED_FILE, 'utf8'));
    return new Set(Array.isArray(j.sessionIds) ? j.sessionIds : []);
  } catch {
    return new Set();
  }
}

function saveUnresolved(ids) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(UNRESOLVED_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), sessionIds: [...ids] }, null, 2));
  } catch {
    /* best effort */
  }
}

function sha256(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/** Upload the whole transcript, matching the Stop hook's key layout exactly. */
function repairSession(bin, bucket, entry) {
  const date = new Date(entry.mtimeMs).toISOString().slice(0, 10);
  const repo = entry.slug.replace(/^C--Users-[^-]+-/, '').replace(/^.*-/, '') || entry.slug;
  const key = `transcripts/${repo}/${date}/${entry.sessionId}.jsonl`;
  const r = aws(bin, ['s3', 'cp', entry.file, `s3://${bucket}/${key}`, '--sse', 'AES256'], 300000);
  return { ok: r.status === 0, key, error: r.status === 0 ? null : (r.stderr || '').trim().slice(0, 200) };
}

function publishReceipt(bin, bucket, receipt) {
  const tmp = path.join(os.tmpdir(), `sb-audit-${receipt.jobId}.json`);
  writeFileSync(tmp, JSON.stringify(receipt, null, 2));
  const host = receipt.host;
  const ok1 = aws(bin, ['s3', 'cp', tmp, `s3://${bucket}/audits/${host}/${receipt.jobId}.json`, '--sse', 'AES256'], 60000);
  const ok2 = aws(bin, ['s3', 'cp', tmp, `s3://${bucket}/audits/${host}/latest.json`, '--sse', 'AES256'], 60000);
  return ok1.status === 0 && ok2.status === 0;
}

export function runAudit(opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const limit = opts.all ? Infinity : (opts.limit || DEFAULT_LIMIT);
  const bin = awsBin();
  if (!bin) throw new Error('aws CLI not found (set SB_AWS_BIN); refusing to report health without evidence');
  const bucket = opts.bucket || sessionsBucket(bin);
  if (!bucket) throw new Error('cannot resolve sessions bucket; refusing to report health without evidence');

  const { sessions: census, nestedExcluded } = localCensus();
  const unresolvedIds = loadUnresolved();
  const audit = selectAuditSet(census, unresolvedIds, limit);
  const evidence = s3Evidence(bin, bucket);
  const evidenceMeta = evidence.get('__meta__') || { pages: 0, objects: 0 };

  const results = [];
  for (const c of audit) {
    const cov = coverageForSession(evidence.get(c.sessionId) || [], c.size);
    results.push({
      sessionId: c.sessionId,
      repo: c.slug,
      live: nowMs - c.mtimeMs <= LIVE_GRACE_MS,
      mtime: new Date(c.mtimeMs).toISOString(),
      ...cov,
    });
  }

  const repaired = [];
  if (opts.repair) {
    for (const r of results) {
      if (r.live || r.state === 'sealed' || r.state === 'covered') continue;
      const entry = audit.find((c) => c.sessionId === r.sessionId);
      if (!entry) continue;
      const rep = repairSession(bin, bucket, entry);
      repaired.push({ sessionId: r.sessionId, ...rep });
      if (rep.ok) {
        r.state = 'sealed';
        r.verifiedBytes = entry.size;
        r.reason = 'repaired: whole-file upload';
        r.repairedKey = rep.key;
        r.sha256 = sha256(entry.file);
      }
    }
  }

  const summary = summarizeAudit(results);
  // Lag must compare like with like. A live session is deliberately excluded
  // from "verified" (the sweep withholds its trailing partial line), so counting
  // it as local activity would make every machine with an open session look
  // permanently behind. Both sides here are FINISHED sessions only.
  const finished = results.filter((r) => !r.live);
  const newestLocal = finished.reduce((m, r) => Math.max(m, Date.parse(r.mtime) || 0), 0);
  const newestArchived = finished.reduce(
    (m, r) => (r.state === 'sealed' || r.state === 'covered' ? Math.max(m, Date.parse(r.mtime) || 0) : m),
    0,
  );

  const receipt = {
    jobId: opts.jobId || `audit-${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}`,
    // SB_AUDIT_HOST makes the identity explicit rather than derived. The
    // accountability registry (audits/expected-hosts.json) must name the same
    // string the auditing machine publishes under, or a host could "report"
    // under a name nobody is watching and stay invisible while looking healthy.
    host: (opts.host || process.env.SB_AUDIT_HOST || os.hostname()).toLowerCase(),
    completedAt: new Date().toISOString(),
    bucket,
    limit: opts.all ? 'all' : limit,
    localSessionsTotal: census.length,
    audited: results.length,
    // Known uncovered class, surfaced so it can never read as "all uploaded".
    subagentTranscriptsExcluded: nestedExcluded,
    // How much evidence this verdict rests on. Published because the 2026-07-18
    // false-red came from silently reading one page: a receipt claiming
    // hundreds of missing sessions off a single page of objects is self-evidently
    // untrustworthy, and now you can see that from the receipt alone.
    s3ListPages: evidenceMeta.pages,
    s3ListObjects: evidenceMeta.objects,
    s3DistinctSessions: evidence.size - 1, // minus the __meta__ entry
    counts: summary.counts,
    unresolved: summary.unresolved.length,
    unresolvedSample: summary.unresolved.slice(0, 25),
    repaired: repaired.length,
    repairFailures: repaired.filter((r) => !r.ok).length,
    // Finished-session activity vs finished-session archive coverage.
    newestLocalActivity: newestLocal ? new Date(newestLocal).toISOString() : null,
    newestVerifiedArchive: newestArchived ? new Date(newestArchived).toISOString() : null,
    // Reported separately so a machine that is busy right now is visible without
    // being mistaken for a machine that is failing to upload.
    newestLocalActivityIncludingLive: results.reduce(
      (m, r) => { const t = Date.parse(r.mtime) || 0; return t > m ? t : m; }, 0,
    ) ? new Date(results.reduce((m, r) => { const t = Date.parse(r.mtime) || 0; return t > m ? t : m; }, 0)).toISOString() : null,
    status: summary.status,
    detail: summary.detail,
  };

  saveUnresolved(new Set(summary.unresolved.map((u) => u.sessionId)));
  // `null` (skipped) must stay distinguishable from `false` (tried and failed):
  // the health probe treats false as red, and skipped must not masquerade as ok.
  receipt.receiptPublished = opts.noReceipt ? null : publishReceipt(bin, bucket, receipt);

  return { ...summary, receipt, results, repaired };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const limitArg = argv.indexOf('--limit');
  const hostArg = argv.indexOf('--host');
  const opts = {
    all: argv.includes('--all'),
    repair: argv.includes('--repair'),
    noReceipt: argv.includes('--no-receipt'),
    limit: limitArg >= 0 ? Number(argv[limitArg + 1]) : DEFAULT_LIMIT,
    // --host pins the identity the receipt publishes under. The scheduled task
    // passes it explicitly so a machine's receipt always lands under the name
    // the accountability registry is watching, rather than whatever
    // os.hostname() happens to return after a rename or reimage.
    host: hostArg >= 0 ? argv[hostArg + 1] : undefined,
  };
  try {
    const r = runAudit(opts);
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ status: r.status, detail: r.detail, counts: r.counts, receipt: r.receipt, unresolved: r.unresolved }, null, 2));
    } else {
      console.log(`[session-archive-audit] ${r.status.toUpperCase()}: ${r.detail}`);
      if (r.repaired.length) console.log(`  repaired ${r.repaired.filter((x) => x.ok).length}/${r.repaired.length}`);
      for (const u of r.unresolved.slice(0, 20)) console.log(`  ${u.state.padEnd(7)} ${u.sessionId.slice(0, 8)} ${u.repo}: ${u.reason}`);
      if (r.unresolved.length > 20) console.log(`  ...and ${r.unresolved.length - 20} more`);
      if (r.receipt.subagentTranscriptsExcluded) {
        console.log(`  note: ${r.receipt.subagentTranscriptsExcluded} subagent/workflow transcripts are NOT archived by any pipeline (known gap, out of scope here)`);
      }
      const pub = r.receipt.receiptPublished;
      console.log(`  receipt: s3://${r.receipt.bucket}/audits/${r.receipt.host}/latest.json (${pub === null ? 'skipped (--no-receipt)' : `published=${pub}`})`);
    }
    process.exit(r.status === 'red' ? 1 : 0);
  } catch (e) {
    // Fail closed and loud. An auditor that cannot see AWS must never print green.
    console.error(`[session-archive-audit] FAILED: ${e.message}`);
    process.exit(2);
  }
}
