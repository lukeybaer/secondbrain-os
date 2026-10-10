'use strict';

const crypto = require('node:crypto');

const REQUIRED_STAGES = Object.freeze([
  'raw_archive',
  'full_audio',
  'diarization',
  'embeddings',
  'membership',
  'naming',
  'people_file_projection',
]);
const AUDIO_CODECS = new Set(['aac', 'flac', 'm4a', 'mp3', 'mp4', 'opus', 'wav']);
const MEMBERSHIP_DISPOSITIONS = new Set([
  'matched',
  'unmatched_with_proof',
  'human_blocked',
]);
const NAMING_DISPOSITIONS = new Set([
  'accepted',
  'proposed_with_proof',
  'unresolved_with_proof',
  'human_blocked',
]);
const PEOPLE_FILE_NA_REASONS = new Set([
  'no_accepted_identity',
  'projection_already_current',
]);
const HASH_RE = /^[a-f0-9]{64}$/;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hashReceipt(receipt) {
  const withoutHash = {};
  for (const [key, value] of Object.entries(receipt || {})) {
    if (key !== 'receipt_hash') withoutHash[key] = value;
  }
  return sha256(stableStringify(withoutHash));
}

function isHash(value) {
  return HASH_RE.test(String(value || '').toLowerCase());
}

function isPositiveNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function hasText(value) {
  return Boolean(String(value || '').trim());
}

function proofBackedDisposition(value, allowedStatuses) {
  return (
    value &&
    allowedStatuses.has(String(value.status || '')) &&
    hasText(value.reason) &&
    isHash(value.proof_hash)
  );
}

function collectEvidenceHashes(value, output = new Set(), key = '') {
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceHashes(item, output, key);
    return output;
  }
  if (!value || typeof value !== 'object') {
    if (/(^|_)hash$/.test(key) && key !== 'receipt_hash' && isHash(value)) {
      output.add(String(value).toLowerCase());
    }
    return output;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    collectEvidenceHashes(childValue, output, childKey);
  }
  return output;
}

function derivedManifest(callId, sourceRevision, receipts) {
  const rows = (Array.isArray(receipts) ? receipts : [])
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      stage: String(row.stage || ''),
      receipt_id: String(row.receipt_id || ''),
      receipt_hash: String(row.receipt_hash || ''),
      computed_receipt_hash: hashReceipt(row),
      evidence_hashes: [...collectEvidenceHashes(row.payload)].sort(),
    }))
    .sort(
      (left, right) =>
        left.receipt_id.localeCompare(right.receipt_id) ||
        left.stage.localeCompare(right.stage),
    );
  const body = {
    schema: 'otter_exact_call_closure_manifest.v1',
    call_id: String(callId || ''),
    source_revision: String(sourceRevision || ''),
    receipt_count: rows.length,
    receipts: rows,
  };
  return {
    ...body,
    manifest_hash: sha256(stableStringify(body)),
  };
}

function pushMissingCoverage(problems, stage, kind, expectedIds, actualIds) {
  const missing = expectedIds.filter((id) => !actualIds.has(id));
  if (missing.length) {
    problems.push(`${stage} is missing ${kind}(s): ${missing.sort().join(', ')}`);
  }
}

function validateNotApplicable(payload, stage, problems) {
  if (
    payload?.disposition !== 'not_applicable' ||
    payload?.reason_code !== 'no_eligible_tracks' ||
    !hasText(payload?.reason) ||
    !isHash(payload?.proof_hash)
  ) {
    problems.push(`${stage} requires explicit no-eligible-tracks N/A proof`);
  }
}

function validateRawArchive(receipt, sourceRevision, problems) {
  const raw = receipt?.payload?.raw_archive;
  const local = receipt?.payload?.local_archive;
  if (
    !raw ||
    !/^s3:\/\/[^/]+\/.+/.test(String(raw.uri || '')) ||
    !isPositiveNumber(raw.bytes) ||
    raw.content_hash !== sourceRevision ||
    String(raw.checksum_sha256 || '') !==
      Buffer.from(sourceRevision, 'hex').toString('base64') ||
    !hasText(raw.etag)
  ) {
    problems.push(
      'durable raw archive proof is missing, is not remote, or does not match the source revision',
    );
  }
  if (
    !local ||
    !hasText(local.path) ||
    !isPositiveNumber(local.bytes) ||
    local.content_hash !== sourceRevision
  ) {
    problems.push('local archive proof is missing or does not match the source revision');
  }
  if (raw && local && Number(raw.bytes) !== Number(local.bytes)) {
    problems.push('raw and local archive byte counts do not match');
  }
}

