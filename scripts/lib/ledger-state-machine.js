'use strict';

// One shared shape for the ledgers whose status moves through states
// (state machine audit, Owner decision,
// https://claude.ai/artifact/8wKEsESFcNyAEzGz1CJEFC). The audit found the same
// four causes everywhere: status is free text with several spellings, nothing
// refuses an illegal move (sent back to armed), in-flight states never expire,
// and several processes rewrite the same JSON file without a lock.
//
// defineStateMachine() answers the first three; withFileLock() and
// updateJsonLocked() answer the fourth. A caller that does slow work (network
// calls, uploads) must NOT hold the lock across it: read, release, do the work,
// then re-read under the lock and apply only its own row's transition, so a
// newer write from another process is never replaced by a stale copy.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJsonAtomicRetry } = require('./write-json-atomic-retry');

class IllegalTransitionError extends Error {
  constructor(machine, from, to) {
    super(`${machine}: illegal transition ${from ?? '(none)'} -> ${to}`);
    this.name = 'IllegalTransitionError';
    this.code = 'ILLEGAL_TRANSITION';
    this.machine = machine;
    this.from = from;
    this.to = to;
  }
}

/**
 * Declare a ledger's states and legal moves.
 *
 * @param {object} spec
 * @param {string} spec.name
 * @param {Object<string,string[]>} spec.transitions  from -> allowed targets.
 *   Use the key '' for the moves allowed from a record with no state yet.
 * @param {string[]} [spec.terminal]  states nothing may leave.
 * @param {Object<string,string>} [spec.aliases]  old spelling -> canonical.
 * @param {Object<string,{ttlMs?:number,maxAttempts?:number}>} [spec.inFlight]
 */
function defineStateMachine(spec) {
  const name = String(spec?.name || '').trim();
  if (!name) throw new Error('defineStateMachine: name is required');
  const transitions = spec.transitions || {};
  const terminal = new Set(spec.terminal || []);
  const aliases = spec.aliases || {};
  const inFlight = spec.inFlight || {};

  const states = new Set();
  for (const [from, targets] of Object.entries(transitions)) {
    if (from) states.add(from);
    for (const to of targets) states.add(to);
  }
  for (const s of terminal) states.add(s);
  for (const s of Object.keys(inFlight)) states.add(s);
  for (const s of terminal) {
    if ((transitions[s] || []).length) {
      throw new Error(`${name}: terminal state ${s} must not have outgoing transitions`);
    }
  }
  for (const target of Object.values(aliases)) {
    if (!states.has(target)) throw new Error(`${name}: alias target ${target} is not a declared state`);
  }

  // Unknown spellings stay as-is so canTransition refuses them; they never
  // silently become a legal state.
  function normalize(value) {
    if (value == null || value === '') return '';
    const raw = String(value).trim();
    if (states.has(raw)) return raw;
    if (Object.prototype.hasOwnProperty.call(aliases, raw)) return aliases[raw];
    return raw;
  }

  function isKnown(value) {
    const s = normalize(value);
    return s === '' || states.has(s);
  }

  function canTransition(from, to) {
    const f = normalize(from);
    const t = normalize(to);
    if (!states.has(t)) return false;
    if (f !== '' && !states.has(f)) return false;
    if (terminal.has(f)) return false;
    return (transitions[f] || []).includes(t);
  }

  function assertTransition(from, to) {
    if (!canTransition(from, to)) throw new IllegalTransitionError(name, normalize(from) || null, normalize(to));
    return normalize(to);
  }

  function isTerminal(value) {
    return terminal.has(normalize(value));
  }

  function isInFlight(value) {
    return Object.prototype.hasOwnProperty.call(inFlight, normalize(value));
  }

  /**
   * True when a record has sat in an in-flight state past its TTL.
   * `since` is the ISO time or epoch ms the record entered that state.
   */
  function isExpired(state, since, now = Date.now()) {
    const s = normalize(state);
    const rule = inFlight[s];
    if (!rule || !Number.isFinite(rule.ttlMs)) return false;
    const t = typeof since === 'number' ? since : Date.parse(since || '');
    if (!Number.isFinite(t)) return true; // no timestamp: cannot prove it is live
    return now - t > rule.ttlMs;
  }

  function attemptsExhausted(state, attempts) {
    const rule = inFlight[normalize(state)];
    if (!rule || !Number.isFinite(rule.maxAttempts)) return false;
    return Number(attempts || 0) >= rule.maxAttempts;
  }

  return Object.freeze({
    name,
    states: Object.freeze([...states]),
    terminal: Object.freeze([...terminal]),
    normalize,
    isKnown,
    canTransition,
    assertTransition,
    isTerminal,
    isInFlight,
    isExpired,
    attemptsExhausted,
  });
}

