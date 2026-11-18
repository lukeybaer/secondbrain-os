'use strict';

// One complete publication transaction per card at a time, across processes.
//
// Codex F3 (2026-10-26): S-5 let the controller's serial publish loop run while
// a healer's child process published the same card. Each refresh-card took the
// short shared lock only around the baseline read, Gate A and Gate B, and ran
// live QC unlocked in between. A sibling could commit its own Gate A between
// this transaction's Gate A and Gate B, so a clean live proof was retained as
// superseded (verdict clean, appliedToBoard false) and the row stayed red.
//
// Every publisher (controller publish loop, healer publication, single-metric
// refresh) ends in refreshOneCardArtifact in a refresh-card process. This lock
// wraps that function's whole transaction, staged-row rebase through Gate B, so
// the next publisher of the same card rebases onto the committed result.
// Staging never takes it, so rows still stage in parallel.
//
// Mechanism: an in-process queue per lock path, then an atomic mkdir lock
// directory with an owner record (pid, host, nonce, heartbeat). A lock is
// reclaimed when its same-host owner pid is dead (or recycled: the recorded
// process start time no longer matches), or when a different-host owner's
// heartbeat is older than remoteStaleMs. Heartbeat staleness never reclaims a
// live same-host owner: synchronous verification can block the heartbeat timer
// for minutes, and admitting a second publisher then is the bug this prevents.
// Acquisition and reaping run inside a short mkdir gate so a reaper
// can never delete a lock a successor acquired after its staleness check.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOCK_REL_DIR = path.join('agent', 'briefing-card-publish-locks');
const DEFAULT_WAIT_MS = 20 * 60 * 1000;
// Torn owner record (directory exists, owner.json never written).
const DEFAULT_STALE_MS = 2 * 60 * 1000;
// Different-host owner: well above the longest synchronous step (two 60 s fetches).
const DEFAULT_REMOTE_STALE_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 10 * 1000;
const POLL_MS = 100;
const GATE_STALE_MS = 60 * 1000;

const inProcessTails = new Map();

function safeSegment(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]/g, '_') || '_';
}

function cardPublishLockDir({ dataDir, date, cardId }) {
  return path.join(dataDir, LOCK_REL_DIR, safeSegment(date), `${safeSegment(cardId)}.lock.d`);
}

function ownerFile(lockDir) {
  return path.join(lockDir, 'owner.json');
}

function readOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(ownerFile(lockDir), 'utf8'));
  } catch {
    return null;
  }
}

function writeOwner(lockDir, owner) {
  const tmp = `${ownerFile(lockDir)}.${owner.nonce}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(owner)}\n`, 'utf8');
  fs.renameSync(tmp, ownerFile(lockDir));
}

function defaultOwnerAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

// Process start time (clock ticks since boot) from /proc on Linux; null when
// unreadable, in which case a live pid is treated as the live owner.
function defaultStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] || null;
  } catch {
    return null;
  }
}

function isStale(lockDir, { staleMs, remoteStaleMs, hostName, ownerAliveFn, startTimeFn, nowMs }) {
  const owner = readOwner(lockDir);
  if (!owner) {
    // Owner record not written yet (or torn): judge by the directory age.
    try {
      return nowMs - fs.statSync(lockDir).mtimeMs > staleMs;
    } catch {
      return false;
    }
  }
  if (owner.host === hostName) {
    if (!Number.isInteger(owner.pid)) return true;
    if (!ownerAliveFn(owner.pid)) return true;
    if (owner.startTime) {
      const current = startTimeFn(owner.pid);
      if (current && String(current) !== String(owner.startTime)) return true;
    }
    return false;
  }
  const beat = Date.parse(owner.heartbeatAt || owner.acquiredAt || '') || 0;
  return nowMs - beat > remoteStaleMs;
}

// The gate is held for microseconds; one older than a minute is crash debris.
function tryInsideGate(lockDir, fn) {
  const gate = `${lockDir}.gate`;
  try {
    fs.mkdirSync(gate);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    try {
      if (Date.now() - fs.statSync(gate).mtimeMs > GATE_STALE_MS) {
        fs.rmSync(gate, { recursive: true, force: true });
      }
    } catch {}
    return { entered: false };
  }
  try {
    return { entered: true, value: fn() };
  } finally {
    try {
      fs.rmSync(gate, { recursive: true, force: true });
    } catch {}
  }
}

function busyError(lockDir, code, detail) {
  const owner = readOwner(lockDir);
  const error = new Error(
    `ABORT: card publication transaction lock ${lockDir} ${detail}${
      owner ? ` (holder pid=${owner.pid} host=${owner.host} since ${owner.acquiredAt})` : ''
    }.`,
  );
  error.code = code;
  return error;
}

