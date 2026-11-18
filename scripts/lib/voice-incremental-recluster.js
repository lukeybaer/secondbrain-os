'use strict';

const {
  DEFAULTS,
  cosine,
  meanVector,
  mintUniqueClusterId,
} = require('../voice-global-recluster.js');

function observationKey(value) {
  if (typeof value === 'string') return value.split('|').slice(0, 2).join('|');
  return `${String(value?.otid || '')}|${String(value?.label || value?.speaker_model_label || '')}`;
}

function materializeMember(item) {
  return {
    track_key: item.key,
    otid: item.otid,
    speaker_model_label: item.label,
    voice_cluster_id: item.voiceClusterId,
    source_voice_cluster_ids: item.sourceVoiceClusterIds || [item.voiceClusterId].filter(Boolean),
    probe_audio_path: item.probeAudioPath,
    source_probe_audio_paths: item.sourceProbeAudioPaths || [item.probeAudioPath].filter(Boolean),
    source_revision: item.sourceRevision || '',
    source_revisions: item.sourceRevisions || [item.sourceRevision].filter(Boolean),
  };
}

function clusterCentroid(cluster, itemByKey) {
  if (Array.isArray(cluster?.centroid) && cluster.centroid.length) return cluster.centroid;
  const vectors = (cluster?.member_track_keys || [])
    .map((key) => itemByKey.get(key)?.vector)
    .filter((vector) => Array.isArray(vector) && vector.length);
  return vectors.length ? meanVector(vectors) : [];
}

function appendToCentroid(centroid, priorSize, vector) {
  const size = Math.max(1, Number(priorSize || 0));
  const combined = centroid.map((value, index) => value * size + Number(vector[index] || 0));
  const norm = Math.sqrt(combined.reduce((sum, value) => sum + value * value, 0));
  return norm ? combined.map((value) => value / norm) : vector.slice();
}

