const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const QUEUE_SCHEMA = 'otter_call_landing_queue.v1';
const DEFAULT_RETRY_MS = 60_000;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function timestamp(now = new Date()) {
  const value = now instanceof Date ? now : new Date(now);
  return value.toISOString();
}

function defaultLandingQueuePath(dataDir) {
  const root =
    dataDir ||
    process.env.SECONDBRAIN_DATA_DIR ||
    process.env.SECONDBRAIN_DATA ||
    '/opt/secondbrain/data';
  return path.join(root, 'agent', 'otter-call-landing-events.jsonl');
}

function sourceRevisionForRawBytes(rawBytes) {
  return crypto.createHash('sha256').update(rawBytes).digest('hex');
}

function sourceRevisionForSpeech(speech = {}) {
  return sourceRevisionForRawBytes(Buffer.from(JSON.stringify(speech, null, 2), 'utf8'));
}

function landingJobIdentity(otid, sourceRevision) {
  const exact = `${String(otid)}\0${String(sourceRevision)}`;
  const digest = sha256(exact);
  return {
    jobKey: `otter-call:${digest}`,
    clientToken: `otter-${digest.slice(0, 58)}`,
  };
}

// Each event is one O_APPEND write followed by fsync. A leading newline makes
// the next valid event independently parseable even if the previous process
// died midway through its final JSON record.
function appendLandingEvent(queuePath, event) {
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  const fd = fs.openSync(queuePath, 'a');
  try {
    const row = {
      schema: QUEUE_SCHEMA,
      ...event,
    };
    fs.writeSync(fd, Buffer.from(`\n${JSON.stringify(row)}\n`, 'utf8'));
    fs.fsyncSync(fd);
    return row;
  } finally {
    fs.closeSync(fd);
  }
}

function readLandingEvents(queuePath) {
  let raw = '';
  try {
    raw = fs.readFileSync(queuePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event && event.schema === QUEUE_SCHEMA && event.job_key) events.push(event);
    } catch {
      // A killed append can leave one torn record. Valid records are
      // newline-isolated, so one damaged event must not hide later queue work.
    }
  }
  return events;
}

function landingJobStates(queuePath) {
  const states = new Map();
  for (const [appendOrder, event] of readLandingEvents(queuePath).entries()) {
    let state = states.get(event.job_key);
    if (!state && event.type === 'enqueued') {
      state = {
        jobKey: event.job_key,
        clientToken: event.client_token,
        otid: event.otid,
        sourceRevision: event.source_revision,
        rawPath: event.raw_path || null,
        enqueuedAt: event.at,
        enqueuedOrder: appendOrder,
        launched: false,
        settled: false,
        nextAttemptAt: null,
      };
      states.set(event.job_key, state);
    }
    if (!state) continue;
    if (event.type === 'repair_enqueued') {
      state.expiredCount = 0;
      state.retryExhausted = false;
      state.clientToken = event.client_token;
      state.enqueuedAt = event.at;
      state.enqueuedOrder = appendOrder;
      state.launched = false;
      state.settled = false;
      state.nextAttemptAt = null;
      state.repairGeneration = Number(event.repair_generation || 0);
      state.repairReason = event.reason || 'exact_call_repair';
      state.repairRequestKey = event.repair_request_key || null;
      state.taskArn = null;
    } else if (event.type === 'launch_deferred') {
      if (
        event.client_token &&
        state.clientToken &&
        event.client_token !== state.clientToken
      ) {
        continue;
      }
      state.lastReason = event.reason || 'deferred';
      state.nextAttemptAt = event.next_attempt_at || null;
    } else if (event.type === 'launched') {
      if (
        event.client_token &&
        state.clientToken &&
        event.client_token !== state.clientToken
      ) {
        continue;
      }
      state.launched = true;
      state.taskArn = event.task_arn || null;
      state.launchedAt = event.at;
      state.nextAttemptAt = null;
    } else if (event.type === 'launch_expired') {
      // A launched Fargate job that stopped without publishing its envelope
      // re-enters the pending set under a fresh client token, so the queue
      // retries it instead of treating it as running forever.
      if (
        event.client_token &&
        state.clientToken &&
        event.client_token !== state.clientToken
      ) {
        continue;
      }
      state.launched = false;
      state.taskArn = null;
      state.nextAttemptAt = null;
      state.clientToken = event.next_client_token || state.clientToken;
      state.expiredCount = Number(state.expiredCount || 0) + 1;
      state.lastExpiry = { at: event.at, reason: event.reason || 'stopped_without_envelope' };
    } else if (event.type === 'retry_exhausted') {
      if (
        event.client_token &&
        state.clientToken &&
        event.client_token !== state.clientToken
      ) {
        continue;
      }
      state.retryExhausted = true;
      state.retryExhaustedReason = event.reason || '';
    } else if (event.type === 'terminal_skipped') {
      state.settled = true;
      state.settledReason = event.reason || 'terminal_revision';
      state.settledAt = event.at;
      state.nextAttemptAt = null;
    }
  }
  return states;
}

