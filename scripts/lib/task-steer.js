'use strict';

// Owner steer: a change of plan for work the spine already owns.
//
// A phone call or Telegram turn that says "do it this way instead" or "stop
// that" must reach the Task that is already running, not start a second one.
// Each steer is appended to a per-task ledger. The attempt runner watches the
// ledger and interrupts the live attempt; the worker folds every steer into the
// next attempt's prompt. The ledger feeds the Task, it is not a second store:
// queued and blocked Tasks are patched here directly.

const fs = require('fs');
const path = require('path');

const OWNER_DISPATCH_ORIGINS = new Set(['voice', 'vapi', 'telegram']);
const STEERABLE_STATUSES = new Set(['queued', 'running', 'blocked']);
const RELEASE_PHASES = new Set(['releasing', 'land_retry', 'landed', 'post_deploy_closure']);
const STEER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const STOP_WORDS = new Set(
  'the a an and or to of for in on it that this with my me i you is be do did was not no so then now instead please amy task one thing make'.split(
    ' ',
  ),
);

function dataDir(opts = {}) {
  return (
    opts.dataDir ||
    process.env.SECONDBRAIN_DATA_DIR ||
    (process.platform === 'linux' ? '/opt/secondbrain/data' : path.join(process.cwd(), 'data'))
  );
}

function tasksDir(opts = {}) {
  return opts.tasksDir || process.env.SECONDBRAIN_SPINE_TASKS_DIR || path.join(dataDir(opts), 'tasks');
}

function steerLedgerPath(taskId, opts = {}) {
  const safe = String(taskId || '').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(dataDir(opts), 'agent', 'task-steer', `${safe}.jsonl`);
}

