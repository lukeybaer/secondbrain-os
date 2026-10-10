'use strict';

// ExampleCo paused video work on the morning of 2026-09-22, then explicitly
// resumed it that evening (option 1: "resume video work" so spine-owned video
// tasks can close their card green). Flip back to true only on a new owner pause.
const VIDEO_WORK_OWNER_PAUSED = false;
const VIDEO_WORK_PAUSE_REASON = 'Owner paused all video repair effort until explicit resume.';

const VIDEO_WORK_IDS = new Set([
  'video_approval_queue',
  'video-quality-research',
  'video-quality-tools',
  'system_health:stuck-videos',
]);

function normalizeVideoWorkId(value) {
  return String(value || '').trim().toLowerCase();
}

function isOwnerPausedVideoWork(value, { ownerPaused = VIDEO_WORK_OWNER_PAUSED } = {}) {
  return Boolean(ownerPaused) && VIDEO_WORK_IDS.has(normalizeVideoWorkId(value));
}

module.exports = {
  VIDEO_WORK_IDS,
  VIDEO_WORK_OWNER_PAUSED,
  VIDEO_WORK_PAUSE_REASON,
  isOwnerPausedVideoWork,
};
