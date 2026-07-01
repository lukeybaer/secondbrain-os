// video-delete-state.js
// Single source of truth for the DELETE (reject-and-do-NOT-regenerate) state
// on a content-review manifest video, and for the predicate the auto-regen
// loop uses to decide whether a video is a regeneration candidate.
//
// Background (video-delete-17, 2026-07-01): ExampleCo could reject a video (which
// re-queues it for regeneration) or "trash" it, but there was no explicit
// DELETE action that marks a video terminally rejected AND suppresses
// regeneration. The auto-regen loop keys off v.video_needs_regen /
// v.thumbnail_needs_regen, so any video with a needs_regen flag set keeps
// cycling back into the queue. A delete has to (a) clear those flags and
// (b) set an explicit suppression flag so no other flow can re-queue it.
//
// Terminal state contract for a deleted video:
//   status              = 'deleted'
//   video_needs_regen   = false
//   thumbnail_needs_regen = false
//   regen_suppressed    = true
//   deleted_at          = ISO timestamp
//
// This is intentionally distinct from 'trashed' (asset-level throwaway) and
// from 'rejected'/'video_rejected'/'thumbnail_rejected' (which mean "in the
// regen queue, the note is the regen instruction").

const DELETED_STATUS = 'deleted';

/** True if this manifest video has been terminally deleted (no regen). */
function isVideoDeleted(v) {
  if (!v) return false;
  return v.status === DELETED_STATUS || v.regen_suppressed === true;
}

/**
 * Whether the auto-regen loop should treat this video as a regeneration
 * candidate. A deleted / regen-suppressed video is NEVER a candidate, even if
 * some other flow flipped a needs_regen flag back on. Otherwise a video is a
 * candidate when either asset is flagged for regen.
 */
function isRegenCandidate(v) {
  if (!v) return false;
  if (isVideoDeleted(v)) return false;
  return v.video_needs_regen === true || v.thumbnail_needs_regen === true;
}

/**
 * Apply the DELETE action to a manifest video in place: mark it terminally
 * rejected and suppress regeneration. Mutates `v`. Returns true if anything
 * changed (idempotent: a second call on an already-deleted video returns
 * false and leaves the original deleted_at intact).
 */
function applyVideoDelete(v, nowIso) {
  if (!v) return false;
  if (isVideoDeleted(v) && v.status === DELETED_STATUS) return false;
  v.status = DELETED_STATUS;
  v.video_needs_regen = false;
  v.thumbnail_needs_regen = false;
  v.regen_suppressed = true;
  v.deleted_at = nowIso || new Date().toISOString();
  return true;
}

module.exports = {
  DELETED_STATUS,
  isVideoDeleted,
  isRegenCandidate,
  applyVideoDelete,
};
