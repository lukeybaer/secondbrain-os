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

const fs = require('node:fs');
const path = require('node:path');
const { videoStuckAgeHours } = require('./video-stuck-grace.js');

const DELETED_STATUS = 'deleted';
const HELD_MISSING_FINAL_STATUS = 'held_missing_final';
const TERMINAL_VIDEO_STATUSES = new Set([DELETED_STATUS, 'trashed']);

function isTerminalVideoState(v) {
  return !!v && TERMINAL_VIDEO_STATUSES.has(String(v.status || ''));
}

function defaultVideoDeleteLedgerFile() {
  const dataDir =
    process.env.SECONDBRAIN_DATA_DIR ||
    path.join(process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..'), 'data');
  return path.join(dataDir, 'agent', 'video-delete-tombstones.jsonl');
}

function videoId(v) {
  return String((v && (v.id || v.video_id || v.videoId)) || '').trim();
}

function loadVideoDeleteTombstones(ledgerFile = defaultVideoDeleteLedgerFile()) {
  const ids = new Set();
  let raw = '';
  try {
    raw = fs.readFileSync(ledgerFile, 'utf8');
  } catch {
    return ids;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const id = videoId(row);
      if (id && row.deleted !== false) ids.add(id);
    } catch {
      // A damaged forensic line never makes an undeleted item look deleted.
    }
  }
  return ids;
}

function recordVideoDeleteTombstone({
  videoId: id,
  ledgerFile = defaultVideoDeleteLedgerFile(),
  deletedAt = new Date().toISOString(),
  source = 'video-delete',
} = {}) {
  const normalizedId = String(id || '').trim();
  if (!normalizedId) throw new Error('video delete tombstone requires videoId');
  if (loadVideoDeleteTombstones(ledgerFile).has(normalizedId)) {
    return { recorded: false, alreadyRecorded: true, videoId: normalizedId, ledgerFile };
  }
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const row = {
    kind: 'video-delete-tombstone',
    videoId: normalizedId,
    deleted: true,
    deletedAt,
    source,
  };
  fs.appendFileSync(ledgerFile, JSON.stringify(row) + '\n', 'utf8');
  return { recorded: true, alreadyRecorded: false, videoId: normalizedId, ledgerFile };
}

// The legacy content pipeline's YouTube post ledger (May 2026 uploads). The
// current accepted-upload transaction marks the manifest row posted instead
// and does not append here, so this guards legacy rows only. A row whose id is
// recorded here is already public: its missing local final is expected, and
// rebuilding it would put a duplicate of a live short in ExampleCo's queue
// (2026-09-27: short009_aitakes, posted 2026-05-07, was resurrected by a July
// artifact recovery sweep, retired as held_missing_final, and dispatched for
// rebuild).
function defaultYoutubeHistoryFile() {
  const dataDir =
    process.env.SECONDBRAIN_DATA_DIR ||
    path.join(process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..'), 'data');
  return path.join(dataDir, 'youtube', 'history.json');
}

function loadPublishedVideoRecords(historyFile = defaultYoutubeHistoryFile()) {
  const records = new Map();
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  } catch (err) {
    // A missing or unreadable ledger silently disables this safeguard, so the
    // caller must treat it as degraded and fail closed.
    records.error =
      err && err.code === 'ENOENT'
        ? `youtube history missing: ${historyFile}`
        : `youtube history unreadable: ${err && err.message}`;
    return records;
  }
  if (!Array.isArray(rows)) {
    records.error = 'youtube history is not an array';
    return records;
  }
  for (const row of rows) {
    const id = videoId(row);
    const youtubeId = String((row && (row.videoId || row.youtube_video_id)) || '').trim();
    if (id && youtubeId) records.set(id, { ...row, videoId: youtubeId });
  }
  return records;
}

