'use strict';

// Run the name-judge orphan scan + free re-key recovery right after a recluster
// publishes new membership. The System Health rows
// `voice-name-judge-orphans` and `past-week-voice-name-judge-orphans` are bound
// to the recluster run id the scan describes, so any recluster newer than the
// last scan turns both red. The scan used to run only in the nightly refresh;
// the unknown-voice regroup runs about every 3 hours, so the rows were red most
// of the day. Idempotent (the scan re-keys only what still covers its cluster).
//
// The recluster launches the scan as its own detached process and returns at
// once, so the scan never eats a caller's step deadline (daytime catch-up gives
// the whole recluster six minutes). Callers that run their own orphan recovery
// right after the recluster (the call-processing healer) pass --no-orphan-scan.
//
// Every run of voice-name-judge-orphan-report.js, from any caller, holds one
// shared lock (withScanLock), so two scans never write the report, baseline or
// recovered judgments at once. A scan that finds the lock held waits its turn
// instead of skipping, so a newer recluster is never dropped: the waiter reads
// the newest membership once it runs. The detached run writes an outcome
// receipt so a failed scan is visible even when the recluster exited 0.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn: spawnAsync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCAN_SCRIPT = path.join('scripts', 'voice-name-judge-orphan-report.js');
const SCAN_ARGS = ['--recent-days', '7', '--apply', '--json'];
const SCAN_TIMEOUT_MS = 10 * 60 * 1000;
// A lock older than the scan bound plus slack belongs to a dead run.
const LOCK_STALE_MS = SCAN_TIMEOUT_MS + 5 * 60 * 1000;
// How long a scan waits for another scan to finish before giving up loudly.
const LOCK_WAIT_MS = 12 * 60 * 1000;
const LOCK_POLL_MS = 2000;
// The detached run may wait its turn and then scan.
const DETACHED_TIMEOUT_MS = LOCK_WAIT_MS + SCAN_TIMEOUT_MS;

function scanStatePaths(dataDir) {
  const dir = path.join(dataDir, 'voice-name-judge');
  return {
    dir,
    lock: path.join(dir, 'post-recluster-orphan-scan.lock'),
    outcome: path.join(dir, 'post-recluster-orphan-scan-last.json'),
  };
}

function defaultDataDir(root = ROOT, env = process.env) {
  return env.SECONDBRAIN_DATA_DIR || path.join(root, 'data');
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function readToken(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8')).token || null;
  } catch {
    return null;
  }
}

