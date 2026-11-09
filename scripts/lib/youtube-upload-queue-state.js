'use strict';

// YouTube upload queue (/opt/secondbrain/data/youtube/queue.json): the queue
// row's state machine, and the "is this video still approved right now"
// decision the upload slot makes immediately before bytes leave.
//
// State machine audit finding #2 (owner decision): the queue row and the
// video approval manifest row were two machines that never talked. A video
// approved at 4:50 PM and rejected at 4:55 PM still uploaded at 5:00 PM,
// because the slot only checked duplicates and text fit. The manifest is the
// authority on approval, so the slot re-reads the manifest row for the video
// right before the network call and refuses anything that is not approved
// right now; the reject, delete and thumbnail-reject routes also take the
// video's queued rows off the queue under the queue file lock.

const { defineStateMachine, withFileLock, readJsonStrict } = require('./ledger-state-machine');
const { writeJsonAtomicRetry } = require('./write-json-atomic-retry');
const { heldResumeProblem } = require('./youtube-approved-upload-handoff');

const QUEUED = 'queued';
const BLOCKED_DUPLICATE = 'blocked-duplicate';
const BLOCKED_TEXT_FIT = 'blocked-text-fit';
const UPLOADING = 'uploading';
const OUTCOME_UNKNOWN = 'outcome-unknown';
const HELD_PRIVATE = 'held-private';
const POSTED = 'posted';
const CANCELLED_UNAPPROVED = 'cancelled-unapproved';

// A row with no status at all is a legacy row; it may enter any pre-upload
// state. held-private keeps its YouTube video id and never cancels (its
// identity must outlive a rejection so the id is never uploaded again; only
// the publish is refused, by heldResumeProblem). cancelled-unapproved is final
// for the slot: its only way out is a fresh approval, which queues it again.
// `uploading` is the durable upload claim (Codex b1 review): it is written,
// with the resumable session URL, before the bytes leave. A row still there
// with no upload running, or whose upload ended without a proven answer
// (timeout, lost response, crash), parks in outcome-unknown: YouTube may hold
// the video, so it is never started as a fresh upload automatically. Its only
// ways out are the manifest proving the video id (posted or held-private).
const youtubeQueueMachine = defineStateMachine({
  name: 'youtube-upload-queue',
  transitions: {
    '': [QUEUED, BLOCKED_DUPLICATE, BLOCKED_TEXT_FIT, CANCELLED_UNAPPROVED],
    [QUEUED]: [UPLOADING, BLOCKED_DUPLICATE, BLOCKED_TEXT_FIT, HELD_PRIVATE, POSTED, CANCELLED_UNAPPROVED],
    [BLOCKED_DUPLICATE]: [QUEUED, BLOCKED_TEXT_FIT, CANCELLED_UNAPPROVED],
    [BLOCKED_TEXT_FIT]: [QUEUED, BLOCKED_DUPLICATE, CANCELLED_UNAPPROVED],
    [UPLOADING]: [QUEUED, BLOCKED_DUPLICATE, BLOCKED_TEXT_FIT, HELD_PRIVATE, POSTED, CANCELLED_UNAPPROVED, OUTCOME_UNKNOWN],
    [OUTCOME_UNKNOWN]: [POSTED, HELD_PRIVATE],
    [HELD_PRIVATE]: [POSTED],
    [CANCELLED_UNAPPROVED]: [QUEUED],
  },
  terminal: [POSTED],
  aliases: {
    blocked_duplicate: BLOCKED_DUPLICATE,
    blocked_text_fit: BLOCKED_TEXT_FIT,
    held_private: HELD_PRIVATE,
    cancelled_unapproved: CANCELLED_UNAPPROVED,
    'canceled-unapproved': CANCELLED_UNAPPROVED,
    outcome_unknown: OUTCOME_UNKNOWN,
  },
  inFlight: { [UPLOADING]: { ttlMs: 2 * 60 * 60 * 1000, maxAttempts: 3 } },
});

/** The row's canonical state ('' when it has none). */
function queueRowState(row) {
  return youtubeQueueMachine.normalize(String((row && row.status) || '').trim().toLowerCase());
}

function isCancelledUnapproved(row) {
  return queueRowState(row) === CANCELLED_UNAPPROVED;
}

/** The upload may have reached YouTube: never start it again automatically. */
function isUploadOutcomeUnknown(row) {
  const state = queueRowState(row);
  return state === OUTCOME_UNKNOWN || state === UPLOADING;
}

/**
 * Move a row to `to` if the machine allows it. Never throws: the slot loop must
 * not die on one odd row, so an illegal move returns ok:false and the caller
 * skips the row. A move to the state the row is already in is a no-op that
 * only canonicalizes the spelling.
 */
