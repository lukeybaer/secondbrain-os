'use strict';

// Video approval manifest (content-review/pending/manifest.json): the one
// declaration of a row's `status`, its `regen_status` vocabulary, and the
// locked, field-level way to write a row back.
//
// State machine audit finding #21 (owner decision): the manifest had 14+
// status values typed as plain strings, reject had no posted guard (rejecting a
// posted video erased its receipt), trashing kept needs_regen, and auto-regen
// read the manifest once, worked for hours, then wrote its stale copy back over
// whatever the owner decided meanwhile. Every reader and writer imports this module.

const { defineStateMachine, withFileLock, readJsonStrict } = require('./ledger-state-machine');
const { writeJsonAtomicRetry } = require('./write-json-atomic-retry');

const VIDEO_STATUS = Object.freeze({
  PENDING: 'pending',
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  UPLOADING: 'uploading',
  SCHEDULED: 'scheduled',
  POSTED: 'posted',
  REJECTED: 'rejected',
  VIDEO_REJECTED: 'video_rejected',
  THUMBNAIL_REJECTED: 'thumbnail_rejected',
  DELETED: 'deleted',
  TRASHED: 'trashed',
  HELD_MISSING_FINAL: 'held_missing_final',
  BLOCKED_TEXT_FIT: 'blocked_text_fit',
  BUILD_FAILED: 'build_failed',
  BUILDING: 'building',
  VIDEO_BUILT: 'video_built',
  QC_PASSED: 'qc_passed',
  QC_FAILED: 'qc_failed',
});

const WORKING_STATES = [
  VIDEO_STATUS.PENDING,
  VIDEO_STATUS.PENDING_APPROVAL,
  VIDEO_STATUS.APPROVED,
  VIDEO_STATUS.UPLOADING,
  VIDEO_STATUS.SCHEDULED,
  VIDEO_STATUS.REJECTED,
  VIDEO_STATUS.VIDEO_REJECTED,
  VIDEO_STATUS.THUMBNAIL_REJECTED,
  VIDEO_STATUS.HELD_MISSING_FINAL,
  VIDEO_STATUS.BLOCKED_TEXT_FIT,
  VIDEO_STATUS.BUILD_FAILED,
  VIDEO_STATUS.BUILDING,
  VIDEO_STATUS.VIDEO_BUILT,
  VIDEO_STATUS.QC_PASSED,
  VIDEO_STATUS.QC_FAILED,
];
const ENDED = [VIDEO_STATUS.POSTED, VIDEO_STATUS.DELETED, VIDEO_STATUS.TRASHED];

// A row may move between working states in any direction (the build, QC,
// approval and regen writers all do), and out of them to posted, deleted or
// trashed. What the table refuses is the audit's bad move: leaving an ended
// state. deleted and trashed are final. posted can only be deleted (the
// owner's delete keeps the posted receipt fields), never rejected, trashed or
// sent back to a working state. A row with no status may enter any state.
const transitions = { '': [...WORKING_STATES, ...ENDED] };
for (const state of WORKING_STATES) {
  transitions[state] = [...WORKING_STATES.filter((other) => other !== state), ...ENDED];
}
transitions[VIDEO_STATUS.POSTED] = [VIDEO_STATUS.DELETED];

const videoStatusMachine = defineStateMachine({
  name: 'video-manifest',
  transitions,
  terminal: [VIDEO_STATUS.DELETED, VIDEO_STATUS.TRASHED],
  // `published` is the legacy spelling of posted (the YouTube post ledger).
  aliases: { published: VIDEO_STATUS.POSTED },
});

/** A row's canonical status ('' when it has none). Unknown spellings stay as written. */
function videoStatusOf(row) {
  return videoStatusMachine.normalize(String((row && row.status) || '').trim().toLowerCase());
}

/**
 * Can a row in `from` move to `to`? A legacy spelling nobody writes any more
 * (amy_review_queued) cannot be proved illegal, so it may be left for a known
 * state; a move INTO an unknown state is never legal.
 */
