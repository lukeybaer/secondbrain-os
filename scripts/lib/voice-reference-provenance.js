'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HASH_RE = /^[a-f0-9]{64}$/;
const PROVENANCE_SCHEMA = 'life_archive_voice_reference_provenance.v1';
const RECEIPT_SCHEMA = 'life_archive_legacy_voice_reference_migration_receipt.v1';
const AUDIT_SCHEMA = 'life_archive_legacy_voice_reference_migration_audit.v1';
const MIGRATION_ID = 'legacy-known-voice-baseline-2026-07-28';
const MIGRATION_AUTHORITY = Object.freeze({
  principal_id: 'ExampleCo',
  authorization_id: 'ExampleCo_direct_2026-07-28_trusted_voice_baseline',
});
const RECEIPTS_RELATIVE_ROOT = path.join(
  'life-archive',
  'voiceprints',
  'legacy-reference-migration-receipts',
);
const RAW_INDEX_CACHE = new Map();
// The migration CLI is intentionally one-shot. A long-lived caller must start a
// new process before tracing newly arrived raw files so this immutable scan
// cannot change underneath one audit.

function resolveRegistryPersonId(registry, personId) {
  let current = String(personId || '').trim().replace(/^person:/, '');
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const next = String(registry?.person_id_aliases?.[current] || '')
      .trim()
      .replace(/^person:/, '');
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function baselineEnrollmentRecord(enrollment) {
  const record = clone(enrollment || {});
  delete record.reference_provenance;
  return record;
}

function enrollmentRecordHash(enrollment) {
  return sha256(stableJson(baselineEnrollmentRecord(enrollment)));
}

function authorityMatches(authority) {
  return (
    authority?.principal_id === MIGRATION_AUTHORITY.principal_id &&
    authority?.authorization_id === MIGRATION_AUTHORITY.authorization_id
  );
}

function hashField(value) {
  return HASH_RE.test(String(value || '').toLowerCase());
}

function hasFullySourceVersionedProvenance(enrollment) {
  return (
    hashField(enrollment?.source_revision_hash) &&
    hashField(enrollment?.reference_audio_sha256) &&
    hashField(enrollment?.segment_evidence_sha256) &&
    hashField(enrollment?.probe_sha256) &&
    hashField(enrollment?.evidence_hash) &&
    Boolean(String(enrollment?.model || '').trim()) &&
    Boolean(String(enrollment?.model_version || '').trim())
  );
}

function confirmedKnownReferenceScope(registry, enrollment) {
  if (!String(enrollment?.enrollment_id || '').trim()) {
    return { in_scope: false, reason: 'missing_enrollment_id' };
  }
  if (enrollment?.calibration_quarantine_status === 'quarantined') {
    return { in_scope: false, reason: 'reference_quarantined' };
  }
  if (!String(enrollment?.model || '').trim()) {
    return { in_scope: false, reason: 'missing_reference_model' };
  }
  const storedPersonId = String(enrollment?.person_id || '').trim();
  const personId = resolveRegistryPersonId(registry, storedPersonId);
  const person = registry?.people?.[personId] || {};
  const personConfirmed =
    person.identity_confirmation_status === 'confirmed_by_ExampleCo' &&
    person.voiceprint_status === 'enrolled';
  const clusterId =
    enrollment?.voice_cluster_id ||
    enrollment?.source_voice_cluster_id ||
    '';
  const resolution = clusterId
    ? registry?.voice_cluster_resolutions?.[clusterId]
    : null;
  const resolutionConfirmed =
    resolution?.status === 'confirmed_by_ExampleCo' &&
    (!resolution.person_id ||
      resolveRegistryPersonId(registry, resolution.person_id) === personId);
  if (!personConfirmed && !resolutionConfirmed) {
    return {
      in_scope: false,
      reason: 'person_not_confirmed_and_enrolled',
    };
  }
  return { in_scope: true, reason: 'known_reference' };
}

function resolveStoredDataPath(storedPath, dataDir, fsApi = fs) {
  const stored = String(storedPath || '').trim();
  if (!stored) return '';
  if (path.isAbsolute(stored) && fsApi.existsSync(stored)) return stored;
  const normalized = stored.replace(/\\/g, '/');
  const dataIndex = normalized.lastIndexOf('data/');
  return dataIndex >= 0
    ? path.resolve(dataDir, normalized.slice(dataIndex + 'data/'.length))
    : path.resolve(dataDir, normalized);
}

function fileSha256(file, fsApi = fs) {
  return sha256(fsApi.readFileSync(file));
}

function existingNonemptyFile(file, fsApi = fs) {
  try {
    const stat = fsApi.statSync(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function readJsonFile(file, fsApi = fs) {
  try {
    return JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function sourceClusterId(enrollment) {
  const direct = String(enrollment?.source_voice_cluster_id || '').trim();
  if (direct) return direct;
  const source = String(enrollment?.source_id || '');
  return source.startsWith('voice_cluster:')
    ? source.slice('voice_cluster:'.length)
    : '';
}

function rawFileForOtid(dataRoot, otid, fsApi = fs) {
  const cacheKey = `${path.resolve(dataRoot)}:${fsApi === fs ? 'native' : 'custom'}`;
  let index = RAW_INDEX_CACHE.get(cacheKey);
  if (!index) {
    index = new Map();
    const rawDir = path.join(dataRoot, 'otter', 'raw');
    let names = [];
    try {
      names = fsApi.readdirSync(rawDir);
    } catch {
      RAW_INDEX_CACHE.set(cacheKey, index);
      return '';
    }
    for (const name of names) {
      if (!String(name).endsWith('.json')) continue;
      const file = path.join(rawDir, name);
      const raw = readJsonFile(file, fsApi);
      const rawOtid = String(raw?.otid || raw?.id || '');
      if (rawOtid && !index.has(rawOtid)) index.set(rawOtid, file);
    }
    RAW_INDEX_CACHE.set(cacheKey, index);
  }
  return index.get(otid) || '';
}

function traceFromIdentityEvents(clusterId, roots, primaryDataRoot, fsApi = fs) {
  for (const root of roots) {
    const eventsFile = path.join(
      root,
      'life-archive',
      'people',
      'speaker-identity-change-events.jsonl',
    );
    let lines = [];
    try {
      lines = fsApi.readFileSync(eventsFile, 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.includes(clusterId)) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const matchingState = [event?.before, event?.after].find(
        (state) =>
          state?.acoustic_unknown_id === clusterId ||
          state?.unknown_speaker_id === clusterId ||
          String(state?.identity_key || '').includes(clusterId),
      );
      if (!matchingState) continue;
      const trackParts = String(event?.track_key || '').split('|');
      const otid = String(matchingState.otid || trackParts[0] || '').trim();
      const label = String(
        matchingState.speaker_model_label || trackParts[1] || '',
      ).trim();
      if (!otid || !label) continue;
      const audioDir = path.join(root, 'otter', 'audio', otid);
      let audioNames = [];
      try {
        audioNames = fsApi
          .readdirSync(audioDir)
          .filter((name) =>
            String(name).startsWith(`track-label-${label}-`),
          )
          .sort((left, right) => {
            const leftPrimary = String(left).includes('-start-') ? 0 : 1;
            const rightPrimary = String(right).includes('-start-') ? 0 : 1;
            return leftPrimary - rightPrimary || String(left).localeCompare(String(right));
          });
      } catch {
        continue;
      }
      const audioName = audioNames.find((name) =>
        existingNonemptyFile(path.join(audioDir, name), fsApi),
      );
      if (!audioName) continue;
      const audioFile = path.join(audioDir, audioName);
      const rawFile = rawFileForOtid(root, otid, fsApi);
      const enrichedFile = path.join(root, 'otter', 'enriched', `${otid}.json`);
      const enriched = readJsonFile(enrichedFile, fsApi);
      const hasLabel = Array.isArray(enriched?.segments)
        ? enriched.segments.some(
            (segment) =>
              String(
                segment?.speaker_model_label ??
                  segment?.speaker_id ??
                  segment?.speaker ??
                  '',
              ) === label,
          )
        : false;
      if (!rawFile || !hasLabel) continue;
      const trace = {
        status: 'resolved_relocation',
        reason: 'exact_identity_event_track_verified',
        source_voice_cluster_id: clusterId,
        source_identity_event_path: `data/${path
          .relative(root, eventsFile)
          .replace(/\\/g, '/')}`,
        source_identity_event_sha256: sha256(line),
        selected_audio_path: `data/${path
          .relative(root, audioFile)
          .replace(/\\/g, '/')}`,
        selected_audio_sha256: fileSha256(audioFile, fsApi),
        selected_audio_size: fsApi.statSync(audioFile).size,
        selected_otid: otid,
        selected_speaker_model_label: label,
        raw_path: `data/${path.relative(root, rawFile).replace(/\\/g, '/')}`,
        raw_sha256: fileSha256(rawFile, fsApi),
        enriched_path: `data/${path
          .relative(root, enrichedFile)
          .replace(/\\/g, '/')}`,
        enriched_sha256: fileSha256(enrichedFile, fsApi),
        data_root_alias_used:
          root === primaryDataRoot ? 'current_data_root' : 'moved_path_alias',
      };
      trace.evidence_hash = sha256(stableJson(trace));
      return trace;
    }
  }
  return null;
}

function traceLegacyReferenceAudio(
  enrollment,
  { dataDir, aliasDataRoots = [], fsApi = fs } = {},
) {
  const primaryDataRoot = path.resolve(
    dataDir ||
      process.env.SECONDBRAIN_DATA_DIR ||
      path.join(__dirname, '..', '..', 'data'),
  );
  const roots = [
    ...new Set(
      [primaryDataRoot, ...aliasDataRoots]
        .filter(Boolean)
        .map((root) => path.resolve(root)),
    ),
  ];
  const clusterId = sourceClusterId(enrollment);
  const clusterSuffix = clusterId.replace(/^unknown_voice_ecapa_/, '');
  if (!clusterId || !/^[a-zA-Z0-9._-]+$/.test(clusterSuffix)) {
    return {
      status: 'ambiguous',
      reason: 'source_cluster_missing_or_invalid',
      source_voice_cluster_id: clusterId,
    };
  }
  let sequenceFile = '';
  let sequence = null;
  let sequenceRoot = '';
  for (const root of roots) {
    const candidate = path.join(
      root,
      'life-archive',
      'voiceprints',
      `voice-sequence-${clusterSuffix}.json`,
    );
    const parsed = readJsonFile(candidate, fsApi);
    if (!parsed) continue;
    sequenceFile = candidate;
    sequence = parsed;
    sequenceRoot = root;
    break;
  }
  if (!sequence) {
    const eventTrace = traceFromIdentityEvents(
      clusterId,
      roots,
      primaryDataRoot,
      fsApi,
    );
    if (eventTrace) return eventTrace;
    return {
      status: 'ambiguous',
      reason: 'source_sequence_missing',
      source_voice_cluster_id: clusterId,
    };
  }
  if (String(sequence.target || '') !== clusterId) {
    return {
      status: 'ambiguous',
      reason: 'source_sequence_target_mismatch',
      source_voice_cluster_id: clusterId,
      source_sequence_path: path
        .relative(sequenceRoot, sequenceFile)
        .replace(/\\/g, '/'),
    };
  }
  const samples = Array.isArray(sequence.samples) ? sequence.samples : [];
  let locatedAudio = 0;
  const unsupported = [];
  for (const sample of samples) {
    const storedAudio = String(sample?.audio || '').trim();
    const otid = String(sample?.otid || '').trim();
    const label = String(sample?.label || '').trim();
    if (!storedAudio || !otid || !label) continue;
    let audioFile = '';
    let audioRoot = '';
    for (const root of roots) {
      const candidate = resolveStoredDataPath(storedAudio, root, fsApi);
      if (!existingNonemptyFile(candidate, fsApi)) continue;
      audioFile = candidate;
      audioRoot = root;
      break;
    }
    if (!audioFile) continue;
    locatedAudio += 1;
    let rawFile = '';
    let enrichedFile = '';
    let evidenceRoot = '';
    for (const root of roots) {
      const rawCandidate = rawFileForOtid(root, otid, fsApi);
      const enrichedCandidate = path.join(root, 'otter', 'enriched', `${otid}.json`);
      const enriched = readJsonFile(enrichedCandidate, fsApi);
      const hasLabel = Array.isArray(enriched?.segments)
        ? enriched.segments.some(
            (segment) =>
              String(
                segment?.speaker_model_label ??
                  segment?.speaker_id ??
                  segment?.speaker ??
                  '',
              ) === label,
          )
        : false;
      if (!rawCandidate || !hasLabel) continue;
      rawFile = rawCandidate;
      enrichedFile = enrichedCandidate;
      evidenceRoot = root;
      break;
    }
    if (!rawFile || !enrichedFile) {
      unsupported.push({
        otid,
        label,
        audio_path: storedAudio,
        reason: 'raw_or_enriched_identity_evidence_missing',
      });
      continue;
    }
    const trace = {
      status: 'resolved_relocation',
      reason: 'exact_sequence_sample_verified',
      source_voice_cluster_id: clusterId,
      source_sequence_path: `data/${path
        .relative(sequenceRoot, sequenceFile)
        .replace(/\\/g, '/')}`,
      source_sequence_sha256: fileSha256(sequenceFile, fsApi),
      selected_audio_path: storedAudio.replace(/\\/g, '/'),
      selected_audio_sha256: fileSha256(audioFile, fsApi),
      selected_audio_size: fsApi.statSync(audioFile).size,
      selected_otid: otid,
      selected_speaker_model_label: label,
      raw_path: `data/${path.relative(evidenceRoot, rawFile).replace(/\\/g, '/')}`,
      raw_sha256: fileSha256(rawFile, fsApi),
      enriched_path: `data/${path
        .relative(evidenceRoot, enrichedFile)
        .replace(/\\/g, '/')}`,
      enriched_sha256: fileSha256(enrichedFile, fsApi),
      candidate_samples: samples.length,
      located_audio_samples: locatedAudio,
      data_root_alias_used:
        audioRoot === primaryDataRoot && evidenceRoot === primaryDataRoot
          ? 'current_data_root'
          : 'moved_path_alias',
    };
    trace.evidence_hash = sha256(stableJson(trace));
    return trace;
  }
  return {
    status: locatedAudio > 0 ? 'ambiguous' : 'genuinely_missing',
    reason:
      locatedAudio > 0
        ? 'located_audio_lacks_exact_raw_enriched_support'
        : 'sequence_audio_absent_from_all_roots',
    source_voice_cluster_id: clusterId,
    source_sequence_path: `data/${path
      .relative(sequenceRoot, sequenceFile)
      .replace(/\\/g, '/')}`,
    source_sequence_sha256: fileSha256(sequenceFile, fsApi),
    candidate_samples: samples.length,
    located_audio_samples: locatedAudio,
    unsupported_candidates: unsupported,
  };
}

function referenceAudioCapability(
  enrollment,
  { dataDir, fsApi = fs } = {},
) {
  const stored = String(
    enrollment?.reference_audio_rel ||
      enrollment?.reference_audio_path ||
      '',
  ).trim();
  if (!stored) {
    const traceStatus = enrollment?.reference_audio_trace?.status;
    return {
      matchable: false,
      capability:
        traceStatus === 'genuinely_missing'
          ? 'legacy_trusted_genuinely_missing'
          : 'legacy_trusted_audio_trace_ambiguous',
      reason:
        traceStatus === 'genuinely_missing'
          ? 'sequence_audio_absent_from_all_roots'
          : enrollment?.reference_audio_trace?.reason ||
            'reference_audio_trace_required',
      audio_path: '',
    };
  }
  const defaultDataDir = path.resolve(
    process.env.SECONDBRAIN_DATA_DIR ||
      path.join(__dirname, '..', '..', 'data'),
  );
  const effectiveDataDir = path.resolve(dataDir || defaultDataDir);
  const resolved = resolveStoredDataPath(stored, effectiveDataDir, fsApi);
  if (existingNonemptyFile(resolved, fsApi)) {
    return {
      matchable: true,
      capability: 'legacy_trusted_matchable',
      reason: '',
      audio_path: resolved,
    };
  }
  const traceStatus = enrollment?.reference_audio_trace?.status;
  return {
    matchable: false,
    capability:
      traceStatus === 'genuinely_missing'
        ? 'legacy_trusted_genuinely_missing'
        : 'legacy_trusted_audio_trace_ambiguous',
    reason:
      traceStatus === 'genuinely_missing'
        ? 'sequence_audio_absent_from_all_roots'
        : enrollment?.reference_audio_trace?.reason ||
          'reference_audio_pointer_unresolved',
    audio_path: resolved,
  };
}

function safeReceiptRelativePath(enrollmentId, recordHash) {
  const safeId = String(enrollmentId || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 100);
  return path.join(
    RECEIPTS_RELATIVE_ROOT,
    safeId || sha256(String(enrollmentId || '')).slice(0, 20),
    `${recordHash}.json`,
  );
}

function resolveReceiptPath(dataDir, relativePath) {
  const root = path.resolve(dataDir, RECEIPTS_RELATIVE_ROOT);
  const resolved = path.resolve(dataDir, String(relativePath || ''));
  const prefix = `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    return { ok: false, reason: 'legacy_trusted_receipt_path_out_of_scope' };
  }
  return { ok: true, path: resolved };
}

function receiptBytes(receipt) {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function buildLegacyReceipt({
  enrollment,
  authority,
  migratedAt,
  acousticCapability,
}) {
  const record = baselineEnrollmentRecord(enrollment);
  return {
    schema: RECEIPT_SCHEMA,
    migration_id: MIGRATION_ID,
    migrated_at: migratedAt,
    migration_authority: clone(authority),
    eligibility_basis: 'legacy_trusted',
    attestation_scope:
      'existing_known_voice_enrollment_record_integrity_only',
    acoustic_capability_at_migration: acousticCapability.capability,
    acoustic_non_matchable_reason_at_migration:
      acousticCapability.reason || null,
    enrollment_id: String(enrollment.enrollment_id),
    person_id: String(enrollment.person_id || ''),
    model: String(enrollment.model || ''),
    attested_record_sha256: sha256(stableJson(record)),
    attested_record: record,
  };
}

function buildLegacyStamp({ receipt, receiptPath }) {
  const bytes = receiptBytes(receipt);
  return {
    schema: PROVENANCE_SCHEMA,
    eligibility_basis: 'legacy_trusted',
    migration_id: MIGRATION_ID,
    migrated_at: receipt.migrated_at,
    migration_authority: clone(receipt.migration_authority),
    attestation_scope: receipt.attestation_scope,
    acoustic_capability_at_migration:
      receipt.acoustic_capability_at_migration,
    enrollment_record_sha256: receipt.attested_record_sha256,
    receipt_path: receiptPath.replace(/\\/g, '/'),
    receipt_sha256: sha256(bytes),
  };
}

function validateLegacyTrustedReference(
  enrollment,
  { dataDir, fsApi = fs } = {},
) {
  const provenance = enrollment?.reference_provenance;
  if (
    provenance?.schema !== PROVENANCE_SCHEMA ||
    provenance?.eligibility_basis !== 'legacy_trusted' ||
    provenance?.migration_id !== MIGRATION_ID ||
    provenance?.attestation_scope !==
      'existing_known_voice_enrollment_record_integrity_only'
  ) {
    return { valid: false, reason: 'legacy_trusted_attestation_missing_or_invalid' };
  }
  if (!authorityMatches(provenance.migration_authority)) {
    return { valid: false, reason: 'legacy_trusted_authority_invalid' };
  }
  const currentRecordHash = enrollmentRecordHash(enrollment);
  if (currentRecordHash !== provenance.enrollment_record_sha256) {
    return { valid: false, reason: 'legacy_trusted_record_hash_mismatch' };
  }
  const resolved = resolveReceiptPath(dataDir, provenance.receipt_path);
  if (!resolved.ok) return { valid: false, reason: resolved.reason };
  if (!fsApi.existsSync(resolved.path)) {
    return { valid: false, reason: 'legacy_trusted_receipt_missing' };
  }
  const bytes = fsApi.readFileSync(resolved.path, 'utf8');
  if (sha256(bytes) !== provenance.receipt_sha256) {
    return { valid: false, reason: 'legacy_trusted_receipt_hash_mismatch' };
  }
  let receipt;
  try {
    receipt = JSON.parse(bytes.replace(/^\uFEFF/, ''));
  } catch {
    return { valid: false, reason: 'legacy_trusted_receipt_invalid_json' };
  }
  if (
    receipt?.schema !== RECEIPT_SCHEMA ||
    receipt?.migration_id !== MIGRATION_ID ||
    receipt?.eligibility_basis !== 'legacy_trusted' ||
    receipt?.attestation_scope !== provenance.attestation_scope ||
    receipt?.acoustic_capability_at_migration !==
      provenance.acoustic_capability_at_migration ||
    ![
      'legacy_trusted_matchable',
      'legacy_trusted_audio_trace_ambiguous',
      'legacy_trusted_genuinely_missing',
    ].includes(receipt?.acoustic_capability_at_migration) ||
    receipt?.migrated_at !== provenance.migrated_at ||
    !authorityMatches(receipt?.migration_authority) ||
    receipt?.enrollment_id !== String(enrollment.enrollment_id || '') ||
    receipt?.person_id !== String(enrollment.person_id || '') ||
    receipt?.model !== String(enrollment.model || '') ||
    receipt?.attested_record_sha256 !== currentRecordHash ||
    sha256(stableJson(receipt?.attested_record || {})) !== currentRecordHash
  ) {
    return { valid: false, reason: 'legacy_trusted_receipt_contract_mismatch' };
  }
  return {
    valid: true,
    eligibility_basis: 'legacy_trusted',
    evidence_hash: provenance.receipt_sha256,
    enrollment_record_sha256: currentRecordHash,
    receipt_path: provenance.receipt_path,
  };
}

function referenceEligibility(
  registry,
  enrollment,
  { dataDir, fsApi = fs } = {},
) {
  const scope = confirmedKnownReferenceScope(registry, enrollment);
  if (!scope.in_scope) {
    return { eligible: false, reason: scope.reason };
  }
  const acoustic = referenceAudioCapability(enrollment, { dataDir, fsApi });
  if (hasFullySourceVersionedProvenance(enrollment)) {
    return {
      eligible: true,
      eligibility_basis: 'source_versioned',
      acoustic_matchable: acoustic.matchable,
      acoustic_capability: acoustic.matchable
        ? 'source_versioned_matchable'
        : 'source_versioned_audio_pointer_unresolved',
      acoustic_non_matchable_reason: acoustic.reason || null,
      evidence_hash: String(enrollment.evidence_hash).toLowerCase(),
      enrollment_record_sha256: enrollmentRecordHash(enrollment),
    };
  }
  if (enrollment?.reference_provenance) {
    const legacy = validateLegacyTrustedReference(enrollment, { dataDir, fsApi });
    return legacy.valid
      ? {
          eligible: true,
          ...legacy,
          acoustic_matchable: acoustic.matchable,
          acoustic_capability: acoustic.capability,
          acoustic_non_matchable_reason: acoustic.reason || null,
        }
      : { eligible: false, reason: legacy.reason };
  }
  return { eligible: false, reason: 'missing_reference_provenance' };
}

function writeImmutable(file, bytes, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fsApi.writeFileSync(file, bytes, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o644,
    });
    return { created: true };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (fsApi.readFileSync(file, 'utf8') !== bytes) {
      throw new Error(`immutable legacy reference receipt conflict: ${file}`);
    }
    return { created: false };
  }
}

function atomicWriteJson(file, value, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fsApi.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o644,
  });
  fsApi.renameSync(temp, file);
}

function auditReference(enrollment, reason) {
  return {
    enrollment_id: String(enrollment?.enrollment_id || ''),
    person_id: String(enrollment?.person_id || ''),
    model: String(enrollment?.model || ''),
    reason,
  };
}

function migrateLegacyTrustedReferences({
  registryPath,
  dataDir,
  authority = MIGRATION_AUTHORITY,
  migratedAt = new Date().toISOString(),
  write = false,
  aliasDataRoots = [],
  fsApi = fs,
} = {}) {
  if (!authorityMatches(authority)) {
    throw new Error('legacy voice reference migration authority is invalid');
  }
  const originalBytes = fsApi.readFileSync(registryPath, 'utf8');
  const registry = JSON.parse(originalBytes.replace(/^\uFEFF/, ''));
  const updated = clone(registry);
  const enrollments = Array.isArray(updated.enrollments)
    ? updated.enrollments
    : Object.values(updated.enrollments || {});
  const plannedReceipts = [];
  const affectedPeople = new Set();
  const eligibleEnrollmentIds = new Set();
  const ineligible = [];
  const nonMatchableAudio = [];
  const audioTrace = [];
  let stamped = 0;
  let alreadyStamped = 0;
  let sourceVersioned = 0;
  let tampered = 0;
  let legacyTrustedMatchable = 0;
  let legacyTrustedAudioTraceAmbiguous = 0;
  let legacyTrustedGenuinelyMissing = 0;
  let resolvedRelocation = 0;
  let genuinelyMissing = 0;
  let ambiguous = 0;

  for (const enrollment of enrollments) {
    const scope = confirmedKnownReferenceScope(updated, enrollment);
    if (!scope.in_scope) {
      ineligible.push(auditReference(enrollment, scope.reason));
      continue;
    }
    const fullySourceVersioned = hasFullySourceVersionedProvenance(enrollment);
    const existingAcoustic = referenceAudioCapability(enrollment, {
      dataDir,
      fsApi,
    });
    if (
      !fullySourceVersioned &&
      !enrollment.reference_provenance &&
      !existingAcoustic.matchable
    ) {
      const preRecoveryRecordSha256 = enrollmentRecordHash(enrollment);
      const trace = traceLegacyReferenceAudio(enrollment, {
        dataDir,
        aliasDataRoots,
        fsApi,
      });
      audioTrace.push({
        enrollment_id: String(enrollment.enrollment_id || ''),
        person_id: String(enrollment.person_id || ''),
        ...trace,
      });
      if (trace.status === 'resolved_relocation') {
        resolvedRelocation += 1;
        enrollment.reference_audio_rel = trace.selected_audio_path;
        enrollment.reference_audio_recovery = {
          ...trace,
          pre_recovery_enrollment_record_sha256: preRecoveryRecordSha256,
        };
      } else if (trace.status === 'genuinely_missing') {
        genuinelyMissing += 1;
        enrollment.reference_audio_trace = {
          ...trace,
          pre_trace_enrollment_record_sha256: preRecoveryRecordSha256,
        };
      } else {
        ambiguous += 1;
        enrollment.reference_audio_trace = {
          ...trace,
          pre_trace_enrollment_record_sha256: preRecoveryRecordSha256,
        };
      }
    }
    const acoustic = referenceAudioCapability(enrollment, { dataDir, fsApi });
    if (fullySourceVersioned) {
      sourceVersioned += 1;
      affectedPeople.add(String(enrollment.person_id || ''));
      eligibleEnrollmentIds.add(String(enrollment.enrollment_id || ''));
      if (!acoustic.matchable) {
        nonMatchableAudio.push(auditReference(enrollment, acoustic.reason));
      }
      continue;
    }
    if (enrollment.reference_provenance) {
      const validation = validateLegacyTrustedReference(enrollment, {
        dataDir,
        fsApi,
      });
      if (validation.valid) {
        alreadyStamped += 1;
        affectedPeople.add(String(enrollment.person_id || ''));
        eligibleEnrollmentIds.add(String(enrollment.enrollment_id || ''));
        if (acoustic.matchable) legacyTrustedMatchable += 1;
        else {
          if (
            acoustic.capability === 'legacy_trusted_genuinely_missing'
          ) {
            legacyTrustedGenuinelyMissing += 1;
          } else {
            legacyTrustedAudioTraceAmbiguous += 1;
          }
          nonMatchableAudio.push(auditReference(enrollment, acoustic.reason));
        }
      } else {
        tampered += 1;
        ineligible.push(auditReference(enrollment, validation.reason));
      }
      continue;
    }
    const receipt = buildLegacyReceipt({
      enrollment,
      authority,
      migratedAt,
      acousticCapability: acoustic,
    });
    const relativePath = safeReceiptRelativePath(
      enrollment.enrollment_id,
      receipt.attested_record_sha256,
    );
    enrollment.reference_provenance = buildLegacyStamp({
      receipt,
      receiptPath: relativePath,
    });
    plannedReceipts.push({
      path: path.resolve(dataDir, relativePath),
      bytes: receiptBytes(receipt),
    });
    stamped += 1;
    affectedPeople.add(String(enrollment.person_id || ''));
    eligibleEnrollmentIds.add(String(enrollment.enrollment_id || ''));
    if (acoustic.matchable) legacyTrustedMatchable += 1;
    else {
      if (acoustic.capability === 'legacy_trusted_genuinely_missing') {
        legacyTrustedGenuinelyMissing += 1;
      } else {
        legacyTrustedAudioTraceAmbiguous += 1;
      }
      nonMatchableAudio.push(auditReference(enrollment, acoustic.reason));
    }
  }

  const ExampleCoEnrollments = enrollments.filter((row) => row.person_id === 'ExampleCo');
  const ExampleCoEligible = ExampleCoEnrollments.filter((row) =>
    eligibleEnrollmentIds.has(String(row.enrollment_id || '')),
  ).length;
  const ExampleCoMatchable = ExampleCoEnrollments.filter(
    (row) =>
      eligibleEnrollmentIds.has(String(row.enrollment_id || '')) &&
      referenceAudioCapability(row, { dataDir, fsApi }).matchable,
  ).length;
  const audit = {
    schema: AUDIT_SCHEMA,
    migration_id: MIGRATION_ID,
    generated_at: migratedAt,
    migration_authority: clone(authority),
    write_requested: write === true,
    total_enrollments: enrollments.length,
    stamped,
    already_stamped: alreadyStamped,
    source_versioned: sourceVersioned,
    legacy_trusted_matchable: legacyTrustedMatchable,
    legacy_trusted_audio_trace_ambiguous:
      legacyTrustedAudioTraceAmbiguous,
    legacy_trusted_genuinely_missing: legacyTrustedGenuinelyMissing,
    resolved_relocation: resolvedRelocation,
    genuinely_missing: genuinelyMissing,
    ambiguous,
    tampered,
    ineligible: ineligible.length,
    affected_known_people: [...affectedPeople].filter(Boolean).sort(),
    ineligible_references: ineligible,
    non_matchable_audio_references: nonMatchableAudio,
    audio_trace: audioTrace,
    ExampleCo: {
      enrollment_count: ExampleCoEnrollments.length,
      eligible_count: ExampleCoEligible,
      matchable_count: ExampleCoMatchable,
      status: ExampleCoEligible > 0 ? 'eligible' : 'ineligible',
    },
  };
  const auditHash = sha256(stableJson(audit));
  const auditRelativePath = path.join(
    RECEIPTS_RELATIVE_ROOT,
    'migration-audits',
    `${auditHash}.json`,
  );
  audit.audit_report_path = auditRelativePath.replace(/\\/g, '/');

  if (write) {
    for (const receipt of plannedReceipts) {
      writeImmutable(receipt.path, receipt.bytes, fsApi);
    }
    const nextBytes = `${JSON.stringify(updated, null, 2)}\n`;
    if (nextBytes !== originalBytes) atomicWriteJson(registryPath, updated, fsApi);
    writeImmutable(
      path.resolve(dataDir, auditRelativePath),
      `${JSON.stringify(audit, null, 2)}\n`,
      fsApi,
    );
  }
  return {
    ok: tampered === 0 && audit.ExampleCo.status === 'eligible',
    changed: stamped > 0,
    registry: updated,
    audit,
  };
}

module.exports = {
  AUDIT_SCHEMA,
  MIGRATION_AUTHORITY,
  MIGRATION_ID,
  PROVENANCE_SCHEMA,
  RECEIPT_SCHEMA,
  baselineEnrollmentRecord,
  confirmedKnownReferenceScope,
  enrollmentRecordHash,
  hasFullySourceVersionedProvenance,
  migrateLegacyTrustedReferences,
  referenceAudioCapability,
  traceLegacyReferenceAudio,
  referenceEligibility,
  stableJson,
  validateLegacyTrustedReference,
};
