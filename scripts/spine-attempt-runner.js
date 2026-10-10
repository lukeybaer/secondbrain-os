#!/usr/bin/env node
'use strict';

/**
 * One supervised attempt of an owner-dispatched spine Task.
 *
 * The spine worker runs this synchronously in place of a bare `codex exec`, so
 * a long attempt stays observable and interruptible:
 *   - it heartbeats the Task (lease and lastProgressAt) so a live attempt is
 *     never mistaken for a stalled one and a dead one is reclaimed on expiry;
 *   - it watches the Task's steer ledger and stops the agent the moment ExampleCo
 *     changes the plan or cancels, so the worker can restart in the same
 *     worktree with the new instruction;
 *   - it enforces the attempt deadline by killing the whole process group.
 *
 * Exit codes: 0 finished, 75 steered (amend), 76 cancelled, 77 lease lost,
 * 124 deadline, 1 agent failure.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readSteers, hasCancel } = require('./lib/task-steer.js');

const EXIT = { OK: 0, FAILED: 1, STEERED: 75, CANCELLED: 76, LEASE_LOST: 77, DEADLINE: 124 };

function tasksDir() {
  const dataDir =
    process.env.SECONDBRAIN_DATA_DIR ||
    (process.platform === 'linux' ? '/opt/secondbrain/data' : path.join(process.cwd(), 'data'));
  return process.env.SECONDBRAIN_SPINE_TASKS_DIR || path.join(dataDir, 'tasks');
}

// Extend the lease and stamp progress. Returns false once the lease is gone.
function heartbeat(spec, nowMs = Date.now()) {
  const file = path.join(tasksDir(), `${spec.taskId}.json`);
  let task;
  try {
    task = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return true; // a transient read miss is not proof the lease moved
  }
  if (!task.lease || task.lease.token !== spec.leaseToken || task.status !== 'running') return false;
  const ts = new Date(nowMs).toISOString();
  task.lease = { ...task.lease, expiresAt: new Date(nowMs + spec.leaseTtlMs).toISOString() };
  task.lastProgressAt = ts;
  task.updatedAt = ts;
  const tmp = `${file}.${process.pid}.${nowMs}.hb.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
  fs.renameSync(tmp, file);
  return true;
}

function killGroup(child, signal) {
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    /* already gone */
  }
}

function runAttempt(spec, deps = {}) {
  const spawnFn = deps.spawnFn || spawn;
  const pollMs = deps.pollMs || spec.pollMs || 10_000;
  const heartbeatMs = deps.heartbeatMs || spec.heartbeatMs || 60_000;
  const beat = deps.heartbeat || heartbeat;
  const steers = deps.readSteers || readSteers;
  return new Promise((resolve) => {
    const errFd = spec.errFile ? fs.openSync(spec.errFile, 'a', 0o600) : 'ignore';
    const child = spawnFn(spec.command || 'codex', spec.codexArgs || [], {
      cwd: spec.cwd,
      env: process.env,
      detached: process.platform !== 'win32',
      // Only the default `codex` launcher is a Windows .cmd shim that needs a shell.
      shell: process.platform === 'win32' && !spec.command,
      stdio: ['pipe', 'ignore', errFd],
    });
    let outcome = null;
    let lastBeat = Date.now();
    const started = Date.now();
    const stop = (code) => {
      if (outcome != null) return;
      outcome = code;
      killGroup(child, 'SIGTERM');
      setTimeout(() => killGroup(child, 'SIGKILL'), deps.killGraceMs || 5000).unref?.();
    };
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - started >= spec.timeoutMs) return stop(EXIT.DEADLINE);
      const rows = steers(spec.taskId);
      if (rows.length > (spec.steerSeen || 0)) {
        return stop(hasCancel(rows.slice(spec.steerSeen || 0)) ? EXIT.CANCELLED : EXIT.STEERED);
      }
      if (now - lastBeat >= heartbeatMs) {
        lastBeat = now;
        if (!beat(spec, now)) return stop(EXIT.LEASE_LOST);
      }
    }, pollMs);
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (typeof errFd === 'number') fs.closeSync(errFd);
      resolve(outcome != null ? outcome : code === 0 ? EXIT.OK : EXIT.FAILED);
    };
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code));
    try {
      child.stdin.end(fs.readFileSync(spec.promptFile, 'utf8'));
    } catch {
      stop(EXIT.FAILED);
    }
  });
}

if (require.main === module) {
  const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  runAttempt(spec).then((code) => process.exit(code));
}

module.exports = { EXIT, heartbeat, runAttempt };