function validateFullAudio(receipt, problems) {
  const audio = receipt?.payload || {};
  if (!isHash(audio.audio_hash)) problems.push('full audio hash is missing or invalid');
  if (!AUDIO_CODECS.has(String(audio.codec || '').toLowerCase())) {
    problems.push('full audio codec is missing or unsupported');
  }
  if (!isPositiveNumber(audio.bytes)) problems.push('full audio byte count is missing or invalid');
  if (!isPositiveNumber(audio.duration_seconds)) {
    problems.push('full audio duration is missing or invalid');
  }
  if (audio.decodable !== true) problems.push('full audio has no successful decode proof');
}

function validateDiarization(receipt, problems) {
  const payload = receipt?.payload || {};
  const tracks = Array.isArray(payload.tracks) ? payload.tracks : [];
  if (payload.mode === 'explicit_fallback') {
    if (
      !hasText(payload.reason_code) ||
      !hasText(payload.reason) ||
      !isHash(payload.proof_hash)
    ) {
      problems.push('diarization fallback lacks an explicit proof-backed disposition');
    }
    if (tracks.length) problems.push('diarization fallback cannot declare speaker tracks');
    return [];
  }
  if (payload.mode !== 'diarized') {
    problems.push('diarization mode is neither diarized nor an explicit fallback');
    return [];
  }
  if (!tracks.length) problems.push('diarization has no tracks and no explicit fallback');
  const seen = new Set();
  for (const track of tracks) {
    const trackId = String(track?.track_id || '');
    if (!trackId) {
      problems.push('diarization contains a track without a track_id');
      continue;
    }
    if (seen.has(trackId)) problems.push(`diarization contains duplicate track: ${trackId}`);
    seen.add(trackId);
    if (typeof track.identity_grade !== 'boolean') {
      problems.push(`diarization track ${trackId} lacks an identity_grade disposition`);
    }
    if (typeof track.membership_eligible !== 'boolean') {
      problems.push(`diarization track ${trackId} lacks a membership_eligible disposition`);
    }
    if (track.identity_grade === true && track.membership_eligible !== true) {
      problems.push(
        `diarization track ${trackId} is identity-grade but not membership-eligible`,
      );
    }
  }
  return tracks;
}

function validateEmbeddings(receipt, tracks, problems) {
  const expected = tracks
    .filter((track) => track?.identity_grade === true)
    .map((track) => String(track.track_id));
  const items = Array.isArray(receipt?.payload?.items) ? receipt.payload.items : [];
  if (!expected.length) {
    validateNotApplicable(receipt?.payload, 'embeddings', problems);
    if (items.length) problems.push('embeddings N/A proof cannot include embedding items');
    return;
  }
  const actual = new Set();
  const knownTracks = new Set(tracks.map((track) => String(track.track_id)));
  for (const item of items) {
    const trackId = String(item?.track_id || '');
    if (!trackId) {
      problems.push('embeddings contains an item without a track_id');
      continue;
    }
    if (actual.has(trackId)) problems.push(`embeddings contains duplicate track: ${trackId}`);
    actual.add(trackId);
    if (!knownTracks.has(trackId)) problems.push(`embeddings contains unknown track: ${trackId}`);
    if (
      !isHash(item.embedding_hash) ||
      !hasText(item.model) ||
      !hasText(item.model_version)
    ) {
      problems.push(`embedding for ${trackId} lacks hash, model, or model version`);
    }
  }
  pushMissingCoverage(problems, 'embeddings', 'identity-grade track', expected, actual);
}

