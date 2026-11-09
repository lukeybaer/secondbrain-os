'use strict';

// S-1 (#b 2026-10-28): keep the controller's liveness ping beating while a
// blocking child runs. The land gate runs as spawnSync inside the controller
// process, so the 60-second heartbeat timer cannot fire for the whole land;
// on Oct 27 the owner read ten silent minutes as a hung controller and killed
// a run that was busy landing its own repair.
//
// Two pieces:
//  1. A module-level registry. The controller registers its heartbeat file
//     and pid when it creates the heartbeat and clears it when it stops.
//  2. A sidecar process. `beatWhileBlocked(fn)` sets the stage, starts the
//     sidecar, runs the blocking work, then stops the sidecar and restores
//     the stage. The sidecar only ever bumps `lastBeatAt`, only for a file
//     whose `pid` is the parent it was given, only forwards in time, and it
//     exits on its own when the parent dies (stdin closes, or the pid is
//     gone) or when another writer owns the file.
//  3. Lease mode (Codex F3, 2026-10-28). In enforce mode the controller has
//     no legacy heartbeat file: its liveness is the conflict lease, renewed
//     by heartbeatConflictLease() on a timer that a blocking child also
//     stops, so the lease would expire and be swept mid-land. The same
//     sidecar renews the lease (token and run id arrive through its
//     environment, never argv) while the parent pid is alive, and exits when
//     the lease is gone. A registration may carry a file, a lease, or both.
//
// The sidecar never touches `lastOutputAt`: a ping proves the process is
// alive, not that it finished anything, and the supervisor's two-hour
// no-output ceiling still ends a land that never returns.

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const DEFAULT_SIDECAR_INTERVAL_MS = 15 * 1000;
const MIN_SIDECAR_INTERVAL_MS = 100;

const SIDECAR_LEASE_ENV = 'SB_HEARTBEAT_SIDECAR_LEASE';

let registered = null;

function leaseIdentity(lease) {
  if (!lease || typeof lease !== 'object' || !lease.token) return null;
  return { token: String(lease.token), runId: String(lease.runId || '') };
}

function registerBlockingHeartbeat({ file = '', pid = process.pid, setStage = () => {}, stage = () => '', lease = null, dataDir = '' } = {}) {
  const leaseRef = leaseIdentity(lease);
  if (!file && !(leaseRef && dataDir)) return null;
  registered = {
    file: file ? String(file) : '',
    pid: Number(pid),
    setStage,
    stage,
    lease: leaseRef && dataDir ? leaseRef : null,
    dataDir: leaseRef && dataDir ? String(dataDir) : '',
  };
  return registered;
}

function clearBlockingHeartbeat(target = null) {
  if (target && registered !== target) return;
  registered = null;
}

function currentBlockingHeartbeat() {
  return registered;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!error && error.code === 'EPERM';
  }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.sidecar.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

// One sidecar tick. Pure enough to unit test: every decision is returned.
function sidecarTick({ file, pid, nowMs = Date.now(), parentAlive = pidAlive }) {
  if (!parentAlive(pid)) return { wrote: false, exit: true, reason: 'parent-gone' };
  let json = null;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { wrote: false, exit: false, reason: 'unreadable' };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { wrote: false, exit: true, reason: 'not-an-object' };
  }
  if (Number(json.pid) !== Number(pid)) return { wrote: false, exit: true, reason: 'foreign-writer' };
  const previous = Date.parse(json.lastBeatAt);
  if (Number.isFinite(previous) && previous >= nowMs) return { wrote: false, exit: false, reason: 'monotonic' };
  json.lastBeatAt = new Date(nowMs).toISOString();
  try {
    writeJsonAtomic(file, json);
  } catch {
    return { wrote: false, exit: false, reason: 'write-failed' };
  }
  return { wrote: true, exit: false, reason: 'beat' };
}

// One lease tick: renew the conflict lease under the blocking stage while the
// parent is alive. A lease the store no longer holds ends the sidecar.
function sidecarLeaseTick({ dataDir, lease, stage = 'blocking', pid, nowMs = Date.now(), parentAlive = pidAlive, renew }) {
  if (!parentAlive(pid)) return { wrote: false, exit: true, reason: 'parent-gone' };
  const ref = leaseIdentity(lease);
  if (!ref || !dataDir) return { wrote: false, exit: true, reason: 'no-lease' };
  let renewed = false;
  try {
    const heartbeatLease = renew || require('./controller-conflict-leases.js').heartbeatConflictLease;
    renewed = heartbeatLease(ref, { dataDir, stage, nowMs }) === true;
  } catch {
    return { wrote: false, exit: false, reason: 'renew-failed' };
  }
  return renewed ? { wrote: true, exit: false, reason: 'lease-beat' } : { wrote: false, exit: true, reason: 'lease-gone' };
}

function startSidecar({ file = '', pid, intervalMs = DEFAULT_SIDECAR_INTERVAL_MS, lease = null, dataDir = '', stage = 'blocking', spawnFn = spawn }) {
  const leaseRef = leaseIdentity(lease);
  const env = { ...process.env };
  if (leaseRef && dataDir) env[SIDECAR_LEASE_ENV] = JSON.stringify({ dataDir: String(dataDir), lease: leaseRef, stage: String(stage || 'blocking') });
  else delete env[SIDECAR_LEASE_ENV];
  const child = spawnFn(
    process.execPath,
    [__filename, '--sidecar', file ? String(file) : '-', String(pid), String(intervalMs)],
    { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env },
  );
  if (child && typeof child.on === 'function') child.on('error', () => {});
  if (child && child.stdin && typeof child.stdin.on === 'function') child.stdin.on('error', () => {});
  return child;
}

