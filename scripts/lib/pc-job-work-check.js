'use strict';

// Names any PC scheduled job that reports success but did no work (E-3, the owner
// 2026-10-27). Task Scheduler showed Session Sweep "result 0" every two
// minutes for 11 days while it exited before doing anything, so an exit code
// is not proof. Each job here writes a stamp file on every real run; a job
// whose stamp is stale, whose stamp records a failed delivery, or whose last
// result is a failure code is named on the System Health Dev Ops row. Only
// add a job whose stamp is written by every run that did its work.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MINUTE = 60 * 1000;
const PC_JOBS = Object.freeze([
  // The sweep writes its heartbeat even when the cloud upload fails; the stamp says which.
  { task: 'SecondBrain Session Sweep', label: 'Session Sweep', intervalMs: 2 * MINUTE, stamp: 'agent/session-cloud-producer-local.json',
    stampFailure: (stamp) => (stamp.s3_heartbeat_ok === false ? `S3 upload failed: ${stamp.s3_heartbeat_reason || 'unknown'}`
      : stamp.cloud_heartbeat_ok === false ? `cloud heartbeat failed: ${stamp.cloud_heartbeat_reason || 'unknown'}` : '') },
  { task: 'SecondBrain-CodexThreadIndexSync', label: 'Codex thread sync', intervalMs: 2 * MINUTE, stamp: 'agent/codex-thread-index.jsonl' },
]);
// The shipped receipt is refreshed every two hours; an older one proves nothing.
const RECEIPT_FRESH_MS = 4 * 60 * MINUTE;

// Task Scheduler results that are not failures: success, running, not yet
// run, and a trigger skipped because the previous run was still going.
const BENIGN_RESULTS = new Set([0, 0x41301, 0x41303, 0x800710e0]);

const staleAfterMs = (job) => Math.max(3 * job.intervalMs, 15 * MINUTE);

function queryScheduledTasks(names) {
  const list = names.map((name) => `'${name.replace(/'/g, "''")}'`).join(',');
  const script = `@(${list}) | ForEach-Object { $t = Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue; if ($t) { $i = $t | Get-ScheduledTaskInfo; [pscustomobject]@{ task = $_; state = [string]$t.State; last_run_at = if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToUniversalTime().ToString('o') } else { '' }; last_result = [int64]$i.LastTaskResult } } } | ConvertTo-Json -Compress`;
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (run.error || run.status !== 0) throw new Error(`scheduled task query failed: ${String((run.error && run.error.message) || run.stderr).slice(0, 200)}`);
  const parsed = JSON.parse(String(run.stdout || '').trim() || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

function stampMs(dataDir, rel) {
  try { return fs.statSync(path.join(dataDir, rel)).mtimeMs; } catch { return 0; }
}

function stampFailure(dataDir, job) {
  if (!job.stampFailure) return '';
  try { return job.stampFailure(JSON.parse(fs.readFileSync(path.join(dataDir, job.stamp), 'utf8').replace(/^﻿/, ''))); }
  catch { return 'stamp file unreadable'; }
}

function checkPcJobWork({ dataDir, nowMs = Date.now(), jobs = PC_JOBS, queryTasks = queryScheduledTasks } = {}) {
  const tasks = new Map(queryTasks(jobs.map((job) => job.task)).map((row) => [row.task, row]));
  const results = jobs.map((job) => {
    const info = tasks.get(job.task);
    const workMs = stampMs(dataDir, job.stamp);
    const lastRunMs = Date.parse((info && info.last_run_at) || '') || 0;
    const row = {
      label: job.label,
      task: job.task,
      last_run_at: lastRunMs ? new Date(lastRunMs).toISOString() : '',
      last_result: info ? info.last_result : null,
      last_work_at: workMs ? new Date(workMs).toISOString() : '',
    };
    const limit = staleAfterMs(job);
    if (!info || /disabled/i.test(info.state)) return { ...row, state: 'missing' };
    if (nowMs - lastRunMs > limit) return { ...row, state: 'not-running' };
    if (nowMs - workMs > limit) return { ...row, state: 'no-work' };
    if (info.last_result != null && !BENIGN_RESULTS.has(Number(info.last_result))) return { ...row, state: 'failing', reason: `last result ${info.last_result}` };
    const failure = stampFailure(dataDir, job);
    if (failure) return { ...row, state: 'failing', reason: failure };
    return { ...row, state: 'ok' };
  });
  return { checked_at: new Date(nowMs).toISOString(), jobs: results };
}

function ago(iso, nowMs) {
  const ms = nowMs - (Date.parse(iso || '') || 0);
  if (!iso || ms < 0) return 'never';
  if (ms < 2 * 60 * MINUTE) return `${Math.round(ms / MINUTE)} min ago`;
  if (ms < 48 * 60 * MINUTE) return `${Math.round(ms / (60 * MINUTE))} h ago`;
  return `${Math.round(ms / (24 * 60 * MINUTE))} days ago`;
}

// One sentence naming each failing job, or '' when all did their work or the
// shipped check is missing or too old to judge.
function pcJobWorkFinding(pcJobs, nowMs = Date.now()) {
  // A check that could not run is unproven, not green.
  if (pcJobs && pcJobs.status === 'error') return `PC job check failed: ${pcJobs.reason || 'unknown error'}`;
  if (!pcJobs || !Array.isArray(pcJobs.jobs)) return '';
  if (nowMs - (Date.parse(pcJobs.checked_at || '') || 0) > RECEIPT_FRESH_MS) return '';
  const named = pcJobs.jobs.filter((job) => job.state && job.state !== 'ok').map((job) => {
    if (job.state === 'missing') return `${job.label} (scheduled task missing or disabled)`;
    if (job.state === 'failing') return `${job.label} (ran ${ago(job.last_run_at, nowMs)} but failed: ${job.reason})`;
    if (job.state === 'not-running') return `${job.label} (has not run since ${ago(job.last_run_at, nowMs)})`;
    return `${job.label} (ran ${ago(job.last_run_at, nowMs)} with result ${job.last_result}, but last did work ${ago(job.last_work_at, nowMs)})`;
  });
  return named.length ? `PC jobs not doing their work: ${named.join('; ')}` : '';
}

module.exports = { PC_JOBS, RECEIPT_FRESH_MS, checkPcJobWork, pcJobWorkFinding, queryScheduledTasks };