function validateMembership(receipt, tracks, problems) {
  const expected = tracks
    .filter((track) => track?.membership_eligible === true)
    .map((track) => String(track.track_id));
  const rows = Array.isArray(receipt?.payload?.dispositions)
    ? receipt.payload.dispositions
    : [];
  if (!expected.length) {
    validateNotApplicable(receipt?.payload, 'membership', problems);
    if (rows.length) problems.push('membership N/A proof cannot include dispositions');
    return;
  }
  const actual = new Set();
  const expectedSet = new Set(expected);
  for (const row of rows) {
    const trackId = String(row?.track_id || '');
    if (!trackId) {
      problems.push('membership contains a disposition without a track_id');
      continue;
    }
    if (actual.has(trackId)) problems.push(`membership contains duplicate track: ${trackId}`);
    actual.add(trackId);
    if (!expectedSet.has(trackId)) {
      problems.push(`membership contains ineligible track: ${trackId}`);
    }
    if (!MEMBERSHIP_DISPOSITIONS.has(String(row.status || ''))) {
      problems.push(`membership for ${trackId} lacks a terminal disposition`);
    } else if (row.status === 'matched') {
      if (!hasText(row.identity_id) || !isHash(row.evidence_hash)) {
        problems.push(`matched membership for ${trackId} lacks identity or evidence`);
      }
    } else if (!hasText(row.reason) || !isHash(row.evidence_hash)) {
      problems.push(`${row.status} membership for ${trackId} lacks proof`);
    }
  }
  pushMissingCoverage(problems, 'membership', 'eligible track disposition', expected, actual);
}

function validateNaming(receipt, tracks, problems) {
  const expected = tracks
    .filter((track) => track?.membership_eligible === true)
    .map((track) => String(track.track_id));
  const rows = Array.isArray(receipt?.payload?.dispositions)
    ? receipt.payload.dispositions
    : [];
  if (!expected.length) {
    validateNotApplicable(receipt?.payload, 'naming', problems);
    if (rows.length) problems.push('naming N/A proof cannot include dispositions');
    return [];
  }
  const actual = new Set();
  const expectedSet = new Set(expected);
  for (const row of rows) {
    const trackId = String(row?.track_id || '');
    if (!trackId) {
      problems.push('naming contains a disposition without a track_id');
      continue;
    }
    if (actual.has(trackId)) problems.push(`naming contains duplicate track: ${trackId}`);
    actual.add(trackId);
    if (!expectedSet.has(trackId)) problems.push(`naming contains ineligible track: ${trackId}`);
    if (!NAMING_DISPOSITIONS.has(String(row.status || ''))) {
      problems.push(`naming for ${trackId} lacks an allowed terminal disposition`);
    } else if (row.status === 'accepted') {
      if (!hasText(row.person_id) || !isHash(row.evidence_hash)) {
        problems.push(`accepted naming for ${trackId} lacks person or evidence`);
      }
    } else if (row.status === 'proposed_with_proof') {
      if (
        !hasText(row.proposed_name) ||
        !hasText(row.reason) ||
        !isHash(row.evidence_hash)
      ) {
        problems.push(`proposed naming for ${trackId} lacks name, reason, or evidence`);
      }
    } else if (!hasText(row.reason) || !isHash(row.evidence_hash)) {
      problems.push(`${row.status} naming for ${trackId} lacks proof`);
    }
  }
  pushMissingCoverage(problems, 'naming', 'eligible track disposition', expected, actual);
  return rows;
}

function durableStagingRequestProof(payload, stagingRequestRows) {
  if (
    !hasText(payload.staging_request_id) ||
    !isHash(payload.staging_receipt_hash) ||
    !isHash(payload.staging_proof_binding_hash)
  ) {
    return false;
  }
  const expectedBindingHash = sha256(
    stableStringify({
      request_id: payload.staging_request_id,
      staging_receipt_hash: payload.staging_receipt_hash,
      projection_receipt_hash: payload.proof_hash,
    }),
  );
  if (payload.staging_proof_binding_hash !== expectedBindingHash) return false;

  const matchingRequest = (Array.isArray(stagingRequestRows) ? stagingRequestRows : [])
    .filter(
      (row) =>
        row &&
        typeof row === 'object' &&
        !Array.isArray(row) &&
        String(row.request_id || '') === String(payload.staging_request_id),
    )
    .at(-1);
  if (
    matchingRequest?.schema !== 'life_archive_voice_git_people_sync_request.v1' ||
    matchingRequest?.status !== 'ready'
  ) {
    return false;
  }
  const computedRequestHash = hashReceipt(matchingRequest);
  const recordedRequestHash = String(matchingRequest.receipt_hash || '').toLowerCase();
  if (recordedRequestHash && (!isHash(recordedRequestHash) || recordedRequestHash !== computedRequestHash)) {
    return false;
  }
  return computedRequestHash === String(payload.staging_receipt_hash).toLowerCase();
}

