'use strict';

const crypto = require('node:crypto');
const { deterministicOnly } = require('./briefing-healer-policy.js');
const { unitEvidenceDigest } = require('./live-board-truth.js');

function compact(value, max = 1200) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function normalized(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function evidenceForTarget(board, targetId, cardId) {
  const exact = (
    Array.isArray(board && board.systemHealthMeasurements) ? board.systemHealthMeasurements : []
  ).find((row) => normalized(row && row.id) === normalized(targetId));
  if (exact) return compact(exact.detail || exact.evidence || exact.status, 1600);
  const defects = Array.isArray(board && board.defects) ? board.defects : [];
  const needle = normalized(cardId);
  return compact(
    defects
      .filter((row) =>
        normalized(typeof row === 'string' ? row : JSON.stringify(row)).includes(needle),
      )
      .map((row) => (typeof row === 'string' ? row : row.message || JSON.stringify(row)))
      .join(' | '),
    1600,
  );
}

function titleForTarget(board, targetId, cardId) {
  if (normalized(targetId).startsWith('system_health:')) {
    const exact = (
      Array.isArray(board && board.systemHealthMeasurements) ? board.systemHealthMeasurements : []
    ).find((row) => normalized(row && row.id) === normalized(targetId));
    return `SYSTEM HEALTH · ${compact((exact && (exact.name || exact.id)) || targetId, 180)}`;
  }
  const card = (Array.isArray(board && board.cards) ? board.cards : []).find(
    (row) => normalized(row && row.id) === normalized(cardId),
  );
  return compact((card && (card.title || card.id)) || cardId, 220);
}

function plainTargetName(board, targetId, cardId) {
  const exact = (
    Array.isArray(board && board.systemHealthMeasurements) ? board.systemHealthMeasurements : []
  ).find((row) => normalized(row && row.id) === normalized(targetId));
  if (exact && (exact.name || exact.id)) return compact(exact.name || exact.id, 180);
  const card = (Array.isArray(board && board.cards) ? board.cards : []).find(
    (row) => normalized(row && row.id) === normalized(cardId),
  );
  return compact((card && (card.title || card.id)) || cardId || targetId, 180);
}

const INTERNAL_REPORT_LANGUAGE_RE =
  /\b(?:source:[\w-]+|targeted-refresh|target-remains-nonclean|scoped live qc|workunit|repair evidence|rolled-back-unverified-target|kept-unverified-live-unreachable|published-verified-deterioration|cycle-cap-exhausted)\b/i;

const IMMUTABLE_HISTORY_TARGETS = new Set([
  'system_health:watcher-interventions',
]);

function repairTerminalState(receipt, targetId, clean) {
  if (clean) return { terminal: true, retryable: false, terminalReason: 'qc-clean' };
  const outcome = normalized(receipt && receipt.outcome);
  const healer =
    receipt && receipt.agenticHealer && typeof receipt.agenticHealer === 'object'
      ? receipt.agenticHealer
      : {};
  // The card controller's own repair loop is the authority on WHICH blocker
  // class a scoped live attempt just proved (an immutable historical window,
  // a disabled external integration, a doom-loop "no changed input" verdict,
  // or any future class). When it has already classified the receipt via
  // cardReceipt.terminalReason, honor that verdict directly instead of
  // re-deriving it here, so a new blocker class never needs a second
  // classifier: dev-plans/core/briefing.md invariant 12, "extend, never
  // build a parallel QC/classifier."
  const controllerTerminalReason = String((receipt && receipt.terminalReason) || '').trim();
  if (controllerTerminalReason) {
    return { terminal: true, retryable: false, terminalReason: controllerTerminalReason };
  }
  if (IMMUTABLE_HISTORY_TARGETS.has(normalized(targetId))) {
    return { terminal: true, retryable: false, terminalReason: 'immutable-history' };
  }
  if (deterministicOnly(targetId || receipt?.cardId)) {
    return { terminal: true, retryable: false, terminalReason: 'no-agentic-healer' };
  }
  if (
    outcome === 'cycle-cap-exhausted' ||
    /hard\s+(?:eight|8)[-\s]cycle|cycle[-\s]cap[-\s]exhausted/i.test(
      String(healer.verdictReason || ''),
    )
  ) {
    return { terminal: true, retryable: false, terminalReason: 'eight-cycle-cap' };
  }
  if (
    healer.verdict === 'escalated' &&
    Number(healer.escalatedToHuman || 0) > 0 &&
    Number(healer.failedToFix || 0) === 0
  ) {
    return { terminal: true, retryable: false, terminalReason: 'human-gate' };
  }
  return { terminal: false, retryable: true, terminalReason: '' };
}

function plainAttempt(receipt, targetName) {
  const outcome = normalized(receipt.outcome);
  if (outcome === 'source-failed') {
    return `I refreshed ${targetName} from its current source, but that source failed before it could publish a verified result.`;
  }
  if (outcome === 'target-remains-nonclean') {
    return `I refreshed ${targetName} from its current source and checked only that item. It still showed the same problem.`;
  }
  if (outcome === 'rolled-back-unverified-target') {
    return `I refreshed ${targetName}, but the new result could not be verified, so the previous published state was preserved.`;
  }
  if (outcome === 'kept-unverified-live-unreachable') {
    return `I refreshed ${targetName}, but the live dashboard could not be reached to verify the result.`;
  }
  if (outcome === 'cleared') {
    return `I refreshed ${targetName} from its current source and its live dashboard check passed.`;
  }
  return `I ran the existing repair for ${targetName} and checked only that item on the live dashboard.`;
}

function plainSurvivalReason(receipt, targetName) {
  const reflection = compact(receipt.reflection, 1200);
  if (reflection && !INTERNAL_REPORT_LANGUAGE_RE.test(reflection)) return reflection;
  const outcome = normalized(receipt.outcome);
  if (outcome === 'source-failed') {
    return `${targetName} stayed unhealthy because its current source did not complete successfully.`;
  }
  if (outcome === 'target-remains-nonclean') {
    return `The refreshed ${targetName} result still showed the same problem on the live dashboard.`;
  }
  if (outcome === 'rolled-back-unverified-target') {
    return `${targetName} stayed unhealthy because the replacement result lacked current live proof.`;
  }
  if (outcome === 'kept-unverified-live-unreachable') {
    return `${targetName} stayed unverified because the live dashboard was unreachable.`;
  }
  if (outcome === 'cycle-cap-exhausted') {
    return `${targetName} stayed unhealthy after the nightly repair limit was reached.`;
  }
  return `${targetName} did not produce verified healthy evidence before the overnight cutoff.`;
}

function plainNextMove(receipt, targetId, targetName) {
  const next = plainSourceNextMove(receipt, targetId, targetName);
  if (deterministicOnly(targetId || receipt?.cardId)) {
    return `${next} No automatic coding healer is assigned; the report must account for this repair.`;
  }
  return next;
}

function plainSourceNextMove(receipt, targetId, targetName) {
  if (receipt.outcome === 'owner-pause-deferred') return `Honor the existing Otter pause${receipt.deferredUntil ? ` until ${receipt.deferredUntil}` : ' until its lease is resolved'}, then resume the prior live lane and verify exact call receipts. Past SLA misses remain recorded.`;
  if (receipt.terminalReason === 'owner-disabled-advisory') return 'Keep Graphiti off under the owner policy. Archive and People continue independently; no repair can certify disabled graph ingestion as green.';
  const humanNeed = compact(receipt.needFromExampleCo, 900);
  if (humanNeed && !INTERNAL_REPORT_LANGUAGE_RE.test(humanNeed)) return humanNeed;
  if (normalized(targetId) === 'system_health:otter-call-processing-sla') {
    return 'Repair any current processing targets and prove their exact call receipts. New Otter calls must meet each stage deadline and the 60-minute completion SLA. Past misses remain honest in the rolling 24-hour window.';
  }
  if (normalized(targetId) === 'system_health:watcher-interventions') {
    return 'The next briefing window must complete with zero attended rescues. Historical interventions remain honest for the measured day.';
  }
  const candidate = compact(receipt.makeGreen || receipt.nextHypothesis, 900);
  if (candidate && !INTERNAL_REPORT_LANGUAGE_RE.test(candidate)) return candidate;
  const outcome = normalized(receipt.outcome);
  if (outcome === 'source-failed') {
    return `Repair the current ${targetName} source or its missing dependency, rerun only ${targetName}, and confirm the live dashboard shows the new result.`;
  }
  if (outcome === 'target-remains-nonclean') {
    return `Inspect the live ${targetName} failure, correct the business input that is still wrong, rerun only ${targetName}, and confirm it on the live dashboard.`;
  }
  if (outcome === 'rolled-back-unverified-target') {
    return `${targetName} must produce a fresh result and pass its live dashboard check before the replacement can be published.`;
  }
  if (outcome === 'kept-unverified-live-unreachable') {
    return `Restore live dashboard access, rerun the deterministic ${targetName} check, and keep it unverified until that check passes.`;
  }
  if (outcome === 'cycle-cap-exhausted') {
    return `Review the named ${targetName} blocker and choose a genuinely different next approach before another repair cycle runs.`;
  }
  if (outcome === 'published-verified-deterioration') {
    return `Repair the newly affected ${targetName} process, then rerun only its source and live dashboard checks.`;
  }
  return `The ${targetName} business process must complete successfully, then that item alone must pass its live dashboard check.`;
}

function plainImpact(receipt, targetName) {
  const outcome = normalized(receipt.outcome);
  if (receipt.terminalReason === 'owner-disabled-advisory') {
    return 'Graphiti stays off under owner policy. Independent Signal stages continue; no coding repair or graph success is claimed.';
  }
  if (outcome === 'source-failed') {
    return `The impact is high because ${targetName} can be missing or late; the repair is moderate complexity and can affect the source connection, so rollout must keep the current live proof fail-closed.`;
  }
  if (
    outcome === 'rolled-back-unverified-target' ||
    outcome === 'kept-unverified-live-unreachable'
  ) {
    return `The impact is high because ExampleCo cannot trust ${targetName} without live proof; the repair is moderate complexity, and the main risk is publishing an unverified replacement while verification is recovering.`;
  }
  if (outcome === 'cycle-cap-exhausted') {
    return `The impact is high because ${targetName} stayed red after its full nightly repair budget; the next approach is higher complexity, and another unchanged attempt would waste time and model usage.`;
  }
  return `The impact is medium to high because ${targetName} remains incomplete or unreliable; the repair is moderate complexity, and its rollout must stay scoped so another card is not disturbed.`;
}

function buildCardReportEvidence({ cardReceipt, board, date, now = new Date() } = {}) {
  const receipt = cardReceipt && typeof cardReceipt === 'object' ? cardReceipt : {};
  const cardId = normalized(receipt.cardId);
  const workUnitIds = Array.isArray(receipt.workUnitIds)
    ? receipt.workUnitIds.map(normalized).filter(Boolean)
    : [];
  const targetId = workUnitIds[0] || cardId;
  if (!targetId || !receipt.finishedAt) return null;
  const status = normalized(receipt.statusAfter || receipt.outcome || 'unknown');
  const sourceEvidence = evidenceForTarget(board || {}, targetId, cardId);
  const clean = status === 'clean' || receipt.outcome === 'cleared';
  const targetName = plainTargetName(board || {}, targetId, cardId);
  const assembledAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const terminalState = repairTerminalState(receipt, targetId, clean);
  const evidence = {
    schemaVersion: 1,
    date: String(date || ''),
    id: targetId,
    cardId,
    title: titleForTarget(board || {}, targetId, cardId),
    status: clean ? 'green' : status,
    terminalAt: String(receipt.finishedAt),
    assembledAt,
    whyRed: clean
      ? ''
      : sourceEvidence ||
        compact(receipt.defectsAfter, 1200) ||
        'Scoped live proof stayed non-green.',
    attempted: plainAttempt(receipt, targetName),
    survivedBecause: clean ? '' : plainSurvivalReason(receipt, targetName),
    makeGreen: clean ? '' : plainNextMove(receipt, targetId, targetName),
    technicalAttempt: compact(
      [
        receipt.tactic ? `Tactic: ${receipt.tactic}.` : '',
        receipt.outcome ? `Result: ${receipt.outcome}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
      900,
    ),
    ...terminalState,
    executionStatus: clean
      ? 'QC Yes'
      : receipt.outcome === 'owner-pause-deferred'
        ? `paused${receipt.deferredUntil ? ` until ${receipt.deferredUntil}` : ': pause lease needs recovery'}`
      : status === 'yellow' && terminalState.terminalReason === 'owner-disabled-advisory'
        ? 'advisory: disabled by owner'
      : terminalState.terminal
        ? `red for the day: ${terminalState.terminalReason}`
        : 'open: this same card must continue its repair loop',
    sourceBoardTs: String((board && board.ts) || ''),
    sourceUnitDigest: unitEvidenceDigest(board || {}, targetId),
  };
  evidence.whatWentWrong = clean
    ? `${targetName} completed and passed its scoped live check.`
    : evidence.whyRed;
  evidence.howToFixOrImprove = clean ? '' : evidence.makeGreen;
  evidence.impactRisksCost = clean ? '' : plainImpact(receipt, targetName);
  evidence.evidenceHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(evidence))
    .digest('hex');
  return evidence;
}

// The one predicate for "this red unit already has current terminal proof".
// The night coordinator's frontier and early finalization both read it, so the
// two can never disagree about the same event. Exact board-ts equality stays
// the first branch; otherwise the proof holds only while the unit's own row
// digest is unchanged, so a sibling write cannot reopen it and an own-row
// change (a new attempt, a status flip) always does.
function hasCurrentTerminalProof({ event, board, unitId } = {}) {
  const content = event?.content && typeof event.content === 'object' ? event.content : {};
  if (!(event?.terminal === true && content.terminal === true && content.retryable === false)) {
    return false;
  }
  if (String(content.sourceBoardTs || '') === String(board?.ts || '')) return true;
  const digest = String(content.sourceUnitDigest || '');
  return Boolean(digest) && digest === unitEvidenceDigest(board, unitId);
}

module.exports = {
  buildCardReportEvidence,
  hasCurrentTerminalProof,
  repairTerminalState,
};
