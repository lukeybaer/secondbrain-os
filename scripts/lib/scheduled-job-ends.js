'use strict';

// How a scheduled job really ended, and the repair requests that same-failure
// twice files (owner decision S-4).
//
// Two writers feed one request file, data/agent/night-repair-requests.jsonl:
//   source "cron"  scripts/cron-job-shell.sh, one row per raw crontab run in
//                  data/agent/scheduled-job-ends/YYYY-MM-DD.jsonl
//   source "fleet" scripts/lib/cloud-scheduled-fleet.js, one outcome row per
//                  skill run in data/agent/scheduled-skill-outcomes.jsonl
//
// The System Health scheduled-tasks row reads the open requests, so S-2's
// repair loop (which acts on red rows) is the fixer link. This file owns the
// reading logic as pure functions plus thin file readers.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WORK_UNIT_ID = 'system_health:scheduled-tasks';
const LOCK_BUSY_REASON = 'lock busy';
const ENDED_VALUES = Object.freeze(['done', 'refused', 'timed_out', 'failed']);
const REFUSAL_RE = /\brefus/i;
// Words that name a refusal without one having happened: "0 refusals", "not refused",
// {"refused":false}. They come out first, so a word that is left is a real refusal. The
// shell wrapper applies the same three rules.
const NOT_A_REFUSAL_RES = Object.freeze([
  /"refus\w*"\s*:\s*(?:false|0|null|\[\s*\])/gi,
  /\b(?:no|not|never|without|zero|0)\s+(?:\w+\s+)?refus\w*/gi,
  /\brefus\w*\s*[:=]?\s*(?:0|false|none)\b/gi,
]);

// Same normalisation the shell wrapper applies: each run of digits becomes N so a changing
// pid, count or timestamp does not make the same failure look new.
function reasonFingerprint(reason) {
  return crypto
    .createHash('sha1')
    .update(String(reason || '').replace(/[0-9]+/g, 'N'))
    .digest('hex');
}

function lastLines(text, count = 2) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-count)
    .join(' ');
}

// A run whose own last lines say it refused is never done, whatever its exit
// code. Only the tail counts: a long successful run may mention the word
// earlier without having refused.
function outputSaysRefused(raw) {
  return REFUSAL_RE.test(NOT_A_REFUSAL_RES.reduce((text, re) => text.replace(re, ''), lastLines(raw, 2)));
}

function cleanReason(raw, max = 300) {
  return String(raw || '')
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-max);
}

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function repairRequestsFile(dataDir) {
  return path.join(dataDir, 'agent', 'night-repair-requests.jsonl');
}

function jobEndsDir(dataDir) {
  return path.join(dataDir, 'agent', 'scheduled-job-ends');
}

