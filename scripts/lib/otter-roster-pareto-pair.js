'use strict';

// One writer discipline for the recorder roster/Pareto pair (2026-10-19).
//
// The Pareto stamps source_roster_sha256 from the roster bytes it reads, but
// before this module nothing serialized roster writes against the Pareto's
// read-to-write window, and both producers wrote with a plain writeFileSync.
// On 2026-10-19 a roster write landed after the controller staged the card,
// the scoped QC recomputed the face from a mismatched pair and the card stayed
// red all day. Every roster writer and every Pareto build now takes this one
// pair lock, publishes atomically, and the Pareto re-hashes the roster right
// before it writes, so a pair can never be published from different bytes.
//
// The lock reuses the recluster publish lock (mkdir lock, owner nonce, reap
// gate, dead-owner reaping, 130-minute minimum stale window). It is reentrant
// in-process, and a child process started while the lock is held inherits it
// through SB_OTTER_ROSTER_PARETO_PAIR_LOCK when the owner nonce still matches,
// so a parent that runs the roster and Pareto children inside one critical
// section never deadlocks against them.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { lockDirFor, tryAcquireReclusterPublishLock } = require('./recluster-publish-lock.js');

const PAIR_LOCK_ENV = 'SB_OTTER_ROSTER_PARETO_PAIR_LOCK';
const PAIR_LOCK_ANCHOR_NAME = 'otter-roster-pareto-pair';
const ROSTER_FILE_NAME = 'otter-call-speaker-rosters-latest.json';
const PARETO_FILE_NAME = 'speaker-pareto-latest.json';
// The Pareto build holds the lock from roster read to Pareto write and runs
// under a five-minute command timeout, so a waiting writer waits slightly
// longer than that before it fails loud.
const DEFAULT_WAIT_BUDGET_MS = Number(process.env.SB_OTTER_PAIR_LOCK_WAIT_MS || 6 * 60 * 1000);
const DEFAULT_POLL_MS = 250;
const EXIT_ROSTER_MOVED = 75;
const EXIT_LOCK_TIMEOUT = 76;

class RosterParetoPairLockTimeoutError extends Error {
  constructor(lockDir, waitBudgetMs) {
    super(
      `OTTER-PAIR-LOCK-TIMEOUT: roster/Pareto pair lock at ${lockDir} stayed held for ${waitBudgetMs} ms; another roster or Pareto writer is still publishing`,
    );
    this.name = 'RosterParetoPairLockTimeoutError';
    this.code = 'OTTER_PAIR_LOCK_TIMEOUT';
    this.exitCode = EXIT_LOCK_TIMEOUT;
    this.lockDir = lockDir;
  }
}

class RosterParetoPairMovedError extends Error {
  constructor({ rosterPath, readSha256, currentSha256 }) {
    super(
      `OTTER-PAIR-ROSTER-MOVED: roster ${rosterPath} changed between the Pareto read (${String(readSha256 || 'none').slice(0, 12)}) and its write (${String(currentSha256 || 'none').slice(0, 12)}); the Pareto was not published and must rebuild on the new bytes`,
    );
    this.name = 'RosterParetoPairMovedError';
    this.code = 'OTTER_PAIR_ROSTER_MOVED';
    this.exitCode = EXIT_ROSTER_MOVED;
    this.readSha256 = readSha256 || null;
    this.currentSha256 = currentSha256 || null;
  }
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function voiceprintsDirFor(dataDir) {
  return path.join(path.resolve(String(dataDir || '')), 'life-archive', 'voiceprints');
}

function pairPathsForVoiceprintsDir(voiceprintsDir) {
  const dir = path.resolve(String(voiceprintsDir || ''));
  const lockAnchor = path.join(dir, PAIR_LOCK_ANCHOR_NAME);
  return {
    voiceprintsDir: dir,
    rosterPath: path.join(dir, ROSTER_FILE_NAME),
    paretoPath: path.join(dir, PARETO_FILE_NAME),
    lockAnchor,
    lockDir: lockDirFor(lockAnchor),
  };
}

function pairPaths(dataDir) {
  return pairPathsForVoiceprintsDir(voiceprintsDirFor(dataDir));
}

const heldInProcess = new Map();

function readOwnerNonce(lockDir) {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')).nonce || '');
  } catch {
    return '';
  }
}

// A child started by a holder inherits the lock only while the holder's owner
// record still carries the same nonce. A reaped or released lock is not held.
function inheritedFromParent(lockDir) {
  const token = String(process.env[PAIR_LOCK_ENV] || '');
  const separator = token.lastIndexOf('|');
  if (separator <= 0) return false;
  const tokenDir = token.slice(0, separator);
  const tokenNonce = token.slice(separator + 1);
  if (!tokenNonce || path.resolve(tokenDir) !== path.resolve(lockDir)) return false;
  return readOwnerNonce(lockDir) === tokenNonce;
}

