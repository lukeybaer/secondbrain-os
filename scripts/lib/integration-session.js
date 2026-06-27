'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_TTL_MS = 60 * 60 * 1000;

function normalizePath(p) {
  if (typeof p !== 'string' || p.length === 0) return '';
  let out = p.replace(/\\/g, '/');
  const msys = out.match(/^\/([a-zA-Z])\/(.*)$/);
  if (msys) out = msys[1] + ':/' + msys[2];
  if (/^[a-zA-Z]:/.test(out)) out = out[0].toLowerCase() + out.slice(1);
  return out.replace(/\/+$/, '');
}

function defaultLockPath(mainRoot) {
  const root = normalizePath(mainRoot || process.env.SECONDBRAIN_ROOT || path.join(os.homedir(), 'secondbrain'));
  const slug = root.replace(/^[a-z]:\//i, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'secondbrain';
  return path.join(os.homedir(), '.secondbrain', `integration-session-${slug}.json`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function validateIntegrationSession({ env = process.env, mainRoot, now = Date.now(), fsApi = fs } = {}) {
  if (env.SB_INTEGRATION_SESSION !== '1') {
    return { valid: false, reason: 'SB_INTEGRATION_SESSION is not set' };
  }
  const lockPath = env.SB_INTEGRATION_SESSION_LOCK || defaultLockPath(mainRoot);
  let lock;
  try {
    lock = JSON.parse(fsApi.readFileSync(lockPath, 'utf8'));
  } catch (e) {
    return { valid: false, reason: `integration lease missing or unreadable at ${lockPath}` };
  }
  const expectedRoot = normalizePath(mainRoot || lock.mainRoot || '');
  const lockRoot = normalizePath(lock.mainRoot || '');
  if (expectedRoot && lockRoot && expectedRoot !== lockRoot) {
    return { valid: false, reason: `integration lease is for ${lock.mainRoot}, not ${mainRoot}` };
  }
  const expiresAtMs = Date.parse(lock.expiresAt || '');
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
    return { valid: false, reason: 'integration lease expired' };
  }
  if (lock.pid && !pidAlive(lock.pid)) {
    return { valid: false, reason: `integration lease owner pid ${lock.pid} is not alive` };
  }
  return {
    valid: true,
    reason: `integration lease active for ${lock.reason || 'unspecified reason'}`,
    lock,
    lockPath,
  };
}

function createIntegrationSession({
  mainRoot,
  reason = 'integration',
  ttlMs = DEFAULT_TTL_MS,
  lockPath,
  cwd = process.cwd(),
  pid = process.pid,
  fsApi = fs,
  now = Date.now(),
} = {}) {
  const root = normalizePath(mainRoot || process.env.SECONDBRAIN_ROOT || path.join(os.homedir(), 'secondbrain'));
  const file = lockPath || defaultLockPath(root);
  const lease = {
    version: 1,
    mainRoot: root,
    cwd: normalizePath(cwd),
    pid,
    owner: process.env.USERNAME || process.env.USER || os.userInfo().username,
    reason,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  fsApi.writeFileSync(file, JSON.stringify(lease, null, 2) + '\n');
  return { lockPath: file, lease };
}

function clearIntegrationSession({ lockPath, mainRoot, fsApi = fs } = {}) {
  const file = lockPath || defaultLockPath(mainRoot);
  try {
    fsApi.unlinkSync(file);
    return { cleared: true, lockPath: file };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { cleared: false, lockPath: file, reason: 'already absent' };
    throw e;
  }
}

module.exports = {
  DEFAULT_TTL_MS,
  normalizePath,
  defaultLockPath,
  validateIntegrationSession,
  createIntegrationSession,
  clearIntegrationSession,
  readJson,
};
