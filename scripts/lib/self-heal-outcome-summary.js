'use strict';

const CLEARED_ATTEMPT_OUTCOMES = new Set(['cleared', 'deployed-verified', 'resolved']);

function normalizedOutcome(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
}

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
    const outcome = normalizedOutcome(row.qcResult || row.outcome);
    if (CLEARED_ATTEMPT_OUTCOMES.has(outcome)) summary.cleared += 1;
    else if (outcome === 'failed') summary.failed += 1;
    else if (outcome === 'target-remains-nonclean') summary.targetRemainedNonClean += 1;
    else if (outcome === 'repaired-pending-deploy' || outcome === 'integration-pending') {
      summary.pendingDeployment += 1;
    } else if (
      outcome === 'integration-blocked' ||
      outcome === 'kept-unverified-live-unreachable'
    ) {
      summary.integrationBlocked += 1;
    } else if (
      outcome === 'terminal-no-progress' ||
      outcome === 'exhausted' ||
      outcome === 'hard-blocker' ||
      outcome === 'blocked-on-ExampleCo'
    ) {
      summary.terminalNoProgress += 1;
    } else {
      summary.otherNonClear += 1;
    }
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
    if (outcome === 'cleared') summary.cleared += 1;
    else if (outcome === 'target-remains-nonclean') summary.targetRemainedNonClean += 1;
    else if (outcome === 'repaired-pending-deploy' || outcome === 'pending-deployment') {
      summary.pendingDeployment += 1;
    } else if (outcome === 'survived') summary.survived += 1;
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
