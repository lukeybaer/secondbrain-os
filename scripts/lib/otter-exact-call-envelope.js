'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  provenanceProblems,
} = require('./otter-architecture-provenance.js');
const {
  canonicalPersonId,
  isConfirmedIdentity,
} = require('./canonical-speaker-identity.js');
const {
  OTTER_OFFSET_DIVISOR_CANDIDATES,
  inferOtterOffsetDivisor,
} = require('./otter-timebase.js');

const ENVELOPE_SCHEMA = 'life_archive_otter_exact_call_completion_envelope.v1';
const CUTOVER_SCHEMA = 'life_archive_otter_exact_call_envelope_cutover.v1';
const HISTORICAL_AUTHORIZATION_SCHEMA =
  'life_archive_otter_exact_call_historical_producer_authorization.v1';
const CORRECTION_AUTHORIZATION_SCHEMA =
  'life_archive_otter_exact_call_completion_correction_authorization.v1';
const PRODUCER_TIMEBASE_DEFECT = 'producer_timebase_inference_defect';
const MUTABLE_ENRICHED_PROJECTION_DEFECT = 'mutable_enriched_projection_artifact_defect';
const ROOT_RELATIVE = path.join(
  'life-archive',
  'voiceprints',
  'otter-exact-call-envelopes',
);
const HASH_RE = /^[a-f0-9]{64}$/;

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file, fsApi = fs) {
  return sha256Bytes(fsApi.readFileSync(file));
}

function callKey(otid) {
  return sha256Bytes(String(otid || ''));
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

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function identityTarget(identity = {}) {
  const personId = canonicalPersonId(
    identity?.person_id ||
      identity?.confirmed_person_id ||
      String(identity?.voice_cluster_id || '').replace(/^person:/, ''),
  );
  if (personId && /^person:/.test(String(identity?.voice_cluster_id || ''))) {
    return `person:${personId}`;
  }
  if (personId) return `person:${personId}`;
  return String(
    identity?.acoustic_unknown_id ||
      identity?.unknown_speaker_id ||
      identity?.voice_cluster_id ||
      '',
  );
}

function envelopeHash(envelope) {
  const canonical = { ...envelope };
  delete canonical.bundle_hash;
  return sha256Bytes(stableJson(canonical));
}

function safeRelativePath(dataDir, file) {
  const root = path.resolve(String(dataDir || ''));
  const absolute = path.resolve(String(file || ''));
  const relative = path.relative(root, absolute);
  if (
    !root ||
    !absolute ||
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`artifact is outside the exact-call data root: ${absolute}`);
  }
  return relative.replace(/\\/g, '/');
}

function safeDescriptorPath(relativePath) {
  const value = String(relativePath || '').replace(/\\/g, '/');
  const normalized = path.posix.normalize(value);
  if (
    !value ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`unsafe exact-call artifact path: ${value}`);
  }
  return normalized;
}

function artifactDescriptor({
  dataDir,
  file,
  kind,
  required = true,
  metadata = {},
  fsApi = fs,
} = {}) {
  if (!kind) throw new Error('artifact kind is required');
  const relative = safeRelativePath(dataDir, file);
  const stat = fsApi.statSync(file);
  if (!stat.isFile()) throw new Error(`exact-call artifact is not a file: ${file}`);
  return {
    kind: String(kind),
    path: relative,
    sha256: sha256File(file, fsApi),
    bytes: stat.size,
    required: required !== false,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
  };
}

function flattenArtifacts(artifacts) {
  const rows = [];
  for (const [key, value] of Object.entries(artifacts || {})) {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    for (const descriptor of values) {
      if (!descriptor || typeof descriptor !== 'object') continue;
      rows.push({ artifact_key: key, ...descriptor });
    }
  }
  return rows;
}

function envelopeProblems(envelope) {
  const problems = [];
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return ['exact-call completion envelope is not an object'];
  }
  if (envelope.schema !== ENVELOPE_SCHEMA) {
    problems.push('exact-call completion envelope schema is invalid');
  }
  if (!String(envelope.otid || '').trim()) problems.push('exact-call envelope lacks otid');
  if (!HASH_RE.test(String(envelope.source_revision_hash || '').toLowerCase())) {
    problems.push('exact-call envelope lacks a valid source revision hash');
  }
  if (!String(envelope.producer_sha || '').trim()) {
    problems.push('exact-call envelope lacks producer SHA');
  }
  for (const problem of provenanceProblems(envelope.architecture_provenance)) {
    problems.push(`exact-call envelope ${problem}`);
  }
  if (!Number.isFinite(Date.parse(String(envelope.produced_at || '')))) {
    problems.push('exact-call envelope lacks a production timestamp');
  }
  const rows = flattenArtifacts(envelope.artifacts);
  const requiredKinds = new Set(rows.filter((row) => row.required !== false).map((row) => row.kind));
  for (const kind of [
    'raw_transcript',
    'raw_archive_receipt',
    'full_audio',
    'enriched_diarization',
  ]) {
    if (!requiredKinds.has(kind)) problems.push(`exact-call envelope lacks ${kind}`);
  }
  const seenPaths = new Set();
  for (const row of rows) {
    try {
      safeDescriptorPath(row.path);
    } catch (error) {
      problems.push(error.message);
    }
    if (!String(row.kind || '').trim()) problems.push('exact-call artifact lacks kind');
    if (!HASH_RE.test(String(row.sha256 || '').toLowerCase())) {
      problems.push(`exact-call artifact has invalid hash: ${row.path || row.kind || 'unknown'}`);
    }
    if (!Number.isFinite(Number(row.bytes)) || Number(row.bytes) <= 0) {
      problems.push(`exact-call artifact has invalid byte count: ${row.path || row.kind || 'unknown'}`);
    }
    if (seenPaths.has(row.path)) problems.push(`exact-call artifact path is duplicated: ${row.path}`);
    seenPaths.add(row.path);
  }
  const raw = rows.find((row) => row.kind === 'raw_transcript');
  if (
    raw &&
    String(raw.sha256 || '').toLowerCase() !==
      String(envelope.source_revision_hash || '').toLowerCase()
  ) {
    problems.push('raw transcript artifact does not match the source revision hash');
  }
  if (Object.prototype.hasOwnProperty.call(envelope, 'ranked_identity_candidates')) {
    if (!Array.isArray(envelope.ranked_identity_candidates)) {
      problems.push('ranked identity candidates are not an array');
    } else {
      const candidateArtifact = rows.find(
        (row) => row.kind === 'ranked_identity_candidates',
      );
      if (!candidateArtifact) {
        problems.push('exact-call envelope lacks ranked identity candidate evidence');
      }
      const identityTracks = new Map(
        (envelope.identity_tracks || []).map((track) => [
          String(track?.speaker_model_label || ''),
          track?.identity || {},
        ]),
      );
      for (const candidate of envelope.ranked_identity_candidates) {
        const { evidence_hash: evidenceHash, ...candidateEvidence } = candidate || {};
        if (String(candidate?.otid || '') !== String(envelope.otid || '')) {
          problems.push('ranked identity candidate belongs to another call');
        }
        if (
          String(candidate?.source_revision_hash || '').toLowerCase() !==
          String(envelope.source_revision_hash || '').toLowerCase()
        ) {
          problems.push('ranked identity candidate belongs to another raw revision');
        }
        if (
          !String(candidate?.speaker_model_label || '').trim() ||
          !String(candidate?.candidate_person_id || '').trim() ||
          !Number.isFinite(Number(candidate?.score)) ||
          !Number.isFinite(Number(candidate?.margin)) ||
          !Number.isInteger(Number(candidate?.rank)) ||
          Number(candidate.rank) < 1 ||
          !HASH_RE.test(String(candidate?.probe_sha256 || '').toLowerCase()) ||
          !HASH_RE.test(String(candidate?.embedding_sha256 || '').toLowerCase()) ||
          !HASH_RE.test(String(candidate?.evidence_hash || '').toLowerCase())
        ) {
          problems.push('ranked identity candidate evidence is incomplete');
        }
        if (
          HASH_RE.test(String(evidenceHash || '').toLowerCase()) &&
          sha256Bytes(stableJson(candidateEvidence)) !==
            String(evidenceHash).toLowerCase()
        ) {
          problems.push('ranked identity candidate evidence hash is invalid');
        }
        if (Object.prototype.hasOwnProperty.call(candidate || {}, 'decision')) {
          if (!['accepted', 'rejected'].includes(String(candidate?.decision || ''))) {
            problems.push('ranked identity candidate decision is invalid');
          } else if (
            candidate.decision === 'accepted' &&
            String(candidate.rejection_reason || '')
          ) {
            problems.push('accepted ranked identity candidate has a rejection reason');
          } else if (
            candidate.decision === 'rejected' &&
            !String(candidate.rejection_reason || '')
          ) {
            problems.push('rejected ranked identity candidate lacks a rejection reason');
          }
          if (candidate.decision === 'accepted') {
            const identity = identityTracks.get(
              String(candidate.speaker_model_label || ''),
            );
            if (
              !isConfirmedIdentity(identity) ||
              canonicalPersonId(identity?.person_id) !==
                canonicalPersonId(candidate.candidate_person_id)
            ) {
              problems.push(
                'accepted ranked identity candidate is not the canonical envelope identity',
              );
            }
          }
        }
      }
    }
  }
  const expectedBundleHash = envelopeHash(envelope);
  if (!HASH_RE.test(String(envelope.bundle_hash || '').toLowerCase())) {
    problems.push('exact-call envelope lacks a valid bundle hash');
  } else if (String(envelope.bundle_hash).toLowerCase() !== expectedBundleHash) {
    problems.push('exact-call envelope bundle hash is invalid');
  }
  return [...new Set(problems)];
}

