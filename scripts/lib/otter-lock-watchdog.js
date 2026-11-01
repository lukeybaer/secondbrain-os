'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The live/historical recorder scheduler lock is a bare flock on an empty file:
// it records no pid and no heartbeat. 2026-10-26 a memory-throttled report
// child sat at zero CPU holding it for hours while every later pass logged
// "another scheduler pass is active". The only progress signal the kernel
// gives is CPU time, so a holder tree whose utime+stime has not advanced (and
// whose process set has not changed) for STALL_MS is frozen. A waiter that
// finds the lock busy calls this: it writes a durable receipt, SIGTERMs the
// holder's whole process tree (holder plus descendants; progress is summed
// over that tree too), SIGKILLs after a grace, and exits 10 only once /proc
// proves every pid gone (survivors: receipt, exit 11, no takeover). Maintenance
// owners of the same lock files (recluster, pause recovery, backfill, deploy)
// are never killed. The shell retakes the lock on 10. A holder that is merely slow keeps advancing ticks and is
// never touched. No holder at all is the existing stale-lock case (flock is
// simply free) and is left to the runner.
const STALL_MS = 20 * 60 * 1000;
const GRACE_MS = 5000;
const STATE_SCHEMA = 'otter_lock_watchdog_state.v1';
const RECEIPT_SCHEMA = 'otter_lock_watchdog_receipt.v1';
const EXIT_TOOK_OVER = 10;
const EXIT_SURVIVORS = 11;
const EXIT_QUARANTINED = 12;
const MAINTENANCE_OWNERS = [
  'ec2-otter-recluster-rebuild-run.sh',
  'ec2-otter-healer-pause-recovery-run.sh',
  'ec2-otter-audio-backfill.sh',
  'deploy-ec2-server.sh',
];

function numericDirs(procRoot) {
  return fs.readdirSync(procRoot).filter((name) => /^[0-9]+$/.test(name));
}

function readTicks(procRoot, pid) {
  const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
  // comm may contain spaces/parens; fields resume after the last ')'.
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(rest[11]) + Number(rest[12]); // utime + stime
}

// Pids whose open file description on the lock file actually holds the flock.
// A waiter that opened the file and lost flock -n has the fd but no lock line
// in fdinfo, so it is never mistaken for the holder.
function findHolders(lockFile, procRoot) {
  const lockStat = fs.statSync(lockFile);
  const holders = [];
  for (const pid of numericDirs(procRoot)) {
    if (Number(pid) === process.pid) continue;
    let held = false;
    try {
      const fdDir = path.join(procRoot, pid, 'fd');
      for (const fd of fs.readdirSync(fdDir)) {
        let st;
        try {
          st = fs.statSync(path.join(fdDir, fd));
        } catch {
          continue;
        }
        if (st.ino !== lockStat.ino || st.dev !== lockStat.dev) continue;
        const info = fs.readFileSync(path.join(procRoot, pid, 'fdinfo', fd), 'utf8');
        if (/^lock:.*\bFLOCK\b/m.test(info)) {
          held = true;
          break;
        }
      }
    } catch {
      continue; // process exited or fd table unreadable
    }
    if (held) holders.push(Number(pid));
  }
  return holders.sort((a, b) => a - b);
}

function readState(stateFile) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return state && state.schema === STATE_SCHEMA ? state : null;
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}
`, 'utf8');
  fs.renameSync(temp, file);
}

// Real workers close the lock descriptor, so the fd holder alone under-measures
// the work. The verified scope is the holders plus every descendant by ppid.
function processTable(procRoot) {
  const table = new Map();
  for (const name of numericDirs(procRoot)) {
    try {
      const stat = fs.readFileSync(path.join(procRoot, name, 'stat'), 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      table.set(Number(name), { ppid: Number(rest[1]), zombie: rest[0] === 'Z', start: rest[19] || '' });
    } catch {}
  }
  return table;
}

function treeOf(roots, table) {
  const tree = new Set(roots);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, info] of table) {
      if (!tree.has(pid) && tree.has(info.ppid)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  return [...tree].sort((a, b) => a - b);
}

function cmdline(procRoot, pid) {
  try {
    return fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8').split(String.fromCharCode(0)).join(' ').trim();
  } catch {
    return '';
  }
}

// Non-call-healer owners of these same lock files (grep of the repo): they
// legitimately hold the lock for long, quiet stretches and are never killed.
function maintenanceOwner(procRoot, holders, table) {
  const seen = new Set();
  for (let pid of holders) {
    while (pid > 1 && !seen.has(pid)) {
      seen.add(pid);
      const match = MAINTENANCE_OWNERS.find((name) => cmdline(procRoot, pid).includes(name));
      if (match) return { pid, owner: match };
      const info = table.get(pid);
      if (!info) break;
      pid = info.ppid;
    }
  }
  return null;
}

function checkLock({
  lockFile,
  stateFile,
  receiptFile,
  procRoot = '/proc',
  now = Date.now(),
  stallMs = STALL_MS,
  graceMs = GRACE_MS,
  quarantineFile = quarantineFileFor(lockFile),
  kill = (pid, signal) => process.kill(pid, signal),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  return (async () => {
    const holders = findHolders(lockFile, procRoot);
    if (!holders.length) {
      fs.rmSync(stateFile, { force: true });
      return { action: 'no_holder' };
    }
    const table = processTable(procRoot);
    const tree = treeOf(holders, table);
    const ticks = tree.reduce((sum, pid) => {
      try {
        return sum + readTicks(procRoot, pid);
      } catch {
        return sum;
      }
    }, 0);
    const prev = readState(stateFile);
    const sameSet = prev && JSON.stringify(prev.pids) === JSON.stringify(tree);
    const progressed = !sameSet || ticks > prev.ticks;
    const state = {
      schema: STATE_SCHEMA,
      pids: tree,
      ticks,
      held_since: sameSet ? prev.held_since : new Date(now).toISOString(),
      last_progress_at: progressed ? new Date(now).toISOString() : prev.last_progress_at,
      maintenance_receipted: Boolean(sameSet && prev.maintenance_receipted),
    };
    const receipt = (outcome, extra = {}) => {
      const row = {
        schema: RECEIPT_SCHEMA,
        at: new Date(now).toISOString(),
        outcome,
        lock_file: lockFile,
        pid: holders[0],
        holder_pids: holders,
        tree_pids: tree,
        held_since: state.held_since,
        last_progress_at: state.last_progress_at,
        stalled_minutes: Math.round((now - Date.parse(state.last_progress_at)) / 60000),
        ...extra,
      };
      fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
      fs.appendFileSync(receiptFile, `${JSON.stringify(row)}
