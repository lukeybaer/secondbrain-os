#!/usr/bin/env node
/**
 * Back-propagate durable voice-cluster resolutions into speaker artifacts.
 *
 * ExampleCo's confirmation is stored in voice-identity-registry.json. This script
 * applies that truth to the speaker-cluster registry, discovery roster, and
 * raw Otter JSON assignment blocks so a confirmed speaker_########## resolves
 * everywhere that exact durable cluster already appears.
 */

const fs = require('fs');
const path = require('path');
const { runSpeakerIdentityChangeHook } = require('./lib/run-speaker-identity-change-hook');

const REPO = path.resolve(__dirname, '..');
const IDENTITY_REGISTRY = path.join(REPO, 'data', 'life-archive', 'voice-identity-registry.json');
const CLUSTER_REGISTRY = path.join(REPO, 'data', 'life-archive', 'voiceprints', 'speaker-cluster-registry.json');
const ROSTER_PATH = path.join(REPO, 'data', 'life-archive', 'voiceprints', 'voice-discovery-roster-latest.json');
const RAW_DIR = path.join(REPO, 'data', 'otter', 'raw');
const ENRICHED_DIR = path.join(REPO, 'data', 'otter', 'enriched');
const STATUS_PATH = path.join(REPO, 'data', 'life-archive', 'voiceprints', 'voice-cluster-resolution-apply-latest.json');

