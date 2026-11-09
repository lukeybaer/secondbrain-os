'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { atomicWriteJson, runtimeDataDir } = require('./session-event-outbox.js');
const { acquireSingleHostLease } = require('./session-sweep-lease.js');
const { readWorkerHeartbeat } = require('./desktop-worker-heartbeat.js');

const PROJECTION_SCHEMA = 'amy.session_projection.v1';
const HEALTH_SCHEMA = 'amy.session_cloud_health.v1';
const TERMINAL_TYPES = new Set(['activity_completed', 'activity_failed', 'activity_cancelled']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TRANSCRIPT_MISSING = 'transcript_missing';
// A resolved missing transcript keeps the row yellow this long, so it is seen
// before it settles into the green row's labeled count.
const TRANSCRIPT_MISSING_VISIBLE_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_STATS_VERSION = 2;
const DEFAULT_LAG_RED_MS = 10 * 60 * 1000;
const DEFAULT_HEARTBEAT_FRESH_MS = 20 * 60 * 1000;
const MAX_INGEST_BATCH_SIZE = 100;
// An asleep PC owes no delivery, but a backup more than a day behind is red regardless.
const ASLEEP_LAG_RED_MS = 24 * 60 * 60 * 1000;

function sessionCloudPaths(dataDir) {
  const root = path.join(runtimeDataDir(dataDir), 'agent', 'session-cloud');
  return {
    root,
    ledger: path.join(root, 'events.jsonl'),
    projection: path.join(root, 'projection.json'),
    voiceProjection: path.join(root, 'voice-projection.json'),
    receipts: path.join(root, 'receipts'),
    heartbeat: path.join(root, 'producer-heartbeat.json'),
    health: path.join(root, 'health-latest.json'),
  };
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function appendJsonlFsync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function safeEventId(value) {
  const id = String(value || '').trim();
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(id)) throw new Error('session event_id is missing or unsafe');
  return id;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function eventFingerprint(event) {
  return crypto.createHash('sha256').update(canonicalJson(event)).digest('hex');
}

function validateSessionEvent(event) {
  if (!event || event.schema !== 'amy.session_event.v1') throw new Error('unsupported session event schema');
  if (!event.provider || !event.session_id || !event.activity_id) {
    throw new Error('session event provider, session_id, and activity_id are required');
  }
  safeEventId(event.event_id);
  if (Object.prototype.hasOwnProperty.call(event, 'outbox')) {
    throw new Error('session event must not include local outbox transport metadata');
  }
}

function emptyProjection() {
  return {
    schema: PROJECTION_SCHEMA,
    updated_at: null,
    sessions: {},
    activities: {},
  };
}

function readSessionProjection({ dataDir } = {}) {
  const value = readJson(sessionCloudPaths(dataDir).projection, null);
  if (!value || value.schema !== PROJECTION_SCHEMA) return emptyProjection();
  return {
    ...emptyProjection(),
    ...value,
    sessions: value.sessions && typeof value.sessions === 'object' ? value.sessions : {},
    activities: value.activities && typeof value.activities === 'object' ? value.activities : {},
  };
}

// Voice lookups read the projection on every check_spine and read_session
// call. The full file (243 MB on 2026-10-28) took ~3 s to parse, blocking the
// event loop, three times per read_session. The voice copy keeps only sessions
// the voice windows can show (owner 7 days, automated 24 h, anything still
// running) and drops the activity fields voice never reads; it is ~75 MB and
// parses in ~0.3 s. Same schema, so every reader works on either file.
const VOICE_PROJECTION_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;
const VOICE_DROPPED_ACTIVITY_FIELDS = ['terminal_receipt', 'raw', 'execution'];

// Codex rows carry a raw epoch (seconds or ms) where Claude rows carry ISO.
function epochMs(value) {
  if (value == null || value === '') return NaN;
  const numeric = typeof value === 'number' ? value : (/^\d{10}(\d{3})?$/.test(String(value).trim()) ? Number(value) : NaN);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  return Date.parse(value);
}

function latestMs(...values) {
  let best = -Infinity;
  for (const value of values) {
    const ms = epochMs(value);
    if (Number.isFinite(ms) && ms > best) best = ms;
  }
  return best;
}

function buildVoiceProjection(projection, now = new Date(), sourceKey = null) {
  const cutoff = now.getTime() - VOICE_PROJECTION_WINDOW_MS;
  const activityLatest = new Map();
  for (const activity of Object.values(projection.activities || {})) {
    const key = `${activity.provider}:${activity.session_id}`;
    const ms = latestMs(activity.updated_at, activity.occurred_at, activity.last_observed_at);
    if (ms > (activityLatest.get(key) ?? -Infinity)) activityLatest.set(key, ms);
  }
  const sessions = {};
  for (const [key, session] of Object.entries(projection.sessions || {})) {
    const running = String(session.status || '').toLowerCase() === 'running' || Number(session.active_activity_count || 0) > 0;
    const seenMs = Math.max(latestMs(session.updated_at, session.last_observed_at), activityLatest.get(key) ?? -Infinity);
    // Undated rows stay: the voice readers' age filters skip them too.
    if (running || seenMs >= cutoff || seenMs === -Infinity) sessions[key] = session;
  }
  const activities = {};
  for (const [id, activity] of Object.entries(projection.activities || {})) {
    if (!sessions[`${activity.provider}:${activity.session_id}`]) continue;
    const slim = { ...activity };
    for (const field of VOICE_DROPPED_ACTIVITY_FIELDS) delete slim[field];
    activities[id] = slim;
  }
  return {
    ...projection,
    voice_window_ms: VOICE_PROJECTION_WINDOW_MS,
    voice_built_at: now.toISOString(),
    ...(sourceKey ? { voice_source_key: sourceKey } : {}),
    sessions,
    activities,
  };
}

// One parsed copy per file, reused until the file's (mtime, size, inode)
// changes. The ingest writer replaces both files atomically, so a changed key
// always means a whole new file.
const projectionCache = new Map();

function cachedProjectionFile(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const key = fileKey(stat);
  const hit = projectionCache.get(file);
  if (hit && hit.key === key) return hit;
  const value = readJson(file, null);
  if (!value || value.schema !== PROJECTION_SCHEMA) return null;
  const entry = {
    key,
    mtimeMs: stat.mtimeMs,
    value: {
      ...emptyProjection(),
      ...value,
      sessions: value.sessions && typeof value.sessions === 'object' ? value.sessions : {},
      activities: value.activities && typeof value.activities === 'object' ? value.activities : {},
    },
  };
  projectionCache.set(file, entry);
  return entry;
}

// The voice copy when it was built from the full projection now on disk (it
// records that file's mtime, size and inode); otherwise (missing, unreadable,
// or left behind by a failed write) the full projection, cached the same way.
// Callers must treat the result as read-only.
function readVoiceProjection({ dataDir } = {}) {
  const paths = sessionCloudPaths(dataDir);
  let fullKey = null;
  try { fullKey = fileKey(fs.statSync(paths.projection)); } catch { /* none */ }
  const voice = cachedProjectionFile(paths.voiceProjection);
  if (voice && fullKey && voice.value.voice_source_key === fullKey) {
    // The full copy is only a fallback; do not hold both in memory.
    projectionCache.delete(paths.projection);
    return voice.value;
  }
  return readFullProjectionCached({ dataDir });
}

function readFullProjectionCached({ dataDir } = {}) {
  const full = cachedProjectionFile(sessionCloudPaths(dataDir).projection);
  return full ? full.value : emptyProjection();
}

function activityStatus(event) {
  if (event.type === 'activity_completed') return 'completed';
  if (event.type === 'activity_failed') return 'failed';
  if (event.type === 'activity_cancelled') return 'cancelled';
  if (event.type === 'receipt_confirmed') return '';
  return 'running';
}

function eventIsNewer(event, current) {
  const revision = Number(event.source_revision || 0);
  const currentRevision = Number(current?.source_revision || 0);
  if (revision !== currentRevision) return revision > currentRevision;
  const sequence = Number(event.source_sequence || 0);
  const currentSequence = Number(current?.source_sequence || 0);
  if (sequence !== currentSequence) return sequence > currentSequence;
  return (Date.parse(event.occurred_at || '') || 0) >= (Date.parse(current?.updated_at || '') || 0);
}

// Who started the session (owner or automated) and the name the app shows for
// it. Both are sticky: once known they survive events that omit them.
function identityFields(event, prior = {}) {
  const initiator = event.initiator || prior.initiator || '';
  const sessionTitle = event.session_title || prior.session_title || '';
  return {
    ...(initiator ? { initiator } : {}),
    ...(sessionTitle ? { session_title: sessionTitle } : {}),
  };
}

// What the owner asked the session, carried on identity checkpoints. Session-level
// only, and an older scan never replaces a newer one.
function digestFields(event, prior = {}) {
  if (!Array.isArray(event.owner_prompts) && !event.intent) return {};
  if (prior.digest_at && String(event.digest_at || '') < String(prior.digest_at)) return {};
  return {
    owner_prompts: Array.isArray(event.owner_prompts) ? event.owner_prompts.slice(0, 12) : [],
    intent: String(event.intent || '').slice(0, 1000),
    digest_at: event.digest_at || event.observed_at || '',
  };
}

function projectSessionEvent(projection, event, committedAt) {
  const activityKey = `${event.provider}:${event.session_id}:${event.activity_id}`;
  const sessionKey = `${event.provider}:${event.session_id}`;
  if (event.type === 'source_checkpoint') {
    const prior = projection.sessions[sessionKey] || {};
    projection.sessions[sessionKey] = {
      ...prior,
      provider: event.provider,
      session_id: event.session_id,
      title: event.title || prior.title || `${event.provider} session`,
      ...identityFields(event, prior),
      ...digestFields(event, prior),
      status: prior.status || 'observed',
      updated_at: event.occurred_at || committedAt,
      last_observed_at: event.observed_at || committedAt,
      source_available: true,
      active_activity_count: Number(prior.active_activity_count || 0),
      activity_count: Number(prior.activity_count || 0),
    };
    projection.updated_at = committedAt;
    return projection;
  }
  const current = projection.activities[activityKey] || null;
  const incomingStatus = activityStatus(event);
  const currentTerminal = TERMINAL_STATUSES.has(String(current?.status || ''));
  const incomingTerminal = TERMINAL_TYPES.has(event.type);

  let next = current ? { ...current } : {
    provider: event.provider,
    session_id: event.session_id,
    activity_id: event.activity_id,
    source_id: event.source_id || '',
    source_kind: event.source_kind || 'main',
    status: 'running',
    terminal_receipt_verified: false,
  };

  if (event.type === 'receipt_confirmed') {
    if (event.terminal_receipt?.verified === true) {
      next.terminal_receipt_verified = true;
      next.terminal_receipt = event.terminal_receipt;
      next.terminal_receipt_at = event.terminal_receipt.replicated_at || committedAt;
      delete next.terminal_receipt_resolution;
      delete next.terminal_receipt_resolved_at;
    } else if (
      event.terminal_receipt?.resolution === TRANSCRIPT_MISSING &&
      next.terminal_receipt_verified !== true &&
      TERMINAL_STATUSES.has(String(next.status || ''))
    ) {
      // Ended, transcript missing: the producer that owns this source found no
      // transcript left to verify. Labeled, never counted as a verified receipt.
      next.terminal_receipt_resolution = TRANSCRIPT_MISSING;
      next.terminal_receipt_resolved_at = event.terminal_receipt.checked_at || event.observed_at || committedAt;
      next.terminal_receipt = event.terminal_receipt;
    }
  } else if ((!currentTerminal || incomingTerminal) && eventIsNewer(event, current)) {
    next = {
      ...next,
      provider: event.provider,
      session_id: event.session_id,
      activity_id: event.activity_id,
      parent_session_id: event.parent_session_id || null,
      source_id: event.source_id || '',
      source_kind: event.source_kind || 'main',
      title: event.title || next.title || `${event.provider} session`,
      ...identityFields(event, next),
      status: incomingStatus || next.status,
      prompt_summary: event.prompt_summary || next.prompt_summary || '',
      progress_summary: event.progress_summary || next.progress_summary || '',
      result_summary: event.result_summary || next.result_summary || '',
      execution: event.execution || next.execution || {},
      raw: event.raw || next.raw || {},
      source_sequence: Number(event.source_sequence || 0),
      source_revision: Number(event.source_revision || 0),
      occurred_at: event.occurred_at,
      updated_at: event.occurred_at || committedAt,
      last_observed_at: event.observed_at || committedAt,
      ...(incomingTerminal ? { completed_at: event.occurred_at || committedAt } : {}),
      ...(incomingTerminal && event.terminal_receipt
        ? {
            terminal_receipt_verified: event.terminal_receipt.verified === true,
            terminal_receipt: event.terminal_receipt,
            terminal_receipt_at: event.terminal_receipt.verified
              ? event.terminal_receipt.replicated_at || committedAt
              : null,
          }
        : {}),
    };
  }
  projection.activities[activityKey] = next;

  const sessionActivities = Object.values(projection.activities)
    .filter((item) => item.provider === event.provider && item.session_id === event.session_id)
    .sort((a, b) => (Date.parse(b.updated_at || '') || 0) - (Date.parse(a.updated_at || '') || 0));
  const active = sessionActivities.filter((item) => item.status === 'running');
  const latest = sessionActivities[0] || next;
  const priorSession = projection.sessions[sessionKey] || {};
  projection.sessions[sessionKey] = {
    ...priorSession,
    provider: event.provider,
    session_id: event.session_id,
    title: latest.title || priorSession.title || `${event.provider} session`,
    ...identityFields(event, { ...priorSession, ...identityFields(latest, priorSession) }),
    status: active.length ? 'running' : latest.status || 'recent',
    updated_at: latest.updated_at || committedAt,
    last_observed_at: event.observed_at || latest.last_observed_at || committedAt,
    source_available: true,
    active_activity_count: active.length,
    activity_count: sessionActivities.length,
    latest_activity_id: latest.activity_id,
    latest_result_summary: latest.result_summary || '',
    latest_terminal_receipt_verified: latest.terminal_receipt_verified === true,
  };
  projection.updated_at = committedAt;
  return projection;
}

function callDerived(fn, event, kind) {
  if (!event.visible_text || !String(event.visible_text).trim()) {
    return { status: 'skipped', updated_at: null, reason: 'no visible prompt/response text' };
  }
  if (typeof fn !== 'function') {
    return { status: 'pending', updated_at: null, reason: `${kind} executor unavailable` };
  }
  try {
    const result = fn(event);
    if (result?.skipped === true) return { status: 'skipped', updated_at: null, reason: String(result.reason || `${kind} policy-disabled`).slice(0, 1000) };
    if (result?.ok === true) return { status: 'succeeded', updated_at: new Date().toISOString(), result };
    return { status: 'pending', updated_at: null, reason: String(result?.reason || `${kind} failed`).slice(0, 1000) };
  } catch (error) {
    return { status: 'pending', updated_at: null, reason: String(error?.message || error).slice(0, 1000) };
  }
}

function receiptFile(paths, eventId) {
  return path.join(paths.receipts, `${safeEventId(eventId)}.json`);
}

function processDerived(receipt, { indexVisibleText, writeGraphiti, now = new Date() } = {}) {
  const next = { ...receipt, derived: { ...(receipt.derived || {}) } };
  if (!next.derived.fts || next.derived.fts.status === 'pending') {
    next.derived.fts = callDerived(indexVisibleText, next.event, 'fts');
    if (next.derived.fts.status === 'succeeded') next.derived.fts.updated_at = now.toISOString();
  }
  if (!next.derived.graphiti || next.derived.graphiti.status === 'pending') {
    next.derived.graphiti = callDerived(writeGraphiti, next.event, 'graphiti');
    if (next.derived.graphiti.status === 'succeeded') next.derived.graphiti.updated_at = now.toISOString();
  }
  next.updated_at = now.toISOString();
  return next;
}

function prepareSessionEvent(event, paths, now) {
  validateSessionEvent(event);
  const file = receiptFile(paths, event.event_id);
  const fingerprint = eventFingerprint(event);
  let receipt = readJson(file, null);
  const duplicate = Boolean(receipt);
  if (receipt) {
    const existingFingerprint = receipt.event_sha256 || eventFingerprint(receipt.event || {});
    if (receipt.event_id !== event.event_id || existingFingerprint !== fingerprint) {
      throw new Error(`session event_id ${safeEventId(event.event_id)} conflicts with a different durable event`);
    }
    return { event, file, receipt, duplicate, fingerprint };
  }
  const preparedAt = now.toISOString();
  appendJsonlFsync(paths.ledger, event);
  // This is an idempotency prepare record, not an acknowledgement: projection
  // durability still precedes a committed receipt returned to the producer.
  receipt = {
    schema: 'amy.session_event_cloud_receipt.v1',
    receipt_id: `session-cloud:${event.event_id}`,
    event_id: event.event_id,
    event_sha256: fingerprint,
    status: 'prepared',
    prepared_at: preparedAt,
    updated_at: preparedAt,
    event,
    derived: {},
  };
  atomicWriteJson(file, receipt);
  return { event, file, receipt, duplicate, fingerprint };
}

function committedAtForReceipt(receipt, now) {
  return receiptIsCommitted(receipt) ? receipt.committed_at : now.toISOString();
}

// The projection is the largest file in the store; indented output doubled its
// size and its stringify cost on every ingest batch. Readers JSON.parse it.
function writeCompactProjection(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return file;
}

function applySessionEventBatch(events, {
  dataDir,
  now = new Date(),
  indexVisibleText,
  writeGraphiti,
  recomputeHealth = true,
  readProjection = readSessionProjection,
  writeProjection = writeCompactProjection,
  writeVoiceProjection = writeCompactProjection,
} = {}) {
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_INGEST_BATCH_SIZE) {
    throw new Error(`session ingest batch must contain 1-${MAX_INGEST_BATCH_SIZE} events`);
  }
  const ids = new Set();
  for (const event of events) {
    validateSessionEvent(event);
    if (ids.has(event.event_id)) throw new Error(`session ingest batch repeats event_id ${safeEventId(event.event_id)}`);
    ids.add(event.event_id);
  }
  const paths = sessionCloudPaths(dataDir);
  const prepared = events.map((event) => prepareSessionEvent(event, paths, now));
  // Replaying a prepared or committed idempotent event repairs a projection
  // interrupted before its sole batch write. The projection is durable before
  // any committed receipt can be returned for local outbox acknowledgement.
  let projection = readProjection({ dataDir });
  for (const item of prepared) {
    projection = projectSessionEvent(
      projection,
      item.event,
      committedAtForReceipt(item.receipt, now),
    );
  }
  writeProjection(paths.projection, projection);
  try {
    const sourceKey = fileKey(fs.statSync(paths.projection));
    writeVoiceProjection(paths.voiceProjection, buildVoiceProjection(projection, now, sourceKey));
  } catch (error) {
    // Voice falls back to the full projection when its copy is older.
    console.warn('[session-cloud] voice projection write failed:', error.message);
  }
  const results = prepared.map((item) => {
    // A prepared record has no cloud-save time: commit time starts only after
    // the batch projection has reached durable storage. Older staged records
    // used committed_at as their prepare timestamp; do not preserve it.
    const committedAt = committedAtForReceipt(item.receipt, now);
    const receipt = processDerived(
      { ...item.receipt, status: 'committed', committed_at: committedAt },
      { indexVisibleText, writeGraphiti, now },
    );
    atomicWriteJson(item.file, receipt);
    return {
      ok: true,
      receipt_id: receipt.receipt_id,
      event_id: item.event.event_id,
      committed_at: receipt.committed_at,
      duplicate: item.duplicate,
      derived: receipt.derived,
    };
  });
  if (recomputeHealth) {
    const health = computeSessionCloudHealth({ dataDir, now });
    atomicWriteJson(paths.health, health);
  }
  return results;
}

function applySessionEvent(event, options = {}) {
  return applySessionEventBatch([event], options)[0];
}

function ingestSessionEvent(event, options = {}) {
  const { dataDir, lease: leaseOptions = {}, ...applyOptions } = options;
  const lease = acquireSingleHostLease({
    root: path.join(runtimeDataDir(dataDir), 'agent', 'session-cloud', 'ingest-lease'),
    schema: 'amy.session_cloud_ingest_lease.v1',
    ...leaseOptions,
  });
  if (!lease.acquired) return { ok: false, reason: 'session cloud ingest busy; retain outbox event for replay' };
  try {
    return applySessionEvent(event, { dataDir, ...applyOptions });
  } finally {
    lease.release();
  }
}

function ingestSessionEventBatch(events, options = {}) {
  const { dataDir, lease: leaseOptions = {}, ...applyOptions } = options;
  const lease = acquireSingleHostLease({
    root: path.join(runtimeDataDir(dataDir), 'agent', 'session-cloud', 'ingest-lease'),
    schema: 'amy.session_cloud_ingest_lease.v1',
    ...leaseOptions,
  });
  if (!lease.acquired) return { ok: false, reason: 'session cloud ingest busy; retain outbox events for replay' };
  try {
    return { ok: true, results: applySessionEventBatch(events, { dataDir, ...applyOptions }) };
  } finally {
    lease.release();
  }
}

function summarizeReceipt(receipt) {
  if (!receipt) return null;
  const committed = receiptIsCommitted(receipt);
  return {
    event_id: receipt.event_id,
    committed_at: receipt.committed_at,
    occurred_at: receipt.event?.occurred_at,
    source_id: receipt.event?.source_id,
    source_sequence: Number(receipt.event?.source_sequence || 0),
    raw_byte_end: Number(receipt.event?.raw?.byte_end || 0),
    has_visible_text: Boolean(String(receipt.event?.visible_text || '').trim()),
    derived: receipt.derived,
    status: receipt.status || (committed ? 'legacy-committed' : 'invalid'),
    committed,
  };
}

const RECEIPT_INDEX_SCHEMA = 'amy.session_receipt_index.v1';

function fileKey(stat) {
  return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
}

function writeCompactJson(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Health and redrive selection need metadata, not every transcript body. The
// summaries persist beside the receipts keyed by each file's (mtime, size,
// inode); atomic receipt writes always change the key, so a changed or new
// receipt is re-read and an unchanged one is never re-parsed. A missing or
// corrupt index only costs one full rebuild.
function listReceiptSummaries(dataDir) {
  const paths = sessionCloudPaths(dataDir);
  const dir = paths.receipts;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const indexFile = path.join(paths.root, 'receipt-index.json');
  const stored = readJson(indexFile, null);
  const prior = stored?.schema === RECEIPT_INDEX_SCHEMA && stored.entries && typeof stored.entries === 'object' ? stored.entries : {};
  const entries = {};
  const out = [];
  let dirty = Object.keys(prior).length !== names.length;
  for (const name of names) {
    const file = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(file); } catch { dirty = true; continue; }
    const key = fileKey(stat);
    const hit = prior[name];
    let summary;
    if (hit && hit.key === key) {
      summary = hit.summary;
    } else {
      summary = summarizeReceipt(readJson(file, null));
      dirty = true;
    }
    if (!summary) continue;
    entries[name] = { key, summary };
    out.push(summary);
  }
  if (dirty) {
    try {
      writeCompactJson(indexFile, { schema: RECEIPT_INDEX_SCHEMA, entries });
    } catch {
      // The index is a cache; health must not fail because it could not persist.
    }
  }
  return out;
}

function receiptIsCommitted(receipt) {
  if (!receipt || typeof receipt !== 'object') return false;
  if (receipt.status === 'committed') return true;
  // Before batch staging, receipts were written only after the projection
  // write and had this complete shape but no explicit status. Do not infer
  // commitment from a partial/prepared-looking JSON object.
  if (Object.prototype.hasOwnProperty.call(receipt, 'status')) return false;
  try {
    const eventId = safeEventId(receipt.event_id);
    return receipt.schema === 'amy.session_event_cloud_receipt.v1'
      && receipt.receipt_id === `session-cloud:${eventId}`
      && Number.isFinite(Date.parse(receipt.committed_at || ''))
      && receipt.event?.schema === 'amy.session_event.v1'
      && receipt.event?.event_id === eventId;
  } catch {
    return false;
  }
}

function maxIso(values) {
  let best = null;
  let bestMs = -Infinity;
  for (const value of values) {
    const ms = Date.parse(value || '');
    if (Number.isFinite(ms) && ms > bestMs) {
      best = value;
      bestMs = ms;
    }
  }
  return best;
}

function heartbeatSourceProof(heartbeat) {
  const source = heartbeat?.latest_source;
  const byteEnd = source?.byte_end;
  if (!source?.source_id || typeof byteEnd !== 'number' || !Number.isFinite(byteEnd) || byteEnd < 0) return null;
  const rawBytes = Number(source?.raw_bytes);
  return {
    source_id: String(source.source_id), byte_end: byteEnd,
    raw_bytes: Number.isFinite(rawBytes) && rawBytes >= byteEnd ? rawBytes : null,
    updated_at: source.updated_at || null,
  };
}

function ageLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown age';
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

// Terminal-activity debt comes from the projection, which is large and only
// changes on ingest. Cache the derived counts keyed by the projection file.
function readTerminalStats(dataDir) {
  const paths = sessionCloudPaths(dataDir);
  const cacheFile = path.join(paths.root, 'projection-terminal-cache.json');
  let key = null;
  try { key = fileKey(fs.statSync(paths.projection)); } catch { /* no projection yet */ }
  const cached = key ? readJson(cacheFile, null) : null;
  if (cached && cached.key === key && cached.version === TERMINAL_STATS_VERSION && Array.isArray(cached.pending)) return cached;
  const projection = readSessionProjection({ dataDir });
  const terminal = Object.values(projection.activities || {}).filter((activity) => TERMINAL_STATUSES.has(String(activity.status || '')));
  const unverified = terminal.filter((activity) => activity.terminal_receipt_verified !== true);
  const missing = unverified.filter((activity) => activity.terminal_receipt_resolution === TRANSCRIPT_MISSING);
  const stats = {
    key,
    version: TERMINAL_STATS_VERSION,
    total: terminal.length,
    pending: unverified
      .filter((activity) => activity.terminal_receipt_resolution !== TRANSCRIPT_MISSING)
      .map((activity) => Date.parse(activity.completed_at || activity.updated_at || '') || null),
    transcript_missing: missing
      .map((activity) => Date.parse(activity.terminal_receipt_resolved_at || activity.completed_at || '') || null),
  };
  if (key) {
    try { writeCompactJson(cacheFile, stats); } catch { /* cache only */ }
  }
  return stats;
}

// The ONE PC asleep/awake detector (owner decision). Two independent PC signals reach EC2:
// the session sweep heartbeat and the desktop capability worker's relay claim, which polls
// every 5 seconds while the PC is awake, independent of the sweep. Neither inside the
// freshness window means asleep or offline; a fresh claim means awake. The Session
// transcript freshness row and the Dev Ops snapshot row both read this, so the two rows can
// never disagree about whether the PC is asleep. `proven` is true only when both
// signals carry a readable timestamp that is not in the future; a reader that must fail
// closed on missing or ambiguous evidence requires it. `since` is the newer signal.
function readPcPresence({
  dataDir,
  nowMs = Date.now(),
  heartbeatFreshMs = DEFAULT_HEARTBEAT_FRESH_MS,
  workerClaimAt,
  heartbeat,
} = {}) {
  const sweep = heartbeat !== undefined ? heartbeat : readJson(sessionCloudPaths(dataDir).heartbeat, null);
  const claimAt = workerClaimAt !== undefined
    ? workerClaimAt
    : readWorkerHeartbeat(runtimeDataDir(dataDir))?.last_claim_at;
  const claimMs = Date.parse(claimAt || '');
  const workerAwake = Number.isFinite(claimMs) && nowMs - claimMs <= heartbeatFreshMs;
  const sweepAt = sweep?.observed_at || sweep?.received_at || null;
  const sweepMs = Date.parse(sweepAt || '');
  const sweepAgeMs = sweepAt ? nowMs - sweepMs : Infinity;
  const sweepFresh = sweepAgeMs <= heartbeatFreshMs;
  const asleep = sweepAgeMs > heartbeatFreshMs && !workerAwake;
  const proven = Number.isFinite(claimMs) && Number.isFinite(sweepMs) && claimMs <= nowMs && sweepMs <= nowMs;
  const sinceMs = Math.max(Number.isFinite(claimMs) ? claimMs : -Infinity, Number.isFinite(sweepMs) ? sweepMs : -Infinity);
  return {
    asleep,
    proven,
    workerAwake,
    sweepFresh,
    sweepAt,
    sweepAgeMs,
    claimAt: claimAt || null,
    since: Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null,
  };
}

function computeSessionCloudHealth({
  dataDir,
  now = new Date(),
  lagRedMs = DEFAULT_LAG_RED_MS,
  heartbeatFreshMs = DEFAULT_HEARTBEAT_FRESH_MS,
  receiptSummaries: providedSummaries,
  workerClaimAt,
} = {}) {
  const paths = sessionCloudPaths(dataDir);
  const nowMs = now.getTime();
  const heartbeat = readJson(paths.heartbeat, null);
  const presence = readPcPresence({ dataDir, nowMs, heartbeatFreshMs, workerClaimAt, heartbeat });
  const pcAwake = presence.workerAwake;
  const receiptSummaries = providedSummaries || listReceiptSummaries(dataDir);
  const receipts = receiptSummaries.filter((receipt) => receipt.committed);
  const sourceProof = heartbeatSourceProof(heartbeat);
  const latestSourceAt = maxIso([
    heartbeat?.latest_source_at,
    ...receiptSummaries.map((receipt) => receipt.occurred_at),
  ]);
  // Transcript clocks and file mtimes differ. A heartbeat can prove its
  // newest source only through that source's immutable identity and byte
  // boundary, never by comparing occurred_at with filesystem time.
  const latestSavedAt = heartbeat?.latest_source_at
    ? sourceProof
      ? maxIso(receipts
        .filter((receipt) => receipt.source_id === sourceProof.source_id && receipt.raw_byte_end >= sourceProof.byte_end)
        .map((receipt) => receipt.committed_at))
      : null
    : maxIso(receipts.map((receipt) => receipt.committed_at));
  const heartbeatAt = presence.sweepAt;
  const heartbeatAge = presence.sweepAgeMs;
  const sourceMs = Date.parse(latestSourceAt || '');
  const savedMs = Date.parse(latestSavedAt || '');
  const sourceCovered = Boolean(sourceProof && latestSavedAt);
  const sourceAheadMs = Number.isFinite(sourceMs)
    ? Number.isFinite(savedMs)
      ? Math.max(0, sourceMs - savedMs)
      : Math.max(0, nowMs - sourceMs)
    : Infinity;
  const lagSeconds = sourceCovered && Number.isFinite(sourceMs) && Number.isFinite(savedMs)
    ? Math.max(0, Math.round((savedMs - sourceMs) / 1000))
    : null;
  let freshnessStatus = 'unknown';
  let freshnessDetail = 'no desktop producer heartbeat or cloud session receipt exists';
  if (heartbeat?.latest_source_at && !sourceProof) {
    freshnessStatus = 'yellow';
    freshnessDetail = 'newest observed transcript lacks source identity and byte-boundary save proof';
  } else if (sourceProof?.byte_end === 0 && !sourceCovered) {
    freshnessStatus = 'yellow';
    freshnessDetail = 'newest transcript has no complete source line ready for delivery; trailing bytes remain pending';
  } else if (sourceCovered) {
    freshnessStatus = 'green';
    freshnessDetail = heartbeatAge <= heartbeatFreshMs
      ? `newest cloud save ${ageLabel(nowMs - savedMs)}; source-to-cloud lag ${lagSeconds}s`
      : `last observed transcript ${ageLabel(nowMs - sourceMs)} is saved; desktop source currently unavailable`;
  } else if (Number.isFinite(sourceMs) && sourceAheadMs > lagRedMs && sourceAheadMs <= ASLEEP_LAG_RED_MS && presence.asleep) {
    // Sleep-aware (owner decision): no sweep heartbeat AND no desktop worker claim inside
    // the freshness window means the PC is asleep or offline, so no delivery is expected.
    // System Health rows are red or green only (The owner), so this passes with the
    // reason named, up to 24 hours behind. A stale sweep on an awake PC (worker still
    // polling) stays red; that is the Oct 26 daytime stall this row exists to catch.
    freshnessStatus = 'green';
    freshnessDetail = `newest observed transcript is ${Math.round(sourceAheadMs / 60000)}m ahead of its cloud save, but the PC is not reporting (last heartbeat ${ageLabel(heartbeatAge)}; asleep or offline); delivery resumes when it wakes`;
  } else if (Number.isFinite(sourceMs) && sourceAheadMs > lagRedMs) {
    freshnessStatus = 'red';
    freshnessDetail = heartbeatAge > heartbeatFreshMs
      ? (pcAwake
        ? `newest observed transcript is ahead of its cloud save by ${Math.round(sourceAheadMs / 60000)}m; the PC is awake but the sweep stopped reporting ${ageLabel(heartbeatAge)} ago`
        : `newest observed transcript is ahead of its cloud save by ${Math.round(sourceAheadMs / 60000)}m; the PC has not reported for ${ageLabel(heartbeatAge)} and is over a day behind`)
      : `newest observed transcript is ahead of its cloud save by ${Math.round(sourceAheadMs / 60000)}m`;
  } else if (Number.isFinite(sourceMs) && Number.isFinite(savedMs)) {
    // Inside the delivery window nothing is overdue: the check passes. Only a
    // transcript older than the window without a save is a failure (The owner,
    // 2026-09-28: a check is due when it is measured; no "not due yet" red).
    freshnessStatus = 'green';
    freshnessDetail = `newest observed transcript is ${Math.round(sourceAheadMs / 1000)}s ahead of its cloud save, inside the 10m delivery window; nothing is overdue`;
  } else if (Number.isFinite(sourceMs)) {
    freshnessStatus = 'yellow';
    freshnessDetail = `newest observed transcript has no cloud save receipt yet and is still inside the 10m delivery window`;
  }

  const terminalStats = readTerminalStats(dataDir);
  const terminal = { length: terminalStats.total };
  const terminalPending = { length: terminalStats.pending.length };
  const oldestTerminalPendingMs = terminalStats.pending.reduce((max, at) => {
    const age = nowMs - (Number.isFinite(at) ? at : nowMs);
    return Math.max(max, age);
  }, 0);
  const transcriptMissing = Array.isArray(terminalStats.transcript_missing) ? terminalStats.transcript_missing : [];
  const recentMissing = transcriptMissing.filter((at) => !Number.isFinite(at) || nowMs - at < TRANSCRIPT_MISSING_VISIBLE_MS).length;
  const terminalStatus = terminalPending.length === 0
    ? recentMissing > 0 ? 'yellow' : 'green'
    : oldestTerminalPendingMs > lagRedMs
      ? 'red'
      : 'yellow';
  const verifiedCount = terminal.length - terminalPending.length - transcriptMissing.length;
  const missingDetail = transcriptMissing.length
    ? `; ${transcriptMissing.length} ended with the transcript missing (no receipt possible, not counted as verified${recentMissing ? `, ${recentMissing} resolved in the last 7 days` : ''})`
    : '';
  const terminalDetail = terminalPending.length === 0
    ? `${verifiedCount} terminal activit${verifiedCount === 1 ? 'y has' : 'ies have'} verified full-transcript receipts; 0 pending${missingDetail}`
    : `${terminalPending.length} terminal activit${terminalPending.length === 1 ? 'y is' : 'ies are'} missing a verified full-transcript receipt; oldest ${ageLabel(oldestTerminalPendingMs)}${missingDetail}`;

  const searchReceipts = receipts.filter((receipt) => receipt.has_visible_text);
  const ftsPending = searchReceipts.filter((receipt) => receipt.derived?.fts?.status === 'pending');
  const graphitiPending = searchReceipts.filter((receipt) => receipt.derived?.graphiti?.status === 'pending');
  const graphitiSkipped = searchReceipts.filter((receipt) => receipt.derived?.graphiti?.status === 'skipped');
  const pendingDerived = [...new Set([...ftsPending, ...graphitiPending])];
  const oldestDerivedMs = pendingDerived.reduce((max, receipt) => {
    const age = nowMs - (Date.parse(receipt.committed_at || '') || nowMs);
    return Math.max(max, age);
  }, 0);
  const searchStatus = receipts.length === 0
    ? 'unknown'
    : pendingDerived.length === 0
      ? 'green'
      : oldestDerivedMs > lagRedMs
        ? 'red'
        : 'yellow';
  const searchDetail = receipts.length === 0
    ? 'no cloud session events exist to prove exact-search and Graphiti projection'
    : pendingDerived.length === 0
      ? `${searchReceipts.length} visible cloud event${searchReceipts.length === 1 ? '' : 's'} projected to exact search${graphitiSkipped.length ? `; Graphiti skipped by policy for ${graphitiSkipped.length} events` : ' and Graphiti'}; 0 pending${receipts.length > searchReceipts.length ? `; ${receipts.length - searchReceipts.length} raw/receipt-only event${receipts.length - searchReceipts.length === 1 ? '' : 's'} required no derived text` : ''}`
      : `${ftsPending.length} exact-search and ${graphitiPending.length} Graphiti projection${graphitiPending.length === 1 ? '' : 's'} pending; oldest ${ageLabel(oldestDerivedMs)}`;

  return {
    schema: HEALTH_SCHEMA,
    generated_at: now.toISOString(),
    producer_heartbeat_at: heartbeatAt,
    latest_source_at: latestSourceAt,
    latest_saved_at: latestSavedAt,
    providers: heartbeat?.providers || {},
    metrics: {
      transcript_freshness: {
        status: freshnessStatus,
        detail: freshnessDetail,
        latest_source_at: latestSourceAt,
        latest_saved_at: latestSavedAt,
        lag_seconds: lagSeconds,
        source_id: sourceProof?.source_id || null,
        deliverable_byte_end: sourceProof?.byte_end ?? null,
        raw_byte_end: sourceProof?.raw_bytes ?? null,
        source_available: heartbeatAge <= heartbeatFreshMs,
      },
      terminal_receipts: {
        status: terminalStatus,
        detail: terminalDetail,
        terminal_total: terminal.length,
        pending: terminalPending.length,
        transcript_missing: transcriptMissing.length,
        transcript_missing_recent: recentMissing,
        oldest_pending_seconds: Math.round(oldestTerminalPendingMs / 1000),
      },
      search_projection: {
        status: searchStatus,
        detail: searchDetail,
        event_total: receipts.length,
        visible_event_total: searchReceipts.length,
        fts_pending: ftsPending.length,
        graphiti_pending: graphitiPending.length,
        graphiti_skipped: graphitiSkipped.length,
        oldest_pending_seconds: Math.round(oldestDerivedMs / 1000),
      },
    },
  };
}

function recordSessionProducerHeartbeat(heartbeat, { dataDir, now = new Date() } = {}) {
  const paths = sessionCloudPaths(dataDir);
  const next = {
    schema: 'amy.session_producer_heartbeat.v1',
    observed_at: heartbeat?.observed_at || now.toISOString(),
    received_at: now.toISOString(),
    latest_source_at: heartbeat?.latest_source_at || null,
    latest_source: heartbeatSourceProof(heartbeat),
    providers: heartbeat?.providers || {},
    source_count: Number(heartbeat?.source_count || 0),
    pending_outbox: Number(heartbeat?.pending_outbox || 0),
    producer_host: String(heartbeat?.producer_host || ''),
  };
  atomicWriteJson(paths.heartbeat, next);
  const health = computeSessionCloudHealth({ dataDir, now });
  atomicWriteJson(paths.health, health);
  return health;
}

function reconcileSessionDerivedWork({
  dataDir,
  now = new Date(),
  limit = 200,
  indexVisibleText,
  writeGraphiti,
} = {}) {
  const paths = sessionCloudPaths(dataDir);
  const all = listReceiptSummaries(dataDir);
  const isPending = (receipt) =>
    receipt.committed && (receipt.derived?.fts?.status === 'pending' || receipt.derived?.graphiti?.status === 'pending');
  const receipts = all
    .filter(isPending)
    .sort((a, b) => (Date.parse(a.committed_at || '') || 0) - (Date.parse(b.committed_at || '') || 0))
    .slice(0, Math.max(1, Math.min(2000, Number(limit) || 200)));
  const refreshed = new Map();
  for (const summary of receipts) {
    const receipt = readJson(receiptFile(paths, summary.event_id), null);
    if (!receipt) continue;
    const next = processDerived(receipt, { indexVisibleText, writeGraphiti, now });
    atomicWriteJson(receiptFile(paths, receipt.event_id), next);
    refreshed.set(summary.event_id, summarizeReceipt(next));
  }
  // One directory pass serves selection, the remaining count, and health; only
  // the receipts just rewritten are re-summarized in memory.
  const current = all.map((receipt) => refreshed.get(receipt.event_id) || receipt);
  const remaining = current.filter(isPending).length;
  const health = computeSessionCloudHealth({ dataDir, now, receiptSummaries: current });
  atomicWriteJson(paths.health, health);
  return { attempted: receipts.length, remaining, health };
}

module.exports = {
  ASLEEP_LAG_RED_MS,
  DEFAULT_HEARTBEAT_FRESH_MS,
  DEFAULT_LAG_RED_MS,
  HEALTH_SCHEMA,
  PROJECTION_SCHEMA,
  MAX_INGEST_BATCH_SIZE,
  applySessionEvent,
  applySessionEventBatch,
  buildVoiceProjection,
  readFullProjectionCached,
  readVoiceProjection,
  VOICE_PROJECTION_WINDOW_MS,
  projectSessionEvent,
  ingestSessionEvent,
  ingestSessionEventBatch,
  computeSessionCloudHealth,
  listReceiptSummaries,
  readPcPresence,
  readSessionProjection,
  reconcileSessionDerivedWork,
  recordSessionProducerHeartbeat,
  sessionCloudPaths,
};