const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 120_000;
// A lock whose owner pid is still alive is not stale until this ceiling, so a
// slow owner keeps its lock and a recycled pid cannot hold a ledger forever.
const LOCK_LIVE_OWNER_MAX_MS = 30 * 60_000;
// The async holder refreshes its lock's mtime, so only a dead holder goes stale.
const LOCK_HEARTBEAT_MS = 30_000;
// A temp record this old was left by a crash between its write and its link.
const LOCK_TEMP_STALE_MS = 60_000;
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);
// Tokens of the locks this process holds right now, shared by every copy of
// this module in the process. A record with our pid but an unknown token was
// left by an earlier process that had our pid, so it gets no liveness credit.
const LIVE_TOKENS = Symbol.for('secondbrain.ledger-state-machine.liveTokens');
const liveTokens = globalThis[LIVE_TOKENS] || (globalThis[LIVE_TOKENS] = new Set());

// Lock protocol (Codex review 7c11e451c062, F1). `${file}.locks/` holds numbered
// generation records g000000000001, g000000000002, ... Each record is published
// whole by an exclusive hard link, so exactly one party can create a number.
// The highest number is the lock state: "held|free <pid> <iso> <token>".
// - Acquire: judge the top record n-1 (free, or held by a dead owner), create n
//   as held, then re-read n-1 and list the records. A different token at n-1, or
//   any record above n, means our n was a pruned number re-created from a stale
//   view; it is closed with a free record and we try again.
// - Hold: we own n while n+1 does not exist and n still carries our token
//   (successor checked first, because records are pruned lowest first).
// - Release, recovery and giving up only CREATE the next record. Nothing renames
//   a record and nothing deletes the top two, so a delayed party can only fail a
//   create; it can never remove or supersede a live owner's record.
// - A new owner at n prunes records n-2 and lower, lowest first.
// A plain `${file}.lock` file (an operator's or an older build's hold) is
// waited for while it looks live and is never removed.

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockBusyError(file) {
  const err = new Error(`ledger busy: ${path.basename(file)}`);
  err.code = 'LEDGER_BUSY';
  return err;
}

function lockLostError(file) {
  const err = new Error(`ledger lock lost, refusing to write: ${path.basename(file)}`);
  err.code = 'LEDGER_LOCK_LOST';
  return err;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

const GEN_RE = /^g(\d{12})$/;
const genPath = (dir, n) => path.join(dir, `g${String(n).padStart(12, '0')}`);

function listRecords(names) {
  const out = [];
  for (const name of names) {
    const m = GEN_RE.exec(name);
    if (m) out.push(Number(m[1]));
  }
  return out.sort((a, b) => a - b);
}

// Null when the record is missing or unreadable, so every check fails closed.
function readRecord(io, file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const [kind, pid, , token] = io.readFileSync(file, 'utf8').trim().split(/\s+/);
      const { mtimeMs } = io.statSync(file);
      return { kind, pid: Number(pid), token: token || '', mtimeMs };
    } catch (error) {
      if (!TRANSIENT.has(error.code) || attempt >= 3) return null;
      sleepSync(5);
    }
  }
}

// Any answer but "not found" counts as present, so a successor check fails closed.
function present(io, file) {
  try {
    io.statSync(file);
    return true;
  } catch (error) {
    return error.code !== 'ENOENT';
  }
}

