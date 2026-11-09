'use strict';

// Declared states for the recorder call pipeline (state machine audit #19, the owner,
// 2026-11-03). One module owns the words so every reader and writer of the
// call-processing ledger and the healer jobs file agrees on them, and so an
// illegal move or a wait that never ends is refused instead of being written.
//
// The handoff states live next to their writer in otter-call-healer-handoff.js
// (HANDOFF_MACHINE) because that file is pinned by the drift lint.

const { defineStateMachine } = require('./ledger-state-machine');
const { MAX_CYCLES } = require('./otter-call-processing-cycles');

const hours = (n) => n * 60 * 60 * 1000;
const envMs = (name, fallbackMs, floorMs) =>
  Math.max(floorMs, Number(process.env[name] || fallbackMs));

// ---- Ledger stage status ----------------------------------------------------
// A finished stage (complete, not required, or a recorded terminal disposition)
// never goes back to open or failed just because a slower writer saw older
// evidence. Reopening is a fresh evaluation, never a stale write.
const FINISHED_STAGE_STATES = Object.freeze(['complete', 'not_required', 'terminal_disposition']);
const UNFINISHED_STAGE_STATES = Object.freeze(['failed', 'open', 'waiting']);

const LEDGER_STAGE_MACHINE = defineStateMachine({
  name: 'otter-call-ledger-stage',
  transitions: {
    '': [...FINISHED_STAGE_STATES, ...UNFINISHED_STAGE_STATES],
    ...Object.fromEntries(
      UNFINISHED_STAGE_STATES.map((state) => [
        state,
        [...FINISHED_STAGE_STATES, ...UNFINISHED_STAGE_STATES],
      ]),
    ),
    ...Object.fromEntries(FINISHED_STAGE_STATES.map((state) => [state, [...FINISHED_STAGE_STATES]])),
  },
});

function stageIsFinished(status) {
  return FINISHED_STAGE_STATES.includes(LEDGER_STAGE_MACHINE.normalize(status));
}

// ---- Healer job status ------------------------------------------------------
// A job row that waits for capacity or a retry must not wait forever. Past its
// TTL (or, for retries, the cycle ceiling) it ends in a named expired state that
// health reports while the call is still open.
const CAPACITY_WAIT_TTL_MS = envMs('OTTER_CALL_HEALER_CAPACITY_WAIT_TTL_MS', hours(4), 15 * 60 * 1000);
const RETRY_WAIT_TTL_MS = envMs('OTTER_CALL_HEALER_RETRY_WAIT_TTL_MS', hours(6), 15 * 60 * 1000);
const WAIT_EXPIRED_STATES = Object.freeze([
  'capacity_wait_expired',
  'retry_wait_expired',
  'retry_budget_exhausted',
]);
const WAITING_JOB_STATES = Object.freeze(['capacity_wait', 'retry_wait']);

const HEALER_JOB_MACHINE = defineStateMachine({
  name: 'otter-call-healer-job',
  transitions: {
    '': ['running'],
    running: [
      'capacity_wait',
      'retry_wait',
      'awaiting_async',
      'closed',
      'handed_back',
      'superseded_input_changed',
      'stale_worker_crashed',
    ],
    capacity_wait: ['running', 'capacity_wait_expired', 'superseded_input_changed'],
    retry_wait: [
      'running',
      'retry_wait_expired',
      'retry_budget_exhausted',
      'superseded_input_changed',
    ],
    awaiting_async: ['running', 'closed', 'handed_back', 'superseded_input_changed'],
    // The job id is the repair fingerprint, so a later attempt reuses the row.
    closed: ['running'],
    handed_back: ['running'],
    superseded_input_changed: ['running'],
    stale_worker_crashed: ['running'],
    capacity_wait_expired: ['running'],
    retry_wait_expired: ['running'],
    retry_budget_exhausted: ['running'],
  },
  inFlight: {
    capacity_wait: { ttlMs: CAPACITY_WAIT_TTL_MS },
    retry_wait: { ttlMs: RETRY_WAIT_TTL_MS, maxAttempts: MAX_CYCLES },
  },
});

module.exports = {
  CAPACITY_WAIT_TTL_MS,
  FINISHED_STAGE_STATES,
  HEALER_JOB_MACHINE,
  LEDGER_STAGE_MACHINE,
  RETRY_WAIT_TTL_MS,
  UNFINISHED_STAGE_STATES,
  WAITING_JOB_STATES,
  WAIT_EXPIRED_STATES,
  stageIsFinished,
};
