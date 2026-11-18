'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { withStateLock } = require('./controller-conflict-leases.js');
const { writeJsonAtomicRetry } = require('./write-json-atomic-retry.js');

function defaultDesktopDataDir(env = process.env) {
  if (env.SECONDBRAIN_DATA_DIR) return env.SECONDBRAIN_DATA_DIR;
  const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'secondbrain', 'data');
}

function defaultDesktopSessionRegistryDir(env = process.env) {
  return (
    env.SECONDBRAIN_SESSION_REGISTRY_DIR ||
    path.join(defaultDesktopDataDir(env), 'agent', 'desktop-session-registry')
  );
}

function sessionRegistryFile(sessionId, registryDir = defaultDesktopSessionRegistryDir()) {
  if (!sessionId || /[\\/]/.test(sessionId)) throw new Error('invalid session id');
  return path.join(registryDir, `spine-session-${sessionId}.json`);
}

function registryDirForOptions({ registryDir, dataDir, tasksDir } = {}) {
  if (registryDir) return registryDir;
  if (process.env.SECONDBRAIN_SESSION_REGISTRY_DIR) return process.env.SECONDBRAIN_SESSION_REGISTRY_DIR;
  if (dataDir || tasksDir) return path.join(dataDir || path.dirname(tasksDir), 'agent', 'desktop-session-registry');
  return defaultDesktopSessionRegistryDir();
}

// Receipt updates may read legacy records during cutover, but never create them.
function existingSessionRecordFile(sessionId, options = {}) {
  if (!sessionId || /[\\/]/.test(sessionId)) return null;
  const registry = sessionRegistryFile(sessionId, registryDirForOptions(options));
  if (fs.existsSync(registry)) return registry;
  const legacy = sessionRegistryFile(sessionId, options.tasksDir || path.join(options.dataDir || defaultDesktopDataDir(), 'tasks'));
  return fs.existsSync(legacy) ? legacy : null;
}

function withSessionRecordLock(file, update) {
  return withStateLock({ root: path.dirname(file), lock: `${file}.update-lock` }, update);
}

// T-4 (The owner): a session with no "done" record and no activity for
// 7 days is marked inactive. Nothing is deleted. A new prompt (Claude) or new
// Codex activity puts it back to running. Codex sessions never send Stop, so
// without this the list showed 7,205 long-ended sessions as running.
const SESSION_INACTIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function isIdleRunning(record, nowMs) {
  if (!record || record.status !== 'running') return false;
  const last = Date.parse(record.updatedAt || record.startedAt || record.createdAt || '');
  return Number.isFinite(last) && nowMs - last > SESSION_INACTIVE_AFTER_MS;
}

function inactiveHistoryEntry(ts) {
  return { status: 'inactive', ts, note: 'no done record and no activity for 7 days; nothing deleted' };
}

function markInactiveSessions(registryDir = defaultDesktopSessionRegistryDir(), { now = new Date() } = {}) {
  const nowMs = now.getTime();
  const marked = [];
  let names = [];
  try {
    names = fs.readdirSync(registryDir).filter((name) => name.startsWith('spine-session-') && name.endsWith('.json'));
  } catch {
    return marked;
  }
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  for (const name of names) {
    const file = path.join(registryDir, name);
    try {
      if (!isIdleRunning(read(file), nowMs)) continue; // cheap read; lock only candidates
      withSessionRecordLock(file, () => {
        const record = read(file);
        if (!isIdleRunning(record, nowMs)) return;
        record.status = 'inactive';
        record.history = [...(Array.isArray(record.history) ? record.history : []), inactiveHistoryEntry(now.toISOString())];
        writeJsonAtomicRetry(file, record);
        marked.push(file);
      });
    } catch {
      // malformed or busy record: the next two-minute run tries again
    }
  }
  return marked;
}

module.exports = {
  defaultDesktopDataDir,
  defaultDesktopSessionRegistryDir,
  sessionRegistryFile,
  registryDirForOptions,
  existingSessionRecordFile,
  withSessionRecordLock,
  SESSION_INACTIVE_AFTER_MS,
  isIdleRunning,
  inactiveHistoryEntry,
  markInactiveSessions,
  writeSessionRecord: writeJsonAtomicRetry,
};