function findPublishedVideoRecord(v, opts = {}) {
  const id = videoId(v);
  if (!id) return null;
  const published =
    opts.published instanceof Map
      ? opts.published
      : loadPublishedVideoRecords(opts.historyFile || defaultYoutubeHistoryFile());
  return published.get(id) || null;
}

// ExampleCo, 2026-09-25: "You can kill the example niche channel and proposed
// clips." A video built for a retired channel is closed Amy work: its held
// missing final is never rebuilt or returned to his approval queue. The
// manifest row rarely carries its channel, so the build manifest supplies it.
// Storiesniche is the Example Niche channel id (niches/Storiesniche.yaml):
// every build it ever recorded is a bedtime story.
const RETIRED_VIDEO_CHANNELS = new Map([
  ['Storiesniche', '2026-09-25'],
  ['ExampleNiche', '2026-09-25'],
]);

function defaultVideoBuildManifestFile() {
  const dataDir =
    process.env.SECONDBRAIN_DATA_DIR ||
    path.join(process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..'), 'data');
  return path.join(dataDir, 'youtube', 'build', 'build_manifest.json');
}

function loadVideoBuildChannels(buildManifestFile = defaultVideoBuildManifestFile()) {
  const channels = new Map();
  let data;
  try {
    data = JSON.parse(fs.readFileSync(buildManifestFile, 'utf8'));
  } catch (err) {
    // A missing or unreadable build manifest must not read as "not retired":
    // callers keep a row with no channel of its own held (fail closed).
    channels.error =
      err && err.code === 'ENOENT'
        ? `build manifest missing: ${buildManifestFile}`
        : `build manifest unreadable: ${err && err.message}`;
    return channels;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    channels.error = 'build manifest is not an object';
    return channels;
  }
  for (const [id, row] of Object.entries(data)) {
    const channel = String((row && row.channel) || '').trim();
    if (id && channel) channels.set(id, channel);
  }
  return channels;
}

function findRetiredVideoChannel(v, opts = {}) {
  const id = videoId(v);
  if (!id) return null;
  const channels =
    opts.buildChannels instanceof Map
      ? opts.buildChannels
      : loadVideoBuildChannels(opts.buildManifestFile || defaultVideoBuildManifestFile());
  const rowChannel = String((v && v.channel) || '').trim();
  // An unreadable build manifest can recover on its own (transient); a
  // missing channel record cannot.
  if (!rowChannel && channels.error) {
    return { channel: null, retiredOn: null, unresolved: true, transient: true, reason: channels.error };
  }
  const channel = rowChannel || String(channels.get(id) || '').trim();
  // No channel on the row and none in a readable build manifest is unknown
  // provenance, not a live channel: a retired row could otherwise rebuild.
  if (!channel) {
    return { channel: null, retiredOn: null, unresolved: true, reason: `no channel recorded for ${id}` };
  }
  const retiredOn = RETIRED_VIDEO_CHANNELS.get(channel);
  return retiredOn ? { channel, retiredOn } : null;
}

// Only a held row or an unreviewed missing-final row may be restored. Owner
// decisions (approved, uploading, scheduled, posted) and terminal or
// tombstoned rows are never rewritten.
const PUBLISHED_RESTORE_STATUSES = new Set([HELD_MISSING_FINAL_STATUS, 'pending_approval', 'pending']);

/**
 * Restore a published row to its true terminal state. Returns true when the
 * row changed.
 */
function applyVideoPublishedRestore(v, record, nowIso, opts = {}) {
  if (!v || !record || !record.videoId) return false;
  if (!PUBLISHED_RESTORE_STATUSES.has(String(v.status || ''))) return false;
  if (isTerminalVideoState(v) || isVideoDeleted(v, opts)) return false;
  const previousStatus = String(v.status || '');
  const heldReason = v.held_reason;
  v.status = 'posted';
  v.youtube_video_id = record.videoId;
  if (record.youtube_url) v.youtube_url = record.youtube_url;
  if (record.channel) v.youtube_channel = record.channel;
  if (record.posted_at) v.posted_at = record.posted_at;
  v.posted_reconciled_at = nowIso || new Date().toISOString();
  v.posted_reconciled_source = 'youtube/history.json';
  v.posted_restored_from_status = previousStatus;
  v.video_needs_regen = false;
  v.thumbnail_needs_regen = false;
  // regen_suppressed on a non-held row reads as an owner deletion.
  v.regen_suppressed = false;
  // The hold copied its own reason into the rejection fields; that text was
  // never ExampleCo's feedback.
  if (heldReason && v.video_rejection_note === heldReason) {
    delete v.video_rejection_note;
    delete v.video_rejected_at;
  }
  delete v.held_at;
  delete v.held_reason;
  delete v.held_previous_status;
  delete v.held_previous_state;
  delete v.held_owner;
  delete v.held_disposition;
  return true;
}

// A `<id>.bak` or `<id>_nomusic.bak` row is a backup file of video <id> that
// the July 2026 pending-artifact recovery sweep registered as its own video.
// It shares its parent's identity, so ExampleCo deleting the parent deletes it too
// (mit_30_agents_nomusic.bak, 2026-09-29).
function backupLineageParentIds(id) {
  const m = /^(.+)\.bak$/i.exec(id);
  if (!m) return [];
  const base = m[1];
  const parents = [base];
  const stripped = base.replace(/_nomusic$/i, '');
  if (stripped && stripped !== base) parents.push(stripped);
  return parents;
}

/** True if this manifest video has been terminally deleted (no regen). */
function isVideoDeleted(v, opts = {}) {
  if (!v) return false;
  if (v.status === DELETED_STATUS) return true;
  if (v.regen_suppressed === true && v.status !== HELD_MISSING_FINAL_STATUS) return true;
  const id = videoId(v);
  if (!id) return false;
  const tombstones =
    opts.tombstones instanceof Set
      ? opts.tombstones
      : loadVideoDeleteTombstones(opts.ledgerFile || defaultVideoDeleteLedgerFile());
  if (tombstones.has(id)) return true;
  return backupLineageParentIds(id).some((parent) => tombstones.has(parent));
}

/**
 * Whether the auto-regen loop should treat this video as a regeneration
 * candidate. A deleted / regen-suppressed video is NEVER a candidate, even if
 * some other flow flipped a needs_regen flag back on. Otherwise a video is a
 * candidate when either asset is flagged for regen.
 */
function isRegenCandidate(v, opts = {}) {
  if (!v) return false;
  if (isVideoDeleted(v, opts) || isVideoHeld(v, opts)) return false;
  if (isStaleMissingFinalVirtualHold(v, opts)) return false;
  return v.video_needs_regen === true || v.thumbnail_needs_regen === true;
}

function isVideoHeld(v, opts = {}) {
  return !!v && v.status === HELD_MISSING_FINAL_STATUS;
}

// An attended operator may explicitly retry one row that this module retired
// because its final MP4 stayed missing beyond grace. Keep the hold in place so
// releaseVideoMissingFinalHold still owns promotion, and arm only the video
// target in memory. Unscoped/scheduled sweeps must never reopen held rows.
function armForcedHeldMissingFinalRegen(v, opts = {}) {
  const filterId = String(opts.filterId || '').trim();
  if (opts.force !== true || !filterId || videoId(v) !== filterId || !isVideoHeld(v)) {
    return false;
  }
  // ExampleCo's delete is terminal by identity; a forced retry never rebuilds it.
  if (isVideoDeleted(v, opts)) return false;
  if (findRetiredVideoChannel(v, opts)) return false;
  v.video_needs_regen = true;
  return true;
}

// A forced held-missing-final retry that did not promote a replacement must
// leave the row held. The generic failure branches demote to video_rejected,
// and with regen_suppressed still true that reads as an owner deletion, which
// hides the row from its recovery task and from every later retry.
function restoreForcedHeldMissingFinalAfterFailure(v) {
  if (!v || v.status === 'pending_approval') return false;
  if (v.status !== HELD_MISSING_FINAL_STATUS && (!v.held_at || !v.held_disposition)) return false;
  v.status = HELD_MISSING_FINAL_STATUS;
  v.video_needs_regen = false;
  v.regen_suppressed = true;
  return true;
}

function videoReplacementGatePlan(v) {
  const wasHeldReplacement = isVideoHeld(v);
  return {
    wasHeldReplacement,
    checkVideo: v?.video_needs_regen === true || wasHeldReplacement,
    checkThumbnail: v?.thumbnail_needs_regen === true || wasHeldReplacement,
  };
}

function applyVideoMissingFinalHold(v, nowIso) {
  if (!v || v.status === HELD_MISSING_FINAL_STATUS || isVideoDeleted(v)) return false;
  const holdNow = nowIso ? new Date(nowIso) : new Date();
  if (!isStaleMissingFinalVirtualHold(v, { now: holdNow })) return false;
  if (hasStructuredVideoBlocker(v)) return false;
  const blockerValues = ['regen_hard_block_reason', 'regen_error', 'build_error', 'video_rejection_note', 'thumbnail_rejection_note', 'rejection_note']
    .map((field) => String(v[field] || '').trim())
    .filter(Boolean);
  if (blockerValues.length && !blockerValues.every((value) => MISSING_FINAL_ONLY_RE.test(value))) return false;
  v.held_previous_state = {
    status: String(v.status || ''),
    video_needs_regen: v.video_needs_regen === true,
    thumbnail_needs_regen: v.thumbnail_needs_regen === true,
    regen_suppressed: v.regen_suppressed === true,
  };
  v.held_previous_status = String(v.status || '');
  v.status = HELD_MISSING_FINAL_STATUS;
  v.video_needs_regen = false;
  v.thumbnail_needs_regen = false;
  v.regen_suppressed = true;
  v.held_at = nowIso || new Date().toISOString();
  v.held_reason = 'final video file remained missing beyond the repair grace window';
  return true;
}

function canMaterializeMissingFinalGate(v) {
  if (!v || !ACTIVE_MISSING_FINAL_STATUSES.has(String(v.status || ''))) return false;
  if (isVideoDeleted(v) || isVideoHeld(v) || v.regen_suppressed === true) return false;
  if (v.video_needs_regen === true || v.thumbnail_needs_regen === true) return false;
  if (v.regen_hard_blocked === true || String(v.regen_status || '').trim()) return false;
  if (hasStructuredVideoBlocker(v)) return false;
  const blockerFields = [
    'regen_hard_block_reason', 'regen_error', 'build_error',
    'video_rejection_note', 'thumbnail_rejection_note', 'rejection_note',
  ];
  if (blockerFields.some((field) => String(v[field] || '').trim())) return false;
  return ![v.release_gate, v.video_release_gate, v.text_fit_gate]
    .some((gate) => gate && (gate.ok === false || String(gate.reason || '').trim()));
}

const MISSING_FINAL_ONLY_RE = /^(?:(?:video\s+)?text-fit release gate:(?:\s*[a-z0-9_-]+:)?\s*)?final video file is missing\.?$/i;
const ACTIVE_MISSING_FINAL_STATUSES = new Set(['pending_approval', 'hard_blocked', 'build_failed', 'blocked_text_fit', 'rejected', 'video_rejected']);

function existingFinalVideo(v, opts = {}) {
  const id = videoId(v);
  const root = opts.repoRoot || process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..');
  const manifestDir = opts.manifestPath ? path.dirname(path.resolve(opts.manifestPath)) : path.join(root, 'content-review', 'pending');
  const declared = String(v?.video_file || '').trim();
  const candidates = [
    declared && (path.isAbsolute(declared) ? declared : path.join(manifestDir, declared)),
    declared && path.join(root, 'data', 'youtube', declared),
    id && path.join(root, 'data', 'youtube', `${id}.mp4`),
    id && path.join(root, 'data', 'youtube', 'build', id, 'final.mp4'),
    id && path.join(root, 'data', 'youtube', 'build-from-plan', id, 'final.mp4'),
  ].filter(Boolean);
  return candidates.some((candidate) => {
    try {
      return fs.statSync(candidate).isFile() && fs.statSync(candidate).size > 0;
    } catch {
      return false;
    }
  });
}

function hasStructuredVideoBlocker(v) {
  if (v?.repair_required === true || v?.repair_proposal) return true;
  if (v?.regen_unaddressed_rejection || v?.regen_unaddressed_rejection_at) return true;
  const contentGates = [
    v?.regen_video_metrics?.content_gate,
    v?.regen_video_content_metrics,
    v?.content_gate,
  ].filter(Boolean);
  if (contentGates.some(videoContentGateFailed)) return true;
  for (const gate of [v?.release_gate, v?.video_release_gate, v?.text_fit_gate].filter(Boolean)) {
    if (gate.ok === false && !MISSING_FINAL_ONLY_RE.test(String(gate.reason || '').trim())) return true;
  }
  return false;
}

function videoContentGateFailed(gate) {
  if (!gate || typeof gate !== 'object') return false;
  if (gate.ok === false) return true;
  const parseCount = (raw) => {
    if (typeof raw === 'number') return Number.isInteger(raw) ? raw : Number.NaN;
    if (typeof raw === 'string' && /^(?:0|[1-9]\d*)$/.test(raw)) return Number(raw);
    return Number.NaN;
  };
  const hasTaken = Object.prototype.hasOwnProperty.call(gate, 'samples_taken');
  const hasBlank = Object.prototype.hasOwnProperty.call(gate, 'samples_blank');
  const taken = parseCount(gate.samples_taken);
  const blank = parseCount(gate.samples_blank);
  if (hasTaken && (!Number.isFinite(taken) || taken <= 0)) return true;
  if (hasBlank && (!Number.isFinite(blank) || blank < 0)) return true;
  if (gate.ok === true) return false;
  const frames = Array.isArray(gate.frames) ? gate.frames.filter((frame) => frame && frame.extracted !== false) : [];
  const samplesTaken = hasTaken ? taken : frames.length;
  const samplesBlank = hasBlank ? blank : frames.filter((frame) => frame.ok === false).length;
  return samplesTaken > 0 && samplesBlank > Math.floor(samplesTaken / 2);
}

function videoPromotionAllowed(releaseGate, otherGatesCleared = true) {
  return otherGatesCleared === true && releaseGate?.ok === true;
}

function isStaleMissingFinalVirtualHold(v, opts = {}) {
  if (!v || !ACTIVE_MISSING_FINAL_STATUSES.has(String(v.status || ''))) return false;
  if (existingFinalVideo(v, opts) || hasStructuredVideoBlocker(v)) return false;
  if (v.thumbnail_needs_regen === true) return false;
  if (['rubric_failed', 'dead-letter'].includes(String(v.regen_status || ''))) return false;
  const blockers = ['regen_hard_block_reason', 'regen_error', 'build_error', 'video_rejection_note', 'thumbnail_rejection_note', 'rejection_note']
    .map((field) => String(v[field] || '').trim())
    .filter(Boolean);
  const textFitReason = String(v?.text_fit_gate?.reason || '').trim();
  if (textFitReason) blockers.push(textFitReason);
  if (!blockers.length || !blockers.every((value) => MISSING_FINAL_ONLY_RE.test(value))) return false;
  const age = videoStuckAgeHours(v, opts.now || Date.now());
  return Number.isFinite(age) && age > Number(opts.graceHours || 24);
}

function clearMissingFinalOwnedBlockers(v) {
  if (!v) return;
  let removedHardBlockReason = false;
  for (const field of [
    'regen_hard_block_reason', 'regen_error', 'build_error',
    'video_rejection_note', 'thumbnail_rejection_note', 'rejection_note',
  ]) {
    if (MISSING_FINAL_ONLY_RE.test(String(v[field] || '').trim())) {
      delete v[field];
      if (field === 'regen_hard_block_reason') removedHardBlockReason = true;
    }
  }
  if (MISSING_FINAL_ONLY_RE.test(String(v?.text_fit_gate?.reason || '').trim())) {
    delete v.text_fit_gate;
  }
  const remainingBlocker = ['regen_hard_block_reason', 'regen_error', 'build_error', 'video_rejection_note', 'thumbnail_rejection_note', 'rejection_note']
    .some((field) => String(v[field] || '').trim()) || hasStructuredVideoBlocker(v);
  if (!remainingBlocker && (removedHardBlockReason || v.regen_hard_blocked === true)) {
    v.regen_hard_blocked = false;
  }
  if (!remainingBlocker && ['failed', 'hard_blocked'].includes(String(v.regen_status || ''))) {
    v.regen_status = 'completed';
  }
}

function releaseVideoMissingFinalHold(v, nowIso, releaseGate) {
  if (!v || v.status !== HELD_MISSING_FINAL_STATUS || !videoPromotionAllowed(releaseGate)) return false;
  const stamp = nowIso || new Date().toISOString();
  const prior = v.held_previous_state || {};
  const history = Array.isArray(v.held_history) ? v.held_history : [];
  history.push({
    held_at: v.held_at || null,
    released_at: stamp,
    reason: v.held_reason || null,
    owner: v.held_owner || null,
    disposition: v.held_disposition || null,
    previous_state: prior,
  });
  v.held_history = history;
  // Release is called only after a replacement final is promoted. That new
  // artifact needs a fresh owner decision, irrespective of the pre-hold status.
  v.status = 'pending_approval';
  v.video_needs_regen = false;
  v.thumbnail_needs_regen = prior.thumbnail_needs_regen === true;
  v.regen_suppressed = false;
  v.held_released_at = stamp;
  clearMissingFinalOwnedBlockers(v);
  delete v.held_at;
  delete v.held_reason;
  delete v.held_previous_status;
  delete v.held_previous_state;
  delete v.held_owner;
  delete v.held_disposition;
  return true;
}

function failVideoMissingFinalRelease(v, releaseGate, nowIso) {
  if (!v || v.status !== HELD_MISSING_FINAL_STATUS || videoPromotionAllowed(releaseGate)) return false;
  const stamp = nowIso || new Date().toISOString();
  const history = Array.isArray(v.held_failure_history) ? v.held_failure_history : [];
  history.push({
    held_at: v.held_at || null,
    failed_at: stamp,
    held_reason: v.held_reason || null,
    owner: v.held_owner || null,
    disposition: v.held_disposition || null,
    gate: releaseGate && typeof releaseGate === 'object'
      ? { ok: false, code: releaseGate.code || null, reason: releaseGate.reason || null }
      : { ok: false, code: 'missing-release-gate', reason: 'verified text-fit release gate required' },
  });
  v.held_failure_history = history;
  v.status = /quality|content|thumbnail/i.test(String(releaseGate?.code || ''))
    ? 'video_rejected'
    : 'blocked_text_fit';
  v.video_needs_regen = true;
  v.regen_suppressed = false;
  v.regen_status = 'failed';
  v.regen_error = `text-fit release gate: ${releaseGate?.code || 'missing-release-gate'}: ${releaseGate?.reason || 'verified text-fit release gate required'}`;
  v.regen_failed_at = stamp;
  delete v.held_at;
  delete v.held_reason;
  delete v.held_previous_status;
  delete v.held_previous_state;
  delete v.held_owner;
  delete v.held_disposition;
  return true;
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
  delete v.held_at;
  delete v.held_reason;
  delete v.held_previous_status;
  delete v.held_previous_state;
  return true;
}

/**
 * Whether a manifest video must be EXCLUDED from every "stuck" dashboard
 * scanner (the tile stuck-scan videoNeedsReviewOrRegen in ec2-server.js, and
 * videoNeedsRepair in cloud-morning-briefing.js).
 *
 * Background (2026-07-06 ExampleCo #gap): ExampleCo deleted all 44 pending videos via
 * applyVideoDelete, which correctly clears video_needs_regen /
 * thumbnail_needs_regen and sets status='deleted' + regen_suppressed=true.
 * But both stuck-scanners ALSO treat a leftover `regen_status` value of
 * 'failed' / 'rubric_failed' / 'dead-letter' / 'hard_blocked' (or a stale
 * `regen_hard_block_reason` / `regen_hard_blocked`) as stuck, independent of
 * the delete markers -- those fields are write-once forensic history from
 * the failed regen attempt; applyVideoDelete never clears them (by design,
 * they are a record of what happened, not live state). So a video that is
 * deleted from ExampleCo's point of view kept showing as "1 stuck item" because
 * neither scanner ever consulted isVideoDeleted() before reading those
 * fields.
 *
 * The fix: deleted means gone from ExampleCo's view, full stop, including every
 * retry-ledger / regen-status ghost field a prior failed attempt left
 * behind. Both scanners call this FIRST and short-circuit to "not stuck"
 * before evaluating any regen_status / hard-block field.
 */
function isTerminallyExcludedFromStuckScan(v, opts = {}) {
  return (
    isVideoPostedOnRow(v) ||
    isVideoDeleted(v, opts) ||
    isVideoHeld(v, opts) ||
    isStaleMissingFinalVirtualHold(v, opts)
  );
}

// A row YouTube already accepted has nothing left to decide, even when its
// `status` still reads `approved`. 2026-09-29: ai-song-story-2026-09-29 was
// posted by a manual publish (upload_status posted, youtube_video_id set)
// without the status writeback, and its intentionally absent staging final
// kept the card red as STUCK BEYOND GRACE. A bare upload_status without the
// returned YouTube id is not proof of publication and stays in the scan.
function isVideoPostedOnRow(v) {
  if (!v) return false;
  if (String(v.status || '') === 'posted') return true;
  return (
    String(v.upload_status || '').trim() === 'posted' &&
    String(v.youtube_video_id || '').trim() !== ''
  );
}

module.exports = {
  DELETED_STATUS,
  HELD_MISSING_FINAL_STATUS,
  defaultVideoDeleteLedgerFile,
  loadVideoDeleteTombstones,
  recordVideoDeleteTombstone,
  defaultYoutubeHistoryFile,
  loadPublishedVideoRecords,
  findPublishedVideoRecord,
  applyVideoPublishedRestore,
  backupLineageParentIds,
  RETIRED_VIDEO_CHANNELS,
  defaultVideoBuildManifestFile,
  loadVideoBuildChannels,
  findRetiredVideoChannel,
  isVideoDeleted,
  isRegenCandidate,
  isVideoHeld,
  armForcedHeldMissingFinalRegen,
  restoreForcedHeldMissingFinalAfterFailure,
  videoReplacementGatePlan,
  isTerminalVideoState,
  isStaleMissingFinalVirtualHold,
  videoContentGateFailed,
  videoPromotionAllowed,
  canMaterializeMissingFinalGate,
  applyVideoMissingFinalHold,
  clearMissingFinalOwnedBlockers,
  releaseVideoMissingFinalHold,
  failVideoMissingFinalRelease,
  applyVideoDelete,
  isVideoPostedOnRow,
  isTerminallyExcludedFromStuckScan,
};
