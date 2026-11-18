#!/usr/bin/env node
'use strict';
//
// ship-lock.js -- the one production lock (S-8, owner decision).
//
// One JSON file on the production host, /opt/secondbrain/data/agent/ship.lock.json,
// replaces both "hold master by message" and scripts/deploy-hold.js:
//   kind 'ship'  a running `scripts/ship.js`; other ship runs queue behind it.
//   kind 'hold'  an attended freeze (a recorder cohort, an incident); at most
//                90 minutes, hard expiry, so a crashed agent cannot freeze
//                production.
// Every lock expires on its own, so a dead holder never blocks the queue.
//
// The queue is first come, first served (middle-ground ship, owner decision):
// a waiting ship run stands in `queue` inside the same file and refreshes its
// place every poll; a free lock goes to the oldest live waiter, and a waiter
// that stopped polling for QUEUE_STALE_MS drops out. A hold never waits in line.
//
// Writes are compare-and-swap under a kernel flock on the host: read the file,
// decide in JS, then write only if the bytes are still the ones read. Two
// sessions racing for a free lock cannot both win.
//
// deploy-ec2-server.sh pipes the file into `node scripts/lib/ship-lock.js check`;
// it refuses (exit 75, temporary) while any lock is held by someone other than
// the ship run named in SB_SHIP_RUN. Waiters in the queue hold nothing.

const crypto = require('node:crypto');
const os = require('node:os');

const LOCK_DIR = '/opt/secondbrain/data/agent';
const LOCK_FILE = `${LOCK_DIR}/ship.lock.json`;
const SCHEMA = 'ship_lock.v1';
// A ship lock covers only the deploy since ship-jam S-1 (target 10 minutes);
// 45 minutes bounds a stuck one. deploy-ec2-server.sh keeps its own swap lock.
const MAX_MINUTES = Object.freeze({ ship: 45, hold: 90 });
const BUSY = 75;
const QUEUE_STALE_MS = 3 * 60000;
const POLL_MS = 15000;
const MAX_TRANSPORT_FAILURES = 5;

class LockBusy extends Error {
  constructor(lock, { ahead = null, position = null } = {}) {
    super(ahead
      ? `production is free, but ${ahead.owner} queued first: ${ahead.reason}`
      : `production is locked (${lock.kind}) by ${lock.owner} until ${lock.expires_at}: ${lock.reason}`);
    this.lock = ahead ? { ...ahead, kind: 'queued' } : lock;
    this.position = position;
    this.code = 'SHIP_LOCK_BUSY';
  }
}

function parseLock(text) {
  try {
    const lock = JSON.parse(String(text || ''));
    return lock && typeof lock === 'object' ? lock : null;
  } catch {
    return null;
  }
}

function evaluateLock(lock, nowMs = Date.now()) {
  if (!lock || !lock.expires_at || !lock.token) return { held: false };
  const expires = Date.parse(lock.expires_at);
  if (!Number.isFinite(expires) || expires <= nowMs) return { held: false, expired: true };
  return {
    held: true,
    kind: lock.kind,
    token: lock.token,
    owner: lock.owner,
    reason: lock.reason,
    sha: lock.sha || null,
    expires_at: lock.expires_at,
    minutes_left: Math.ceil((expires - nowMs) / 60000),
  };
}

/** Waiting ship runs in arrival order, minus any that stopped polling. */
function liveQueue(lock, nowMs = Date.now()) {
  return (Array.isArray(lock && lock.queue) ? lock.queue : []).filter((e) => {
    const beat = Date.parse((e && e.heartbeat_at) || '');
    return Boolean(e && e.token) && Number.isFinite(beat) && nowMs - beat <= QUEUE_STALE_MS;
  });
}

