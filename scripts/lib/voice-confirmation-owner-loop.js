'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createSpineTask, resolveTasksDir } = require('./spine-ingress.js');
const { transitionAmyProjectTaskFile } = require('./amy-project-task-state.js');

function safeRequestId(value) {
  const requestId = String(value || '').trim();
  if (!/^voice-people-sync-[a-f0-9]{16}$/i.test(requestId)) {
    throw new Error('invalid voice confirmation request id');
  }
  return requestId.toLowerCase();
}

function taskIdForVoiceConfirmation(requestId) {
  return `voice-confirmation-${safeRequestId(requestId).replace(/^voice-people-sync-/, '')}`;
}

function taskFileForRequest(requestId, opts = {}) {
  return path.join(resolveTasksDir(opts), `${taskIdForVoiceConfirmation(requestId)}.json`);
}

function writeJsonAtomic(file, value, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fsApi.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fsApi.renameSync(temporary, file);
}

function readVoiceConfirmationOwnerTask(requestId, opts = {}) {
  try {
    return JSON.parse((opts.fsApi || fs).readFileSync(taskFileForRequest(requestId, opts), 'utf8'));
  } catch {
    return null;
  }
}

// The lenient reader above answers null for a missing task AND for one that
// cannot be read or parsed. A caller that must not mistake "unreadable" for
// "no task" uses this one: null only when no task file exists (or the id
// cannot name one); an unreadable or malformed task file throws.
function readVoiceConfirmationOwnerTaskStrict(requestId, opts = {}) {
  let file;
  try {
    file = taskFileForRequest(requestId, opts);
  } catch {
    return null;
  }
  let text;
  try {
    text = (opts.fsApi || fs).readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  const task = JSON.parse(text);
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new Error(`voice confirmation Task Spine item is malformed: ${requestId}`);
  }
  return task;
}

function actionLabel(record = {}) {
  const guessed = String(record.guessedName || record.guessed_name || '').trim();
  const corrected = String(record.correctedName || record.corrected_name || '').trim();
  const labels = {
    confirm: `confirm this voice as ${guessed || 'the selected person'}`,
    correct: `correct this voice to ${corrected || 'the typed person'}`,
    not_them: `record that this voice is not ${guessed || 'the suggested person'}`,
    dont_know: 'leave this voice explicitly unknown',
    non_speech: 'record this sample as non-speech',
  };
  return labels[String(record.action || '')] || `apply ${String(record.action || 'the decision')}`;
}

function startVoiceConfirmationOwnerTask(record = {}, requestId, opts = {}) {
  const cleanRequestId = safeRequestId(requestId);
  const taskId = taskIdForVoiceConfirmation(cleanRequestId);
  const voiceClusterId = String(record.voiceClusterId || record.voice_cluster_id || '').trim();
  const label = actionLabel(record);
  return createSpineTask(
    {
      id: taskId,
      kind: 'coding',
      origin: 'briefing',
      status: 'blocked',
      approved: true,
      source: { type: 'voice-confirmation-owner-loop', ref: cleanRequestId },
      title: `Voice decision: ${label}`.slice(0, 100),
      prompt: [
        `ExampleCo clicked the briefing voice review to ${label}.`,
        `Exact request: ${cleanRequestId}. Exact voice: ${voiceClusterId}.`,
        'The deterministic exact-action worker owns the first pass. Do not run a whole-archive voice audit.',
        'If that pass reports a defect, diagnose and fix only the failed action path, replay this exact request, and return the concrete People or identity change with live proof.',
        'Leave the result awaiting ExampleCo review. ExampleCo can acknowledge it or send written feedback through the same Task Spine item.',
      ].join('\n'),
      resultSummary: 'Decision accepted. The exact voice worker is applying it now.',
      meta: {
        explicitRequest: true,
        ownerVerified: true,
        systemOwnedUntilReview: true,
        voiceConfirmationRequestId: cleanRequestId,
        voiceClusterId,
        action: String(record.action || ''),
        guessedName: String(record.guessedName || ''),
        correctedName: String(record.correctedName || ''),
      },
    },
    opts,
  );
}

function updateOwnerTask(requestId, mutate, opts = {}) {
  const task = readVoiceConfirmationOwnerTask(requestId, opts);
  if (!task) throw new Error(`voice confirmation Task Spine item is missing: ${requestId}`);
  const next = mutate({ ...task, history: Array.isArray(task.history) ? [...task.history] : [] });
  writeJsonAtomic(taskFileForRequest(requestId, opts), next, opts.fsApi || fs);
  return next;
}

function markVoiceConfirmationAwaitingReview(requestId, summary, opts = {}) {
  const ts = (opts.now || (() => new Date()))().toISOString();
  return updateOwnerTask(
    requestId,
    (task) => {
      task.status = 'awaiting-review';
      task.updatedAt = ts;
      task.resultSummary = String(summary || 'The voice decision was applied and is ready for review.');
      task.history.push({ status: 'awaiting-review', ts, note: task.resultSummary });
      delete task.completedAt;
      delete task.lease;
      delete task.nextAttemptAt;
      return task;
    },
    opts,
  );
}

function queueVoiceConfirmationRepair(requestId, failure, opts = {}) {
  const ts = (opts.now || (() => new Date()))().toISOString();
  return updateOwnerTask(
    requestId,
    (task) => {
      const reason = String(failure || 'the exact voice action did not produce terminal proof').slice(0, 1800);
      task.status = 'queued';
      task.updatedAt = ts;
      task.resultSummary = `Amy found a defect while applying this voice decision: ${reason}`;
      task.prompt = `${task.prompt}\n\nCURRENT FAILURE TO REPAIR\n${reason}\nRepair the exact action path, replay only ${requestId}, deploy through the canonical release path, and project the result back to this task and the briefing review page.`;
      task.history.push({ status: 'queued', ts, note: 'Exact deterministic pass failed; queued through the existing cloud coding loop.' });
      delete task.completedAt;
      delete task.lease;
      delete task.nextAttemptAt;
      return task;
    },
    opts,
  );
}

function transitionVoiceConfirmationOwnerTask(requestId, action, comment = '', opts = {}) {
  const task = readVoiceConfirmationOwnerTask(requestId, opts);
  if (!task || task.meta?.voiceConfirmationRequestId !== safeRequestId(requestId)) {
    throw new Error('voice confirmation Task Spine item not found');
  }
  return transitionAmyProjectTaskFile({
    file: taskFileForRequest(requestId, opts),
    expectedId: task.id,
    action,
    comment,
    allowedTaskDirs: [resolveTasksDir(opts)],
    now: opts.now,
  });
}

module.exports = {
  actionLabel,
  markVoiceConfirmationAwaitingReview,
  queueVoiceConfirmationRepair,
  readVoiceConfirmationOwnerTask,
  readVoiceConfirmationOwnerTaskStrict,
  safeRequestId,
  startVoiceConfirmationOwnerTask,
  taskFileForRequest,
  taskIdForVoiceConfirmation,
  transitionVoiceConfirmationOwnerTask,
};
