#!/usr/bin/env node
// session-sweep.mjs
//
// Provider-neutral continuous session producer. Every two minutes it discovers
// recent Claude main/subagent transcripts and Codex rollouts, writes complete
// raw deltas to S3, durably queues normalized visible activity events, and asks
// the EC2 session cloud plane to commit them. The cloud plane owns the canonical
// activity projection, exact search, Graphiti projection, and receipts consumed
// by chat and the morning briefing.
//
// Crash-safety (Codex flagged this as the one unrecoverable risk):
//   - never ship a partial trailing line (trim to last newline),
//   - S3 key is the byte RANGE (part-{start}-{end}) so a retry overwrites the
//     same object instead of creating a duplicate,
//   - advance the producer offset only after S3 confirms and the cloud event is
//     durable in the local outbox,
//   - advance the Spine cloud pointer only after the EC2 commit receipt returns.
//
// The existing Stop hook (archive-session-to-s3.sh) remains the final sweep.
// The verbatim FTS index (Layer 2) lives on EC2 and is fed separately.
//
// Usage: node scripts/session-sweep.mjs [--dry] [--session <id>] [--reconcile-cloud-pending]

import { readFileSync, writeFileSync, statSync, existsSync, readdirSync, mkdtempSync, mkdirSync, rmSync, renameSync, openSync, readSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from './lib/invoked-directly.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  buildEventsFromDelta,
  buildReceiptConfirmedEvent,
  defaultClaudeProjectsDir,
  defaultCodexSessionsDir,
  discoverSessionSources,
  scrubDerivedText,
  sessionDigestFromFile,
  sha256,
} = require('./lib/session-source-adapters.js');
const {
  drainSessionEventOutbox,
  countPendingSessionEvents,
  enqueueSessionEvent,
  listPendingSessionEvents,
} = require('./lib/session-event-outbox.js');
const { readArchiveReceipt } = require('./lib/session-archive-receipt.js');
const { existingSessionRecordFile, withSessionRecordLock, writeSessionRecord } = require('./lib/desktop-session-registry.js');
const { acquireSessionSweepLease } = require('./lib/session-sweep-lease.js');
const { appendRunLog } = require('./lib/session-sweep-run-log.js');
const HOME = os.homedir();
const DATA_DIR =
  process.env.SECONDBRAIN_DATA_DIR ||
  path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'secondbrain', 'data');
const TASKS_DIR =
  process.env.SECONDBRAIN_TASKS_DIR ||
  path.join(DATA_DIR, 'tasks');
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const PRODUCER_ROOT = path.join(DATA_DIR, 'agent', 'session-cloud-sources');
const PRODUCER_HEARTBEAT = path.join(DATA_DIR, 'agent', 'session-cloud-producer-local.json');
const SESSION_CLOUD_BATCH_SIZE = Math.max(1, Math.min(100, Math.floor(Number(process.env.SESSION_CLOUD_BATCH_SIZE)) || 100));
// Oct 26 2026: a 60s admission budget delivered about 100 events per run, so a 6,200-event
// backlog stalled and later took 140 runs to drain. The owner (2026-10-27): one run must be able to
// deliver up to 30,000 events. Delivery is durable per event and per batch, so the run budget
// can be long and a kill at the task time limit loses and repeats nothing. Each call rewrites the
// cloud projection once, so batches of 100 (MAX_INGEST_BATCH_SIZE) cut that cost fivefold.
export const SESSION_CLOUD_RUN_EVENT_LIMIT = 30_000;
const SESSION_CLOUD_DRAIN_ADMISSION_MS = 20 * 60_000; // first pass, before scanning sources
const SESSION_CLOUD_FINAL_DRAIN_ADMISSION_MS = 40 * 60_000; // second pass, after scanning
// The scheduled task's execution limit is PT90M (register-session-sweep-task.ps1); the two
// passes admit new batches for at most 60 minutes, leaving room for one 55s batch and cleanup.

// Deploy-order safety (peer review F2): landing promotes this PC runtime before EC2 is deployed,
// and a cloud still on the old 20-event ceiling rejects a 100-event batch with a definitive
// "session ingest batch must contain 1-20 events". The PC offers 100, learns the cloud's ceiling
// from that rejection, re-splits the same events at the ceiling, and keeps the ceiling for the
// rest of the run. The rejection names no event and is never a delivery failure.
const OVERSIZED_BATCH_PATTERN = /session ingest batch must contain 1-(\d+) events/;
const cloudBatchState = { size: SESSION_CLOUD_BATCH_SIZE, fellBackTo: null };

export function createCloudBatchState(size = SESSION_CLOUD_BATCH_SIZE) {
  return { size, fellBackTo: null };
}

export async function sendCloudBatchNegotiated(events, send, state = cloudBatchState, { onFallback } = {}) {
  const results = [];
  let index = 0;
  while (index < events.length) {
    const chunk = events.slice(index, index + state.size);
    const response = await send(chunk);
    const ceiling = response && response.ok === false
      ? Number(String(response.reason || '').match(OVERSIZED_BATCH_PATTERN)?.[1])
      : NaN;
    if (Number.isFinite(ceiling) && ceiling >= 1 && ceiling < chunk.length) {
      state.size = ceiling;
      state.fellBackTo = ceiling;
      if (typeof onFallback === 'function') onFallback(ceiling);
      continue;
    }
    if (!response || response.ok !== true || !Array.isArray(response.results)) return response;
    results.push(...response.results);
    index += chunk.length;
  }
  return { ok: true, results };
}

// Re-discovers sources, queues whatever was appended since the last look, and returns the CURRENT
// newest-source boundary (peer review F4). A long drain keeps calling this so the heartbeat never
// vouches for the boundary frozen at run start.
export function refreshSourceSnapshot({ discover, sweepOne, withBoundary, results = [] }) {
  const sources = discover();
  for (const source of sources) {
    try {
      results.push(sweepOne(source));
    } catch (e) {
      results.push({ provider: source.provider, sessionId: source.session_id, source: source.source_kind, error: (e && e.message) || 'unknown' });
    }
  }
  const providers = sources.reduce((counts, source) => {
    counts[source.provider] = (counts[source.provider] || 0) + 1;
    return counts;
  }, {});
  const latestDiscovered = selectLatestSource(sources);
  const latestSource = latestDiscovered ? withBoundary(latestDiscovered) : null;
  return { sources, providers, latestSource, latestSourceAt: latestSource?.updated_at || null };
}

export function sessionCloudDrainOptions({ delivered = 0, final = false } = {}) {
  return {
    batchSize: SESSION_CLOUD_BATCH_SIZE,
    admissionBudgetMs: final ? SESSION_CLOUD_FINAL_DRAIN_ADMISSION_MS : SESSION_CLOUD_DRAIN_ADMISSION_MS,
    limit: Math.max(1, SESSION_CLOUD_RUN_EVENT_LIMIT - Math.max(0, Number(delivered) || 0)),
  };
}
const SESSION_CLOUD_HEARTBEAT_CADENCE_MS = 60_000;
const RUN_LOG = path.join(DATA_DIR, 'agent', 'session-sweep-run-log.jsonl');
const AUTO_RECONCILE_STAMP = path.join(DATA_DIR, 'agent', 'session-receipt-auto-reconcile.json');

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

// ----------------------------- IO orchestration -----------------------------

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function atomicWriteJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

function sourceStateFile(sourceId) {
  return path.join(PRODUCER_ROOT, `${sha256(sourceId).slice(0, 32)}.json`);
}

function readSourceState(sourceId) {
  return readJson(sourceStateFile(sourceId)) || {
    schema: 'amy.session_source_state.v1',
    source_id: sourceId,
    queued_offset: 0,
    last_offset: 0,
    active_activity_id: '',
    last_terminal_activity_id: '',
  };
}

function writeSourceState(sourceId, update) {
  const current = readSourceState(sourceId);
  const next = { ...current, ...update, schema: 'amy.session_source_state.v1', source_id: sourceId };
  atomicWriteJson(sourceStateFile(sourceId), next);
  return next;
}

function discoveryWindow(nowMs) {
  const prior = readJson(PRODUCER_HEARTBEAT);
  const priorMs = Date.parse(prior?.observed_at || '');
  if (!Number.isFinite(priorMs)) return SELECT_WINDOW_MS;
  return Math.max(SELECT_WINDOW_MS, Math.min(30 * 24 * 60 * 60 * 1000, nowMs - priorMs + 5 * 60 * 1000));
}

