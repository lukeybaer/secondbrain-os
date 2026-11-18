'use strict';

const PROMPT_SAFE_ATTEMPT_SOURCE = 'agentic-healer-driver';
const PROMPT_SAFE_ATTEMPT_SCHEMA = 2;
const ATTEMPT_FIELDS = Object.freeze([
  ['tactic', 120],
  ['hypothesis', 240],
  ['action', 240],
  ['result', 120],
  ['liveOutcome', 120],
  ['whyNotClosed', 300],
  // #b Oct 19 2026 (Fix 3): what a watchdog-cut session had found so far.
  ['checkpoint', 300],
]);
const FORBIDDEN_ATTEMPT_DETAIL =
  /failed\s*predicate|candidate\s*well|source\s*candidate|rejection\s*ident|batch\s*id|ledger\s*total|producer\s*guess|pipeline\s*explanation|raw\s*(?:qc|defect)|dashboard-qc-result|briefing-repair-ledger/i;

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.join(', ')}`);
}

function safeAttemptText(value, max) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return FORBIDDEN_ATTEMPT_DETAIL.test(text) ? '[internal detail withheld]' : text;
}

function normalizeAttemptRow(row) {
  assertExactKeys(
    row,
    ATTEMPT_FIELDS.map(([key]) => key),
    'healer attempt',
  );
  return Object.fromEntries(
    ATTEMPT_FIELDS.map(([key, max]) => {
      const value = row[key];
      if (value != null && typeof value !== 'string') {
        throw new Error(`healer attempt ${key} must be a string`);
      }
      return [key, safeAttemptText(value, max)];
    }),
  );
}

function promptSafeAttemptFromTacticRow(row) {
  if (
    !row ||
    row.source !== PROMPT_SAFE_ATTEMPT_SOURCE ||
    Number(row.schemaVersion) !== PROMPT_SAFE_ATTEMPT_SCHEMA ||
    !row.promptSafeAttempt ||
    typeof row.promptSafeAttempt !== 'object' ||
    Array.isArray(row.promptSafeAttempt)
  ) {
    return null;
  }
  try {
    return normalizeAttemptRow(row.promptSafeAttempt);
  } catch {
    return null;
  }
}

function dedupeAttemptRows(rows, limit = 8) {
  const seen = new Set();
  return (rows || [])
    .map((row) => {
      try {
        return normalizeAttemptRow(row);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((row) => {
      const key = JSON.stringify(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-Math.max(1, Number(limit) || 8));
}

function descriptorLabel(descriptor, fingerprint = '') {
  return safeAttemptText(
    descriptor?.plan ||
      descriptor?.tactic ||
      descriptor?.kind ||
      fingerprint ||
      'unknown tactic',
    120,
  );
}

function attemptRowsFromCycleReceipts(receipts, {
  graphPath = '',
  coreComponentPath = '',
  processKey = '',
} = {}) {
  const allocations = new Map(
    (receipts || [])
      .filter((row) => row?.event === 'cycle_allocated' && row.lease_id)
      .map((row) => [row.lease_id, row]),
  );
  const rows = [];
  if (processKey || graphPath || coreComponentPath) {
    rows.push({
      tactic: 'exact-process-context',
      hypothesis: `Repair the exact process ${processKey || 'identified by the call graph'}, not a corpus-wide approximation.`,
      action: [
        graphPath ? `Inspect the exact call graph at ${graphPath}.` : '',
        coreComponentPath ? `Follow the current core component at ${coreComponentPath}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
      result: 'context loaded',
      liveOutcome: 'The call remains open and owns this repair process.',
      whyNotClosed: 'Use the attempt history below and do not repeat an unchanged tactic.',
    });
  }
  for (const completion of (receipts || []).filter((row) =>
    ['cycle_completed', 'lease_expired'].includes(String(row?.event || '')),
  )) {
    const allocation = allocations.get(completion.lease_id) || {};
    const descriptor =
      allocation.tactic_descriptor ||
      completion.tactic_descriptor ||
      {};
    const outcome = String(completion.outcome || 'unknown');
    const detail = String(completion.detail || '');
    rows.push({
      tactic: descriptorLabel(
        descriptor,
        completion.tactic_fingerprint || allocation.tactic_fingerprint,
      ),
      hypothesis:
        descriptor.hypothesis ||
        `The ${descriptor.plan || descriptor.kind || 'recorded'} repair could close ${completion.stage || allocation.stage || 'this exact stage'}.`,
      action:
        descriptor.action ||
        `Ran cycle ${completion.cycle || allocation.cycle || '?'} with input ${completion.input_fingerprint || allocation.input_fingerprint || 'fingerprint recorded in the cycle ledger'}.`,
      result: outcome,
      liveOutcome: detail || `The exact process reported ${outcome}.`,
      whyNotClosed:
        outcome === 'CLEARED'
          ? ''
          : detail || `The exact process remained open after ${outcome}.`,
    });
  }
  return dedupeAttemptRows(rows);
}

module.exports = {
  ATTEMPT_FIELDS,
  FORBIDDEN_ATTEMPT_DETAIL,
  PROMPT_SAFE_ATTEMPT_SCHEMA,
  PROMPT_SAFE_ATTEMPT_SOURCE,
  attemptRowsFromCycleReceipts,
  dedupeAttemptRows,
  normalizeAttemptRow,
  promptSafeAttemptFromTacticRow,
  safeAttemptText,
};
