#!/usr/bin/env node
'use strict';

// Companion to scripts/land.js. The installed hook consumes a one-use proof
// from the shared Git directory, bound to the tested commit and fetched base.
// Environment values alone are never authority to push master.
const fs = require('node:fs');
const {
  consumeLandPushProof,
  readLandPushProof,
  validateLandPushProof,
} = require('../lib/land-push-proof.js');

function parseUpdates(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 4)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({ localRef, localSha, remoteRef, remoteSha }));
}

function validateLandPush({
  updates = [],
  env = process.env,
  repoRoot = process.cwd(),
  readProof = readLandPushProof,
  consumeProof = consumeLandPushProof,
} = {}) {
  const master = updates.filter((row) => row.remoteRef === 'refs/heads/master');
  if (!master.length) return { ok: true, reason: 'not-master' };
  if (master.length !== 1) return { ok: false, reason: 'multiple-master-updates' };
  const update = master[0];
  const proofPath = env.SB_LAND_PUSH_PROOF;
  const token = env.SB_LAND_PUSH_TOKEN;
  if (!proofPath || !token) return { ok: false, reason: 'missing-one-use-proof' };
  let proof;
  try {
    proof = readProof(proofPath, repoRoot);
  } catch {
    return { ok: false, reason: 'unreadable-one-use-proof' };
  }
  const verdict = validateLandPushProof({ proof, token, localSha: update.localSha, remoteSha: update.remoteSha });
  if (!verdict.ok) return verdict;
  try {
    consumeProof(proofPath, repoRoot);
  } catch {
    return { ok: false, reason: 'proof-not-consumed' };
  }
  return verdict;
}

if (require.main === module) {
  const verdict = validateLandPush({ updates: parseUpdates(fs.readFileSync(0, 'utf8')) });
  if (!verdict.ok) {
    process.stderr.write(`\nERROR: master accepts a scoped land push only (${verdict.reason}). Run node scripts/land.js --apply.\n\n`);
    process.exit(1);
  }
}

module.exports = { parseUpdates, validateLandPush };
