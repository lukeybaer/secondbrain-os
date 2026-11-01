#!/usr/bin/env node
'use strict';

// Cloud-host cron: closes leaked command-less SSH tunnels and records how many
// logins are open. The decision lives in scripts/lib/ssh-idle-sessions.js; this
// file gathers `ps` and `ss`, keeps the state the plan needs (per-login byte
// observations and the burst history of tunnel-shaped starts), applies the
// plan, and writes the receipt.
//
// Usage:
//   node scripts/ssh-idle-session-reaper.js            # observe only, write receipt
//   node scripts/ssh-idle-session-reaper.js --apply    # also close the planned sessions
//
// Off switch: while <dataDir>/agent/ssh-session-health/reaper-disabled exists,
// every run is observe-only and the receipt says disabled: true. Deploys and
// the cron installer never touch that file.
//
// Clock step guard: the stored starts and observations are wall-clock times,
// and process ages run on the boot clock, which a wall-clock step does not
// move. Each scan reads a boot clock reference, the wall time less pid 1's
// age, and the state file keeps it. When it moved by more than 10 seconds
// since the last run, or either value is missing, the stored observations and
// burst history are discarded, so every streak restarts and burst counts come
// from the live logins only; the receipt says clockStepReset: true. Nothing
// can then close for at least 15 minutes.
//
// The CLI exits non-zero when the run failed, or when the receipt or the
// observation state could not be written.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  DEFAULTS,
  parsePsRows,
  parseSsRows,
  parseListenerPids,
  parseChannelPids,
  planIdleSessionReap,
  confirmTargets,
  stillOpen,
} = require('./lib/ssh-idle-sessions.js');

const RECEIPT_SCHEMA = 'secondbrain.ssh-session-health.v1';
// v2 adds the burst history. A v1 file reads as no history.
const OBSERVATIONS_SCHEMA = 'secondbrain.ssh-session-observations.v2';
// A hand cleanup measured that 50 closes with a 3 second pause caused no load
// spike, while one mass close drove the load average past 2,000. Each batch
// is revalidated with a full scan first.
const KILL_BATCH = 50;
const BATCH_PAUSE_MS = 3_000;
// The cron kills a run at 180 seconds. No batch starts after this much of the
// run has passed, so the receipt is always written.
const RUN_BUDGET_MS = 75_000;
// Each host read gets this long; a scan is five of them.
const READ_TIMEOUT_MS = 25_000;
// sshd's monitor relays SIGTERM to its child and exits after it, which takes
// a while on a swapped host, so survivors are read back once a second.
const VERIFY_POLL_MS = 1_000;
const VERIFY_POLLS = 12;
// A run lasts at most about two minutes, so an older temp file was left by a
// run that was killed mid-write.
const STALE_TEMP_MS = 5 * 60_000;
const OWN_TEMP = /^(?:latest|observations)\.json\.\d+\.tmp$/;

function receiptPaths(dataDir) {
  const root = path.join(dataDir, 'agent', 'ssh-session-health');
  return {
    root,
    latest: path.join(root, 'latest.json'),
    events: path.join(root, 'events.jsonl'),
    disabled: path.join(root, 'reaper-disabled'),
    observations: path.join(root, 'observations.json'),
  };
}

function message(error) {
  return String(error && error.message ? error.message : error);
}

// Only a confirmed absence of the switch file lets a run signal. Any other
// answer, including an unreadable directory, keeps the run observe-only.
function reaperDisabled(file) {
  try {
    fs.statSync(file);
    return true;
  } catch (error) {
    return !(error && error.code === 'ENOENT');
  }
}

