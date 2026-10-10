'use strict';

const { isRenderableSystemHealthMetricId } = require('./system-health-ledger.js');

function normalizedId(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function repairWorkUnitIds(value = {}) {
  const declared = Array.isArray(value.workUnitIds)
    ? value.workUnitIds
    : value.workUnitId
      ? [value.workUnitId]
      : [];
  return [...new Set(declared.map(normalizedId).filter(Boolean))];
}

// The permanent ledger owns the System Health row set. A retired alias in an
// old packet is neither a metric nor repair work; reject only that registry
// mismatch, never ordinary prose merely containing “evidence”.
function isPlaceholderRepairReceipt(value = {}) {
  if (!value || typeof value !== 'object') return false;
  if (value.placeholderReceipt === true || value.syntheticPlaceholder === true) return true;
  return repairWorkUnitIds(value).some(
    (id) => id.startsWith('system_health:') && !isRenderableSystemHealthMetricId(id),
  );
}

function unchangedEvidenceReason(value) {
  return /(?:stable contract and current evidence are unchanged|unchanged from the prior dispatched attempt|tactics exhausted.*unchanged|no unique viable tactic|no unused (?:approach|tactic))/i.test(
    String(value || ''),
  );
}

// A mechanically complete source search can honestly come back short of the
// card's editorial minimum. That is changed external evidence waiting to be
// discovered, not a code hypothesis. Keep this deliberately strict: every
// configured query must have reached a result page, URL decoding must be
// clean, and the card itself must name a numeric source shortfall. Transport,
// parser, or incomplete-search failures remain admitted for repair.
function completeExternalEvidenceScarcity(value = {}) {
  const coverage = value && typeof value.xSearchCoverage === 'object'
    ? value.xSearchCoverage
    : null;
  const queryCount = Number(coverage && coverage.queryCount);
  const reached = Number(coverage && coverage.reached);
  const decodeFailures = Number(coverage && coverage.decodeFailures);
  const defects = Array.isArray(value && value.defectKinds) ? value.defectKinds : [];
  const namedShortfall = defects.some((row) =>
    /only\s+\d+\s+of\s+\d+\s+cited sources.*at least\s+\d+\s+(?:are|is) required/i.test(
      String(row || ''),
    ),
  );
  return Boolean(
    coverage &&
      coverage.complete === true &&
      Number.isInteger(queryCount) &&
      queryCount > 0 &&
      reached === queryCount &&
      decodeFailures === 0 &&
      namedShortfall,
  );
}

// A wait for evidence has no executable repair.  It must not retain a worker
// slot or a controller lease, and it must not make a model-context receipt
// look like another dispatch.  A later source/controller event re-enters the
// same exact unit after its evidence digest changes.
function classifyRepairAdmission({
  cardId = '',
  workUnitIds = [],
  modelContext = null,
  healerReceipt = null,
  sourceEvidence = null,
  liveStatus = '',
} = {}) {
  const target = { cardId, workUnitIds };
  if (isPlaceholderRepairReceipt(target)) {
    return {
      admitted: false,
      disposition: 'placeholder-receipt',
      releaseLease: true,
      retainBackgroundCapacity: false,
      pollForEvidence: false,
      reason: 'placeholder evidence is not a repair work unit',
    };
  }
  if (['clean', 'green'].includes(normalizedId(liveStatus))) {
    return {
      admitted: false,
      disposition: 'already-clean',
      releaseLease: true,
      retainBackgroundCapacity: false,
      pollForEvidence: false,
      reason: 'exact repair target is already clean',
    };
  }
  if (completeExternalEvidenceScarcity(sourceEvidence)) {
    return {
      admitted: false,
      disposition: 'awaiting_external_evidence',
      releaseLease: true,
      retainBackgroundCapacity: false,
      pollForEvidence: false,
      reason:
        'the complete decode-clean source search found fewer qualifying items than the stable contract requires; rerun discovery after external evidence changes without spending a judgment worker',
    };
  }
  const reason = String(
    (healerReceipt && (healerReceipt.verdictReason || healerReceipt.error)) || '',
  );
  if (
    healerReceipt &&
    (healerReceipt.capacityDeferred === true ||
      /night-wide spend circuit|deferred capacity|host work .*deferred/i.test(reason))
  ) {
    return {
      admitted: false,
      disposition: 'deferred_capacity',
      releaseLease: true,
      retainBackgroundCapacity: false,
      pollForEvidence: false,
      reason: 'repair capacity is unavailable; release this exact repair lease until a later controller admission',
    };
  }
  if ((modelContext && modelContext.unchangedEvidence === true) || unchangedEvidenceReason(reason)) {
    return {
      admitted: false,
      disposition: 'awaiting_changed_evidence',
      releaseLease: true,
      retainBackgroundCapacity: false,
      pollForEvidence: false,
      reason:
        'no materially new hypothesis exists for unchanged owned evidence; release this exact repair lease until evidence changes',
    };
  }
  return {
    admitted: true,
    disposition: 'admitted',
    releaseLease: false,
    retainBackgroundCapacity: true,
    pollForEvidence: false,
    reason: '',
  };
}

// Exact work-unit invocations receive their own controller key.  Source keys
// remain deliberately shared because they protect a genuinely shared source
// family; a parent-card controller key would instead serialize unrelated
// sibling measurements and is omitted for this exact scope.
function exactRepairLeaseKeys({ cardId = '', workUnitIds = [], getContract = () => null } = {}) {
  const normalizedCardId = normalizedId(cardId);
  const units = repairWorkUnitIds({ workUnitIds }).filter(
    (id) => !id.startsWith('system_health:') || isRenderableSystemHealthMetricId(id),
  );
  const targets = units.length ? units : normalizedCardId ? [normalizedCardId] : [];
  const keys = new Set(targets.map((id) => `controller:${id}`));
  for (const target of targets) {
    const contract = getContract(target) || {};
    const families = [contract.family, ...(contract.sharedSourceFamilies || [])];
    for (const value of families) {
      const family = normalizedId(value);
      if (family && family !== 'card-local') keys.add(`source:${family}`);
    }
  }
  return [...keys].sort();
}

module.exports = {
  normalizedId,
  repairWorkUnitIds,
  isPlaceholderRepairReceipt,
  unchangedEvidenceReason,
  completeExternalEvidenceScarcity,
  classifyRepairAdmission,
  exactRepairLeaseKeys,
};
