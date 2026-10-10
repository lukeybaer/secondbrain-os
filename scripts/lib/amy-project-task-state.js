'use strict';

const fs = require('fs');
const path = require('path');

const DONE_ELIGIBLE_STATUSES = new Set([
  'queued',
  'running',
  'awaiting-review',
  'requires-feedback',
  'failed',
  'blocked',
]);
const FEEDBACK_ELIGIBLE_STATUSES = new Set([...DONE_ELIGIBLE_STATUSES, 'done']);

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function assertTaskFile(file, expectedId, allowedTaskDirs = []) {
  if (!file || path.extname(file).toLowerCase() !== '.json') {
    throw new Error('Amy project task path is not a JSON task record');
  }
  const resolvedFile = fs.realpathSync(file);
  const allowed = allowedTaskDirs
    .filter(Boolean)
    .filter((dir) => fs.existsSync(dir))
    .map((dir) => fs.realpathSync(dir));
  if (!allowed.some((dir) => path.dirname(resolvedFile) === dir)) {
    throw new Error('Amy project task path is outside the Task Spine');
  }
  const task = JSON.parse(fs.readFileSync(resolvedFile, 'utf8'));
  if (!task || String(task.id || '') !== String(expectedId || '')) {
    throw new Error('Amy project task identity changed before mutation');
  }
  return { resolvedFile, task };
}

function transitionAmyProjectTaskFile({
  file,
  expectedId,
  action,
  comment,
  allowedTaskDirs,
  now = () => new Date(),
}) {
  const { resolvedFile, task } = assertTaskFile(file, expectedId, allowedTaskDirs);
  const from = String(task.status || 'queued');
  const ts = now().toISOString();
  let to;

  if (action === 'done') {
    if (from === 'done') return { changed: false, from, to: from };
    if (!DONE_ELIGIBLE_STATUSES.has(from)) {
      throw new Error(`Amy project cannot transition from ${from} to done`);
    }
    to = 'done';
  } else if (action === 'reopen') {
    if (from === 'awaiting-review') return { changed: false, from, to: from };
    if (from !== 'done') {
      throw new Error(`Amy project cannot transition from ${from} to awaiting-review`);
    }
    to = 'awaiting-review';
  } else if (action === 'feedback') {
    const feedback = String(comment || '').replace(/\s+/g, ' ').trim();
    if (!feedback) throw new Error('Amy project feedback comment is required');
    if (feedback.length > 2000) throw new Error('Amy project feedback comment is too long');
    if (!FEEDBACK_ELIGIBLE_STATUSES.has(from)) {
      throw new Error(`Amy project cannot transition from ${from} to requires-feedback`);
    }
    to = 'requires-feedback';
  } else {
    throw new Error(`Unsupported Amy project action: ${action}`);
  }

  const next = {
    ...task,
    status: to,
    updatedAt: ts,
    history: [
      ...(Array.isArray(task.history) ? task.history : []),
      {
        status: to,
        ts,
        note:
          action === 'done'
            ? 'Marked done by ExampleCo from the briefing dashboard'
            : action === 'reopen'
              ? 'Reopened by ExampleCo from the briefing dashboard'
              : `ExampleCo sent feedback from the briefing dashboard: ${String(comment).replace(/\s+/g, ' ').trim()}`,
      },
    ],
  };

  if (action === 'done') {
    next.completedAt = ts;
    delete next.feedbackRequest;
    delete next.lease;
    delete next.nextAttemptAt;
  } else {
    delete next.completedAt;
    if (action === 'reopen') {
      delete next.feedbackRequest;
    } else if (action === 'feedback') {
      next.feedbackRequest = {
        comment: String(comment).replace(/\s+/g, ' ').trim(),
        requestedAt: ts,
        source: 'briefing-dashboard',
      };
      delete next.lease;
      delete next.nextAttemptAt;
    }
  }

  writeJsonAtomic(resolvedFile, next);
  return { changed: true, from, to, task: next };
}

module.exports = {
  DONE_ELIGIBLE_STATUSES,
  FEEDBACK_ELIGIBLE_STATUSES,
  transitionAmyProjectTaskFile,
};