// One request per jobId + fingerprint + date. Returns true when a row was
// appended. Never throws: filing a request must not break the run that filed it.
function appendRepairRequest(dataDir, request) {
  try {
    const file = repairRequestsFile(dataDir);
    const dup = readJsonl(file).some(
      (row) =>
        row.jobId === request.jobId &&
        row.fingerprint === request.fingerprint &&
        row.date === request.date,
    );
    if (dup) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(request) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

// Another run held the lock. It says nothing about whether the job works, so it
// neither closes nor reopens a request.
function isLockBusyRow(row) {
  return String((row && row.reason) || '').trim().toLowerCase() === LOCK_BUSY_REASON;
}

function tsMs(row) {
  const ms = Date.parse(row && row.ts);
  return Number.isFinite(ms) ? ms : null;
}

// Requests nothing has closed yet, however old: a job that broke on Friday is
// still broken on Monday. Pure.
//   requests   rows of night-repair-requests.jsonl, plus any
//              {kind:'resolved', jobId, ts} row that closes one by hand or for a
//              job that no longer exists
//   cronEnds   rows of scheduled-job-ends/*.jsonl
//   fleetRows  rows of scheduled-skill-outcomes.jsonl
// A cron request closes when that job's latest end row ended done after the
// request. A fleet request (jobId "fleet:<skill>") closes when the skill's
// latest outcome row is a success after the request. Lock busy never opens one.
function openRepairRequests({ requests = [], cronEnds = [], fleetRows = [], nowMs = Date.now() } = {}) {
  const latestCron = new Map();
  for (const row of cronEnds) {
    const ms = tsMs(row);
    if (ms === null || !row.jobId || isLockBusyRow(row)) continue;
    const prev = latestCron.get(row.jobId);
    if (!prev || ms >= prev.ms) latestCron.set(row.jobId, { ms, row });
  }
  const latestFleet = new Map();
  for (const row of fleetRows) {
    const ms = tsMs(row);
    if (ms === null || !row.skill) continue;
    const prev = latestFleet.get(row.skill);
    if (!prev || ms >= prev.ms) latestFleet.set(row.skill, { ms, row });
  }
  const resolvedAt = new Map();
  for (const row of requests) {
    const ms = tsMs(row);
    if (row?.kind !== 'resolved' || ms === null || !row.jobId) continue;
    if (ms >= (resolvedAt.get(row.jobId) ?? -Infinity)) resolvedAt.set(row.jobId, ms);
  }
  const byJob = new Map();
  for (const request of requests) {
    if (request?.kind === 'resolved') continue;
    const ms = tsMs(request);
    if (ms === null || !request.jobId) continue;
    if (ms > nowMs + 60_000) continue;
    if (String(request.reason || '').trim().toLowerCase() === LOCK_BUSY_REASON) continue;
    if (request.workUnitId && request.workUnitId !== WORK_UNIT_ID) continue;
    let closed = false;
    let latest = null;
    let latestFine = false;
    let latestFailed = false;
    if (request.source === 'fleet') {
      latest = latestFleet.get(String(request.jobId).replace(/^fleet:/, ''));
      latestFine = latest?.row.ok === true;
      latestFailed = latest?.row.ok === false;
    } else {
      latest = latestCron.get(request.jobId);
      latestFine = latest?.row.ended === 'done';
      latestFailed = latest?.row.ended === 'failed' || latest?.row.ended === 'timed_out';
    }
    closed = Boolean(latest && latest.ms > ms && latestFine);
    // A resolved row closes it, unless the job has really failed again since. A
    // refusal is not a failure.
    const resolvedMs = resolvedAt.get(request.jobId);
    if (!closed && resolvedMs !== undefined && resolvedMs > ms) {
      closed = !(latest && latest.ms > resolvedMs && latestFailed);
    }
    if (closed) continue;
    const prev = byJob.get(request.jobId);
    if (!prev || ms >= prev.ms) byJob.set(request.jobId, { ms, request });
  }
  return [...byJob.values()].map((entry) => entry.request);
}

// Cron end files are one per UTC day and kept 30 days.
function readRecentCronEnds(dataDir, files = 31) {
  const dir = jobEndsDir(dataDir);
  let names = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
      .slice(-files);
  } catch {
    return [];
  }
  return names.flatMap((name) => readJsonl(path.join(dir, name)));
}

function readOpenRepairRequests(dataDir, nowMs = Date.now()) {
  const requests = readJsonl(repairRequestsFile(dataDir));
  if (!requests.length) return [];
  return openRepairRequests({
    requests,
    cronEnds: readRecentCronEnds(dataDir),
    fleetRows: readJsonl(path.join(dataDir, 'agent', 'scheduled-skill-outcomes.jsonl')),
    nowMs,
  });
}

// When the answer the System Health row gives last changed: the request file, or
// the first good run after a request, which is what closes it. Later good runs
// change nothing, so they do not count.
function repairRequestsChangedMs(dataDir) {
  const file = repairRequestsFile(dataDir);
  let newest = null;
  try {
    newest = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const requests = readJsonl(file).filter((row) => row?.kind !== 'resolved' && row?.jobId && tsMs(row) !== null);
  if (!requests.length) return newest;
  const cronDone = readRecentCronEnds(dataDir).filter((row) => row.ended === 'done');
  const fleetOk = readJsonl(path.join(dataDir, 'agent', 'scheduled-skill-outcomes.jsonl')).filter((row) => row.ok === true);
  for (const request of requests) {
    const ms = tsMs(request);
    const good =
      request.source === 'fleet'
        ? fleetOk.filter((row) => row.skill === String(request.jobId).replace(/^fleet:/, ''))
        : cronDone.filter((row) => row.jobId === request.jobId);
    const after = good.map(tsMs).filter((value) => value !== null && value > ms);
    if (after.length) newest = Math.max(newest, Math.min(...after));
  }
  return newest;
}

function openRequestsDetail(open) {
  if (!open.length) return '';
  const shown = open
    .slice(0, 5)
    .map((r) => `${r.jobId} (${cleanReason(r.reason, 120) || 'no reason recorded'})`);
  const more = open.length > 5 ? `; +${open.length - 5} more` : '';
  const noun = open.length === 1 ? 'job has' : 'jobs have';
  return `${open.length} scheduled ${noun} failed the same way twice and ${open.length === 1 ? 'is' : 'are'} waiting for repair: ${shown.join('; ')}${more}.`;
}

module.exports = {
  ENDED_VALUES,
  LOCK_BUSY_REASON,
  WORK_UNIT_ID,
  appendRepairRequest,
  cleanReason,
  jobEndsDir,
  lastLines,
  openRepairRequests,
  openRequestsDetail,
  outputSaysRefused,
  readOpenRepairRequests,
  readRecentCronEnds,
  repairRequestsChangedMs,
  reasonFingerprint,
  repairRequestsFile,
};
