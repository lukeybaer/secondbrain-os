'use strict';

const { isTerminallyExcludedFromStuckScan } = require('./video-delete-state.js');

// The briefing's "Re-ingest for regen" rows answer one question: does this
// rejection still need work? Until 2026-08-16 the code asked a different one,
// "is this video currently queued for regen?", and every video that had moved
// PAST regen answered no and was re-surfaced forever. A video ExampleCo approved and
// that is live on YouTube kept appearing in the queue carrying a defect note he
// had already addressed.

// Records in content-review/rejections.jsonl carry `ts`. Older code read
// `rejectedAt`, which is absent from all 21 live records, so every comparison
// was NaN and every age was meaningless. Read both, prefer whichever parses.
function rejectionTimestamp(rejection) {
  for (const key of ['ts', 'rejectedAt']) {
    const parsed = Date.parse(String(rejection?.[key] || ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

// Manifest fields that mean this video has moved past the rejection.
const TERMINAL_STATUSES = new Set(['posted', 'regen_queued']);
const RESOLUTION_FIELDS = [
  'video_feedback_resolved_at',
  'thumbnail_feedback_resolved_at',
  'regen_completed_at',
  'approved_at',
  'posted_at',
];

function latestResolutionMs(video) {
  let latest = null;
  for (const field of RESOLUTION_FIELDS) {
    const parsed = Date.parse(String(video?.[field] || ''));
    if (Number.isFinite(parsed) && (latest === null || parsed > latest)) latest = parsed;
  }
  return latest;
}

/**
 * Keep only the newest rejection per video id.
 * Records with no parseable timestamp still win over nothing, so a malformed
 * record surfaces rather than silently disappearing.
 */
function latestRejectionByVideo(rows = []) {
  const latest = new Map();
  for (const row of rows) {
    if (!row || !row.id) continue;
    const prev = latest.get(row.id);
    if (!prev) {
      latest.set(row.id, row);
      continue;
    }
    const rowMs = rejectionTimestamp(row);
    const prevMs = rejectionTimestamp(prev);
    if (rowMs === null) continue;
    if (prevMs === null || rowMs > prevMs) latest.set(row.id, row);
  }
  return latest;
}

/**
 * True when this rejection still needs a re-ingest.
 *
 * A rejection is done when the video reached a terminal state, or when the
 * video recorded a resolution at or after the rejection was raised. A later
 * rejection against an earlier resolution is live work again, which is why the
 * comparison is against the rejection's own timestamp rather than a flag.
 */
function rejectionStillNeedsReIngest(rejection, video) {
  if (!video) return true;
  if (isTerminallyExcludedFromStuckScan(video)) return false;
  if (TERMINAL_STATUSES.has(String(video.status || ''))) return false;
  if (video.video_needs_regen === true || video.thumbnail_needs_regen === true) return false;

  const rejectedMs = rejectionTimestamp(rejection);
  const resolvedMs = latestResolutionMs(video);
  if (rejectedMs === null || resolvedMs === null) return true;
  return rejectedMs > resolvedMs;
}

module.exports = {
  latestRejectionByVideo,
  rejectionStillNeedsReIngest,
  rejectionTimestamp,
};
