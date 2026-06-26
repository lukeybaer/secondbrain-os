#!/usr/bin/env node
// session-sweep.mjs
//
// ExampleCo 2026-06-14: store ALL raw session transcripts on AWS continuously, driven
// by the spine, not just at session end. Every 10 min this sweep:
//   Layer 0  reads the spine for live sessions (by updatedAt recency, NOT the
//            noisy `status` flag), reads each transcript delta since a stored
//            byte offset, uploads the delta to S3 as an idempotent offset-range
//            part, then writes an archive pointer back INTO the spine task.
//   Layer 1  summarizes the delta into a Graphiti checkpoint episode (stable
//            name session:{id}:ckpt:{seq} so re-runs supersede, not duplicate).
//
// Crash-safety (Codex flagged this as the one unrecoverable risk):
//   - never ship a partial trailing line (trim to last newline),
//   - S3 key is the byte RANGE (part-{start}-{end}) so a retry overwrites the
//     same object instead of creating a duplicate,
//   - advance the spine offset ONLY after the S3 put confirms.
//
// The existing Stop hook (archive-session-to-s3.sh) remains the final sweep.
// The verbatim FTS index (Layer 2) lives on EC2 and is fed separately.
//
// Usage: node scripts/session-sweep.mjs [--dry] [--session <id>]

import { readFileSync, writeFileSync, statSync, existsSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const TASKS_DIR =
  process.env.SECONDBRAIN_TASKS_DIR ||
  path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'secondbrain', 'data', 'tasks');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const GRAPHITI_CLI = path.join(here, 'graphiti-cli.mjs');
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

const LIVE_WINDOW_MS = 20 * 60 * 1000; // updatedAt within 20 min => live
const HEALTHY_MS = 25 * 60 * 1000; // archived within 25 min => healthy
const STALE_MS = 30 * 60 * 1000; // live but archive >30 min old => disconnected
// Selection window: archive any session whose TRANSCRIPT was written recently.
// Transcript mtime is the ground truth of activity; the spine `updatedAt` goes
// stale during a long single turn (the hook only fires per prompt/stop), so a
// mid-turn session would otherwise be missed. Older sessions were already
// archived at their clean Stop, so this also avoids backfilling 1500+ historicals.
const SELECT_WINDOW_MS = 30 * 60 * 1000;

// ----------------------------- pure helpers (unit-tested) -----------------------------

/** Take only complete lines from a delta buffer; never ship a partial last line. */
export function takeCompleteLines(newBytes) {
  const buf = Buffer.isBuffer(newBytes) ? newBytes : Buffer.from(String(newBytes));
  if (buf.length === 0) return { text: '', bytes: 0 };
  const lastNl = buf.lastIndexOf(0x0a); // '\n'
  if (lastNl < 0) return { text: '', bytes: 0 };
  const slice = buf.subarray(0, lastNl + 1);
  return { text: slice.toString('utf8'), bytes: slice.length };
}

/** Idempotent, crash-safe S3 part key: the byte RANGE, so a retry overwrites. */
export function partKey(repo, date, sessionId, startOffset, endOffset) {
  return `transcripts/${repo}/${date}/${sessionId}/part-${startOffset}-${endOffset}.jsonl`;
}

/** Liveness from updatedAt recency. NEVER the `status` flag (flips done each Stop). */
export function isLive(task, nowMs, liveWindowMs = LIVE_WINDOW_MS) {
  const t = Date.parse((task && (task.updatedAt || task.startedAt)) || '');
  return Number.isFinite(t) && nowMs - t <= liveWindowMs;
}

/**
 * Classify a session's archival health. Never uses `status`.
 *   disconnected: live but nothing archived, or archive pointer far stale
 *   fully-swept : not live and the offset caught up to the file size
 *   archiving   : live and archived recently (healthy)
 *   caught-up   : live and offset == size right now
 *   lagging     : everything else (behind, needs the next sweep)
 */
