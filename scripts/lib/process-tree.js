'use strict';

// Stop a child and everything it started, however it started it.
//
// A signal to the child's process group is not enough at night: coreutils timeout
// leads a group of its own, and a healer worker starts a session of its own, so both
// would keep running after the group is gone. This reads /proc and follows parent,
// group and session links. The kernel never hands out a pid that still names a live
// group or session, so once the root has exited its group and session still name this
// tree. A root pid now held by a different process (its start ticks differ) means the
// tree is gone, and nothing is signalled.
//
// With no /proc (a Windows dev machine), it falls back to the group, then the pid.

const fs = require('node:fs');

const DEAD_STATES = new Set(['Z', 'X', 'x']);

// Fields after the command name, which may itself hold spaces and brackets: state is
// field 3, so start time (field 22) sits at index 19.
function parseStat(text) {
  const open = String(text).indexOf('(');
  const close = String(text).lastIndexOf(')');
  if (open < 0 || close < 0) return null;
  const pid = Number(String(text).slice(0, open).trim());
  const rest = String(text).slice(close + 1).trim().split(/\s+/);
  if (!Number.isInteger(pid) || rest.length < 20) return null;
  return {
    pid,
    state: rest[0],
    ppid: Number(rest[1]),
    pgrp: Number(rest[2]),
    session: Number(rest[3]),
    startTicks: String(rest[19]),
  };
}

function readProcessTable({ procDir = '/proc', fsImpl = fs } = {}) {
  let names;
  try {
    names = fsImpl.readdirSync(procDir);
  } catch {
    return null;
  }
  const pids = names.filter((name) => /^\d+$/.test(String(name)));
  if (!pids.length) return null;
  const table = new Map();
  for (const name of pids) {
    try {
      const row = parseStat(fsImpl.readFileSync(`${procDir}/${name}/stat`, 'utf8'));
      if (row) table.set(row.pid, row);
    } catch {
      // It exited while we read.
    }
  }
  return table;
}

function validRoot(rootPid) {
  return Number.isInteger(rootPid) && rootPid > 1;
}

// Every process in the tree, as a Map of pid to its table row. `known` holds pids seen
// on an earlier walk with their start ticks, so one orphaned since then is still found.
function treeMembers({ rootPid, table, known = new Map() }) {
  const members = new Map();
  if (!validRoot(rootPid) || !table) return members;
  const root = table.get(rootPid);
  const rootTicks = known.get(rootPid);
  // A recycled pid means no group or session of that id is left, so it names nothing.
  const recycled = Boolean(root) && rootTicks !== undefined && root.startTicks !== rootTicks;
  const leaders = new Set(recycled ? [] : [rootPid]);
  if (root && !recycled) members.set(rootPid, root);
  for (const [pid, ticks] of known) {
    const row = table.get(pid);
    if (row && row.startTicks === ticks && pid !== process.pid) members.set(pid, row);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const row of members.values()) {
      if ((row.session === row.pid || row.pgrp === row.pid) && !leaders.has(row.pid)) {
        leaders.add(row.pid);
        changed = true;
      }
    }
    for (const row of table.values()) {
      if (members.has(row.pid) || row.pid <= 1 || row.pid === process.pid) continue;
      if (leaders.has(row.session) || leaders.has(row.pgrp) || members.has(row.ppid)) {
        members.set(row.pid, row);
        changed = true;
      }
    }
  }
  return members;
}

function startTicksOf(pid, { procDir = '/proc', fsImpl = fs } = {}) {
  try {
    return parseStat(fsImpl.readFileSync(`${procDir}/${pid}/stat`, 'utf8'))?.startTicks ?? null;
  } catch {
    return null;
  }
}

// Sends the signal to every live member and remembers who they were. The count is how
// many it reached.
function signalTree({
  rootPid,
  signal,
  known = new Map(),
  procDir = '/proc',
  fsImpl = fs,
  killFn = process.kill.bind(process),
} = {}) {
  if (!validRoot(rootPid)) return 0;
  const table = readProcessTable({ procDir, fsImpl });
  if (!table) {
    for (const target of [-rootPid, rootPid]) {
      try {
        killFn(target, signal);
        return 1;
      } catch {
        // Try the next way of naming it.
      }
    }
    return 0;
  }
  let reached = 0;
  for (const [pid, row] of treeMembers({ rootPid, table, known })) {
    known.set(pid, row.startTicks);
    if (DEAD_STATES.has(row.state)) continue;
    try {
      killFn(pid, signal);
      reached += 1;
    } catch {
      // It exited between the walk and the signal.
    }
  }
  return reached;
}

// How many members still run. A zombie has finished, so it does not count.
function liveMembers({
  rootPid,
  known = new Map(),
  procDir = '/proc',
  fsImpl = fs,
  killFn = process.kill.bind(process),
} = {}) {
  if (!validRoot(rootPid)) return 0;
  const table = readProcessTable({ procDir, fsImpl });
  if (!table) {
    for (const target of [-rootPid, rootPid]) {
      try {
        killFn(target, 0);
        return 1;
      } catch (error) {
        if (error?.code === 'EPERM') return 1;
      }
    }
    return 0;
  }
  let live = 0;
  for (const row of treeMembers({ rootPid, table, known }).values()) {
    if (!DEAD_STATES.has(row.state)) live += 1;
  }
  return live;
}

function treeAlive({ pid, startTicks = null, ...io } = {}) {
  const known = startTicks ? new Map([[pid, String(startTicks)]]) : new Map();
  return liveMembers({ rootPid: pid, known, ...io }) > 0;
}

function realSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// TERM first, because a process such as coreutils timeout forwards it to what it
// runs. KILL whatever is left after the grace, then allow a short time to die. Always
// returns: a process stuck in the kernel cannot hold up the caller.
async function stopTree({
  rootPid,
  known = new Map(),
  killGraceMs,
  closeGraceMs,
  pollMs = 1000,
  now = Date.now,
  sleep = realSleep,
  ...io
} = {}) {
  signalTree({ rootPid, signal: 'SIGTERM', known, ...io });
  const killAt = now() + killGraceMs;
  while (now() < killAt) {
    if (liveMembers({ rootPid, known, ...io }) === 0) return { stopped: true, killed: false };
    await sleep(pollMs);
  }
  signalTree({ rootPid, signal: 'SIGKILL', known, ...io });
  const giveUpAt = now() + closeGraceMs;
  while (now() < giveUpAt) {
    if (liveMembers({ rootPid, known, ...io }) === 0) return { stopped: true, killed: true };
    await sleep(pollMs);
  }
  return { stopped: liveMembers({ rootPid, known, ...io }) === 0, killed: true };
}

module.exports = {
  liveMembers,
  parseStat,
  readProcessTable,
  signalTree,
  startTicksOf,
  stopTree,
  treeAlive,
  treeMembers,
};
