'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { IllegalTransitionError, defineStateMachine, withFileLock } = require('./ledger-state-machine');

const JOBS_FILENAME = 'voice-confirmation-jobs.jsonl';
const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;
const DEFAULT_RUNNING_FRESH_MS = 20 * 60 * 1000;
const DEFAULT_LOCK_STALE_MS = 45 * 60 * 1000;
// A reclaim guard is held for microseconds; one this old outlived a crash.
const LOCK_RECLAIM_GUARD_STALE_MS = 30 * 1000;
const DEFAULT_MAX_DISPATCH_CYCLES = 8;
const DEFAULT_RETRY_BACKOFF_BASE_MS = 2 * 60 * 1000;
const DEFAULT_RETRY_BACKOFF_MAX_MS = 60 * 60 * 1000;
// A worker writes a running row at every step and the worker lock treats 45
// minutes as dead, so a running Save silent for that long has no live worker.
const DEFAULT_RUNNING_TTL_MS = DEFAULT_LOCK_STALE_MS;
const WORKER_LOCK_FILENAME = 'voice-confirmation-backprop.lock';
const NON_RELAY_ACTION_RE = /^(?:not_them|ignore|dismiss|dont_know|non_speech|two_people|undo_two_people)$/i;
const NON_ACOUSTIC_DISCOVERY_ACTION_RE = /^(?:link_person_file|create_people_file|add_notes|not_them|ignore|dismiss|dont_know|non_speech|two_people|undo_two_people)$/i;

// The one declaration of a Save job's states (state machine audit #18, the owner,
// 2026-11-03). Every ledger row is a move, so a writer that would make an
// illegal one (completed back to failed, anything after abandoned) is refused
// instead of rewriting history. Past DEFAULT_MAX_DISPATCH_CYCLES counted
// attempts a Save is abandoned, a terminal state that says why and whether the
// decision was applied, so it never sits as a stale counter. `exhausted` is the
// spelling an old watcher wrote on disk.
const voiceConfirmationJobMachine = defineStateMachine({
  name: 'voice-confirmation-job',
  transitions: {
    // A relay-only request (an exact-call People projection) has no Save and
    // closes on landing; a Save always starts accepted.
    '': ['accepted', 'completed'],
    accepted: ['running', 'dispatch_failed', 'abandoned'],
    running: ['running', 'awaiting_git_relay', 'completed', 'failed', 'dispatch_failed', 'abandoned'],
    dispatch_failed: ['running', 'dispatch_failed', 'completed', 'abandoned'],
    failed: ['running', 'dispatch_failed', 'completed', 'abandoned'],
    awaiting_git_relay: [
      'running',
      'awaiting_git_relay',
      'completed',
      'failed',
      'dispatch_failed',
      'abandoned',
    ],
    // Only a forced exact replay (--force-exact-replay) reopens a completed Save.
    completed: ['running'],
  },
  terminal: ['abandoned'],
  aliases: { exhausted: 'abandoned' },
  inFlight: {
    accepted: { maxAttempts: DEFAULT_MAX_DISPATCH_CYCLES },
    running: { ttlMs: DEFAULT_RUNNING_TTL_MS, maxAttempts: DEFAULT_MAX_DISPATCH_CYCLES },
    dispatch_failed: { maxAttempts: DEFAULT_MAX_DISPATCH_CYCLES },
    failed: { maxAttempts: DEFAULT_MAX_DISPATCH_CYCLES },
    awaiting_git_relay: { ttlMs: DEFAULT_STALE_AFTER_MS, maxAttempts: DEFAULT_MAX_DISPATCH_CYCLES },
  },
});

function voiceConfirmationJobStatus(state) {
  return voiceConfirmationJobMachine.normalize(state?.latest?.job_status);
}

// completed and abandoned both end a Save's dispatching.
function voiceConfirmationJobSettled(state) {
  const status = voiceConfirmationJobStatus(state);
  return status === 'completed' || status === 'abandoned';
}

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

// One Save's rows only. The ledger holds every Save ever accepted, so the lines
// are matched on the id before they are parsed.
function readRequestEvents(filePath, requestId, fsApi = fs) {
  const id = String(requestId || '');
  if (!id) return [];
  let text = '';
  try {
    text = fsApi.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || !line.includes(id)) continue;
    try {
      const row = JSON.parse(line);
      if (row?.request_id === id && row?.job_status) rows.push(row);
    } catch {
      // A torn line cannot name a state.
    }
  }
  return rows;
}

function everCompleted(events = []) {
  return events.some((row) => voiceConfirmationJobMachine.normalize(row?.job_status) === 'completed');
}

