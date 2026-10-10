#!/usr/bin/env node
// session-sweep.mjs
//
// Provider-neutral continuous session producer. Every two minutes it discovers
// recent Claude main/subagent transcripts and Codex rollouts, writes complete
// raw deltas to S3, durably queues normalized visible activity events, and asks
// the EC2 session cloud plane to commit them. The cloud plane owns the canonical
// activity projection, exact search, Graphiti projection, and receipts consumed
// by Telegram and the morning briefing.
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

import { readFileSync, writeFileSync, statSync, existsSync, mkdtempSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  buildEventsFromDelta,
  buildReceiptConfirmedEvent,
  discoverSessionSources,
  scrubDerivedText,
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
const SESSION_CLOUD_BATCH_SIZE = Math.max(1, Math.min(20, Math.floor(Number(process.env.SESSION_CLOUD_BATCH_SIZE)) || 10));
const SESSION_CLOUD_DRAIN_ADMISSION_MS = 60_000;
const SESSION_CLOUD_HEARTBEAT_CADENCE_MS = 120_000;

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
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
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
    });
    if (r.status !== 0) return { ok: false, reason: String(r.stderr || 's3 put failed').slice(0, 500) };
    const head = spawnSync(bin, [
      's3api', 'head-object', '--bucket', bucket, '--key', key,
      '--region', REGION, '--checksum-mode', 'ENABLED',
      '--query', '{bytes:ContentLength,sha:ChecksumSHA256,type:ChecksumType}', '--output', 'json',
    ], { encoding: 'utf8', timeout: 30_000 });
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