let resolvedAwsBin;
function awsBin() {
  if (resolvedAwsBin !== undefined) return resolvedAwsBin;
  const candidates = [
    process.env.SB_AWS_BIN,
    'aws',
    'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe',
    'C:\\Program Files (x86)\\Amazon\\AWSCLIV2\\aws.exe',
    path.join(HOME, 'AppData', 'Local', 'Programs', 'Amazon', 'AWSCLIV2', 'aws.exe'),
  ].filter(Boolean);
  resolvedAwsBin = candidates.find((candidate) => {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    return probe.status === 0;
  }) || null;
  return resolvedAwsBin;
}

function sessionsBucket() {
  if (process.env.SECONDBRAIN_SESSIONS_BUCKET) return process.env.SECONDBRAIN_SESSIONS_BUCKET;
  // Cache the resolved bucket so a transient `sts` failure never stalls a sweep
  // (this runs every 10 min). Resolve once, reuse forever, refresh only if sts
  // succeeds with a new value.
  const cacheFile = path.join(HOME, '.secondbrain', 'sessions-bucket');
  const bin = awsBin();
  const acct = bin ? spawnSync(bin, ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  }) : { stdout: '' };
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
  const bin = awsBin();
  if (!bin) return { ok: false, reason: 'AWS CLI unavailable' };
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  const tmpFile = path.join(tmp, 'part.jsonl');
  try {
    writeFileSync(tmpFile, text);
    const digest = sha256(text);
    const checksumSha256 = Buffer.from(digest, 'hex').toString('base64');
    const bytes = Buffer.byteLength(text);
    const r = spawnSync(bin, [
      's3api', 'put-object', '--bucket', bucket, '--key', key, '--body', tmpFile,
      '--region', REGION, '--server-side-encryption', 'AES256',
      '--checksum-algorithm', 'SHA256', '--checksum-sha256', checksumSha256,
    ], {
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
    });
    if (r.status !== 0) return { ok: false, reason: String(r.stderr || 's3 put failed').slice(0, 500) };
    const head = spawnSync(bin, [
      's3api', 'head-object', '--bucket', bucket, '--key', key,
      '--region', REGION, '--checksum-mode', 'ENABLED',
      '--query', '{bytes:ContentLength,sha:ChecksumSHA256,type:ChecksumType}', '--output', 'json',
    ], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (head.status !== 0) return { ok: false, reason: String(head.stderr || 's3 head failed').slice(0, 500) };
    try {
      const proof = JSON.parse(head.stdout || '{}');
      const verified =
        Number(proof.bytes) === bytes &&
        String(proof.type || '') === 'FULL_OBJECT' &&
        String(proof.sha || '') === checksumSha256;
      return verified
        ? { ok: true, sha256: digest, bytes }
        : { ok: false, reason: 's3 head size/checksum metadata mismatch' };
    } catch {
      return { ok: false, reason: 's3 head returned invalid JSON' };
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const EC2_HOST = process.env.SB_EC2_HOST || 'ec2-user@your-ec2-host';
const EC2_KEY = process.env.SB_EC2_KEY || path.join(HOME, '.ssh', 'sb-key.pem');
const EC2_CLOUD_CLI = process.env.SB_EC2_SESSION_CLOUD_CLI || '/opt/secondbrain/scripts/session-cloud-plane.js';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `"'"'`)}'`;
}

// The remote watchdog is authoritative: a Windows spawnSync timeout only ends
// its SSH client, whereas this isolated remote process group tears down Node and
// any inherited children after a bounded ingest attempt.  A timeout returns no
// receipt, so the local outbox remains pending for the next leased sweep.
export function sessionCloudRemoteCommand(command, cli = EC2_CLOUD_CLI) {
  if (!/^(?:ingest|ingest-batch|heartbeat)$/.test(command)) throw new Error(`unsupported cloud command: ${command}`);
  // Keep stdin attached to the foreground child. GNU timeout owns a separate
  // process group and escalates to KILL, including TERM-ignoring descendants.
  return `SECONDBRAIN_ROOT=/opt/secondbrain SECONDBRAIN_DATA_DIR=/opt/secondbrain/data exec setsid --wait timeout --signal=TERM --kill-after=5s 110s node ${shellQuote(cli)} ${shellQuote(command)}`;
}

export function parseCloudCommandResult(command, result) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}');
  } catch {
    // A failed command can still have emitted a definitive JSON validator error.
  }
  if (result.status === 0 && parsed?.ok === true) return parsed;
  if (parsed?.ok === false && parsed?.definitive === true) {
    return { ok: false, reason: parsed.reason || 'cloud ingest rejected event', definitive: true };
  }
  if (result.status !== 0) {
    return { ok: false, reason: String(result.stderr || result.error?.message || `ssh exit ${result.status}`).slice(0, 1000) };
  }
  return { ok: false, reason: 'cloud session plane returned invalid JSON' };
}

function cloudCommand(command, payload) {
  const remote = sessionCloudRemoteCommand(command);
  const result = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', '-i', EC2_KEY, EC2_HOST, remote],
    { input: JSON.stringify(payload), encoding: 'utf8', timeout: 140_000, windowsHide: true },
  );
  return parseCloudCommandResult(command, result);
}

function cloudPartKey(source, date, start, end) {
  const repo = String(source.repo || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120) || 'unknown';
  const sourceToken = sha256(source.source_id).slice(0, 16);
  return `transcripts/${source.provider}/${repo}/${date}/${source.session_id}/${sourceToken}/part-${start}-${end}.jsonl`;
}

function terminalReceiptFor(source) {
  if (source.source_kind !== 'main') return null;
  const receipt = readArchiveReceipt(source.session_id, { dataDir: DATA_DIR });
  if (receipt?.status !== 'replicated') return null;
  return {
    verified: receipt.s3?.transcript_verified === true && receipt.s3?.metadata_verified === true,
    receipt_id: receipt.operation_id || receipt.session_id,
    replicated_at: receipt.replicated_at || receipt.updated_at,
    transcript_sha256: receipt.transcript?.sha256 || '',
    transcript_bytes: Number(receipt.transcript?.bytes || 0),
  };
}

function fullSourceReceipt(source, bucket, nowIso, fullBuffer) {
  const complete = takeCompleteLines(fullBuffer);
  if (complete.bytes !== fullBuffer.length || complete.bytes === 0) return null;
  const key = cloudPartKey(source, nowIso.slice(0, 10), 0, complete.bytes);
  const proof = s3PutText(bucket, key, complete.text);
  if (!proof.ok) return null;
  return {
    verified: true,
    receipt_id: `session-source:${source.source_id}:${proof.sha256}`,
    replicated_at: nowIso,
    transcript_sha256: proof.sha256,
    transcript_bytes: proof.bytes,
    s3_bucket: bucket,
    s3_key: key,
  };
}

// Every unverified completion of a source waits for one full-source receipt.
// Recording only the last one left earlier completions unverified forever
// (2026-10-01: 68 completed activities from two Sep 29 sessions).
export function mergePendingTerminalIds(state = {}, ids = []) {
  const merged = [];
  const add = (id) => {
    const value = String(id || '');
    if (value && !merged.includes(value)) merged.push(value);
  };
  for (const id of Array.isArray(state.pending_terminal_activity_ids) ? state.pending_terminal_activity_ids : []) add(id);
  if (state.terminal_receipt_pending === true) add(state.last_terminal_activity_id);
  for (const id of ids) add(id);
  return merged;
}

// One batch's receipt decision. A verified full-source receipt confirms every
// earlier pending completion and covers this batch's unverified ones; without
// one, this batch's unverified completions join the pending list.
export function planTerminalReceipts({ state = {}, unverifiedIds = [], sourceReceipt = null } = {}) {
  const pending = mergePendingTerminalIds(state, []);
  const needsReceipt = pending.length > 0 || unverifiedIds.length > 0;
  if (needsReceipt && sourceReceipt?.verified === true) {
    return { needsReceipt, attachReceipt: true, confirmIds: pending, pendingIds: [] };
  }
  return {
    needsReceipt,
    attachReceipt: false,
    confirmIds: [],
    pendingIds: mergePendingTerminalIds({ pending_terminal_activity_ids: pending }, unverifiedIds),
  };
}

// The normal freshness window plus every reconciled source, whatever its age,
// so a seeded historical source is revisited and its retry can run.
export function selectSweepSources({ windowSources = [], allSources = [], reconcileSourceIds = new Set(), onlySessionId = null } = {}) {
  const picked = [...windowSources];
  const seen = new Set(picked.map((source) => source.source_id));
  for (const source of allSources) {
    if (onlySessionId && source.session_id !== onlySessionId) continue;
    if (reconcileSourceIds.has(source.source_id) && !seen.has(source.source_id)) {
      picked.push(source);
      seen.add(source.source_id);
    }
  }
  return picked;
}

