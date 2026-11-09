'use strict';

// Desktop upload queue (content-review/upload-queue.json): the `upload_status`
// of each approved video.
//
// State machine audit finding #25 (owner decision). `uploading` means the
// video was pushed to the EC2 queue and waits for a 9am/1pm/5pm slot. The
// pushers (pushVideoToEc2 in ipc-handlers, healStaleUploads, and
// push-stale-uploads-now) set it with a queued_at time and every pusher skips
// it, but nothing moved it on: the EC2 slot does not report back, so a row
// whose push was lost, or whose upload failed, sat in `uploading` and was
// skipped forever. Past the TTL such a row parks as `upload_unconfirmed`: shown
// in the UI and the briefing, skipped by every pusher. It is never re-uploaded
// automatically, because the video may already be public and a second upload
// is a public duplicate. A person checks YouTube, then marks it posted or
// queues it again.

const { defineStateMachine, updateJsonLocked } = require('./ledger-state-machine');

const SCHEDULED = 'scheduled';
const UPLOADING = 'uploading';
const UPLOAD_UNCONFIRMED = 'upload_unconfirmed';
const POSTED = 'posted';

// Two slots (a day) cover the longest wait, 5pm to the next 9am.
const UPLOADING_TTL_MS = 24 * 60 * 60 * 1000;

// A row with no status is a video waiting for its first push. upload_unconfirmed
// leaves only by a person: markUploaded (posted) or a manual re-queue (uploading).
const uploadQueueMachine = defineStateMachine({
  name: 'desktop-upload-queue',
  transitions: {
    '': [SCHEDULED, UPLOADING, POSTED],
    [SCHEDULED]: [UPLOADING, POSTED],
    [UPLOADING]: [POSTED, UPLOAD_UNCONFIRMED],
    [UPLOAD_UNCONFIRMED]: [UPLOADING, POSTED],
  },
  terminal: [POSTED],
  aliases: { approved: SCHEDULED, pending: SCHEDULED, awaiting_upload: SCHEDULED },
  inFlight: { [UPLOADING]: { ttlMs: UPLOADING_TTL_MS } },
});

/** True for rows no pusher may send to EC2: queued, unconfirmed or posted. */
function isUploadParkedStatus(status) {
  const state = uploadQueueMachine.normalize(String(status ?? '').trim().toLowerCase());
  return state === UPLOADING || state === UPLOAD_UNCONFIRMED || state === POSTED;
}

/**
 * Park every `uploading` row older than the TTL as `upload_unconfirmed`, in
 * place. Returns the parked ids. Never re-queues anything.
 */
function parkStuckUploading(queue, nowMs = Date.now()) {
  const rows = Array.isArray(queue) ? queue : Object.values(queue || {});
  const parked = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (uploadQueueMachine.normalize(String(row.upload_status ?? '').trim().toLowerCase()) !== UPLOADING) continue;
    if (!uploadQueueMachine.isExpired(UPLOADING, row.queued_at, nowMs)) continue;
    uploadQueueMachine.assertTransition(UPLOADING, UPLOAD_UNCONFIRMED);
    row.upload_status = UPLOAD_UNCONFIRMED;
    row.held_at = new Date(nowMs).toISOString();
    row.held_reason = 'Queued on EC2 past the upload window with no confirmation it posted. Check YouTube before queueing it again.';
    parked.push(row.id);
  }
  return parked;
}

/** Locked read-modify-write of the queue file. A missing file parks nothing. */
function sweepUploadQueueFile(queuePath, nowMs = Date.now()) {
  let parked = [];
  updateJsonLocked(queuePath, (queue) => {
    if (queue == null) return updateJsonLocked.SKIP;
    parked = parkStuckUploading(queue, nowMs);
    return parked.length ? undefined : updateJsonLocked.SKIP;
  }, { fallback: null });
  return parked;
}

module.exports = {
  SCHEDULED,
  UPLOADING,
  UPLOAD_UNCONFIRMED,
  POSTED,
  UPLOADING_TTL_MS,
  uploadQueueMachine,
  isUploadParkedStatus,
  parkStuckUploading,
  sweepUploadQueueFile,
};
