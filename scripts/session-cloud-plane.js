#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  ingestSessionEvent,
  ingestSessionEventBatch,
  computeSessionCloudHealth,
  reconcileSessionDerivedWork,
  recordSessionProducerHeartbeat,
  sessionCloudPaths,
} = require('./lib/session-cloud-plane.js');

const REPO_ROOT = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const DATA_DIR = process.env.SECONDBRAIN_DATA_DIR || (fs.existsSync('/opt/secondbrain')
  ? '/opt/secondbrain/data'
  : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'secondbrain', 'data'));
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

function readStdin() {
  return fs.readFileSync(0, 'utf8').trim();
}

function parseStdinJson() {
  const text = readStdin();
  if (!text) throw new Error('JSON stdin payload is required');
  return JSON.parse(text);
}

function sessionsBucket() {
  if (process.env.SECONDBRAIN_SESSIONS_BUCKET) return process.env.SECONDBRAIN_SESSIONS_BUCKET;
  const identity = spawnSync('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], {
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  const account = String(identity.stdout || '').trim();
  return account ? `secondbrain-sessions-${account}-${REGION}` : '';
}

// The S3 heartbeat is a fallback for the SSH heartbeat and its freshness window
// is 20 minutes, so the two-minute reconcile checks it at most this often. Each
// check spawns several aws CLI processes (a Python start each).
const S3_HEARTBEAT_MIN_INTERVAL_MS = 10 * 60 * 1000;

function s3SyncStateFile(dataDir = DATA_DIR) {
  return path.join(sessionCloudPaths(dataDir).root, 's3-heartbeat-sync.json');
}

function syncS3ProducerHeartbeatRateLimited({ dataDir = DATA_DIR, now = Date.now(), minIntervalMs = S3_HEARTBEAT_MIN_INTERVAL_MS, sync = syncS3ProducerHeartbeat } = {}) {
  const file = s3SyncStateFile(dataDir);
  let state = null;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  if (state?.ok === true && now - Number(state.synced_at_ms || 0) < minIntervalMs && now >= Number(state.synced_at_ms || 0)) {
    return { ok: true, skipped: true, reason: 'S3 heartbeat checked within the last 10 minutes' };
  }
  const result = sync();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ synced_at_ms: now, ok: result?.ok === true }), { mode: 0o600 });
  } catch { /* the limiter is an optimization */ }
  return result;
}

function syncS3ProducerHeartbeat() {
  const bucket = sessionsBucket();
  if (!bucket) return { ok: false, reason: 'sessions bucket unavailable' };
  const listing = spawnSync('aws', [
    's3api', 'list-objects-v2', '--bucket', bucket, '--prefix', 'session-cloud/producer-heartbeats/',
    '--query', 'Contents[].Key', '--output', 'json',
  ], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (listing.status !== 0) return { ok: false, reason: String(listing.stderr || 'heartbeat list failed').slice(0, 500) };
  let keys = [];
  try {
    keys = JSON.parse(listing.stdout || '[]') || [];
  } catch {
    return { ok: false, reason: 'heartbeat list returned invalid JSON' };
  }
  let newest = null;
  for (const key of keys.slice(-50)) {
    const object = spawnSync('aws', ['s3', 'cp', `s3://${bucket}/${key}`, '-'], {
      encoding: 'utf8', timeout: 20_000, windowsHide: true,
    });
    if (object.status !== 0) continue;
    try {
      const row = JSON.parse(object.stdout || '{}');
      if (!newest || Date.parse(row.observed_at || '') > Date.parse(newest.observed_at || '')) newest = row;
    } catch {
      // One malformed producer object cannot suppress another valid receipt.
    }
  }
  if (!newest) return { ok: false, reason: 'no valid S3 producer heartbeat exists' };
  return { ok: true, heartbeat: newest, health: recordSessionProducerHeartbeat(newest, { dataDir: DATA_DIR }) };
}

function repoLabel(event) {
  const cwd = String(event.execution?.cwd || '').replace(/[\\/]+$/, '');
  const repo = path.basename(cwd) || 'unknown';
  return `${event.provider}:${repo}`;
}

function indexVisibleText(event) {
  const script = path.join(REPO_ROOT, 'scripts', 'session-fts.py');
  const db = path.join(DATA_DIR, 'session-fts.sqlite');
  const result = spawnSync(
    process.env.PYTHON || 'python3',
    [
      script,
      '--db',
      db,
      'index',
      '--session',
      String(event.session_id),
      '--repo',
      repoLabel(event),
      '--start',
      String(event.raw?.byte_start || 0),
      '--end',
      String(event.raw?.byte_end || event.source_sequence || 0),
      '--ts',
      String(event.occurred_at || ''),
      '--event-id',
      String(event.event_id || ''),
    ],
    {
      input: String(event.visible_text || ''),
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    return { ok: false, reason: String(result.stderr || result.error?.message || 'session FTS failed').slice(0, 1000) };
  }
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    return {
      ok: parsed.indexed === true || parsed.reason === 'duplicate-range' || parsed.reason === 'duplicate-event',
      result: parsed,
    };
  } catch {
    return { ok: false, reason: 'session FTS returned invalid JSON' };
  }
}

function writeGraphiti(event) {
  let policy = null;
  try { policy = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'graphiti-runtime-policy.json'), 'utf8')); } catch {}
  if (policy?.state !== 'enabled' || policy?.ingestion_state !== 'enabled') {
    return { skipped: true, reason: 'Graphiti ingestion policy is disabled' };
  }
  const cli = path.join(REPO_ROOT, 'scripts', 'graphiti-cli.mjs');
  const name = `session:${event.provider}:${event.session_id}:activity:${event.activity_id}:seq:${event.source_sequence}`;
  const body = [
    `${event.provider} session activity in ${repoLabel(event)}.`,
    event.prompt_summary ? `Owner request: ${event.prompt_summary}` : '',
    event.result_summary
      ? `Terminal result: ${event.result_summary}`
      : event.progress_summary
        ? `Latest progress: ${event.progress_summary}`
        : '',
    event.visible_text || '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 7000);
  const result = spawnSync(
    process.execPath,
    [cli, 'add', '--name', name, '--body', body, '--source', 'session-checkpoint', '--time', String(event.occurred_at || '')],
    { encoding: 'utf8', timeout: 45_000, windowsHide: true },
  );
  return result.status === 0 && /(^|\n)ok\b/.test(result.stdout || '')
    ? { ok: true }
    : { ok: false, reason: String(result.stderr || result.error?.message || 'Graphiti checkpoint failed').slice(0, 1000) };
}