function canMoveVideoStatus(from, to) {
  const target = videoStatusMachine.normalize(String(to || '').trim().toLowerCase());
  const origin = videoStatusMachine.normalize(String(from || '').trim().toLowerCase());
  if (origin !== '' && origin === target) return true;
  if (origin !== '' && !videoStatusMachine.isKnown(origin)) return videoStatusMachine.isKnown(target) && target !== '';
  return videoStatusMachine.canTransition(origin, target);
}

/**
 * Is YouTube's acceptance recorded on the row? `posted` status, or a bare
 * `upload_status: posted` together with the returned YouTube id (a bare
 * upload_status alone is not proof).
 */
function isPostedVideoRow(row) {
  if (!row) return false;
  if (videoStatusOf(row) === VIDEO_STATUS.POSTED) return true;
  return (
    String(row.upload_status || '').trim() === 'posted' &&
    String(row.youtube_video_id || '').trim() !== ''
  );
}

// regen_status vocabulary. hard_blocked was written for one release (2026-05-16,
// auth failures) and removed on 2026-05-18 when auth failures moved onto the
// retry budget and dead-letter; a legacy value reads as the failure it was.
const REGEN_STATUS = Object.freeze({
  QUEUED: 'queued',
  IN_PROGRESS: 'in_progress',
  FAILED: 'failed',
  DEAD_LETTER: 'dead-letter',
  RUBRIC_PASSED: 'rubric_passed',
  RUBRIC_FAILED: 'rubric_failed',
  DONE: 'done',
  COMPLETED: 'completed',
  DOOM_LOOP_SKIPPED: 'doom-loop-skipped',
  REBUILD_DID_NOT_ADDRESS_REJECTION: 'rebuild_did_not_address_rejection',
  CONTENT_GATE_BLANK_FRAME: 'content_gate_blank_frame',
});
const REGEN_STATUS_ALIASES = Object.freeze({ hard_blocked: REGEN_STATUS.FAILED });
const STUCK_REGEN_STATUSES = new Set([REGEN_STATUS.FAILED, REGEN_STATUS.RUBRIC_FAILED, REGEN_STATUS.DEAD_LETTER]);

function normalizeRegenStatus(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(REGEN_STATUS_ALIASES, raw) ? REGEN_STATUS_ALIASES[raw] : raw;
}

/** Does this regen_status mean the repair is stuck (failed, rubric-failed, dead-lettered)? */
function isStuckRegenStatus(value) {
  return STUCK_REGEN_STATUSES.has(normalizeRegenStatus(value));
}

/**
 * Why a dashboard reject must not touch this row, or null when it may.
 * A reject means "send this back for regen". A posted video is already public
 * and a reject cannot take it down, so the reject is refused and the row (with
 * its posted receipt) is left exactly as it is. A deleted or trashed row is
 * final; rejecting it would bring it back.
 */
function videoRejectRefusal(row) {
  if (isPostedVideoRow(row)) {
    return {
      code: 'already_posted',
      message:
        'This video is already posted on YouTube. Reject cannot take it down, so nothing was changed and its posted record is kept. Remove it on YouTube, or make a new video.',
    };
  }
  const status = videoStatusOf(row);
  if (status === VIDEO_STATUS.DELETED || status === VIDEO_STATUS.TRASHED) {
    return {
      code: `already_${status}`,
      message: `This video was already ${status}, so it cannot be rejected. Nothing was changed.`,
    };
  }
  return null;
}

/**
 * The no-note reject: throw the asset away. Clears both needs_regen flags so a
 * trashed row can never be picked up for regeneration. Mutates `row`.
 */
function trashVideoRow(row, target, nowIso) {
  row.status = VIDEO_STATUS.TRASHED;
  row.trashed_at = nowIso || new Date().toISOString();
  row[`${target}_trashed`] = true;
  row.video_needs_regen = false;
  row.thumbnail_needs_regen = false;
  return row;
}

