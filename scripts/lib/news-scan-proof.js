'use strict';

// Positive proof that a news scan ran. A zero-item card is a "verified zero"
// when sources were queried, candidates were examined, and the rejections were
// recorded with reasons, or when every source answered with no failure and no
// candidates. Anything less is a silent drop, not a clean zero.

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function reasonTotal(reasons) {
  if (!reasons || typeof reasons !== 'object') return 0;
  return Object.values(reasons).reduce((sum, value) => sum + count(value), 0);
}

function buildScanProof({ searchInventory = null, collectedCount = 0, unusableCount = 0, selectedCount = 0 } = {}) {
  const inventory = searchInventory && typeof searchInventory === 'object' ? searchInventory : {};
  const candidatesConsidered = count(inventory.candidatesConsidered);
  const collected = count(collectedCount);
  const unusable = count(unusableCount);
  const selected = count(selectedCount);
  return {
    sourcesConfigured: count(inventory.configuredSources),
    sourcesQueried: count(inventory.reachedSources),
    sourcesFailed: Array.isArray(inventory.sourceFailures) ? inventory.sourceFailures.length : null,
    candidatesConsidered,
    collectedCount: collected,
    selectedCount: selected,
    rejectionReasons: {
      filteredBeforePool: Math.max(0, candidatesConsidered - collected),
      unusableSource: unusable,
      notSelected: Math.max(0, collected - unusable - selected),
    },
  };
}

// scan: the proof recorded on the card by buildScanProof (or a receipt copy).
// This judges a zero-item scan; a card that shows items needs no zero proof.
function scanProofVerified(scan) {
  if (!scan || typeof scan !== 'object') return false;
  if (!(count(scan.sourcesQueried) > 0)) return false;
  if (count(scan.candidatesConsidered) > 0) return reasonTotal(scan.rejectionReasons) > 0;
  // Genuine zero: every configured source answered, the failure list was
  // recorded and is empty, and nothing came back. A proof without a recorded
  // failure list, or with a source unreached, stays a silent drop.
  return (
    typeof scan.sourcesFailed === 'number' &&
    scan.sourcesFailed === 0 &&
    count(scan.sourcesConfigured) > 0 &&
    count(scan.sourcesQueried) >= count(scan.sourcesConfigured)
  );
}

module.exports = { buildScanProof, scanProofVerified };