function artifactFile({
  dataDir,
  bundleDir = '',
  descriptor,
} = {}) {
  const relative = safeDescriptorPath(descriptor?.path);
  return bundleDir
    ? path.join(path.resolve(bundleDir), 'artifacts', ...relative.split('/'))
    : path.join(path.resolve(dataDir), ...relative.split('/'));
}

function verifyEnvelopeArtifacts(
  envelope,
  {
    dataDir,
    bundleDir = '',
    fsApi = fs,
  } = {},
) {
  const problems = envelopeProblems(envelope);
  for (const descriptor of flattenArtifacts(envelope?.artifacts)) {
    let file = '';
    try {
      file = artifactFile({ dataDir, bundleDir, descriptor });
      const stat = fsApi.statSync(file);
      if (!stat.isFile()) throw new Error('not a file');
      if (Number(stat.size) !== Number(descriptor.bytes)) {
        problems.push(`exact-call artifact byte count differs: ${descriptor.path}`);
        continue;
      }
      if (sha256File(file, fsApi) !== String(descriptor.sha256).toLowerCase()) {
        problems.push(`exact-call artifact hash differs: ${descriptor.path}`);
      }
    } catch (error) {
      problems.push(`exact-call artifact is missing or unreadable: ${descriptor.path} (${error.message})`);
    }
  }
  return {
    ok: problems.length === 0,
    problems: [...new Set(problems)],
    envelope,
  };
}

function buildCompletionEnvelope({
  otid,
  sourceRevisionHash,
  producerSha,
  artifacts,
  identityTracks = [],
  acousticAssignments = [],
  rankedIdentityCandidates,
  stageTimings = [],
  audio = {},
  architectureProvenance,
  producedAt = new Date().toISOString(),
} = {}) {
  const envelope = {
    schema: ENVELOPE_SCHEMA,
    otid: String(otid || '').trim(),
    source_revision_hash: String(sourceRevisionHash || '').toLowerCase(),
    produced_at: String(producedAt),
    producer_sha: String(producerSha || '').trim(),
    architecture_provenance: architectureProvenance || null,
    artifacts: artifacts || {},
    audio: audio && typeof audio === 'object' ? audio : {},
    identity_tracks: Array.isArray(identityTracks) ? identityTracks : [],
    acoustic_assignments: Array.isArray(acousticAssignments) ? acousticAssignments : [],
    stage_timings: Array.isArray(stageTimings) ? stageTimings : [],
  };
  if (Array.isArray(rankedIdentityCandidates)) {
    envelope.ranked_identity_candidates = rankedIdentityCandidates;
  }
  envelope.bundle_hash = envelopeHash(envelope);
  const problems = envelopeProblems(envelope);
  if (problems.length) {
    throw new Error(`invalid exact-call completion envelope: ${problems.join('; ')}`);
  }
  return envelope;
}

function envelopeOutboxPath({ dataDir, otid, sourceRevisionHash } = {}) {
  return path.join(
    path.resolve(dataDir),
    ROOT_RELATIVE,
    'outbox',
    'calls',
    callKey(otid),
    `${String(sourceRevisionHash || '').toLowerCase()}.json`,
  );
}

function envelopeCorrectionOutboxPath({
  dataDir,
  otid,
  sourceRevisionHash,
  correctionId,
} = {}) {
  return path.join(
    path.resolve(dataDir),
    ROOT_RELATIVE,
    'correction-outbox',
    'calls',
    callKey(otid),
    String(sourceRevisionHash || '').toLowerCase(),
    `${sha256Bytes(String(correctionId || ''))}.json`,
  );
}

function envelopeSupersededDir({ dataDir, otid, sourceRevisionHash, bundleHash } = {}) {
  return path.join(
    path.resolve(dataDir),
    ROOT_RELATIVE,
    'superseded',
    'calls',
    callKey(otid),
    String(sourceRevisionHash || '').toLowerCase(),
    String(bundleHash || '').toLowerCase(),
  );
}

function loadInterruptedCorrectionPrior({
  dataDir,
  otid,
  sourceRevisionHash,
  fsApi = fs,
} = {}) {
  const revisionDir = path.dirname(
    envelopeSupersededDir({
      dataDir,
      otid,
      sourceRevisionHash,
      bundleHash: 'placeholder',
    }),
  );
  if (!fsApi.existsSync(revisionDir)) return null;
  const candidates = fsApi
    .readdirSync(revisionDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(revisionDir, entry.name))
    .filter((directory) => !fsApi.existsSync(path.join(directory, '_supersession.json')))
    .map((directory) => {
      const file = path.join(directory, 'envelope.json');
      const envelope = readEnvelopeFile(file, fsApi);
      if (!envelope) return null;
      const verification = verifyEnvelopeArtifacts(envelope, {
        dataDir,
        bundleDir: directory,
        fsApi,
      });
      if (
        !verification.ok ||
        String(envelope.otid || '') !== String(otid || '') ||
        String(envelope.source_revision_hash || '').toLowerCase() !==
          String(sourceRevisionHash || '').toLowerCase()
      ) {
        return null;
      }
      return {
        ...verification,
        ok: true,
        found: true,
        file,
        bundleDir: directory,
        envelope,
        interrupted_correction: true,
      };
    })
    .filter(Boolean);
  if (candidates.length > 1) {
    throw new Error(
      `interrupted exact-call correction is ambiguous: ${candidates.length} valid prior bundles`,
    );
  }
  return candidates[0] || null;
}