/** The lock to write, or throws LockBusy when someone else holds it or queued first. */
function nextLock(current, { kind, token, owner, reason, sha = null, minutes }, nowMs = Date.now()) {
  if (!MAX_MINUTES[kind]) throw new Error(`unknown lock kind ${kind}`);
  const m = Number(minutes === undefined ? MAX_MINUTES[kind] : minutes);
  if (!Number.isFinite(m) || m < 1 || m > MAX_MINUTES[kind]) {
    throw new Error(`--minutes must be 1 through ${MAX_MINUTES[kind]} for a ${kind} lock.`);
  }
  if (!token) throw new Error('a lock needs a token');
  if (kind === 'hold' && (String(reason || '').trim().length < 12 || /[<>`]/.test(String(reason || '')))) {
    throw new Error('--reason must say why production must stay frozen.');
  }
  const active = evaluateLock(current, nowMs);
  if (active.held && current.token !== token) throw new LockBusy(current);
  const queue = liveQueue(current, nowMs);
  if (kind === 'ship' && !active.held) {
    const mine = queue.findIndex((e) => e.token === token);
    const ahead = mine === 0 ? null : queue[0] || null;
    if (ahead) throw new LockBusy(current, { ahead, position: mine === -1 ? queue.length + 1 : mine + 1 });
  }
  const lock = {
    schema: SCHEMA,
    kind,
    token,
    owner,
    reason: String(reason || '').trim(),
    sha,
    acquired_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + m * 60000).toISOString(),
  };
  const waiting = queue.filter((e) => e.token !== token);
  if (waiting.length) lock.queue = waiting;
  return lock;
}

/** The file with our place in line added or refreshed; the holder is untouched. */
function withQueueEntry(current, { token, owner, reason, sha = null }, nowMs = Date.now()) {
  const at = new Date(nowMs).toISOString();
  const queue = liveQueue(current, nowMs);
  const i = queue.findIndex((e) => e.token === token);
  if (i === -1) queue.push({ token, owner, reason: String(reason || '').trim(), sha, enqueued_at: at, heartbeat_at: at });
  else queue[i] = { ...queue[i], heartbeat_at: at };
  const holder = evaluateLock(current, nowMs).held ? { ...current } : { schema: SCHEMA };
  return { ...holder, queue };
}

/** The file without our place in line, or null when nothing is left in it. */
function withoutQueueEntry(current, token, nowMs = Date.now()) {
  const queue = liveQueue(current, nowMs).filter((e) => e.token !== token);
  const held = evaluateLock(current, nowMs).held;
  if (!held && !queue.length) return null;
  const out = held ? { ...current } : { schema: SCHEMA };
  if (queue.length) out.queue = queue;
  else delete out.queue;
  return out;
}

/** Exit status for deploy-ec2-server.sh: 0 clear or ours, 75 held by another. */
function checkLock(lock, runToken, nowMs = Date.now()) {
  const v = evaluateLock(lock, nowMs);
  if (!v.held) return { status: 0, line: 'CLEAR' };
  if (runToken && v.token === runToken) return { status: 0, line: `OWNED by this ship run (${v.token})` };
  return {
    status: BUSY,
    line: `HELD (${v.kind}) until ${v.expires_at} (${v.minutes_left} min) by ${v.owner}: ${v.reason}`,
  };
}

function ownerName(env = process.env) {
  const thread = env.CODEX_THREAD_ID || env.CLAUDE_SESSION_ID || '';
  return env.SB_SHIP_OWNER || `${os.userInfo().username}@${os.hostname()}${thread ? `:${thread}` : ''}`;
}

function newToken(kind = 'ship') {
  return `${kind}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(4).toString('hex')}`;
}

const digest = (text) => (text ? crypto.createHash('sha256').update(text).digest('hex') : 'none');

// --- transport ---------------------------------------------------------------
// `exec(command, {input})` returns {status, stdout, stderr}. Production uses
// ssh (or bash on the host itself with --local); tests pass a fake.

// ssh's own connection failures (exit 255, or our spawn timeout), never a
// remote command's answer. Retried: one dropped handshake must not kill a
// queued ship run (2026-11-15: kex_exchange_identification ended two waits).
const TRANSIENT_SSH = /kex_exchange_identification|ssh_exchange_identification|connection reset|connection timed out|operation timed out|connection closed by|connection refused|broken pipe|etimedout/i;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withRetry(exec, { attempts = 3, delaysMs = [2000, 5000], pause = sleepSync } = {}) {
  return (command, opts) => {
    let r;
    for (let i = 0; i < attempts; i += 1) {
      r = exec(command, opts);
      const sshFailed = r && (r.status === 255 || r.status === null) && TRANSIENT_SSH.test(String(r.stderr || ''));
      if (!sshFailed) return r;
      if (i < attempts - 1) pause(delaysMs[Math.min(i, delaysMs.length - 1)]);
    }
    return r;
  };
}

function remoteExec({ local = false, env = process.env } = {}) {
  if (local) {
    const { spawnSync } = require('node:child_process');
    return (command, { input } = {}) => {
      // No timer: the only blocking step is `flock -w 20`, which bounds itself.
      const r = spawnSync('bash', ['-c', command], { input, encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
    };
  }
  const { runRemote } = require('./ec2-remote.js');
  return withRetry((command, { input } = {}) => runRemote(command, { input, env }));
}

function readRaw(exec) {
  const r = exec(`cat ${LOCK_FILE} 2>/dev/null || true`);
  if (r.status !== 0) throw new Error(`could not read the ship lock: ${String(r.stderr).trim()}`);
  return r.stdout || '';
}

// Compare-and-swap: replace (or delete, when next is null) only if the file
// still hashes to `expected` ('none' = absent). Exit 75 means it moved.
function casCommand(expected, next) {
  const write = next === null ? `rm -f ${LOCK_FILE}` : `cat > ${LOCK_FILE}.tmp && mv ${LOCK_FILE}.tmp ${LOCK_FILE}`;
  return [
    'set -e',
    `mkdir -p ${LOCK_DIR}`,
    `exec 9>${LOCK_FILE}.flock`,
    'flock -w 20 9',
    `if [ -f ${LOCK_FILE} ]; then cur=$(sha256sum ${LOCK_FILE} | cut -d' ' -f1); else cur=none; fi`,
    `[ "$cur" = "${expected}" ] || exit ${BUSY}`,
    write,
  ].join('; ');
}

function cas(exec, raw, next) {
  return next === null
    ? exec(casCommand(digest(raw), null))
    : exec(casCommand(digest(raw), next), { input: `${JSON.stringify(next, null, 2)}\n` });
}

/**
 * One attempt. With `queue: true` (ship.js waiting) a refused ship run also
 * takes or refreshes its place in line before LockBusy is thrown.
 */
function tryAcquire(exec, spec, nowMs = Date.now()) {
  const raw = readRaw(exec);
  const current = parseLock(raw);
  let lock;
  try {
    lock = nextLock(current, spec, nowMs);
  } catch (err) {
    if (err.code === 'SHIP_LOCK_BUSY' && spec.queue && spec.kind === 'ship') {
      const queued = withQueueEntry(current, spec, nowMs);
      const r = cas(exec, raw, queued);
      if (r.status !== 0 && r.status !== BUSY) throw new Error(`could not write the ship queue: ${String(r.stderr).trim()}`);
      err.position = queued.queue.findIndex((e) => e.token === spec.token) + 1;
    }
    throw err;
  }
  const r = cas(exec, raw, lock);
  if (r.status === BUSY) return { acquired: false, raced: true };
  if (r.status !== 0) throw new Error(`could not write the ship lock: ${String(r.stderr).trim()}`);
  return { acquired: true, lock };
}

/** Drop our place in line (a waiter that gave up). Best effort: a stale place expires anyway. */
function leaveQueue(exec, token, nowMs = Date.now()) {
  for (let i = 0; i < 3; i += 1) {
    try {
      const raw = readRaw(exec);
      const current = parseLock(raw);
      if (!liveQueue(current, nowMs).some((e) => e.token === token)) return true;
      const r = cas(exec, raw, withoutQueueEntry(current, token, nowMs));
      if (r.status === 0) return true;
      if (r.status !== BUSY) return false;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Stand in line for the lock: retry every pollMs until waitMs passes.
 * @returns {Promise<{acquired:boolean, lock?:object, holder?:object}>}
 */
async function acquire(exec, spec, { waitMs = 45 * 60000, pollMs = POLL_MS, now = Date.now, sleep, log = () => {} } = {}) {
  const pause = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + waitMs;
  let announced = null;
  let holder = null;
  let failures = 0;
  for (;;) {
    let wait = pollMs;
    try {
      const got = tryAcquire(exec, { ...spec, queue: true }, now());
      failures = 0;
      if (got.acquired) return got;
      wait = Math.min(pollMs, 2000); // raced: another writer moved the file; look again soon
    } catch (err) {
      if (err.code !== 'SHIP_LOCK_BUSY') {
        failures += 1;
        if (failures >= MAX_TRANSPORT_FAILURES) throw err;
        log(`[ship] queue: lock read failed (${failures}/${MAX_TRANSPORT_FAILURES}), retrying: ${String(err.message).slice(0, 200)}`);
      } else {
        failures = 0;
        holder = err.lock;
        const key = `${err.lock.token}#${err.position || ''}`;
        if (announced !== key) {
          log(`[ship] queued${err.position ? ` (#${err.position} in line)` : ''}: ${err.message}`);
          announced = key;
        }
      }
    }
    if (now() + wait > deadline) {
      leaveQueue(exec, spec.token, now());
      return { acquired: false, holder: holder || { owner: 'unknown', kind: 'unknown', reason: 'the lock could not be read' } };
    }
    await pause(wait);
  }
}

/** Release only a lock we hold; a lock someone else took after expiry stays. The line stays. */
function release(exec, token, nowMs = Date.now()) {
  for (let i = 0; i < 5; i += 1) {
    const raw = readRaw(exec);
    const lock = parseLock(raw);
    if (!lock || lock.token !== token) return { released: false, reason: 'not ours' };
    const queue = liveQueue(lock, nowMs);
    const r = cas(exec, raw, queue.length ? { schema: SCHEMA, queue } : null);
    if (r.status !== BUSY) return { released: r.status === 0 };
    // a waiter refreshed its place between our read and write: read again
  }
  return { released: false, reason: 'the lock file kept moving' };
}

function status(exec, nowMs = Date.now()) {
  const lock = parseLock(readRaw(exec));
  const v = evaluateLock(lock, nowMs);
  const queue = liveQueue(lock, nowMs).map((e) => ({ owner: e.owner, reason: e.reason, enqueued_at: e.enqueued_at }));
  return queue.length ? { ...v, queue } : v;
}

module.exports = {
  BUSY,
  LOCK_FILE,
  MAX_MINUTES,
  QUEUE_STALE_MS,
  LockBusy,
  acquire,
  casCommand,
  checkLock,
  digest,
  evaluateLock,
  leaveQueue,
  liveQueue,
  newToken,
  nextLock,
  ownerName,
  parseLock,
  release,
  remoteExec,
  status,
  tryAcquire,
  withRetry,
};

if (require.main === module) {
  // `... | node scripts/lib/ship-lock.js check` (deploy-ec2-server.sh)
  if (process.argv[2] !== 'check') {
    process.stderr.write('usage: <lock json> | node scripts/lib/ship-lock.js check\n');
    process.exit(2);
  }
  let text = '';
  try {
    text = require('node:fs').readFileSync(0, 'utf8');
  } catch {
    text = '';
  }
  const v = checkLock(parseLock(text), process.env.SB_SHIP_RUN || '');
  process.stdout.write(`${v.line}\n`);
  process.exit(v.status);
}