function runSync(fn, label) {
  const result = fn();
  if (result && typeof result.then === 'function') {
    throw new TypeError(`${label} requires a synchronous callback`);
  }
  return result;
}

// Run fn while holding the roster/Pareto pair lock for the voiceprints dir.
// fn must be synchronous: the lock is released when it returns.
function withRosterParetoPairLockAt(voiceprintsDir, fn, options = {}) {
  const paths = pairPathsForVoiceprintsDir(voiceprintsDir);
  const key = paths.lockDir;
  const held = heldInProcess.get(key);
  if (held) {
    held.depth += 1;
    try {
      return runSync(() => fn(paths), 'withRosterParetoPairLock');
    } finally {
      held.depth -= 1;
    }
  }
  if (inheritedFromParent(key)) {
    heldInProcess.set(key, { depth: 1, inherited: true });
    try {
      return runSync(() => fn(paths), 'withRosterParetoPairLock');
    } finally {
      heldInProcess.delete(key);
    }
  }
  const pollMs = Math.max(1, Number(options.pollMs || DEFAULT_POLL_MS));
  const waitBudgetMs = Math.max(0, Number(options.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS));
  const lock = tryAcquireReclusterPublishLock(paths.lockAnchor, {
    retries: Math.ceil(waitBudgetMs / pollMs),
    waitMs: pollMs,
    ...(options.staleMs ? { staleMs: options.staleMs } : {}),
    ...(options.sleepFn ? { sleepFn: options.sleepFn } : {}),
    ...(options.ownerAliveFn ? { ownerAliveFn: options.ownerAliveFn } : {}),
  });
  if (!lock) throw new RosterParetoPairLockTimeoutError(key, waitBudgetMs);
  // Writer tag: the 2026-10-19 external writers could not be identified from
  // surviving files, so the owner record names the script that holds the pair.
  try {
    const ownerFile = path.join(key, 'owner.json');
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    if (owner.nonce === lock.nonce) {
      owner.writer = String(options.writer || path.basename(process.argv[1] || 'node'));
      fs.writeFileSync(ownerFile, `${JSON.stringify(owner)}\n`, 'utf8');
    }
  } catch {}
  heldInProcess.set(key, { depth: 1, nonce: lock.nonce });
  const hadEnv = Object.prototype.hasOwnProperty.call(process.env, PAIR_LOCK_ENV);
  const previousEnv = process.env[PAIR_LOCK_ENV];
  process.env[PAIR_LOCK_ENV] = `${key}|${lock.nonce}`;
  try {
    return runSync(() => fn(paths), 'withRosterParetoPairLock');
  } finally {
    if (hadEnv) process.env[PAIR_LOCK_ENV] = previousEnv;
    else delete process.env[PAIR_LOCK_ENV];
    heldInProcess.delete(key);
    lock.release();
  }
}

function withRosterParetoPairLock(dataDir, fn, options = {}) {
  return withRosterParetoPairLockAt(voiceprintsDirFor(dataDir), fn, options);
}

function isRetryableRenameError(error) {
  return ['EPERM', 'EBUSY', 'EACCES'].includes(error?.code);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

// Temp file in the same directory, fsync, then rename over the target, so a
// reader sees either the old complete file or the new complete file. Windows
// can briefly refuse a rename while a reader has the target open; retry that.
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt >= 40) {
        try {
          fs.rmSync(temp, { force: true });
        } catch {}
        throw error;
      }
      sleepSync(25);
    }
  }
}