function envelopeInboxDir({ dataDir, otid, sourceRevisionHash } = {}) {
  return path.join(
    path.resolve(dataDir),
    ROOT_RELATIVE,
    'inbox',
    'calls',
    callKey(otid),
    String(sourceRevisionHash || '').toLowerCase(),
  );
}

function writeImmutableJson(file, value, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fsApi.writeFileSync(temp, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  try {
    fsApi.linkSync(temp, file);
    return { created: true, idempotent: false, path: file, value };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (stableJson(existing) !== stableJson(value)) {
      throw new Error(`immutable exact-call artifact conflict: ${file}`);
    }
    return { created: false, idempotent: true, path: file, value: existing };
  } finally {
    fsApi.rmSync(temp, { force: true });
  }
}

function writeCompletionEnvelope({
  dataDir,
  envelope,
  correctionId = '',
  fsApi = fs,
} = {}) {
  const verification = verifyEnvelopeArtifacts(envelope, { dataDir, fsApi });
  if (!verification.ok) {
    throw new Error(`exact-call completion envelope is not publishable: ${verification.problems.join('; ')}`);
  }
  const file = correctionId
    ? envelopeCorrectionOutboxPath({
        dataDir,
        otid: envelope.otid,
        sourceRevisionHash: envelope.source_revision_hash,
        correctionId,
      })
    : envelopeOutboxPath({
        dataDir,
        otid: envelope.otid,
        sourceRevisionHash: envelope.source_revision_hash,
      });
  return writeImmutableJson(file, envelope, fsApi);
}

function descriptorForKind(envelope, kind) {
  return flattenArtifacts(envelope?.artifacts).find((row) => row.kind === kind) || null;
}

function artifactDescriptorMatches(left, right) {
  return Boolean(
    left &&
      right &&
      String(left.sha256 || '').toLowerCase() === String(right.sha256 || '').toLowerCase() &&
      Number(left.bytes) === Number(right.bytes),
  );
}

function readEnvelopeArtifactJson({ dataDir, bundleDir = '', envelope, kind, fsApi = fs } = {}) {
  const descriptor = descriptorForKind(envelope, kind);
  if (!descriptor) return null;
  const file = artifactFile({ dataDir, bundleDir, descriptor });
  return readEnvelopeFile(file, fsApi);
}

function resolvedRawTimebaseProof(raw = {}) {
  const stored = raw?.otter_timebase || {};
  const divisor = Number(stored?.offset_divisor || 0);
  const ratio = Number(stored?.alignment_median_ratio || 0);
  const samples = Number(stored?.alignment_samples || 0);
  if (
    stored?.timebase_source === 'word-alignment' &&
    stored?.timebase_unresolved !== true &&
    OTTER_OFFSET_DIVISOR_CANDIDATES.includes(divisor) &&
    Number.isFinite(ratio) &&
    ratio > 0 &&
    Math.abs(ratio - divisor) / divisor <= 0.15 &&
    Number.isFinite(samples) &&
    samples >= 1
  ) {
    return {
      ...stored,
      offset_divisor: divisor,
      alignment_median_ratio: ratio,
      alignment_samples: samples,
      timebase_source: 'word-alignment',
    };
  }
  return inferOtterOffsetDivisor(raw);
}

function producerTimebaseCorrectionProof({
  priorEnvelope,
  replacementEnvelope,
  priorDataDir,
  priorBundleDir = '',
  replacementDataDir,
  replacementBundleDir = '',
  fsApi = fs,
} = {}) {
  const problems = [];
  if (
    String(priorEnvelope?.otid || '') !== String(replacementEnvelope?.otid || '') ||
    String(priorEnvelope?.source_revision_hash || '').toLowerCase() !==
      String(replacementEnvelope?.source_revision_hash || '').toLowerCase()
  ) {
    problems.push('producer timebase defect correction is not bound to one call revision');
  }
  for (const kind of ['raw_transcript', 'raw_archive_receipt', 'full_audio']) {
    if (
      !artifactDescriptorMatches(
        descriptorForKind(priorEnvelope, kind),
        descriptorForKind(replacementEnvelope, kind),
      )
    ) {
      problems.push(`producer timebase defect correction changed ${kind}`);
    }
  }
  const raw = readEnvelopeArtifactJson({
    dataDir: replacementDataDir,
    bundleDir: replacementBundleDir,
    envelope: replacementEnvelope,
    kind: 'raw_transcript',
    fsApi,
  });
  const priorEnriched = readEnvelopeArtifactJson({
    dataDir: priorDataDir,
    bundleDir: priorBundleDir,
    envelope: priorEnvelope,
    kind: 'enriched_diarization',
    fsApi,
  });
  const replacementEnriched = readEnvelopeArtifactJson({
    dataDir: replacementDataDir,
    bundleDir: replacementBundleDir,
    envelope: replacementEnvelope,
    kind: 'enriched_diarization',
    fsApi,
  });
  if (!raw || !priorEnriched || !replacementEnriched) {
    problems.push('producer timebase defect correction evidence is unreadable');
  }
  const inferred = raw ? resolvedRawTimebaseProof(raw) : {};
  const expectedDivisor = Number(inferred?.offset_divisor || 0);
  const priorDivisor = Number(priorEnriched?.otter_timebase?.offset_divisor || 0);
  const replacementDivisor = Number(
    replacementEnriched?.otter_timebase?.offset_divisor || 0,
  );
  if (!expectedDivisor || inferred?.timebase_unresolved === true) {
    problems.push('producer timebase defect correction lacks a resolved raw alignment timebase');
  }
  if (priorDivisor === expectedDivisor) {
    problems.push('producer timebase defect correction does not prove a defective prior timebase');
  }
  if (replacementDivisor !== expectedDivisor) {
    problems.push('producer timebase defect correction replacement does not match raw alignment');
  }
  const replacementTracks = replacementEnriched?.speaker_identity_tracks || {};
  const priorEnvelopeTracks = new Map(
    (priorEnvelope?.identity_tracks || []).map((track) => [
      String(track?.speaker_model_label || ''),
      track,
    ]),
  );
  const replacementTrackIds = (replacementEnvelope?.identity_tracks || [])
    .map((track) => String(track?.speaker_model_label || ''))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const changedTrackIds = [];
  for (const track of replacementEnvelope?.identity_tracks || []) {
    const label = String(track?.speaker_model_label || '');
    const envelopeTarget = identityTarget(track?.identity || {});
    if (!label || !envelopeTarget) continue;
    const priorTrack = priorEnvelopeTracks.get(label);
    if (!priorTrack) {
      problems.push(
        `producer timebase defect correction added track ${label} that is absent from the prior envelope`,
      );
    } else if (identityTarget(priorTrack?.identity || {}) !== envelopeTarget) {
      changedTrackIds.push(label);
    }
    const enrichedTarget = identityTarget(replacementTracks[label] || {});
    if (enrichedTarget !== envelopeTarget) {
      problems.push(
        `producer timebase defect correction identity track ${label} does not match corrected enriched evidence`,
      );
    }
  }
  return {
    ok: problems.length === 0,
    problems: [...new Set(problems)],
    expected_divisor: expectedDivisor || null,
    prior_divisor: priorDivisor || null,
    replacement_divisor: replacementDivisor || null,
    timebase_source: String(inferred?.timebase_source || ''),
    raw_sha256: String(descriptorForKind(replacementEnvelope, 'raw_transcript')?.sha256 || ''),
    prior_enriched_sha256: String(
      descriptorForKind(priorEnvelope, 'enriched_diarization')?.sha256 || '',
    ),
    replacement_enriched_sha256: String(
      descriptorForKind(replacementEnvelope, 'enriched_diarization')?.sha256 || '',
    ),
    replacement_track_ids: replacementTrackIds,
    changed_track_ids: changedTrackIds.sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    ),
  };
}