// One attempt. Returns the owner token, or null when a live scan holds it.
// A stale lock is reclaimed by an atomic rename to a name only this contender
// owns, so of two contenders that both see it stale, exactly one wins the
// rename; the other then finds the winner's fresh lock and waits.
function tryTakeLock(lockPath, nowMs) {
  const token = crypto.randomUUID();
  const body = JSON.stringify({ pid: process.pid, token, at: new Date(nowMs).toISOString() });
  try {
    fs.writeFileSync(lockPath, body, { flag: 'wx' });
    return token;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  let age;
  try {
    age = nowMs - fs.statSync(lockPath).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return tryTakeLock(lockPath, nowMs);
    throw error;
  }
  if (age < LOCK_STALE_MS) return null;
  const graveyard = `${lockPath}.stale-${token}`;
  try {
    fs.renameSync(lockPath, graveyard);
  } catch (error) {
    if (error.code === 'ENOENT') return null; // another contender reclaimed it first
    throw error;
  }
  fs.rmSync(graveyard, { force: true });
  try {
    fs.writeFileSync(lockPath, body, { flag: 'wx' });
    return token;
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    throw error;
  }
}

// Release only a lock this run still owns.
function releaseLock(lockPath, token) {
  if (readToken(lockPath) === token) fs.rmSync(lockPath, { force: true });
}

// Run fn while holding the shared scan lock, waiting up to waitMs for a scan
// already in progress. Returns { ok:false, reason } when the wait runs out.
function withScanLock(
  dataDir,
  fn,
  { waitMs = LOCK_WAIT_MS, pollMs = LOCK_POLL_MS, now = () => Date.now(), sleep = sleepSync } = {},
) {
  const { dir, lock } = scanStatePaths(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const deadline = now() + waitMs;
  let token = tryTakeLock(lock, now());
  while (!token) {
    if (now() >= deadline) {
      return { ok: false, reason: `another orphan scan still holds ${lock} after ${Math.round(waitMs / 1000)}s` };
    }
    sleep(pollMs);
    token = tryTakeLock(lock, now());
  }
  try {
    return { ok: true, value: fn() };
  } finally {
    releaseLock(lock, token);
  }
}

// Atomic receipt write: a crash mid-write never leaves a torn or stale-looking
// file. Throws on failure so the caller can report it.
function writeOutcome(dataDir, outcome) {
  const { dir, outcome: file } = scanStatePaths(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(outcome));
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

// Synchronous scan with an outcome receipt. This is what the detached child
// runs; the scan script itself takes the shared lock. Never throws.
function runPostReclusterOrphanScan({
  root = ROOT,
  env = process.env,
  dataDir = defaultDataDir(root, env),
  spawn = spawnSync,
  now = () => Date.now(),
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const startedMs = now();
  let outcome;
  try {
    const result = spawn(process.execPath, [path.join(root, SCAN_SCRIPT), ...SCAN_ARGS], {
      cwd: root,
      env: { ...env, SECONDBRAIN_DATA_DIR: dataDir },
      encoding: 'utf8',
      timeout: DETACHED_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      const why = result.error
        ? String(result.error.message || result.error)
        : `exit ${result.status}: ${String(result.stderr || '').trim().slice(-400)}`;
      outcome = { ok: false, reason: why };
    } else {
      outcome = { ok: true, reason: '' };
    }
  } catch (error) {
    outcome = { ok: false, reason: String(error?.message || error) };
  }
  if (!outcome.ok) log(`[post-recluster-orphan-scan] FAILED, the orphan rows stay red until the next scan: ${outcome.reason}`);
  try {
    writeOutcome(dataDir, {
      ok: outcome.ok,
      reason: outcome.reason,
      started_at: new Date(startedMs).toISOString(),
      finished_at: new Date(now()).toISOString(),
    });
  } catch (error) {
    outcome = { ok: false, reason: `${outcome.reason} (receipt write failed: ${error.message})`.trim() };
    log(`[post-recluster-orphan-scan] FAILED to write the outcome receipt: ${error.message}`);
  }
  return outcome;
}

// Called by the recluster: start the scan as a detached child and return at
// once. Never throws and never lets a launch failure crash the caller: spawn
// reports most launch failures later, through the child's 'error' event, so
// that event is handled and written to the receipt too.
function launchPostReclusterOrphanScan({
  root = ROOT,
  env = process.env,
  dataDir = defaultDataDir(root, env),
  spawn = spawnAsync,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const fail = (why) => {
    log(`[post-recluster-orphan-scan] FAILED to launch, the orphan rows stay red until the next scan: ${why}`);
    try {
      writeOutcome(dataDir, { ok: false, reason: `launch failed: ${why}`, finished_at: new Date().toISOString() });
    } catch (error) {
      log(`[post-recluster-orphan-scan] FAILED to write the outcome receipt: ${error.message}`);
    }
  };
  try {
    const child = spawn(process.execPath, [__filename], {
      cwd: root,
      env: { ...env, SECONDBRAIN_DATA_DIR: dataDir },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child && typeof child.on === 'function') child.on('error', (error) => fail(String(error?.message || error)));
    if (child && typeof child.unref === 'function') child.unref();
    return { launched: true };
  } catch (error) {
    const why = String(error?.message || error);
    fail(why);
    return { launched: false, reason: why };
  }
}

module.exports = {
  runPostReclusterOrphanScan,
  launchPostReclusterOrphanScan,
  withScanLock,
  tryTakeLock,
  scanStatePaths,
  SCAN_ARGS,
  LOCK_STALE_MS,
};

if (require.main === module) {
  const result = runPostReclusterOrphanScan();
  process.exitCode = result.ok ? 0 : 1;
}