// Refuses a move the machine does not allow. A completed Save reopens only when
// the row says it is a forced replay.
function assertJobMove(fromStatus, event) {
  const to = voiceConfirmationJobMachine.assertTransition(fromStatus, event.job_status);
  if (voiceConfirmationJobMachine.normalize(fromStatus) === 'completed' && event.forced_replay !== true) {
    throw new IllegalTransitionError(voiceConfirmationJobMachine.name, 'completed', to);
  }
  return to;
}

function abandonedRow(history, status, attempts, eventAt, lastError = '') {
  const action = history.find((row) => row.action)?.action || '';
  return {
    schema: 'life_archive_voice_confirmation_job.v1',
    request_id: history[0].request_id,
    voice_cluster_id: history.find((row) => row.voice_cluster_id)?.voice_cluster_id || '',
    person_file_path: history.find((row) => row.person_file_path)?.person_file_path || '',
    ...(action ? { action } : {}),
    job_status: 'abandoned',
    reason: 'attempts_exhausted',
    reason_detail:
      `${attempts} of ${DEFAULT_MAX_DISPATCH_CYCLES} dispatch attempts used; last state ${status}` +
      (lastError ? `: ${String(lastError).slice(0, 300)}` : ''),
    attempt_count: attempts,
    last_status: status,
    // awaiting_git_relay means the identity apply ran and only the People File
    // relay never landed; anything earlier means the decision was never applied.
    decision_applied: history.some(
      (row) => voiceConfirmationJobMachine.normalize(row.job_status) === 'awaiting_git_relay',
    ),
    abandoned_at: eventAt,
    event_at: eventAt,
  };
}

// Appends one row under the ledger lock after checking the move against the
// Save's own history. An illegal move throws IllegalTransitionError and writes
// nothing. When the row is a failure that spends the Save's last attempt, the
// abandoned row follows in the same locked step, so a Save never rests in
// failed with no budget left.
function appendVoiceConfirmationJobEvent(filePath, event, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
  return withFileLock(filePath, () => {
    const eventAt = event.event_at || new Date().toISOString();
    const row = {
      schema: 'life_archive_voice_confirmation_job.v1',
      ...event,
      event_at: eventAt,
    };
    const history = readRequestEvents(filePath, row.request_id, fsApi);
    const latest = collectJobStates(history).get(row.request_id)?.latest;
    assertJobMove(latest?.job_status, row);
    fsApi.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
    const status = voiceConfirmationJobMachine.normalize(row.job_status);
    if (status === 'failed' || status === 'dispatch_failed') {
      const rows = [...history, row];
      const attempts = dispatchAttemptsByRequestId(rows).get(row.request_id) || 0;
      if (!everCompleted(history) && voiceConfirmationJobMachine.attemptsExhausted(status, attempts)) {
        fsApi.appendFileSync(
          filePath,
          `${JSON.stringify(abandonedRow(rows, status, attempts, eventAt, row.error || row.error_tail || ''))}\n`,
          'utf8',
        );
      }
    }
    return row;
  });
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
  const abandoned = [];
  const stuckRunning = [];
  const ackLatencies = [];
  const completionLatencies = [];
  for (const state of states.values()) {
    if (Number.isFinite(state.ack_latency_ms)) ackLatencies.push(state.ack_latency_ms);
    const status = voiceConfirmationJobStatus(state);
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
    // Abandoned is terminal and reported on its own; it is neither pending nor
    // stale, so the stale counter can no longer hide a Save that was given up.
    if (status === 'abandoned') {
      abandoned.push(state);
      continue;
    }
    pending.push(state);
    if (status === 'failed' || status === 'dispatch_failed') failed.push(state);
    if (
      status === 'running' &&
      voiceConfirmationJobMachine.isExpired('running', eventTimestamp(state.latest), nowMs)
    ) {
      stuckRunning.push(state);
    }
    const acceptedMs = timeMs(state.accepted_at || eventTimestamp(state.latest));
    if (acceptedMs && nowMs - acceptedMs > staleAfterMs) stalePending.push(state);
  }
  return {
    accepted_jobs: states.size,
    completed_jobs: completed.length,
    pending_jobs: pending.length,
    failed_jobs: failed.length,
    stale_pending_jobs: stalePending.length,
    abandoned_jobs: abandoned.length,
    stuck_running_jobs: stuckRunning.length,
    ack_latency_p50_ms: percentile(ackLatencies, 50),
    ack_latency_p95_ms: percentile(ackLatencies, 95),
    completion_latency_p50_ms: percentile(completionLatencies, 50),
    completion_latency_p95_ms: percentile(completionLatencies, 95),
    pending_request_ids: pending.map((state) => state.request_id),
    failed_request_ids: failed.map((state) => state.request_id),
    stale_pending_request_ids: stalePending.map((state) => state.request_id),
    abandoned_request_ids: abandoned.map((state) => state.request_id),
    stuck_running_request_ids: stuckRunning.map((state) => state.request_id),
    abandoned: abandoned.map((state) => ({
      request_id: state.request_id,
      voice_cluster_id: state.voice_cluster_id || '',
      action: state.action || '',
      reason: String(state.latest?.reason || 'attempts_exhausted'),
      reason_detail: String(state.latest?.reason_detail || state.latest?.reason || ''),
      attempt_count: Number(state.latest?.attempt_count) || null,
      decision_applied: state.latest?.decision_applied === true,
      abandoned_at: state.latest?.abandoned_at || eventTimestamp(state.latest),
    })),
    states,
  };
}