function mutableEnrichedProjectionCorrectionProof({
  priorEnvelope,
  replacementEnvelope,
  priorDataDir,
  priorBundleDir = '',
  replacementDataDir,
  replacementBundleDir = '',
  fsApi = fs,
} = {}) {
  const problems = [];
  if (
    String(priorEnvelope?.otid || '') !== String(replacementEnvelope?.otid || '') ||
    String(priorEnvelope?.source_revision_hash || '').toLowerCase() !==
      String(replacementEnvelope?.source_revision_hash || '').toLowerCase()
  ) {
    problems.push('mutable enriched projection correction is not bound to one call revision');
  }
  for (const kind of ['raw_transcript', 'raw_archive_receipt', 'full_audio']) {
    if (!artifactDescriptorMatches(descriptorForKind(priorEnvelope, kind), descriptorForKind(replacementEnvelope, kind))) {
      problems.push(`mutable enriched projection correction changed ${kind}`);
    }
  }
  const priorEnrichedDescriptor = descriptorForKind(priorEnvelope, 'enriched_diarization');
  const replacementEnrichedDescriptor = descriptorForKind(replacementEnvelope, 'enriched_diarization');
  if (!priorEnrichedDescriptor || !replacementEnrichedDescriptor) {
    problems.push('mutable enriched projection correction lacks enriched descriptors');
  }
  const priorVerification = verifyEnvelopeArtifacts(priorEnvelope, {
    dataDir: priorDataDir,
    bundleDir: priorBundleDir,
    fsApi,
  });
  const allowedPriorProblems = new Set([
    `exact-call artifact byte count differs: ${priorEnrichedDescriptor?.path || ''}`,
    `exact-call artifact hash differs: ${priorEnrichedDescriptor?.path || ''}`,
  ]);
  for (const problem of priorVerification.problems) {
    if (!allowedPriorProblems.has(problem)) problems.push(`prior ${problem}`);
  }
  const replacementEnriched = readEnvelopeArtifactJson({
    dataDir: replacementDataDir,
    bundleDir: replacementBundleDir,
    envelope: replacementEnvelope,
    kind: 'enriched_diarization',
    fsApi,
  });
  if (!replacementEnriched) {
    problems.push('mutable enriched projection replacement is unreadable');
  } else if (
    String(replacementEnriched.source_revision || '').toLowerCase() !==
    String(replacementEnvelope?.source_revision_hash || '').toLowerCase()
  ) {
    problems.push('mutable enriched projection replacement revision is invalid');
  }
  const replacementTracks = replacementEnriched?.speaker_identity_tracks || {};
  const priorTracks = new Map((priorEnvelope?.identity_tracks || []).map((track) => [String(track?.speaker_model_label || ''), track]));
  const replacementTrackIds = [];
  const changedTrackIds = [];
  for (const track of replacementEnvelope?.identity_tracks || []) {
    const label = String(track?.speaker_model_label || '');
    if (!label) continue;
    replacementTrackIds.push(label);
    const envelopeTarget = identityTarget(track.identity || {});
    if (identityTarget(replacementTracks[label] || {}) !== envelopeTarget) {
      problems.push(`mutable enriched projection identity track ${label} does not match replacement evidence`);
    }
    const priorTrack = priorTracks.get(label);
    if (!priorTrack) {
      problems.push(`mutable enriched projection correction added identity track ${label}`);
      changedTrackIds.push(label);
    } else if (identityTarget(priorTrack.identity || {}) !== envelopeTarget) {
      changedTrackIds.push(label);
    }
  }
  if (changedTrackIds.length) {
    problems.push(
      `mutable enriched projection correction changed identity track(s): ${changedTrackIds.join(', ')}`,
    );
  }
  return {
    ok: problems.length === 0,
    problems: [...new Set(problems)],
    raw_sha256: String(descriptorForKind(replacementEnvelope, 'raw_transcript')?.sha256 || ''),
    prior_enriched_sha256: String(priorEnrichedDescriptor?.sha256 || ''),
    replacement_enriched_sha256: String(replacementEnrichedDescriptor?.sha256 || ''),
    replacement_track_ids: replacementTrackIds.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    changed_track_ids: changedTrackIds.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  };
}

function correctionAuthorizationHash(value) {
  const canonical = { ...(value || {}) };
  delete canonical.authorization_hash;
  return sha256Bytes(stableJson(canonical));
}

function validateCorrectionAuthorization({
  authorization,
  currentEnvelope,
  dataDir,
  currentBundleDir,
  fsApi = fs,
} = {}) {
  const problems = [];
  const archiveRelative = String(authorization?.prior_bundle_directory || '');
  const archiveDir = path.resolve(dataDir, ...archiveRelative.replace(/\\/g, '/').split('/'));
  const dataRoot = path.resolve(dataDir);
  const archiveWithinRoot =
    archiveDir !== dataRoot &&
    !path.relative(dataRoot, archiveDir).startsWith(`..${path.sep}`) &&
    !path.isAbsolute(path.relative(dataRoot, archiveDir));
  const priorEnvelope = archiveWithinRoot
    ? readEnvelopeFile(path.join(archiveDir, 'envelope.json'), fsApi)
    : null;
  if (authorization?.schema !== CORRECTION_AUTHORIZATION_SCHEMA) {
    problems.push('exact-call correction authorization schema is invalid');
  }
  if (![PRODUCER_TIMEBASE_DEFECT, MUTABLE_ENRICHED_PROJECTION_DEFECT].includes(authorization?.reason_code)) {
    problems.push('exact-call correction authorization reason is invalid');
  }
  if (
    String(authorization?.otid || '') !== String(currentEnvelope?.otid || '') ||
    String(authorization?.source_revision_hash || '').toLowerCase() !==
      String(currentEnvelope?.source_revision_hash || '').toLowerCase()
  ) {
    problems.push('exact-call correction authorization binding is invalid');
  }
  if (!archiveWithinRoot || !priorEnvelope) {
    problems.push('exact-call correction authorization prior bundle is missing');
  }
  if (
    String(authorization?.prior_bundle_hash || '').toLowerCase() !==
      String(priorEnvelope?.bundle_hash || '').toLowerCase() ||
    String(authorization?.replacement_bundle_hash || '').toLowerCase() !==
      String(currentEnvelope?.bundle_hash || '').toLowerCase()
  ) {
    problems.push('exact-call correction authorization bundle hashes are invalid');
  }
  if (
    !HASH_RE.test(String(authorization?.authorization_hash || '').toLowerCase()) ||
    String(authorization.authorization_hash).toLowerCase() !==
      correctionAuthorizationHash(authorization)
  ) {
    problems.push('exact-call correction authorization hash is invalid');
  }
  let proof = { ok: false, problems: [] };
  if (priorEnvelope) {
    proof = authorization?.reason_code === MUTABLE_ENRICHED_PROJECTION_DEFECT
      ? mutableEnrichedProjectionCorrectionProof({
          priorEnvelope,
          replacementEnvelope: currentEnvelope,
          priorDataDir: dataDir,
          priorBundleDir: archiveDir,
          replacementDataDir: dataDir,
          replacementBundleDir: currentBundleDir,
          fsApi,
        })
      : producerTimebaseCorrectionProof({
          priorEnvelope,
          replacementEnvelope: currentEnvelope,
          priorDataDir: dataDir,
          priorBundleDir: archiveDir,
          replacementDataDir: dataDir,
          replacementBundleDir: currentBundleDir,
          fsApi,
        });
    problems.push(...proof.problems);
  }
  for (const [field, expected] of [
    ['expected_divisor', proof.expected_divisor],
    ['prior_divisor', proof.prior_divisor],
    ['replacement_divisor', proof.replacement_divisor],
    ['raw_sha256', proof.raw_sha256],
    ['prior_enriched_sha256', proof.prior_enriched_sha256],
    ['replacement_enriched_sha256', proof.replacement_enriched_sha256],
  ]) {
    if (expected != null && String(authorization?.proof?.[field] ?? '') !== String(expected)) {
      problems.push(`exact-call correction authorization ${field} proof is invalid`);
    }
  }
  for (const field of ['replacement_track_ids', 'changed_track_ids']) {
    if (
      stableJson(authorization?.proof?.[field] || []) !==
      stableJson(proof?.[field] || [])
    ) {
      problems.push(`exact-call correction authorization ${field} proof is invalid`);
    }
  }
  return {
    ok: problems.length === 0,
    problems: [...new Set(problems)],
    priorEnvelope,
    archiveDir,
    proof,
  };
}