export function classifySession(task, transcriptSize, nowMs, opts = {}) {
  const liveWindowMs = opts.liveWindowMs ?? LIVE_WINDOW_MS;
  const healthyMs = opts.healthyMs ?? HEALTHY_MS;
  const staleMs = opts.staleMs ?? STALE_MS;
  const archive = (task && task.archive) || {};
  const lastOffset = archive.lastOffset ?? 0;
  const lastArchivedAt = Date.parse(archive.lastArchivedAt || '');
  const updated = Date.parse((task && (task.updatedAt || task.startedAt)) || '');
  const live = Number.isFinite(updated) && nowMs - updated <= liveWindowMs;
  const archivedSomething = (Array.isArray(archive.parts) ? archive.parts.length : 0) > 0 || lastOffset > 0;
  const caughtUp = transcriptSize >= 0 && lastOffset >= transcriptSize;

  if (live && !archivedSomething) return 'disconnected';
  if (live && Number.isFinite(lastArchivedAt) && nowMs - lastArchivedAt > staleMs) return 'disconnected';
  if (!live && caughtUp && archivedSomething) return 'fully-swept';
  if (live && caughtUp) return 'caught-up';
  if (Number.isFinite(lastArchivedAt) && nowMs - lastArchivedAt <= healthyMs) return 'archiving';
  return 'lagging';
}

/** Build a Graphiti checkpoint episode body from a transcript delta (capped). */
export function buildCheckpointEpisode(sessionId, repo, seq, deltaText, prompts = []) {
  const recentPrompt = prompts.length ? prompts[prompts.length - 1] : '';
  const head = `Claude Code session ${sessionId.slice(0, 8)} (${repo}) checkpoint ${seq}.` +
    (recentPrompt ? ` Latest user request: ${String(recentPrompt).slice(0, 300)}.` : '');
  // Pull human-readable text out of the JSONL delta, cap for Graphiti's extractor.
  const body = (head + '\n\n' + extractReadable(deltaText)).slice(0, 5000);
  return { name: `session:${sessionId}:ckpt:${seq}`, body, source: 'session-checkpoint' };
}

function extractReadable(jsonl) {
  const out = [];
  for (const line of String(jsonl).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      const role = o.role || (o.message && o.message.role) || o.type;
      let text = '';
      const content = (o.message && o.message.content) ?? o.content;
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) text = content.map((c) => (typeof c === 'string' ? c : c.text || '')).join(' ');
      if (text) out.push(`${role || '?'}: ${text}`);
    } catch {
      /* skip non-JSON lines */
    }
  }
  return out.join('\n').slice(0, 4500);
}

// ----------------------------- IO orchestration (not unit-tested) -----------------------------

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listSpineSessions() {
  if (!existsSync(TASKS_DIR)) return [];
  return readdirSync(TASKS_DIR)
    .filter((f) => f.startsWith('spine-session-') && f.endsWith('.json'))
    .map((f) => ({ file: path.join(TASKS_DIR, f), task: readJson(path.join(TASKS_DIR, f)) }))
    .filter((x) => x.task && x.task.sessionId);
}

