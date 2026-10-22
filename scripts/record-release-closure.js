#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? String(argv[index + 1] || '') : '';
}

const DEPLOYMENT_STEPS = [
  'immutableSwap',
  'health',
  'deployReceipt',
  'scheduleNormalization',
  'currentReleaseCanary',
  'provenanceActivation',
  'parity',
];
const STANDALONE_REPAINT_TARGET_PREFIX = 'standalone-deploy-repaint:';

function receiptEntriesForSha(file, releaseSha) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        const row = JSON.parse(line);
        return row && row.releaseSha === releaseSha
          ? {
              row,
              line,
              lineNumber: index + 1,
              digest: crypto.createHash('sha256').update(line).digest('hex'),
            }
          : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function receiptsForSha(file, releaseSha) {
  return receiptEntriesForSha(file, releaseSha).map((entry) => entry.row);
}

// The deploy pipeline writes exactly ONE pending-exact-repaint anchor row
// per deployed SHA (deploy-ec2-server.sh: targetId
// "standalone-deploy-repaint:<sha>"). PACKET E1: a batched integration sweep
// deploys once for several closure ids sharing that one SHA, so MULTIPLE
// 'complete' rows (one per targetId) now legitimately reference the SAME
// anchor -- looking only at the SHA's most-recently-appended row (any
// status) would let the FIRST closure's 'complete' write shadow the anchor
// for every sibling that closes after it. Matching on the anchor's own
// still-pending status instead, regardless of how many later rows for
// sibling targetIds have already been appended, keeps every sibling
// evidence-valid without weakening the single-target case (there was never
// more than one row to find there either).
function latestPendingReceiptForSha(file, releaseSha) {
  const pending = receiptEntriesForSha(file, releaseSha).filter(
    (entry) => entry.row.status === 'pending-exact-repaint',
  );
  return pending.length ? pending[pending.length - 1] : null;
}

function latestPendingReleaseClosureAnchor(file, releaseSha) {
  return latestPendingReceiptForSha(file, releaseSha);
}

function pendingTargetEntries(file, releaseSha, targetId) {
  return receiptEntriesForSha(file, releaseSha).filter(
    (entry) =>
      entry.row.status === 'pending-exact-repaint' &&
      entry.row.stage === 'deployment-proved' &&
      entry.row.targetId === String(targetId || ''),
  );
}

function writeReleaseClosureReceipt({
  dataDir,
  sha,
  stage = 'complete',
  targetId = '',
  completedAt = new Date().toISOString(),
  expectedAnchorDigest = '',
} = {}) {
  const releaseSha = String(sha || '').trim();
  if (!releaseSha) throw new Error('release closure receipt requires sha');
  const dir = path.join(dataDir, 'agent');
  const file = path.join(dir, 'release-closure-receipts.jsonl');
  const final = stage === 'complete';
  // Deployment retries are allowed to resume an exact SHA, but must not add a
  // second pending standalone target.  The consumer deliberately refuses an
  // ambiguous anchor, so keeping this writer idempotent is what makes a
  // same-SHA deploy retry consumable instead of permanently wedging closure.
  // The deployment script has one durable target per immutable source SHA.
  // An identical retry must reuse that target: there is no deployment nonce in
  // the release identity, and a second pending row would make its consumer
  // ambiguous.  Do not apply this rule to card/integration targets; they are
  // separate closures that can legitimately share a deployed SHA.
  if (
    !final &&
    stage === 'deployment-proved' &&
    String(targetId || '').startsWith(STANDALONE_REPAINT_TARGET_PREFIX)
  ) {
    const existing = pendingTargetEntries(file, releaseSha, targetId);
    if (existing.length > 1) {
      throw new Error(
        `release ${releaseSha} has ambiguous pending deployment receipts for target ${targetId}`,
      );
    }
    if (existing.length === 1) {
      const row = existing[0].row;
      if (
        row.steps?.exactOwningUnitRepaint === 'pending' &&
        DEPLOYMENT_STEPS.every((step) => row.steps?.[step] === 'passed')
      ) {
        return { file, row, reused: true };
      }
      throw new Error(`release ${releaseSha} has an invalid pending deployment receipt for target ${targetId}`);
    }
  }
  const priorEntry = final ? latestPendingReceiptForSha(file, releaseSha) : null;
  const prior = priorEntry?.row || null;
  if (
    final &&
    (!prior || DEPLOYMENT_STEPS.some((step) => prior.steps?.[step] !== 'passed'))
  ) {
    throw new Error(
      `release ${releaseSha} cannot close without its prior same-SHA deployment-proved receipt`,
    );
  }
  if (final && expectedAnchorDigest && priorEntry.digest !== expectedAnchorDigest) {
    throw new Error(
      `release ${releaseSha} cannot close because its deployment-proved receipt changed after repaint claim`,
    );
  }
  const row = {
    schemaVersion: 1,
    type: 'release-closure',
    releaseSha,
    status: final ? 'complete' : 'pending-exact-repaint',
    stage: final ? 'complete' : 'deployment-proved',
    targetId: String(targetId || ''),
    completedAt,
    steps: {
      ...(final
        ? prior.steps
        : Object.fromEntries(DEPLOYMENT_STEPS.map((step) => [step, 'passed']))),
      exactOwningUnitRepaint: final ? 'passed' : 'pending',
    },
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return { file, row };
}

if (require.main === module) {
  const dataDir =
    argValue(process.argv.slice(2), '--data-dir') ||
    process.env.SECONDBRAIN_DATA_DIR ||
    '/opt/secondbrain/data';
  const sha = argValue(process.argv.slice(2), '--sha');
  const stage = argValue(process.argv.slice(2), '--stage') || 'complete';
  const targetId = argValue(process.argv.slice(2), '--target');
  const result = writeReleaseClosureReceipt({ dataDir, sha, stage, targetId });
  process.stdout.write(`${JSON.stringify(result.row)}\n`);
}

module.exports = {
  DEPLOYMENT_STEPS,
  STANDALONE_REPAINT_TARGET_PREFIX,
  receiptEntriesForSha,
  latestPendingReleaseClosureAnchor,
  pendingTargetEntries,
  writeReleaseClosureReceipt,
};
