'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PRINCIPALS = new Set(['ExampleCo', 'PRIVATE_NAME']);
const ROW_RE = /^(g\d+)\s*\|\s*(.*?)\s*\|\s*auth:([^|]+)\|\s*kw:([^|]*)\|\s*enf:([^|]+)\|\s*([A-Z ]+)\s*$/;
const UNIT_INDEPENDENCE_AUTHORITY = 'memory/requirements/unit-independence.md';

function ctDateString(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.?\//, '');
}

function parseGravity(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(ROW_RE);
    if (!match) continue;
    const [, id, law, auth, keywords, enforcement, status] = match;
    const authPaths = auth
      .split(';')
      .map((x) => normalizePath(x.trim()))
      .filter(Boolean);
    const enforcementPaths = enforcement
      .split(';')
      .map((entry) => {
        const value = entry.trim().replace(/^[^:]+:/, '').replace(/@[^/]+$/, '');
        return normalizePath(value);
      })
      .filter((value) => value.includes('/'));
    rows.push({
      id,
      law: law.trim(),
      authPaths,
      keywords: keywords.trim(),
      enforcementPaths,
      status: status.trim(),
    });
  }
  return rows;
}

function declaredRatifiedCount(text) {
  const match = String(text || '').match(/Ratified (?:laws|rows):\s*(?:\*\*)?(\d+)(?:\*\*)?/i);
  return match ? Number(match[1]) : null;
}

function gravityStructure(text) {
  const rows = parseGravity(text);
  const ids = rows.map((x) => x.id);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  const declared = declaredRatifiedCount(text);
  return {
    ok:
      rows.length > 0 &&
      declared === rows.length &&
      duplicateIds.length === 0 &&
      rows.every((row) =>
        ['SOLID', 'PARTIAL', 'POLICY', 'PROPOSED', 'GAP'].includes(row.status),
      ),
    declared,
    rowCount: rows.length,
    duplicateIds: [...new Set(duplicateIds)],
    rows,
  };
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function semanticAuthorityPaths(rows) {
  return new Set([
    'memory/AMY_GRAVITY.md',
    'memory/AMY_AUTHORIZATIONS.md',
    // This small, stable acceptance contract defines the approved outcome.
    // Method code and its ordinary tests remain freely editable.
    'scripts/__tests__/unit-independence-contract.test.js',
    ...rows.flatMap((row) => row.authPaths),
  ]);
}

// g27 is intentionally a narrow protected trace.  Its requirement is a
// separately owned canonical file, so a future edit cannot silently detach
// that authority by deleting or redirecting the row while leaving the
// requirement behind.  Do not generalize this into another policy framework:
// the existing same-day approval, ledger, and impact-note gate remains the
// enforcement mechanism.
function unitIndependenceAuthorityProtected(repoRoot, rows) {
  if (!fs.existsSync(path.join(repoRoot, ...UNIT_INDEPENDENCE_AUTHORITY.split('/')))) {
    return true;
  }
  const row = rows.find((candidate) => candidate.id === 'g27');
  return !!row && row.authPaths.length === 1 && row.authPaths[0] === UNIT_INDEPENDENCE_AUTHORITY;
}

function enforcementPaths(rows) {
  return new Set(rows.flatMap((row) => row.enforcementPaths));
}

function ledgerAmendedRows(file, date) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
    try {
      const row = JSON.parse(line);
      if (String(row.date || '').startsWith(date) && Array.isArray(row.amendedRows)) {
        rows.push(...row.amendedRows);
      }
    } catch {
      /* unparseable ledger lines never satisfy identity */
    }
  }
  return [...new Set(rows)];
}

function ledgerHasApproval(file, approval, date) {
  if (!fs.existsSync(file)) return false;
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => {
      try {
        const row = JSON.parse(line);
        return (
          String(row.date || '').startsWith(date) &&
          String(row.approvedBy || '').toLowerCase() ===
            String(approval.approvedBy || '').toLowerCase()
        );
      } catch {
        return false;
      }
    });
}

function evaluateGravityChange({
  root,
  changedFiles = [],
  now = new Date(),
  gravityText,
} = {}) {
  const repoRoot = path.resolve(root || path.join(__dirname, '..', '..'));
  const gravityPath = path.join(repoRoot, 'memory', 'AMY_GRAVITY.md');
  const text =
    gravityText === undefined ? fs.readFileSync(gravityPath, 'utf8') : String(gravityText);
  const structure = gravityStructure(text);
  if (!structure.ok) {
    return { ok: false, classification: 'invalid-gravity-index', structure, reasons: ['gravity-index-invalid'] };
  }
  if (!unitIndependenceAuthorityProtected(repoRoot, structure.rows)) {
    return {
      ok: false,
      classification: 'invalid-gravity-index',
      structure,
      reasons: ['unit-independence-authority-link-invalid'],
    };
  }
  const normalized = [...new Set(changedFiles.map(normalizePath))];
  const authority = semanticAuthorityPaths(structure.rows);
  const enforcement = enforcementPaths(structure.rows);
  const semanticFiles = normalized.filter((file) => authority.has(file));
  const methodFiles = normalized.filter((file) => enforcement.has(file) && !authority.has(file));
  if (!semanticFiles.length) {
    return {
      ok: true,
      classification: methodFiles.length ? 'method-only' : 'ordinary',
      semanticFiles,
      methodFiles,
      structure,
      reasons: [],
    };
  }

  const date = ctDateString(now);
  const approvalPath = path.join(repoRoot, 'data', 'agent', 'gravity-amendment-approval.json');
  const ledgerPath = path.join(repoRoot, 'data', 'agent', 'gravity-amendments.jsonl');
  const impactPath = path.join(
    repoRoot,
    'data',
    'agent',
    `gravity-amendment-impact-${date}.md`,
  );
  const approval = safeReadJson(approvalPath);
  const reasons = [];
  if (!approval) reasons.push('approval-missing');
  else {
    if (!PRINCIPALS.has(String(approval.approvedBy || '').toLowerCase())) {
      reasons.push('approval-not-principal');
    }
    if (approval.date !== date) reasons.push('approval-not-same-day');
    if (!String(approval.reason || '').trim()) reasons.push('approval-reason-missing');
  }
  if (!fs.existsSync(impactPath)) reasons.push('impact-note-missing');
  else {
    // Receipt identity, not just date: a same-day impact note written for a
    // DIFFERENT amendment must not green this one (Codex review 2026-08-02).
    const impactText = fs.readFileSync(impactPath, 'utf8').toLowerCase();
    const missingRows = ledgerAmendedRows(ledgerPath, date).filter(
      (id) => !impactText.includes(String(id).toLowerCase()),
    );
    if (missingRows.length > 0) {
      reasons.push('impact-note-mismatch:' + missingRows.join(','));
    }
  }
  if (approval && !ledgerHasApproval(ledgerPath, approval, date)) {
    reasons.push('amendment-ledger-missing');
  }
  return {
    ok: reasons.length === 0,
    classification: 'semantic',
    semanticFiles,
    methodFiles,
    structure,
    approvalPath,
    ledgerPath,
    impactPath,
    reasons,
  };
}

module.exports = {
  PRINCIPALS,
  ctDateString,
  declaredRatifiedCount,
  enforcementPaths,
  evaluateGravityChange,
  gravityStructure,
  parseGravity,
  semanticAuthorityPaths,
  UNIT_INDEPENDENCE_AUTHORITY,
  unitIndependenceAuthorityProtected,
};