// Fields only the owner (or the upload flow) sets. A writer that worked from an
// older copy of the row must not write over a row where any of these moved.
const OWNER_DECISION_FIELDS = Object.freeze([
  'approved_at',
  'approved_by',
  'rejected_at',
  'rejected_by',
  'video_rejected_at',
  'thumbnail_rejected_at',
  'video_rejection_note',
  'thumbnail_rejection_note',
  'rejection_note',
  'deleted_at',
  'deleted_by',
  'trashed_at',
  'regen_suppressed',
  'owner_post_after_fix',
  'upload_status',
  'youtube_video_id',
  'youtube_url',
  'posted_at',
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function manifestRows(manifest) {
  if (Array.isArray(manifest)) return manifest;
  if (manifest && Array.isArray(manifest.videos)) return manifest.videos;
  return null;
}

function rowId(row) {
  return row && row.id != null ? String(row.id) : '';
}

/** The fields `next` set or removed relative to `base`. */
function rowDiff(base, next) {
  const set = {};
  const remove = [];
  for (const key of Object.keys(next || {})) {
    if (next[key] === undefined) {
      if (base && base[key] !== undefined) remove.push(key);
    } else if (!base || stable(next[key]) !== stable(base[key])) {
      set[key] = clone(next[key]);
    }
  }
  for (const key of Object.keys(base || {})) {
    if (!Object.prototype.hasOwnProperty.call(next || {}, key)) remove.push(key);
  }
  return { set, remove, empty: !Object.keys(set).length && !remove.length };
}

/** Which owner-decision fields (and status) differ between the row a writer started from and the row on disk. */
function movedOwnerFields(base, diskRow) {
  const moved = [];
  if (videoStatusOf(base) !== videoStatusOf(diskRow)) moved.push('status');
  for (const field of OWNER_DECISION_FIELDS) {
    if (stable(base ? base[field] : undefined) !== stable(diskRow ? diskRow[field] : undefined)) moved.push(field);
  }
  return moved;
}

/**
 * Apply one row's field-level change to the manifest file under its lock:
 * re-read the current file, find the row by id, let `guard(diskRow)` refuse,
 * then set/remove only the fields `next` changed relative to `baseline`. Every
 * other field of every row stays as it is on disk. A corrupt file throws and is
 * never rewritten.
 *
 * `items` is [{ id, baseline, next, guard? }]; the result has one entry each.
 * guard returns null to proceed or { code, message } to refuse that row.
 */
function applyRowChangesLocked(manifestPath, items, lockOpts) {
  const results = [];
  withFileLock(
    manifestPath,
    () => {
      const disk = readJsonStrict(manifestPath, null);
      const list = manifestRows(disk);
      if (!list) throw new Error(`video manifest has no videos array, refusing to rewrite: ${manifestPath}`);
      let wrote = false;
      for (const item of items) {
        const id = String(item.id);
        const diskRow = list.find((row) => rowId(row) === id) || null;
        if (!item.baseline) {
          if (diskRow) {
            results.push({ id, ok: false, code: 'row_exists', message: `${id} already has a row` });
          } else {
            list.push(clone(item.next));
            wrote = true;
            results.push({ id, ok: true });
          }
          continue;
        }
        if (!diskRow) {
          results.push({ id, ok: false, code: 'row_missing', message: `${id} is no longer on the manifest` });
          continue;
        }
        const refusal = item.guard ? item.guard(diskRow) : null;
        if (refusal) {
          results.push({ id, ok: false, code: refusal.code, message: refusal.message, detail: refusal.detail });
          continue;
        }
        const diff = rowDiff(item.baseline, item.next);
        if (!diff.empty) {
          Object.assign(diskRow, diff.set);
          for (const key of diff.remove) delete diskRow[key];
          wrote = true;
        }
        results.push({ id, ok: true });
      }
      if (wrote) writeJsonAtomicRetry(manifestPath, disk);
    },
    lockOpts,
  );
  return results;
}

/**
 * Write one row's change (a dashboard or desktop reject) without replacing the
 * rest of the file: locked, re-read, guarded. Returns { ok, code?, message? }.
 */
function commitVideoRowChange(manifestPath, id, baseline, next, { guard, lockOpts } = {}) {
  const [result] = applyRowChangesLocked(manifestPath, [{ id, baseline, next, guard }], lockOpts);
  return result;
}

/**
 * Hold a manifest in memory for a long job and write it back safely.
 *
 * The auto-regen job reads the manifest once, works for hours, and used to
 * write that stale copy over the file. flush() instead diffs every row against
 * the copy it last read or wrote, re-reads the file under the lock, and applies
 * only the fields this job changed. A row is REFUSED (left as it is on disk) when
 * it is gone, when its status or any owner-decision field moved since the job
 * read it, or when the job's status change is not a legal move from the status
 * now on disk. A refused row is not retried this run.
 */
function createManifestFlusher(manifestPath, manifest, { lockOpts } = {}) {
  const baselines = new Map();
  const refused = new Map();
  for (const row of manifestRows(manifest) || []) {
    if (rowId(row)) baselines.set(rowId(row), clone(row));
  }

  function guardFor(id, row) {
    return (diskRow) => {
      const moved = movedOwnerFields(baselines.get(id), diskRow);
      if (moved.length) {
        return {
          code: 'owner_decision_moved',
          message: `${id}: ${moved.join(', ')} changed on the manifest while this job worked`,
          detail: moved,
        };
      }
      if (videoStatusOf(diskRow) !== videoStatusOf(row) && !canMoveVideoStatus(diskRow.status, row.status)) {
        return {
          code: 'illegal_move',
          message: `${id}: ${String(diskRow.status || '(none)')} -> ${String(row.status)} is not a legal video status move`,
          detail: [String(diskRow.status || ''), String(row.status)],
        };
      }
      return null;
    };
  }

  /** Why the row must not be worked on now (null when it is unchanged on disk or cannot be read). */
  function rowMoved(id) {
    const key = String(id);
    const base = baselines.get(key);
    if (!base) return null;
    try {
      const list = manifestRows(readJsonStrict(manifestPath, null));
      if (!list) return null;
      const diskRow = list.find((row) => rowId(row) === key);
      if (!diskRow) return { code: 'row_missing', message: `${key} is no longer on the manifest` };
      const moved = movedOwnerFields(base, diskRow);
      return moved.length
        ? { code: 'owner_decision_moved', message: `${key}: ${moved.join(', ')} changed on the manifest`, detail: moved }
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Apply this job's changes since the last flush. Returns { applied, refused }
   * (arrays of ids and of { id, code, message }). A failed write throws with the
   * baselines untouched, so the next flush retries the same changes.
   */
  function flush(current = manifest) {
    const items = [];
    for (const row of manifestRows(current) || []) {
      const id = rowId(row);
      if (!id || refused.has(id)) continue;
      const base = baselines.get(id);
      if (base && rowDiff(base, row).empty) continue;
      items.push({ id, baseline: base || null, next: row, guard: base ? guardFor(id, row) : null });
    }
    if (!items.length) return { applied: [], refused: [] };
    const results = applyRowChangesLocked(manifestPath, items, lockOpts);
    const applied = [];
    const refusedNow = [];
    for (const result of results) {
      if (result.ok) {
        const item = items.find((candidate) => candidate.id === result.id);
        baselines.set(result.id, clone(item.next));
        applied.push(result.id);
      } else {
        refused.set(result.id, { code: result.code, message: result.message });
        refusedNow.push({ id: result.id, code: result.code, message: result.message });
      }
    }
    return { applied, refused: refusedNow };
  }

  return { flush, rowMoved, isRefused: (id) => refused.has(String(id)), refused };
}

module.exports = {
  VIDEO_STATUS,
  videoStatusMachine,
  videoStatusOf,
  canMoveVideoStatus,
  isPostedVideoRow,
  REGEN_STATUS,
  REGEN_STATUS_ALIASES,
  normalizeRegenStatus,
  isStuckRegenStatus,
  videoRejectRefusal,
  trashVideoRow,
  OWNER_DECISION_FIELDS,
  rowDiff,
  movedOwnerFields,
  applyRowChangesLocked,
  commitVideoRowChange,
  createManifestFlusher,
};
