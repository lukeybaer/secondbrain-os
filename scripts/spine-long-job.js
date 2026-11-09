#!/usr/bin/env node
'use strict';

/**
 * Start, inspect or wrap a long job for a supervised spine Task.
 *
 *   node scripts/spine-long-job.js start --name render-v1 --cwd <dir> [--deadline-min 240] -- node src/render.cjs v1
 *   node scripts/spine-long-job.js status
 *   node scripts/spine-long-job.js run <job.json>      (internal: the detached wrapper)
 *
 * The Task id and data dir come from AMY_SPINE_TASK_ID and SECONDBRAIN_DATA_DIR,
 * which the spine worker sets for every supervised attempt.
 */

const longJob = require('./lib/spine-long-job.js');

function dataDir() {
  return process.env.SECONDBRAIN_DATA_DIR || (process.platform === 'linux' ? '/opt/secondbrain/data' : `${process.cwd()}/data`);
}

function parseStart(argv) {
  const split = argv.indexOf('--');
  if (split < 0 || split === argv.length - 1) throw new Error('usage: start --name <n> [--cwd <dir>] [--deadline-min <m>] -- <command> [args...]');
  const opts = {};
  const flags = argv.slice(0, split);
  for (let i = 0; i < flags.length; i += 2) opts[flags[i].replace(/^--/, '')] = flags[i + 1];
  const [command, ...args] = argv.slice(split + 1);
  return {
    name: opts.name || 'job',
    cwd: opts.cwd || process.cwd(),
    deadlineMs: opts['deadline-min'] ? Number(opts['deadline-min']) * 60_000 : undefined,
    command,
    args,
  };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const taskId = process.env.AMY_SPINE_TASK_ID;
  if (cmd === 'run') {
    const receipt = await longJob.runJob(rest[0]);
    process.exitCode = receipt.exitCode === 0 ? 0 : 1;
    return;
  }
  if (cmd === 'start') {
    const job = longJob.startJob({ dataDir: dataDir(), taskId, ...parseStart(rest) });
    console.log(JSON.stringify({ started: job.id, pid: job.wrapperPid, log: job.logFile, deadlineAt: job.deadlineAt }));
    return;
  }
  if (cmd === 'status') {
    const jobs = longJob.listJobs(dataDir(), taskId).map((job) => ({ id: job.id, name: job.name, ...longJob.jobState(job), log: job.logFile }));
    console.log(JSON.stringify(jobs, null, 2));
    return;
  }
  throw new Error('commands: start | status | run');
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(2);
  });
}

module.exports = { main, parseStart };
