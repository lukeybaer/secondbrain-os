'use strict';

// One desktop owns the session outbox at a time.  The producer is intentionally
// scheduled every two minutes, but an individual drain can take longer than a
// cadence when the cloud is busy.  A directory acquisition is atomic on the
// local filesystem; a loser must leave the durable pending events untouched.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LEASE_SCHEMA = 'amy.session_sweep_lease.v1';
// Four times the Task Scheduler execution limit (PT90M, raised from PT8M on 2026-10-27 for the
// 30,000-event run); no live sweep holds the lease this long.
const SESSION_SWEEP_LEASE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

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

function sleepMs(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Stops the process (TerminateProcess on Windows via process.kill, never taskkill).
function terminatePid(pid) {
  try { process.kill(Number(pid)); } catch { /* already gone or not permitted; liveness is re-checked */ }
}

// Process start time in epoch ms, or null when it cannot be read.  Used to
// detect a recycled pid before anything is killed.
function pidStartMs(pid) {
  try {
    const cmd = process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`]]
      : ['ps', ['-o', 'lstart=', '-p', String(Number(pid))]];
    const out = execFileSync(cmd[0], cmd[1], { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? ms : null;
  } catch { return null; }
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
  maxAgeMs = 0,
  terminate = terminatePid,
  getPidStartMs = pidStartMs,
  settleMs = 3000,
  log = (message) => console.error(message),
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
        let state = ownerState(owner, { hostname, isPidAlive, schema });
        // The scheduler kills a sweep after 8 minutes, but an orphaned child can keep its PID
        // alive and hold this lease for hours, deferring every run with exit 0 (2026-10-25:
        // no session reached the cloud for 15 hours). A same-host owner past maxAgeMs is hung.
        // A live owner is reclaimed only after it is proven gone: stop it, re-check
        // liveness, and refuse to reclaim if it survives (it could still write the outbox).
        if (state === 'alive' && maxAgeMs > 0) {
          const heldMs = now() - Date.parse(owner.acquired_at || '');
          if (Number.isFinite(heldMs) && heldMs > maxAgeMs) {
            const startedMs = getPidStartMs(Number(owner.pid));
            const acquiredMs = Date.parse(owner.acquired_at);
            if (Number.isFinite(startedMs) && startedMs > acquiredMs + 60000) {
              state = 'dead'; // pid recycled by an unrelated process: the owner already exited, do not kill it
            } else {
              terminate(Number(owner.pid));
              sleepMs(settleMs);
              if (isPidAlive(Number(owner.pid))) {
                log(`[session-sweep-lease] hung owner pid ${owner.pid} survived stop; lease not reclaimed`);
                return { acquired: false, paths, owner, reason: 'lease-alive-unstoppable' };
              }
              state = 'dead';
            }
          }
        }
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
        holds() {
          const current = readJson(path.join(paths.lock, 'owner.json'), fsApi);
          return current?.token === token;
        },
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
  return acquireSingleHostLease({ root: pathsFor(dataDir).root, maxAgeMs: SESSION_SWEEP_LEASE_MAX_AGE_MS, ...options });
}

module.exports = { LEASE_SCHEMA, acquireSessionSweepLease, acquireSingleHostLease, ownerState, pathsFor };
