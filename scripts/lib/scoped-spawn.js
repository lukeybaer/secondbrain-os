'use strict';

// scripts/lib/scoped-spawn.js
//
// Resource-scoped process launch for long-running child commands. On the EC2
// runtime a child starts inside its own systemd user scope with memory, CPU,
// task and runtime limits; elsewhere it starts as its own process group.
// Moved unchanged from the deleted heal-executor.js (S-1b follow-up,
// 2026-11-16). Its callers are scripts/amy-night-run.js and
// scripts/heal-resource-scope-canary.js.

const { spawnSync } = require('child_process');
const fs = require('fs');
const { watchedLimitMs } = require('./watched-work-limit');

// Default wall budget for one scoped child: 30 minutes.
const DEFAULT_BUDGET_MS = watchedLimitMs(30 * 60 * 1000);
const POSIX_WORKER_MEMORY_HIGH = '900M';
const POSIX_WORKER_MEMORY_MAX = '1200M';
const POSIX_WORKER_CPU_QUOTA = '100%';
// #b Oct 20 2026 (Fix 1): TasksMax counts threads, and one Claude or Codex
// session plus its Node hooks (about ten threads each) passed 96, so Codex
// got EAGAIN on every launch and 9 hook processes aborted at 23:36 CT.
const POSIX_WORKER_TASKS_MAX = '512';


// On the EC2 runtime, systemd owns a user cgroup for the complete worker tree.
// The limits are aggregate across Codex/Claude plus every tool and test it
// spawns, so overlapping or wedged tests degrade the worker instead of the
// briefing host. RuntimeMaxSec is a second, kernel-managed wall behind the
// executor watchdog. Other POSIX hosts retain the process-group boundary even
// when systemd-run is unavailable.
function resourceScopedSpawn(command, args, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform === 'win32') return { command, args, detached: false, resourceScoped: false };
  const existsSync = opts.existsSync || fs.existsSync;
  const systemdRunPath = opts.systemdRunPath || '/usr/bin/systemd-run';
  const budgetMs = Math.max(1, Number(opts.budgetMs) || DEFAULT_BUDGET_MS);
  const runtimeSec = Math.max(60, Math.ceil((budgetMs + 15_000) / 1000));
  const productionRuntime =
    opts.enableSystemdScope == null
      ? existsSync('/opt/secondbrain')
      : opts.enableSystemdScope === true;
  if (!productionRuntime || !existsSync(systemdRunPath)) {
    return { command, args, detached: true, resourceScoped: false };
  }
  const scopeUnit = String(
    opts.scopeUnit ||
      `secondbrain-heal-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}.scope`,
  ).replace(/[^A-Za-z0-9_.@:-]/g, '-');
  return {
    command: systemdRunPath,
    args: [
      '--user',
      '--scope',
      '--quiet',
      `--unit=${scopeUnit}`,
      `--property=MemoryHigh=${POSIX_WORKER_MEMORY_HIGH}`,
      `--property=MemoryMax=${POSIX_WORKER_MEMORY_MAX}`,
      `--property=CPUQuota=${POSIX_WORKER_CPU_QUOTA}`,
      `--property=TasksMax=${POSIX_WORKER_TASKS_MAX}`,
      `--property=RuntimeMaxSec=${runtimeSec}s`,
      '--property=TimeoutStopSec=15s',
      '--property=KillMode=control-group',
      '--',
      command,
      ...args,
    ],
    detached: true,
    resourceScoped: true,
    scopeUnit,
  };
}

// System services do not inherit a login session's bus environment. Derive the
// local user's bus for both launch and cleanup; never drop the cgroup limits
// just because the service started without XDG_RUNTIME_DIR.
function userScopeEnv(env, opts = {}) {
  const result = { ...env };
  if ((opts.platform || process.platform) !== 'linux') return result;
  const existsSync = opts.existsSync || fs.existsSync;
  const enabled =
    opts.enableSystemdScope == null
      ? existsSync('/opt/secondbrain')
      : opts.enableSystemdScope === true;
  if (!enabled) return result;
  const uid = (opts.getuid || process.getuid)();
  const runtimeDir = `/run/user/${uid}`;
  if (!existsSync(`${runtimeDir}/bus`)) {
    throw new Error(
      `user systemd bus is unavailable at ${runtimeDir}/bus; retain resource limits and restore the user manager`,
    );
  }
  result.XDG_RUNTIME_DIR = runtimeDir;
  result.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtimeDir}/bus`;
  return result;
}

function stopResourceScope(child, opts = {}) {
  const scopeUnit = String(child && child.secondbrainScopeUnit ? child.secondbrainScopeUnit : '');
  if (!scopeUnit) return { attempted: false, scopeUnit: '' };
  const run = opts.spawnSync || spawnSync;
  let result;
  try {
    result = run('systemctl', ['--user', 'stop', scopeUnit], {
      encoding: 'utf8',
      timeout: watchedLimitMs(5000),
      windowsHide: true,
      env: userScopeEnv(opts.env || process.env, opts),
    });
  } catch (error) {
    // Losing the bus while a worker exits must still resolve its durable
    // result. The kernel scope timeout and process-group watchdog remain.
    return { attempted: true, scopeUnit, exitCode: null, error: String(error.message || error) };
  }
  return {
    attempted: true,
    scopeUnit,
    exitCode: Number.isInteger(result && result.status) ? result.status : null,
  };
}

module.exports = {
  resourceScopedSpawn,
  userScopeEnv,
  stopResourceScope,
};
