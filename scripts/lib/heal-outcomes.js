'use strict';

// scripts/lib/heal-outcomes.js
//
// The heal outcome vocabulary, declared ONCE (state machine audit #22). Before
// this, the briefing repair ledger, the outcome summary, the health card, the
// unit-independence receipt and the watch report each carried their own copy of
// "which words mean cleared", and only some of them mapped '_' to '-'. A
// process-cycle row written as `repaired_pending_deploy` (192 such rows on EC2)
// was pending in one reader and "other" in another.
//
// Spellings on disk (checked read-only on EC2, 2026-11-03): attempt qcResult and
// tactics-ledger outcomes are dashed; process-cycle outcomes also carry
// underscored words (repaired_pending_deploy, integration_blocked,
// repaired_pending_land) and `clean`. Every reader normalizes through
// normalizeOutcome, so one word has one meaning everywhere.

const { defineStateMachine } = require('./ledger-state-machine.js');

// Tactic label the orchestrator and driver write for a human-gate triage row.
const HUMAN_GATE_TRIAGE_TACTIC = 'human-gate-triage';

// Canonical outcome -> class. Outcomes are recorded facts, so every one is
// terminal: a row never changes its outcome, a later row supersedes it.
const OUTCOME_CLASS = Object.freeze({
  // The defect left authenticated live QC.
  cleared: 'cleared',
  'deployed-verified': 'cleared',
  resolved: 'cleared',
  failed: 'failed',
  'target-remains-nonclean': 'target-remains-nonclean',
  // A repair exists and waits on land or deploy: not a failed move.
  'repaired-pending-deploy': 'pending-deployment',
  'repaired-pending-land': 'pending-deployment',
  'integration-pending': 'pending-deployment',
  'pending-deployment': 'pending-deployment',
  'integration-blocked': 'integration-blocked',
  'kept-unverified-live-unreachable': 'integration-blocked',
  // The loop ended on proof, not on a retryable failure.
  'terminal-no-progress': 'terminal',
  exhausted: 'terminal',
  'hard-blocker': 'terminal',
  'blocked-on-owner': 'terminal',
  // Work that never started: admission deferrals and guard-only receipts.
  'capacity-deferred': 'non-attempt',
  'source-capacity-deferred': 'non-attempt',
  'stage-capacity-deferred': 'non-attempt',
  'admission-deferred': 'non-attempt',
  'not-attempted': 'non-attempt',
  'never-started': 'non-attempt',
  'no-spin-skip': 'non-attempt',
  'source-no-spin-skip': 'non-attempt',
  'guard-only': 'non-attempt',
  'guard-only-skip': 'non-attempt',
  // A worker or a triage stopped without clearing. Whether it consumed a tactic
  // depends on who wrote it: see isTriageEscalation.
  escalated: 'escalated',
});

// Old spellings that mean another declared outcome. '_' and case are folded
// before this lookup.
const OUTCOME_ALIASES = Object.freeze({
  clean: 'cleared',
});

const machine = defineStateMachine({
  name: 'heal-outcome',
  transitions: { '': Object.keys(OUTCOME_CLASS) },
  terminal: Object.keys(OUTCOME_CLASS),
  aliases: OUTCOME_ALIASES,
});

const CLEARED_OUTCOMES = new Set(
  Object.keys(OUTCOME_CLASS).filter((name) => OUTCOME_CLASS[name] === 'cleared'),
);
const NON_ATTEMPT_OUTCOMES = new Set(
  Object.keys(OUTCOME_CLASS).filter((name) => OUTCOME_CLASS[name] === 'non-attempt'),
);

// The one normalizer: trim, lowercase, '_' to '-', then declared aliases.
// Unknown words pass through unchanged so a reader can bucket them as "other".
function normalizeOutcome(value) {
  const spelled = String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  return machine.normalize(spelled);
}

function outcomeClass(value) {
  const name = normalizeOutcome(value);
  return Object.prototype.hasOwnProperty.call(OUTCOME_CLASS, name) ? OUTCOME_CLASS[name] : '';
}

function isKnownOutcome(value) {
  return outcomeClass(value) !== '';
}

function isClearedOutcome(value) {
  return outcomeClass(value) === 'cleared';
}

function isNonAttemptOutcome(value) {
  return outcomeClass(value) === 'non-attempt';
}

// The outcome word a ledger row carries: attempt rows use qcResult, process
// and tactics rows use outcome, open-defect projections use lastQcResult.
function rowOutcome(row) {
  return normalizeOutcome(row && (row.qcResult || row.outcome || row.lastQcResult));
}

function rowTacticKey(row) {
  return String((row && (row.tacticKey || row.tactic || row.lastTactic)) || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[`'"]/g, '')
    .trim();
}

function isTriageRow(row) {
  return rowTacticKey(row) === HUMAN_GATE_TRIAGE_TACTIC;
}

// A triage escalation records that a defect needs the owner; no implementation
// tactic ran. It is not a failed move, so it must never make the no-repeat
// guard refuse a real tactic. A WORKER escalation (budget kill, parse failure,
// nested task) did run a session on that input and stays a failed move.
function isTriageEscalation(row) {
  return rowOutcome(row) === 'escalated' && isTriageRow(row);
}

// True when the row records a real attempt that did not clear: the only rows
// the no-repeat guard may count against a tactic.
function consumesTactic(row) {
  if (!row) return false;
  const name = rowOutcome(row);
  if (isClearedOutcome(name) || isNonAttemptOutcome(name)) return false;
  return !isTriageEscalation(row);
}

module.exports = {
  HUMAN_GATE_TRIAGE_TACTIC,
  OUTCOME_CLASS,
  OUTCOME_ALIASES,
  CLEARED_OUTCOMES,
  NON_ATTEMPT_OUTCOMES,
  normalizeOutcome,
  outcomeClass,
  isKnownOutcome,
  isClearedOutcome,
  isNonAttemptOutcome,
  rowOutcome,
  isTriageRow,
  isTriageEscalation,
  consumesTactic,
};