function expiredClientToken(jobKey, attempt) {
  return `otter-x${Number(attempt)}-${sha256(`${jobKey}\0expired\0${attempt}`).slice(0, 55)}`.slice(0, 64);
}

function pendingLandingJobs(queuePath) {
  return [...landingJobStates(queuePath).values()]
    .filter((job) => !job.launched && !job.settled)
    .sort(
      (a, b) =>
        String(a.enqueuedAt || '').localeCompare(String(b.enqueuedAt || '')) ||
        Number(a.enqueuedOrder || 0) - Number(b.enqueuedOrder || 0),
    );
}

function terminalLandingDisposition(job, ledger) {
  const call = (Array.isArray(ledger?.calls) ? ledger.calls : []).find(
    (row) => String(row?.otid || '') === String(job?.otid || ''),
  );
  const closure = call?.receipt_closure;
  if (!call || closure?.closed !== true || closure?.status !== 'closed') {
    return { terminal: false, reason: '' };
  }
  const closedRevision = String(closure.source_revision || '');
  const queuedRevision = String(job?.sourceRevision || '');
  if (closedRevision && closedRevision === queuedRevision) {
    return {
      terminal: true,
      reason: 'exact_revision_closed',
      closedRevision,
    };
  }

  const currentRevision = String(call.source_revision_hash || '');
  const closureCompletedMs = Date.parse(
    String(call.orchestration?.exact_revision_closure?.completed_at || ''),
  );
  const enqueuedMs = Date.parse(String(job?.enqueuedAt || ''));
  if (
    currentRevision &&
    closedRevision === currentRevision &&
    queuedRevision &&
    queuedRevision !== currentRevision &&
    Number.isFinite(closureCompletedMs) &&
    Number.isFinite(enqueuedMs) &&
    enqueuedMs <= closureCompletedMs
  ) {
    return {
      terminal: true,
      reason: 'source_revision_superseded_by_closed_revision',
      closedRevision,
    };
  }
  return { terminal: false, reason: '' };
}

