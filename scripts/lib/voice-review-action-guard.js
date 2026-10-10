'use strict';

// The browser is not an authorization boundary. This guard is shared by the
// briefing endpoint so a crafted POST cannot bank an identity for a row that
// is visible only to expose an audio or recluster defect.
const IDENTITY_ACTIONS = new Set([
  'confirm',
  'correct',
  'link_person_file',
  'create_people_file',
  'keep_voiceprint',
]);

// Every lane the queue artifact publishes. The review surfaces render rows
// from ALL of these (scripts/lib/voiceprint-text-conflicts.js QUEUE_LANES),
// so save-time membership must be judged on the durable acoustic id across
// every published lane, never on which lane a row was found in. Lane omission
// is not a reviewability signal; reviewability is enforced by the explicit
// unreviewable_voice_ids map and each row's own reviewable flag below.
const QUEUE_MEMBERSHIP_LANES = Object.freeze([
  'confirmation_queue',
  'reviewable_voice_queue',
  'unresolved_voice_queue',
  'unknown_voice_queue',
  'pending_name_judge_queue',
  'recluster_repair_queue',
]);

function rowsFromQueue(queue) {
  if (Array.isArray(queue?.reviewable_voice_queue)) {
    return QUEUE_MEMBERSHIP_LANES.flatMap((lane) =>
      Array.isArray(queue?.[lane]) ? queue[lane] : [],
    );
  }
  if (Array.isArray(queue?.unresolved_voice_queue)) return queue.unresolved_voice_queue;
  if (Array.isArray(queue?.unknown_voice_queue)) return queue.unknown_voice_queue;
  return [];
}

function rowMatchesId(row, voiceClusterId) {
  const wanted = String(voiceClusterId || '');
  return [
    row?.acoustic_unknown_id,
    row?.voice_cluster_id,
    ...(Array.isArray(row?.voice_cluster_ids) ? row.voice_cluster_ids : []),
  ]
    .filter(Boolean)
    .map(String)
    .includes(wanted);
}

// A nameless voice heard on fewer than three calls is held back from review
// (recurrence floor); it returns to the queue when it recurs.
function belowFloorBlock() {
  return {
    allowed: false,
    code: 'below_recurrence_floor',
    error: 'identity save is unavailable until this voice appears on at least three calls',
  };
}

function guardVoiceReviewAction({ queue, voiceClusterId, action }) {
  if (!IDENTITY_ACTIONS.has(String(action || ''))) return { allowed: true };
  const explicitBlocks = queue?.unreviewable_voice_ids || {};
  const explicitReason = explicitBlocks[String(voiceClusterId || '')];
  if (explicitReason) {
    const reason = String(explicitReason);
    if (reason === 'below_recurrence_floor') return belowFloorBlock();
    return {
      allowed: false,
      code:
        reason === 'recluster_repair' ? 'recluster_repair_required' : 'review_audio_unavailable',
      error:
        reason === 'recluster_repair'
          ? 'identity save is unavailable until current recluster membership is rebuilt'
          : 'identity save is unavailable until a playable review clip is mirrored',
    };
  }
  const row = rowsFromQueue(queue).find((candidate) => rowMatchesId(candidate, voiceClusterId));
  // Pre-contract artifacts did not carry reviewability. They also contained
  // only playable rows, so retain compatibility while new artifacts enforce
  // the explicit server-side value below.
  if (!row && Array.isArray(queue?.reviewable_voice_queue)) {
    return {
      allowed: false,
      code: 'voice_not_reviewable',
      error:
        'identity save is unavailable because this voice is no longer in the current review queue; refresh this page to load the current queue',
    };
  }
  if (!row || row.reviewable === undefined) return { allowed: true };
  if (row.reviewable === false) {
    const reason = String(row.review_block_reason || row.review_queue_lane || 'review_unavailable');
    if (reason === 'below_recurrence_floor') return belowFloorBlock();
    return {
      allowed: false,
      code:
        reason === 'recluster_repair' ? 'recluster_repair_required' : 'review_audio_unavailable',
      error:
        reason === 'recluster_repair'
          ? 'identity save is unavailable until current recluster membership is rebuilt'
          : 'identity save is unavailable until a playable review clip is mirrored',
    };
  }
  return { allowed: true };
}

module.exports = { IDENTITY_ACTIONS, rowsFromQueue, rowMatchesId, guardVoiceReviewAction };
