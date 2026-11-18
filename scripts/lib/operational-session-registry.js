'use strict';

// Migration helper for legacy Task-backed desktop session telemetry. The live
// operational registry is one atomic file per session, owned by
// desktop-session-registry.js. Never introduce a shared JSON document here:
// concurrent prompt hooks must not read-modify-write each other's sessions.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withSessionRecordLock, writeSessionRecord } = require('./desktop-session-registry.js');

const REGISTRY_SCHEMA = 'amy.desktop-session-registry.v1';
const LEGACY_PREFIX = 'spine-session-';
const TELEMETRY_ORIGINS = new Set(['claude-code', 'codex']);
const DISPATCH_MARKERS = new Set(['dispatch', 'dispatchId', 'dispatch_id', 'callback', 'assignee', 'recipient', 'channel', 'delivery', 'ownerVerified', 'sessionTurn', 'taskType']);

function defaultDesktopSessionRegistryDir(env = process.env) {
  const dataDir = env.SECONDBRAIN_DATA_DIR || path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'secondbrain', 'data');
  return env.SECONDBRAIN_SESSION_REGISTRY_DIR || path.join(dataDir, 'agent', 'desktop-session-registry');
}
function sessionRegistryFile(sessionId, registryDir = defaultDesktopSessionRegistryDir()) { return path.join(registryDir, `spine-session-${sessionId}.json`); }

function writeJsonAtomic(file, value) { writeSessionRecord(file, value); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }
function checksumText(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function legacySessionIdFromFilename(name) { return typeof name === 'string' && name.startsWith(LEGACY_PREFIX) && name.endsWith('.json') ? name.slice(LEGACY_PREFIX.length, -'.json'.length) : ''; }
function hasDispatchMarker(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => (DISPATCH_MARKERS.has(key) && item != null && item !== false && item !== '') || (item && typeof item === 'object' && hasDispatchMarker(item)));
}
function classifyLegacySessionTelemetry({ filename, record } = {}) {
  const sessionId = legacySessionIdFromFilename(filename);
  if (!sessionId || /[\\/]/.test(sessionId)) return { eligible: false, reason: 'filename-not-legacy-session' };
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { eligible: false, reason: 'record-invalid' };
  if (!TELEMETRY_ORIGINS.has(record.origin)) return { eligible: false, reason: 'origin-not-desktop-telemetry' };
  if (record.id !== `${LEGACY_PREFIX}${sessionId}` || record.sessionId !== sessionId) return { eligible: false, reason: 'id-or-session-mismatch' };
  if (record.kind !== 'action') return { eligible: false, reason: 'unexpected-task-kind' };
  if (hasDispatchMarker(record)) return { eligible: false, reason: 'dispatch-marker-present' };
  return { eligible: true, sessionId };
}
function sessionFromLegacy(record, { sourcePath, archivePath, checksum, migratedAt } = {}) {
  return {
    ...record,
    schema: REGISTRY_SCHEMA,
    recordType: 'operational_session',
    migration: { source: 'legacy-spine-session-task', source_task_id: record.id, source_path: sourcePath, archived_path: archivePath, source_sha256: checksum, migrated_at: migratedAt },
  };
}
function listLegacyTelemetry({ tasksDir } = {}) {
  let names = []; try { names = fs.readdirSync(tasksDir); } catch { return { candidates: [], skipped: [] }; }
  const candidates = []; const skipped = [];
  for (const filename of names.filter((name) => name.startsWith(LEGACY_PREFIX) && name.endsWith('.json')).sort()) {
    const sourcePath = path.join(tasksDir, filename); let text; let record;
    try { text = fs.readFileSync(sourcePath, 'utf8'); record = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { skipped.push({ filename, reason: 'unreadable-or-invalid-json' }); continue; }
    const classified = classifyLegacySessionTelemetry({ filename, record });
    if (!classified.eligible) { skipped.push({ filename, reason: classified.reason }); continue; }
    candidates.push({ filename, sourcePath, record, text, checksum: checksumText(text), sessionId: classified.sessionId });
  }
  return { candidates, skipped };
}
function migrateLegacySessionTelemetry({ tasksDir, registryDir = defaultDesktopSessionRegistryDir(), write = false, now = new Date().toISOString() } = {}) {
  if (!tasksDir) throw new Error('tasksDir is required');
  const plan = listLegacyTelemetry({ tasksDir });
  const archiveDir = path.join(tasksDir, 'archive', 'operational-session-telemetry');
  const planned = plan.candidates.map((candidate) => ({ filename: candidate.filename, session_id: candidate.sessionId, source_path: candidate.sourcePath, registry_path: sessionRegistryFile(candidate.sessionId, registryDir), archived_path: path.join(archiveDir, candidate.filename), source_sha256: candidate.checksum }));
  if (!write) return { mode: 'dry-run', ...plan, planned, registry_dir: registryDir };
  let migrated = 0;
  for (const [index, candidate] of plan.candidates.entries()) {
    const target = planned[index];
    withSessionRecordLock(target.registry_path, () => {
      const existing = readJson(target.registry_path);
      if (existing && (existing.schema !== REGISTRY_SCHEMA || existing.recordType !== 'operational_session' || existing.id !== candidate.record.id || existing.sessionId !== candidate.sessionId)) throw new Error(`registry conflict for ${candidate.filename}; source retained`);
      if (fs.existsSync(target.archived_path) && checksumText(fs.readFileSync(target.archived_path, 'utf8')) !== candidate.checksum) {
        target.archived_path = path.join(archiveDir, `${candidate.filename.slice(0, -5)}.${candidate.checksum}.json`);
      }
      fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
      // Archive the scanned bytes first, so a failed or concurrent source update
      // never creates a registry pointer to bytes that were not preserved.
      try { fs.writeFileSync(target.archived_path, candidate.text, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (checksumText(fs.readFileSync(target.archived_path, 'utf8')) !== candidate.checksum) throw new Error(`archive checksum conflict for ${candidate.filename}`);
      if (checksumText(fs.readFileSync(candidate.sourcePath, 'utf8')) !== candidate.checksum) throw new Error(`source changed during migration for ${candidate.filename}; source retained`);
      target.registry_disposition = existing ? 'preserved-existing-operational-record' : 'created';
      if (!existing) writeJsonAtomic(target.registry_path, sessionFromLegacy(candidate.record, { sourcePath: candidate.sourcePath, archivePath: target.archived_path, checksum: candidate.checksum, migratedAt: now }));
      // Claim the old filename atomically before removal. A late old writer's
      // different bytes remain archived, never deleted on a stale checksum.
      const claimed = path.join(archiveDir, `claimed-${crypto.randomUUID()}-${candidate.filename}`);
      fs.renameSync(candidate.sourcePath, claimed);
      if (checksumText(fs.readFileSync(claimed, 'utf8')) !== candidate.checksum) throw new Error(`source changed while claiming ${candidate.filename}; changed bytes retained at ${claimed}`);
      fs.unlinkSync(claimed);
    });
    migrated += 1;
  }
  return { mode: 'write', ...plan, planned, migrated, registry_dir: registryDir };
}
module.exports = { REGISTRY_SCHEMA, TELEMETRY_ORIGINS, defaultDesktopSessionRegistryDir, sessionRegistryFile, classifyLegacySessionTelemetry, sessionFromLegacy, listLegacyTelemetry, migrateLegacySessionTelemetry };