function readEnvelopeFile(file, fsApi = fs) {
  try {
    return JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function loadCompletionEnvelope({
  dataDir,
  otid,
  sourceRevisionHash,
  location = 'inbox',
  fsApi = fs,
} = {}) {
  const bundleDir =
    location === 'outbox'
      ? ''
      : envelopeInboxDir({ dataDir, otid, sourceRevisionHash });
  const file =
    location === 'outbox'
      ? envelopeOutboxPath({ dataDir, otid, sourceRevisionHash })
      : path.join(bundleDir, 'envelope.json');
  const envelope = readEnvelopeFile(file, fsApi);
  if (!envelope) {
    return {
      ok: false,
      found: false,
      file,
      bundleDir,
      envelope: null,
      problems: ['exact-call completion envelope is missing or unreadable'],
    };
  }
  const verification = verifyEnvelopeArtifacts(envelope, {
    dataDir,
    bundleDir,
    fsApi,
  });
  const bindingProblems = [];
  if (String(envelope.otid || '') !== String(otid || '')) {
    bindingProblems.push('exact-call envelope does not match the requested call');
  }
  if (
    String(envelope.source_revision_hash || '').toLowerCase() !==
    String(sourceRevisionHash || '').toLowerCase()
  ) {
    bindingProblems.push('exact-call envelope does not match the requested source revision');
  }
  const correctionFile = bundleDir
    ? path.join(bundleDir, '_correction_authorization.json')
    : '';
  let correctionAuthorization = null;
  const correctionProblems = [];
  if (correctionFile && fsApi.existsSync(correctionFile)) {
    const authorization = readEnvelopeFile(correctionFile, fsApi);
    const validation = validateCorrectionAuthorization({
      authorization,
      currentEnvelope: envelope,
      dataDir,
      currentBundleDir: bundleDir,
      fsApi,
    });
    correctionAuthorization = {
      ...(authorization || {}),
      ok: validation.ok,
      file: correctionFile,
      problems: validation.problems,
    };
    correctionProblems.push(...validation.problems);
  }
  const problems = [
    ...new Set([
      ...verification.problems,
      ...bindingProblems,
      ...correctionProblems,
    ]),
  ];
  return {
    ...verification,
    ok: problems.length === 0,
    problems,
    found: true,
    file,
    bundleDir,
    correction_authorization: correctionAuthorization,
  };
}

function cutoverPath(dataDir) {
  return path.join(path.resolve(dataDir), ROOT_RELATIVE, 'cutover.json');
}

function cutoverReleaseDir(dataDir) {
  return path.join(path.resolve(dataDir), ROOT_RELATIVE, 'cutover-releases');
}

function historicalCutoverAuthorizationDir(dataDir) {
  return path.join(
    path.resolve(dataDir),
    ROOT_RELATIVE,
    'historical-producer-authorizations',
  );
}

function validCutoverMarker(marker) {
  const producerContract = String(marker?.producer_contract_sha256 || '').toLowerCase();
  return (
    marker?.schema === CUTOVER_SCHEMA &&
    Number.isFinite(Date.parse(String(marker?.activated_at || ''))) &&
    Boolean(String(marker?.producer_sha || '').trim()) &&
    Boolean(String(marker?.consumer_sha || '').trim()) &&
    HASH_RE.test(String(marker?.core_document_sha256 || '').toLowerCase()) &&
    (!producerContract || HASH_RE.test(producerContract)) &&
    marker?.envelope_schema === ENVELOPE_SCHEMA &&
    (!marker?.envelope_required_since ||
      Number.isFinite(Date.parse(String(marker.envelope_required_since))))
  );
}

function activeCutoverMarkerValid(marker) {
  return (
    validCutoverMarker(marker) &&
    HASH_RE.test(String(marker?.producer_contract_sha256 || '').toLowerCase())
  );
}

function validHistoricalCutoverAuthorization(value) {
  const producerContract = String(
    value?.producer_contract_sha256 || '',
  ).toLowerCase();
  return (
    value?.schema === HISTORICAL_AUTHORIZATION_SCHEMA &&
    Number.isFinite(Date.parse(String(value?.authorized_at || ''))) &&
    Boolean(String(value?.producer_sha || '').trim()) &&
    HASH_RE.test(String(value?.core_document_sha256 || '').toLowerCase()) &&
    (!producerContract || HASH_RE.test(producerContract)) &&
    value?.envelope_schema === ENVELOPE_SCHEMA &&
    Boolean(String(value?.proof?.otid || '').trim()) &&
    HASH_RE.test(String(value?.proof?.source_revision_hash || '').toLowerCase()) &&
    HASH_RE.test(String(value?.proof?.bundle_hash || '').toLowerCase())
  );
}

function cutoverMarkerHash(marker) {
  return sha256Bytes(stableJson(marker));
}

function writeCutoverMarker({
  dataDir,
  activatedAt = new Date().toISOString(),
  producerSha,
  consumerSha,
  coreDocumentSha256,
  producerContractSha256 = '',
  envelopeSchema = ENVELOPE_SCHEMA,
  note = '',
  fsApi = fs,
} = {}) {
  const current = readCutoverMarker(dataDir, fsApi);
  if (current.found && !current.ok) {
    throw new Error(
      `invalid existing exact-call cutover chain blocks activation: ${current.problems.join('; ')}`,
    );
  }
  const marker = {
    schema: CUTOVER_SCHEMA,
    activated_at: String(activatedAt),
    envelope_required_since:
      current.marker?.envelope_required_since ||
      current.marker?.activated_at ||
      String(activatedAt),
    producer_sha: String(producerSha || '').trim(),
    consumer_sha: String(consumerSha || '').trim(),
    core_document_sha256: String(coreDocumentSha256 || '').toLowerCase(),
    producer_contract_sha256: String(producerContractSha256 || '').toLowerCase(),
    envelope_schema: String(envelopeSchema || '').trim(),
    note: String(note || ''),
  };
  if (
    !Number.isFinite(Date.parse(marker.activated_at)) ||
    !marker.producer_sha ||
    !marker.consumer_sha ||
    !HASH_RE.test(marker.core_document_sha256) ||
    !HASH_RE.test(marker.producer_contract_sha256) ||
    marker.envelope_schema !== ENVELOPE_SCHEMA
  ) {
    throw new Error(
      'active exact-call cutover requires a timestamp, producer SHA, consumer SHA, core-document hash, producer-contract hash, and current envelope schema',
    );
  }
  if (!current.marker) {
    return writeImmutableJson(cutoverPath(dataDir), marker, fsApi);
  }
  if (
    current.marker.producer_sha === marker.producer_sha &&
    current.marker.consumer_sha === marker.consumer_sha &&
    current.marker.core_document_sha256 === marker.core_document_sha256 &&
    String(current.marker.producer_contract_sha256 || '') ===
      String(marker.producer_contract_sha256 || '') &&
    current.marker.envelope_schema === marker.envelope_schema
  ) {
    return {
      created: false,
      idempotent: true,
      path: current.file,
      value: current.marker,
    };
  }
  if (
    Date.parse(marker.activated_at) <=
    Date.parse(String(current.marker.activated_at || ''))
  ) {
    throw new Error(
      'exact-call release activation must be later than the current immutable activation',
    );
  }
  marker.supersedes_sha256 = cutoverMarkerHash(current.marker);
  marker.release_sequence = Number(current.release_count || 0) + 1;
  const digest = cutoverMarkerHash(marker);
  const file = path.join(
    cutoverReleaseDir(dataDir),
    `${String(marker.release_sequence).padStart(6, '0')}-${digest.slice(0, 20)}.json`,
  );
  return writeImmutableJson(file, marker, fsApi);
}

function writeHistoricalCutoverAuthorization({
  dataDir,
  authorizedAt = new Date().toISOString(),
  producerSha,
  coreDocumentSha256,
  producerContractSha256 = '',
  envelopeSchema = ENVELOPE_SCHEMA,
  proof,
  note = '',
  fsApi = fs,
} = {}) {
  const cutover = readCutoverMarker(dataDir, fsApi);
  if (!cutover.found || !cutover.ok || !cutover.active_ok) {
    throw new Error(
      'historical producer authorization requires a contract-pinned active cutover chain',
    );
  }
  if (!cutover.authorization_ok) {
    throw new Error(
      `invalid existing historical producer authorizations block authorization: ${cutover.authorization_problems.join('; ')}`,
    );
  }
  const authorization = {
    schema: HISTORICAL_AUTHORIZATION_SCHEMA,
    authorized_at: String(authorizedAt),
    producer_sha: String(producerSha || '').trim(),
    core_document_sha256: String(coreDocumentSha256 || '').toLowerCase(),
    producer_contract_sha256: String(producerContractSha256 || '').toLowerCase(),
    envelope_schema: String(envelopeSchema || '').trim(),
    proof: {
      otid: String(proof?.otid || '').trim(),
      source_revision_hash: String(
        proof?.source_revision_hash || '',
      ).toLowerCase(),
      bundle_hash: String(proof?.bundle_hash || '').toLowerCase(),
      envelope_path: String(proof?.envelope_path || ''),
    },
    note: String(note || ''),
  };
  if (!validHistoricalCutoverAuthorization(authorization)) {
    throw new Error(
      'historical producer authorization requires a timestamp, producer SHA, core-document hash, current envelope schema, and exact verified bundle proof',
    );
  }
  const existing = (cutover.authorizations || []).find(
    (row) =>
      row.marker.producer_sha === authorization.producer_sha &&
      row.marker.core_document_sha256 === authorization.core_document_sha256 &&
      String(row.marker.producer_contract_sha256 || '') ===
        String(authorization.producer_contract_sha256 || '') &&
      row.marker.envelope_schema === authorization.envelope_schema &&
      row.marker.proof.bundle_hash === authorization.proof.bundle_hash,
  );
  if (existing) {
    return {
      created: false,
      idempotent: true,
      path: existing.file,
      value: existing.marker,
    };
  }
  const digest = cutoverMarkerHash(authorization);
  const file = path.join(
    historicalCutoverAuthorizationDir(dataDir),
    `${digest}.json`,
  );
  return writeImmutableJson(file, authorization, fsApi);
}

function readCutoverMarker(dataDir, fsApi = fs) {
  const rootFile = cutoverPath(dataDir);
  const initial = readEnvelopeFile(rootFile, fsApi);
  const releaseDir = cutoverReleaseDir(dataDir);
  const problems = [];
  const releases = [];
  const authorizationProblems = [];
  const authorizations = [];
  if (fsApi.existsSync(releaseDir)) {
    for (const name of fsApi
      .readdirSync(releaseDir)
      .filter((item) => item.endsWith('.json'))
      .sort()) {
      const file = path.join(releaseDir, name);
      const marker = readEnvelopeFile(file, fsApi);
      if (!validCutoverMarker(marker) || !HASH_RE.test(String(marker?.supersedes_sha256 || ''))) {
        problems.push(`exact-call release activation is invalid: ${name}`);
        continue;
      }
      releases.push({ file, marker });
    }
  }
  const authorizationDir = historicalCutoverAuthorizationDir(dataDir);
  if (fsApi.existsSync(authorizationDir)) {
    for (const name of fsApi
      .readdirSync(authorizationDir)
      .filter((item) => item.endsWith('.json'))
      .sort()) {
      const file = path.join(authorizationDir, name);
      const marker = readEnvelopeFile(file, fsApi);
      if (!validHistoricalCutoverAuthorization(marker)) {
        authorizationProblems.push(
          `historical producer authorization is invalid: ${name}`,
        );
        continue;
      }
      if (name !== `${cutoverMarkerHash(marker)}.json`) {
        authorizationProblems.push(
          `historical producer authorization filename hash is invalid: ${name}`,
        );
        continue;
      }
      authorizations.push({
        kind: 'historical_authorization',
        file,
        marker,
      });
    }
  }
  if (!initial && releases.length) {
    problems.push('exact-call release activations exist without the initial cutover marker');
  } else if (initial && !validCutoverMarker(initial)) {
    problems.push('exact-call envelope cutover marker is invalid');
  }

  const history = initial ? [{ file: rootFile, marker: initial }] : [];
  let current = initial ? { file: rootFile, marker: initial } : null;
  const remaining = [...releases];
  while (current && remaining.length) {
    const currentHash = cutoverMarkerHash(current.marker);
    const matches = remaining.filter(
      (row) => String(row.marker.supersedes_sha256 || '') === currentHash,
    );
    if (matches.length > 1) {
      problems.push('exact-call release activation chain is forked');
      break;
    }
    if (!matches.length) break;
    const next = matches[0];
    if (
      Date.parse(String(next.marker.activated_at || '')) <=
      Date.parse(String(current.marker.activated_at || ''))
    ) {
      problems.push('exact-call release activation timestamps are not monotonic');
      break;
    }
    history.push(next);
    current = next;
    remaining.splice(remaining.indexOf(next), 1);
  }
  if (remaining.length) {
    problems.push('exact-call release activation chain contains orphaned receipts');
  }
  const ok = Boolean(current) && problems.length === 0;
  const activeOk = ok && activeCutoverMarkerValid(current?.marker);
  return {
    ok,
    active_ok: activeOk,
    found: Boolean(initial || releases.length),
    file: ok ? current.file : rootFile,
    root_file: rootFile,
    marker: ok ? current.marker : null,
    initial_marker: validCutoverMarker(initial) ? initial : null,
    enforced_at:
      (validCutoverMarker(initial) &&
        (initial.envelope_required_since || initial.activated_at)) ||
      '',
    release_count: Math.max(0, history.length - 1),
    history,
    problems,
    authorization_ok: authorizationProblems.length === 0,
    authorization_count: authorizations.length,
    authorizations,
    authorization_problems: authorizationProblems,
  };
}

function authorizedCutoverRelease(
  cutover,
  {
    producerSha,
    coreDocumentSha256,
    producerContractSha256 = '',
    envelopeSchema = ENVELOPE_SCHEMA,
    bundleHash = '',
  } = {},
) {
  if (!cutover?.ok) return null;
  const activeRows =
    Array.isArray(cutover.history) && cutover.history.length
      ? cutover.history
      : cutover.marker
        ? [{ file: cutover.file || '', marker: cutover.marker }]
        : [];
  const rows = [
    ...activeRows.map((row) => ({ kind: 'active_release', ...row })),
    ...(cutover.authorization_ok === false
      ? []
      : (cutover.authorizations || []).map((row) => ({
          kind: 'historical_authorization',
          ...row,
        }))),
  ];
  return (
    rows.find(
      (row) =>
        row?.marker?.producer_sha === String(producerSha || '') &&
        (row.kind !== 'historical_authorization' ||
          (HASH_RE.test(String(bundleHash || '').toLowerCase()) &&
            row?.marker?.proof?.bundle_hash ===
              String(bundleHash || '').toLowerCase())) &&
        (row?.marker?.producer_contract_sha256
          ? Boolean(String(producerContractSha256 || '')) &&
            row.marker.producer_contract_sha256 ===
              String(producerContractSha256 || '').toLowerCase()
          : row?.marker?.core_document_sha256 ===
              String(coreDocumentSha256 || '').toLowerCase()) &&
        row?.marker?.envelope_schema === String(envelopeSchema || ''),
    ) || null
  );
}

function envelopeRequiredForCall({
  landedAt,
  envelopeFound = false,
  cutover,
} = {}) {
  if (envelopeFound) return true;
  const activatedAt =
    cutover?.enforced_at ||
    cutover?.marker?.envelope_required_since ||
    cutover?.envelope_required_since ||
    cutover?.marker?.activated_at ||
    cutover?.activated_at ||
    '';
  const landedMs = Date.parse(String(landedAt || ''));
  const activatedMs = Date.parse(String(activatedAt || ''));
  return (
    Number.isFinite(landedMs) &&
    Number.isFinite(activatedMs) &&
    landedMs >= activatedMs
  );
}

function copyVerifiedArtifact(source, destination, descriptor, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(destination), { recursive: true });
  if (
    fsApi.existsSync(destination) &&
    fsApi.statSync(destination).isFile() &&
    fsApi.statSync(destination).size === Number(descriptor.bytes) &&
    sha256File(destination, fsApi) === String(descriptor.sha256).toLowerCase()
  ) {
    return 'unchanged';
  }
  const temp = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    fsApi.copyFileSync(source, temp);
    if (
      fsApi.statSync(temp).size !== Number(descriptor.bytes) ||
      sha256File(temp, fsApi) !== String(descriptor.sha256).toLowerCase()
    ) {
      throw new Error(`copied exact-call artifact failed verification: ${descriptor.path}`);
    }
    fsApi.renameSync(temp, destination);
    return 'copied';
  } finally {
    fsApi.rmSync(temp, { force: true });
  }
}