const EC2_HOST = process.env.SB_EC2_HOST || 'ec2-user@ExampleCo';
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
  return `SECONDBRAIN_ROOT=/opt/secondbrain SECONDBRAIN_DATA_DIR=/opt/secondbrain/data exec setsid --wait timeout --signal=TERM --kill-after=5s 55s node ${shellQuote(cli)} ${shellQuote(command)}`;
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
    { input: JSON.stringify(payload), encoding: 'utf8', timeout: 80_000, windowsHide: true },
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
export function seedPendingTerminalIds(state = {}, ids = []) {
  const pending = mergePendingTerminalIds(state, ids);
  return { ...state, terminal_receipt_pending: pending.length > 0, pending_terminal_activity_ids: pending };
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

async function drainOutbox(now, options = {}) {
  return drainSessionEventOutbox({
    dataDir: DATA_DIR,
    now,
    batchSize: SESSION_CLOUD_BATCH_SIZE,
    admissionBudgetMs: SESSION_CLOUD_DRAIN_ADMISSION_MS,
    ...options,
    sendBatch: async (queued) => cloudCommand('ingest-batch', { events: queued }),
    onDelivered: async (queued, receipt) => {
      const deliveredOffset = Number(queued.raw?.byte_end || 0);
      const state = readSourceState(queued.source_id);
      writeSourceState(queued.source_id, {
        last_offset: Math.max(Number(state.last_offset || 0), deliveredOffset),
        last_cloud_receipt_id: receipt?.receipt_id || '',
        last_cloud_committed_at: receipt?.committed_at || now.toISOString(),
      });
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
    return { provider: source.provider, sessionId: source.session_id, source: source.source_kind, skipped: 'no-new-bytes', receiptQueued, sourceReceiptQueued };
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
  return { provider: source.provider, sessionId: source.session_id, source: source.source_kind, uploaded: key, bytes, events: events.length };
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
  const row=(out[a.source_id]=out[a.source_id]||{session_id:String(a.session_id||""),activity_ids:[]});
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

function reconcileCloudPendingReceipts(nowIso, onlySessionId = null) {
  const query = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', '-i', EC2_KEY, EC2_HOST, CLOUD_PENDING_QUERY],
    { encoding: 'utf8', timeout: 80_000, windowsHide: true },
  );
  let pendingBySource;
  try {
    pendingBySource = JSON.parse(String(query.stdout || ''));
  } catch {
    return { ok: false, reason: `cloud-pending-query-failed:${String(query.stderr || query.status).slice(0, 200)}` };
  }
  const scoped = pendingInSession(pendingBySource, onlySessionId);
  const seeded = [];
  const unmatched = [];
  for (const [sourceId, ids] of Object.entries(scoped)) {
    // Missing or unreadable local state is unmatched, never a silent skip.
    if (!existsSync(sourceStateFile(sourceId)) || !readJson(sourceStateFile(sourceId))) {
      unmatched.push({ source_id: sourceId, activities: ids.length });
      continue;
    }
    const next = seedPendingTerminalIds(readSourceState(sourceId), ids);
    writeSourceState(sourceId, next);
    seeded.push({ source_id: sourceId, activity_ids: ids });
  }
  const seed = buildReconcileSeedReceipt({ nowIso, pendingBySource: scoped, seeded, unmatched });
  atomicWriteJson(path.join(DATA_DIR, 'agent', seed.fileName), seed.receipt);
  return { ok: seed.ok, ...seed.receipt };
}

// A seed receipt, not completion proof: confirmation happens when the
// ordinary retry delivers receipt_confirmed events, and the proof is the
// System Health session-terminal-receipts row reading 0 pending. One unique
// file per run; any cloud activity with no local source fails the run.
export function buildReconcileSeedReceipt({ nowIso, pendingBySource = {}, seeded = [], unmatched = [] } = {}) {
  return {
    ok: unmatched.length === 0,
    fileName: `session-receipt-reconcile-seed-${String(nowIso).replace(/[:.]/g, '-')}.json`,
    receipt: {
      schema: 'amy.session_receipt_reconcile_seed.v1',
      stage: 'seeded',
      seeded_at: nowIso,
      cloud_unverified_terminal: Object.values(pendingBySource).reduce((sum, ids) => sum + ids.length, 0),
      seeded,
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
  try {
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);

  const bucket = dry ? '(dry)' : sessionsBucket();
  if (!dry && !bucket) {
    console.error('[session-sweep] cannot resolve S3 bucket (no SECONDBRAIN_SESSIONS_BUCKET, sts failed)');
    process.exit(1);
  }
  const reconcileSourceIds = new Set();
  if (!dry && process.argv.includes('--reconcile-cloud-pending')) {
    const reconcile = reconcileCloudPendingReceipts(nowIso, only);
    console.log(`[session-sweep] reconcile-cloud-pending ${JSON.stringify(reconcile)}`);
    if (!reconcile.ok) process.exitCode = 1;
    for (const row of reconcile.seeded || []) reconcileSourceIds.add(row.source_id);
  }

  const windowSources = discoverSessionSources({
    tasksDir: TASKS_DIR,
    nowMs,
    selectWindowMs: only ? Number.MAX_SAFE_INTEGER : discoveryWindow(nowMs),
  }).filter((source) => !only || source.session_id === only);
  const sources = selectSweepSources({
    windowSources,
    allSources: reconcileSourceIds.size
      ? discoverSessionSources({ tasksDir: TASKS_DIR, nowMs, selectWindowMs: Number.MAX_SAFE_INTEGER })
      : [],
    reconcileSourceIds,
    onlySessionId: only,
  });
  const providers = sources.reduce((counts, source) => {
    counts[source.provider] = (counts[source.provider] || 0) + 1;
    return counts;
  }, {});
  const latestDiscoveredSource = selectLatestSource(sources);
  const latestSource = latestDiscoveredSource ? sourceWithDeliveryBoundary(latestDiscoveredSource) : null;
  const latestSourceAt = latestSource?.updated_at || null;
  // Heartbeat first: a retained backlog must never make a current producer
  // look offline while FIFO batch delivery catches up behind it.
  let heartbeat = { ok: true, dry: true };
  let heartbeatArchive = { ok: true, dry: true };
  let lastHeartbeatMs = nowMs;
  const refreshHeartbeat = () => {
    const refreshedAt = new Date().toISOString();
    const refreshed = publishProducerHeartbeat({
      bucket, nowIso: refreshedAt, latestSourceAt, latestSource, providers,
      sourceCount: sources.length, pendingOutbox: countPendingSessionEvents({ dataDir: DATA_DIR }),
    });
    heartbeat = refreshed.heartbeat;
    heartbeatArchive = refreshed.heartbeatArchive;
    lastHeartbeatMs = Date.parse(refreshedAt);
  };
  if (!dry) {
    refreshHeartbeat();
  }
  const results = [];
  let initialDrain = { attempted: 0, delivered: 0, failed: 0, remaining: 0 };
  const heartbeatBetweenBatches = async () => {
    if (Date.now() - lastHeartbeatMs >= SESSION_CLOUD_HEARTBEAT_CADENCE_MS) refreshHeartbeat();
  };
  if (!dry) initialDrain = await drainOutbox(new Date(nowIso), { onBatch: heartbeatBetweenBatches });
  for (const source of sources) {
    try {
      results.push(sweepSource(source, bucket, nowIso, dry));
    } catch (e) {
      results.push({ provider: source.provider, sessionId: source.session_id, source: source.source_kind, error: (e && e.message) || 'unknown' });
    }
  }
  let finalDrain = { attempted: 0, delivered: 0, failed: 0, remaining: 0 };
  if (!dry) finalDrain = await drainOutbox(new Date(nowIso), { onBatch: heartbeatBetweenBatches });

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
  return { deferred: false, pendingOutbox, errors: err };
  } finally {
    lease?.release();
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[session-sweep] fatal: ${String(error?.message || error)}`);
    process.exitCode = 1;
  });
}
