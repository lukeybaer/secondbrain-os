'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The full nightly recluster and every per-call incremental publish the SAME
// recluster-latest.json. Before 2026-08-14 they used different locks and plain
// writeFileSync, so an incremental could read a torn artifact or overwrite a
// completed full rebuild with its stale prior state. Every writer serializes
// its whole read-compute-publish transaction through this one artifact-scoped
// lock and publishes atomically.
//
// Acquisition and stale reaping both run inside a short-lived reap gate, so a
// reaper can never delete a lock a successor acquired between its staleness
// check and its removal. Staleness requires BOTH an old directory mtime and an
// old (or absent) owner record, the stale window exceeds the full recluster's
// 2h runtime cap, and release deletes the lock only while the owner nonce
// still matches.

// The env override can tune the stale window UP but never below the 2h
// identity-scope runtime cap plus margin, so a live capped writer can never
// be reaped by configuration; a nonnumeric override falls back to the
// default instead of poisoning staleness math with NaN.
function resolveStaleMs(rawValue) {
  const parsed = Number(rawValue);
  const requested = Number.isFinite(parsed) && parsed > 0 ? parsed : 150 * 60 * 1000;
  return Math.max(requested, 130 * 60 * 1000);
}
const DEFAULT_STALE_MS = resolveStaleMs(process.env.SB_RECLUSTER_LOCK_STALE_MS);
const DEFAULT_WAIT_MS = Number(process.env.SB_RECLUSTER_LOCK_WAIT_MS || 200);
const DEFAULT_RETRIES = Number(process.env.SB_RECLUSTER_LOCK_RETRIES || 300);
const GATE_STALE_MS = 60 * 1000;

function lockDirFor(latestPath) {
  return `${String(latestPath)}.publish-lock.d`;
}

function ownerFileFor(lockDir) {
  return path.join(lockDir, 'owner.json');
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

function readOwner(lockDir, fsApi) {
  try {
    return JSON.parse(fsApi.readFileSync(ownerFileFor(lockDir), 'utf8'));
  } catch {
    return null;
  }
}

// The gate serializes lock acquisition against stale reaping. It is held for
// microseconds, so a gate older than a minute is debris from a crashed holder.
function withReapGate(lockDir, { fsApi, sleepFn }, fn) {
  const gate = `${lockDir}.gate`;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    let entered = false;
    try {
      fsApi.mkdirSync(gate);
      entered = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fsApi.statSync(gate).mtimeMs > GATE_STALE_MS) {
          fsApi.rmSync(gate, { recursive: true, force: true });
        }
      } catch {}
      sleepFn(10);
    }
    if (entered) {
      try {
        return fn();
      } finally {
        try {
          fsApi.rmSync(gate, { recursive: true, force: true });
        } catch {}
      }
    }
  }
  throw new Error(`recluster publish reap gate is wedged at ${lockDir}.gate`);
}

function tryAcquireReclusterPublishLock(
  latestPath,
  {
    retries = DEFAULT_RETRIES,
    waitMs = DEFAULT_WAIT_MS,
    staleMs = DEFAULT_STALE_MS,
    fsApi = fs,
    sleepFn = sleepSync,
    hostName = os.hostname(),
    ownerAliveFn = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error?.code !== 'ESRCH';
      }
    },
  } = {},
) {
  const lockDir = lockDirFor(latestPath);
  fsApi.mkdirSync(path.dirname(lockDir), { recursive: true });
  const nonce = crypto.randomBytes(8).toString('hex');
  const handle = {
    lockDir,
    nonce,
    release() {
      // Only the live owner may delete: after a stale takeover this directory
      // belongs to a successor with a different nonce.
      const owner = readOwner(lockDir, fsApi);
      if (owner && owner.nonce === nonce) {
        fsApi.rmSync(lockDir, { recursive: true, force: true });
      }
    },
  };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const acquired = withReapGate(lockDir, { fsApi, sleepFn }, () => {
      try {
        fsApi.mkdirSync(lockDir);
        fsApi.writeFileSync(
          ownerFileFor(lockDir),
          `${JSON.stringify({
            pid: process.pid,
            host: hostName,
            nonce,
            acquired_at: new Date().toISOString(),
          })}\n`,
          'utf8',
        );
        return true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        // Reap only a doubly-stale lock: old directory AND old/absent owner.
        let dirAge = Infinity;
        try {
          dirAge = Date.now() - fsApi.statSync(lockDir).mtimeMs;
        } catch {
          return false;
        }
        const owner = readOwner(lockDir, fsApi);
        const acquiredAt = Date.parse(owner?.acquired_at || '') || 0;
        const ownerAge = acquiredAt ? Date.now() - acquiredAt : Infinity;
        const sameHostOwnerProvenDead = Boolean(
          owner?.host &&
            owner.host === hostName &&
            Number.isInteger(Number(owner.pid)) &&
            Number(owner.pid) > 0 &&
            ownerAliveFn(Number(owner.pid)) === false,
        );
        if ((dirAge >= staleMs && ownerAge >= staleMs) || sameHostOwnerProvenDead) {
          fsApi.rmSync(lockDir, { recursive: true, force: true });
        }
        return false;
      }
    });
    if (acquired) return handle;
    if (attempt < retries) sleepFn(waitMs);
  }
  return null;
}

function acquireReclusterPublishLock(latestPath, options = {}) {
  const lock = tryAcquireReclusterPublishLock(latestPath, options);
  if (!lock) {
    throw new Error(
      `could not acquire recluster publish lock at ${lockDirFor(latestPath)}; a writer is holding it`,
    );
  }
  return lock;
}

function withReclusterPublishLock(latestPath, fn, options = {}) {
  const lock = acquireReclusterPublishLock(latestPath, options);
  try {
    return fn();
  } finally {
    lock.release();
  }
}

function saveJsonAtomic(file, value, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fsApi.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fsApi.renameSync(temp, file);
}

module.exports = {
  acquireReclusterPublishLock,
  lockDirFor,
  resolveStaleMs,
  saveJsonAtomic,
  tryAcquireReclusterPublishLock,
  withReclusterPublishLock,
};