function defaultCallProcessingLedgerPath(queuePath) {
  return path.join(
    path.dirname(path.dirname(queuePath)),
    'life-archive',
    'voiceprints',
    'otter-call-processing-ledger-latest.json',
  );
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function enqueueLandingEvent({
  queuePath = defaultLandingQueuePath(),
  otid,
  sourceRevision,
  rawPath = null,
  now = new Date(),
} = {}) {
  if (!otid) throw new Error('otid is required');
  if (!sourceRevision) throw new Error('sourceRevision is required');
  const { jobKey, clientToken } = landingJobIdentity(otid, sourceRevision);
  if (landingJobStates(queuePath).has(jobKey)) {
    return { enqueued: false, duplicate: true, jobKey, clientToken };
  }
  appendLandingEvent(queuePath, {
    type: 'enqueued',
    at: timestamp(now),
    job_key: jobKey,
    client_token: clientToken,
    otid: String(otid),
    source_revision: String(sourceRevision),
    raw_path: rawPath,
  });
  return { enqueued: true, duplicate: false, jobKey, clientToken };
}

function enqueueRepairEvent({
  queuePath = defaultLandingQueuePath(),
  otid,
  sourceRevision,
  reason = 'exact_call_repair',
  repairRequestKey = '',
  now = new Date(),
} = {}) {
  if (!otid) throw new Error('otid is required');
  if (!sourceRevision) throw new Error('sourceRevision is required');
  const { jobKey } = landingJobIdentity(otid, sourceRevision);
  let state = landingJobStates(queuePath).get(jobKey);
  if (!state) {
    enqueueLandingEvent({ queuePath, otid, sourceRevision, now });
    state = landingJobStates(queuePath).get(jobKey);
  }
  const exactRepairRequestKey = String(repairRequestKey || '');
  if (
    exactRepairRequestKey &&
    state?.repairRequestKey === exactRepairRequestKey &&
    !state.settled
  ) {
    return {
      enqueued: false,
      duplicate: true,
      repair: true,
      jobKey,
      clientToken: state.clientToken,
      repairGeneration: Number(state.repairGeneration || 0),
      repairRequestKey: exactRepairRequestKey,
      phase: state.launched ? 'launched' : 'queued',
    };
  }
  const generation = Math.max(0, Number(state?.repairGeneration || 0)) + 1;
  const clientToken = `otter-repair-${sha256(`${jobKey}\0${generation}`).slice(0, 51)}`;
  appendLandingEvent(queuePath, {
    type: 'repair_enqueued',
    at: timestamp(now),
    job_key: jobKey,
    client_token: clientToken,
    otid: String(otid),
    source_revision: String(sourceRevision),
    repair_generation: generation,
    repair_request_key: exactRepairRequestKey || null,
    reason: String(reason || 'exact_call_repair'),
  });
  return {
    enqueued: true,
    repair: true,
    jobKey,
    clientToken,
    repairGeneration: generation,
    repairRequestKey: exactRepairRequestKey || null,
  };
}

function deferStopsReconcile(reason) {
  return new Set([
    'active_task_lookup_failed',
    'deferred_capacity',
    'disabled',
    'missing_network_config',
    'registry_stage_failed',
    'run_task_failed',
    'trigger_threw',
  ]).has(reason);
}

function reconcileLandingEventQueue({
  queuePath = defaultLandingQueuePath(),
  launchFn,
  terminalFn,
  now = new Date(),
  retryMs = DEFAULT_RETRY_MS,
  maxLaunches = Number.parseInt(process.env.VOICE_FARGATE_LAUNCH_BATCH_MAX || '10', 10),
  allowedOtids,
} = {}) {
  if (typeof launchFn !== 'function') {
    ({ launchVoiceTask: launchFn } = require('./voice-fargate-trigger'));
  }
  if (typeof terminalFn !== 'function') {
    const ledger = readJson(defaultCallProcessingLedgerPath(queuePath), null);
    terminalFn = (job) => terminalLandingDisposition(job, ledger);
  }
  const nowIso = timestamp(now);
  const nowMs = new Date(nowIso).getTime();
  const pending = pendingLandingJobs(queuePath);
  const allowedOtidSet = Array.isArray(allowedOtids)
    ? new Set(allowedOtids.map((value) => String(value || '').trim()).filter(Boolean))
    : null;
  const scopedPending = allowedOtidSet
    ? pending.filter((job) => allowedOtidSet.has(String(job.otid || '')))
    : pending;
  const candidates = scopedPending.filter(
    (job) => !job.nextAttemptAt || new Date(job.nextAttemptAt).getTime() <= nowMs,
  );
  const outcomes = [];
  let launched = 0;
  let deferred = 0;
  let settled = 0;
  const launchLimit =
    Number.isFinite(Number(maxLaunches)) && Number(maxLaunches) > 0
      ? Math.floor(Number(maxLaunches))
      : 4;

  for (const job of candidates) {
    const terminal = terminalFn(job);
    if (terminal?.terminal === true) {
      appendLandingEvent(queuePath, {
        type: 'terminal_skipped',
        at: nowIso,
        job_key: job.jobKey,
        client_token: job.clientToken,
        otid: job.otid,
        source_revision: job.sourceRevision,
        reason: terminal.reason || 'terminal_revision',
        closed_revision: terminal.closedRevision || null,
      });
      settled += 1;
      outcomes.push({
        jobKey: job.jobKey,
        otid: job.otid,
        launched: false,
        settled: true,
        reason: terminal.reason || 'terminal_revision',
      });
      continue;
    }
    if (launched >= launchLimit) continue;
    appendLandingEvent(queuePath, {
      type: 'launch_attempted',
      at: nowIso,
      job_key: job.jobKey,
      client_token: job.clientToken,
      otid: job.otid,
      source_revision: job.sourceRevision,
    });
    let result;
    try {
      result = launchFn([job.otid], {
        reason: 'otter-call-landing-queue',
        idempotencyKey: job.clientToken,
        sourceRevision: job.sourceRevision,
      });
    } catch (error) {
      result = { launched: false, reason: 'trigger_threw', detail: error.message };
    }
    if (result && result.launched === true) {
      appendLandingEvent(queuePath, {
        type: 'launched',
        at: nowIso,
        job_key: job.jobKey,
        client_token: job.clientToken,
        otid: job.otid,
        source_revision: job.sourceRevision,
        task_arn: result.taskArn || null,
      });
      launched += 1;
      outcomes.push({ jobKey: job.jobKey, otid: job.otid, launched: true });
      continue;
    }

    const reason = result?.reason || 'launch_refused';
    appendLandingEvent(queuePath, {
      type: 'launch_deferred',
      at: nowIso,
      job_key: job.jobKey,
      client_token: job.clientToken,
      otid: job.otid,
      source_revision: job.sourceRevision,
      reason,
      detail: result?.detail || null,
      active: result?.active == null ? null : result.active,
      next_attempt_at: new Date(nowMs + retryMs).toISOString(),
    });
    deferred += 1;
    outcomes.push({ jobKey: job.jobKey, otid: job.otid, launched: false, reason });
    if (deferStopsReconcile(reason)) break;
  }

  return {
    schema: 'otter_call_landing_reconcile.v1',
    at: nowIso,
    launched,
    deferred,
    settled,
    pending: pendingLandingJobs(queuePath).length,
    skippedOutsideScope: allowedOtidSet ? pending.length - scopedPending.length : 0,
    outcomes,
  };
}

module.exports = {
  QUEUE_SCHEMA,
  appendLandingEvent,
  defaultCallProcessingLedgerPath,
  defaultLandingQueuePath,
  enqueueLandingEvent,
  enqueueRepairEvent,
  expiredClientToken,
  landingJobIdentity,
  landingJobStates,
  pendingLandingJobs,
  readLandingEvents,
  reconcileLandingEventQueue,
  terminalLandingDisposition,
  sourceRevisionForSpeech,
  sourceRevisionForRawBytes,
};
