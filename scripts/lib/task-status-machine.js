'use strict';

// The one declaration of Task status for JS writers (state machine audit,
// Owner decision, findings 15, 16 and part of 25). `src/main/task-store.ts`
// is the authority; this is its twin, and
// `scripts/__tests__/task-status-machine-parity.test.js` reads the TS file and
// fails when the two disagree.
//
// What it answers:
// - Status was free text written in about ten places. Every state and legal move
//   is declared here, old spellings map through ALIASES, and writeTaskGuarded
//   refuses an off-list value or an illegal move instead of writing it.
// - A stale writer replaced a newer record. writeTaskGuarded takes the task
//   file's lock, and a caller that read the Task earlier passes `expected` so the
//   write is a compare-and-swap on status and updatedAt.
// - Leaving `done` has one rule: no automatic writer may. An explicit owner
//   action (dashboard reopen or feedback) is the only way out, and passes
//   `owner: true` against OWNER_MOVES.

const path = require('path');
const {
  IllegalTransitionError,
  defineStateMachine,
  readJsonStrict,
  withFileLock,
} = require('./ledger-state-machine');
const { writeJsonAtomicRetry } = require('./write-json-atomic-retry');

const TERMINAL_STATUSES = Object.freeze(['done', 'cancelled', 'removed_non_actionable']);

// Moves the system itself makes. Mirrors LEGAL_TRANSITIONS in task-store.ts.
// '' is a Task file that does not exist yet (creation).
const TRANSITIONS = Object.freeze({
  '': [
    'queued',
    'running',
    'awaiting-review',
    'requires-feedback',
    'blocked',
    'done',
    'failed',
    'cancelled',
    'removed_non_actionable',
  ],
  queued: ['running', 'cancelled', 'failed', 'removed_non_actionable', 'awaiting-review', 'archived'],
  running: [
    'awaiting-review',
    'requires-feedback',
    'done',
    'failed',
    'cancelled',
    'removed_non_actionable',
    'queued', // retry after a failed attempt, or a steer on a lease-expired run
    'blocked', // attempt budget used, or a stop that is not retryable
    'deploying', // guarded land passed, release in flight
    'archived',
  ],
  deploying: ['queued', 'blocked', 'done', 'failed', 'cancelled'],
  'awaiting-review': [
    'running',
    'requires-feedback',
    'done',
    'failed',
    'cancelled',
    'removed_non_actionable',
    'queued', // a steer reopens unlanded work
    'archived',
  ],
  'requires-feedback': ['queued', 'running', 'failed', 'cancelled', 'removed_non_actionable'],
  // Parked, waiting on a reopen. Only these exits: a steer or retry requeues
  // it, a card-closure release claims it, an owner or reconcile closes it.
  blocked: ['queued', 'running', 'awaiting-review', 'failed', 'cancelled', 'removed_non_actionable'],
  failed: ['queued', 'removed_non_actionable'], // retry re-queues the task
  // Restore after an archive sweep is rolled back.
  archived: ['queued', 'running', 'awaiting-review', 'removed_non_actionable'],
  done: [],
  cancelled: [],
  removed_non_actionable: [],
});

// Moves only an explicit owner action may make (a dashboard button or a spoken
// "mark it done"). This is the single declared way out of `done`.
const OWNER_MOVES = Object.freeze({
  queued: ['done', 'requires-feedback'],
  running: ['requires-feedback'],
  'awaiting-review': ['requires-feedback'],
  'requires-feedback': ['done'],
  failed: ['done', 'requires-feedback'],
  blocked: ['done', 'requires-feedback'],
  done: ['awaiting-review', 'requires-feedback', 'queued'],
});
const OWNER_REOPEN_FROM_DONE = Object.freeze(['awaiting-review', 'requires-feedback', 'queued']);