// Reconciliation seed: completions the cloud still reports unverified become
// pending on their source, so the ordinary retry confirms them.
// A delivered byte was queued first, so the queue cursor never trails it. The
// Oct 24 helper source lost its state file before delivery recreated it with
// queued_offset 0; seeding restores the cursor so the retry confirms instead of
// re-uploading the whole transcript as new activity.
export function seedPendingTerminalIds(state = {}, ids = []) {
  const pending = mergePendingTerminalIds(state, ids);
  return {
    ...state,
    ...restoredQueueCursor(state),
    terminal_receipt_pending: pending.length > 0,
    pending_terminal_activity_ids: pending,
  };
}

function restoredQueueCursor(state = {}) {
  const queued = Number(state.queued_offset);
  const delivered = Number(state.last_offset);
  if (!Number.isFinite(delivered) || delivered <= 0) return {};
  return { queued_offset: Math.max(Number.isFinite(queued) ? queued : 0, delivered) };
}

// The source-state update for one delivered event. Missing state must never
// come back with queued_offset 0 behind a delivered byte.
export function deliveredSourceStateUpdate(state = {}, deliveredOffset = 0, receipt = null, nowIso = new Date().toISOString()) {
  const lastOffset = Math.max(Number(state.last_offset || 0), Number(deliveredOffset || 0));
  return {
    last_offset: lastOffset,
    queued_offset: Math.max(Number(state.queued_offset || 0), lastOffset),
    last_cloud_receipt_id: receipt?.receipt_id || '',
    last_cloud_committed_at: receipt?.committed_at || nowIso,
  };
}

// Pending terminal receipts are retried only while their source sits in the
// discovery window. A source that ages out with a receipt still pending (the
// Oct 27 698ace0e session) was never revisited, so the sweep reconciles from
// the cloud once pending debt outlives the window, at most hourly.
export const AUTO_RECONCILE_MIN_PENDING_SECONDS = 30 * 60;
export const AUTO_RECONCILE_EVERY_MS = 60 * 60 * 1000;
export function shouldAutoReconcileTerminalReceipts({ terminalMetric = null, lastRunMs = 0, nowMs = Date.now() } = {}) {
  if (!terminalMetric || Number(terminalMetric.pending || 0) <= 0) return false;
  if (Number(terminalMetric.oldest_pending_seconds || 0) < AUTO_RECONCILE_MIN_PENDING_SECONDS) return false;
  return !(Number.isFinite(lastRunMs) && lastRunMs > 0 && nowMs - lastRunMs < AUTO_RECONCILE_EVERY_MS);
}

// Classify cloud-pending sources. A source this host produced (local state
// exists) is labeled ended with the transcript missing only when its recorded
// transcript path is confirmed absent (stat ENOENT) after a complete discovery.
// Absence from discovery alone proves nothing: a same-named workflow journal
// moves the original file to a new source id while it still exists (Codex R3,
// 2026-10-29). A recorded file that still exists is recovered and retried under
// its recorded id; an incomplete scan, unrecorded path, or failed stat stays
// pending as unknown. A source with no local state may belong to another host,
// so it stays pending and unmatched.
export function classifyCloudPendingSources({
  pendingRows = {},
  hasLocalState = () => false,
  discoveredSourceIds = new Set(),
  recordedTranscript = () => ({ path: '', presence: 'unknown', alias: null }),
  discoveryComplete = false,
} = {}) {
  const seed = [];
  const recovered = [];
  const missing = [];
  const unknown = [];
  const unmatched = [];
  for (const [sourceId, row] of Object.entries(pendingRows)) {
    const ids = Array.isArray(row?.activity_ids) ? row.activity_ids : [];
    if (!ids.length) continue;
    if (!hasLocalState(sourceId)) { unmatched.push({ source_id: sourceId, activities: ids.length }); continue; }
    if (discoveredSourceIds.has(sourceId)) { seed.push({ source_id: sourceId, activity_ids: ids }); continue; }
    const recorded = recordedTranscript(sourceId) || {};
    if (recorded.presence === 'present') {
      recovered.push({ source_id: sourceId, activity_ids: ids, row: { ...row, activity_ids: ids }, transcript_path: recorded.path, alias: recorded.alias || null });
    } else if (recorded.presence === 'absent' && discoveryComplete) {
      missing.push({ source_id: sourceId, row: { ...row, activity_ids: ids } });
    } else {
      unknown.push({ source_id: sourceId, activities: ids.length, reason: discoveryComplete ? 'transcript-unverifiable' : 'discovery-incomplete' });
    }
  }
  return { seed, recovered, missing, unknown, unmatched };
}

function samePath(a, b) {
  const norm = (p) => {
    const resolved = path.resolve(String(p));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return Boolean(a && b) && norm(a) === norm(b);
}

// The recorded transcript for a source id that discovery no longer reports:
// present, absent (stat ENOENT only), or unknown (no recorded path, any other
// stat error). alias is the discovered source now naming the same file.
export function resolveRecordedTranscript({ state = {}, sources = [], stat = statSync } = {}) {
  const file = String(state?.transcript_path || '');
  if (!file) return { path: '', presence: 'unknown', alias: null };
  const alias = sources.find((source) => samePath(source.transcript_path, file)) || null;
  try {
    stat(file);
    return { path: file, presence: 'present', alias };
  } catch (e) {
    return { path: file, presence: e?.code === 'ENOENT' ? 'absent' : 'unknown', alias };
  }
}

// Discovery swallows directory read errors, so the reconcile walks the same
// roots and treats any unreadable directory as an incomplete scan. A root that
// does not exist is an empty, complete scan.
export function probeDiscoveryRoots(roots = [], { readdir = (dir) => readdirSync(dir, { withFileTypes: true }) } = {}) {
  const errors = [];
  const rootSet = new Set(roots);
  const stack = [...roots];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdir(dir);
    } catch (e) {
      if (!(rootSet.has(dir) && e?.code === 'ENOENT')) errors.push({ dir, code: String(e?.code || 'error') });
      continue;
    }
    for (const entry of entries) if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
  }
  return { complete: errors.length === 0, errors };
}

// A sweepable source for a recovered id: its recorded file and identity, so
// the ordinary retry confirms the pending receipts under the id the cloud holds.
export function recordedSweepSource({ sourceId, row = {}, state = {}, alias = null, nowIso = new Date().toISOString() } = {}) {
  return {
    ...(alias || {}),
    provider: String(row.provider || state.provider || alias?.provider || ''),
    session_id: String(row.session_id || state.session_id || alias?.session_id || ''),
    parent_session_id: row.parent_session_id || state.parent_session_id || alias?.parent_session_id || null,
    source_id: sourceId,
    source_kind: String(row.source_kind || state.source_kind || alias?.source_kind || 'main'),
    transcript_path: String(state.transcript_path || alias?.transcript_path || ''),
    title: alias?.title || '',
    updated_at: alias?.updated_at || nowIso,
  };
}

// One labeled resolution per activity: ended, transcript missing. It rides the
// receipt_confirmed type with verified false, which an older cloud ignores, so
// it can never be read as a verified receipt. The id carries the day so a
// cloud upgraded later still receives one.
export function transcriptMissingEvents({ sourceId, row = {}, state = {}, nowIso }) {
  const day = String(nowIso).slice(0, 10);
  return (Array.isArray(row.activity_ids) ? row.activity_ids : []).map((activityId) => ({
    schema: 'amy.session_event.v1',
    event_id: sha256([row.provider || '', row.session_id || '', sourceId, activityId, 'transcript_missing', day].join('|')),
    provider: String(row.provider || state.provider || ''),
    session_id: String(row.session_id || state.session_id || ''),
    activity_id: activityId,
    parent_session_id: row.parent_session_id || null,
    source_id: sourceId,
    source_kind: String(row.source_kind || state.source_kind || 'main'),
    type: 'receipt_confirmed',
    occurred_at: nowIso,
    observed_at: nowIso,
    source_sequence: Number(state.last_offset || state.queued_offset || 0),
    source_revision: 2,
    title: '',
    prompt_summary: '', progress_summary: '', result_summary: '', visible_text: '',
    execution: {},
    terminal_receipt: {
      verified: false,
      resolution: 'transcript_missing',
      receipt_id: '',
      checked_at: nowIso,
      checked_host: os.hostname().toLowerCase(),
      transcript_path_recorded: Boolean(state.transcript_path),
    },
  }));
}