function writeJsonAtomic(file, value, { trailingNewline = true } = {}) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}${trailingNewline ? '\n' : ''}`);
}

function readBytes(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function parseBytes(bytes) {
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function snapshotFromBytes(paths, rosterBytes, paretoBytes, mode) {
  const pareto = parseBytes(paretoBytes);
  const rosterSha256 = rosterBytes ? sha256Bytes(rosterBytes) : null;
  const paretoDeclaredRosterSha256 =
    String(pareto?.source_roster_sha256 || '')
      .trim()
      .toLowerCase() || null;
  return {
    rosterPath: paths.rosterPath,
    paretoPath: paths.paretoPath,
    rosterBytes,
    rosterSha256,
    roster: parseBytes(rosterBytes),
    pareto,
    paretoSha256: paretoBytes ? sha256Bytes(paretoBytes) : null,
    paretoDeclaredRosterSha256,
    pairConsistent: Boolean(rosterSha256 && paretoDeclaredRosterSha256 === rosterSha256),
    takenAt: new Date().toISOString(),
    mode,
  };
}

// One roster/Pareto pair, read at one instant. When the pair lock is free it
// is read inside the lock. When a writer holds it (a Pareto build can hold it
// for minutes), readers never block: both producers publish by atomic rename,
// so reading roster, Pareto, roster and accepting only an unchanged roster
// yields a pair that coexisted on disk at the moment the Pareto was read.
function readPairSnapshot(dataDir, options = {}) {
  const paths = options.voiceprintsDir
    ? pairPathsForVoiceprintsDir(options.voiceprintsDir)
    : pairPaths(dataDir);
  const lockedRead = () =>
    withRosterParetoPairLockAt(
      paths.voiceprintsDir,
      () => snapshotFromBytes(paths, readBytes(paths.rosterPath), readBytes(paths.paretoPath), 'locked'),
      { waitBudgetMs: 0, writer: options.writer || 'pair-snapshot-reader' },
    );
  // A reader never fails on the lock: a held lock, a missing directory or a
  // read-only data dir all fall through to the validated lock-free read.
  if (options.lock !== false && fs.existsSync(paths.voiceprintsDir)) {
    try {
      return lockedRead();
    } catch {}
  }
  const attempts = Math.max(1, Number(options.attempts || 5));
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = readBytes(paths.rosterPath);
    const paretoBytes = readBytes(paths.paretoPath);
    const after = readBytes(paths.rosterPath);
    const same =
      (before === null && after === null) ||
      (before !== null && after !== null && before.equals(after));
    last = snapshotFromBytes(paths, after, paretoBytes, 'validated');
    if (same) return last;
  }
  return { ...last, mode: 'unsettled' };
}

// Compact, serializable provenance for artifacts and receipts.
function pairSnapshotSummary(snapshot) {
  if (!snapshot) return null;
  return {
    rosterSha256: snapshot.rosterSha256 || null,
    paretoSha256: snapshot.paretoSha256 || null,
    paretoDeclaredRosterSha256: snapshot.paretoDeclaredRosterSha256 || null,
    pairConsistent: snapshot.pairConsistent === true,
    takenAt: snapshot.takenAt || null,
    mode: snapshot.mode || null,
  };
}

// Converge: a roster-only writer leaves the Pareto stamped with older bytes.
// When the pair has drifted, rebuild the Pareto. The Pareto build takes the
// pair lock itself and stamps whatever roster is current when it runs. With
// no Pareto on disk there is no pair to converge; the card's own source
// contract builds the first one.
function rosterParetoPairDrift(dataDir, options = {}) {
  const snapshot = readPairSnapshot(dataDir, options);
  return {
    drifted: Boolean(snapshot.rosterSha256 && snapshot.pareto) && !snapshot.pairConsistent,
    snapshot: pairSnapshotSummary(snapshot),
  };
}

function convergeRosterParetoPair({
  dataDir,
  repoRoot = path.resolve(__dirname, '..', '..'),
  node = process.execPath,
  spawn = spawnSync,
  timeoutMs = 5 * 60 * 1000,
} = {}) {
  const before = rosterParetoPairDrift(dataDir);
  if (!before.drifted) return { ok: true, rebuilt: false, before: before.snapshot, after: before.snapshot };
  const result = spawn(node, [path.join(repoRoot, 'scripts', 'otter-speaker-pareto-report.js')], {
    cwd: repoRoot,
    env: { ...process.env, SECONDBRAIN_DATA_DIR: path.resolve(String(dataDir)) },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const after = rosterParetoPairDrift(dataDir);
  return {
    ok: Number(result?.status) === 0 && !after.drifted,
    rebuilt: true,
    exitCode: result?.status ?? null,
    stderr: String(result?.stderr || '').slice(-2000),
    before: before.snapshot,
    after: after.snapshot,
  };
}

if (require.main === module) {
  if (process.argv.includes('--converge')) {
    const dataDir =
      process.env.SECONDBRAIN_DATA_DIR || path.resolve(__dirname, '..', '..', 'data');
    const outcome = convergeRosterParetoPair({ dataDir });
    process.stdout.write(`${JSON.stringify({ converge: outcome }, null, 2)}\n`);
    process.exitCode = outcome.ok ? 0 : 1;
  } else {
    process.stderr.write('usage: node scripts/lib/otter-roster-pareto-pair.js --converge\n');
    process.exitCode = 2;
  }
}

module.exports = {
  EXIT_LOCK_TIMEOUT,
  EXIT_ROSTER_MOVED,
  PAIR_LOCK_ENV,
  RosterParetoPairLockTimeoutError,
  RosterParetoPairMovedError,
  convergeRosterParetoPair,
  pairPaths,
  pairPathsForVoiceprintsDir,
  pairSnapshotSummary,
  readPairSnapshot,
  rosterParetoPairDrift,
  sha256Bytes,
  withRosterParetoPairLock,
  withRosterParetoPairLockAt,
  writeFileAtomic,
  writeJsonAtomic,
};
