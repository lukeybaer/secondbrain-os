'use strict';

// Healer deploy states, declared once (state machine audit findings #12 and
// #13, Owner decision, https://claude.ai/artifact/8wKEsESFcNyAEzGz1CJEFC).
//
// The audit found `phase` doing four jobs with no declaration. Readers tested
// `batch.phase === 'proving'` in five places while only rows were ever written
// `proving`; a batch was marked `complete` while a proof had failed; and the
// controller's pending-repair list missed `deployed_pending_proof`, which the
// deploy coordinator and executor both write. Every writer and reader of these
// states now imports this file.
//
//   REPAIR  repairState on a healer integration row and on a deploy result.
//   BATCH   a coordinator batch file (batches/*.json).
//   ROW     a coordinator inbox row (inbox/*.json), one per waiter.
//   JOURNAL the single-process executor's active-batch.json.
//   JOURNAL_ROW  the waiter rows inside that journal.
//   DELIVERY_WINDOW  computed from the clock, never stored.
//
// `recovery-wait` is a marker resetRolledBackBatch returns in memory; it is
// never written, so it is deliberately not a BATCH state.

const { defineStateMachine } = require('./ledger-state-machine');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const REPAIR_STATE = Object.freeze({
  PENDING_LAND: 'repaired_pending_land',
  PENDING_DEPLOY: 'repaired_pending_deploy',
  PENDING_PROOF: 'deployed_pending_proof',
  BLOCKED: 'integration_blocked',
  // The proof budget ran out. Handed to a human; the controller stops owning it.
  PROOF_ESCALATED: 'proof_escalated',
});

const repairMachine = defineStateMachine({
  name: 'healer-repair-state',
  transitions: {
    '': [
      REPAIR_STATE.PENDING_LAND,
      REPAIR_STATE.PENDING_DEPLOY,
      REPAIR_STATE.PENDING_PROOF,
      REPAIR_STATE.BLOCKED,
    ],
    [REPAIR_STATE.PENDING_LAND]: [
      REPAIR_STATE.PENDING_DEPLOY,
      REPAIR_STATE.PENDING_PROOF,
      REPAIR_STATE.BLOCKED,
    ],
    [REPAIR_STATE.PENDING_DEPLOY]: [
      REPAIR_STATE.PENDING_PROOF,
      REPAIR_STATE.BLOCKED,
    ],
    [REPAIR_STATE.PENDING_PROOF]: [REPAIR_STATE.PENDING_DEPLOY, REPAIR_STATE.PROOF_ESCALATED],
    [REPAIR_STATE.BLOCKED]: [
      REPAIR_STATE.PENDING_LAND,
      REPAIR_STATE.PENDING_DEPLOY,
      REPAIR_STATE.PENDING_PROOF,
    ],
  },
  terminal: [REPAIR_STATE.PROOF_ESCALATED],
  // The batch and row phase spelling the coordinator also writes.
  aliases: { 'deployed-pending-proof': REPAIR_STATE.PENDING_PROOF },
});

const RESUME_STAGES = Object.freeze(
  new Set(['land', 'deploy', 'proof', 'live-proof', 'authority', 'release-closure-receipt']),
);

function normalizeRepairState(value) {
  return repairMachine.normalize(String(value || '').toLowerCase());
}

// Repair states a healer still owns: the repair landed or deployed but is not
// proven live. A proof_escalated state is terminal, so it is not in this set.
function isPendingRepairState(value) {
  const state = normalizeRepairState(value);
  return state !== '' && repairMachine.isKnown(state) && !repairMachine.isTerminal(state);
}

// True while an integration row still owes the controller a land, a deploy or a
// live proof. One definition for the controller, the driver and the writers.
function isPendingIntegrationRow(row) {
  if (!row || typeof row !== 'object') return false;
  const state = normalizeRepairState(row.repairState);
  if (repairMachine.isTerminal(state)) return false;
  if (isPendingRepairState(state)) return true;
  return (
    row.ok !== true && RESUME_STAGES.has(String(row.resumeStage || '').trim().toLowerCase())
  );
}

const WAITING_PROOF_BUDGET = Object.freeze({
  // A deployed repair that keeps failing its live proof stops being retried and
  // goes to a human. Eight matches the healer's own per-unit cycle ceiling.
  maxAttempts: 8,
  ttlMs: 12 * HOUR,
});