function ingestEvent(event, { dataDir = DATA_DIR, index = indexVisibleText, graphiti = writeGraphiti, now } = {}) {
  return ingestSessionEvent(event, {
    dataDir,
    indexVisibleText: index,
    writeGraphiti: graphiti,
    ...(now ? { now } : {}),
    recomputeHealth: false,
  });
}

function ingestBatch(events, { dataDir = DATA_DIR, index = indexVisibleText, graphiti = writeGraphiti, now } = {}) {
  return ingestSessionEventBatch(events, {
    dataDir,
    indexVisibleText: index,
    writeGraphiti: graphiti,
    ...(now ? { now } : {}),
    recomputeHealth: false,
  });
}

function emit(value, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exitCode = exitCode;
}

// Only validation failures may be isolated by the desktop outbox. A lease,
// disk, timeout, or malformed response is ambiguous and retains the FIFO batch.
function isDefinitiveIngressError(error) {
  const reason = String(error?.message || error || '');
  return /^(unsupported session event schema|session event provider, session_id, and activity_id are required|session event_id is missing or unsafe|session event must not include local outbox transport metadata|session ingest batch must contain|session ingest batch repeats event_id|session event_id .* conflicts with a different durable event)/.test(reason);
}

function main() {
  const command = process.argv[2] || 'health';
  if (command === 'ingest') {
    // The producer needs the exact event receipt, not an O(all receipts) health
    // rebuild. Heartbeat, health, and reconcile own aggregate health snapshots.
    emit(ingestEvent(parseStdinJson()));
    return;
  }
  if (command === 'ingest-batch') {
    const payload = parseStdinJson();
    emit(ingestBatch(payload?.events));
    return;
  }
  if (command === 'heartbeat') {
    emit({ ok: true, health: recordSessionProducerHeartbeat(parseStdinJson(), { dataDir: DATA_DIR }) });
    return;
  }
  if (command === 'reconcile') {
    const producerHeartbeat = syncS3ProducerHeartbeatRateLimited();
    emit({ ok: true, producer_heartbeat: producerHeartbeat, ...reconcileSessionDerivedWork({ dataDir: DATA_DIR, indexVisibleText, writeGraphiti }) });
    return;
  }
  if (command === 'health') {
    const producerHeartbeat = syncS3ProducerHeartbeat();
    const health = computeSessionCloudHealth({ dataDir: DATA_DIR });
    const paths = sessionCloudPaths(DATA_DIR);
    fs.mkdirSync(path.dirname(paths.health), { recursive: true });
    fs.writeFileSync(paths.health, `${JSON.stringify(health, null, 2)}\n`, { mode: 0o600 });
    emit({ ok: true, producer_heartbeat: producerHeartbeat, health });
    return;
  }
  throw new Error(`unknown session cloud command: ${command}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    emit({ ok: false, reason: String(error?.message || error), definitive: isDefinitiveIngressError(error) }, 1);
  }
}

module.exports = { indexVisibleText, isDefinitiveIngressError, sessionsBucket, syncS3ProducerHeartbeat, syncS3ProducerHeartbeatRateLimited, writeGraphiti, ingestEvent, ingestBatch };
