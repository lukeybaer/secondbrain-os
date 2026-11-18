const crypto = require('crypto');

const INPUT_SCHEMA = 'whole_call_marked_target_membership.v1';
const EXACT_INPUT_SCHEMA = 'exact_call_marked_target_membership.v1';

function normalizedMembers(cluster = {}) {
  return (cluster.members || [])
    .map((member) => ({
      otid: String(member?.otid || '').trim(),
      speaker_model_label: String(member?.speaker_model_label || '').trim(),
      voice_cluster_id: String(member?.voice_cluster_id || '').trim(),
      source_voice_cluster_ids: [...new Set(member?.source_voice_cluster_ids || [])]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .sort(),
    }))
    .filter((member) => member.otid && member.speaker_model_label)
    .sort(
      (a, b) =>
        a.otid.localeCompare(b.otid) ||
        a.speaker_model_label.localeCompare(b.speaker_model_label) ||
        a.voice_cluster_id.localeCompare(b.voice_cluster_id),
    );
}

function fingerprintCluster(cluster = {}) {
  const clusterId = String(cluster?.cluster_id || '').trim();
  const members = normalizedMembers(cluster);
  if (!clusterId || !members.length) return '';
  const payload = JSON.stringify({
    schema: INPUT_SCHEMA,
    cluster_id: clusterId,
    members,
  });
  return `${INPUT_SCHEMA}:${crypto.createHash('sha256').update(payload).digest('hex').slice(0, 24)}`;
}

function clusterForTarget(recluster = {}, target = '') {
  return (recluster.clusters || []).find(
    (cluster) => String(cluster?.cluster_id || '') === String(target || ''),
  );
}

function fingerprintTarget(recluster = {}, target = '') {
  return fingerprintCluster(clusterForTarget(recluster, target));
}

function fingerprintExactCallTarget({
  target = '',
  sourceRevisionByOtid = {},
  trackKeys = [],
} = {}) {
  const normalizedTarget = String(target || '').trim();
  const tracks = [...new Set(trackKeys || [])]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .sort();
  const trackOtids = new Set(tracks.map((value) => value.split('|')[0]).filter(Boolean));
  const calls = [...trackOtids]
    .map((otid) => ({
      otid,
      source_revision: String(sourceRevisionByOtid?.[otid] || '').trim().toLowerCase(),
      speaker_model_labels: tracks
        .filter((value) => value.startsWith(`${otid}|`))
        .map((value) => value.slice(otid.length + 1))
        .filter(Boolean)
        .sort(),
    }))
    .filter((row) => row.source_revision && row.speaker_model_labels.length)
    .sort((a, b) => a.otid.localeCompare(b.otid));
  if (!normalizedTarget || !calls.length || calls.length !== trackOtids.size) return '';
  const payload = JSON.stringify({
    schema: EXACT_INPUT_SCHEMA,
    target: normalizedTarget,
    calls,
  });
  return `${EXACT_INPUT_SCHEMA}:${crypto.createHash('sha256').update(payload).digest('hex').slice(0, 24)}`;
}

module.exports = {
  INPUT_SCHEMA,
  EXACT_INPUT_SCHEMA,
  normalizedMembers,
  fingerprintCluster,
  clusterForTarget,
  fingerprintTarget,
  fingerprintExactCallTarget,
};
