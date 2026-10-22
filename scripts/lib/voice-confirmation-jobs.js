'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const JOBS_FILENAME = 'voice-confirmation-jobs.jsonl';
const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;
const DEFAULT_RUNNING_FRESH_MS = 20 * 60 * 1000;
const DEFAULT_LOCK_STALE_MS = 45 * 60 * 1000;
const DEFAULT_MAX_DISPATCH_CYCLES = 8;
const DEFAULT_RETRY_BACKOFF_BASE_MS = 2 * 60 * 1000;
const DEFAULT_RETRY_BACKOFF_MAX_MS = 60 * 60 * 1000;
const WORKER_LOCK_FILENAME = 'voice-confirmation-backprop.lock';
const NON_RELAY_ACTION_RE = /^(?:not_them|ignore|dismiss|dont_know|non_speech)$/i;
const NON_ACOUSTIC_DISCOVERY_ACTION_RE = /^(?:link_person_file|create_people_file|add_notes|not_them|ignore|dismiss|dont_know|non_speech)$/i;

function timeMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function eventTimestamp(row) {
  return (
    row?.event_at ||
    row?.completed_at ||
    row?.failed_at ||
    row?.started_at ||
    row?.accepted_at ||
    ''
  );
}

function jobsPathForDataRoot(dataRoot) {
  return path.join(
    dataRoot,
    'life-archive',
    'people',
    JOBS_FILENAME,
  );
}

function workerLockPathForDataRoot(dataRoot) {
  return path.join(dataRoot, 'life-archive', 'voiceprints', WORKER_LOCK_FILENAME);
}

function readVoiceConfirmationJobEvents(filePath, fsApi = fs) {
  try {
    return fsApi
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((row) => row?.request_id && row?.job_status);
  } catch {
    return [];
  }
}

