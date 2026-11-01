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

module.exports = {
  defaultDesktopDataDir,
  defaultDesktopSessionRegistryDir,
  sessionRegistryFile,
  registryDirForOptions,
  existingSessionRecordFile,
  withSessionRecordLock,
  writeSessionRecord: writeJsonAtomicRetry,
};