// Spellings already on disk or in older writers. A writer that uses one is
// written back canonical.
const ALIASES = Object.freeze({
  completed: 'done',
  complete: 'done',
  in_progress: 'running',
  'in-progress': 'running',
  canceled: 'cancelled',
  awaiting_review: 'awaiting-review',
  requires_feedback: 'requires-feedback',
  'needs-feedback': 'requires-feedback',
  needs_feedback: 'requires-feedback',
  'awaiting-input': 'requires-feedback',
  awaiting_input: 'requires-feedback',
});

// A lease that expires on a `running` Task spends an attempt. Past the budget
// the Task parks as `blocked` with a reason and is never reclaimed again.
const DEFAULT_RECLAIM_BUDGET = 3;

const machine = defineStateMachine({
  name: 'task-status',
  transitions: TRANSITIONS,
  terminal: TERMINAL_STATUSES,
  aliases: ALIASES,
  inFlight: { running: { maxAttempts: DEFAULT_RECLAIM_BUDGET }, deploying: {} },
});

const STATUSES = Object.freeze(machine.states.filter(Boolean));

function normalizeStatus(value) {
  return machine.normalize(value);
}

function isKnownStatus(value) {
  const status = machine.normalize(value);
  return status !== '' && STATUSES.includes(status);
}

function isTerminalStatus(value) {
  return machine.isTerminal(value);
}

/** True when from -> to is a declared move. Staying in the same state is always fine. */
function canMove(from, to, { owner = false } = {}) {
  const f = machine.normalize(from);
  const t = machine.normalize(to);
  if (!isKnownStatus(t)) return false;
  if (f === t) return true;
  if (machine.canTransition(f, t)) return true;
  return owner === true && (OWNER_MOVES[f] || []).includes(t);
}

/** Returns the canonical target, or throws IllegalTransitionError. */
function assertMove(from, to, opts = {}) {
  if (!canMove(from, to, opts)) {
    throw new IllegalTransitionError(machine.name, machine.normalize(from) || null, machine.normalize(to));
  }
  return machine.normalize(to);
}

function reclaimBudget(task) {
  const declared = Number(task?.meta?.maxAttempts);
  return Number.isSafeInteger(declared) && declared > 0 ? declared : DEFAULT_RECLAIM_BUDGET;
}

function sameVersion(current, expected) {
  return (
    machine.normalize(current?.status) === machine.normalize(expected?.status) &&
    String(current?.updatedAt || '') === String(expected?.updatedAt || '')
  );
}

/**
 * Write one Task file under its lock, validated against the declared moves.
 *
 * opts.expected  the Task the caller read before computing `next`. When the file
 *                no longer matches its status and updatedAt, nothing is written
 *                and the result is { ok: false, reason: 'stale', current }.
 * opts.owner     an explicit owner action; allows OWNER_MOVES.
 * opts.write     the caller's atomic writer, write(file, task).
 *
 * Throws IllegalTransitionError for an off-list value or an illegal move.
 */
// The ledger lock keeps a `<key>.locks/` folder beside its key for good. Task
// files share one directory that the stores list, so the key lives in a sibling
// `<tasks dir>.locks/` instead; every writer of one Task resolves the same key.
function taskLockKey(file) {
  const resolved = path.resolve(file);
  return path.join(`${path.dirname(resolved)}.locks`, path.basename(resolved));
}

function writeTaskGuarded(file, next, { expected = null, owner = false, write = writeJsonAtomicRetry } = {}) {
  return withFileLock(taskLockKey(file), () => {
    const current = readJsonStrict(file, null);
    if (expected && !sameVersion(current, expected)) return { ok: false, reason: 'stale', current };
    const from = current ? current.status : '';
    const status = assertMove(from, next.status, { owner });
    if (next.status !== status) next.status = status;
    write(file, next);
    return { ok: true, task: next, from: machine.normalize(from) };
  });
}

module.exports = {
  ALIASES,
  DEFAULT_RECLAIM_BUDGET,
  IllegalTransitionError,
  OWNER_MOVES,
  OWNER_REOPEN_FROM_DONE,
  STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  assertMove,
  canMove,
  isKnownStatus,
  taskLockKey,
  isTerminalStatus,
  normalizeStatus,
  reclaimBudget,
  writeTaskGuarded,
};