function transitionQueueRow(row, to) {
  const from = queueRowState(row);
  const target = youtubeQueueMachine.normalize(to);
  if (from === target) {
    const changed = row.status !== target;
    row.status = target;
    return { ok: true, changed, from, to: target };
  }
  if (!youtubeQueueMachine.canTransition(from, target)) {
    return { ok: false, changed: false, from, to: target };
  }
  row.status = target;
  return { ok: true, changed: true, from, to: target };
}

/** Mark a row cancelled-unapproved, stamping when and why. */
function cancelQueueRow(row, { reason = '', now = new Date() } = {}) {
  const moved = transitionQueueRow(row, CANCELLED_UNAPPROVED);
  if (!moved.ok) return { cancelled: false, changed: false, from: moved.from };
  if (moved.changed) {
    row.cancelled_at = now.toISOString();
    row.cancel_reason = String(reason || '').slice(0, 300);
  }
  return { cancelled: true, changed: moved.changed, from: moved.from };
}

/**
 * The durable upload claim, taken after the resumable session is opened and
 * before any byte leaves. The caller persists the queue and sends nothing
 * unless that write succeeded (and calls releaseUploadClaim if it failed).
 */
function claimQueueRowForUpload(row, { sessionUrl = '', now = new Date() } = {}) {
  const from = queueRowState(row);
  const original = row.status;
  if (from !== QUEUED && !transitionQueueRow(row, QUEUED).ok) return { ok: false, from };
  if (!transitionQueueRow(row, UPLOADING).ok) {
    row.status = original;
    return { ok: false, from };
  }
  row.upload_claimed_at = now.toISOString();
  row.upload_attempts = Number(row.upload_attempts || 0) + 1;
  row.upload_session_url = String(sessionUrl || '') || null;
  delete row.last_upload_error;
  return { ok: true, from };
}

/** No byte left (or YouTube provably refused them): the row is queued again. */
function releaseUploadClaim(row, { reason = '' } = {}) {
  if (queueRowState(row) !== UPLOADING) return { released: false, changed: false };
  transitionQueueRow(row, QUEUED);
  delete row.upload_session_url;
  delete row.upload_claimed_at;
  if (reason) row.last_upload_error = String(reason).slice(0, 300);
  return { released: true, changed: true };
}

/** The bytes may have reached YouTube and no answer proved the outcome. */
function parkUploadOutcomeUnknown(row, { reason = '', now = new Date() } = {}) {
  const moved = transitionQueueRow(row, OUTCOME_UNKNOWN);
  if (!moved.ok) return { parked: false, changed: false, from: moved.from };
  if (moved.changed) {
    row.outcome_unknown_at = now.toISOString();
    row.outcome_unknown_reason = String(reason || 'the upload ended without a proven answer').slice(0, 300);
  }
  return { parked: true, changed: moved.changed, from: moved.from };
}

/**
 * The PUT that sends the bytes answered. Returns the video resource when it
 * names a video id; otherwise throws an error marked as sent, and also as
 * refused only when a 4xx error body proves YouTube made no video (408 is a
 * timeout). `res` is { status, body } with body a Buffer or string.
 */
function uploadPutResult(res) {
  let result = null;
  try {
    result = JSON.parse(String(res && res.body != null ? res.body.toString() : ''));
  } catch {
    result = null;
  }
  if (result && result.id) return result;
  const code = Number(res && res.status);
  const error = new Error('Upload failed: ' + (result ? JSON.stringify(result) : 'HTTP ' + code + ' without a JSON body'));
  error.youtubeUploadSent = true;
  error.youtubeUploadRefused = code >= 400 && code < 500 && code !== 408 && Boolean(result && result.error);
  throw error;
}

/**
 * An upload failed while its claim was open. Bytes that may have reached
 * YouTube without a proven answer park the row (never retried automatically);
 * a failure before the bytes, or a proven refusal, queues it again. The caller
 * persists the queue when `changed` is true.
 */
function settleFailedUploadClaim(row, error, { now = new Date() } = {}) {
  if (queueRowState(row) !== UPLOADING) return { outcome: null, changed: false };
  const message = String((error && error.message) || error).slice(0, 200);
  if (error && error.youtubeUploadSent && !error.youtubeUploadRefused) {
    parkUploadOutcomeUnknown(row, { reason: 'upload ended without a proven answer: ' + message, now });
    return { outcome: OUTCOME_UNKNOWN, changed: true };
  }
  releaseUploadClaim(row, { reason: message });
  return { outcome: QUEUED, changed: true };
}

/**
 * Rows left in `uploading` with no upload running (a crash or restart after the
 * claim) are parked, never retried. Returns the ids it parked.
 */
