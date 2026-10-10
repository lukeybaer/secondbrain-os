'use strict';

// A land push needs a proof that cannot be manufactured by merely setting an
// environment variable. The land process writes this small, one-use record in
// the shared Git directory after scoped tests pass; the installed pre-push hook
// reads and deletes it only when its commit and fetched base match the update.
// It is deliberately not a lease: it has no holder, TTL, renewal, or recovery
// behavior, and an aborted push simply removes the unused file.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROOF_SCHEMA = 'amy.land-push-proof.v1';
const PROOF_DIRNAME = 'amy-land-push-proofs';
const SHA_RE = /^[0-9a-f]{40}$/i;

function commonGitDir(repoRoot = process.cwd()) {
  const value = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return path.resolve(repoRoot, value);
}

function validSha(value) {
  return SHA_RE.test(String(value || ''));
}

function issueLandPushProof({ repoRoot, testedCommit, baseSha, operationId = '', now = new Date() } = {}) {
  if (!validSha(testedCommit) || !validSha(baseSha)) {
    throw new Error('land push proof requires full testedCommit and baseSha values');
  }
  const dir = path.join(commonGitDir(repoRoot), PROOF_DIRNAME);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString('hex');
  const file = path.join(dir, `proof-${process.pid}-${token.slice(0, 12)}.json`);
  const proof = {
    schema: PROOF_SCHEMA,
    issued_at: now.toISOString(),
    tested_commit: testedCommit,
    base_sha: baseSha,
    operation_id: String(operationId || ''),
    token,
  };
  fs.writeFileSync(file, `${JSON.stringify(proof)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { file, token, proof };
}

function isProofPathAllowed(file, repoRoot = process.cwd()) {
  if (!file) return false;
  const expected = path.join(commonGitDir(repoRoot), PROOF_DIRNAME) + path.sep;
  return path.resolve(file).startsWith(expected);
}

function readLandPushProof(file, repoRoot = process.cwd()) {
  if (!isProofPathAllowed(file, repoRoot)) throw new Error('land push proof path is outside the shared Git directory');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function consumeLandPushProof(file, repoRoot = process.cwd()) {
  if (!isProofPathAllowed(file, repoRoot)) throw new Error('land push proof path is outside the shared Git directory');
  fs.unlinkSync(file);
}

function validateLandPushProof({ proof, token, localSha, remoteSha } = {}) {
  if (!proof || proof.schema !== PROOF_SCHEMA) return { ok: false, reason: 'invalid-proof-schema' };
  if (!validSha(proof.tested_commit) || !validSha(proof.base_sha)) return { ok: false, reason: 'invalid-proof-sha' };
  if (!token || proof.token !== token) return { ok: false, reason: 'proof-token-mismatch' };
  if (proof.tested_commit !== localSha) return { ok: false, reason: 'tested-commit-mismatch' };
  if (proof.base_sha !== remoteSha) return { ok: false, reason: 'base-moved-or-unproved' };
  return { ok: true, reason: 'one-use-tested-land-proof' };
}

module.exports = {
  PROOF_DIRNAME,
  PROOF_SCHEMA,
  commonGitDir,
  consumeLandPushProof,
  isProofPathAllowed,
  issueLandPushProof,
  readLandPushProof,
  validateLandPushProof,
};