async function acquireFileLock(
  lockDir,
  { waitMs, staleMs, remoteStaleMs, hostName, ownerAliveFn, startTimeFn, deadlineAtMs, signal, pollMs },
) {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const nonce = crypto.randomBytes(8).toString('hex');
  const waitUntil = Math.min(
    Date.now() + waitMs,
    Number.isFinite(deadlineAtMs) && deadlineAtMs > 0 ? deadlineAtMs : Infinity,
  );
  for (;;) {
    if (signal?.aborted) {
      throw busyError(lockDir, 'CONTROLLER_DEADLINE_EXCEEDED', 'was not acquired before the controller deadline');
    }
    const attempt = tryInsideGate(lockDir, () => {
      try {
        fs.mkdirSync(lockDir);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (!isStale(lockDir, { staleMs, remoteStaleMs, hostName, ownerAliveFn, startTimeFn, nowMs: Date.now() })) return false;
        fs.rmSync(lockDir, { recursive: true, force: true });
        fs.mkdirSync(lockDir);
      }
      const at = new Date().toISOString();
      writeOwner(lockDir, {
        pid: process.pid,
        host: hostName,
        startTime: startTimeFn(process.pid),
        nonce,
        acquiredAt: at,
        heartbeatAt: at,
      });
      return true;
    });
    if (attempt.entered && attempt.value) break;
    if (Date.now() >= waitUntil) {
      throw busyError(
        lockDir,
        Number.isFinite(deadlineAtMs) && deadlineAtMs > 0 && Date.now() >= deadlineAtMs
          ? 'CONTROLLER_DEADLINE_EXCEEDED'
          : 'CARD_PUBLISH_TRANSACTION_BUSY',
        'is held by another publisher',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const heartbeat = setInterval(() => {
    const owner = readOwner(lockDir);
    if (!owner || owner.nonce !== nonce) return;
    try {
      writeOwner(lockDir, { ...owner, heartbeatAt: new Date().toISOString() });
    } catch {}
  }, HEARTBEAT_MS);
  heartbeat.unref();
  return () => {
    clearInterval(heartbeat);
    // Only the live owner deletes: after a stale takeover the directory belongs
    // to a successor with a different nonce.
    tryReleaseUntilGated(lockDir, nonce);
  };
}

function tryReleaseUntilGated(lockDir, nonce) {
  for (let i = 0; i < 200; i += 1) {
    const result = tryInsideGate(lockDir, () => {
      const owner = readOwner(lockDir);
      if (owner && owner.nonce === nonce) fs.rmSync(lockDir, { recursive: true, force: true });
    });
    if (result.entered) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  // Gate wedged: release anyway when we still own the lock.
  const owner = readOwner(lockDir);
  if (owner && owner.nonce === nonce) fs.rmSync(lockDir, { recursive: true, force: true });
}

// Resolves with an idempotent release once this caller owns the card's
// transaction both in-process and across processes.
async function acquireCardPublishTransaction(
  { dataDir, date, cardId },
  {
    waitMs = DEFAULT_WAIT_MS,
    staleMs = DEFAULT_STALE_MS,
    remoteStaleMs = DEFAULT_REMOTE_STALE_MS,
    hostName = os.hostname(),
    ownerAliveFn = defaultOwnerAlive,
    startTimeFn = defaultStartTime,
    deadlineAtMs = Number(process.env.BRIEFING_VERIFY_DEADLINE_AT_MS || 0),
    signal = null,
    pollMs = POLL_MS,
  } = {},
) {
  const lockDir = cardPublishLockDir({ dataDir, date, cardId });
  // Concurrent transactions inside one process queue here first; the file lock
  // alone would let them spin against each other.
  const previous = inProcessTails.get(lockDir) || Promise.resolve();
  let finishLocal;
  const local = new Promise((resolve) => {
    finishLocal = resolve;
  });
  const tail = previous.then(() => local);
  inProcessTails.set(lockDir, tail);
  const releaseLocal = () => {
    finishLocal();
    if (inProcessTails.get(lockDir) === tail) inProcessTails.delete(lockDir);
  };
  let releaseFile;
  try {
    await previous;
    releaseFile = await acquireFileLock(lockDir, {
      waitMs,
      staleMs,
      remoteStaleMs,
      hostName,
      ownerAliveFn,
      startTimeFn,
      deadlineAtMs,
      signal,
      pollMs,
    });
  } catch (error) {
    releaseLocal();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      releaseFile();
    } finally {
      releaseLocal();
    }
  };
}

async function withCardPublishTransaction(target, fn, options = {}) {
  const release = await acquireCardPublishTransaction(target, options);
  try {
    return await fn();
  } finally {
    release();
  }
}

module.exports = {
  acquireCardPublishTransaction,
  cardPublishLockDir,
  withCardPublishTransaction,
  LOCK_REL_DIR,
};
