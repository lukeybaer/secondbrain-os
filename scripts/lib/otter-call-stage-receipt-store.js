'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  REQUIRED_STAGES,
  stableStringify,
  sha256,
  hashReceipt,
  verifyOtterCallClosure,
} = require('./otter-call-closure-verifier.js');

const HASH_RE = /^[a-f0-9]{64}$/;

function validateCoordinates({ rootDir, callId, sourceRevision, stage } = {}) {
  if (!String(rootDir || '').trim()) throw new Error('rootDir is required');
  if (!String(callId || '').trim()) throw new Error('callId is required');
  if (!HASH_RE.test(String(sourceRevision || '').toLowerCase())) {
    throw new Error('sourceRevision must be a SHA-256 hash');
  }
  if (!REQUIRED_STAGES.includes(String(stage || ''))) {
    throw new Error(`unknown Otter closure stage: ${stage || '(missing)'}`);
  }
}

function callDirectoryKey(callId) {
  return sha256(String(callId || ''));
}

function stageReceiptPath({ rootDir, callId, sourceRevision, stage } = {}) {
  validateCoordinates({ rootDir, callId, sourceRevision, stage });
  const root = path.resolve(rootDir);
  const target = path.resolve(
    root,
    'calls',
    callDirectoryKey(callId),
    String(sourceRevision).toLowerCase(),
    `${stage}.json`,
  );
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('stage receipt path escaped rootDir');
  }
  return target;
}

function canonicalReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('receipt must be an object');
  }
  if (receipt.schema !== 'otter_stage_receipt.v1') {
    throw new Error('receipt schema must be otter_stage_receipt.v1');
  }
  if (!String(receipt.receipt_id || '').trim()) throw new Error('receipt_id is required');
  if (receipt.current !== true || receipt.superseded === true) {
    throw new Error('only a current, non-superseded stage receipt can be stored');
  }
  if (!Number.isFinite(Date.parse(String(receipt.produced_at || '')))) {
    throw new Error('receipt produced_at must be a timestamp');
  }
  validateCoordinates({
    rootDir: '.',
    callId: receipt.call_id,
    sourceRevision: receipt.source_revision,
    stage: receipt.stage,
  });

  const providedHash = String(receipt.receipt_hash || '').toLowerCase();
  const normalized = {
    ...receipt,
    source_revision: String(receipt.source_revision).toLowerCase(),
  };
  delete normalized.receipt_hash;
  const computedHash = hashReceipt(normalized);
  if (providedHash && (!HASH_RE.test(providedHash) || providedHash !== computedHash)) {
    throw new Error('receipt_hash does not match the canonical receipt SHA-256');
  }
  return { ...normalized, receipt_hash: computedHash };
}

function immutableConflict(file) {
  const error = new Error(`immutable receipt conflict at ${file}`);
  error.code = 'OTTER_RECEIPT_CONFLICT';
  return error;
}

function existingResult(file, canonicalBytes, fsApi) {
  const existing = fsApi.readFileSync(file, 'utf8');
  if (existing !== canonicalBytes) throw immutableConflict(file);
  return {
    created: false,
    idempotent: true,
    path: file,
    receipt: JSON.parse(existing),
  };
}

function publishImmutable(file, canonicalBytes, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  if (fsApi.existsSync(file)) return existingResult(file, canonicalBytes, fsApi);

  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  let fd;
  try {
    fd = fsApi.openSync(temp, 'wx', 0o600);
    try {
      fsApi.writeFileSync(fd, canonicalBytes, 'utf8');
      fsApi.fsyncSync(fd);
    } finally {
      fsApi.closeSync(fd);
      fd = undefined;
    }
    fsApi.linkSync(temp, file);
    return {
      created: true,
      idempotent: false,
      path: file,
      receipt: JSON.parse(canonicalBytes),
    };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return existingResult(file, canonicalBytes, fsApi);
  } finally {
    if (fd !== undefined) {
      try {
        fsApi.closeSync(fd);
      } catch {}
    }
    try {
      fsApi.unlinkSync(temp);
    } catch {}
  }
}

function writeStageReceipt({ rootDir, receipt, fsApi = fs } = {}) {
  const canonical = canonicalReceipt(receipt);
  const file = stageReceiptPath({
    rootDir,
    callId: canonical.call_id,
    sourceRevision: canonical.source_revision,
    stage: canonical.stage,
  });
  const canonicalBytes = `${stableStringify(canonical)}\n`;
  return publishImmutable(file, canonicalBytes, fsApi);
}