function validatePeopleFile(receipt, namingRows, stagingRequestRows, problems) {
  const payload = receipt?.payload || {};
  const acceptedCount = namingRows.filter((row) => row?.status === 'accepted').length;
  if (payload.disposition === 'scoped_projection_receipt') {
    const expectedPeople = new Set(
      namingRows
        .filter((row) => row?.status === 'accepted')
        .map((row) => String(row.person_id || ''))
        .filter(Boolean),
    );
    const files = Array.isArray(payload.files) ? payload.files : [];
    const actualPeople = new Set();
    const hasStagedFile = files.some((proof) => String(proof?.disposition || '') === 'staged');
    if (
      payload.reason_code !== 'exact_call_identity_scope_projected' ||
      !hasText(payload.reason) ||
      !isHash(payload.proof_hash)
    ) {
      problems.push('scoped People File projection lacks exact-call proof');
    }
    if (hasStagedFile && !durableStagingRequestProof(payload, stagingRequestRows)) {
      problems.push('scoped staged People File projection lacks durable staging proof');
    }
    for (const proof of files) {
      const personId = String(proof?.person_id || '');
      if (!personId || actualPeople.has(personId)) {
        problems.push('scoped People File projection has a missing or duplicate person');
        continue;
      }
      actualPeople.add(personId);
      if (
        !isHash(proof.before_hash) ||
        !isHash(proof.after_hash) ||
        !hasText(proof.path) ||
        !['written', 'already_current', 'staged'].includes(String(proof.disposition || ''))
      ) {
        problems.push(`scoped People File projection proof for ${personId} is incomplete`);
      }
    }
    pushMissingCoverage(
      problems,
      'people_file_projection',
      'accepted person',
      [...expectedPeople],
      actualPeople,
    );
    for (const personId of actualPeople) {
      if (!expectedPeople.has(personId)) {
        problems.push(`People File projection contains out-of-scope person: ${personId}`);
      }
    }
    return;
  }
  if (payload.disposition === 'landed') {
    if (
      !isHash(payload.after_hash) ||
      !hasText(payload.landing_receipt_id) ||
      !/^[a-f0-9]{40}$/i.test(String(payload.landed_commit_sha || ''))
    ) {
      problems.push(
        'People File projection lacks an after-hash, landed receipt, or landed commit',
      );
    }
    return;
  }
  if (payload.disposition !== 'not_applicable') {
    problems.push('People File projection is neither landed nor explicitly N/A');
    return;
  }
  if (
    !PEOPLE_FILE_NA_REASONS.has(String(payload.reason_code || '')) ||
    !hasText(payload.reason) ||
    !isHash(payload.proof_hash)
  ) {
    problems.push('People File N/A disposition lacks an allowed proof');
    return;
  }
  if (payload.reason_code === 'no_accepted_identity' && acceptedCount > 0) {
    problems.push('People File cannot be N/A for no accepted identity when naming accepted one');
  }
  if (payload.reason_code === 'projection_already_current' && !isHash(payload.after_hash)) {
    problems.push('already-current People File N/A proof lacks the current after-hash');
  }
}