const batchMachine = defineStateMachine({
  name: 'healer-deploy-batch',
  transitions: {
    '': ['awaiting-deploy'],
    'awaiting-deploy': ['deployed', 'failed'],
    // deployed -> awaiting-deploy is the rolled-back release reset.
    deployed: ['awaiting-deploy', 'complete', 'proof-failed', 'escalated'],
    // Deploy is done and the batch is released so later deploys can proceed, but
    // at least one waiter's proof failed. Never `complete` until all of them prove.
    'proof-failed': ['complete', 'escalated'],
  },
  terminal: ['complete', 'failed', 'escalated'],
  // `proving` was read in five places and never written; it is the same step as
  // `deployed` (the row carries the proving phase).
  aliases: { proving: 'deployed' },
});

const rowMachine = defineStateMachine({
  name: 'healer-deploy-row',
  transitions: {
    '': ['admitted', 'batched', 'deployed-pending-proof'],
    admitted: ['batched'],
    batched: ['deployed-pending-proof', 'settled-failure'],
    'deployed-pending-proof': ['proving', 'batched', 'escalated'],
    proving: ['proved', 'deployed-pending-proof', 'batched', 'escalated'],
    // A rolled-back release voids a proof taken against it.
    proved: ['batched', 'deployed-pending-proof'],
    // A retryable failed deploy is re-admitted by the next request.
    'settled-failure': ['admitted'],
  },
  terminal: ['escalated'],
  inFlight: { 'deployed-pending-proof': WAITING_PROOF_BUDGET },
});

const journalMachine = defineStateMachine({
  name: 'healer-deploy-journal',
  transitions: {
    '': ['deploying'],
    // A restart recovers an unsettled journal: waiters come back as pending
    // (recovered-awaiting-waiters), or there are none left (complete).
    deploying: ['proving', 'failed', 'recovery-failed', 'recovered-awaiting-waiters', 'complete'],
    proving: [
      'complete',
      'proof-failed',
      'recovery-failed',
      'recovered-awaiting-waiters',
    ],
    'recovered-awaiting-waiters': ['complete', 'proof-failed', 'recovery-failed'],
    // A failed recovery is resumed up to its budget, then escalated.
    'recovery-failed': ['recovered-awaiting-waiters', 'complete', 'recovery-failed', 'escalated'],
  },
  // proof-failed ends this journal: a failed proof is kept as an honest record,
  // and the next batch starts a fresh journal.
  terminal: ['complete', 'failed', 'escalated', 'proof-failed'],
  // Spellings older code read but nothing ever wrote.
  aliases: { deployed: 'proving', 'awaiting-waiters': 'recovered-awaiting-waiters' },
  // Three process starts. A recovery that fails three times is not a blip: the
  // atomic-release recovery retains its own journal on unknown paths or a SHA
  // mismatch on purpose, so the loop stops and a person looks.
  inFlight: { 'recovery-failed': { maxAttempts: 3 } },
});

const journalRowMachine = defineStateMachine({
  name: 'healer-deploy-journal-row',
  transitions: {
    '': ['deploying'],
    deploying: ['deployed-pending-proof', 'redeploy-required'],
    'deployed-pending-proof': ['proving', 'redeploy-required'],
    proving: ['proved', 'deployed-pending-proof', 'redeploy-required'],
    'redeploy-required': ['deployed-pending-proof', 'proving'],
  },
  terminal: ['proved'],
});

const DELIVERY_WINDOW = Object.freeze({ OPEN: 'open', DRAIN: 'drain', CLOSED: 'closed' });

// A batch that still owns the deploy: nothing else may form until it settles.
function isBatchActive(phase) {
  const state = batchMachine.normalize(phase);
  return state === 'awaiting-deploy' || state === 'deployed';
}

// Deployed and not yet settled: waiters are still proving.
function isBatchDeployed(phase) {
  return batchMachine.normalize(phase) === 'deployed';
}

// Deploy ownership is over, so a pending waiter may prove on its own (proof-only
// resume). `complete` is kept for batches written before `proof-failed` existed.
function isBatchReleased(phase) {
  const state = batchMachine.normalize(phase);
  return state === 'complete' || state === 'proof-failed';
}

function rowIsProved(row) {
  return !!(row && row.phase === 'proved' && row.result && row.result.ok === true);
}

module.exports = {
  REPAIR_STATE,
  RESUME_STAGES,
  WAITING_PROOF_BUDGET,
  DELIVERY_WINDOW,
  repairMachine,
  batchMachine,
  rowMachine,
  journalMachine,
  journalRowMachine,
  normalizeRepairState,
  isPendingRepairState,
  isPendingIntegrationRow,
  isBatchActive,
  isBatchDeployed,
  isBatchReleased,
  rowIsProved,
};