function hasArg(name) {
  return process.argv.includes(name);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function rawFiles() {
  if (!fs.existsSync(RAW_DIR)) return [];
  return fs.readdirSync(RAW_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(RAW_DIR, name));
}

function enrichedFiles() {
  if (!fs.existsSync(ENRICHED_DIR)) return [];
  return fs.readdirSync(ENRICHED_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(ENRICHED_DIR, name));
}

function pushEvidence(target, evidence) {
  target.evidence = Array.isArray(target.evidence) ? target.evidence : [];
  if (!target.evidence.includes(evidence)) target.evidence.push(evidence);
}

function isConfirmedResolution(resolution) {
  return /^(confirmed_by_ExampleCo|confirmed_reference_voiceprint_match)$/.test(String(resolution?.status || ''));
}

function quarantinedEnrollmentIds(identity) {
  return new Set((identity.enrollments || [])
    .filter((enrollment) => String(enrollment?.calibration_quarantine_status || '') === 'quarantined')
    .map((enrollment) => enrollment.enrollment_id)
    .filter(Boolean));
}

function isQuarantinedResolution(resolution, quarantinedIds) {
  return Boolean(resolution?.enrollment_id && quarantinedIds.has(resolution.enrollment_id));
}

function isNonSpeechResolution(resolution) {
  return String(resolution?.status || '') === 'non_speech_by_ExampleCo';
}

function confirmedTier(resolution, source) {
  if (resolution?.status === 'confirmed_reference_voiceprint_match') {
    return source === 'acoustic_group'
      ? 'confirmed_reference_voiceprint_acoustic_group'
      : 'confirmed_reference_voiceprint_match';
  }
  return source === 'acoustic_group'
    ? 'confirmed_by_ExampleCo_acoustic_group'
    : 'confirmed_by_ExampleCo_cluster';
}

function applyConfirmedToAssignment(assignment, voiceClusterId, resolution) {
  if (!assignment || assignment.voice_cluster_id !== voiceClusterId) return false;
  const tier = confirmedTier(resolution, 'voice_cluster');
  assignment.identity_status = tier;
  assignment.confidence_tier = tier;
  assignment.person_id = resolution.person_id;
  assignment.display_name = resolution.display_name;
  assignment.confirmed_person_id = resolution.person_id;
  assignment.confirmed_display_name = resolution.display_name;
  assignment.confirmed_enrollment_id = resolution.enrollment_id || null;
  assignment.confirmed_at = resolution.updated_at || null;
  assignment.voice_cluster_resolution_status = resolution.status;
  assignment.identity_source = 'voice_identity_registry.voice_cluster_resolutions';
  return true;
}

function applyConfirmedToResolvedSpeaker(target, resolution, source) {
  if (!target) return false;
  target.resolved_person = resolution.display_name;
  target.person_id = resolution.person_id;
  target.identity_tier = confirmedTier(resolution, source);
  target.confidence = 1;
  target.identity_status = target.identity_tier;
  target.confidence_tier = target.identity_tier;
  target.confirmed_person_id = resolution.person_id;
  target.confirmed_display_name = resolution.display_name;
  target.confirmed_at = resolution.updated_at || null;
  target.voice_cluster_resolution_status = resolution.status;
  target.identity_source = source === 'acoustic_group'
    ? 'voice_identity_registry.acoustic_group_resolutions'
    : 'voice_identity_registry.voice_cluster_resolutions';
  pushEvidence(target, target.identity_tier);
  return true;
}

function applyExampleCoToAssignment(assignment, voiceClusterId, resolution) {
  if (!assignment || assignment.voice_cluster_id !== voiceClusterId) return false;
  const nonSpeech = isNonSpeechResolution(resolution);
  assignment.identity_status = nonSpeech ? 'non_speech_by_ExampleCo' : 'left_ExampleCo_by_ExampleCo';
  assignment.confidence_tier = nonSpeech ? 'non_speech_audio_artifact' : 'ExampleCo_confirmed_by_ExampleCo';
  assignment.person_id = null;
  assignment.display_name = null;
  assignment.confirmed_person_id = null;
  assignment.confirmed_display_name = null;
  assignment.voice_cluster_resolution_status = resolution.status;
  assignment.identity_source = 'voice_identity_registry.voice_cluster_resolutions';
  return true;
}

function applyQuarantinedToAssignment(assignment, voiceClusterId, resolution) {
  if (!assignment || assignment.voice_cluster_id !== voiceClusterId) return false;
  assignment.identity_status = 'calibration_quarantined_voiceprint';
  assignment.confidence_tier = 'quarantined_voiceprint_reference';
  assignment.person_id = null;
  assignment.display_name = null;
  assignment.confirmed_person_id = null;
  assignment.confirmed_display_name = null;
  assignment.confirmed_enrollment_id = null;
  assignment.voice_cluster_resolution_status = 'calibration_quarantined';
  assignment.identity_source = 'voice_identity_registry.quarantined_enrollment';
  assignment.quarantined_enrollment_id = resolution.enrollment_id || null;
  return true;
}

function applyToRawJson(raw, voiceClusterId, resolution, quarantinedIds) {
  let changed = 0;
  const assignments = raw?.voiceprint_speaker_identity?.assignments || [];
  for (const assignment of assignments) {
    const didChange = isQuarantinedResolution(resolution, quarantinedIds)
      ? applyQuarantinedToAssignment(assignment, voiceClusterId, resolution)
      : isConfirmedResolution(resolution)
      ? applyConfirmedToAssignment(assignment, voiceClusterId, resolution)
      : applyExampleCoToAssignment(assignment, voiceClusterId, resolution);
    if (didChange) changed += 1;
  }
  if (Array.isArray(raw?.voiceprint_speakers)) {
    for (const assignment of raw.voiceprint_speakers) {
      const didChange = isQuarantinedResolution(resolution, quarantinedIds)
        ? applyQuarantinedToAssignment(assignment, voiceClusterId, resolution)
        : isConfirmedResolution(resolution)
        ? applyConfirmedToAssignment(assignment, voiceClusterId, resolution)
        : applyExampleCoToAssignment(assignment, voiceClusterId, resolution);
      if (didChange) changed += 1;
    }
  }
  return changed;
}

function applyToEnrichedJson(enriched, resolutions, acousticResolutions, quarantinedIds) {
  let changed = 0;
  const tracks = enriched?.speaker_identity_tracks || {};
  const applyResolution = (target, resolution, source) => {
    const before = JSON.stringify({
      resolved_person: target?.resolved_person,
      person_id: target?.person_id,
      identity_tier: target?.identity_tier,
      confidence_tier: target?.confidence_tier,
      identity_source: target?.identity_source,
    });
    applyConfirmedToResolvedSpeaker(target, resolution, source);
    const after = JSON.stringify({
      resolved_person: target?.resolved_person,
      person_id: target?.person_id,
      identity_tier: target?.identity_tier,
      confidence_tier: target?.confidence_tier,
      identity_source: target?.identity_source,
    });
    return before !== after;
  };
  const applyNonSpeech = (target, resolution, source) => {
    if (!target) return false;
    const before = JSON.stringify({
      resolved_person: target?.resolved_person,
      person_id: target?.person_id,
      identity_tier: target?.identity_tier,
      confidence_tier: target?.confidence_tier,
      identity_source: target?.identity_source,
    });
    target.resolved_person = null;
    target.person_id = null;
    target.identity_tier = 'non_speech_audio_artifact';
    target.confidence = 0;
    target.identity_status = 'non_speech_audio_artifact';
    target.confidence_tier = 'non_speech_audio_artifact';
    target.confirmed_person_id = null;
    target.confirmed_display_name = null;
    target.voice_cluster_resolution_status = resolution.status;
    target.identity_source = source === 'acoustic_group'
      ? 'voice_identity_registry.acoustic_group_resolutions'
      : 'voice_identity_registry.voice_cluster_resolutions';
    pushEvidence(target, 'non_speech_by_ExampleCo');
    const after = JSON.stringify({
      resolved_person: target?.resolved_person,
      person_id: target?.person_id,
      identity_tier: target?.identity_tier,
      confidence_tier: target?.confidence_tier,
      identity_source: target?.identity_source,
    });
    return before !== after;
  };
  const applyQuarantine = (target, resolution, source) => {
    if (!target) return false;
    const before = JSON.stringify({
      resolved_person: target?.resolved_person,
      person_id: target?.person_id,
      identity_tier: target?.identity_tier,
      confidence_tier: target?.confidence_tier,
      identity_source: target?.identity_source,
    });
    target.resolved_person = null;
    target.person_id = null;
    target.identity_tier = 'calibration_quarantined_voiceprint';
    target.confidence = 0;
    target.identity_status = 'calibration_quarantined_voiceprint';
    target.confidence_tier = 'quarantined_voiceprint_reference';
    target.confirmed_person_id = null;
    target.confirmed_display_name = null;
    target.confirmed_enrollment_id = null;
    target.voice_cluster_resolution_status = 'calibration_quarantined';
    target.identity_source = source === 'acoustic_group'
      ? 'voice_identity_registry.quarantined_acoustic_group_resolution'
      : 'voice_identity_registry.quarantined_voice_cluster_resolution';
    target.quarantined_enrollment_id = resolution.enrollment_id || null;
    pushEvidence(target, 'calibration_quarantined_voiceprint');
    const after = JSON.stringify({
      resolved_person: target?.resolved_person,
      person_id: target?.person_id,
      identity_tier: target?.identity_tier,
      confidence_tier: target?.confidence_tier,
      identity_source: target?.identity_source,
    });
    return before !== after;
  };

  for (const track of Object.values(tracks)) {
    if (!track) continue;
    const byCluster = resolutions[track.voice_cluster_id];
    const byAcoustic = acousticResolutions[track.acoustic_ExampleCo_id];
    if (isQuarantinedResolution(byCluster, quarantinedIds) && applyQuarantine(track, byCluster, 'voice_cluster')) changed += 1;
    else if (isQuarantinedResolution(byAcoustic, quarantinedIds) && applyQuarantine(track, byAcoustic, 'acoustic_group')) changed += 1;
    else if (isConfirmedResolution(byCluster) && applyResolution(track, byCluster, 'voice_cluster')) changed += 1;
    else if (isConfirmedResolution(byAcoustic) && applyResolution(track, byAcoustic, 'acoustic_group')) changed += 1;
    else if (isNonSpeechResolution(byCluster) && applyNonSpeech(track, byCluster, 'voice_cluster')) changed += 1;
    else if (isNonSpeechResolution(byAcoustic) && applyNonSpeech(track, byAcoustic, 'acoustic_group')) changed += 1;
  }

  for (const segment of enriched?.segments || []) {
    const speaker = segment.resolved_speaker;
    if (!speaker) continue;
    const byCluster = resolutions[speaker.voice_cluster_id];
    const byAcoustic = acousticResolutions[speaker.acoustic_ExampleCo_id];
    if (isQuarantinedResolution(byCluster, quarantinedIds) && applyQuarantine(speaker, byCluster, 'voice_cluster')) changed += 1;
    else if (isQuarantinedResolution(byAcoustic, quarantinedIds) && applyQuarantine(speaker, byAcoustic, 'acoustic_group')) changed += 1;
    else if (isConfirmedResolution(byCluster) && applyResolution(speaker, byCluster, 'voice_cluster')) changed += 1;
    else if (isConfirmedResolution(byAcoustic) && applyResolution(speaker, byAcoustic, 'acoustic_group')) changed += 1;
    else if (isNonSpeechResolution(byCluster) && applyNonSpeech(speaker, byCluster, 'voice_cluster')) changed += 1;
    else if (isNonSpeechResolution(byAcoustic) && applyNonSpeech(speaker, byAcoustic, 'acoustic_group')) changed += 1;
  }

  return changed;
}

function apply({ write = false } = {}) {
  const identity = readJson(IDENTITY_REGISTRY, {});
  const clusterRegistry = readJson(CLUSTER_REGISTRY, { clusters: {} });
  const roster = readJson(ROSTER_PATH, { roster: [] });
  const resolutions = identity.voice_cluster_resolutions || {};
  const acousticResolutions = identity.acoustic_group_resolutions || {};
  const quarantinedIds = quarantinedEnrollmentIds(identity);
  const report = {
    schema: 'life_archive_voice_cluster_resolution_apply.v1',
    generated_at: new Date().toISOString(),
    write,
    resolutions_seen: Object.keys(resolutions).length,
    confirmed_seen: 0,
    quarantined_confirmed_seen: 0,
    left_ExampleCo_seen: 0,
    cluster_registry_updated: 0,
    roster_rows_updated: 0,
    raw_files_updated: 0,
    raw_assignments_updated: 0,
    enriched_files_updated: 0,
    enriched_assignments_updated: 0,
    missing_clusters: [],
    results: [],
  };

  const rosterById = new Map((roster.roster || []).map((row) => [row.voice_cluster_id, row]));

  for (const [voiceClusterId, resolution] of Object.entries(resolutions)) {
    if (!/^speaker_\d+$/.test(voiceClusterId)) continue;
    const resolutionQuarantined = isQuarantinedResolution(resolution, quarantinedIds);
    if (isConfirmedResolution(resolution) && !resolutionQuarantined) report.confirmed_seen += 1;
    if (isConfirmedResolution(resolution) && resolutionQuarantined) report.quarantined_confirmed_seen += 1;
    if (resolution.status === 'left_ExampleCo_by_ExampleCo') report.left_ExampleCo_seen += 1;
    if (isNonSpeechResolution(resolution)) report.left_ExampleCo_seen += 1;

    const cluster = clusterRegistry.clusters?.[voiceClusterId];
    if (cluster) {
      if (resolutionQuarantined) {
        cluster.status = 'calibration_quarantined';
        cluster.confirmed_person_id = null;
        cluster.confirmed_display_name = null;
        cluster.confirmed_enrollment_id = null;
        cluster.quarantined_enrollment_id = resolution.enrollment_id || null;
      } else if (isConfirmedResolution(resolution)) {
        cluster.status = resolution.status;
        cluster.confirmed_person_id = resolution.person_id;
        cluster.confirmed_display_name = resolution.display_name;
        cluster.current_best_guess_person_id = resolution.person_id;
        cluster.current_best_guess_display_name = resolution.display_name;
        cluster.confirmed_enrollment_id = resolution.enrollment_id || null;
      } else if (resolution.status === 'left_ExampleCo_by_ExampleCo' || isNonSpeechResolution(resolution)) {
        cluster.status = resolution.status === 'left_ExampleCo_by_ExampleCo' ? 'left_ExampleCo_by_ExampleCo' : 'non_speech_by_ExampleCo';
        cluster.confirmed_person_id = null;
        cluster.confirmed_display_name = null;
      }
      cluster.resolution_updated_at = resolution.updated_at || new Date().toISOString();
      for (const example of cluster.examples || []) {
        if (resolutionQuarantined) {
          example.identity_status = 'calibration_quarantined_voiceprint';
          example.best_guess_person_id = null;
          example.best_guess_display_name = null;
          example.confirmed_person_id = null;
          example.confirmed_display_name = null;
          example.quarantined_enrollment_id = resolution.enrollment_id || null;
        } else if (isConfirmedResolution(resolution)) {
          example.identity_status = confirmedTier(resolution, 'voice_cluster');
          example.best_guess_person_id = resolution.person_id;
          example.best_guess_display_name = resolution.display_name;
          example.confirmed_person_id = resolution.person_id;
          example.confirmed_display_name = resolution.display_name;
        } else if (resolution.status === 'left_ExampleCo_by_ExampleCo' || isNonSpeechResolution(resolution)) {
          example.identity_status = resolution.status === 'left_ExampleCo_by_ExampleCo' ? 'left_ExampleCo_by_ExampleCo' : 'non_speech_audio_artifact';
          example.confirmed_person_id = null;
          example.confirmed_display_name = null;
        }
      }
      report.cluster_registry_updated += 1;
    } else {
      report.missing_clusters.push(voiceClusterId);
    }

    const rosterRow = rosterById.get(voiceClusterId);
    if (rosterRow) {
      if (resolutionQuarantined) {
        rosterRow.status = 'calibration_quarantined';
        rosterRow.review_status = 'calibration_quarantined';
        rosterRow.confirmed_person_id = null;
        rosterRow.confirmed_display_name = null;
        rosterRow.confirmed_enrollment_id = null;
        rosterRow.quarantined_enrollment_id = resolution.enrollment_id || null;
      } else if (isConfirmedResolution(resolution)) {
        rosterRow.status = resolution.status;
        rosterRow.review_status = resolution.status;
        rosterRow.confirmed_person_id = resolution.person_id;
        rosterRow.confirmed_display_name = resolution.display_name;
        rosterRow.confirmed_enrollment_id = resolution.enrollment_id || null;
      } else if (resolution.status === 'left_ExampleCo_by_ExampleCo' || isNonSpeechResolution(resolution)) {
        rosterRow.status = resolution.status === 'left_ExampleCo_by_ExampleCo' ? 'left_ExampleCo_by_ExampleCo' : 'non_speech_by_ExampleCo';
        rosterRow.review_status = rosterRow.status;
        rosterRow.confirmed_person_id = null;
        rosterRow.confirmed_display_name = null;
      }
      rosterRow.review_status_updated_at = resolution.updated_at || new Date().toISOString();
      report.roster_rows_updated += 1;
    }

    report.results.push({
      voice_cluster_id: voiceClusterId,
      status: resolutionQuarantined ? 'calibration_quarantined' : resolution.status,
      person_id: resolutionQuarantined ? null : (resolution.person_id || null),
      display_name: resolutionQuarantined ? null : (resolution.display_name || null),
      quarantined_enrollment_id: resolutionQuarantined ? resolution.enrollment_id || null : null,
    });
  }

  for (const file of rawFiles()) {
    const raw = readJson(file, null);
    if (!raw) continue;
    let fileAssignments = 0;
    for (const [voiceClusterId, resolution] of Object.entries(resolutions)) {
      fileAssignments += applyToRawJson(raw, voiceClusterId, resolution, quarantinedIds);
    }
    if (fileAssignments > 0) {
      report.raw_files_updated += 1;
      report.raw_assignments_updated += fileAssignments;
      if (write) saveJson(file, raw);
    }
  }

  for (const file of enrichedFiles()) {
    const enriched = readJson(file, null);
    if (!enriched) continue;
    const fileAssignments = applyToEnrichedJson(enriched, resolutions, acousticResolutions, quarantinedIds);
    if (fileAssignments > 0) {
      report.enriched_files_updated += 1;
      report.enriched_assignments_updated += fileAssignments;
      if (write) saveJson(file, enriched);
    }
  }

  if (write) {
    saveJson(CLUSTER_REGISTRY, clusterRegistry);
    saveJson(ROSTER_PATH, roster);
    saveJson(STATUS_PATH, report);
    report.speaker_identity_change_hook = runSpeakerIdentityChangeHook('apply-voice-cluster-resolutions');
    saveJson(STATUS_PATH, report);
  }
  return report;
}

const report = apply({ write: hasArg('--write') });
process.stdout.write(`${JSON.stringify(report, null, hasArg('--json') ? 2 : 0)}\n`);