// Settlement barrier. A steer (read Task, append row) and the worker's final
// decision (read rows, mark the Task as releasing) each run under this
// exclusive lock, so a steer is either seen by the worker or refused; it can
// never be acknowledged and then lost between the two. The wait is short and
// bounded; a caller that cannot get the lock fails closed.
function withSteerLock(taskId, fn, opts = {}) {
  const lock = `${steerLedgerPath(taskId, opts)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + (opts.lockWaitMs == null ? 500 : opts.lockWaitMs);
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx');
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.unlinkSync(lock);
      } catch {
        /* holder released it */
      }
      if (Date.now() >= deadline) return { locked: false };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  try {
    return { locked: true, value: fn() };
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(lock);
    } catch {
      /* already released */
    }
  }
}

function readSteers(taskId, opts = {}) {
  try {
    return fs
      .readFileSync(steerLedgerPath(taskId, opts), 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function readTaskFile(taskId, opts = {}) {
  try {
    return JSON.parse(fs.readFileSync(path.join(tasksDir(opts), `${taskId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function listTasks(opts = {}) {
  let names = [];
  try {
    names = fs.readdirSync(tasksDir(opts)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(tasksDir(opts), name), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeTaskAtomic(task, opts = {}) {
  const file = path.join(tasksDir(opts), `${task.id}.json`);
  const tmp = `${file}.${process.pid}.${Date.now()}.steer.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
  fs.renameSync(tmp, file);
}

function isOwnerDispatchTask(task) {
  return Boolean(
    task &&
      OWNER_DISPATCH_ORIGINS.has(String(task.origin || '').toLowerCase()) &&
      // Only supervised coding Tasks have a runner that can honor a steer. Other
      // kinds are not steerable, so a change of plan is never acknowledged and
      // then ignored.
      String(task.kind || '').toLowerCase() === 'coding',
  );
}

function isSelfTestTask(task) {
  return task?.meta?.selfTest === true;
}

function words(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

function describe(task, nowMs) {
  const last = Date.parse(task.updatedAt || task.createdAt || '') || nowMs;
  return {
    id: task.id,
    title: String(task.title || task.prompt || '').replace(/\s+/g, ' ').slice(0, 100),
    status: task.status,
    origin: task.origin,
    minutesSinceUpdate: Math.max(0, Math.round((nowMs - last) / 60000)),
  };
}

// Choose the Task a steer applies to. An exact or suffix id wins. Otherwise the
// caller's words are matched against each open owner-dispatched Task; one clear
// best match wins, then a single running Task, then a single open Task. When it
// is still unclear the candidates come back so Amy can ask with discriminators.
function selectSteerTarget({ taskId = '', hint = '', selfTest = false } = {}, opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const all = opts.tasks || listTasks(opts);
  const wanted = String(taskId || '').trim();
  if (wanted) {
    // An explicit id is exact or nothing. It never falls back to another Task.
    const match = all.filter((task) => task.id === wanted || String(task.id).endsWith(wanted));
    if (match.length === 1 && isOwnerDispatchTask(match[0]) && isSelfTestTask(match[0]) === selfTest) {
      return { task: match[0], by: 'id' };
    }
    return { task: null, notFound: true };
  }
  const open = all.filter((task) => {
    if (!isOwnerDispatchTask(task) || isSelfTestTask(task) !== selfTest) return false;
    const last = Date.parse(task.updatedAt || task.createdAt || '') || 0;
    return nowMs - last <= STEER_WINDOW_MS && STEERABLE_STATUSES.has(String(task.status || ''));
  });
  if (!open.length) {
    const shipped = all
      .filter(
        (task) =>
          isOwnerDispatchTask(task) &&
          isSelfTestTask(task) === selfTest &&
          ['deploying', 'done', 'awaiting-review'].includes(String(task.status || '')) &&
          nowMs - (Date.parse(task.updatedAt || '') || 0) <= 24 * 60 * 60 * 1000,
      )
      .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''));
    return { task: null, none: true, recentlyShipped: shipped.slice(0, 3).map((t) => describe(t, nowMs)) };
  }
  const hintWords = new Set(words(hint));
  if (hintWords.size) {
    const scored = open
      .map((task) => {
        const taskWords = new Set(words(`${task.title || ''} ${task.prompt || ''}`));
        let score = 0;
        for (const word of hintWords) if (taskWords.has(word)) score += 1;
        return { task, score };
      })
      .sort((a, b) => b.score - a.score);
    if (scored[0].score > 0 && (scored.length === 1 || scored[0].score > scored[1].score)) {
      return { task: scored[0].task, by: 'topic' };
    }
  }
  if (open.length === 1) return { task: open[0], by: 'only-open' };
  const running = open.filter((task) => task.status === 'running');
  if (running.length === 1) return { task: running[0], by: 'only-running' };
  return {
    task: null,
    ambiguous: true,
    candidates: open
      .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))
      .slice(0, 5)
      .map((task) => describe(task, nowMs)),
  };
}

// Record the steer and, when no attempt is live, apply it to the Task now.
function applySteer(taskId, steer = {}, opts = {}) {
  const held = withSteerLock(taskId, () => applySteerLocked(taskId, steer, opts), opts);
  if (!held.locked) {
    return { ok: false, reason: 'busy', status: 'busy for a moment', task: readTaskFile(taskId, opts) };
  }
  return held.value;
}

function applySteerLocked(taskId, { action = 'amend', text = '', source = '', sourceRef = '' } = {}, opts = {}) {
  const kind = action === 'cancel' ? 'cancel' : 'amend';
  const instruction = String(text || '').trim().slice(0, 4000);
  if (kind === 'amend' && !instruction) throw new Error('applySteer amend requires the new instruction');
  const task = readTaskFile(taskId, opts);
  if (!task) throw new Error(`applySteer: task ${taskId} not found`);
  if (!isOwnerDispatchTask(task) || !STEERABLE_STATUSES.has(String(task.status || ''))) {
    return { ok: false, reason: 'not-steerable', status: task.status, task };
  }
  // Once the worker has started committing and landing, no attempt is left to
  // interrupt. Refuse honestly instead of promising a change nobody will make.
  if (task.status === 'running' && RELEASE_PHASES.has(String(task.execution?.phase || ''))) {
    return { ok: false, reason: 'not-steerable', status: 'being released', task };
  }
  const ts = new Date(opts.nowMs || Date.now()).toISOString();
  const row = { ts, action: kind, text: instruction, source: String(source || ''), sourceRef: String(sourceRef || '') };
  const file = steerLedgerPath(taskId, opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');

  const leaseLive = task.lease && Date.parse(task.lease.expiresAt || '') > (opts.nowMs || Date.now());
  if (task.status === 'running' && leaseLive) {
    // The attempt runner sees the ledger grow and interrupts the live attempt.
    return { ok: true, applied: 'interrupting-live-attempt', row, task };
  }
  const note =
    kind === 'cancel' ? 'Owner cancelled this task.' : `Owner changed the plan: ${instruction.slice(0, 200)}`;
  const next = {
    ...task,
    updatedAt: ts,
    history: [...(task.history || []), { status: kind === 'cancel' ? 'cancelled' : 'steered', ts, note }],
  };
  if (kind === 'cancel') {
    next.status = 'cancelled';
    next.completedAt = ts;
    next.resultSummary = 'Cancelled at your request.';
    delete next.lease;
    delete next.nextAttemptAt;
    // The preserved attempt worktree is no longer needed by anyone.
    const resume = task.execution?.resumeWorktree;
    if (resume && resume.created === true) {
      try {
        (opts.discardWorktree || require('./codex-worktree.js').discardCodexWorktree)(resume);
      } catch {
        /* disk cleanup must never change the Task outcome */
      }
    }
  } else {
    next.status = 'queued';
    delete next.lease;
    delete next.nextAttemptAt;
    // Only a Task that had stopped as blocked reopens with a fresh attempt
    // budget and a fresh callback. Steering a queued Task keeps both, so
    // repeated steers cannot defeat the attempt budget.
    if (task.status === 'blocked') {
      next.retryable = true;
      next.attempts = 0;
    }
    if (task.status === 'blocked' && next.callback) {
      delete next.callback.deliveredAt;
      delete next.callback.deadLetterAt;
      delete next.callback.nextAttemptAt;
      delete next.callback.fallbackNotifiedAt;
      next.callback.attempts = [];
    }
  }
  writeTaskAtomic(next, opts);
  return { ok: true, applied: kind === 'cancel' ? 'cancelled' : 'requeued', row, task: next };
}

// The block appended to an attempt prompt. Later steers override earlier ones.
function steerPromptBlock(rows = []) {
  const amends = rows.filter((row) => row.action === 'amend' && row.text);
  if (!amends.length) return '';
  return [
    '',
    'OWNER CHANGE OF PLAN. ExampleCo updated this request after it started. Apply these in order; where they conflict with the original request or with each other, the latest one wins:',
    ...amends.map((row, index) => `${index + 1}. (${row.ts}) ${row.text}`),
  ].join('\n');
}

// A cancel is terminal for its Task. Any cancel row means stop, whatever
// order it arrived in relative to amends the runner already acted on.
function hasCancel(rows = []) {
  return rows.some((row) => row && row.action === 'cancel');
}

function latestSteerAction(rows = []) {
  return rows.length ? rows[rows.length - 1].action : null;
}

module.exports = {
  OWNER_DISPATCH_ORIGINS,
  STEERABLE_STATUSES,
  applySteer,
  hasCancel,
  isOwnerDispatchTask,
  isSelfTestTask,
  latestSteerAction,
  readSteers,
  selectSteerTarget,
  steerLedgerPath,
  steerPromptBlock,
  withSteerLock,
};
