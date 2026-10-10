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

// ExampleCo, 2026-09-25, on unknown_voice_ecapa_3df1ffc422644ce5 at 12 calls: "You
// definitely should know this person's name by the name guessing." A strong
// whole-call name judgment (PRIVATE_NAME, five direct name mentions) was stored on
// 2026-09-23, then a recluster grew the group and every list showed "no name
// hypothesis yet". This turns a stored strong judgment into a review hint. It
// is evidence for ExampleCo to confirm, never a saved identity.
const PRIOR_JUDGMENT_CONFIDENCES = new Set(['strong', 'high']);

function priorNameJudgmentHint(judgment, currentCalls = 0) {
  if (!judgment || !judgment.best_name) return '';
  if (!PRIOR_JUDGMENT_CONFIDENCES.has(String(judgment.confidence || '').toLowerCase())) return '';
  if (Number(judgment.counterevidence_count || 0) > 0) return '';
  const name = String(judgment.best_name)
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const heard = Number(judgment.direct_name_evidence_count || judgment.clear_evidence_count || 0);
  const judgedCalls = Number(judgment.judge_summary?.actual_call_count || judgment.judged_call_count || 0);
  const heardText = heard ? `name heard directly ${heard} time${heard === 1 ? '' : 's'}` : 'name heard directly';
  const growth =
    judgedCalls && currentCalls > judgedCalls
      ? `; judged on ${judgedCalls} calls, the group now has ${currentCalls}, so confirm`
      : '; confirm before saving';
  return `likely ${name} (${heardText}${growth})`;
}

// A stored name-judge report keeps each target's verdict in judged.targets[]
// and its call coverage in target_summaries[]; join them for one target.
function judgmentRowForTarget(report, target) {
  const id = String(target || '');
  const row = (report?.judged?.targets || []).find((entry) => String(entry?.target || '') === id);
  if (!row) return null;
  const summary = (report?.target_summaries || []).find((entry) => String(entry?.target || '') === id);
  return { ...row, judge_summary: row.judge_summary || summary || {} };
}

// Recurrence floor (ExampleCo approved 2026-10-05, Amy Top 15 smaller win): 97.5% of
// unknown voice groups appear in exactly one call. A nameless unknown voice is
// surfaced for review, and counted into the surfaced backlog, only once the
// MERGED group (after recluster fragments are joined) spans this many distinct
// calls. A group carrying a name hypothesis stays visible (2026-07-29 lesson:
// a one-call admissible name must not be crowded out). The naming judge never
// calls this; it keeps judging every group.
const UNKNOWN_VOICE_MIN_CALLS = 3;
const BELOW_FLOOR_REASON = 'below_recurrence_floor';

function belowUnknownVoiceFloor(calls, { hasNameHypothesis = false } = {}) {
  if (hasNameHypothesis) return false;
  return Number(calls || 0) < UNKNOWN_VOICE_MIN_CALLS;
}

module.exports = {
  UNKNOWN_VOICE_MIN_CALLS,
  BELOW_FLOOR_REASON,
  belowUnknownVoiceFloor,
  judgmentRowForTarget,
  priorNameJudgmentHint,
  buildReclusterMemberIndex,
  reclusterInfoForIds,
  likelyPersonForCluster,
  resolutionClearsLikelyPersonGate,
  distinctOtidCount,
};