export function sourceReceiptConfirmedEvents(source, state, receipt, nowIso) {
  if (receipt?.verified !== true) return [];
  return mergePendingTerminalIds(state, [])
    .map((activityId) => sourceReceiptConfirmedEvent(source, state, receipt, nowIso, activityId))
    .filter(Boolean);
}

function sourceReceiptConfirmedEvent(source, state, receipt, nowIso, activityId = state.last_terminal_activity_id) {
  if (!activityId || receipt?.verified !== true) return null;
  return {
    schema: 'amy.session_event.v1',
    event_id: sha256([source.provider, source.session_id, source.source_id, activityId, 'source_receipt', receipt.transcript_sha256].join('|')),
    provider: source.provider,
    session_id: source.session_id,
    activity_id: activityId,
    parent_session_id: source.parent_session_id || null,
    source_id: source.source_id,
    source_kind: source.source_kind,
    type: 'receipt_confirmed',
    occurred_at: receipt.replicated_at || nowIso,
    observed_at: nowIso,
    source_sequence: Number(state.queued_offset || state.last_offset || receipt.transcript_bytes || 0),
    source_revision: 2,
    title: scrubDerivedText(source.title).slice(0, 240),
    prompt_summary: '', progress_summary: '', result_summary: '', visible_text: '',
    execution: {
      cwd: scrubDerivedText(source.task?.execution?.cwd || '').slice(0, 500),
      branch: scrubDerivedText(source.task?.execution?.branch || '').slice(0, 240),
      commit: scrubDerivedText(source.task?.execution?.commit || '').slice(0, 80),
    },
    raw: {
      s3_key: receipt.s3_key || state.last_s3_key || '',
      s3_bucket: receipt.s3_bucket || '',
      byte_start: 0,
      byte_end: Number(receipt.transcript_bytes || 0),
      sha256: receipt.transcript_sha256 || '',
      verified: true,
    },
    terminal_receipt: receipt,
  };
}

function retryPendingSourceReceipt(source, state, bucket, nowIso, dry) {
  if (dry || !mergePendingTerminalIds(state, []).length) return false;
  const full = readFileSync(source.transcript_path);
  const receipt = fullSourceReceipt(source, bucket, nowIso, full);
  const events = sourceReceiptConfirmedEvents(source, state, receipt, nowIso);
  if (!events.length) return false;
  for (const event of events) enqueueSessionEvent(event, { dataDir: DATA_DIR, now: new Date(nowIso) });
  writeSourceState(source.source_id, {
    terminal_receipt_pending: false,
    pending_terminal_activity_ids: [],
    terminal_receipt_queued_at: nowIso,
  });
  return true;
}