function validateLoadedReceipt(row, expected, problems) {
  const label = `${expected.stage} receipt`;
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    problems.push(`${label} is not an object`);
    return false;
  }
  if (row.schema !== 'otter_stage_receipt.v1') {
    problems.push(`${label} has an invalid schema`);
  }
  if (String(row.call_id || '') !== expected.callId) {
    problems.push(`${label} is for a different call`);
  }
  if (String(row.source_revision || '').toLowerCase() !== expected.sourceRevision) {
    problems.push(`${label} is for a different source revision`);
  }
  if (row.stage !== expected.stage) problems.push(`${label} declares a different stage`);
  if (row.current !== true || row.superseded === true) problems.push(`${label} is stale`);
  if (!HASH_RE.test(String(row.receipt_hash || '').toLowerCase())) {
    problems.push(`${label} lacks a canonical receipt hash`);
  } else if (hashReceipt(row) !== String(row.receipt_hash).toLowerCase()) {
    problems.push(`${label} receipt hash is corrupt`);
  }
  return !problems.some((problem) => problem.startsWith(label));
}

function loadStageReceipts({ rootDir, callId, sourceRevision, fsApi = fs } = {}) {
  const normalizedCallId = String(callId || '');
  const normalizedRevision = String(sourceRevision || '').toLowerCase();
  validateCoordinates({
    rootDir,
    callId: normalizedCallId,
    sourceRevision: normalizedRevision,
    stage: REQUIRED_STAGES[0],
  });

  const receipts = [];
  const missingStages = [];
  const problems = [];
  for (const stage of REQUIRED_STAGES) {
    const file = stageReceiptPath({
      rootDir,
      callId: normalizedCallId,
      sourceRevision: normalizedRevision,
      stage,
    });
    if (!fsApi.existsSync(file)) {
      missingStages.push(stage);
      continue;
    }
    let row;
    try {
      row = JSON.parse(fsApi.readFileSync(file, 'utf8'));
    } catch (error) {
      problems.push(`${stage} receipt cannot be decoded: ${error.message}`);
      continue;
    }
    if (
      validateLoadedReceipt(
        row,
        { callId: normalizedCallId, sourceRevision: normalizedRevision, stage },
        problems,
      )
    ) {
      receipts.push(row);
    }
  }
  return {
    schema: 'otter_stage_receipt_store_load.v1',
    call_id: normalizedCallId,
    source_revision: normalizedRevision,
    receipts,
    missing_stages: missingStages,
    problems,
  };
}

function identityGradeTrackIds(receipts = []) {
  const diarization = receipts.find((receipt) => receipt?.stage === 'diarization');
  return [
    ...new Set(
      (diarization?.payload?.tracks || [])
        .filter((track) => track?.identity_grade === true)
        .map((track) => String(track?.track_id || '').trim())
        .filter(Boolean),
    ),
  ].sort();
}

function canonicalStagingRequestsFile(rootDir) {
  return path.join(
    path.dirname(path.dirname(path.resolve(rootDir))),
    'people',
    'voice-git-people-sync-requests.jsonl',
  );
}

