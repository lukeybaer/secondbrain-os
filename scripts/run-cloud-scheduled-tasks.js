#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_CLOUD_SCHEDULED_SKILLS,
  ctDateFromMs,
  runDueScheduledTasks,
} = require('./lib/cloud-scheduled-fleet.js');

const DEFAULT_DATA_DIR =
  process.env.SECONDBRAIN_DATA_DIR ||
  (process.platform === 'linux'
    ? '/opt/secondbrain/data'
    : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'secondbrain', 'data'));

function parseArgs(argv) {
  const opts = {
    dataDir: DEFAULT_DATA_DIR,
    date: ctDateFromMs(Date.now()),
    trigger: 'cloud-cron',
    maxTasks: Infinity,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date') opts.date = argv[++i];
    else if (arg === '--data-dir') opts.dataDir = argv[++i];
    else if (arg === '--trigger') opts.trigger = argv[++i];
    else if (arg === '--max-tasks') opts.maxTasks = Number(argv[++i]);
    else if (arg === '--task') {
      const skill = argv[++i];
      opts.tasks = DEFAULT_CLOUD_SCHEDULED_SKILLS.filter((task) => task.skill === skill);
    }
  }
  return opts;
}

async function withLock(lockPath, fn) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const staleMs = Number(process.env.AMY_CLOUD_SCHEDULE_LOCK_STALE_MS || 4 * 60 * 60 * 1000);
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs < staleMs) {
      return { ok: false, skipped: 'already-running', lockPath };
    }
    fs.unlinkSync(lockPath);
  } catch {
    // No lock, or stale lock already gone.
  }
  fs.writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`, { flag: 'wx' });
  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Another process may already have cleaned a stale lock.
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const lockPath = path.join(opts.dataDir, 'agent', 'cloud-scheduled-fleet.lock');
  const result = await withLock(lockPath, () => runDueScheduledTasks(opts));
  if (result.skipped === 'already-running') {
    console.log('[cloud-schedule] already running; skipped this tick');
    return;
  }
  const replayed = (result.replayed || []).map((row) => row.skill).join(', ') || 'none';
  console.log(
    `[cloud-schedule] ${result.status} date=${result.date} expected=${(result.expected || []).length} replayed=${replayed}`,
  );
  if (!result.ok) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[cloud-schedule] failed:', err.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, withLock };