`, 'utf8');
      return row;
    };

    const owner = maintenanceOwner(procRoot, holders, table);
    if (owner) {
      if (!state.maintenance_receipted) {
        receipt('maintenance_owner_left_alone', { maintenance_owner: owner });
        state.maintenance_receipted = true;
      }
      writeJson(stateFile, state);
      return { action: 'maintenance_owner', owner };
    }
    if (now - Date.parse(state.last_progress_at) < stallMs) {
      writeJson(stateFile, state);
      return { action: 'progressing', state };
    }

    receipt('kill_attempted', { signal_sequence: ['SIGTERM', 'SIGKILL'] });
    for (const pid of tree) {
      try {
        kill(pid, 'SIGTERM');
      } catch {}
    }
    await sleep(graceMs);
    // Workers may have spawned during the grace: kill the rescanned tree too.
    const again = treeOf(tree, processTable(procRoot));
    for (const pid of again) {
      try {
        kill(pid, 'SIGKILL');
      } catch {}
    }
    await sleep(Math.min(graceMs, 1000));
    // Takeover only on proof: every pid is gone from /proc (or a reaped-pending zombie).
    const after = processTable(procRoot);
    const survivors = again.filter((pid) => after.has(pid) && !after.get(pid).zombie);
    if (survivors.length) {
      writeJson(stateFile, state);
      // Codex F1 closure: once the fd holder dies the lock is free, so the
      // next scheduler would start beside a surviving worker. Quarantine the
      // survivors (pid + start time, so a reused pid does not match) until
      // /proc shows them gone; every scheduler entry checks this first.
      writeJson(quarantineFile, {
        at: new Date(now).toISOString(),
        survivors: survivors.map((pid) => ({ pid, start: after.get(pid).start })),
      });
      return { action: 'survivors', receipt: receipt('survivors_block_takeover', { survivors }) };
    }
    fs.rmSync(stateFile, { force: true });
    return { action: 'killed', receipt: receipt('killed_verified', { killed_pids: again }) };
  })();
}

function quarantineFileFor(lockFile) {
  return `${lockFile}.quarantine.json`;
}

// Returns { blocked, alive } for a scheduler that already holds the lock.
// No file means no quarantine; once every survivor is gone the file clears.
function checkQuarantine({ lockFile, quarantineFile = quarantineFileFor(lockFile), procRoot = '/proc' } = {}) {
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(quarantineFile, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return { blocked: false, alive: [] };
    return { blocked: true, alive: [], reason: `unreadable quarantine: ${error.message}` };
  }
  const table = processTable(procRoot);
  const alive = (Array.isArray(entry && entry.survivors) ? entry.survivors : [])
    .filter(({ pid, start }) => table.has(pid) && !table.get(pid).zombie && table.get(pid).start === start)
    .map(({ pid }) => pid);
  if (alive.length) return { blocked: true, alive };
  fs.rmSync(quarantineFile, { force: true });
  return { blocked: false, alive: [], cleared: true };
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

if (require.main === module) {
  const lockFile = arg('--lock');
  if (!lockFile) {
    console.error('usage: otter-lock-watchdog.js --lock <file> [--state <file>] [--receipts <file>]');
    process.exit(64);
  }
  if (process.argv.includes('--quarantine-check')) {
    const result = checkQuarantine({ lockFile });
    if (result.blocked) {
      console.log(`[otter-lock-watchdog] quarantined: ${result.reason || `survivors alive: ${result.alive.join(',')}`}`);
      process.exit(EXIT_QUARANTINED);
    }
    process.exit(0);
  }
  checkLock({
    lockFile,
    stateFile: arg('--state') || `${lockFile}.watchdog.json`,
    receiptFile: arg('--receipts') || path.join(path.dirname(lockFile), 'otter-lock-watchdog-receipts.jsonl'),
  })
    .then((result) => {
      console.log(`[otter-lock-watchdog] ${result.action}`);
      process.exit(result.action === 'killed' ? EXIT_TOOK_OVER : result.action === 'survivors' ? EXIT_SURVIVORS : 0);
    })
    .catch((error) => {
      console.error(`[otter-lock-watchdog] check failed: ${error.message}`);
      process.exit(0); // never turn a busy lock into a failed pass
    });
}

module.exports = { checkLock, checkQuarantine, quarantineFileFor, findHolders, readTicks, STALL_MS, EXIT_TOOK_OVER, EXIT_SURVIVORS, EXIT_QUARANTINED };