function run(command, args, spawnSyncFn) {
  const result = spawnSyncFn(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: READ_TIMEOUT_MS });
  if (!result || result.error) throw new Error(`${command} failed: ${message(result && result.error)}`);
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${String(result.stderr || '').slice(0, 300)}`);
  return result.stdout;
}

// The five reads every decision rests on. Any failure throws, so a caller
// never acts on a partial picture. `scannedAt` is taken right after the
// socket read whose byte counters the plan compares.
function scanHost(spawnSyncFn, now) {
  const sockets = parseSsRows(
    run('sudo', ['-n', 'ss', '-tinpoH', 'state', 'established', '( sport = :22 )'], spawnSyncFn),
  );
  const scannedAt = now().getTime();
  // Without the listener tables a quiet remote forward could not be told
  // apart from a leaked tunnel. Only LISTENING unix sockets are read: every
  // sshd also owns unnamed and connected ones (the privsep socketpair,
  // syslog), so those cannot mark a forward. A connected unix-domain forward
  // (`ssh -L` to a socket path) is therefore a known limit.
  const listenerPids = new Set([
    ...parseListenerPids(run('sudo', ['-n', 'ss', '-tlnpH'], spawnSyncFn)),
    ...parseListenerPids(run('sudo', ['-n', 'ss', '-xlpH'], spawnSyncFn)),
  ]);
  // Without the all-port table a tunnel with a forwarded connection open
  // right now could not be told apart either.
  const channelPids = parseChannelPids(run('sudo', ['-n', 'ss', '-tnpH', 'state', 'established'], spawnSyncFn));
  // The process table is read last, so the command check is the freshest
  // evidence before a signal. The wall time taken right before it, less pid
  // 1's age from it, is the boot clock reference; a missing pid 1 gives null.
  const processesAt = now().getTime();
  const processes = parsePsRows(run('ps', ['-eo', 'pid=,ppid=,etimes=,args='], spawnSyncFn));
  const init = processes.find((row) => row.pid === 1);
  const bootReference = init && Number.isFinite(init.etimes) ? processesAt - init.etimes * 1000 : null;
  return { processes, sockets, listenerPids, channelPids, scannedAt, bootReference };
}

// True only when both references exist and agree within the tolerance.
function sameBootClock(stored, current, toleranceMs) {
  return Number.isFinite(stored) && Number.isFinite(current) && Math.abs(stored - current) <= toleranceMs;
}

// A missing, unreadable or corrupt state file means no history: nothing
// matches this run, the burst history is rebuilt from the live logins, and
// the file is rewritten.
function readObservations(file) {
  const none = (history) => ({ previous: null, bursts: null, bootReference: null, history });
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return none(error && error.code === 'ENOENT' ? 'none' : 'unreadable');
  }
  try {
    const parsed = JSON.parse(raw);
    const isMap = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    if (!isMap(parsed) || parsed.schema !== OBSERVATIONS_SCHEMA || !isMap(parsed.sessions) || !isMap(parsed.bursts)) {
      return none('corrupt');
    }
    const bootReference = Number.isFinite(parsed.bootReference) ? parsed.bootReference : null;
    return { previous: parsed.sessions, bursts: parsed.bursts, bootReference, history: 'ok' };
  } catch {
    return none('corrupt');
  }
}

function writeJsonAtomic(file, value, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
    // The mode above applies only to a new file; this covers a reused name.
    if (mode !== undefined) fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // The temp file was never created, or is not a file.
    }
    throw error;
  }
}

// Removes temp files this program left behind when a run was killed
// mid-write. Only its own names, only regular files, only old ones.
function removeStaleTemps(root, nowMs) {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!OWN_TEMP.test(name)) continue;
    const file = path.join(root, name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && nowMs - stat.mtimeMs > STALE_TEMP_MS) fs.unlinkSync(file);
    } catch {
      // Gone already, or not removable; the next run tries again.
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Reads the signalled pids back. Returns the targets still open, or null when
// the read itself failed. procps ps exits 1 when none of the pids exists.
function survivors(targets, spawnSyncFn) {
  const pids = targets.map((row) => row.monitorPid).join(',');
  const result = spawnSyncFn('ps', ['-o', 'pid=,ppid=,etimes=,args=', '-p', pids], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  if (!result || result.error || (result.status !== 0 && result.status !== 1)) return null;
  return stillOpen(targets, parsePsRows(result.stdout));
}

// A target that exited on its own between the check and the signal makes
// kill exit non-zero with "No such process". Only that, and nothing else on
// stderr, is not a kill failure.
function killFailed(result) {
  if (!result || result.error) return true;
  if (result.status === 0) return false;
  const lines = String(result.stderr || '')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  return !(lines.length && lines.every((line) => /No such process/.test(line)));
}

// Signals the plan in batches of 50 with a pause between them. Before each
// batch the host is scanned again in full, every matching session is
// re-checked by the same rules and each source's count recounted (still
// matching plus already closed this run); after it, the kill status is
// checked and the process table read back once a second for up to 12
// seconds. Returns an error message, or null. Any doubt stops this and every
// later batch from being signalled. No batch starts once the run budget is
// spent; the rest count as deferred.
function signalPlanned({ plan, planScan, receipt, spawnSyncFn, now, sleep, startedAt, options }) {
  const targets = plan.reap;
  const closed = [];
  for (let index = 0; index < targets.length; index += KILL_BATCH) {
    const planned = targets.slice(index, index + KILL_BATCH);
    const later = targets.length - index - planned.length;
    if (index > 0) sleep(BATCH_PAUSE_MS);
    if (now().getTime() - startedAt >= RUN_BUDGET_MS) {
      receipt.deferred += targets.length - index;
      return null;
    }
    let fresh;
    try {
      fresh = scanHost(spawnSyncFn, now);
    } catch (error) {
      receipt.skipped += targets.length - index;
      receipt.revalidationError = message(error).slice(0, 300);
      return 'could not re-read the host before signalling';
    }
    const confirmed = confirmTargets(planned, plan.matching, fresh, {
      elapsedSeconds: (fresh.scannedAt - planScan.scannedAt) / 1000,
      bursts: plan.bursts,
      closed,
      options,
    });
    receipt.skipped += planned.length - confirmed.length;
    if (!confirmed.length) continue;
    const killed = spawnSyncFn('sudo', ['-n', 'kill', ...confirmed.map((row) => String(row.monitorPid))], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    let open = confirmed;
    let unverified = false;
    for (let poll = 0; poll < VERIFY_POLLS && open.length; poll += 1) {
      sleep(VERIFY_POLL_MS);
      const left = survivors(open, spawnSyncFn);
      if (left === null) {
        unverified = true;
        break;
      }
      open = left;
    }
    const stillThere = new Set(open.map((row) => row.monitorPid));
    closed.push(...confirmed.filter((row) => !stillThere.has(row.monitorPid)));
    receipt.closed += confirmed.length - open.length;
    receipt.signalFailed += open.length;
    if (unverified) {
      receipt.skipped += later;
      return `could not verify ${open.length} signalled sessions closed`;
    }
    if (killFailed(killed) && open.length) {
      receipt.skipped += later;
      return `kill failed and ${open.length} signalled sessions are still open`;
    }
  }
  return null;
}

function reapIdleSshSessions({
  dataDir = process.env.SECONDBRAIN_DATA_DIR || '/opt/secondbrain/data',
  apply = false,
  now = () => new Date(),
  sleep = sleepSync,
  spawnSyncFn = spawnSync,
  options = {},
} = {}) {
  const paths = receiptPaths(dataDir);
  const startedAt = now().getTime();
  const receipt = {
    schema: RECEIPT_SCHEMA,
    observedAt: new Date(startedAt).toISOString(),
    host: os.hostname(),
    applied: false,
    disabled: reaperDisabled(paths.disabled),
    ok: false,
  };
  let signal = Boolean(apply) && !receipt.disabled;
  removeStaleTemps(paths.root, startedAt);
  try {
    const scan = scanHost(spawnSyncFn, now);
    const stored = readObservations(paths.observations);
    receipt.history = stored.history;
    // A stored history tied to another boot clock reference is discarded.
    const toleranceMs = { ...DEFAULTS, ...options }.clockToleranceSeconds * 1000;
    receipt.clockStepReset = stored.history === 'ok' && !sameBootClock(stored.bootReference, scan.bootReference, toleranceMs);
    const previous = receipt.clockStepReset ? null : stored.previous;
    const bursts = receipt.clockStepReset ? null : stored.bursts;
    const plan = planIdleSessionReap({ ...scan, previous, bursts, now: scan.scannedAt, options });
    receipt.counts = plan.counts;
    receipt.matching = plan.matching.length;
    receipt.targets = plan.targets;
    receipt.planned = plan.reap.length;
    receipt.deferred = plan.deferred;
    receipt.kept = plan.kept;
    // Counts only. The receipt never stores an address or anything derived
    // from one: a hash of an IPv4 address is reversible.
    receipt.sourcesWithTargets = new Set(plan.reap.map((row) => row.source)).size;
    receipt.skipped = 0;
    receipt.closed = 0;
    receipt.signalFailed = 0;
    let failure = null;
    // The next run's idleness and burst counts rest on this state, so a run
    // that cannot save it signals nothing. Only this program reads or writes it.
    try {
      writeJsonAtomic(
        paths.observations,
        {
          schema: OBSERVATIONS_SCHEMA,
          observedAt: new Date(scan.scannedAt).toISOString(),
          bootReference: scan.bootReference,
          sessions: plan.observations,
          bursts: plan.bursts,
        },
        { mode: 0o600 },
      );
    } catch (error) {
      receipt.stateWriteError = message(error).slice(0, 300);
      failure = 'could not save the observation state';
      signal = false;
    }
    if (signal && plan.reap.length) {
      failure = signalPlanned({ plan, planScan: scan, receipt, spawnSyncFn, now, sleep, startedAt, options });
    }
    receipt.applied = signal;
    if (failure) receipt.error = failure;
    receipt.ok = !failure;
  } catch (error) {
    receipt.error = message(error).slice(0, 500);
  }
  receipt.durationMs = now().getTime() - startedAt;
  try {
    writeJsonAtomic(paths.latest, receipt);
    if (!receipt.ok || receipt.planned > 0) {
      fs.appendFileSync(paths.events, `${JSON.stringify(receipt)}\n`, 'utf8');
    }
  } catch (error) {
    receipt.writeError = message(error).slice(0, 300);
  }
  return receipt;
}

function exitCodeFor(receipt) {
  return receipt.ok && !receipt.writeError && !receipt.stateWriteError ? 0 : 1;
}

function main({ argv = process.argv.slice(2), write = (text) => process.stdout.write(text), ...deps } = {}) {
  const receipt = reapIdleSshSessions({ ...deps, apply: argv.includes('--apply') });
  write(`${JSON.stringify(receipt)}\n`);
  return exitCodeFor(receipt);
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { RECEIPT_SCHEMA, OBSERVATIONS_SCHEMA, receiptPaths, reapIdleSshSessions, exitCodeFor, main };