function parkOrphanedUploads(queue, { isActive = () => false, now = new Date() } = {}) {
  const parked = [];
  for (const row of queue) {
    if (!row || queueRowState(row) !== UPLOADING || isActive(row.id)) continue;
    const result = parkUploadOutcomeUnknown(row, {
      reason: 'found uploading with no upload running (crash, restart or lost response); YouTube may hold the video',
      now,
    });
    if (result.changed) parked.push(String(row.id || ''));
  }
  return parked;
}

/**
 * Is the video approved right now? Reads the manifest file fresh every call.
 *
 * ok:true                       approved and not deleted.
 * ok:false, cancel:true         the manifest row exists (or provably does not)
 *                               and says the video is rejected, deleted,
 *                               trashed, pending or otherwise not approved.
 * ok:false, cancel:false        approval cannot be proved (no manifest path, or
 *                               an unreadable manifest). Nothing uploads, but
 *                               the row is not cancelled for a read failure.
 *
 * `manifestPath` is a path or a function returning one. `deleteOpts` passes
 * `deleted`, `tombstones` or `ledgerFile` to the delete check (tests); the
 * server lets the delete ledger decide.
 */
function decideUploadApproval(id, { manifestPath, deleteOpts = {} } = {}) {
  const file = typeof manifestPath === 'function' ? manifestPath() : manifestPath;
  if (!file) {
    return { ok: false, cancel: false, code: 'manifest_unavailable', reason: 'the approval manifest path is not available, so approval cannot be proved' };
  }
  let manifest;
  try {
    manifest = readJsonStrict(file, null);
  } catch (error) {
    return { ok: false, cancel: false, code: 'manifest_unreadable', reason: `the approval manifest is unreadable (${error.message})` };
  }
  if (!manifest || !Array.isArray(manifest.videos)) {
    return { ok: false, cancel: false, code: 'manifest_unreadable', reason: 'the approval manifest has no videos array' };
  }
  const row = manifest.videos.find((video) => video && String(video.id || '') === String(id)) || null;
  if (!row) {
    return { ok: false, cancel: true, code: 'not_on_manifest', reason: `${id} has no row on the approval manifest`, status: null };
  }
  const problem = heldResumeProblem(row, deleteOpts);
  if (problem) {
    return { ok: false, cancel: true, code: 'not_approved', reason: problem, status: String(row.status || '') };
  }
  return { ok: true, status: String(row.status || '') };
}

class UploadNotApprovedError extends Error {
  constructor(id, decision) {
    super(`upload of ${id} refused: ${decision.reason}`);
    this.name = 'UploadNotApprovedError';
    this.code = 'UPLOAD_NOT_APPROVED';
    this.videoId = id;
    this.cancel = decision.cancel === true;
    this.reason = decision.reason;
    this.decisionCode = decision.code;
  }
}

/** Throws UploadNotApprovedError unless the video is approved right now. */
function assertUploadStillApproved(id, opts) {
  const decision = decideUploadApproval(id, opts);
  if (!decision.ok) throw new UploadNotApprovedError(id, decision);
  return decision;
}

/**
 * Run one upload behind the approval guard. `upload({ beforeUpload })` does the
 * real work and must call `beforeUpload()` after its slow steps (token refresh,
 * channel probe) and right before the request that sends bytes; a rejection
 * that landed in the meantime throws there, so no upload call is made.
 *
 * A row that is provably not approved is marked cancelled-unapproved (a held
 * row cannot be: its transition is illegal, so it stays as it is and the
 * outcome is 'refused'). Any other error from `upload` propagates untouched.
 * The caller persists the queue when `changed` is true.
 */
async function runGuardedUpload({ item, manifestPath, deleteOpts, upload, now = new Date() } = {}) {
  const opts = { manifestPath, deleteOpts };
  const beforeUpload = () => assertUploadStillApproved(item.id, opts);
  try {
    beforeUpload();
    const result = await upload({ beforeUpload });
    return { uploaded: true, result };
  } catch (error) {
    if (!(error instanceof UploadNotApprovedError)) throw error;
    if (!error.cancel) {
      // A refusal after the claim is still before the bytes: queued again.
      const released = releaseUploadClaim(item, { reason: error.reason });
      return { uploaded: false, outcome: 'held-unprovable', changed: released.changed, reason: error.reason };
    }
    const cancelled = cancelQueueRow(item, { reason: error.reason, now });
    return {
      uploaded: false,
      outcome: cancelled.cancelled ? CANCELLED_UNAPPROVED : 'refused',
      changed: cancelled.changed,
      reason: error.reason,
    };
  }
}