// The last name the Claude app gave this session ("Quarterly planning"), read
// from its custom-title rows. Empty for Codex and for sessions never named.
export function lastCustomTitle(text) {
  let title = '';
  for (const m of String(text || '').matchAll(/"customTitle"\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    try {
      title = JSON.parse(m[1]);
    } catch {
      /* keep the previous name */
    }
  }
  return String(title || '').trim();
}

// The same answer as lastCustomTitle, streamed in bounded chunks so a
// multi-megabyte transcript is never held in memory whole.
export function lastCustomTitleInFile(file, { chunkBytes = 1024 * 1024 } = {}) {
  const fd = openSync(file, 'r');
  try {
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(chunkBytes);
    let carry = '';
    let title = '';
    const take = (line) => {
      if (!line.includes('"customTitle"')) return;
      const found = lastCustomTitle(line);
      if (found) title = found;
    };
    for (let pos = 0; ; ) {
      const n = readSync(fd, buffer, 0, chunkBytes, pos);
      if (n <= 0) break;
      pos += n;
      const lines = (carry + decoder.write(buffer.subarray(0, n))).split('\n');
      carry = lines.pop();
      lines.forEach(take);
    }
    take(carry + decoder.end());
    return title;
  } finally {
    closeSync(fd);
  }
}

// Session identity (who started it, and the app's name for it) reached the
// cloud on 2026-10-14. A source with no new bytes still reports it once, so
// sessions recorded earlier can be told apart and named on the phone.
// The digest (The owner's own prompts and the latest recap of what he wants) rides
// the same event, so the phone can say what a session is about even when its
// title is just "B" and its live turns are tool chatter.
export function identityCheckpointEvent(source, state, observedAt, sessionTitle = '', digest = null) {
  const title = scrubDerivedText(sessionTitle).slice(0, 160);
  const hasDigest = Boolean(digest && (digest.owner_prompts?.length || digest.intent));
  const digestHash = hasDigest ? sha256(JSON.stringify(digest)).slice(0, 16) : '';
  const key = `${source.initiator || ''}|${title}${digestHash ? `|${digestHash}` : ''}`;
  if ((source.source_kind || 'main') !== 'main' || key === '|' || state.identity_reported === key) return null;
  return {
    key,
    sessionTitle: title,
    event: {
      schema: 'amy.session_event.v1',
      event_id: sha256([source.provider, source.session_id, source.source_id, 'identity', key].join('|')),
      provider: source.provider,
      session_id: source.session_id,
      activity_id: `source-${sha256(source.source_id).slice(0, 12)}`,
      parent_session_id: source.parent_session_id || null,
      source_id: source.source_id,
      source_kind: source.source_kind || 'main',
      type: 'source_checkpoint',
      occurred_at: source.updated_at || observedAt,
      // Stamped with the source's own time: reporting identity is not new
      // activity, and must not make a finished session read as open.
      observed_at: source.updated_at || observedAt,
      source_sequence: Number(state.queued_offset ?? state.last_offset ?? 0),
      source_revision: 1,
      title: scrubDerivedText(source.title).slice(0, 240),
      ...(source.initiator ? { initiator: source.initiator } : {}),
      ...(title ? { session_title: title } : {}),
      ...(hasDigest ? { owner_prompts: digest.owner_prompts, intent: digest.intent || '', digest_at: observedAt } : {}),
      prompt_summary: '',
      progress_summary: '',
      result_summary: '',
      execution: {},
      visible_text: '',
      raw: {},
    },
  };
}

// Scans a transcript for its name at most once per size: an unchanged source
// that was already scanned (named or not) costs one stat, never a full read.
// `force` rescans anyway (the repair path); the identity key still dedupes, so
// only a changed classification, title or digest emits a new event. The digest
// is read only when the transcript grew since the last scan (or on force).
// DIGEST_VERSION marks which digest a source last reported, so sources scanned
// before digests existed (or before a digest change) are scanned once more.
// minIntervalMs throttles the growing-session path, which would otherwise
// reread a live transcript on every sweep.
export const DIGEST_VERSION = 1;
export const GROWING_DIGEST_INTERVAL_MS = 10 * 60 * 1000;
export function reportSourceIdentity(source, state, nowIso, dry, { dataDir = DATA_DIR, writeState = writeSourceState, force = false, minIntervalMs = 0 } = {}) {
  if (dry || (source.source_kind || 'main') !== 'main') return false;
  if (!force && minIntervalMs && Date.parse(nowIso) - (Date.parse(state.digest_scanned_at || '') || 0) < minIntervalMs) return false;
  const digestStale = state.digest_version !== DIGEST_VERSION;
  let size = 0;
  try {
    size = statSync(source.transcript_path).size;
  } catch {
    return false;
  }
  if (!force && !digestStale && state.identity_scanned_size === size && 'identity_reported' in state) return false;
  const scannedTitle =
    (force || !state.session_title) && source.provider === 'claude' ? lastCustomTitleInFile(source.transcript_path) : '';
  const sessionTitle = scannedTitle || state.session_title || '';
  const scanDigest = force || digestStale || state.identity_scanned_size !== size;
  const digest = scanDigest ? sessionDigestFromFile(source.transcript_path, source.provider) : null;
  const built = identityCheckpointEvent(source, state, nowIso, sessionTitle, digest);
  if (built) enqueueSessionEvent(built.event, { dataDir, now: new Date(nowIso) });
  writeState(source.source_id, {
    identity_scanned_size: size,
    identity_reported: built ? built.key : state.identity_reported || '',
    ...(scanDigest ? { digest_version: DIGEST_VERSION, digest_scanned_at: nowIso } : {}),
    ...(built && built.sessionTitle ? { session_title: built.sessionTitle } : {}),
  });
  return Boolean(built);
}

// One-time identity pass over the last week of sources, run automatically on
// the first sweep after this code lands. Its receipt attests only that every
// source was scanned and its identity event written to the local outbox; the
// outbox replays those events until EC2 acknowledges them (spine rule 15), so
// cloud durability is the outbox's job, not this receipt's. A missing or
// unreadable receipt reruns the pass. --backfill-identity forces a full rescan.
// v2 (2026-10-28): reruns once so last week's sessions report their digest.
export const IDENTITY_BACKFILL_RECEIPT = 'session-identity-backfill-v2.json';
const IDENTITY_BACKFILL_VERSION = 2;

export function identityBackfillDone(receiptPath) {
  try {
    const r = JSON.parse(readFileSync(receiptPath, 'utf8'));
    return r && r.version === IDENTITY_BACKFILL_VERSION && r.scope === 'local-outbox' && !Number.isNaN(Date.parse(r.scan_completed_at));
  } catch {
    return false;
  }
}

function runIdentityBackfill({ nowIso, nowMs, only, dry, force }) {
  const receiptPath = path.join(DATA_DIR, 'agent', IDENTITY_BACKFILL_RECEIPT);
  if (dry || (!force && identityBackfillDone(receiptPath))) return null;
  const weekSources = discoverSessionSources({ tasksDir: TASKS_DIR, nowMs, selectWindowMs: 7 * 24 * 60 * 60 * 1000 })
    .filter((source) => !only || source.session_id === only);
  let queued = 0;
  let failed = 0;
  for (const source of weekSources) {
    try {
      if (reportSourceIdentity(source, readSourceState(source.source_id), nowIso, dry, { force })) queued += 1;
    } catch (e) {
      failed += 1;
      console.warn(`[session-sweep] identity backfill skipped ${source.source_id}: ${(e && e.message) || e}`);
    }
  }
  console.log(`[session-sweep] backfill-identity sources=${weekSources.length} queued=${queued} failed=${failed}`);
  // A failed source leaves the receipt unwritten so the next sweep retries.
  if (!failed && !only) {
    atomicWriteJson(receiptPath, {
      version: IDENTITY_BACKFILL_VERSION,
      scope: 'local-outbox',
      scan_completed_at: nowIso,
      sources: weekSources.length,
      enqueued: queued,
    });
  }
  return { sources: weekSources.length, queued, failed };
}

export function rawCheckpointEvent(source, raw, observedAt) {
  return {
    schema: 'amy.session_event.v1',
    event_id: sha256([source.provider, source.session_id, source.source_id, 'raw_checkpoint', raw.byte_start, raw.byte_end].join('|')),
    provider: source.provider,
    session_id: source.session_id,
    activity_id: `source-${sha256(source.source_id).slice(0, 12)}`,
    parent_session_id: source.parent_session_id || null,
    source_id: source.source_id,
    source_kind: source.source_kind,
    type: 'source_checkpoint',
    occurred_at: source.updated_at || observedAt,
    observed_at: observedAt,
    source_sequence: raw.byte_end,
    source_revision: 1,
    title: scrubDerivedText(source.title).slice(0, 240),
    ...(source.initiator ? { initiator: source.initiator } : {}),
    prompt_summary: '',
    progress_summary: '',
    result_summary: '',
    execution: {
      cwd: scrubDerivedText(source.task?.execution?.cwd || '').slice(0, 500),
      branch: scrubDerivedText(source.task?.execution?.branch || '').slice(0, 240),
      commit: scrubDerivedText(source.task?.execution?.commit || '').slice(0, 80),
    },
    visible_text: '',
    raw,
  };
}

function enqueueAvailableTerminalReceipt(source, state, nowIso, dry) {
  if (dry || source.source_kind !== 'main') return false;
  const archiveReceipt = readArchiveReceipt(source.session_id, { dataDir: DATA_DIR });
  if (
    !state.last_terminal_activity_id &&
    state.active_activity_id &&
    archiveReceipt?.status === 'replicated' &&
    Number(archiveReceipt.transcript?.bytes || 0) >= Number(state.queued_offset || 0)
  ) {
    const terminalReceipt = terminalReceiptFor(source);
    const event = {
      schema: 'amy.session_event.v1',
      event_id: sha256([
        source.provider, source.session_id, state.active_activity_id, 'archive_terminal',
        archiveReceipt.transcript?.sha256 || '', archiveReceipt.transcript?.bytes || 0,
      ].join('|')),
      provider: source.provider,
      session_id: source.session_id,
      activity_id: state.active_activity_id,
      parent_session_id: source.parent_session_id || null,
      source_id: source.source_id,
      source_kind: source.source_kind,
      type: 'activity_completed',
      occurred_at: archiveReceipt.replicated_at || archiveReceipt.updated_at || nowIso,
      observed_at: nowIso,
      source_sequence: Number(state.queued_offset || archiveReceipt.transcript?.bytes || 0),
      source_revision: 2,
      title: scrubDerivedText(source.title).slice(0, 240),
      prompt_summary: '', progress_summary: '', result_summary: '', visible_text: '',
      execution: {},
      raw: {
        s3_key: archiveReceipt.s3?.transcript_key || state.last_s3_key || '',
        s3_bucket: archiveReceipt.s3?.bucket || '',
        byte_start: 0,
        byte_end: Number(archiveReceipt.transcript?.bytes || 0),
        sha256: archiveReceipt.transcript?.sha256 || '',
        verified: true,
      },
      terminal_receipt: terminalReceipt,
    };
    const queued = enqueueSessionEvent(event, { dataDir: DATA_DIR, now: new Date(nowIso) }).queued === true;
    writeSourceState(source.source_id, {
      active_activity_id: '',
      last_terminal_activity_id: state.active_activity_id,
      terminal_receipt_pending: terminalReceipt?.verified !== true,
    });
    return queued;
  }
  const confirmed = buildReceiptConfirmedEvent({ source, state, receipt: archiveReceipt, observedAt: nowIso });
  if (!confirmed) return false;
  return enqueueSessionEvent(confirmed, { dataDir: DATA_DIR, now: new Date(nowIso) }).queued === true;
}

function writeSpineCloudPointer(event, receipt, observedAt) {
  if (event.source_kind !== 'main') return;
  const file = existingSessionRecordFile(event.session_id, { dataDir: DATA_DIR, tasksDir: TASKS_DIR });
  if (!file) return;
  return withSessionRecordLock(file, () => {
  const task = readJson(file);
  if (!task) return;
  const archive = task.archive && typeof task.archive === 'object' ? task.archive : {};
  const sources = archive.sources && typeof archive.sources === 'object' ? archive.sources : {};
  const current = sources[event.source_id] || {};
  sources[event.source_id] = {
    ...current,
    provider: event.provider,
    sourceKind: event.source_kind,
    lastOffset: Math.max(Number(current.lastOffset || 0), Number(event.raw?.byte_end || 0)),
    lastArchivedAt: observedAt,
    bucket: event.raw?.s3_bucket || current.bucket || '',
    lastPart: event.raw?.s3_key || current.lastPart || '',
    cloudReceiptId: receipt?.receipt_id || current.cloudReceiptId || '',
    cloudCommittedAt: receipt?.committed_at || observedAt,
  };
  task.archive = {
    ...archive,
    sources,
    lastOffset: Math.max(Number(archive.lastOffset || 0), Number(event.raw?.byte_end || 0)),
    lastArchivedAt: observedAt,
    bucket: event.raw?.s3_bucket || archive.bucket || '',
  };
  writeSessionRecord(file, task);
  });
}

// A reclaimed (stopped or superseded) owner must not drain or rewrite the outbox.
let activeLease = null;
function assertLeaseHeld() {
  if (activeLease && !activeLease.holds()) throw new Error('session sweep lease lost; aborting before outbox write');
}

async function drainOutbox(now, options = {}) {
  assertLeaseHeld();
  return drainSessionEventOutbox({
    dataDir: DATA_DIR,
    now,
    ...sessionCloudDrainOptions({ delivered: options.alreadyDelivered, final: options.final }),
    onBatch: options.onBatch,
    sendBatch: async (queued) => {
      assertLeaseHeld();
      return sendCloudBatchNegotiated(queued, async (chunk) => cloudCommand('ingest-batch', { events: chunk }), cloudBatchState, {
        onFallback: (size) => appendRunLog(RUN_LOG, { ev: 'batch-size-fallback', size, reason: 'cloud still on the older batch ceiling' }),
      });
    },
    onDelivered: async (queued, receipt) => {
      assertLeaseHeld();
      const deliveredOffset = Number(queued.raw?.byte_end || 0);
      const state = readSourceState(queued.source_id);
      writeSourceState(queued.source_id, deliveredSourceStateUpdate(state, deliveredOffset, receipt, now.toISOString()));
      writeSpineCloudPointer(queued, receipt, now.toISOString());
    },
  });
}

function heartbeatSourceProof(source) {
  if (!source?.source_id || typeof source.deliverable_bytes !== 'number' || !Number.isFinite(source.deliverable_bytes) || source.deliverable_bytes < 0) return null;
  return {
    source_id: source.source_id,
    byte_end: Number(source.deliverable_bytes),
    raw_bytes: Number.isFinite(Number(source.transcript_bytes)) ? Number(source.transcript_bytes) : null,
    updated_at: source.updated_at || null,
  };
}

export function producerHeartbeatSourceProof(source) {
  return heartbeatSourceProof(source);
}

export function selectLatestSource(sources) {
  return (Array.isArray(sources) ? sources : []).reduce((latest, source) => {
    const candidateMs = Date.parse(source?.updated_at || '');
    if (!Number.isFinite(candidateMs)) return latest;
    const latestMs = Date.parse(latest?.updated_at || '');
    return !Number.isFinite(latestMs) || candidateMs > latestMs ? source : latest;
  }, null);
}

export function sourceDeliveryBoundary(source, state, full) {
  const bytes = Buffer.isBuffer(full) ? full : Buffer.from(full || '');
  const persisted = Number(state?.queued_offset);
  const fallback = Number(state?.last_offset);
  const start = Math.max(0, Math.min(bytes.length, Number.isFinite(persisted) ? persisted : Number.isFinite(fallback) ? fallback : 0));
  const complete = takeCompleteLines(bytes.subarray(start));
  return {
    ...source,
    transcript_bytes: bytes.length,
    deliverable_bytes: start + complete.bytes,
  };
}

function sourceWithDeliveryBoundary(source) {
  try {
    return sourceDeliveryBoundary(source, readSourceState(source.source_id), readFileSync(source.transcript_path));
  } catch {
    // Do not invent a boundary after an unreadable source. Its heartbeat stays
    // unbound instead of claiming a saved transcript from stale state.
    return { ...source, deliverable_bytes: null };
  }
}

function publishProducerHeartbeat({ bucket, nowIso, latestSourceAt, latestSource, providers, sourceCount, pendingOutbox }) {
  const heartbeatPayload = {
    observed_at: nowIso,
    latest_source_at: latestSourceAt,
    latest_source: heartbeatSourceProof(latestSource),
    providers,
    source_count: sourceCount,
    pending_outbox: pendingOutbox,
    producer_host: os.hostname().toLowerCase(),
  };
  const hostToken = os.hostname().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const heartbeatArchive = s3PutText(
    bucket,
    `session-cloud/producer-heartbeats/${hostToken}.json`,
    `${JSON.stringify(heartbeatPayload)}\n`,
  );
  const heartbeat = cloudCommand('heartbeat', heartbeatPayload);
  atomicWriteJson(PRODUCER_HEARTBEAT, {
    schema: 'amy.session_producer_local.v1',
    ...heartbeatPayload,
    s3_heartbeat_ok: heartbeatArchive.ok === true,
    s3_heartbeat_reason: heartbeatArchive.ok === true ? '' : heartbeatArchive.reason || 'unknown',
    cloud_heartbeat_ok: heartbeat.ok === true,
    cloud_heartbeat_reason: heartbeat.ok === true ? '' : heartbeat.reason || 'unknown',
  });
  return { heartbeat, heartbeatArchive, heartbeatPayload };
}

function sweepSource(source, bucket, nowIso, dry) {
  const state = readSourceState(source.source_id);
  const size = statSync(source.transcript_path).size;
  const start = Math.max(0, Number(state.queued_offset ?? state.last_offset ?? 0));
  if (size <= start) {
    const receiptQueued = enqueueAvailableTerminalReceipt(source, state, nowIso, dry);
    const sourceReceiptQueued = retryPendingSourceReceipt(source, state, bucket, nowIso, dry);
    const identityQueued = reportSourceIdentity(source, readSourceState(source.source_id), nowIso, dry);
    return { provider: source.provider, sessionId: source.session_id, source: source.source_kind, skipped: 'no-new-bytes', receiptQueued, sourceReceiptQueued, identityQueued };
  }
  const full = readFileSync(source.transcript_path);
  const { text, bytes } = takeCompleteLines(full.subarray(start));
  if (bytes === 0) return { provider: source.provider, sessionId: source.session_id, source: source.source_kind, skipped: 'only-partial-line' };
  const end = start + bytes;
  const key = cloudPartKey(source, nowIso.slice(0, 10), start, end);
  if (dry) return { provider: source.provider, sessionId: source.session_id, source: source.source_kind, wouldUpload: key, bytes };

  const put = s3PutText(bucket, key, text);
  if (!put.ok) {
    return { provider: source.provider, sessionId: source.session_id, source: source.source_kind, error: 's3-put-or-head-verification-failed', reason: put.reason, key };
  }
  const raw = {
    s3_key: key,
    s3_bucket: bucket,
    byte_start: start,
    byte_end: end,
    sha256: put.sha256,
    verified: true,
  };
  const parsed = buildEventsFromDelta({
    source,
    deltaText: text,
    startOffset: start,
    endOffset: end,
    observedAt: nowIso,
    previousState: state,
    terminalReceipt: terminalReceiptFor(source),
    raw,
  });
  const terminalEvents = parsed.events.filter((event) => event.type === 'activity_completed');
  // Earlier completions still waiting on a receipt stay pending until one
  // full-source receipt confirms them; a later verified batch never drops them.
  const unverifiedTerminal = terminalEvents.filter((event) => event.terminal_receipt?.verified !== true);
  const unverifiedIds = unverifiedTerminal.map((event) => event.activity_id);
  const needsReceipt = planTerminalReceipts({ state, unverifiedIds }).needsReceipt;
  const sourceReceipt = needsReceipt ? fullSourceReceipt(source, bucket, nowIso, full) : null;
  const receiptPlan = planTerminalReceipts({ state, unverifiedIds, sourceReceipt });
  if (receiptPlan.attachReceipt) {
    for (const event of unverifiedTerminal) event.terminal_receipt = sourceReceipt;
  }
  const confirmEvents = receiptPlan.confirmIds.length
    ? sourceReceiptConfirmedEvents(
        source,
        { ...state, terminal_receipt_pending: false, pending_terminal_activity_ids: receiptPlan.confirmIds },
        sourceReceipt,
        nowIso,
      )
    : [];
  const pendingTerminalIds = receiptPlan.pendingIds;
  const terminalReceiptPending = pendingTerminalIds.length > 0;
  const events = [
    ...(parsed.events.length ? parsed.events : [rawCheckpointEvent(source, raw, nowIso)]),
    ...confirmEvents,
  ];
  for (const event of events) enqueueSessionEvent(event, { dataDir: DATA_DIR, now: new Date(nowIso) });
  const next = writeSourceState(source.source_id, {
    ...parsed.state,
    provider: source.provider,
    session_id: source.session_id,
    source_kind: source.source_kind,
    transcript_path: source.transcript_path,
    queued_offset: end,
    latest_source_at: source.updated_at,
    last_s3_key: key,
    last_s3_sha256: raw.sha256,
    last_queued_at: nowIso,
    terminal_receipt_pending: terminalReceiptPending,
    pending_terminal_activity_ids: pendingTerminalIds,
  });
  enqueueAvailableTerminalReceipt(source, next, nowIso, dry);
  // A session that keeps growing still refreshes what it is about.
  const identityQueued = reportSourceIdentity(source, readSourceState(source.source_id), nowIso, dry, {
    minIntervalMs: GROWING_DIGEST_INTERVAL_MS,
  });
  return { provider: source.provider, sessionId: source.session_id, source: source.source_kind, uploaded: key, bytes, events: events.length, identityQueued };
}

// --reconcile-cloud-pending: one-time repair for completions recorded before
// pending_terminal_activity_ids existed. Reads (never writes) the cloud
// projection for terminal activities without a verified receipt, seeds each
// matching local source, and leaves the ordinary retry to confirm them.
const CLOUD_PROJECTION_PATH = '/opt/secondbrain/data/agent/session-cloud/projection.json';
const CLOUD_PENDING_QUERY = `node -e '
const p=JSON.parse(require("fs").readFileSync(${JSON.stringify(CLOUD_PROJECTION_PATH)},"utf8"));
const out={};
for (const a of Object.values(p.activities||{})) {
  if (!["completed","failed","cancelled"].includes(String(a.status||""))) continue;
  if (a.terminal_receipt_verified===true || !a.source_id || !a.activity_id) continue;
  if (a.terminal_receipt_resolution==="transcript_missing") continue;
  const row=(out[a.source_id]=out[a.source_id]||{provider:String(a.provider||""),session_id:String(a.session_id||""),source_kind:String(a.source_kind||""),parent_session_id:a.parent_session_id||null,activity_ids:[]});
  row.activity_ids.push(a.activity_id);
}
process.stdout.write(JSON.stringify(out));'`;

// The cloud reports each pending source with its own session id, so --session
// scoping never depends on local state that may be missing or unreadable.
export function pendingInSession(pendingRows = {}, onlySessionId = null) {
  const scoped = {};
  for (const [sourceId, row] of Object.entries(pendingRows)) {
    if (onlySessionId && String(row?.session_id || '') !== onlySessionId) continue;
    scoped[sourceId] = Array.isArray(row?.activity_ids) ? row.activity_ids : [];
  }
  return scoped;
}

function reconcileCloudPendingReceipts(nowIso, onlySessionId = null, nowMs = Date.parse(nowIso)) {
  const query = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', '-i', EC2_KEY, EC2_HOST, CLOUD_PENDING_QUERY],
    { encoding: 'utf8', timeout: 80_000, windowsHide: true },
  );
  let pendingBySource;
  try {
    pendingBySource = JSON.parse(String(query.stdout || ''));
  } catch {
    return { ok: false, reason: `cloud-pending-query-failed:${String(query.stderr || query.status).slice(0, 200)}`, sources: [] };
  }
  const scopedRows = Object.fromEntries(Object.entries(pendingBySource)
    .filter(([, row]) => !onlySessionId || String(row?.session_id || '') === onlySessionId));
  let allSources = [];
  let discoveryComplete = false;
  if (Object.keys(scopedRows).length) {
    try {
      allSources = discoverSessionSources({ tasksDir: TASKS_DIR, nowMs, selectWindowMs: Number.MAX_SAFE_INTEGER });
      discoveryComplete = probeDiscoveryRoots([defaultClaudeProjectsDir(), defaultCodexSessionsDir()]).complete;
    } catch {
      allSources = [];
      discoveryComplete = false;
    }
  }
  const byId = new Map(allSources.map((source) => [source.source_id, source]));
  // Missing or unreadable local state is unmatched, never a silent skip.
  const plan = classifyCloudPendingSources({
    pendingRows: scopedRows,
    hasLocalState: (sourceId) => existsSync(sourceStateFile(sourceId)) && Boolean(readJson(sourceStateFile(sourceId))),
    discoveredSourceIds: new Set(byId.keys()),
    recordedTranscript: (sourceId) => resolveRecordedTranscript({ state: readSourceState(sourceId), sources: allSources }),
    discoveryComplete,
  });
  for (const row of plan.seed) {
    writeSourceState(row.source_id, seedPendingTerminalIds(readSourceState(row.source_id), row.activity_ids));
  }
  const recoveredSources = [];
  for (const row of plan.recovered) {
    const state = writeSourceState(row.source_id, seedPendingTerminalIds(readSourceState(row.source_id), row.activity_ids));
    recoveredSources.push(recordedSweepSource({ sourceId: row.source_id, row: row.row, state, alias: row.alias, nowIso }));
  }
  const missing = [];
  for (const { source_id: sourceId, row } of plan.missing) {
    const state = readSourceState(sourceId);
    for (const event of transcriptMissingEvents({ sourceId, row, state, nowIso })) {
      enqueueSessionEvent(event, { dataDir: DATA_DIR, now: new Date(nowIso) });
    }
    writeSourceState(sourceId, {
      terminal_receipt_pending: false,
      pending_terminal_activity_ids: [],
      transcript_missing_activity_ids: row.activity_ids,
      transcript_missing_resolved_at: nowIso,
    });
    missing.push({ source_id: sourceId, activity_ids: row.activity_ids });
  }
  const seed = buildReconcileSeedReceipt({
    nowIso,
    pendingBySource: pendingInSession(scopedRows, null),
    seeded: plan.seed,
    recovered: plan.recovered.map((row) => ({ source_id: row.source_id, activity_ids: row.activity_ids, alias_source_id: row.alias?.source_id || '' })),
    unmatched: plan.unmatched,
    unknown: plan.unknown,
    missing,
  });
  atomicWriteJson(path.join(DATA_DIR, 'agent', seed.fileName), seed.receipt);
  return {
    ok: seed.ok,
    ...seed.receipt,
    sources: [...plan.seed.map((row) => byId.get(row.source_id)).filter(Boolean), ...recoveredSources],
  };
}

