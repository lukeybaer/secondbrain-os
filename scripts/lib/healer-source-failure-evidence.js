// scripts/lib/healer-source-failure-evidence.js
//
// When a card or System Health row is red because its SOURCE failed, the
// healer must see why the source failed: the command, exit code and error
// tail the card controller already recorded in its run receipt. Without it
// the healer saw only "<row>: RED", fixed the display, and the source stayed
// broken (#b 2026-10-30 S-2: otter-past-week failed on one empty call for
// three nights while the healer chased the tile).

const fs = require('fs');
const path = require('path');

const MAX_RECEIPT_BYTES = 50 * 1024 * 1024;
const TAIL_CHARS = 600;

function tail(text, max = TAIL_CHARS) {
  const value = String(text || '').trim();
  return value.length > max ? value.slice(-max) : value;
}

function familyCoversTarget(family, card) {
  const workUnitId = String((card && card.workUnitId) || '');
  const workUnitIds = Array.isArray(family.workUnitIds) ? family.workUnitIds.map(String) : [];
  if (workUnitId && workUnitIds.length) return workUnitIds.includes(workUnitId);
  const cardId = String((card && card.id) || '');
  if (!cardId) return false;
  return [family.cardIds, family.refreshTargetIds].some(
    (ids) => Array.isArray(ids) && ids.map(String).includes(cardId),
  );
}

// The whole date's runs are scanned, so unrelated activity can never push a
// failure out of view; the cap only bounds a pathological directory. Parsed
// receipts are cached by path, mtime and size because every pending target
// reads the same day.
const MAX_RECEIPTS_SCANNED = 500;
const receiptCache = new Map();

function readReceiptCached(row) {
  const key = `${row.file}|${row.mtimeMs}|${row.size}`;
  if (receiptCache.has(key)) return receiptCache.get(key);
  const receipt = JSON.parse(fs.readFileSync(row.file, 'utf8'));
  if (receiptCache.size > 2000) receiptCache.clear();
  receiptCache.set(key, receipt);
  return receipt;
}

// Controller run receipts for the date, newest first, each read only when it
// is a sane size. A receipt mid-write or corrupt is skipped.
function recentControllerReceipts(runDir, limit = MAX_RECEIPTS_SCANNED) {
  let files = [];
  try {
    files = fs
      .readdirSync(runDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const file = path.join(runDir, name);
        const stat = fs.statSync(file);
        return { file, mtimeMs: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
  const out = [];
  for (const row of files) {
    if (out.length >= limit) break;
    if (row.size > MAX_RECEIPT_BYTES) continue;
    try {
      out.push({ file: row.file, receipt: readReceiptCached(row) });
    } catch {
      // Try the next newest.
    }
  }
  return out;
}

// A family row that ran nothing proves nothing either way: a no-spin retry on
// unchanged input, a capacity deferral, an intentional skip, a preflight
// block, or a family the controller deadline reached before it started. An
// empty commands array is NOT that: in-process producers fail with no command
// rows and their error is the evidence.
function familyRanNothing(family) {
  return Boolean(
    family.noSpin ||
      family.capacityDeferred ||
      family.skipped ||
      family.preflightBlocked ||
      family.deadlineSkipped,
  );
}

// Failed source families that feed this target, with each failed command's
// bounded evidence. Per family, the newest receipt that actually RAN it
// decides: a later green run clears the evidence, while a newer unrelated run
// or a no-spin retry leaves the original failure visible.
function sourceFailureEvidence({ runDir, card } = {}) {
  if (!runDir || !card) return [];
  const decided = new Map();
  for (const { file, receipt } of recentControllerReceipts(runDir)) {
    const families = Array.isArray(receipt.sourceFamilies) ? receipt.sourceFamilies : [];
    for (const family of families) {
      if (!family || !familyCoversTarget(family, card)) continue;
      const name = String(family.family || 'unknown');
      if (decided.has(name)) continue;
      // Any green row clears, including a skip that kept a fresh proven source.
      if (family.ok === true && !family.noSpin && !family.capacityDeferred) {
        decided.set(name, null);
        continue;
      }
      if (family.ok !== false || familyRanNothing(family)) continue;
      decided.set(name, {
        family: name,
        runId: String(receipt.runId || path.basename(file, '.json')),
        error: tail(family.error, 300),
        commands: (Array.isArray(family.commands) ? family.commands : [])
          .filter((command) => command && command.ok === false)
          .slice(0, 3)
          .map((command) => ({
            args: (Array.isArray(command.args) ? command.args : [])
              .map(String)
              .join(' ')
              .slice(0, 300),
            exitCode: command.exitCode,
            timedOut: !!command.timedOut,
            // stderr first; a producer that prints its error to stdout still
            // leaves cause evidence.
            errorTail: tail(command.stderr) || tail(command.stdout),
          })),
      });
    }
  }
  return [...decided.values()].filter(Boolean);
}

function formatSourceFailureEvidence(identity, failures = []) {
  if (!failures.length) return '';
  const lines = [`  ${identity}:`];
  for (const failure of failures) {
    lines.push(
      `    source family "${failure.family}" FAILED in controller run ${failure.runId}${
        failure.error ? `: ${failure.error}` : ''
      }`,
    );
    for (const command of failure.commands) {
      lines.push(
        `    command: ${command.args || '(unknown)'}; exit ${command.exitCode}${
          command.timedOut ? ' (timed out)' : ''
        }`,
      );
      if (command.errorTail) lines.push(`    error tail: ${command.errorTail.replace(/\s+/g, ' ')}`);
    }
  }
  return lines.join('\n');
}

const SOURCE_FAILURE_CONSTRAINT =
  '- When SOURCE FAILURE EVIDENCE names a failed source for your row, the repair must make that source command exit green. A change that only alters card display, scoping or labels while the source still fails is not a fix; do not report it as repaired.';

module.exports = {
  sourceFailureEvidence,
  formatSourceFailureEvidence,
  familyCoversTarget,
  SOURCE_FAILURE_CONSTRAINT,
};
