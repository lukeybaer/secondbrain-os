'use strict';

// S-2 (owner decision): "you let the work finish and you watch it responsibly."
//
// A runner that starts long work records a small file here: what the job was asked
// to do, which process to stop, where its progress is, when it started, how it gets
// restarted and how many restarts it has had tonight. The job progress reader
// (scripts/lib/job-progress-reader.js) reads these files every five minutes. The
// runner removes the file when the job ends.
//
// The reader cannot restart a job itself, because the runner holds its leases and
// receipts. It leaves a verdict next to the job's file and stops the process. The
// runner sees the command end, takes the verdict, and restarts or hands the job to
// its failure path.
//
// Nothing in this file may stop a job: every write fails soft and the job runs on.

const fs = require('node:fs');
const path = require('node:path');
const { WATCHED_JOB_ENV } = require('./watched-work-limit.js');

const WATCHED_JOB_PROGRESS_ENV = 'AMY_WATCHED_JOB_PROGRESS';
// The reader only ever reads a tail, so a chatty job is cut back to its newest half.
const MAX_PROGRESS_BYTES = 2 * 1024 * 1024;
const MAX_ASKED_CHARS = 2000;
const NIGHT_ROLLOVER_MS = 60 * 60 * 1000;
const RESTART_NIGHTS_KEPT = 3;
// Before a restart the runner waits this long for the old process group to empty, then
// force-kills what is left and waits once more.
const RESTART_GROUP_GRACE_MS = 5 * 1000;
const RESTART_GROUP_POLL_GRACE_MS = 250;
// Idempotency ledger kept inside each night's restart counts. A job id never contains a
// dollar sign, so it cannot collide with one.
const TXN_LEDGER_KEY = '$txns';

let registrationSeq = 0;

function watchedJobsDir(dataDir) {
  return path.join(dataDir, 'agent', 'watched-jobs');
}

function restartCountsPath(dataDir) {
  return path.join(dataDir, 'agent', 'watched-job-restarts.json');
}

// Start identity of a process: /proc/<pid>/stat field 22, the start time in ticks since
// boot. A reused pid has a different one. Empty where it cannot be read (no /proc).
function processStartIdentity(pid, { procRoot = '/proc' } = {}) {
  try {
    const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    return String(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || '');
  } catch {
    return '';
  }
}

// The reader every default goes through. Tests on a host with no /proc (Windows) swap in
// a stand-in so the real processes they spawn can still be verified.
let startIdentityReader = processStartIdentity;
function currentProcessStart(pid) {
  return startIdentityReader(pid);
}
function setProcessStartReaderForTests(reader) {
  startIdentityReader = typeof reader === 'function' ? reader : processStartIdentity;
}

// One registration generation of one job: it changes when the runner restarts the job.
function restartTxnId(job) {
  return `${job.jobId}|${job.progressPath}|${job.startedAt}`;
}

function verdictPath(jobFile) {
  return `${jobFile}.verdict`;
}

// The children the reader listed before stopping a job that is not a process group. They
// can outlive their leader, so a restart waits for them. Written before the first signal.
function stoppingPath(jobFile) {
  return `${jobFile}.stopping`;
}

function writeStoppingTree(jobFile, members) {
  writeJsonAtomic(stoppingPath(jobFile), { members });
}

function readStoppingTree(jobFile) {
  try {
    const { members } = JSON.parse(fs.readFileSync(stoppingPath(jobFile), 'utf8'));
    return Array.isArray(members) ? members : [];
  } catch {
    return [];
  }
}

function clearStoppingTree(jobFile) {
  try {
    fs.unlinkSync(stoppingPath(jobFile));
  } catch {
    /* already gone */
  }
}

// A night runs from 11 PM to the next 10:59 PM Central, named for the morning it
// reaches, so one job's restart limit spans the whole 11 PM to 5:30 AM run.
function nightKey(nowMs = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs + NIGHT_ROLLOVER_MS));
}