/** Find a session's transcript jsonl regardless of the project-slug encoding. */
function findTranscript(sessionId) {
  if (!existsSync(PROJECTS_DIR)) return null;
  for (const slug of readdirSync(PROJECTS_DIR)) {
    const p = path.join(PROJECTS_DIR, slug, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

function sessionsBucket() {
  if (process.env.SECONDBRAIN_SESSIONS_BUCKET) return process.env.SECONDBRAIN_SESSIONS_BUCKET;
  // Cache the resolved bucket so a transient `sts` failure never stalls a sweep
  // (this runs every 10 min). Resolve once, reuse forever, refresh only if sts
  // succeeds with a new value.
  const cacheFile = path.join(HOME, '.secondbrain', 'sessions-bucket');
  const acct = spawnSync('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  const id = (acct.stdout || '').trim();
  if (id) {
    const bucket = `secondbrain-sessions-${id}-${REGION}`;
    try {
      mkdirSync(path.dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, bucket);
    } catch {
      /* cache write is best-effort */
    }
    return bucket;
  }
  // sts failed: fall back to the cached value if we resolved it before.
  try {
    const cached = readFileSync(cacheFile, 'utf8').trim();
    if (cached) return cached;
  } catch {
    /* no cache yet */
  }
  return null;
}

function s3PutText(bucket, key, text) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  const tmpFile = path.join(tmp, 'part.jsonl');
  try {
    writeFileSync(tmpFile, text);
    const r = spawnSync('aws', ['s3', 'cp', tmpFile, `s3://${bucket}/${key}`, '--sse', 'AES256'], {
      encoding: 'utf8',
      timeout: 60000,
    });
    return r.status === 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function graphitiCheckpoint(ep) {
  const r = spawnSync(
    process.execPath,
    [GRAPHITI_CLI, 'add', '--name', ep.name, '--body', ep.body, '--source', ep.source],
    { encoding: 'utf8', timeout: 45000 },
  );
  return /(^|\n)ok\b/.test(r.stdout || ''); // trust the ok marker, not exit code (Windows libuv exit crash)
}

const EC2_HOST = process.env.SB_EC2_HOST || 'ec2-user@ExampleCo';
const EC2_KEY = process.env.SB_EC2_KEY || path.join(HOME, '.ssh', 'sb-key.pem');
const EC2_FTS = process.env.SB_EC2_FTS_SCRIPT || '/opt/secondbrain/scripts/session-fts.py';
const EC2_FTS_DB = process.env.SB_EC2_FTS_DB || '/opt/secondbrain/data/session-fts.sqlite';

// Layer 2 transport: push the readable delta text into the EC2 verbatim FTS
// index over SSH stdin. Best-effort, so a down host never blocks Layer 0. SSH
// stdin (not argv) ExampleCos the body, so arbitrary/large text is safe; the small
// argv values (uuid, repo basename, ints, iso ts) are controlled. This is why
// the only ec2-server.js change for Layer 2 is the read path, not an ingest API.
function ftsIndexDelta({ sessionId, repo, start, end, ts, readable }) {
  if (!readable || !readable.trim()) return false;
  const remote =
    `python3 ${EC2_FTS} --db ${EC2_FTS_DB} index --session ${sessionId} ` +
    `--repo ${repo} --start ${start} --end ${end} --ts ${ts}`;
  const r = spawnSync(
    'ssh',
    ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', '-i', EC2_KEY, EC2_HOST, remote],
    { input: readable, encoding: 'utf8', timeout: 30000 },
  );
  try {
    const o = JSON.parse(r.stdout || '{}');
    return o.indexed === true || o.reason === 'duplicate-range';
  } catch {
    return false;
  }
}

function repoFromCwd(cwd) {
  return path.basename(String(cwd || 'ExampleCo').replace(/[\\/]+$/, '')) || 'ExampleCo';
}

function sweepSession(entry, bucket, nowIso, dry) {
  const { file, task, transcript } = entry;
  if (!transcript) return { sessionId: task.sessionId, skipped: 'no-transcript' };

  const size = statSync(transcript).size;
  const archive = task.archive || { lastOffset: 0, parts: [], seq: 0 };
  const lastOffset = archive.lastOffset || 0;
  if (size <= lastOffset) return { sessionId: task.sessionId, skipped: 'no-new-bytes' };

  const full = readFileSync(transcript);
  const newBytes = full.subarray(lastOffset);
  const { text, bytes } = takeCompleteLines(newBytes);
  if (bytes === 0) return { sessionId: task.sessionId, skipped: 'only-partial-line' };

  const repo = repoFromCwd(task.execution && task.execution.cwd);
  const date = nowIso.slice(0, 10);
  const start = lastOffset;
  const end = lastOffset + bytes;
  const seq = (archive.seq || 0) + 1;
  const key = partKey(repo, date, task.sessionId, start, end);

  if (dry) {
    return { sessionId: task.sessionId, wouldUpload: key, bytes, seq };
  }

  // 1) raw delta to S3 FIRST. Only advance the spine offset if this confirms.
  const put = s3PutText(bucket, key, text);
  if (!put) return { sessionId: task.sessionId, error: 's3-put-failed', key };

  // 2) advance the spine archive pointer. Re-read first so we merge onto any
  //    prompts the hook appended during the upload, narrowing the read-modify-
  //    write race on this shared file (hook and sweep both write it). Worst case
  //    of a lost race is a redundant re-upload next sweep (idempotent offset-range
  //    keys overwrite), never data loss.
  const fresh = readJson(file) || task;
  const freshParts = (fresh.archive && fresh.archive.parts) || archive.parts || [];
  fresh.archive = {
    s3Prefix: `transcripts/${repo}/${date}/${task.sessionId}/`,
    lastOffset: end,
    seq,
    parts: [...freshParts, key].slice(-200),
    lastArchivedAt: nowIso,
    bucket,
  };
  writeFileSync(file, JSON.stringify(fresh, null, 2));

  // 3) Graphiti checkpoint (semantic freshness). Best-effort; never blocks Layer 0.
  let graphiti = false;
  try {
    const ep = buildCheckpointEpisode(task.sessionId, repo, seq, text, (task.meta && task.meta.prompts) || []);
    graphiti = graphitiCheckpoint(ep);
  } catch {
    graphiti = false;
  }

  // 4) Verbatim FTS (Layer 2): index the readable delta on EC2. Best-effort.
  let fts = false;
  try {
    fts = ftsIndexDelta({
      sessionId: task.sessionId,
      repo,
      start,
      end,
      ts: nowIso,
      readable: extractReadable(text),
    });
  } catch {
    fts = false;
  }

  return { sessionId: task.sessionId, uploaded: key, bytes, seq, graphiti, fts };
}

function main() {
  const dry = process.argv.includes('--dry');
  const onlyIdx = process.argv.indexOf('--session');
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);

  const bucket = dry ? '(dry)' : sessionsBucket();
  if (!dry && !bucket) {
    console.error('[session-sweep] cannot resolve S3 bucket (no SECONDBRAIN_SESSIONS_BUCKET, sts failed)');
    process.exit(1);
  }

  const all = listSpineSessions();
  // Select by transcript-mtime recency (truth of activity), not the spine status
  // flag and not solely the spine updatedAt (which goes stale mid-turn).
  const live = [];
  for (const e of all) {
    if (only && e.task.sessionId !== only) continue;
    const transcript = findTranscript(e.task.sessionId);
    if (!transcript) continue;
    const mtime = statSync(transcript).mtimeMs;
    const spineUpdated = Date.parse(e.task.updatedAt || e.task.startedAt || '') || 0;
    const recency = Math.max(mtime, spineUpdated);
    if (only || nowMs - recency <= SELECT_WINDOW_MS) live.push({ ...e, transcript });
  }
  const results = [];
  for (const entry of live) {
    try {
      results.push(sweepSession(entry, bucket, nowIso, dry));
    } catch (e) {
      results.push({ sessionId: entry.task.sessionId, error: (e && e.message) || 'ExampleCo' });
    }
  }

  const up = results.filter((r) => r.uploaded || r.wouldUpload).length;
  const err = results.filter((r) => r.error).length;
  console.log(
    `[session-sweep] ${dry ? 'DRY ' : ''}live=${live.length}/${all.length} archived=${up} errors=${err}`,
  );
  for (const r of results) console.log('  ', JSON.stringify(r));
  if (err > 0 && up === 0 && live.length > 0) process.exit(1);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