// Every dispatch path spends the Save's budget: a worker start, a failed spawn,
// and a worker that found the lock busy. Counting only starts let a Save whose
// dispatches kept failing stay eligible forever and keep the scheduler firing.
// A dispatch_failed row counts only when its writer tagged it counted_attempt:
// the old id-less scheduler stamped untagged rows on every pending Save when
// one unrelated spawn failed, and those Saves were never dispatched.
// Nov 4 #otter (owner decision): the one exception is a row the worker lock
// caused. Another worker held the lock, so this Save never ran and its budget
// is untouched; a burst of 24 answers would otherwise burn attempts just by
// queueing behind the single worker.
function isLockCausedDispatchFailure(row) {
  if (!row || row.job_status !== 'dispatch_failed') return false;
  return (
    row.lock_caused === true ||
    /(^|[^a-z_])worker_lock_busy([^a-z_]|$)/i.test(String(row.error || row.reason || ''))
  );
}

function dispatchAttemptsByRequestId(events = []) {
  const attempts = new Map();
  for (const row of events) {
    if (!row?.request_id) continue;
    const started = row.job_status === 'running' && row.phase === 'starting';
    if (
      started ||
      (row.job_status === 'dispatch_failed' &&
        row.counted_attempt === true &&
        !isLockCausedDispatchFailure(row))
    ) {
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
  // Nov 4 #otter (owner decision): a lock-busy row says only that another
  // worker was running. It is transparent here, so the Save's status, relay
  // wait and backoff read as if the row were never written.
  const dispatchStates = collectJobStates(
    events.filter((row) => !isLockCausedDispatchFailure(row)),
  );
  // A Save the worker already applied (it reached awaiting_git_relay) only
  // waits on the desktop relay. If those reruns went first they would hold the
  // one worker lock and starve every Save that has not been applied yet, so
  // the never-applied Saves go first, oldest first; reruns follow, the one
  // tried longest ago first. collectJobStates inserts each Save at its first
  // event, so insertion order is oldest first.
  const appliedIds = new Set(
    events.filter((row) => row?.job_status === 'awaiting_git_relay').map((row) => row.request_id),
  );
  const eligibleStates = [...dispatchStates.values()].filter((state) => {
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
  const workerEligibleStates = [
    ...eligibleStates.filter((state) => !appliedIds.has(state.request_id)),
    ...eligibleStates
      .filter((state) => appliedIds.has(state.request_id))
      .sort(
        (left, right) =>
          timeMs(eventTimestamp(left.latest)) - timeMs(eventTimestamp(right.latest)),
      ),
  ];
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
  if (!state || voiceConfirmationJobSettled(state)) return false;
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

// The sweep for Saves that no dispatch will ever pick up again. The scheduler
// calls it each tick, and the worker calls it at start, under the ledger lock:
//   - a running Save with no row for DEFAULT_RUNNING_TTL_MS has no live worker.
//     It moves to failed (running_ttl_expired), which says the run died and
//     makes no claim that the work did or did not happen; the apply is replayed
//     only through the normal budgeted dispatch.
//   - a Save with no attempts left that is not running (or is past its relay
//     wait) moves to abandoned, so it stops being a stale counter.
// A Save that ever completed (a forced replay) is left to the operator.
function settleVoiceConfirmationJobs(
  filePath,
  { nowMs = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS, fsApi = fs } = {},
) {
  const result = { failed: [], abandoned: [] };
  return withFileLock(filePath, () => {
    const events = readVoiceConfirmationJobEvents(filePath, fsApi);
    const attemptsById = dispatchAttemptsByRequestId(events);
    const completedIds = new Set(
      events
        .filter((row) => voiceConfirmationJobMachine.normalize(row.job_status) === 'completed')
        .map((row) => row.request_id),
    );
    const append = (row) =>
      fsApi.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
    const nowIso = new Date(nowMs).toISOString();
    for (const state of collectJobStates(events).values()) {
      let status = voiceConfirmationJobStatus(state);
      if (voiceConfirmationJobSettled(state) || completedIds.has(state.request_id)) continue;
      const lastAtMs = timeMs(eventTimestamp(state.latest));
      const history = events.filter((row) => row.request_id === state.request_id);
      let lastError = state.latest.error_tail || state.latest.error || '';
      if (
        status === 'running' &&
        voiceConfirmationJobMachine.isExpired('running', eventTimestamp(state.latest), nowMs)
      ) {
        lastError = `no worker row for ${Math.round((nowMs - lastAtMs) / 60000)} minutes; the run is presumed dead (last phase ${state.latest.phase || 'unknown'})`;
        append({
          schema: 'life_archive_voice_confirmation_job.v1',
          request_id: state.request_id,
          voice_cluster_id: state.voice_cluster_id || '',
          person_file_path: state.person_file_path || '',
          ...(state.action ? { action: state.action } : {}),
          job_status: 'failed',
          failed_at: nowIso,
          failure_phase: 'running_ttl_expired',
          error_tail: lastError,
          event_at: nowIso,
        });
        result.failed.push(state.request_id);
        status = 'failed';
      }
      const attempts = attemptsById.get(state.request_id) || 0;
      if (!voiceConfirmationJobMachine.attemptsExhausted(status, attempts)) continue;
      // The last attempt may still be running, or waiting on its relay.
      if (status === 'running') continue;
      if (status === 'awaiting_git_relay' && !(lastAtMs > 0 && nowMs - lastAtMs > staleAfterMs)) continue;
      voiceConfirmationJobMachine.assertTransition(status, 'abandoned');
      append(abandonedRow(history, status, attempts, nowIso, lastError));
      result.abandoned.push(state.request_id);
    }
    return result;
  });
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
  const row = {
    token,
    pid: process.pid,
    acquired_at: new Date(nowMs).toISOString(),
  };
  // The lock path appears only with its full row (temp file, then link), so a
  // contender never reads a half-written lock and mistakes it for stale. An
  // open-then-write lock let two processes both acquire (Codex 1d642350e498).
  const publish = () => {
    const temp = `${lockPath}.${token}.tmp`;
    fsApi.writeFileSync(temp, `${JSON.stringify(row)}\n`, { encoding: 'utf8', flag: 'wx' });
    try {
      fsApi.linkSync(temp, lockPath);
      return row;
    } catch (error) {
      if (error?.code === 'EEXIST') return null;
      throw error;
    } finally {
      try {
        fsApi.unlinkSync(temp);
      } catch {}
    }
  };
  const first = publish();
  if (first) return first;
  // Stale-lock recovery runs under a short guard, so two contenders cannot
  // both unlink: the second re-reads and finds the first one's fresh lock.
  const guard = `${lockPath}.reclaim`;
  try {
    fsApi.writeFileSync(guard, `${process.pid}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    try {
      if (Date.now() - fsApi.statSync(guard).mtimeMs > LOCK_RECLAIM_GUARD_STALE_MS) fsApi.unlinkSync(guard);
    } catch {}
    return null;
  }
  try {
    // A failed read never means "free". Gone means the owner just released:
    // retry the atomic publish, because unlinking here would remove a lock a
    // third process took meanwhile (Codex 01b5a847a7e8). Unreadable (a writer
    // from the previous release mid-write) is judged by its age alone.
    let existing;
    try {
      existing = JSON.parse(fsApi.readFileSync(lockPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return publish();
      existing = { acquired_at: new Date(fsApi.statSync(lockPath).mtimeMs).toISOString() };
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
    return publish();
  } catch {
    return null;
  } finally {
    try {
      fsApi.unlinkSync(guard);
    } catch {}
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
  DEFAULT_RUNNING_TTL_MS,
  voiceConfirmationJobMachine,
  voiceConfirmationJobStatus,
  voiceConfirmationJobSettled,
  settleVoiceConfirmationJobs,
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
  isLockCausedDispatchFailure,
  retryBackoffMs,
  recordUnstartedWorkerExit,
  selectVoiceConfirmationDispatch,
  shouldDispatchVoiceConfirmationWorker,
  workerLockHeld,
  acquireWorkerLock,
  releaseWorkerLock,
};
