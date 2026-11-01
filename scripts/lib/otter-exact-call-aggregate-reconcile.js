'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadCompletionEnvelope,
} = require('./otter-exact-call-envelope.js');
const {
  acquireReclusterPublishLock,
} = require('./recluster-publish-lock.js');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function readJson(file, fallback, fsApi = fs) {
  try {
    return JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function saveJsonAtomic(file, value, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fsApi.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fsApi.renameSync(temp, file);
}

function aggregateTrackFromExact(row) {
  return {
    speaker_model_label: String(row?.speaker_model_label || ''),
    substantive: row?.substantive === true,
    identity_grade: row?.identity_grade === true,
    state: String(row?.state || ''),
    probe_audio_path: String(row?.probe_audio_path || ''),
    embedding_path: String(row?.embedding_path || ''),
    identity: row?.identity || null,
  };
}

function probeRevision(row) {
  return String(row?.source_revision || row?.source_revision_hash || '').toLowerCase();
}

function assertAcceptedCandidatesAreConfirmed(envelope) {
  const tracks = new Map(
    (envelope?.identity_tracks || []).map((track) => [
      String(track?.speaker_model_label || ''),
      track?.identity || {},
    ]),
  );
  for (const candidate of envelope?.ranked_identity_candidates || []) {
    if (candidate?.decision !== 'accepted') continue;
    const identity = tracks.get(String(candidate?.speaker_model_label || '')) || {};
    if (
      identity.identity_tier !== 'confirmed_reference_voiceprint_match' ||
      String(identity.person_id || '').trim().toLowerCase() !==
        String(candidate?.candidate_person_id || '').trim().toLowerCase()
    ) {
      throw new Error(
        'accepted ranked identity candidate is not a confirmed canonical envelope identity',
      );
    }
  }
}

function reconcileProbeIndex({
  file,
  otid,
  sourceRevisionHash,
  exactTracks,
  now,
  fsApi,
}) {
  if (!fsApi.existsSync(file)) {
    return {
      changed: false,
      removed_identity_grade_rows: 0,
      upserted_identity_grade_rows: 0,
      before_hash: null,
      after_hash: null,
    };
  }
  const report = readJson(file, { probes: [] }, fsApi);
  const beforeHash = sha256(JSON.stringify(report));
  const exactRevision = String(sourceRevisionHash).toLowerCase();
  const exactLabels = new Set(
    exactTracks.map((track) => String(track?.speaker_model_label || '').trim()),
  );
  let removedIdentityGradeRows = 0;
  const probes = (Array.isArray(report.probes) ? report.probes : []).filter((row) => {
    const sameCall = String(row?.otid || '') === String(otid);
    const sameRevision = probeRevision(row) === exactRevision;
    const label = String(row?.speaker_model_label || '').trim();
    const staleIdentityGradeRow =
      sameCall &&
      sameRevision &&
      row?.identity_grade === true &&
      !exactLabels.has(label);
    if (staleIdentityGradeRow) removedIdentityGradeRows += 1;
    return !staleIdentityGradeRow;
  });
  let upsertedIdentityGradeRows = 0;
  for (const track of exactTracks.filter((row) => row.identity_grade === true)) {
    const label = String(track.speaker_model_label || '').trim();
    const existingIndex = probes.findIndex(
      (row) =>
        String(row?.otid || '') === String(otid) &&
        probeRevision(row) === exactRevision &&
        String(row?.speaker_model_label || '').trim() === label,
    );
    const exactRow = {
      ...(existingIndex >= 0 ? probes[existingIndex] : {}),
      otid: String(otid),
      source_revision: exactRevision,
      speaker_model_label: label,
      substantive: track.substantive === true,
      identity_grade: true,
      state: String(track.state || ''),
      probe_audio_path: String(track.probe_audio_path || ''),
      embedding_path: String(track.embedding_path || ''),
      identity: track.identity || null,
      exact_bundle_authoritative: true,
    };
    if (existingIndex >= 0) probes[existingIndex] = exactRow;
    else probes.push(exactRow);
    upsertedIdentityGradeRows += 1;
  }
  if (removedIdentityGradeRows === 0 && upsertedIdentityGradeRows === 0) {
    return {
      changed: false,
      removed_identity_grade_rows: 0,
      upserted_identity_grade_rows: 0,
      before_hash: beforeHash,
      after_hash: beforeHash,
    };
  }
  const next = {
    ...report,
    generated_at: now(),
    probes,
  };
  const afterHash = sha256(JSON.stringify(next));
  saveJsonAtomic(file, next, fsApi);
  return {
    changed: true,
    removed_identity_grade_rows: removedIdentityGradeRows,
    upserted_identity_grade_rows: upsertedIdentityGradeRows,
    before_hash: beforeHash,
    after_hash: afterHash,
  };
}

function reconcileExactCallAggregate({
  dataDir,
  otid,
  sourceRevisionHash,
  now = () => new Date().toISOString(),
  fsApi = fs,
  verifiedEnvelope = null,
  verifiedBundleDir = '',
  publishLockOptions = {},
} = {}) {
  const exact = verifiedEnvelope
    ? { ok: true, envelope: verifiedEnvelope, bundleDir: verifiedBundleDir }
    : loadCompletionEnvelope({
        dataDir,
        otid,
        sourceRevisionHash,
        fsApi,
      });
  if (!exact.ok) {
    throw new Error(
      `verified exact completion envelope is required for aggregate reconcile: ${(exact.problems || [])
        .slice(0, 3)
        .join('; ') || 'not found'}`,
    );
  }
  assertAcceptedCandidatesAreConfirmed(exact.envelope);
  const vpDir = path.join(dataDir, 'life-archive', 'voiceprints');
  const file = path.join(vpDir, 'probe-eligibility-latest.json');
  // Every exact-call repair updates the same two corpus aggregates. Atomic
  // rename prevents torn JSON, but without a transaction lock concurrent
  // repairs can all read the same prior state and the last rename silently
  // discards the other calls. Use the canonical artifact-scoped publish lock
  // across both read-modify-write operations so a successful receipt is
  // durable when attended finishing runs several calls in parallel.
  const publishLock = acquireReclusterPublishLock(file, {
    ...publishLockOptions,
    fsApi,
  });
  try {
    const report = readJson(file, { calls: [] }, fsApi);
    const beforeHash = sha256(JSON.stringify(report));
    const calls = Array.isArray(report.calls) ? [...report.calls] : [];
    const index = calls.findIndex((row) => String(row?.otid || '') === String(otid));
    const prior = index >= 0 ? calls[index] : {};
    const priorTracks = new Map(
      (Array.isArray(prior.tracks) ? prior.tracks : []).map((track) => [
        String(track?.speaker_model_label || ''),
        track,
      ]),
    );
    const exactTracks = (exact.envelope.identity_tracks || []).map((track) => {
      const exactTrack = aggregateTrackFromExact(track);
      return {
        ...(priorTracks.get(exactTrack.speaker_model_label) || {}),
        ...exactTrack,
      };
    });
    const call = {
      ...prior,
      otid: String(otid),
      source_revision: String(sourceRevisionHash).toLowerCase(),
      source_revision_hash: String(sourceRevisionHash).toLowerCase(),
      tracks: exactTracks,
      exact_bundle_hash: exact.envelope.bundle_hash,
      exact_bundle_projected_at: now(),
      exact_bundle_authoritative: true,
    };
    if (index >= 0) calls[index] = call;
    else calls.push(call);
    const next = {
      ...report,
      generated_at: now(),
      calls,
    };
    const afterHash = sha256(JSON.stringify(next));
    if (afterHash !== beforeHash) saveJsonAtomic(file, next, fsApi);
    const probeIndexFile = path.join(vpDir, 'track-probe-index-latest.json');
    const probeIndex = reconcileProbeIndex({
      file: probeIndexFile,
      otid,
      sourceRevisionHash,
      exactTracks,
      now,
      fsApi,
    });
    return {
      ok: true,
      changed: afterHash !== beforeHash || probeIndex.changed,
      otid: String(otid),
      source_revision_hash: String(sourceRevisionHash).toLowerCase(),
      exact_bundle_hash: exact.envelope.bundle_hash,
      track_count: exactTracks.length,
      eligibility_path: file,
      before_hash: beforeHash,
      after_hash: afterHash,
      probe_index_path: probeIndexFile,
      probe_index_changed: probeIndex.changed,
      probe_index_removed_identity_grade_rows:
        probeIndex.removed_identity_grade_rows,
      probe_index_upserted_identity_grade_rows:
        probeIndex.upserted_identity_grade_rows,
      probe_index_before_hash: probeIndex.before_hash,
      probe_index_after_hash: probeIndex.after_hash,
    };
  } finally {
    publishLock.release();
  }
}

module.exports = {
  aggregateTrackFromExact,
  assertAcceptedCandidatesAreConfirmed,
  reconcileExactCallAggregate,
};