function assignIncrementalClusters({
  items,
  previous,
  targetOtids,
  thresholds = {},
  forceDetachObservations = [],
} = {}) {
  const targets = new Set((targetOtids || []).map(String));
  const itemByKey = new Map((items || []).map((item) => [item.key, item]));
  const itemByObservation = new Map((items || []).map((item) => [observationKey(item), item]));
  const forced = new Set((forceDetachObservations || []).map(observationKey));
  let clusters = (previous?.clusters || []).map((cluster) => ({
    ...cluster,
    member_track_keys: [...(cluster.member_track_keys || [])],
    members: [...(cluster.members || [])],
    otids: [...(cluster.otids || [])],
    centroid: [...(cluster.centroid || [])],
  }));
  if (forced.size) {
    clusters = clusters
      .map((cluster) => {
        const members = (cluster.members || []).filter(
          (member) => !forced.has(observationKey(member)),
        );
        if (members.length === (cluster.members || []).length) return cluster;
        return {
          ...cluster,
          members,
          member_track_keys: members.map((member) => member.track_key).filter(Boolean),
          otids: [...new Set(members.map((member) => member.otid).filter(Boolean))].sort(),
          size: members.length,
          centroid: [],
        };
      })
      .filter((cluster) => (cluster.members || []).length > 0);
  }
  const clusterByObservation = new Map();
  for (const cluster of clusters) {
    for (const member of cluster.members || []) {
      clusterByObservation.set(observationKey(member), cluster);
    }
  }
  const threshold = Number(
    thresholds.threshold ?? previous?.thresholds?.threshold ?? DEFAULTS.threshold,
  );
  const pairFloor = Number(
    thresholds.pairFloor ?? previous?.thresholds?.pair_floor ?? DEFAULTS.pairFloor,
  );
  const sameCallGate = Number(
    thresholds.sameCallGate ??
      previous?.thresholds?.same_call_gate ??
      DEFAULTS.sameCallGate,
  );
  const assignments = [];

  for (const item of (items || []).filter((row) => targets.has(String(row.otid || '')))) {
    const existing = clusterByObservation.get(observationKey(item));
    if (existing) {
      const existingMember = (existing.members || []).find(
        (member) => observationKey(member) === observationKey(item),
      );
      if (existingMember) {
        existingMember.source_revision =
          item.sourceRevision || existingMember.source_revision || '';
        existingMember.source_revisions = [
          ...new Set(
            [
              ...(existingMember.source_revisions || []),
              ...(item.sourceRevisions || []),
              item.sourceRevision,
            ].filter(Boolean),
          ),
        ].sort();
      }
      assignments.push({
        otid: item.otid,
        speaker_model_label: item.label,
        source_revision: item.sourceRevision || '',
        cluster_id: existing.cluster_id,
        source_voice_cluster_id: item.voiceClusterId || '',
        confirmed_person_id:
          existing.confirmed_person_id ||
          String(existing.cluster_id || '').match(/^person:(.+)$/)?.[1] ||
          null,
        confirmed_display_name: existing.confirmed_display_name || null,
        reference_voiceprint_match: existing.reference_voiceprint_match || null,
        action: 'existing_membership',
        score: 1,
      });
      continue;
    }

    let best = null;
    for (const cluster of clusters) {
      if (cluster.frozen || cluster.confirmed_person_id) continue;
      const centroid = clusterCentroid(cluster, itemByKey);
      if (!centroid.length) continue;
      const memberItems = (cluster.members || [])
        .map(
          (member) =>
            itemByKey.get(member.track_key) ||
            itemByObservation.get(observationKey(member)),
        )
        .filter((member) => Array.isArray(member?.vector) && member.vector.length);
      if (
        !memberItems.length ||
        memberItems.length !== Number(cluster.members?.length || 0)
      ) {
        continue;
      }
      const score = cosine(item.vector, centroid);
      const pairScores = memberItems.map((member) => cosine(item.vector, member.vector));
      const minPairScore = Math.min(...pairScores);
      const sameCallDifferentLabel = (cluster.members || []).some(
        (member) =>
          String(member.otid || '') === String(item.otid || '') &&
          String(member.speaker_model_label || '') !== String(item.label || ''),
      );
      const passes =
        score >= threshold &&
        minPairScore >= pairFloor &&
        (!sameCallDifferentLabel ||
          (score >= sameCallGate && minPairScore >= sameCallGate));
      if (passes && (!best || score > best.score)) {
        best = { cluster, centroid, score, minPairScore };
      }
    }

    let cluster = best?.cluster;
    let action = 'joined_existing_cluster';
    if (!cluster) {
      // Never reuse an id another cluster carries: a cluster keeps its
      // inherited id after the member whose key minted it is detached, so the
      // plain key hash can collide with it.
      const clusterId = mintUniqueClusterId(
        [item],
        new Set(clusters.map((existingCluster) => existingCluster.cluster_id)),
      );
      cluster = {
        cluster_id: clusterId,
        size: 0,
        frozen: false,
        confirmed_person_id: null,
        confirmed_display_name: null,
        reference_voiceprint_match: null,
        inherited_id: false,
        member_track_keys: [],
        members: [],
        otids: [],
        centroid: item.vector.slice(),
      };
      clusters.push(cluster);
      action = 'minted_durable_unknown';
    }

    const priorSize = Number(cluster.size || cluster.members.length || 0);
    const priorCentroid = clusterCentroid(cluster, itemByKey);
    cluster.member_track_keys.push(item.key);
    cluster.members.push(materializeMember(item));
    cluster.otids = [...new Set([...(cluster.otids || []), item.otid])].sort();
    cluster.size = cluster.members.length;
    cluster.centroid =
      priorSize && priorCentroid.length
        ? appendToCentroid(priorCentroid, priorSize, item.vector)
        : item.vector.slice();
    clusterByObservation.set(observationKey(item), cluster);
    assignments.push({
      otid: item.otid,
      speaker_model_label: item.label,
      source_revision: item.sourceRevision || '',
      cluster_id: cluster.cluster_id,
      source_voice_cluster_id: item.voiceClusterId || '',
      confirmed_person_id: cluster.confirmed_person_id || null,
      confirmed_display_name: cluster.confirmed_display_name || null,
      reference_voiceprint_match: cluster.reference_voiceprint_match || null,
      action,
      score: best ? Number(best.score.toFixed(6)) : 1,
      min_pair_score: best ? Number(best.minPairScore.toFixed(6)) : 1,
    });
  }

  clusters.sort(
    (left, right) =>
      Number(right.size || 0) - Number(left.size || 0) ||
      String(left.cluster_id).localeCompare(String(right.cluster_id)),
  );
  return { clusters, assignments };
}

module.exports = {
  observationKey,
  materializeMember,
  clusterCentroid,
  appendToCentroid,
  assignIncrementalClusters,
};
