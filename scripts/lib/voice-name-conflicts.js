'use strict';

const crypto = require('node:crypto');
const { cosine } = require('./voice-reference-people.js');
const { logisticProbability } = require('./voice-score-normalization.js');
const { firstNamesCompatible } = require('./people-name-match.js');
const { fingerprintCluster } = require('./voice-name-judge-coverage.js');
const { canonicalPersonId } = require('./voice-people-file-target.js');

const DEFAULT_CONTRADICTION_MARGIN = 0.1;

function acousticAssignmentFingerprint(cluster = {}) {
  const identity = {
    cluster_id: String(cluster.cluster_id || ''),
    confirmed_person_id: String(cluster.confirmed_person_id || ''),
    member_track_keys: (cluster.member_track_keys || [])
      .map(String)
      .sort(),
    members: (cluster.members || [])
      .map((row) => ({
        otid: String(row && row.otid ? row.otid : ''),
        speaker_model_label: String(
          row && row.speaker_model_label ? row.speaker_model_label : '',
        ),
        probe_audio_path: String(row && row.probe_audio_path ? row.probe_audio_path : ''),
      }))
      .sort((a, b) =>
        `${a.otid}|${a.speaker_model_label}|${a.probe_audio_path}`.localeCompare(
          `${b.otid}|${b.speaker_model_label}|${b.probe_audio_path}`,
        ),
      ),
    centroid: (cluster.centroid || []).map((value) => Number(Number(value).toFixed(6))),
  };
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function assignmentOverride(registry, cluster, fingerprint) {
  const row =
    registry &&
    registry.voiceprint_assignment_overrides &&
    registry.voiceprint_assignment_overrides[cluster.cluster_id];
  if (!row || row.disposition !== 'keep_voiceprint') return null;
  if (String(row.person_id || '') !== String(cluster.confirmed_person_id || '')) return null;
  if (String(row.cluster_fingerprint || '') !== fingerprint) return null;
  return row;
}

function calibratedProbability(calibration, rawScore) {
  if (
    !calibration ||
    calibration.status !== 'ok' ||
    calibration.models?.global?.trained !== true
  ) {
    return null;
  }
  const value = logisticProbability(calibration.models.global, rawScore);
  return value == null ? null : Number(value.toFixed(6));
}

function buildAcousticAssignmentAudit({
  cluster = {},
  referencePeople = [],
  calibration = null,
  registry = {},
  contradictionMargin = DEFAULT_CONTRADICTION_MARGIN,
} = {}) {
  const fingerprint = acousticAssignmentFingerprint(cluster);
  const assignedPersonId = String(cluster.confirmed_person_id || '');
  const centroid = Array.isArray(cluster.centroid) ? cluster.centroid : [];
  const base = {
    schemaVersion: 1,
    cluster_fingerprint: fingerprint,
    assigned_person_id: assignedPersonId,
    assigned_display_name: String(cluster.confirmed_display_name || assignedPersonId),
  };
  if (!assignedPersonId || !centroid.length) {
    return { ...base, status: 'unverified', reason: 'confirmed-assignment-and-centroid-required' };
  }
  if (
    !calibration ||
    calibration.status !== 'ok' ||
    calibration.models?.global?.trained !== true
  ) {
    return { ...base, status: 'unverified', reason: 'trained-calibration-required' };
  }
  const assignedReference = referencePeople.find(
    (person) => String(person && person.person_id) === assignedPersonId,
  );
  if (!assignedReference || !Array.isArray(assignedReference.centroid)) {
    return { ...base, status: 'unverified', reason: 'assigned-reference-voiceprint-required' };
  }
  const alternatives = referencePeople
    .filter(
      (person) =>
        person &&
        String(person.person_id || '') !== assignedPersonId &&
        Array.isArray(person.centroid),
    )
    .map((person) => ({
      person,
      rawScore: cosine(centroid, person.centroid),
    }))
    .sort((a, b) => b.rawScore - a.rawScore);
  const alternative = alternatives[0] || null;
  const assignedRawScore = cosine(centroid, assignedReference.centroid);
  const assignedProbability = calibratedProbability(calibration, assignedRawScore);
  const alternativeProbability = alternative
    ? calibratedProbability(calibration, alternative.rawScore)
    : null;
  const alternativeMargin = alternative ? alternative.rawScore - assignedRawScore : null;
  const evidence = {
    ...base,
    assigned_raw_score: Number(assignedRawScore.toFixed(6)),
    assigned_probability: assignedProbability,
    best_alternative_person_id: alternative ? String(alternative.person.person_id || '') : null,
    best_alternative_display_name: alternative
      ? String(alternative.person.display_name || alternative.person.person_id || '')
      : null,
    best_alternative_raw_score: alternative
      ? Number(alternative.rawScore.toFixed(6))
      : null,
    best_alternative_probability: alternativeProbability,
    alternative_margin_over_assigned:
      alternativeMargin == null ? null : Number(alternativeMargin.toFixed(6)),
    calibrated_probability_gate: Number(
      calibration.ops?.calibrated_probability_gate ?? 0.99,
    ),
    calibrated_min_raw_floor: Number(calibration.ops?.calibrated_min_raw_floor ?? 0.56),
    contradiction_margin_gate: Number(contradictionMargin),
  };
  const override = assignmentOverride(registry, cluster, fingerprint);
  if (override) {
    return {
      ...evidence,
      status: 'assigned_voiceprint_kept_by_ExampleCo',
      reason:
        'ExampleCo confirmed this exact acoustic membership as the assigned voiceprint; the same mismatch claim is suppressed until the acoustic evidence changes.',
      override,
    };
  }
  const contradiction =
    alternative &&
    alternativeProbability != null &&
    alternativeProbability >= evidence.calibrated_probability_gate &&
    alternative.rawScore >= evidence.calibrated_min_raw_floor &&
    alternativeMargin >= evidence.contradiction_margin_gate;
  return contradiction
    ? {
        ...evidence,
        status: 'confident_acoustic_contradiction',
        reason:
          'A trained calibrated acoustic model strongly favors a different enrolled voice over the assigned voiceprint.',
      }
    : {
        ...evidence,
        status: 'assigned_voiceprint_supported',
        reason:
          'Current calibrated acoustic evidence does not clear the serious contradiction gate.',
      };
}

function playableIdentity(cluster) {
  const member = (cluster.members || []).find((row) => row && row.probe_audio_path) || {};
  const sourceRevision = String(
    member.source_revision || member.otter_revision || '',
  );
  const actionVoiceClusterId = [
    member.voice_cluster_id,
    ...(Array.isArray(member.source_voice_cluster_ids) ? member.source_voice_cluster_ids : []),
  ]
    .map((value) => String(value || ''))
    .find(
      (value) =>
        value.startsWith('speaker_') &&
        value.slice('speaker_'.length).length > 0 &&
        [...value.slice('speaker_'.length)].every((character) => '0123456789'.includes(character)),
    );
  return {
    acoustic_unknown_id: String(cluster.cluster_id || ''),
    voice_cluster_id: String(member.voice_cluster_id || ''),
    action_voice_cluster_id: String(actionVoiceClusterId || ''),
    otid: String(member.otid || ''),
    source_revision: sourceRevision,
    speaker_model_label: String(member.speaker_model_label || ''),
    probe_audio_path: String(member.probe_audio_path || ''),
  };
}

function conflictRow(cluster) {
  const assignment = cluster.acoustic_assignment_audit || {};
  const identity = playableIdentity(cluster);
  return {
    target: String(cluster.cluster_id || ''),
    person_id: String(cluster.confirmed_person_id || assignment.assigned_person_id || ''),
    confirmed_display_name: String(
      cluster.confirmed_display_name ||
        assignment.assigned_display_name ||
        cluster.confirmed_person_id ||
        '',
    ),
    source: 'calibrated_acoustic_assignment_audit',
    confidence: assignment.best_alternative_probability,
    confidence_basis: 'calibrated_acoustic_probability',
    why: String(assignment.reason || ''),
    assignment_cluster_id: String(cluster.cluster_id || ''),
    cluster_fingerprint: String(assignment.cluster_fingerprint || ''),
    assigned_raw_score: assignment.assigned_raw_score,
    assigned_probability: assignment.assigned_probability,
    best_alternative_person_id: assignment.best_alternative_person_id,
    best_alternative_display_name: assignment.best_alternative_display_name,
    best_alternative_raw_score: assignment.best_alternative_raw_score,
    best_alternative_probability: assignment.best_alternative_probability,
    alternative_margin_over_assigned: assignment.alternative_margin_over_assigned,
    ...identity,
    audio_url: identity.probe_audio_path
      ? `/life-archive/voice-audio?path=${encodeURIComponent(identity.probe_audio_path)}`
      : '',
    review_url: `/life-archive/voice-sequence?target=${encodeURIComponent(
      identity.acoustic_unknown_id || identity.voice_cluster_id,
    )}`,
    disposition: {
      action: 'keep_voiceprint',
      label: 'Keep this voiceprint',
      person_id: String(cluster.confirmed_person_id || ''),
      assignment_cluster_id: String(cluster.cluster_id || ''),
      action_voice_cluster_id: identity.action_voice_cluster_id,
      cluster_fingerprint: String(assignment.cluster_fingerprint || ''),
    },
  };
}

function targetRows(report = {}) {
  const summaries = new Map(
    (report.target_summaries || []).map((row) => [String(row?.target || ''), row || {}]),
  );
  return (report?.judged?.targets || [])
    .map((row) => {
      const target = String(row?.target || '');
      const summary = summaries.get(target) || {};
      return {
        ...row,
        target,
        generated_at: String(report.generated_at || ''),
        input_fingerprint: String(
          row?.input_fingerprint || summary.input_fingerprint || '',
        ),
        coverage_complete:
          row?.coverage_complete === true || summary.coverage_complete === true,
        source_revisions: [
          ...new Set([
            ...(row?.source_revisions || []),
            ...(summary.source_revisions || []),
          ]),
        ]
          .map(String)
          .filter(Boolean)
          .sort(),
        source_revision_by_otid: {
          ...(summary.source_revision_by_otid || {}),
          ...(row?.source_revision_by_otid || {}),
        },
      };
    })
    .filter((row) => row.target);
}

function currentNameJudgment(cluster, reports = []) {
  const clusterId = String(cluster?.cluster_id || '');
  const currentFingerprint = fingerprintCluster(cluster);
  if (!clusterId || !currentFingerprint) return null;
  const candidates = (reports || [])
    .flatMap(targetRows)
    .filter(
      (row) =>
        row.target === clusterId &&
        row.coverage_complete === true &&
        row.input_fingerprint === currentFingerprint,
    )
    .sort(
      (left, right) =>
        String(right.generated_at || '').localeCompare(String(left.generated_at || '')) ||
        JSON.stringify(right).localeCompare(JSON.stringify(left)),
    );
  return candidates[0] || null;
}

function candidateSourceRevision(candidate = {}, cluster = {}) {
  const direct = String(candidate.source_revision || candidate.otter_revision || '').trim();
  if (direct) return direct;
  const member = (cluster.members || []).find(
    (row) =>
      String(row?.otid || '') === String(candidate.otid || '') &&
      String(row?.speaker_model_label || '') ===
        String(candidate.speaker_model_label || ''),
  );
  return String(member?.source_revision || member?.otter_revision || '').trim();
}

function judgmentCoversCandidate(judgment, candidate, cluster) {
  if (!judgment) return false;
  const expectedRevision = candidateSourceRevision(candidate, cluster);
  const judgedRevision = String(
    judgment.source_revision_by_otid?.[String(candidate.otid || '')] || '',
  ).trim();
  if (!expectedRevision) return true;
  return Boolean(judgedRevision) && expectedRevision === judgedRevision;
}

function candidateMatchesConfirmedCluster(candidate = {}, cluster = {}) {
  const candidatePersonId = canonicalPersonId(candidate.candidate_person_id || '');
  const confirmedPersonId = canonicalPersonId(
    cluster.confirmed_person_id ||
      String(cluster.cluster_id || '').replace(/^person:/i, ''),
  );
  return Boolean(candidatePersonId) && candidatePersonId === confirmedPersonId;
}

function numericNameConfidence(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const normalized = String(value || '').trim().toLowerCase();
  if (['strong', 'high', 'confirmed', 'certain'].includes(normalized)) return 1;
  if (['medium', 'provisional'].includes(normalized)) return 0.7;
  return 0;
}

function strongContradictoryName(judgment, candidate) {
  const bestName = String(judgment?.best_name || '').trim();
  const candidateName = String(
    candidate?.display_name || candidate?.candidate_person_id || '',
  )
    .replace(/_/g, ' ')
    .trim();
  if (!bestName || !candidateName || firstNamesCompatible(bestName, candidateName)) {
    return false;
  }
  return (
    numericNameConfidence(judgment.confidence) >= 0.9 &&
    Number(judgment.clear_evidence_count || 0) >= 2 &&
    Number(judgment.counterevidence_count || 0) === 0
  );
}

function exactOwnerDeniesCandidate(candidate, ownerCorrections = []) {
  const candidatePersonId = canonicalPersonId(candidate?.candidate_person_id || '');
  const candidateRevision = String(
    candidate?.source_revision || candidate?.otter_revision || '',
  ).toLowerCase();
  return (ownerCorrections || []).find(
    (row) =>
      row?.source === 'owner-direct-correction' &&
      row?.action === 'not_them' &&
      String(row?.otid || '') === String(candidate?.otid || '') &&
      String(row?.speakerModelLabel || row?.speaker_model_label || '') ===
        String(candidate?.speaker_model_label || '') &&
      (!candidateRevision ||
        String(row?.sourceRevision || row?.source_revision_hash || '').toLowerCase() ===
          candidateRevision) &&
      canonicalPersonId(row?.deniedPersonId || row?.denied_person_id || '') ===
        candidatePersonId,
  ) || null;
}

function provisionalNameConflictRow(candidate, cluster, judgment) {
  const identity = playableIdentity(cluster);
  const sourceRevision = candidateSourceRevision(candidate, cluster);
  const sourceRevisionByOtid = {
    ...(judgment.source_revision_by_otid || {}),
  };
  if (candidate.otid && sourceRevision) {
    sourceRevisionByOtid[String(candidate.otid)] = sourceRevision;
  }
  const sourceRevisions = [
    ...new Set([
      ...(judgment.source_revisions || []),
      sourceRevision,
    ]),
  ]
    .map(String)
    .filter(Boolean)
    .sort();
  const observationKey = `${String(candidate.otid || '')}|${String(
    candidate.speaker_model_label || '',
  )}`;
  return {
    conflict_type: 'provisional_promotion_name_mismatch',
    target: String(cluster.cluster_id || ''),
    source: 'whole_call_marked_target_membership',
    candidate_person_id: String(candidate.candidate_person_id || ''),
    candidate_display_name: String(
      candidate.display_name || candidate.candidate_person_id || '',
    ),
    marked_call_best_name: String(judgment.best_name || ''),
    confidence: judgment.confidence ?? null,
    confidence_basis: 'current_complete_marked_target_name_judgment',
    clear_evidence_count: Number(judgment.clear_evidence_count || 0),
    counterevidence_count: Number(judgment.counterevidence_count || 0),
    why:
      'The unresolved acoustic candidate cannot be promoted because current complete marked-speaker evidence strongly names a different person.',
    input_fingerprint: String(judgment.input_fingerprint || ''),
    source_revisions: sourceRevisions,
    source_revision_by_otid: sourceRevisionByOtid,
    observation_key: observationKey,
    ...identity,
    audio_url: identity.probe_audio_path
      ? `/life-archive/voice-audio?path=${encodeURIComponent(identity.probe_audio_path)}`
      : '',
    review_url: `/life-archive/voice-sequence?target=${encodeURIComponent(
      String(cluster.cluster_id || ''),
    )}`,
  };
}

function buildVoiceNameConflictAudit({
  recluster = { clusters: [] },
  sandboxCandidates = { candidates: [] },
  nameJudgmentReports = [],
  ownerCorrections = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const clusters = Array.isArray(recluster && recluster.clusters) ? recluster.clusters : [];
  const contradictions = clusters.filter(
    (cluster) =>
      cluster &&
      cluster.acoustic_assignment_audit?.status === 'confident_acoustic_contradiction',
  );
  const acousticConflicts = contradictions.map(conflictRow);
  const blockedAcousticIds = acousticConflicts
    .map((row) => row.acoustic_unknown_id)
    .filter(Boolean);
  const clusterByObservation = new Map();
  for (const cluster of clusters) {
    for (const member of cluster.members || []) {
      clusterByObservation.set(
        `${String(member.otid || '')}|${String(member.speaker_model_label || '')}`,
        cluster,
      );
    }
  }
  const blockedSet = new Set(blockedAcousticIds);
  const evaluatedObservationKeys = [];
  const readyForPromotionObservationKeys = [];
  const observationAcousticUnknownIds = {};
  const pendingSandboxCandidates = [];
  const ownerDeniedSandboxCandidates = [];
  const provisionalNameConflicts = [];
  const sourceRevisions = new Set();
  const sourceRevisionByOtid = {};
  for (const candidate of sandboxCandidates?.candidates || []) {
    const key = `${String(candidate.otid || '')}|${String(
      candidate.speaker_model_label || '',
    )}`;
    const cluster = clusterByObservation.get(key);
    if (!cluster) {
      pendingSandboxCandidates.push({
        ...candidate,
        observation_key: key,
        reason: 'durable_acoustic_cluster_missing',
      });
      continue;
    }
    const ownerDenial = exactOwnerDeniesCandidate(candidate, ownerCorrections);
    if (ownerDenial) {
      ownerDeniedSandboxCandidates.push({
        ...candidate,
        observation_key: key,
        acoustic_unknown_id: String(cluster.cluster_id || ''),
        owner_correction_id: String(ownerDenial.owner_correction_id || ''),
        reason: 'candidate_rejected_by_exact_owner_correction',
      });
      continue;
    }
    observationAcousticUnknownIds[key] = String(cluster.cluster_id || '');
    if (candidateMatchesConfirmedCluster(candidate, cluster)) {
      evaluatedObservationKeys.push(key);
      readyForPromotionObservationKeys.push(key);
      const sourceRevision = candidateSourceRevision(candidate, cluster);
      if (sourceRevision) {
        sourceRevisions.add(sourceRevision);
        if (candidate.otid) sourceRevisionByOtid[String(candidate.otid)] = sourceRevision;
      }
      continue;
    }
    const judgment = currentNameJudgment(cluster, nameJudgmentReports);
    if (!judgment || !judgmentCoversCandidate(judgment, candidate, cluster)) {
      pendingSandboxCandidates.push({
        ...candidate,
        observation_key: key,
        acoustic_unknown_id: String(cluster.cluster_id || ''),
        reason: 'current_complete_marked_call_disposition_missing',
      });
      continue;
    }
    evaluatedObservationKeys.push(key);
    for (const revision of judgment.source_revisions || []) sourceRevisions.add(revision);
    for (const [otid, revision] of Object.entries(judgment.source_revision_by_otid || {})) {
      if (otid && revision) sourceRevisionByOtid[otid] = String(revision);
    }
    if (strongContradictoryName(judgment, candidate)) {
      const row = provisionalNameConflictRow(candidate, cluster, judgment);
      provisionalNameConflicts.push(row);
      blockedSet.add(String(cluster.cluster_id || ''));
      blockedAcousticIds.push(String(cluster.cluster_id || ''));
      continue;
    }
    if (!blockedSet.has(String(cluster.cluster_id || ''))) {
      readyForPromotionObservationKeys.push(key);
    }
  }
  const conflicts = [...acousticConflicts, ...provisionalNameConflicts];
  const blockedObservationKeys = [
    ...acousticConflicts
      .map((row) =>
        row.otid && row.speaker_model_label
          ? `${row.otid}|${row.speaker_model_label}`
          : '',
      )
      .filter(Boolean),
    ...provisionalNameConflicts.map((row) => row.observation_key).filter(Boolean),
  ];
  return {
    schema: 'life_archive_voiceprint_acoustic_contradictions.v2',
    generated_at: generatedAt,
    status: conflicts.length ? 'RED' : 'GREEN',
    confident_acoustic_contradictions: acousticConflicts.length,
    provisional_promotion_name_conflicts: provisionalNameConflicts.length,
    // Backward-readable zeros keep older health readers honest while they roll
    // to the v2 acoustic field. Text naming is no longer a contradiction gate.
    confirmed_voice_text_name_conflicts: 0,
    conflicts_without_playable_audio: conflicts.filter((row) => !row.probe_audio_path).length,
    sandbox_candidates_without_marked_call_disposition: pendingSandboxCandidates.length,
    blocked_acoustic_unknown_ids: [...new Set(blockedAcousticIds)],
    blocked_voice_cluster_ids: [
      ...new Set(conflicts.map((row) => row.voice_cluster_id).filter(Boolean)),
    ],
    blocked_observation_keys: [...new Set(blockedObservationKeys)],
    pending_acoustic_unknown_ids: [
      ...new Set(
        pendingSandboxCandidates.map((row) => row.acoustic_unknown_id).filter(Boolean),
      ),
    ],
    observation_acoustic_unknown_ids: observationAcousticUnknownIds,
    evaluated_observation_keys: [...new Set(evaluatedObservationKeys)],
    ready_for_promotion_observation_keys: [
      ...new Set(
        readyForPromotionObservationKeys.filter(
          (key) => !blockedSet.has(observationAcousticUnknownIds[key]),
        ),
      ),
    ],
    pending_sandbox_candidates: pendingSandboxCandidates,
    owner_denied_sandbox_candidates: ownerDeniedSandboxCandidates,
    conflicts,
    source_revisions: [...sourceRevisions].sort(),
    source_revision_by_otid: sourceRevisionByOtid,
    source_reports_seen: (nameJudgmentReports || []).length,
    rule:
      'Confirmed voiceprints remain sticky unless trained calibrated acoustics contradict them. An unresolved acoustic candidate also requires current complete marked-speaker review and is blocked when that evidence strongly names a different person.',
  };
}

module.exports = {
  DEFAULT_CONTRADICTION_MARGIN,
  acousticAssignmentFingerprint,
  buildAcousticAssignmentAudit,
  buildVoiceNameConflictAudit,
  exactOwnerDeniesCandidate,
};