function promoteCompletionEnvelope({
  sourceDataDir,
  destinationDataDir,
  envelopeFile,
  correctionReasonCode = '',
  fsApi = fs,
} = {}) {
  const envelope = readEnvelopeFile(envelopeFile, fsApi);
  // The immutable envelope carries its correction reason so reconciliation
  // callers cannot accidentally strip correction semantics in transit.
  const effectiveCorrectionReasonCode =
    String(correctionReasonCode || envelope?.correction_reason_code || '').trim();
  const envelopeValidationProblems = envelopeProblems(envelope);
  if (envelopeValidationProblems.length) {
    throw new Error(
      `exact-call completion envelope is invalid: ${envelopeValidationProblems.join('; ')}`,
    );
  }
  const finalDir = envelopeInboxDir({
    dataDir: destinationDataDir,
    otid: envelope.otid,
    sourceRevisionHash: envelope.source_revision_hash,
  });
  // EFS is a reusable job workspace. Once this exact bundle has been copied
  // into and verified from the immutable local inbox, later jobs may reuse the
  // source paths named by an old outbox envelope. The immutable inbox is then
  // the durable authority; re-reading mutable EFS bytes would turn a healthy
  // idempotent poll into a permanent false divergence.
  let existing = null;
  if (fsApi.existsSync(finalDir)) {
    existing = loadCompletionEnvelope({
      dataDir: destinationDataDir,
      otid: envelope.otid,
      sourceRevisionHash: envelope.source_revision_hash,
      fsApi,
    });
    if (existing.ok && existing.envelope.bundle_hash === envelope.bundle_hash) {
      return {
        promoted: false,
        idempotent: true,
        envelope,
        finalDir,
        copiedCanonicalArtifacts: 0,
      };
    }
    if (!existing.ok && effectiveCorrectionReasonCode !== MUTABLE_ENRICHED_PROJECTION_DEFECT) {
      throw new Error(
        `canonical exact-call inbox is invalid and cannot be corrected: ${existing.problems.join('; ')}`,
      );
    }
    if (![PRODUCER_TIMEBASE_DEFECT, MUTABLE_ENRICHED_PROJECTION_DEFECT].includes(effectiveCorrectionReasonCode)) {
      throw new Error(`canonical exact-call inbox conflicts with bundle ${envelope.bundle_hash}`);
    }
  } else if (effectiveCorrectionReasonCode === PRODUCER_TIMEBASE_DEFECT) {
    existing = loadInterruptedCorrectionPrior({
      dataDir: destinationDataDir,
      otid: envelope.otid,
      sourceRevisionHash: envelope.source_revision_hash,
      fsApi,
    });
    if (!existing) {
      throw new Error(
        'producer timebase defect correction requires a current or interrupted prior envelope',
      );
    }
  }
  const sourceVerification = verifyEnvelopeArtifacts(envelope, {
    dataDir: sourceDataDir,
    fsApi,
  });
  if (!sourceVerification.ok) {
    throw new Error(`exact-call source bundle failed verification: ${sourceVerification.problems.join('; ')}`);
  }
  const stagingRoot = path.join(
    path.resolve(destinationDataDir),
    ROOT_RELATIVE,
    'staging',
  );
  fsApi.mkdirSync(stagingRoot, { recursive: true });
  const stageDir = path.join(
    stagingRoot,
    `${envelope.bundle_hash}.${process.pid}.${Date.now()}.tmp`,
  );
  fsApi.mkdirSync(stageDir, { recursive: false });
  try {
    for (const descriptor of flattenArtifacts(envelope.artifacts)) {
      const source = artifactFile({ dataDir: sourceDataDir, descriptor });
      const destination = artifactFile({ bundleDir: stageDir, descriptor });
      copyVerifiedArtifact(source, destination, descriptor, fsApi);
    }
    fsApi.writeFileSync(
      path.join(stageDir, 'envelope.json'),
      `${JSON.stringify(envelope, null, 2)}\n`,
      'utf8',
    );
    const stagedVerification = verifyEnvelopeArtifacts(envelope, {
      dataDir: destinationDataDir,
      bundleDir: stageDir,
      fsApi,
    });
    if (!stagedVerification.ok) {
      throw new Error(`staged exact-call bundle failed verification: ${stagedVerification.problems.join('; ')}`);
    }
    fsApi.mkdirSync(path.dirname(finalDir), { recursive: true });
    if (existing) {
      const proof = effectiveCorrectionReasonCode === MUTABLE_ENRICHED_PROJECTION_DEFECT
        ? mutableEnrichedProjectionCorrectionProof({
            priorEnvelope: existing.envelope,
            replacementEnvelope: envelope,
            priorDataDir: destinationDataDir,
            priorBundleDir: existing.bundleDir,
            replacementDataDir: destinationDataDir,
            replacementBundleDir: stageDir,
            fsApi,
          })
        : producerTimebaseCorrectionProof({
            priorEnvelope: existing.envelope,
            replacementEnvelope: envelope,
            priorDataDir: destinationDataDir,
            priorBundleDir: existing.bundleDir,
            replacementDataDir: destinationDataDir,
            replacementBundleDir: stageDir,
            fsApi,
          });
      if (!proof.ok) {
        throw new Error(
          `exact-call correction rejected: ${proof.problems.join('; ')}`,
        );
      }
      const archiveDir = existing.interrupted_correction
        ? existing.bundleDir
        : envelopeSupersededDir({
            dataDir: destinationDataDir,
            otid: envelope.otid,
            sourceRevisionHash: envelope.source_revision_hash,
            bundleHash: existing.envelope.bundle_hash,
          });
      if (!existing.interrupted_correction && fsApi.existsSync(archiveDir)) {
        throw new Error(`superseded exact-call envelope archive already exists: ${archiveDir}`);
      }
      fsApi.mkdirSync(path.dirname(archiveDir), { recursive: true });
      const priorBundleDirectory = path
        .relative(path.resolve(destinationDataDir), archiveDir)
        .replace(/\\/g, '/');
      const authorization = {
        schema: CORRECTION_AUTHORIZATION_SCHEMA,
        otid: envelope.otid,
        source_revision_hash: envelope.source_revision_hash,
        reason_code: effectiveCorrectionReasonCode,
        prior_bundle_hash: existing.envelope.bundle_hash,
        replacement_bundle_hash: envelope.bundle_hash,
        prior_bundle_directory: priorBundleDirectory,
        proof: {
          ...(effectiveCorrectionReasonCode === PRODUCER_TIMEBASE_DEFECT ? {
            expected_divisor: proof.expected_divisor,
            prior_divisor: proof.prior_divisor,
            replacement_divisor: proof.replacement_divisor,
            timebase_source: proof.timebase_source,
          } : {}),
          raw_sha256: proof.raw_sha256,
          prior_enriched_sha256: proof.prior_enriched_sha256,
          replacement_enriched_sha256: proof.replacement_enriched_sha256,
          replacement_track_ids: proof.replacement_track_ids,
          changed_track_ids: proof.changed_track_ids,
        },
        authorized_at: new Date().toISOString(),
      };
      authorization.authorization_hash = correctionAuthorizationHash(authorization);
      fsApi.writeFileSync(
        path.join(stageDir, '_correction_authorization.json'),
        `${JSON.stringify(authorization, null, 2)}\n`,
        'utf8',
      );
      if (!existing.interrupted_correction) fsApi.renameSync(finalDir, archiveDir);
      try {
        fsApi.renameSync(stageDir, finalDir);
      } catch (error) {
        if (!existing.interrupted_correction) fsApi.renameSync(archiveDir, finalDir);
        throw error;
      }
      writeImmutableJson(
        path.join(archiveDir, '_supersession.json'),
        {
          schema: 'life_archive_otter_exact_call_completion_supersession.v1',
          otid: envelope.otid,
          source_revision_hash: envelope.source_revision_hash,
          reason_code: effectiveCorrectionReasonCode,
          prior_bundle_hash: existing.envelope.bundle_hash,
          replacement_bundle_hash: envelope.bundle_hash,
          authorization_hash: authorization.authorization_hash,
          superseded_at: authorization.authorized_at,
        },
        fsApi,
      );
      existing.correction = {
        archiveDir,
        authorization,
      };
    } else {
      fsApi.renameSync(stageDir, finalDir);
    }
  } finally {
    if (fsApi.existsSync(stageDir)) fsApi.rmSync(stageDir, { recursive: true, force: true });
  }

  let copiedCanonicalArtifacts = 0;
  for (const descriptor of flattenArtifacts(envelope.artifacts)) {
    if (['raw_transcript', 'raw_archive_receipt'].includes(descriptor.kind)) {
      continue;
    }
    const source = artifactFile({ bundleDir: finalDir, descriptor });
    const destination = artifactFile({ dataDir: destinationDataDir, descriptor });
    if (copyVerifiedArtifact(source, destination, descriptor, fsApi) === 'copied') {
      copiedCanonicalArtifacts += 1;
    }
  }
  return {
    promoted: true,
    idempotent: false,
    corrected: Boolean(existing?.correction),
    recovered_interrupted_correction: Boolean(existing?.interrupted_correction),
    prior_bundle_hash: existing?.correction ? existing.envelope.bundle_hash : '',
    correction_authorization: existing?.correction?.authorization || null,
    envelope,
    finalDir,
    copiedCanonicalArtifacts,
  };
}

