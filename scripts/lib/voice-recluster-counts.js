/**
 * voice-recluster-counts.js -- join the fragmented per-generation speaker
 * artifacts (Pareto / speaker-intelligence) to the nightly GLOBAL recluster so
 * the review UI shows ARCHIVE-WIDE call counts, not per-batch lower bounds.
 *
 * The recluster (data/life-archive/voiceprints/recluster-latest.json) is the
 * stable-id truth: it merges what the Pareto grouping split. A Pareto row lists
 * member speaker ids (speaker_NNN); those members belong to a recluster cluster
 * whose distinct-otid count is the real number of calls the voice appears on.
 * This module maps member id -> recluster cluster info (calls + likely person
 * from confirmed member matches) so callers can override the displayed count
 * and add an honest "likely you / likely PRIVATE_NAME" hint on the big clusters.
 */

function distinctOtidCount(cluster) {
  return new Set((cluster && cluster.otids ? cluster.otids : []).filter(Boolean)).size;
}

const STRICT_LIKELY_PERSON_STATUSES = new Set([
  'confirmed_by_ExampleCo',
  'confirmed_by_ExampleCo_cluster',
  'confirmed_reference_voiceprint_match',
  'confirmed_reference_voiceprint_acoustic_group',
]);

function resolutionClearsLikelyPersonGate(resolution) {
  if (!resolution || !resolution.person_id) return false;
  const status = String(resolution.status || '').toLowerCase();
  if (!STRICT_LIKELY_PERSON_STATUSES.has(status)) return false;
  const blob = JSON.stringify(resolution).toLowerCase();
  return !/inferred|needs_ExampleCo|low_margin|person_guess|provisional|not strong enough|not enough/.test(blob);
}

// person_id -> clips among this cluster's members that already resolved to that
// person (confirmed_by_ExampleCo or an auto voiceprint match). The top one is the
// "likely person" hint; it is evidence, never an assertion.
function likelyPersonForCluster(cluster, resolutions) {
  const counts = new Map();
  for (const member of (cluster && cluster.members) || []) {
    const res = resolutions[String(member && member.voice_cluster_id)];
    const pid = resolutionClearsLikelyPersonGate(res) ? String(res.person_id) : '';
    if (!pid) continue;
    counts.set(pid, (counts.get(pid) || 0) + 1);
  }
  let person = null;
  let clips = 0;
  for (const [pid, n] of counts) {
    if (n > clips) {
      person = pid;
      clips = n;
    }
  }
  return { person, clips };
}

/**
 * Build a Map from member id (and each cluster's own id) to
 * {clusterId, calls, frozen, confirmedPerson, likelyPerson, likelyPersonClips}.
 * First writer wins per member so a member is attributed to one cluster.
 */
function buildReclusterMemberIndex(recluster, registry) {
  const byMember = new Map();
  const resolutions = (registry && registry.voice_cluster_resolutions) || {};
  for (const cluster of (recluster && recluster.clusters) || []) {
    const { person, clips } = likelyPersonForCluster(cluster, resolutions);
    const info = {
      clusterId: cluster.cluster_id || '',
      calls: distinctOtidCount(cluster),
      frozen: Boolean(cluster.frozen || cluster.confirmed_person_id),
      confirmedPerson: cluster.confirmed_person_id || null,
      likelyPerson: person,
      likelyPersonClips: clips,
    };
    if (info.clusterId && !byMember.has(info.clusterId)) byMember.set(info.clusterId, info);
    for (const member of cluster.members || []) {
      const mid = String((member && member.voice_cluster_id) || '');
      if (mid && !byMember.has(mid)) byMember.set(mid, info);
    }
  }
  return byMember;
}

/**
 * Best recluster cluster for a set of ids (the row's own label + its member
 * voice_cluster_ids), chosen by maximum member overlap. Returns null when no
 * id is known to the recluster (caller keeps the per-generation count).
 */
function reclusterInfoForIds(byMember, ids) {
  const overlaps = new Map();
  for (const id of ids || []) {
    const info = byMember.get(String(id || ''));
    if (!info) continue;
    const entry = overlaps.get(info.clusterId) || { info, overlap: 0 };
    entry.overlap += 1;
    overlaps.set(info.clusterId, entry);
  }
  let best = null;
  for (const entry of overlaps.values()) {
    if (!best || entry.overlap > best.overlap) best = entry;
  }
  return best ? best.info : null;
}

module.exports = {
  buildReclusterMemberIndex,
  reclusterInfoForIds,
  likelyPersonForCluster,
  resolutionClearsLikelyPersonGate,
  distinctOtidCount,
};