// A seed receipt, not completion proof: confirmation happens when the
// ordinary retry delivers receipt_confirmed events, and the proof is the
// System Health session-terminal-receipts row reading 0 pending. One unique
// file per run; any cloud activity with no local source fails the run.
export function buildReconcileSeedReceipt({ nowIso, pendingBySource = {}, seeded = [], recovered = [], unmatched = [], unknown = [], missing = [] } = {}) {
  return {
    ok: unmatched.length === 0 && unknown.length === 0,
    fileName: `session-receipt-reconcile-seed-${String(nowIso).replace(/[:.]/g, '-')}.json`,
    receipt: {
      schema: 'amy.session_receipt_reconcile_seed.v1',
      stage: 'seeded',
      seeded_at: nowIso,
      cloud_unverified_terminal: Object.values(pendingBySource).reduce((sum, ids) => sum + ids.length, 0),
      seeded,
      recovered,
      transcript_missing: missing,
      unknown,
      unmatched,
    },
  };
}

async function main() {
  const dry = process.argv.includes('--dry');
  const onlyIdx = process.argv.indexOf('--session');
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
  const lease = dry ? null : acquireSessionSweepLease({ dataDir: DATA_DIR });
  if (lease && !lease.acquired) {
    console.log(`[session-sweep] deferred=${lease.reason}; another sweep owns the durable outbox`);
    return { deferred: true, reason: lease.reason };
  }
  activeLease = lease;
  if (!dry) appendRunLog(RUN_LOG, { ev: 'start', pending: countPendingSessionEvents({ dataDir: DATA_DIR }) });
  try {
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);

  const bucket = dry ? '(dry)' : sessionsBucket();
  if (!dry && !bucket) {
    console.error('[session-sweep] cannot resolve S3 bucket (no SECONDBRAIN_SESSIONS_BUCKET, sts failed)');
    process.exit(1);
  }
  const reconcileSourceIds = new Set();
  const reconciledSources = [];
  const runReconcile = (label) => {
    const reconcile = reconcileCloudPendingReceipts(nowIso, only, nowMs);
    const { sources: found = [], ...logged } = reconcile;
    console.log(`[session-sweep] ${label} ${JSON.stringify(logged)}`);
    appendRunLog(RUN_LOG, { ev: label, ok: reconcile.ok, seeded: (reconcile.seeded || []).length, transcript_missing: (reconcile.transcript_missing || []).length, unmatched: (reconcile.unmatched || []).length, recovered: (reconcile.recovered || []).length, unknown: (reconcile.unknown || []).length });
    for (const source of found) {
      reconcileSourceIds.add(source.source_id);
      reconciledSources.push(source);
    }
    return reconcile;
  };
  if (!dry && process.argv.includes('--reconcile-cloud-pending')) {
    if (!runReconcile('reconcile-cloud-pending').ok) process.exitCode = 1;
  }

  runIdentityBackfill({ nowIso, nowMs, only, dry, force: process.argv.includes('--backfill-identity') });

  const windowSources = discoverSessionSources({
    tasksDir: TASKS_DIR,
    nowMs,
    selectWindowMs: only ? Number.MAX_SAFE_INTEGER : discoveryWindow(nowMs),
  }).filter((source) => !only || source.session_id === only);
  const sources = selectSweepSources({
    windowSources,
    allSources: reconciledSources,
    reconcileSourceIds,
    onlySessionId: only,
  });
  let providers = sources.reduce((counts, source) => {
    counts[source.provider] = (counts[source.provider] || 0) + 1;
    return counts;
  }, {});
  const latestDiscoveredSource = selectLatestSource(sources);
  let latestSource = latestDiscoveredSource ? sourceWithDeliveryBoundary(latestDiscoveredSource) : null;
  let latestSourceAt = latestSource?.updated_at || null;
  let sourceCount = sources.length;
  // Heartbeat first: a retained backlog must never make a current producer
  // look offline while FIFO batch delivery catches up behind it.
  let heartbeat = { ok: true, dry: true };
  let heartbeatArchive = { ok: true, dry: true };
  let lastHeartbeatMs = nowMs;
  const refreshHeartbeat = () => {
    const refreshedAt = new Date().toISOString();
    const refreshed = publishProducerHeartbeat({
      bucket, nowIso: refreshedAt, latestSourceAt, latestSource, providers,
      sourceCount, pendingOutbox: countPendingSessionEvents({ dataDir: DATA_DIR }),
    });
    heartbeat = refreshed.heartbeat;
    heartbeatArchive = refreshed.heartbeatArchive;
    lastHeartbeatMs = Date.parse(refreshedAt);
  };
  if (!dry) {
    refreshHeartbeat();
    console.log(`[session-sweep] housekeeping ${JSON.stringify(runPcHousekeeping({ nowMs }))}`);
    const stamp = readJson(AUTO_RECONCILE_STAMP);
    if (shouldAutoReconcileTerminalReceipts({
      terminalMetric: heartbeat?.health?.metrics?.terminal_receipts,
      lastRunMs: Date.parse(stamp?.at || '') || 0,
      nowMs,
    })) {
      atomicWriteJson(AUTO_RECONCILE_STAMP, { at: nowIso });
      const before = reconciledSources.length;
      try { runReconcile('auto-reconcile-terminal-receipts'); } catch (e) {
        appendRunLog(RUN_LOG, { ev: 'auto-reconcile-error', message: String((e && e.message) || e).slice(0, 300) });
      }
      const picked = new Set(sources.map((source) => source.source_id));
      for (const source of reconciledSources.slice(before)) {
        if (!picked.has(source.source_id) && (!only || source.session_id === only)) sources.push(source);
      }
    }
  }
  const results = [];
  const startWindowMs = only ? Number.MAX_SAFE_INTEGER : discoveryWindow(nowMs);
  const rediscoverDuringDrain = () => {
    const snapshot = refreshSourceSnapshot({
      discover: () => selectSweepSources({
        windowSources: discoverSessionSources({
          tasksDir: TASKS_DIR,
          nowMs: Date.now(),
          selectWindowMs: only ? Number.MAX_SAFE_INTEGER : startWindowMs + (Date.now() - nowMs),
        }).filter((source) => !only || source.session_id === only),
        allSources: [],
        reconcileSourceIds,
        onlySessionId: only,
      }),
      sweepOne: (source) => sweepSource(source, bucket, new Date().toISOString(), false),
      withBoundary: sourceWithDeliveryBoundary,
      results,
    });
    providers = snapshot.providers;
    latestSource = snapshot.latestSource;
    latestSourceAt = snapshot.latestSourceAt;
    sourceCount = snapshot.sources.length;
  };
  let initialDrain = { attempted: 0, delivered: 0, failed: 0, remaining: 0 };
  // Per batch: the outbox has already moved each delivered event to delivered/ and advanced
  // its source cursor (drain onDelivered), so a kill here loses and repeats nothing. This hook
  // adds the run-log line and keeps the producer heartbeat fresh while a long drain runs.
  let loggedDelivered = 0;
  let loggedFailed = 0;
  const heartbeatBetweenBatches = async ({ result }) => {
    if (!dry) {
      appendRunLog(RUN_LOG, {
        ev: 'batch', delivered: result.delivered - loggedDelivered, failed: result.failed - loggedFailed,
        run_delivered: result.delivered, remaining_in_pass: Math.max(0, result.remaining - result.attempted),
      });
    }
    loggedDelivered = result.delivered;
    loggedFailed = result.failed;
    if (!dry && Date.now() - lastHeartbeatMs >= SESSION_CLOUD_HEARTBEAT_CADENCE_MS) {
      try { rediscoverDuringDrain(); } catch (e) {
        appendRunLog(RUN_LOG, { ev: 'rediscover-error', message: String((e && e.message) || e).slice(0, 300) });
      }
      refreshHeartbeat();
    }
  };
  if (!dry) initialDrain = await drainOutbox(new Date(nowIso), { onBatch: heartbeatBetweenBatches });
  for (const source of sources) {
    assertLeaseHeld();
    try {
      results.push(sweepSource(source, bucket, nowIso, dry));
    } catch (e) {
      results.push({ provider: source.provider, sessionId: source.session_id, source: source.source_kind, error: (e && e.message) || 'unknown' });
    }
  }
  let finalDrain = { attempted: 0, delivered: 0, failed: 0, remaining: 0 };
  loggedDelivered = 0;
  loggedFailed = 0;
  if (!dry) finalDrain = await drainOutbox(new Date(nowIso), { onBatch: heartbeatBetweenBatches, final: true, alreadyDelivered: initialDrain.delivered });

  const pendingOutbox = dry ? listPendingSessionEvents({ dataDir: DATA_DIR }).length : finalDrain.remaining;
  if (!dry) refreshHeartbeat();

  const up = results.filter((r) => r.uploaded || r.wouldUpload).length;
  const err = results.filter((r) => r.error).length + initialDrain.failed + finalDrain.failed + (heartbeat.ok ? 0 : 1) + (heartbeatArchive.ok ? 0 : 1);
  console.log(
    `[session-sweep] ${dry ? 'DRY ' : ''}sources=${sources.length} archived=${up} delivered=${initialDrain.delivered + finalDrain.delivered} pending=${pendingOutbox} errors=${err}`,
  );
  for (const r of results) console.log('  ', JSON.stringify(r));
  if (!heartbeatArchive.ok) console.error(`  S3 producer heartbeat: ${heartbeatArchive.reason || 'failed'}`);
  if (!heartbeat.ok) console.error(`  cloud heartbeat: ${heartbeat.reason || 'failed'}`);
  if (err > 0) process.exitCode = 1;
  if (!dry) appendRunLog(RUN_LOG, { ev: 'end', delivered: initialDrain.delivered + finalDrain.delivered, pending: pendingOutbox, errors: err });
  return { deferred: false, pendingOutbox, errors: err };
  } catch (error) {
    if (!dry) appendRunLog(RUN_LOG, { ev: 'error', message: String((error && error.message) || error).slice(0, 500) });
    throw error;
  } finally {
    lease?.release();
  }
}