function stopSidecar(child) {
  if (!child) return;
  try {
    if (child.stdin) child.stdin.end();
  } catch {
    // The child exits on its own once its parent pid is gone.
  }
  try {
    child.kill();
  } catch {
    // Already gone.
  }
}

// Run `fn` (normally a spawnSync) with the registered heartbeat kept alive.
// Without a registered heartbeat this is a plain call: a healer run outside
// the controller (tests, a daytime one-off) never spawns a sidecar.
function beatWhileBlocked(fn, { stage = 'blocking', intervalMs = DEFAULT_SIDECAR_INTERVAL_MS, heartbeat = registered, spawnFn } = {}) {
  if (!heartbeat || (!heartbeat.file && !(heartbeat.lease && heartbeat.dataDir))) return fn();
  let previousStage = '';
  try {
    previousStage = String(heartbeat.stage() || '');
  } catch {
    previousStage = '';
  }
  try {
    heartbeat.setStage(stage);
  } catch {
    // Observability only.
  }
  let child = null;
  try {
    child = startSidecar({ file: heartbeat.file, pid: heartbeat.pid, intervalMs, lease: heartbeat.lease, dataDir: heartbeat.dataDir, stage, spawnFn });
  } catch {
    child = null;
  }
  try {
    return fn();
  } finally {
    stopSidecar(child);
    try {
      heartbeat.setStage(previousStage || undefined);
    } catch {
      // Observability only.
    }
  }
}

// The awaited twin of beatWhileBlocked (S-5 part 2, 2026-10-29). The healer's
// land and deploy now run as async children, so the controller's own timers
// keep firing; the stage name and the sidecar stay so a supervisor still reads
// "landing" and the conflict lease keeps renewing exactly as before.
async function beatWhileAwaiting(fn, { stage = 'blocking', intervalMs = DEFAULT_SIDECAR_INTERVAL_MS, heartbeat = registered, spawnFn } = {}) {
  if (!heartbeat || (!heartbeat.file && !(heartbeat.lease && heartbeat.dataDir))) return fn();
  let previousStage = '';
  try {
    previousStage = String(heartbeat.stage() || '');
  } catch {
    previousStage = '';
  }
  try {
    heartbeat.setStage(stage);
  } catch {
    // Observability only.
  }
  let child = null;
  try {
    child = startSidecar({ file: heartbeat.file, pid: heartbeat.pid, intervalMs, lease: heartbeat.lease, dataDir: heartbeat.dataDir, stage, spawnFn });
  } catch {
    child = null;
  }
  try {
    return await fn();
  } finally {
    stopSidecar(child);
    try {
      heartbeat.setStage(previousStage || undefined);
    } catch {
      // Observability only.
    }
  }
}

// Stage names the supervisor accepts as "alive and blocked": land.js gets its
// own name so the alert can say what the controller was doing.
function blockingStageFor(command, args = []) {
  const joined = [command, ...(Array.isArray(args) ? args : [])].map((v) => String(v || '').replace(/\\/g, '/')).join(' ');
  return /(^|[\s/])scripts\/land\.js(\s|$)/.test(joined) ? 'landing' : 'blocking';
}

function parseSidecarLeaseEnv(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(String(raw));
    const ref = leaseIdentity(parsed && parsed.lease);
    if (!ref || !parsed.dataDir) return null;
    return { dataDir: String(parsed.dataDir), lease: ref, stage: String(parsed.stage || 'blocking') };
  } catch {
    return null;
  }
}

function runSidecarMain(argv = process.argv, env = process.env) {
  const file = String(argv[3] || '');
  const pid = Number(argv[4]);
  const intervalMs = Math.max(MIN_SIDECAR_INTERVAL_MS, Number(argv[5]) || DEFAULT_SIDECAR_INTERVAL_MS);
  const leaseJob = parseSidecarLeaseEnv(env[SIDECAR_LEASE_ENV]);
  const fileJob = file && file !== '-' ? file : '';
  const exit = () => process.exit(0);
  if ((!fileJob && !leaseJob) || !Number.isInteger(pid) || pid <= 0) exit();
  process.stdin.on('end', exit);
  process.stdin.on('close', exit);
  process.stdin.on('error', exit);
  process.stdin.resume();
  const tick = () => {
    if (fileJob && sidecarTick({ file: fileJob, pid }).exit) exit();
    if (leaseJob && sidecarLeaseTick({ ...leaseJob, pid }).exit) exit();
  };
  setInterval(tick, intervalMs);
}

if (require.main === module && process.argv[2] === '--sidecar') {
  runSidecarMain();
}

module.exports = {
  DEFAULT_SIDECAR_INTERVAL_MS,
  SIDECAR_LEASE_ENV,
  SIDECAR_SCRIPT: __filename,
  beatWhileAwaiting,
  beatWhileBlocked,
  blockingStageFor,
  clearBlockingHeartbeat,
  currentBlockingHeartbeat,
  pidAlive,
  registerBlockingHeartbeat,
  sidecarLeaseTick,
  sidecarTick,
  startSidecar,
  stopSidecar,
};
