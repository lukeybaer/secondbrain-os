'use strict';

// The vocabulary and its one normalizer live in lib/heal-outcomes.js (audit #22),
// shared with the repair ledger so both read a row the same way.
const { normalizeOutcome, outcomeClass } = require('./heal-outcomes.js');

const normalizedOutcome = normalizeOutcome;

function summarizeAttemptOutcomes(rows = []) {
  const summary = {
    total: 0,
    cleared: 0,
    failed: 0,
    targetRemainedNonClean: 0,
    pendingDeployment: 0,
    integrationBlocked: 0,
    terminalNoProgress: 0,
    otherNonClear: 0,
    nonClear: 0,
  };
  for (const row of rows) {
    if (!row || row.type !== 'attempt') continue;
    summary.total += 1;
    const outcomeKind = outcomeClass(row.qcResult || row.outcome);
    if (outcomeKind === 'cleared') summary.cleared += 1;
    else if (outcomeKind === 'failed') summary.failed += 1;
    else if (outcomeKind === 'target-remains-nonclean') summary.targetRemainedNonClean += 1;
    else if (outcomeKind === 'pending-deployment') summary.pendingDeployment += 1;
    else if (outcomeKind === 'integration-blocked') summary.integrationBlocked += 1;
    else if (outcomeKind === 'terminal') summary.terminalNoProgress += 1;
    else summary.otherNonClear += 1;
  }
  summary.nonClear = summary.total - summary.cleared;
  return summary;
}

function summarizeProcessOutcomes(rows = []) {
  const summary = {
    total: 0,
    cleared: 0,
    targetRemainedNonClean: 0,
    pendingDeployment: 0,
    survived: 0,
    unverified: 0,
    skipped: 0,
    other: 0,
  };
  for (const row of rows) {
    if (!row || row.type !== 'process-cycle' || row.phase !== 'finished') continue;
    summary.total += 1;
    const outcome = normalizedOutcome(row.outcome);
    const outcomeKind = outcomeClass(outcome);
    if (outcomeKind === 'cleared') summary.cleared += 1;
    else if (outcomeKind === 'target-remains-nonclean') summary.targetRemainedNonClean += 1;
    else if (outcomeKind === 'pending-deployment') summary.pendingDeployment += 1;
    else if (outcome === 'survived') summary.survived += 1;
    else if (outcome === 'unverified') summary.unverified += 1;
    else if (outcome === 'skipped') summary.skipped += 1;
    else summary.other += 1;
  }
  return summary;
}

function repairOutcomeSummary(attemptRows = [], repairRows = []) {
  return {
    attemptOutcomes: summarizeAttemptOutcomes(attemptRows),
    processOutcomes: summarizeProcessOutcomes(repairRows),
  };
}

module.exports = {
  normalizedOutcome,
  summarizeAttemptOutcomes,
  summarizeProcessOutcomes,
  repairOutcomeSummary,
};
