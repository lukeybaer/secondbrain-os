'use strict';

// Stable binding between the read-only paperwork audit and the exact ledger
// content it audited. Generation timestamps are intentionally excluded: the
// SLA producer may refresh metadata without changing any call. The fields
// below are the production call fields that determine paperwork membership,
// revision identity, closure state, and committed-settlement evidence.

const crypto = require('node:crypto');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function paperworkCallFacts(row = {}) {
  const settlement = row.closure_settlement && typeof row.closure_settlement === 'object'
    ? row.closure_settlement
    : {};
  return {
    otid: String(row.otid || ''),
    source_revision_hash: String(row.source_revision_hash || '').toLowerCase(),
    closed: row.closed === true,
    status: String(row.status || ''),
    state: String(row.state || ''),
    failed_stages: Array.isArray(row.failed_stages) ? row.failed_stages.map(String) : [],
    // The settlement schema has several legitimate terminal variants
    // (rehash, correction, quarantine, recovered-source supersession). Bind
    // the complete production object so a new or variant-specific proof field
    // cannot change underneath a same-count audit unnoticed.
    closure_settlement: stableValue(settlement),
  };
}

function paperworkLedgerSemanticDigest(ledger = {}) {
  const calls = (Array.isArray(ledger.calls) ? ledger.calls : [])
    .map(paperworkCallFacts)
    .sort((a, b) => a.otid.localeCompare(b.otid) || a.source_revision_hash.localeCompare(b.source_revision_hash));
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(calls))).digest('hex');
}

module.exports = { paperworkCallFacts, paperworkLedgerSemanticDigest };