/**
 * Take every queued upload row of one video off the queue (the video was
 * rejected, deleted or had its thumbnail rejected). Each row is moved through
 * the machine to cancelled-unapproved first, then removed, so the queue holds
 * only work that can still go up. Left alone, with the reason:
 *  - posted rows (already on YouTube; settlement owns them),
 *  - held-private rows (the video id is kept so it is never uploaded again),
 *  - the row whose upload is running now (its own pre-upload check decides).
 * Mutates `queue` in place and returns what it did.
 */
function cancelQueueRowsForVideo(queue, id, { reason = '', now = new Date(), isActive = () => false } = {}) {
  const removed = [];
  const kept = [];
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const row = queue[index];
    if (!row || String(row.id || '') !== String(id)) continue;
    const state = queueRowState(row);
    if (state === POSTED) {
      kept.push({ id: String(id), status: state, why: 'already_posted' });
    } else if (state === HELD_PRIVATE) {
      kept.push({ id: String(id), status: state, why: 'held_private_identity' });
    } else if (isActive(id)) {
      kept.push({ id: String(id), status: state, why: 'upload_in_flight' });
    } else if (state === OUTCOME_UNKNOWN || state === UPLOADING) {
      // YouTube may hold this video: the row is the only record of that.
      kept.push({ id: String(id), status: state, why: 'upload_outcome_unknown' });
    } else if (!cancelQueueRow(row, { reason, now }).cancelled) {
      kept.push({ id: String(id), status: state, why: 'illegal_state' });
    } else {
      queue.splice(index, 1);
      removed.push({ ...row });
    }
  }
  removed.reverse();
  kept.reverse();
  return { removed, kept };
}

/**
 * cancelQueueRowsForVideo plus the file write, as one step under the queue file
 * lock. Waits (Atomics.wait) for a busy lock: CLI and tests only. The server
 * uses the fail-fast twins below.
 */
function cancelVideoQueueRowsLocked({ file, queue, id, reason, now, isActive, lockOpts } = {}) {
  return withFileLock(
    file,
    () => {
      const result = cancelQueueRowsForVideo(queue, id, { reason, now, isActive });
      if (result.removed.length) writeJsonAtomicRetry(file, queue);
      return result;
    },
    lockOpts,
  );
}

/** Persist the queue under the same lock, atomically. Waits for a busy lock: CLI and tests only. */
function writeQueueLocked(file, queue, lockOpts) {
  return withFileLock(file, () => writeJsonAtomicRetry(file, queue), lockOpts);
}

// Server paths never wait for the lock (Codex b1 review): the server is the
// queue's only writer and each write runs synchronously inside the lock, so
// its own callers never overlap. A held lock is another process or an
// orphaned lock; the call throws LEDGER_BUSY at once (no Atomics.wait) and the
// caller refuses with a retryable busy answer. One immediate second try lets a
// stale-lock takeover, which removes the old lock and reports busy, succeed.
const FAIL_FAST = Object.freeze({ waitMs: 0 });

function failFast(run) {
  try {
    return run();
  } catch (error) {
    if (!error || error.code !== 'LEDGER_BUSY') throw error;
    return run();
  }
}

/** writeQueueLocked for the server: never waits for a busy lock. */
function writeQueueFailFast(file, queue, lockOpts = {}) {
  return failFast(() => writeQueueLocked(file, queue, { ...lockOpts, ...FAIL_FAST }));
}

/** cancelVideoQueueRowsLocked for the server: never waits for a busy lock. */
function cancelVideoQueueRowsFailFast({ lockOpts = {}, ...opts } = {}) {
  return failFast(() => cancelVideoQueueRowsLocked({ ...opts, lockOpts: { ...lockOpts, ...FAIL_FAST } }));
}

module.exports = {
  QUEUED,
  BLOCKED_DUPLICATE,
  BLOCKED_TEXT_FIT,
  UPLOADING,
  OUTCOME_UNKNOWN,
  HELD_PRIVATE,
  POSTED,
  CANCELLED_UNAPPROVED,
  youtubeQueueMachine,
  queueRowState,
  isCancelledUnapproved,
  isUploadOutcomeUnknown,
  claimQueueRowForUpload,
  releaseUploadClaim,
  parkUploadOutcomeUnknown,
  parkOrphanedUploads,
  uploadPutResult,
  settleFailedUploadClaim,
  transitionQueueRow,
  cancelQueueRow,
  decideUploadApproval,
  UploadNotApprovedError,
  assertUploadStillApproved,
  runGuardedUpload,
  cancelQueueRowsForVideo,
  cancelVideoQueueRowsLocked,
  writeQueueLocked,
  cancelVideoQueueRowsFailFast,
  writeQueueFailFast,
};
