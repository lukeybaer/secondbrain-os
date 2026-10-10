'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'briefing-report-evidence-freeze@1';

function dateKey(value) {
  const day = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error('report evidence freeze requires a YYYY-MM-DD date');
  }
  return day;
}

function statePackagePath(dataDir, date) {
  return path.join(
    path.resolve(dataDir),
    'agent',
    'briefing-overnight-watch',
    `${dateKey(date)}-report-evidence-freeze.json`,
  );
}

function sha256Json(value) {
  const serialized = JSON.stringify(value);
  return crypto
    .createHash('sha256')
    .update(serialized === undefined ? 'null' : serialized)
    .digest('hex');
}

function validateStatePackage(value, { date, expectedSha256 = null } = {}) {
  const problems = [];
  let day;
  try {
    day = dateKey(date);
  } catch (error) {
    return { valid: false, problems: [error.message] };
  }
  const parsed = value && typeof value === 'object' ? value : null;
  if (!parsed) return { valid: false, problems: ['state package is missing'] };
  const unsigned = { ...parsed };
  delete unsigned.sha256;
  if (parsed.schema !== SCHEMA) problems.push('state package schema is invalid');
  if (parsed.date !== day) problems.push('state package date is wrong');
  if (parsed.inputs?.window?.date !== day) problems.push('input window date is wrong');
  if (parsed.inputs?.board?.artifact?.date !== day) problems.push('board date is wrong');
  if (parsed.boardSha256 !== sha256Json(parsed.inputs?.board?.artifact)) {
    problems.push('board hash is invalid');
  }
  if (parsed.rosterSha256 !== sha256Json(parsed.inputs?.redRoster)) {
    problems.push('starting roster hash is invalid');
  }
  if (parsed.systemHealth?.current?.date !== day)
    problems.push('current System Health date is wrong');
  if (parsed.systemHealth?.current?.cutoffAt !== parsed.cutoffAt) {
    problems.push('current System Health cutoff is wrong');
  }
  if (
    parsed.systemHealth?.current?.evidenceHash !==
    sha256Json(parsed.systemHealth?.current?.measurements || [])
  ) {
    problems.push('current System Health hash is invalid');
  }
  if (!Array.isArray(parsed.systemHealth?.historicalServiceTargetFailures)) {
    problems.push('historical service-target failures are missing');
  }
  // 2026-08-31 OOM fix: freezeReportEvidence now stores a small hash
  // descriptor per unbounded ledger (selfHeal, escalations, ...) instead of
  // the raw rows, so the receipt never grows with the night. inputs.ledgers
  // is optional here (older receipts and hand-built fixtures omit it), but
  // when present every entry must be a well-formed descriptor: this is the
  // one place that audits the shape rehydrateFrozenLedgers depends on.
  if (parsed.inputs?.ledgers && typeof parsed.inputs.ledgers === 'object') {
    for (const [name, descriptor] of Object.entries(parsed.inputs.ledgers)) {
      const malformed =
        !descriptor ||
        typeof descriptor !== 'object' ||
        typeof descriptor.path !== 'string' ||
        !/^[0-9a-f]{64}$/.test(String(descriptor.sha256 || '')) ||
        !Number.isInteger(descriptor.bytes) ||
        descriptor.bytes < 0 ||
        !Number.isInteger(descriptor.rowCount) ||
        descriptor.rowCount < 0 ||
        !descriptor.window ||
        typeof descriptor.window !== 'object';
      if (malformed) problems.push(`ledger descriptor "${name}" is malformed`);
    }
  }
  if (parsed.sha256 !== sha256Json(unsigned)) problems.push('state package hash is invalid');
  if (expectedSha256 && parsed.sha256 !== expectedSha256) {
    problems.push('state package does not match the report');
  }
  return { valid: problems.length === 0, problems, parsed };
}

function readStatePackage({ dataDir, date, expectedSha256 = null } = {}) {
  const file = statePackagePath(dataDir, date);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const validation = validateStatePackage(parsed, { date, expectedSha256 });
    return validation.valid ? { file, parsed, validation } : null;
  } catch {
    return null;
  }
}

module.exports = {
  SCHEMA,
  dateKey,
  readStatePackage,
  sha256Json,
  statePackagePath,
  validateStatePackage,
};
