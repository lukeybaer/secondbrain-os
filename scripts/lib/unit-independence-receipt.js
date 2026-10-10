'use strict';

// Law g27 evidence: each briefing card owns its progress and verdict, and no
// card is held up by another card's failure or by aggregate lifecycle state.
// Owner-approved test (ExampleCo 2026-09-23): red when any card was blocked or
// delayed last night by something other than its own evidence.
//
// Source: the night repair ledger on EC2,
// <dataDir>/agent/briefing-repair-ledger/briefing-<date>.jsonl, rows of
// type "attempt" with `defect` ("<card_id>:<defect_type>") and `qcResult`.
// A card's terminal outcome is its last attempt of the night.

const fs = require('node:fs');
const path = require('node:path');

// Every qcResult code observed on EC2 (2026-09-21/22), classified. No code
// observed so far means "held by another unit"; the 'blocked' class is kept
// for the first one that does. Codes not
// listed are 'unmapped' and turn the receipt red until someone classifies
// them, so a new blocking shape can never hide as green.
const CODE_CLASS = Object.freeze({
  // Settled on the card's own evidence, QC or source.
  cleared: 'own',
  'target-remains-nonclean': 'own',
  'source-failed': 'own',
  failed: 'own',
  'stage-failed': 'own',
  'generation-publish-incomplete': 'own',
  'no-actionable-live-target': 'own',
  'kept-unverified-live-unreachable': 'own',
  'no-spin-skip': 'own',
  // Explicit, scoped waits the laws allow: land/deploy integration is the one
  // sanctioned serialization, a capacity deferral is a declared resource
  // limit, and an owner gate waits on ExampleCo, not on another card.
  'repaired-pending-deploy': 'allowed-wait',
  'stage-capacity-deferred': 'allowed-wait',
  'blocked-on-ExampleCo': 'allowed-wait',
  // The card's OWN repair failed its own coordinator gate (its affected tests
  // failed or its live re-verification did not run): agentic-healer-driver.js
  // integrationBlockingError reads that card's own integration error. Not a
  // wait on another card (verified against the 2026-09-23 ledger).
  'integration-blocked': 'own',
});

function readAttempts(file) {
  if (!fs.existsSync(file)) return null;
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.type === 'attempt') rows.push(row);
    } catch { /* a torn line is skipped, never fatal */ }
  }
  return rows;
}

function classifyUnitIndependence({ dataDir, date, file = null } = {}) {
  const ledger = file || path.join(dataDir, 'agent', 'briefing-repair-ledger', `briefing-${date}.jsonl`);
  const attempts = readAttempts(ledger);
  if (attempts === null) {
    return { status: 'unknown', detail: `No night repair ledger exists for ${date}.`, units: [] };
  }
  const lastByUnit = new Map();
  for (const row of attempts) {
    const unit = String(row.defect || '').split(':')[0];
    if (unit) lastByUnit.set(unit, row);
  }
  const units = [...lastByUnit.entries()].map(([unit, row]) => {
    const reasonCode = String(row.qcResult || '');
    return { unit, verdict: CODE_CLASS[reasonCode] || 'unmapped', reasonCode };
  });
  const blocked = units.filter((unit) => unit.verdict === 'blocked');
  const unmapped = units.filter((unit) => unit.verdict === 'unmapped');
  if (blocked.length || unmapped.length) {
    const parts = [];
    if (blocked.length) parts.push(`${blocked.length} card(s) ended the night held up by another unit instead of their own evidence: ${blocked.map((u) => u.unit).join(', ')}`);
    if (unmapped.length) parts.push(`${unmapped.length} card(s) ended on an unclassified outcome that must be classified: ${unmapped.map((u) => `${u.unit} (${u.reasonCode || 'empty'})`).join(', ')}`);
    return { status: 'red', detail: `${parts.join('. ')}.`, units };
  }
  return {
    status: 'green',
    detail: units.length
      ? `All ${units.length} card(s) worked on overnight reached their own verdict or an allowed, scoped wait.`
      : 'No card needed overnight repair, so none could be held up by another.',
    units,
  };
}

module.exports = { CODE_CLASS, classifyUnitIndependence };
