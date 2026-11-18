'use strict';

// Lock for a long-running unit of work (an execution plan can hold it for
// hours), unlike withFileLock in ledger-state-machine.js, which guards a short
// read-modify-write and judges staleness by mtime alone. A killed holder used
// to leave its `wx` lock behind and block the same unit forever (state machine
// audit finding #25, owner decision).
//
// The file records the holder's pid, host, start time and a token. A waiter
// takes over only when the holder is provably gone: its pid is dead on this
// host, or the lock has gone unrenewed too long. A live same-host pid is never
// taken over because the lock is old: the holder renews (mtime) on a heartbeat
// and before each phase, so age is measured from the last renewal. A pid that
// is alive but silent for liveOwnerMaxMs is a recycled pid (pid reuse); a
// holder on another host cannot be probed, so it goes by maxAgeMs of silence.
// The stale decision runs inside a short mutex and the dead file is renamed
// aside, so two waiters cannot both take over. Release is token-checked, and
// the holder fences itself with assertHeld()/renew() before each effect, so a
// holder judged stale by mistake stops instead of running beside its successor.

const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { withFileLock } = require('./ledger-state-machine');

const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000; // silence that expires a holder on another host
// A live same-host pid that has not renewed for this long is a recycled pid.
const DEFAULT_LIVE_OWNER_MAX_MS = 30 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 30 * 1000;
const WRITE_GRACE_MS = 5000; // a just-created lock may still be empty

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function readHolder(lockFile) {
  try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return null; }
}

function tryCreate(lockFile, holder) {
  let fd;
  try {
    fd = fs.openSync(lockFile, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    fs.writeSync(fd, JSON.stringify(holder));
  } catch (error) {
    try { fs.closeSync(fd); fs.unlinkSync(lockFile); } catch { /* best effort */ }
    throw error;
  }
  fs.closeSync(fd);
  return true;
}

/** Why a lock may be taken over, or null while its holder is still live. */
function staleReason(lockFile, holder, { maxAgeMs, liveOwnerMaxMs, isAlive, nowMs }) {
  let quietMs; // time since the holder last renewed (lock mtime)
  try {
    quietMs = nowMs() - fs.statSync(lockFile).mtimeMs;
  } catch {
    return 'gone';
  }
  if (!holder || !Number.isInteger(holder.pid)) return quietMs > WRITE_GRACE_MS ? 'unreadable' : null;
  const sameHost = !holder.host || holder.host === os.hostname();
  if (sameHost) {
    if (!isAlive(holder.pid)) return 'dead-holder';
    return quietMs > liveOwnerMaxMs ? 'expired' : null;
  }
  return quietMs > maxAgeMs ? 'expired' : null;
}

function heldError(lockFile, holder) {
  const error = new Error(`Lock ${lockFile} is held by pid ${holder && holder.pid} since ${holder && holder.startedAt}`);
  error.code = 'EEXIST';
  error.holder = holder || null;
  return error;
}

function lockLostError(lockFile) {
  const error = new Error(`Lock ${lockFile} was lost to another holder`);
  error.code = 'LOCK_LOST';
  return error;
}

// held/assertHeld/renew let the holder prove it still owns the lock before an
// effect; the heartbeat keeps a long phase from looking silent.
function makeHandle(lockFile, holder, tookOver, heartbeatMs) {
  const held = () => { const current = readHolder(lockFile); return Boolean(current) && current.token === holder.token; };
  const renew = () => {
    if (!held()) return false;
    try { const now = new Date(); fs.utimesSync(lockFile, now, now); return true; } catch { return false; }
  };
  const heartbeat = setInterval(renew, heartbeatMs);
  if (heartbeat.unref) heartbeat.unref();
  return {
    token: holder.token,
    tookOver,
    held,
    renew,
    assertHeld() { if (!held()) throw lockLostError(lockFile); },
    release() { clearInterval(heartbeat); return releasePidLock(lockFile, holder.token); },
  };
}

/**
 * Take the lock or throw (code EEXIST) while a live holder has it. Returns
 * { token, tookOver, held, renew, assertHeld, release }; tookOver names why a
 * stale lock was replaced. The returned handle renews the lock on a heartbeat.
 */
function acquirePidLock(lockFile, { maxAgeMs = DEFAULT_MAX_AGE_MS, liveOwnerMaxMs = DEFAULT_LIVE_OWNER_MAX_MS, heartbeatMs = DEFAULT_HEARTBEAT_MS,
  isAlive = pidAlive, nowMs = Date.now, pid = process.pid } = {}) {
  const holder = { pid, host: os.hostname(), startedAt: new Date(nowMs()).toISOString(), token: crypto.randomUUID() };
  const handle = tookOver => makeHandle(lockFile, holder, tookOver, heartbeatMs);
  if (tryCreate(lockFile, holder)) return handle(null);
  return withFileLock(lockFile, () => {
    if (tryCreate(lockFile, holder)) return handle(null);
    const current = readHolder(lockFile);
    const reason = staleReason(lockFile, current, { maxAgeMs, liveOwnerMaxMs, isAlive, nowMs });
    if (!reason) throw heldError(lockFile, current);
    if (reason !== 'gone') {
      const aside = `${lockFile}.stale-${process.pid}-${crypto.randomUUID()}`;
      try {
        fs.renameSync(lockFile, aside);
        try { fs.unlinkSync(aside); } catch { /* already gone */ }
      } catch { /* released meanwhile; the create below decides */ }
    }
    if (tryCreate(lockFile, holder)) return handle(reason);
    throw heldError(lockFile, readHolder(lockFile));
  });
}

/** Remove the lock only if this token still owns it. */
function releasePidLock(lockFile, token) {
  try {
    return withFileLock(lockFile, () => {
      const current = readHolder(lockFile);
      if (!current || current.token !== token) return false;
      fs.unlinkSync(lockFile);
      return true;
    });
  } catch {
    return false;
  }
}

module.exports = { acquirePidLock, releasePidLock, pidAlive, DEFAULT_MAX_AGE_MS, DEFAULT_LIVE_OWNER_MAX_MS, DEFAULT_HEARTBEAT_MS };
