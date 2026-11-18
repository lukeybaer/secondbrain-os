'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LEGACY_PROJECTION_SCHEMA = 'life_archive_otter_exact_call_people_projection.v1';
const PROJECTION_SCHEMA = 'life_archive_otter_exact_call_people_projection.v2';
const STAGED_PROJECTION_SCHEMA = 'life_archive_otter_exact_call_people_projection.v3';
const EXACT_PROJECTION_PROBLEM_CODE = 'exact_call_people_projection_proof_missing';
const HASH_RE = /^[a-f0-9]{64}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file, fsApi = fs) {
  return sha256(fsApi.readFileSync(file));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function receiptHash(receipt) {
  const canonical = { ...receipt };
  delete canonical.receipt_hash;
  return sha256(JSON.stringify(stableValue(canonical)));
}

function projectionReceiptPath({ vpDir, otid, sourceRevision }) {
  return path.join(
    path.resolve(vpDir),
    'otter-exact-call-people-projection-receipts',
    'calls',
    sha256(String(otid || '')),
    `${String(sourceRevision || '').toLowerCase()}.json`,
  );
}

function normalizeIdentities(identities) {
  return [...new Set((identities || []).map((value) => String(value || '').trim()).filter(Boolean))]
    .sort();
}

function stableLegacyPeoplePath(file) {
  const normalized = String(file || '').replace(/\\/g, '/');
  const memoryIndex = normalized.indexOf('/memory/');
  if (
    normalized.startsWith('/opt/secondbrain-releases/') &&
    memoryIndex >= 0
  ) {
    return `/opt/secondbrain${normalized.slice(memoryIndex)}`;
  }
  return file;
}

function buildExactCallProjectionReceipt({
  otid,
  sourceRevision,
  identities,
  files,
  evidence,
  gitRelay = null,
  producedAt = new Date().toISOString(),
}) {
  const durableGitRelay =
    gitRelay?.status === 'landed' &&
    String(gitRelay?.request_id || '').trim() &&
    /^[a-f0-9]{40}$/.test(String(gitRelay?.landed_commit_sha || '').toLowerCase()) &&
    HASH_RE.test(String(gitRelay?.relay_receipt_hash || '').toLowerCase());
  const durableStaging =
    gitRelay?.status === 'staged' &&
    String(gitRelay?.request_id || '').trim() &&
    HASH_RE.test(String(gitRelay?.staging_receipt_hash || '').toLowerCase());
  const receipt = {
    schema: durableStaging
      ? STAGED_PROJECTION_SCHEMA
      : durableGitRelay
        ? PROJECTION_SCHEMA
        : LEGACY_PROJECTION_SCHEMA,
    otid: String(otid || '').trim(),
    source_revision: String(sourceRevision || '').toLowerCase(),
    produced_at: producedAt,
    scope: {
      identities: normalizeIdentities(identities),
      archive_wide_mutation: false,
    },
    files: (files || [])
      .map((row) => ({
        person_id: String(row.person_id || '').trim(),
        path: path.resolve(String(row.path || '')),
        before_hash: String(row.before_hash || '').toLowerCase(),
        after_hash: String(row.after_hash || '').toLowerCase(),
        disposition: String(row.disposition || ''),
        preserved_richer_evidence: row.preserved_richer_evidence === true,
      }))
      .sort((a, b) => a.person_id.localeCompare(b.person_id) || a.path.localeCompare(b.path)),
    evidence: (evidence || [])
      .map((row) => ({
        path: path.resolve(String(row.path || '')),
        sha256: String(row.sha256 || '').toLowerCase(),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
  if (durableGitRelay) {
    receipt.git_relay = {
      request_id: String(gitRelay.request_id),
      status: 'landed',
      landed_commit_sha: String(gitRelay.landed_commit_sha).toLowerCase(),
      relay_receipt_hash: String(gitRelay.relay_receipt_hash).toLowerCase(),
    };
  }
  if (durableStaging) {
    receipt.git_relay = {
      request_id: String(gitRelay.request_id),
      status: 'staged',
      staging_receipt_hash: String(gitRelay.staging_receipt_hash).toLowerCase(),
    };
  }
  receipt.receipt_hash = receiptHash(receipt);
  return receipt;
}

function projectionReceiptProblems({
  receipt,
  otid,
  sourceRevision,
  identities,
  relayRequestsFile = '',
  relayReceiptsFile = '',
  fsApi = fs,
}) {
  const problems = [];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return ['exact-call People File projection receipt is invalid'];
  }
  const durableSchema = receipt.schema === PROJECTION_SCHEMA;
  const stagedSchema = receipt.schema === STAGED_PROJECTION_SCHEMA;
  const legacySchema = receipt.schema === LEGACY_PROJECTION_SCHEMA;
  if (!durableSchema && !stagedSchema && !legacySchema) problems.push('projection receipt schema is invalid');
  if (String(receipt.otid || '') !== String(otid || '')) {
    problems.push('projection receipt call id is not exact');
  }
  if (String(receipt.source_revision || '') !== String(sourceRevision || '').toLowerCase()) {
    problems.push('projection receipt source revision is not exact');
  }
  if (receipt.scope?.archive_wide_mutation !== false) {
    problems.push('projection receipt does not prove scoped mutation');
  }
  const expectedIdentities = normalizeIdentities(identities);
  const actualIdentities = normalizeIdentities(receipt.scope?.identities);
  if (JSON.stringify(actualIdentities) !== JSON.stringify(expectedIdentities)) {
    problems.push('projection receipt identity scope does not match exact call');
  }
  if (!Array.isArray(receipt.files) || receipt.files.length !== expectedIdentities.length) {
    problems.push('projection receipt file proofs are incomplete');
  }
  for (const personId of expectedIdentities) {
    const proof = (receipt.files || []).find((row) => String(row.person_id || '') === personId);
    if (!proof) {
      problems.push(`projection receipt lacks ${personId}`);
      continue;
    }
    if (!HASH_RE.test(String(proof.before_hash || '')) || !HASH_RE.test(String(proof.after_hash || ''))) {
      problems.push(`projection receipt hashes for ${personId} are invalid`);
      continue;
    }
    if (!String(proof.path || '').trim()) {
      problems.push(`projection receipt path for ${personId} is missing`);
      continue;
    }
    if (legacySchema) {
      const originalFile = path.resolve(String(proof.path || ''));
      const stableFile = stableLegacyPeoplePath(String(proof.path || ''));
      const file =
        fsApi.existsSync(originalFile) || stableFile === proof.path
          ? originalFile
          : stableFile;
      if (!fsApi.existsSync(file) || !fsApi.statSync(file).isFile()) {
        problems.push(`projected People File for ${personId} is missing`);
        continue;
      }
      if (sha256File(file, fsApi) !== proof.after_hash) {
        problems.push(`projected People File for ${personId} changed after exact receipt`);
      }
    }
  }
  if (durableSchema) {
    const relay = receipt.git_relay || {};
    if (
      !String(relay.request_id || '').trim() ||
      relay.status !== 'landed' ||
      !/^[a-f0-9]{40}$/.test(String(relay.landed_commit_sha || '').toLowerCase()) ||
      !HASH_RE.test(String(relay.relay_receipt_hash || '').toLowerCase())
    ) {
      problems.push('projection receipt lacks a durable landed git relay');
    } else if (!relayReceiptsFile || !fsApi.existsSync(relayReceiptsFile)) {
      problems.push('projection receipt landed git relay evidence is missing');
    } else {
      const matchingRelay = fsApi
        .readFileSync(relayReceiptsFile, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .find(
          (row) =>
            row.request_id === relay.request_id &&
            row.status === 'landed' &&
            String(row.landed_commit_sha || '').toLowerCase() ===
              String(relay.landed_commit_sha || '').toLowerCase() &&
            receiptHash(row) === String(relay.relay_receipt_hash || '').toLowerCase(),
        );
      if (!matchingRelay) {
        problems.push('projection receipt landed git relay row hash does not match');
      }
    }
  }
  if (stagedSchema) {
    const relay = receipt.git_relay || {};
    if (
      !String(relay.request_id || '').trim() ||
      relay.status !== 'staged' ||
      !HASH_RE.test(String(relay.staging_receipt_hash || '').toLowerCase())
    ) {
      problems.push('projection receipt lacks a durable accepted staging receipt');
    } else if (!relayRequestsFile || !fsApi.existsSync(relayRequestsFile)) {
      problems.push('projection receipt staging evidence is missing');
    } else {
      const requestRows = fsApi
        .readFileSync(relayRequestsFile, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .filter((row) => row.request_id === relay.request_id);
      const matchingRequest = requestRows.at(-1);
      const requestMatches =
        matchingRequest?.status === 'ready' &&
        receiptHash(matchingRequest) === String(relay.staging_receipt_hash || '').toLowerCase();
      if (!requestMatches) problems.push('projection receipt accepted staging row hash does not match');
    }
  }
  for (const item of receipt.evidence || []) {
    if (!HASH_RE.test(String(item.sha256 || ''))) {
      problems.push('projection receipt evidence hash is invalid');
    }
  }
  if (!HASH_RE.test(String(receipt.receipt_hash || '')) || receiptHash(receipt) !== receipt.receipt_hash) {
    problems.push('projection receipt hash is invalid');
  }
  return [...new Set(problems)];
}

function loadExactCallProjectionReceipt({
  vpDir,
  otid,
  sourceRevision,
  identities,
  fsApi = fs,
}) {
  const file = projectionReceiptPath({ vpDir, otid, sourceRevision });
  if (!fsApi.existsSync(file)) {
    return {
      ok: false,
      file,
      receipt: null,
      problems: ['exact-call People File projection receipt is missing'],
    };
  }
  let receipt = null;
  try {
    receipt = JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {
      ok: false,
      file,
      receipt: null,
      problems: ['exact-call People File projection receipt is unreadable'],
    };
  }
  const problems = projectionReceiptProblems({
    receipt,
    otid,
    sourceRevision,
    identities,
    relayRequestsFile: path.join(
      path.dirname(path.resolve(vpDir)),
      'people',
      'voice-git-people-sync-requests.jsonl',
    ),
    relayReceiptsFile: path.join(
      path.dirname(path.resolve(vpDir)),
      'people',
      'voice-git-people-sync-receipts.jsonl',
    ),
    fsApi,
  });
  return { ok: problems.length === 0, file, receipt, problems };
}

module.exports = {
  EXACT_PROJECTION_PROBLEM_CODE,
  LEGACY_PROJECTION_SCHEMA,
  PROJECTION_SCHEMA,
  STAGED_PROJECTION_SCHEMA,
  buildExactCallProjectionReceipt,
  loadExactCallProjectionReceipt,
  normalizeIdentities,
  projectionReceiptPath,
  projectionReceiptProblems,
  receiptHash,
  sha256File,
  stableLegacyPeoplePath,
};