// #b 2026-10-25: two PC jobs had no reliable autonomous driver. The prompt
// sweep only ran on a later UserPromptSubmit, and the nightly branch retire
// ran from backup.bat in the stale shared checkout, so the retire card's run
// clock went 30 hours without a row. This sweep runs every two minutes from
// the promoted amy-code release, so both ride here.
const RETIRE_EVERY_MS = 20 * 60 * 60 * 1000;

export function lastRetireRunMs(dataDir) {
  let last = 0;
  try {
    const text = readFileSync(path.join(dataDir, 'git-archive', 'retire-ledger.jsonl'), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.includes('"stage":"run"')) continue;
      try {
        const row = JSON.parse(line);
        if (row.stage === 'run' && row.mode === 'apply') last = Math.max(last, Date.parse(row.at) || 0);
      } catch { /* torn row */ }
    }
  } catch { /* no ledger yet */ }
  return last;
}

export function runPcHousekeeping({ dataDir = DATA_DIR, nowMs = Date.now(), sweepPrompts, spawnRetire, sharedRoot } = {}) {
  const out = { prompts: null, retire: 'not-due' };
  try {
    const sweep = sweepPrompts || require('./lib/model-exchange-provenance.js').sweepStaleHeadlessPrompts;
    out.prompts = sweep({ dataDir, now: new Date(nowMs) });
  } catch (e) {
    out.prompts = { error: String(e?.message || e) };
  }
  if (nowMs - lastRetireRunMs(dataDir) < RETIRE_EVERY_MS) return out;
  try {
    const cwd = sharedRoot || require('./lib/shared-checkout-root.js').sharedCheckoutRoots({ cwd: path.resolve(here, '..') }).at(-1);
    // Detached: retire can take minutes and owns its own run lock, so a
    // second spawn while one is running exits as locked.
    const spawnFn = spawnRetire || ((args, opts) => {
      const child = spawn(process.execPath, args, opts);
      child.unref();
    });
    spawnFn([path.join(here, 'git-branch-retire.js'), '--apply', '--cap=25'], {
      cwd, detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, SECONDBRAIN_DATA_DIR: dataDir },
    });
    out.retire = `spawned:${cwd}`;
  } catch (e) {
    out.retire = `error:${String(e?.message || e)}`;
  }
  return out;
}

const invokedDirectly =
  isInvokedDirectly(process.argv[1], import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[session-sweep] fatal: ${String(error?.message || error)}`);
    process.exitCode = 1;
  });
}