function safeName(value) {
  return String(value || 'job').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120);
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function appendToProgress(file, text) {
  if (!file || !text) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, text);
    const size = fs.statSync(file).size;
    if (size > MAX_PROGRESS_BYTES) {
      const keep = Math.floor(MAX_PROGRESS_BYTES / 2);
      const buffer = Buffer.alloc(keep);
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, buffer, 0, keep, size - keep);
      } finally {
        fs.closeSync(fd);
      }
      fs.writeFileSync(file, buffer);
    }
  } catch {
    /* progress is advisory: a failed write never touches the job */
  }
}

function progressLine(text, nowMs = Date.now()) {
  return `[${new Date(nowMs).toISOString()}] ${String(text || '').replace(/\s+/g, ' ').trim()}\n`;
}

// For a child process that has only its environment: scripts/lib/ask-ai.js and the
// scheduled skill runner write a line at each model reply and stage this way.
function noteWatchedProgress(text, env = process.env) {
  appendToProgress(env && env[WATCHED_JOB_PROGRESS_ENV], progressLine(text));
}

function readRestartCounts(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(restartCountsPath(dataDir), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw error;
  }
}

// Restarts this job has had tonight. Throws on an unreadable count so the reader can
// refuse to act on a number it does not have.
function restartsTonight(dataDir, jobId, nowMs = Date.now()) {
  const night = readRestartCounts(dataDir)[nightKey(nowMs)] || {};
  return Number(night[jobId]) || 0;
}

function restartTxnCounted(dataDir, txn, nowMs = Date.now()) {
  const night = readRestartCounts(dataDir)[nightKey(nowMs)] || {};
  return Array.isArray(night[TXN_LEDGER_KEY]) && night[TXN_LEDGER_KEY].includes(txn);
}

// With a txn id the count is idempotent: the same transaction counts once, however many
// times a pass that died halfway runs it again.
function recordRestart(dataDir, jobId, nowMs = Date.now(), txn = '') {
  const counts = readRestartCounts(dataDir);
  const night = nightKey(nowMs);
  counts[night] = counts[night] || {};
  if (txn) {
    const ledger = Array.isArray(counts[night][TXN_LEDGER_KEY]) ? counts[night][TXN_LEDGER_KEY] : [];
    if (ledger.includes(txn)) return Number(counts[night][jobId]) || 0;
    counts[night][TXN_LEDGER_KEY] = [...ledger, txn];
  }
  counts[night][jobId] = (Number(counts[night][jobId]) || 0) + 1;
  for (const key of Object.keys(counts).sort().slice(0, -RESTART_NIGHTS_KEPT)) delete counts[key];
  writeJsonAtomic(restartCountsPath(dataDir), counts);
  return counts[night][jobId];
}