function appendVoiceConfirmationJobEvent(filePath, event, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
  const eventAt = event.event_at || new Date().toISOString();
  const row = {
    schema: 'life_archive_voice_confirmation_job.v1',
    ...event,
    event_at: eventAt,
  };
  fsApi.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

function percentile(values, percentileValue) {
  const sorted = (values || [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return Math.round(sorted[index]);
}

function collectJobStates(events = []) {
  const states = new Map();
  const sorted = [...events].sort(
    (left, right) => timeMs(eventTimestamp(left)) - timeMs(eventTimestamp(right)),
  );
  for (const row of sorted) {
    if (!row?.request_id || !row?.job_status) continue;
    const current = states.get(row.request_id) || {
      request_id: row.request_id,
      accepted_at: '',
      ack_latency_ms: null,
      action: '',
      voice_cluster_id: '',
      person_file_path: '',
      selected_person_id: '',
      guessed_name: '',
      latest: null,
    };
    if (!current.accepted_at && row.accepted_at) current.accepted_at = row.accepted_at;
    if (!current.action && row.action) current.action = String(row.action);
    if (!current.voice_cluster_id && row.voice_cluster_id)
      current.voice_cluster_id = String(row.voice_cluster_id);
    if (!current.person_file_path && row.person_file_path)
      current.person_file_path = String(row.person_file_path);
    if (!current.selected_person_id && row.selected_person_id)
      current.selected_person_id = String(row.selected_person_id);
    if (!current.guessed_name && row.guessed_name)
      current.guessed_name = String(row.guessed_name);
    if (
      current.ack_latency_ms == null &&
      Number.isFinite(Number(row.ack_latency_ms))
    ) {
      current.ack_latency_ms = Number(row.ack_latency_ms);
    }
    current.latest = row;
    states.set(row.request_id, current);
  }
  return states;
}

function voiceConfirmationJobRequiresGitRelay(state = {}) {
  return !NON_RELAY_ACTION_RE.test(String(state.action || ''));
}

function voiceConfirmationJobNeedsAcousticDiscovery(state = {}) {
  return !NON_ACOUSTIC_DISCOVERY_ACTION_RE.test(String(state.action || ''));
}

function summarizeVoiceConfirmationJobs(
  events = [],
  {
    nowMs = Date.now(),
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
  } = {},
) {
  const states = collectJobStates(events);
  const completed = [];
  const pending = [];
  const failed = [];
  const stalePending = [];
  const ackLatencies = [];
  const completionLatencies = [];
  for (const state of states.values()) {
    if (Number.isFinite(state.ack_latency_ms)) ackLatencies.push(state.ack_latency_ms);
    const status = String(state.latest?.job_status || '');
    if (status === 'completed') {
      completed.push(state);
      const acceptedMs = timeMs(state.accepted_at);
      const completedMs = timeMs(state.latest?.completed_at || eventTimestamp(state.latest));
      const explicitLatency = Number(state.latest?.completion_latency_ms);
      if (Number.isFinite(explicitLatency) && explicitLatency >= 0) {
        completionLatencies.push(explicitLatency);
      } else if (acceptedMs && completedMs >= acceptedMs) {
        completionLatencies.push(completedMs - acceptedMs);
      }
      continue;
    }
    pending.push(state);
    if (status === 'failed' || status === 'dispatch_failed') failed.push(state);
    const acceptedMs = timeMs(state.accepted_at || eventTimestamp(state.latest));
    if (acceptedMs && nowMs - acceptedMs > staleAfterMs) stalePending.push(state);
  }
  return {
    accepted_jobs: states.size,
    completed_jobs: completed.length,
    pending_jobs: pending.length,
    failed_jobs: failed.length,
    stale_pending_jobs: stalePending.length,
    ack_latency_p50_ms: percentile(ackLatencies, 50),
    ack_latency_p95_ms: percentile(ackLatencies, 95),
    completion_latency_p50_ms: percentile(completionLatencies, 50),
    completion_latency_p95_ms: percentile(completionLatencies, 95),
    pending_request_ids: pending.map((state) => state.request_id),
    failed_request_ids: failed.map((state) => state.request_id),
    stale_pending_request_ids: stalePending.map((state) => state.request_id),
    states,
  };
}

// Every dispatch path spends the Save's budget: a worker start, a failed spawn,
// and a worker that found the lock busy. Counting only starts let a Save whose
// dispatches kept failing stay eligible forever and keep the scheduler firing.
// A dispatch_failed row counts only when its writer tagged it counted_attempt:
// the old id-less scheduler stamped untagged rows on every pending Save when
// one unrelated spawn failed, and those Saves were never dispatched.
function dispatchAttemptsByRequestId(events = []) {
  const attempts = new Map();
  for (const row of events) {
    if (!row?.request_id) continue;
    const started = row.job_status === 'running' && row.phase === 'starting';
    if (started || (row.job_status === 'dispatch_failed' && row.counted_attempt === true)) {
      attempts.set(row.request_id, (attempts.get(row.request_id) || 0) + 1);
    }
  }
  return attempts;
}

function retryBackoffMs(
  attempts,
  { backoffBaseMs = DEFAULT_RETRY_BACKOFF_BASE_MS, backoffMaxMs = DEFAULT_RETRY_BACKOFF_MAX_MS } = {},
) {
  if (attempts < 1) return 0;
  return Math.min(backoffMaxMs, backoffBaseMs * 2 ** (attempts - 1));
}

// Returns the one exact Save the worker should run ({ requestId }), an id-less
// full-state replay ({ requestId: '', reason: 'replay' }), or null. The worker
// receives the exact id, so a capped or stale Save can never be replayed in
// place of the eligible one that justified the dispatch.
function selectVoiceConfirmationDispatch(
  events = [],
  {
    nowMs = Date.now(),
    runningFreshMs = DEFAULT_RUNNING_FRESH_MS,
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
    maxDispatchCycles = DEFAULT_MAX_DISPATCH_CYCLES,
    backoffBaseMs = DEFAULT_RETRY_BACKOFF_BASE_MS,
    backoffMaxMs = DEFAULT_RETRY_BACKOFF_MAX_MS,
    projectionAudit = null,
    confirmationBackprop = null,
    workerLockHeld: lockHeld = false,
  } = {},
) {
  if (lockHeld) return null;
  const summary = summarizeVoiceConfirmationJobs(events, { nowMs, staleAfterMs });
  const attemptsById = dispatchAttemptsByRequestId(events);
  // collectJobStates inserts each Save at its first event, so the first
  // eligible state is the oldest one.
  const workerEligibleStates = [...summary.states.values()].filter((state) => {
    const status = String(state.latest?.job_status || '');
    const attempts = attemptsById.get(state.request_id) || 0;
    if (attempts >= maxDispatchCycles) return false;
    const latestEventMs = timeMs(eventTimestamp(state.latest));
    if (status === 'awaiting_git_relay') {
      if (!(latestEventMs > 0 && nowMs - latestEventMs > staleAfterMs)) return false;
    } else if (!['accepted', 'dispatch_failed', 'failed', 'running'].includes(status)) {
      return false;
    }
    const backoff = retryBackoffMs(attempts, { backoffBaseMs, backoffMaxMs });
    return !backoff || latestEventMs <= 0 || nowMs - latestEventMs >= backoff;
  });
  const hasCurrentRunner = [...summary.states.values()].some((state) => {
    if (state.latest?.job_status !== 'running') return false;
    const workerPid = Number(state.latest?.worker_pid);
    if (
      Number.isInteger(workerPid) &&
      workerPid > 0 &&
      !processIsAlive(workerPid)
    ) {
      return false;
    }
    const eventAtMs = timeMs(eventTimestamp(state.latest));
    return eventAtMs > 0 && nowMs - eventAtMs <= runningFreshMs;
  });
  if (hasCurrentRunner) return null;
  if (workerEligibleStates.length) return { requestId: workerEligibleStates[0].request_id };
  return projectionAuditNeedsBackpropReplay(projectionAudit, confirmationBackprop, {
    nowMs,
    runningFreshMs,
  })
    ? { requestId: '', reason: 'replay' }
    : null;
}

// A detached worker can get a pid and still die before it records anything for
// its Save (a failed import, a crash at startup). Nothing then spends the
// Save's budget and the scheduler would re-spawn it every minute. The backend
// calls this when the worker it spawned exits: if the Save is still open and no
// ledger row was written for it since the spawn, one counted dispatch_failed
// row is recorded. A completed Save is never touched, so it cannot reopen.
function recordUnstartedWorkerExit(
  jobsPath,
  { requestId = '', spawnedAtMs = 0, code = null, signal = null } = {},
  {
    readEvents = readVoiceConfirmationJobEvents,
    appendEvent = appendVoiceConfirmationJobEvent,
    now = new Date(),
  } = {},
) {
  if (!requestId || !(spawnedAtMs > 0)) return false;
  const events = readEvents(jobsPath);
  const state = collectJobStates(events).get(requestId);
  if (!state || state.latest?.job_status === 'completed') return false;
  // Strictly after: the Save's own accepted row can share the spawn's
  // millisecond, and a worker cannot write within it.
  const wroteSinceSpawn = events.some(
    (row) => row?.request_id === requestId && timeMs(eventTimestamp(row)) > spawnedAtMs,
  );
  if (wroteSinceSpawn) return false;
  appendEvent(jobsPath, {
    request_id: requestId,
    voice_cluster_id: state.voice_cluster_id || state.latest?.voice_cluster_id || '',
    person_file_path: state.person_file_path || state.latest?.person_file_path || '',
    job_status: 'dispatch_failed',
    error: `worker exited (${signal || `code ${code}`}) before recording a start`,
    counted_attempt: true,
    event_at: now.toISOString(),
  });
  return true;
}

function shouldDispatchVoiceConfirmationWorker(events = [], options = {}) {
  return Boolean(selectVoiceConfirmationDispatch(events, options));
}

function projectionAuditNeedsBackpropReplay(
  audit = null,
  confirmationBackprop = null,
  { nowMs = Date.now(), runningFreshMs = DEFAULT_RUNNING_FRESH_MS } = {},
) {
  if (!audit || /^green$/i.test(String(audit.status || ''))) return false;
  const expected = Number(audit.expected_people_files || 0);
  const current = Number(audit.current_people_file_projections || 0);
  const missing = Math.max(
    Number(audit.missing_or_stale_people_file_projections || 0),
    expected - current,
    0,
  );
  if (missing <= 0) return false;
  const auditAt = timeMs(audit.generated_at);
  const backpropAt = timeMs(confirmationBackprop?.generated_at);
  if (auditAt <= 0) return false;
  if (!backpropAt || auditAt > backpropAt) return true;
  const phase = String(confirmationBackprop?.phase || '');
  const nonTerminalBackprop =
    confirmationBackprop?.ok == null ||
    phase === 'already_running' ||
    phase.startsWith('running_');
  return (
    nonTerminalBackprop &&
    nowMs > backpropAt &&
    nowMs - backpropAt > runningFreshMs
  );
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Read-only probe for the scheduler: true only while a live process owns the
// worker lock. It never removes or rewrites the lock; acquireWorkerLock keeps
// sole ownership of stale-lock recovery.
function workerLockHeld(lockPath, { fsApi = fs, pidAlive = processIsAlive } = {}) {
  try {
    const existing = JSON.parse(fsApi.readFileSync(lockPath, 'utf8'));
    const pid = Number(existing?.pid);
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid);
  } catch {
    return false;
  }
}

function acquireWorkerLock(
  lockPath,
  {
    nowMs = Date.now(),
    staleAfterMs = DEFAULT_LOCK_STALE_MS,
    fsApi = fs,
  } = {},
) {
  fsApi.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = crypto.randomBytes(12).toString('hex');
  const write = () => {
    const fd = fsApi.openSync(lockPath, 'wx');
    const row = {
      token,
      pid: process.pid,
      acquired_at: new Date(nowMs).toISOString(),
    };
    fsApi.writeFileSync(fd, `${JSON.stringify(row)}\n`, 'utf8');
    fsApi.closeSync(fd);
    return row;
  };
  try {
    return write();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  let existing = null;
  try {
    existing = JSON.parse(fsApi.readFileSync(lockPath, 'utf8'));
  } catch {
    existing = null;
  }
  const acquiredMs = timeMs(existing?.acquired_at);
  const existingPid = Number(existing?.pid);
  const hasUsablePid = Number.isInteger(existingPid) && existingPid > 0;
  const alive = hasUsablePid && processIsAlive(existingPid);
  const stale = !acquiredMs || nowMs - acquiredMs > staleAfterMs;
  if (alive) return null;
  if (existing && !hasUsablePid && !stale) return null;
  try {
    fsApi.unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') return null;
  }
  try {
    return write();
  } catch {
    return null;
  }
}

function releaseWorkerLock(lockPath, token, fsApi = fs) {
  try {
    const current = JSON.parse(fsApi.readFileSync(lockPath, 'utf8'));
    if (current?.token !== token) return false;
    fsApi.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  JOBS_FILENAME,
  DEFAULT_STALE_AFTER_MS,
  DEFAULT_MAX_DISPATCH_CYCLES,
  DEFAULT_RETRY_BACKOFF_BASE_MS,
  DEFAULT_RETRY_BACKOFF_MAX_MS,
  jobsPathForDataRoot,
  workerLockPathForDataRoot,
  readVoiceConfirmationJobEvents,
  appendVoiceConfirmationJobEvent,
  collectJobStates,
  voiceConfirmationJobRequiresGitRelay,
  voiceConfirmationJobNeedsAcousticDiscovery,
  summarizeVoiceConfirmationJobs,
  projectionAuditNeedsBackpropReplay,
  dispatchAttemptsByRequestId,
  retryBackoffMs,
  recordUnstartedWorkerExit,
  selectVoiceConfirmationDispatch,
  shouldDispatchVoiceConfirmationWorker,
  workerLockHeld,
  acquireWorkerLock,
  releaseWorkerLock,
};