// Write a private temp file, then hard-link it to the record name, which fails
// if the name exists. Returns 'created', 'exists' or 'retry'.
function createRecord(io, dir, n, kind, token, nowMs) {
  const temp = path.join(dir, `${crypto.randomUUID()}.tmp`);
  const target = genPath(dir, n);
  try {
    io.writeFileSync(temp, `${kind} ${process.pid} ${new Date(nowMs()).toISOString()} ${token}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'ENOENT' || TRANSIENT.has(error.code)) return 'retry';
    throw error;
  }
  try {
    io.linkSync(temp, target);
    return 'created';
  } catch (error) {
    if (error.code === 'EEXIST') return 'exists';
    if (error.code === 'ENOENT') return 'retry';
    if (TRANSIENT.has(error.code)) return readRecord(io, target)?.token === token ? 'created' : 'retry';
    throw error;
  } finally {
    try { io.unlinkSync(temp); } catch { /* pruned as stale */ }
  }
}

function acquirable(rec, nowMs, staleMs) {
  if (rec.kind === 'free') return true;
  const age = nowMs() - rec.mtimeMs;
  if (age <= staleMs) return false;
  const alive = rec.pid === process.pid ? liveTokens.has(rec.token) : pidAlive(rec.pid);
  return !alive || age > LOCK_LIVE_OWNER_MAX_MS;
}

function outsideHold(io, lockFile, staleMs, nowMs) {
  let mtimeMs;
  try {
    ({ mtimeMs } = io.statSync(lockFile));
  } catch (error) {
    return error.code !== 'ENOENT';
  }
  const age = nowMs() - mtimeMs;
  if (age <= staleMs) return true;
  let pid = NaN;
  try { pid = Number(io.readFileSync(lockFile, 'utf8').trim().split(/\s+/)[0]); } catch { /* removed */ }
  return pid !== process.pid && pidAlive(pid) && age <= LOCK_LIVE_OWNER_MAX_MS;
}

function stillHeld(owned) {
  const { io, dir, n, token } = owned;
  if (present(io, genPath(dir, n + 1))) return false;
  const own = readRecord(io, genPath(dir, n));
  return own?.kind === 'held' && own.token === token;
}

// Close our generation with a free record. When a successor exists the create
// fails and leaves the successor alone.
function releaseOwned(owned, nowMs) {
  liveTokens.delete(owned.token);
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (createRecord(owned.io, owned.dir, owned.n + 1, 'free', crypto.randomUUID(), nowMs) !== 'retry') return;
      sleepSync(25);
    }
  } catch { /* left to go stale, as before */ }
}

// Delete records n-2 and lower, lowest first, stopping at the first one that
// cannot be deleted: a missing record then always means every lower one is
// gone too, which the predecessor check relies on.
function prune(io, dir, n, records, names, nowMs) {
  for (const k of records) {
    if (k > n - 2) break;
    try { io.unlinkSync(genPath(dir, k)); } catch (error) { if (error.code !== 'ENOENT') break; }
  }
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue;
    const temp = path.join(dir, name);
    try {
      if (nowMs() - io.statSync(temp).mtimeMs > LOCK_TEMP_STALE_MS) io.unlinkSync(temp);
    } catch { /* linked and removed meanwhile */ }
  }
}

const BUSY = 'busy';
const RACE = 'race';

function attemptOnce(file, dir, { io, staleMs, nowMs }) {
  if (outsideHold(io, `${file}.lock`, staleMs, nowMs)) return BUSY;
  io.mkdirSync(dir, { recursive: true });
  const top = listRecords(io.readdirSync(dir)).pop();
  if (top === undefined) {
    // First use starts the chain with a free record. A copy re-created from a
    // stale view is only a free record below the top, which nobody reads.
    createRecord(io, dir, 1, 'free', crypto.randomUUID(), nowMs);
    return RACE;
  }
  const seen = readRecord(io, genPath(dir, top));
  if (!seen) return RACE;
  if (!acquirable(seen, nowMs, staleMs)) return BUSY;
  const owned = { io, dir, file, n: top + 1, token: crypto.randomUUID(), lost: false };
  liveTokens.add(owned.token);
  if (createRecord(io, dir, owned.n, 'held', owned.token, nowMs) !== 'created') {
    liveTokens.delete(owned.token);
    return RACE;
  }
  const names = io.readdirSync(dir);
  const records = listRecords(names);
  if (readRecord(io, genPath(dir, top))?.token !== seen.token || records.some((k) => k > owned.n)) {
    releaseOwned(owned, nowMs);
    return RACE;
  }
  prune(io, dir, owned.n, records, names, nowMs);
  return owned;
}

// A lost race is retried at once, so a fail-fast caller hears "busy" only when
// someone really holds the lock.
function tryAcquire(file, dir, opts) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = attemptOnce(file, dir, opts);
    if (result === BUSY) return null;
    if (result !== RACE) return result;
  }
  return null;
}

function lockHandle(owned) {
  const held = () => !owned.lost && stillHeld(owned);
  return {
    held,
    assertHeld() {
      if (!held()) throw lockLostError(owned.file);
    },
  };
}

/**
 * Run fn(lock) while holding the ledger's lock. Synchronous; keep fn short.
 * lock.assertHeld() throws if the lock was taken over; call it just before a
 * write that must not race another holder.
 */
function withFileLock(file, fn, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, nowMs = Date.now, io = fs } = {}) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const opts = { io, staleMs, nowMs };
  const deadline = nowMs() + waitMs;
  let owned;
  while (!(owned = tryAcquire(file, `${file}.locks`, opts))) {
    if (nowMs() >= deadline) throw lockBusyError(file);
    sleepSync(50);
  }
  try {
    return fn(lockHandle(owned));
  } finally {
    releaseOwned(owned, nowMs);
  }
}

// One heartbeat: prove we still hold the lock, then refresh our record's mtime.
function beat(owned) {
  if (!stillHeld(owned)) return false;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const t = new Date();
      owned.io.utimesSync(genPath(owned.dir, owned.n), t, t);
      return true;
    } catch (error) {
      if (!TRANSIENT.has(error.code) || attempt >= 3) return false;
      sleepSync(5);
    }
  }
}

/** Async twin of withFileLock for server code that must not block its event loop. */
async function withFileLockAsync(file, fn, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, nowMs = Date.now, heartbeatMs = LOCK_HEARTBEAT_MS, io = fs } = {}) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const opts = { io, staleMs, nowMs };
  const deadline = nowMs() + waitMs;
  let owned;
  while (!(owned = tryAcquire(file, `${file}.locks`, opts))) {
    if (nowMs() >= deadline) throw lockBusyError(file);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const lock = lockHandle(owned);
  // A holder that cannot prove and refresh its lock stops writing for good.
  const heartbeat = setInterval(() => {
    if (beat(owned)) return;
    owned.lost = true;
    clearInterval(heartbeat);
  }, heartbeatMs);
  heartbeat.unref?.();
  try {
    return await fn(lock);
  } finally {
    clearInterval(heartbeat);
    releaseOwned(owned, nowMs);
  }
}

/**
 * Read a JSON file. Missing -> fallback. Corrupt -> throws, because treating a
 * half-written ledger as empty and rewriting it would erase every row in it.
 */
function readJsonStrict(file, fallback = null) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return typeof fallback === 'function' ? fallback() : structuredClone(fallback);
    throw error;
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw new Error(`ledger unreadable, refusing to rewrite: ${path.basename(file)}: ${error.message}`);
  }
}

/**
 * Locked read-modify-write of a JSON file. `mutate(current)` returns the next
 * value, or undefined to keep its in-place edits. Returning the same value
 * unchanged still rewrites; return `updateJsonLocked.SKIP` to write nothing.
 */
function updateJsonLocked(file, mutate, { fallback = null, ...lockOpts } = {}) {
  return withFileLock(file, (lock) => {
    const current = readJsonStrict(file, fallback);
    const result = mutate(current);
    if (result === SKIP) return current;
    const next = result === undefined ? current : result;
    lock.assertHeld();
    writeJsonAtomicRetry(file, next, { io: ownedWriteIo(lock, lockOpts.io || fs) });
    return next;
  }, lockOpts);
}

// Ownership is checked again immediately before the rename that publishes the
// write (and before each Windows retry of it), so a holder that lost its lock
// while writing the temp file publishes nothing.
function ownedWriteIo(lock, io) {
  return Object.assign(Object.create(io), {
    renameSync(from, to) {
      lock.assertHeld();
      return io.renameSync(from, to);
    },
  });
}
const SKIP = Symbol('updateJsonLocked.SKIP');
updateJsonLocked.SKIP = SKIP;

module.exports = {
  IllegalTransitionError,
  defineStateMachine,
  withFileLock,
  withFileLockAsync,
  readJsonStrict,
  updateJsonLocked,
};