// Never throws and always returns a handle. A job whose file cannot be written just
// goes unread, runs on to its limit, and keeps the same environment.
function registerWatchedJob({
  dataDir,
  jobKey,
  kind,
  asked,
  restart,
  now = Date.now,
  processStart = currentProcessStart,
  kill = process.kill.bind(process),
  sleep,
  platform = process.platform,
} = {}) {
  const startedMs = now();
  const jobId = `${safeName(jobKey)}-${nightKey(startedMs)}`;
  registrationSeq += 1;
  const base = path.join(watchedJobsDir(dataDir), `${jobId}.${process.pid}.${registrationSeq}`);
  const file = `${base}.json`;
  const progressPath = `${base}.progress.log`;
  let restarts = 0;
  try {
    restarts = restartsTonight(dataDir, jobId, startedMs);
  } catch {
    restarts = 0;
  }
  const record = {
    schemaVersion: 1,
    jobId,
    kind: String(kind || 'job'),
    asked: String(asked || '').slice(0, MAX_ASKED_CHARS),
    ownerPid: process.pid,
    processes: [],
    progressPath,
    startedAt: new Date(startedMs).toISOString(),
    restart: String(restart || ''),
    restartsTonight: restarts,
  };
  // A budget cut can settle a row before its killed child reports back. Whatever that
  // child's runner does after end() must not write the removed files back.
  let ended = false;
  // Every process this registration started since the last restart check, kept after
  // processEnded so a restart can confirm nothing of the old run is left.
  let launched = [];
  const save = () => {
    if (ended) return;
    try {
      writeJsonAtomic(file, record);
    } catch {
      /* the reader simply cannot see this job */
    }
  };
  save();
  appendToProgress(progressPath, progressLine(`job started: ${record.asked}`, startedMs));
  return {
    jobId,
    file,
    progressPath,
    env: { [WATCHED_JOB_ENV]: jobId, [WATCHED_JOB_PROGRESS_ENV]: progressPath },
    note: (text) => {
      if (!ended) appendToProgress(progressPath, progressLine(text, now()));
    },
    output: (chunk) => {
      if (!ended) appendToProgress(progressPath, String(chunk == null ? '' : chunk));
    },
    // group: the process leads its own process group, so the whole group can be stopped.
    processStarted: (pid, { group = false } = {}) => {
      if (!pid) return;
      const entry = { pid, group: Boolean(group), startId: String(processStart(pid) || '') };
      record.processes.push(entry);
      launched.push({ ...entry });
      save();
    },
    processEnded: (pid) => {
      record.processes = record.processes.filter((entry) => entry.pid !== pid);
      save();
    },
    // A restart is a fresh run. The old output is what the reader already answered, so
    // it is cleared rather than read again as evidence against the new run, and the
    // new run gets its own five minutes before it is read.
    restarted: (reason) => {
      if (ended) return;
      const nowMs = now();
      record.startedAt = new Date(nowMs).toISOString();
      record.restartsTonight += 1;
      save();
      try {
        fs.writeFileSync(progressPath, progressLine(`restarted by the job progress reader: ${reason}`, nowMs));
      } catch {
        /* progress is advisory */
      }
    },
    // Before a restart: the old run's process groups must be gone. Waits a bounded time,
    // force-kills whatever is left, and says no if anything still lives. A runner that
    // gets ok false must not restart.
    confirmProcessesGone: async (options = {}) => {
      const entries = launched;
      launched = [];
      const settled = await settleProcessGroups(entries, {
        kill,
        sleep,
        processStart,
        platform,
        members: readStoppingTree(file),
        ...options,
      });
      if (settled.ok) clearStoppingTree(file);
      return settled;
    },
    // The reader's verdict, once. Null when there is none or it cannot be read.
    takeVerdict: () => {
      const target = verdictPath(file);
      let verdict = null;
      try {
        verdict = JSON.parse(fs.readFileSync(target, 'utf8'));
      } catch {
        verdict = null;
      }
      try {
        fs.unlinkSync(target);
      } catch {
        /* no verdict was waiting */
      }
      return verdict;
    },
    end: () => {
      ended = true;
      for (const target of [file, verdictPath(file), stoppingPath(file), progressPath]) {
        try {
          fs.unlinkSync(target);
        } catch {
          /* already gone */
        }
      }
    },
  };
}

// Every registered job, or the reason a file could not be read.
function listWatchedJobs(dataDir) {
  let names;
  try {
    names = fs.readdirSync(watchedJobsDir(dataDir));
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const file = path.join(watchedJobsDir(dataDir), name);
      try {
        const job = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!job || typeof job !== 'object' || !job.jobId) throw new Error('not a job record');
        return { file, job };
      } catch (error) {
        return { file, error: String((error && error.message) || error) };
      }
    });
}

function writeVerdict(jobFile, verdict) {
  writeJsonAtomic(verdictPath(jobFile), verdict);
}

// The restart transaction. The count is written first (idempotent on the transaction id)
// and only then does the verdict become visible, so a verdict never exists without its
// count, and a pass that dies between the two is finished, not repeated.
function commitVerdict(dataDir, jobFile, job, verdict, nowMs = Date.now()) {
  const txn = restartTxnId(job);
  if (verdict.action === 'restart') recordRestart(dataDir, job.jobId, nowMs, txn);
  const written = { ...verdict, txn };
  writeVerdict(jobFile, written);
  return written;
}

