'use strict';

// One desktop owns the session outbox at a time.  The producer is intentionally
// scheduled every two minutes, but an individual drain can take longer than a
// cadence when the cloud is busy.  A directory acquisition is atomic on the
// local filesystem; a loser must leave the durable pending events untouched.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEASE_SCHEMA = 'amy.session_sweep_lease.v1';

function pathsFor(dataDir) {
  const root = path.join(path.resolve(dataDir), 'agent', 'session-cloud-sweep');
  return { root, lock: path.join(root, 'active-lease') };
}

function readJson(file, fsApi = fs) {
  try { return JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (error) { return error?.code !== 'ESRCH'; }
}

function ownerState(owner, { hostname, isPidAlive = pidAlive, schema = LEASE_SCHEMA } = {}) {
  if (!owner || owner.schema !== schema || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.token) return 'malformed';
  if (String(owner.hostname || '') !== String(hostname || '')) return 'foreign-host';
  return isPidAlive(Number(owner.pid)) ? 'alive' : 'dead';
}

function acquireSingleHostLease({
  root,
  schema = LEASE_SCHEMA,
  now = Date.now,
  hostname = os.hostname(),
  pid = process.pid,
  isPidAlive = pidAlive,
  fsApi = fs,
} = {}) {
  if (!root) throw new Error('single-host lease requires root');
  const paths = { root: path.resolve(root), lock: path.join(path.resolve(root), 'active-lease'), guard: path.join(path.resolve(root), 'admission-guard') };
  const token = crypto.randomBytes(18).toString('hex');
  fsApi.mkdirSync(paths.root, { recursive: true });
  // Acquisition, dead-owner reclamation and release share this short critical
  // section. Without it a stale observer could delete a replacement live lease.
  // A crashed or unreadable guard requires attended reconciliation, never age
  // based unlocking. Pending outbox events remain durable while admission defers.
  function underGuard(action) {
    try {
      fsApi.mkdirSync(paths.guard);
    } catch (error) {
      if (error?.code === 'EEXIST') return { acquired: false, paths, reason: 'admission-guard-busy' };
      throw error;
    }
    try {
      fsApi.writeFileSync(path.join(paths.guard, 'owner.json'), `${JSON.stringify({ token, hostname, pid: Number(pid) })}\n`, { mode: 0o600 });
      return action();
    } finally {
      fsApi.rmSync(paths.guard, { recursive: true, force: true });
    }
  }
  return underGuard(() => {
      if (fsApi.existsSync(paths.lock)) {
        const owner = readJson(path.join(paths.lock, 'owner.json'), fsApi);
        const state = ownerState(owner, { hostname, isPidAlive, schema });
        if (state !== 'dead') return { acquired: false, paths, owner, reason: state === 'malformed' ? 'unverified-lease' : `lease-${state}` };
        fsApi.rmSync(paths.lock, { recursive: true, force: true });
      }
      fsApi.mkdirSync(paths.lock);
      const owner = { schema, token, hostname, pid: Number(pid), acquired_at: new Date(now()).toISOString() };
      fsApi.writeFileSync(path.join(paths.lock, 'owner.json'), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      return {
        acquired: true,
        paths,
        owner,
        release() {
          return underGuard(() => {
            const current = readJson(path.join(paths.lock, 'owner.json'), fsApi);
            if (current?.token !== token) return false;
            fsApi.rmSync(paths.lock, { recursive: true, force: true });
            return true;
          });
        },
      };
  });
}

function acquireSessionSweepLease({ dataDir, ...options } = {}) {
  if (!dataDir) throw new Error('session sweep lease requires dataDir');
  return acquireSingleHostLease({ root: pathsFor(dataDir).root, ...options });
}

module.exports = { LEASE_SCHEMA, acquireSessionSweepLease, acquireSingleHostLease, ownerState, pathsFor };