module.exports = {
  CORRECTION_AUTHORIZATION_SCHEMA,
  CUTOVER_SCHEMA,
  ENVELOPE_SCHEMA,
  HISTORICAL_AUTHORIZATION_SCHEMA,
  PRODUCER_TIMEBASE_DEFECT,
  MUTABLE_ENRICHED_PROJECTION_DEFECT,
  ROOT_RELATIVE,
  activeCutoverMarkerValid,
  artifactDescriptor,
  artifactFile,
  authorizedCutoverRelease,
  buildCompletionEnvelope,
  callKey,
  cutoverMarkerHash,
  cutoverPath,
  cutoverReleaseDir,
  envelopeHash,
  envelopeInboxDir,
  envelopeCorrectionOutboxPath,
  envelopeOutboxPath,
  envelopeSupersededDir,
  envelopeProblems,
  envelopeRequiredForCall,
  loadInterruptedCorrectionPrior,
  flattenArtifacts,
  historicalCutoverAuthorizationDir,
  loadCompletionEnvelope,
  promoteCompletionEnvelope,
  mutableEnrichedProjectionCorrectionProof,
  producerTimebaseCorrectionProof,
  resolvedRawTimebaseProof,
  readCutoverMarker,
  safeDescriptorPath,
  sha256File,
  stableJson,
  verifyEnvelopeArtifacts,
  writeCompletionEnvelope,
  writeCutoverMarker,
  writeHistoricalCutoverAuthorization,
};