function validateReceiptEnvelope(receipt, callId, sourceRevision, problems, seenIds) {
  const stage = String(receipt?.stage || 'unknown');
  const receiptId = String(receipt?.receipt_id || '');
  if (receipt?.schema !== 'otter_stage_receipt.v1') {
    problems.push(`${stage} receipt ${receiptId || '(missing id)'} has an invalid schema`);
  }
  if (!receiptId) {
    problems.push(`${stage} receipt is missing receipt_id`);
  } else if (seenIds.has(receiptId)) {
    problems.push(`duplicate receipt_id: ${receiptId}`);
  }
  seenIds.add(receiptId);
  if (String(receipt?.call_id || '') !== callId) {
    problems.push(`${stage} receipt ${receiptId} is for a different call`);
  }
  if (String(receipt?.source_revision || '') !== sourceRevision) {
    problems.push(`${stage} receipt ${receiptId} is for a different source revision`);
  }
  if (receipt?.current !== true || receipt?.superseded === true) {
    problems.push(`${stage} receipt ${receiptId} is stale`);
  }
  if (!Number.isFinite(Date.parse(String(receipt?.produced_at || '')))) {
    problems.push(`${stage} receipt ${receiptId} lacks a valid produced_at timestamp`);
  }
  const computedHash = hashReceipt(receipt);
  if (!isHash(receipt?.receipt_hash) || computedHash !== receipt.receipt_hash) {
    problems.push(`${stage} receipt ${receiptId} receipt hash is corrupt`);
  }
  if (receipt?.status === 'degraded') {
    if (
      !proofBackedDisposition(
        receipt.degradation_disposition,
        new Set(['accepted_with_proof']),
      )
    ) {
      problems.push(`${stage} receipt ${receiptId} is degraded without a proof-backed disposition`);
    }
  } else if (receipt?.status !== 'complete') {
    problems.push(
      `${stage} receipt ${receiptId} has non-terminal status: ${receipt?.status || 'missing'}`,
    );
  }
}

function verifyOtterCallClosure({
  callId,
  sourceRevision,
  receipts,
  stagingRequestRows = [],
} = {}) {
  const normalizedCallId = String(callId || '');
  const normalizedRevision = String(sourceRevision || '').toLowerCase();
  const rows = Array.isArray(receipts) ? receipts : [];
  const problems = [];
  if (!normalizedCallId) problems.push('callId is required');
  if (!isHash(normalizedRevision)) {
    problems.push('sourceRevision must be the canonical raw payload SHA-256');
  }
  if (!Array.isArray(receipts)) problems.push('receipts must be an array');

  const byStage = new Map();
  const seenIds = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      problems.push('receipt set contains a non-object row');
      continue;
    }
    validateReceiptEnvelope(row, normalizedCallId, normalizedRevision, problems, seenIds);
    const stage = String(row.stage || '');
    if (!REQUIRED_STAGES.includes(stage)) {
      problems.push(`unknown stage receipt: ${stage || '(missing)'}`);
      continue;
    }
    if (byStage.has(stage)) problems.push(`duplicate stage receipt: ${stage}`);
    else byStage.set(stage, row);
  }
  for (const stage of REQUIRED_STAGES) {
    if (!byStage.has(stage)) problems.push(`missing required stage receipt: ${stage}`);
  }

  if (byStage.has('raw_archive')) {
    validateRawArchive(byStage.get('raw_archive'), normalizedRevision, problems);
  }
  if (byStage.has('full_audio')) validateFullAudio(byStage.get('full_audio'), problems);
  const tracks = byStage.has('diarization')
    ? validateDiarization(byStage.get('diarization'), problems)
    : [];
  if (byStage.has('embeddings')) {
    validateEmbeddings(byStage.get('embeddings'), tracks, problems);
  }
  if (byStage.has('membership')) {
    validateMembership(byStage.get('membership'), tracks, problems);
  }
  const namingRows = byStage.has('naming')
    ? validateNaming(byStage.get('naming'), tracks, problems)
    : [];
  if (byStage.has('people_file_projection')) {
    validatePeopleFile(
      byStage.get('people_file_projection'),
      namingRows,
      stagingRequestRows,
      problems,
    );
  }

  const manifest = derivedManifest(normalizedCallId, normalizedRevision, rows);
  return {
    schema: 'otter_exact_call_closure_verification.v1',
    status: problems.length ? 'open' : 'closed',
    closed: problems.length === 0,
    call_id: normalizedCallId,
    source_revision: normalizedRevision,
    problems: [...new Set(problems)],
    manifest,
  };
}

module.exports = {
  REQUIRED_STAGES,
  AUDIO_CODECS,
  MEMBERSHIP_DISPOSITIONS,
  NAMING_DISPOSITIONS,
  PEOPLE_FILE_NA_REASONS,
  stableStringify,
  sha256,
  hashReceipt,
  derivedManifest,
  verifyOtterCallClosure,
};
