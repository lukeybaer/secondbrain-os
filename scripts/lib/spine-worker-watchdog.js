'use strict';
const { watchedLimitMs } = require('./watched-work-limit');
// Liveness watchdog for the EC2 spine worker. The 2026-11-03 freeze left PM2
// "online" for 80+ minutes with an idle event loop because one awaited promise
// never settled. The loop marks progress at each step; if neither the loop nor
// any running Task's lease has shown activity for stallMs, the process exits
// nonzero so PM2 restarts it. Long tasks that renew their lease never trip it.

const DEFAULT_STALL_MS = watchedLimitMs(20 * 60 * 1000);
const DEFAULT_CHECK_MS = 60 * 1000;

function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function createWatchdog({
  now = Date.now,
  exit = (code) => process.exit(code),
  log = (line) => console.error(line),
  leaseActivityMs = () => 0,
  stallMs = DEFAULT_STALL_MS,
  checkMs = DEFAULT_CHECK_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let lastProgressMs = now();
  let timer = null;
  function progress() {
    lastProgressMs = now();
  }
  function check() {
    const t = now();
    let leaseMs = 0;
    try {
      leaseMs = Number(leaseActivityMs()) || 0;
    } catch {
      leaseMs = 0;
    }
    const lastActivity = Math.max(lastProgressMs, leaseMs);
    if (t - lastActivity < stallMs) return false;
    log(
      `[ec2-spine-worker] WATCHDOG: no loop progress or lease renewal for ${Math.round((t - lastActivity) / 60000)} min (limit ${Math.round(stallMs / 60000)}); exiting 70 so PM2 restarts the worker`,
    );
    exit(70);
    return true;
  }
  function start() {
    if (timer) return;
    timer = setIntervalFn(check, checkMs);
    timer?.unref?.();
  }
  function stop() {
    if (timer) clearIntervalFn(timer);
    timer = null;
  }
  return { progress, check, start, stop };
}

// Newest renewal among Tasks that currently hold a running lease (renewLease
// stamps updatedAt, including renewals made by detached runners). With a lane
// named, only that lane's leases count (fast leases carry lane: 'fast'), so a
// busy main lane never keeps a hung fast lane alive, and the reverse.
function newestRunningLeaseMs(tasks, { lane = '' } = {}) {
  let newest = 0;
  for (const task of tasks) {
    if (!task || task.status !== 'running' || !task.lease) continue;
    if (lane && (task.lease.lane === 'fast') !== (lane === 'fast')) continue;
    const ms = Date.parse(task.updatedAt || '');
    if (Number.isFinite(ms) && ms > newest) newest = ms;
  }
  return newest;
}

module.exports = { createWatchdog, withTimeout, newestRunningLeaseMs, DEFAULT_STALL_MS };