function loadJsonlRows(file, fsApi = fs) {
  if (!file || !fsApi.existsSync(file)) return [];
  return fsApi
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function verifyStoredOtterCallClosure({
  rootDir,
  callId,
  sourceRevision,
  expectedIdentityGradeTrackIds = [],
  stagingRequestsFile = '',
  fsApi = fs,
} = {}) {
  const store = loadStageReceipts({ rootDir, callId, sourceRevision, fsApi });
  const resolvedStagingRequestsFile =
    stagingRequestsFile || canonicalStagingRequestsFile(rootDir);
  const verification = verifyOtterCallClosure({
    callId: store.call_id,
    sourceRevision: store.source_revision,
    receipts: store.receipts,
    stagingRequestRows: loadJsonlRows(resolvedStagingRequestsFile, fsApi),
  });
  const receiptDir = path.dirname(
    stageReceiptPath({
      rootDir,
      callId: store.call_id,
      sourceRevision: store.source_revision,
      stage: REQUIRED_STAGES[0],
    }),
  );
  const correctionFile = path.join(receiptDir, '_correction_authorization.json');
  const exactEnvelopeBindingFile = path.join(receiptDir, '_exact_envelope_binding.json');
  let correctionAuthorization = null;
  if (fsApi.existsSync(correctionFile)) {
    try {
      const row = JSON.parse(fsApi.readFileSync(correctionFile, 'utf8'));
      let exactEnvelopeBinding = null;
      if (fsApi.existsSync(exactEnvelopeBindingFile)) {
        exactEnvelopeBinding = JSON.parse(
          fsApi.readFileSync(exactEnvelopeBindingFile, 'utf8'),
        );
      }
      const legacyEnvelopeUpgradeValid =
        row.reason_code !== 'legacy_receipt_set_exact_envelope_upgrade' ||
        (HASH_RE.test(String(row.exact_envelope_bundle_hash || '').toLowerCase()) &&
          exactEnvelopeBinding?.schema ===
            'otter_stage_receipt_exact_envelope_binding.v1' &&
          String(exactEnvelopeBinding.call_id || '') === store.call_id &&
          String(exactEnvelopeBinding.source_revision || '').toLowerCase() ===
            store.source_revision &&
          String(exactEnvelopeBinding.exact_envelope_bundle_hash || '').toLowerCase() ===
            String(row.exact_envelope_bundle_hash || '').toLowerCase());
      const peopleProjectionUpgradeValid =
        row.reason_code !== 'exact_people_projection_proof_upgrade' ||
        (Array.isArray(row.changed_track_ids) && row.changed_track_ids.length === 0);
      const canonicalRegistryUpgradeValid =
        row.reason_code !== 'canonical_registry_confirmed_identity_upgrade' ||
        (Array.isArray(row.changed_track_ids) &&
          row.changed_track_ids.length > 0 &&
          HASH_RE.test(String(row.canonical_registry_sha256 || '').toLowerCase()) &&
          /\/life-archive\/voice-identity-registry\.json$/.test(
            String(row.canonical_registry_path || '').replace(/\\/g, '/'),
          ));
      const valid =
        row?.schema === 'otter_stage_receipt_correction_authorization.v1' &&
        String(row.call_id || '') === store.call_id &&
        String(row.source_revision || '').toLowerCase() === store.source_revision &&
        [
          'owner_direct_identity_correction',
          'identity_grade_track_omitted_from_current_receipts',
          'producer_timebase_inference_defect',
          'mutable_enriched_projection_artifact_defect',
          'exact_people_projection_proof_upgrade',
          'legacy_receipt_set_exact_envelope_upgrade',
          'canonical_registry_confirmed_identity_upgrade',
        ]
          .includes(String(row.reason_code || '')) &&
        HASH_RE.test(String(row.superseded_receipt_set_hash || '').toLowerCase()) &&
        HASH_RE.test(String(row.replacement_receipt_set_hash || '').toLowerCase()) &&
        (!['producer_timebase_inference_defect', 'mutable_enriched_projection_artifact_defect'].includes(row.reason_code) ||
          (HASH_RE.test(
            String(row.producer_correction_authorization_hash || '').toLowerCase(),
          ) &&
            HASH_RE.test(String(row.prior_bundle_hash || '').toLowerCase()) &&
            HASH_RE.test(String(row.replacement_bundle_hash || '').toLowerCase()))) &&
        legacyEnvelopeUpgradeValid &&
        peopleProjectionUpgradeValid &&
        canonicalRegistryUpgradeValid &&
        String(row.replacement_manifest_hash || '').toLowerCase() ===
          String(verification?.manifest?.manifest_hash || '').toLowerCase();
      correctionAuthorization = {
        ok: valid,
        file: correctionFile,
        ...row,
      };
    } catch (error) {
      correctionAuthorization = {
        ok: false,
        file: correctionFile,
        problem: error.message,
      };
    }
  }
  const receiptTrackIds = new Set(identityGradeTrackIds(store.receipts));
  const missingIdentityGradeTracks = [
    ...new Set(
      (expectedIdentityGradeTrackIds || []).map((trackId) => String(trackId || '').trim()),
    ),
  ]
    .filter(Boolean)
    .filter((trackId) => !receiptTrackIds.has(trackId))
    .sort();
  // The durable closure moment is the newest verified receipt's produced_at.
  // The manifest is derived and carries no time, so without this a consumer
  // would fall back to its own evaluation clock and re-date old closures.
  const producedAtMs = store.receipts
    .map((receipt) => Date.parse(String(receipt?.produced_at || '')))
    .filter(Number.isFinite);
  const closedAt = producedAtMs.length ? new Date(Math.max(...producedAtMs)).toISOString() : '';
  const problems = [
    ...new Set([
      ...store.problems,
      ...verification.problems,
      ...missingIdentityGradeTracks.map(
        (trackId) =>
          `identity-grade track ${trackId} is absent from the current diarization receipt`,
      ),
    ]),
  ];
  return {
    ...verification,
    status: problems.length ? 'open' : verification.status,
    closed: problems.length === 0 && verification.closed,
    closed_at: problems.length === 0 && verification.closed ? closedAt : '',
    problems,
    expected_identity_grade_track_ids: [
      ...new Set(
        (expectedIdentityGradeTrackIds || []).map((trackId) =>
          String(trackId || '').trim(),
        ),
      ),
    ]
      .filter(Boolean)
      .sort(),
    receipt_identity_grade_track_ids: [...receiptTrackIds].sort(),
    correction_authorization: correctionAuthorization,
    store: {
      receipt_count: store.receipts.length,
      missing_stages: store.missing_stages,
      problems: store.problems,
    },
  };
}

module.exports = {
  callDirectoryKey,
  stageReceiptPath,
  canonicalReceipt,
  publishImmutable,
  writeStageReceipt,
  loadStageReceipts,
  identityGradeTrackIds,
  canonicalStagingRequestsFile,
  verifyStoredOtterCallClosure,
};