// A verdict found at the start of a pass. Valid only if it is this job generation's,
// has a known action, and (for a restart) its count is on disk.
function inspectVerdict(dataDir, jobFile, job, nowMs = Date.now()) {
  if (!fs.existsSync(verdictPath(jobFile))) return { state: 'none' };
  let verdict;
  try {
    verdict = JSON.parse(fs.readFileSync(verdictPath(jobFile), 'utf8'));
  } catch {
    return { state: 'invalid', reason: 'the verdict file could not be read' };
  }
  if (!verdict || typeof verdict !== 'object') return { state: 'invalid', reason: 'the verdict is not an object' };
  if (verdict.action !== 'restart' && verdict.action !== 'give-up') return { state: 'invalid', reason: 'the verdict has no known action' };
  if (verdict.txn !== restartTxnId(job)) return { state: 'invalid', reason: 'the verdict is not for this run of the job' };
  if (verdict.action === 'restart') {
    let counted = false;
    try {
      counted = restartTxnCounted(dataDir, verdict.txn, nowMs);
    } catch {
      counted = false;
    }
    if (!counted) return { state: 'invalid', reason: 'the verdict is not backed by a counted restart' };
  }
  return { state: 'valid', verdict };
}

function groupHasMembers(entry, { kill, processStart, platform }) {
  if (!entry.group || platform === 'win32') return false;
  const leaderStart = String(processStart(entry.pid) || '');
  // A live leader with another start time is a reused pid. A pid cannot be reused while
  // its group has members, so that group is not ours and is gone.
  if (leaderStart && entry.startId && leaderStart !== entry.startId) return false;
  try {
    kill(-entry.pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

async function settleProcessGroups(
  entries,
  {
    kill = process.kill.bind(process),
    sleep,
    processStart = currentProcessStart,
    platform = process.platform,
    graceMs = RESTART_GROUP_GRACE_MS,
    pollMs = RESTART_GROUP_POLL_GRACE_MS,
    members = [],
  } = {},
) {
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const probe = { kill, processStart, platform };
  const liveGroups = () => (entries || []).filter((entry) => groupHasMembers(entry, probe));
  // A pid that no longer has its recorded start time is gone, or is someone else's.
  const liveMembers = () => members.filter((item) => item.startId && String(processStart(item.pid) || '') === item.startId);
  const livePids = () => [...liveGroups(), ...liveMembers()].map((item) => item.pid);
  const waitGone = async () => {
    for (let waited = 0; ; waited += pollMs) {
      if (!livePids().length) return true;
      if (waited >= graceMs) return false;
      await wait(pollMs);
    }
  };
  if (await waitGone()) return { ok: true, killed: false };
  for (const target of [...liveGroups().map((entry) => -entry.pid), ...liveMembers().map((item) => item.pid)]) {
    try {
      kill(target, 'SIGKILL');
    } catch {
      /* already gone, or refused: the check below decides */
    }
  }
  if (await waitGone()) return { ok: true, killed: true };
  return {
    ok: false,
    reason: `the old process group (${livePids().join(', ')}) was still alive after SIGKILL, so the job was not restarted`,
  };
}

function clearVerdict(jobFile) {
  try {
    fs.unlinkSync(verdictPath(jobFile));
  } catch {
    /* already gone */
  }
}

function hasVerdict(jobFile) {
  return fs.existsSync(verdictPath(jobFile));
}

// A dead owner's file is stale: it is cleaned up and its processes are left alone.
function removeStaleJob(jobFile, job) {
  for (const target of [jobFile, verdictPath(jobFile), stoppingPath(jobFile), job && job.progressPath]) {
    if (!target) continue;
    try {
      fs.unlinkSync(target);
    } catch {
      /* already gone */
    }
  }
}

function readProgressTail(file, maxBytes) {
  const size = fs.statSync(file).size;
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, size - length);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString('utf8');
}

module.exports = {
  MAX_PROGRESS_BYTES,
  WATCHED_JOB_PROGRESS_ENV,
  RESTART_GROUP_GRACE_MS,
  clearStoppingTree,
  clearVerdict,
  commitVerdict,
  readStoppingTree,
  writeStoppingTree,
  hasVerdict,
  inspectVerdict,
  listWatchedJobs,
  nightKey,
  noteWatchedProgress,
  processStartIdentity,
  currentProcessStart,
  setProcessStartReaderForTests,
  readProgressTail,
  recordRestart,
  registerWatchedJob,
  removeStaleJob,
  restartCountsPath,
  restartTxnCounted,
  restartTxnId,
  restartsTonight,
  settleProcessGroups,
  verdictPath,
  watchedJobsDir,
  writeVerdict,
};
