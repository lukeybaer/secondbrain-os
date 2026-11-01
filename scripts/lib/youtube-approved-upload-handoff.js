const fs = require('fs');
const path = require('path');
const { isVideoDeleted } = require('./video-delete-state.js');

const DEFAULT_UPLOAD_CHANNEL = 'Examplechannel';
const UPLOAD_CHANNEL_ALIASES = Object.freeze({ Storiesniche: 'ExampleNiche' });

// Long-form uploads (owner decision: the Moonshots three-minute highlights
// "are not shorts; make it long format"). A manifest row with
// `youtube_format: "longform"` (or `format: "longform"`) goes up as a regular
// YouTube video: no #Shorts marker in the title, description or tags, a
// landscape file, and a watch URL instead of a /shorts/ URL.
const LONGFORM = 'longform';
const LONGFORM_MIN_WIDTH = 1280;

function youtubeFormatFor(entry = {}) {
  const value = String((entry && (entry.youtube_format || entry.format)) || '').trim().toLowerCase();
  return value === LONGFORM ? LONGFORM : 'short';
}

function youtubeUrlFor(videoId, format = 'short') {
  return format === LONGFORM
    ? `https://www.youtube.com/watch?v=${videoId}`
    : `https://youtube.com/shorts/${videoId}`;
}

function stripShortsMarkers(text) {
  return String(text || '')
    .replace(/(^|[ \t])#shorts\b/gim, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function longformUploadMetadata({ title = '', description = '', tags = [] } = {}) {
  return {
    title: stripShortsMarkers(title),
    description: stripShortsMarkers(description),
    tags: (Array.isArray(tags) ? tags : []).filter(
      (tag) => !/^#?shorts?$/i.test(String(tag || '').trim()),
    ),
  };
}

// An AI-presenter row (Sadie) says `synthetic_media: true` on the approval
// manifest row or its build sidecar. The queue item carries it so the upload
// declares YouTube's altered-or-synthetic label itself (Codex review
// a6f6dabb8f34: videos.insert accepts status.containsSyntheticMedia; the old
// by-hand Studio tick was a false limitation) and the X caption carries the
// row's disclosure line.
function isSyntheticMedia(entry = {}, sidecar = {}) {
  return Boolean((entry && entry.synthetic_media === true) || (sidecar && sidecar.synthetic_media === true));
}

// The status part of videos.insert and videos.update for an approved upload.
// A synthetic row inserts private (Codex review 754882545a62 F1): it goes
// public only after publishSyntheticUpload proves the label on the video.
function youtubeUploadStatus({ privacyStatus = 'public', madeForKids = false, synthetic = false } = {}) {
  return {
    privacyStatus,
    madeForKids: Boolean(madeForKids),
    selfDeclaredMadeForKids: Boolean(madeForKids),
    ...(synthetic ? { containsSyntheticMedia: true } : {}),
  };
}

// videos.list never returns containsSyntheticMedia (LEARNINGS 2026-09-29), so
// the label is confirmed from the write response alone.
function syntheticDisclosureOutcome({ synthetic = false, writeStatus = null } = {}) {
  if (!synthetic) return 'not_required';
  return writeStatus && writeStatus.containsSyntheticMedia === true ? 'confirmed' : 'unconfirmed';
}

// A write response proves a status field only when the HTTP status is 2xx
// and the returned status part echoes every expected value.
function writeProves(response, expected) {
  if (!response || !response.status) return false;
  const code = Number(response.httpStatus);
  if (!(code >= 200 && code < 300)) return false;
  return Object.keys(expected).every((key) => response.status[key] === expected[key]);
}

function describeWrite(response) {
  if (!response) return 'no response';
  const parts = [`http ${response.httpStatus}`];
  if (response.error) parts.push(String(response.error).slice(0, 120));
  if (response.status) {
    parts.push(`privacy=${response.status.privacyStatus}`);
    parts.push(`label=${response.status.containsSyntheticMedia}`);
  }
  return parts.join(' ');
}

// What a status part proves about the video's privacy: only an echoed
// privacyStatus counts; anything else is unknown.
function provenPrivacy(status) {
  const value = status && status.privacyStatus;
  return value === 'private' || value === 'public' ? value : 'unknown';
}

// Private-first publication of an AI-presenter upload (Codex reviews
// 754882545a62 findings 1-3 and 6627b57dbccb F1). The video was inserted
// private. `update` writes a status part (videos.update, part=status) and
// resolves { httpStatus, status, error } or throws. The label is proved while
// the video is still private; only a publish response that echoes both the
// label and `public` counts as published. The privacy in the result is only
// ever what a response proved: the insert echo, the prior proven hold passed
// as priorPrivacy, or a 2xx echo here. A rejected write (4xx) leaves the
// prior privacy; an ambiguous publish (no echo, a 5xx, a transport failure)
// is unknown until a pull-private proves private again. Nothing here throws:
// the result says what was proved, and the caller persists it.
// `beforePublish({ disclosure, privacy })` runs after the label proof and
// before the public write (Codex 417e524804ab F5): the caller persists the
// in-flight receipt there. A publish exception gets one bounded
// pull-private (F2); only a proven pull counts.
async function publishSyntheticUpload({
  insertStatus = null,
  uploadStatus = {},
  update,
  priorPrivacy = 'unknown',
  beforePublish = null,
} = {}) {
  if (typeof update !== 'function') throw new Error('publishSyntheticUpload needs an update function');
  const base = { ...uploadStatus, containsSyntheticMedia: true };
  let disclosure = insertStatus && insertStatus.containsSyntheticMedia === true ? 'confirmed' : null;
  let privacy = provenPrivacy(insertStatus);
  if (privacy === 'unknown') privacy = provenPrivacy({ privacyStatus: priorPrivacy });
  // A write that asked for private and did not prove it leaves a proven
  // private video private and anything else unknown.
  const afterUnprovenPrivateWrite = () => (privacy === 'private' ? 'private' : 'unknown');
  let step = 'label';
  try {
    if (!disclosure) {
      const labeled = await update({ ...base, privacyStatus: 'private' });
      privacy = writeProves(labeled, { privacyStatus: 'private' }) ? 'private' : afterUnprovenPrivateWrite();
      if (!writeProves(labeled, { containsSyntheticMedia: true })) {
        return {
          published: false,
          disclosure: 'unconfirmed',
          hold: 'label_unconfirmed',
          privacy,
          detail: describeWrite(labeled),
        };
      }
      disclosure = 'confirmed_by_update';
    }
    // The in-flight receipt (Codex 417e524804ab F5): the caller records
    // "publishing, privacy unknown" before the public write leaves, so a
    // crash during that write is restored as an unproven hold, never as a
    // private one.
    if (typeof beforePublish === 'function') {
      step = 'receipt';
      await beforePublish({ disclosure, privacy });
    }
    step = 'publish';
    const published = await update({ ...base, privacyStatus: 'public' });
    if (writeProves(published, { containsSyntheticMedia: true, privacyStatus: 'public' })) {
      return { published: true, disclosure, hold: null, privacy: 'public', detail: null };
    }
    // The publish write did not prove both fields. A rejected request (4xx)
    // changed nothing. Any other outcome may have made the video public
    // without a proven label, so it is pulled private, and only a proven
    // pull counts.
    const code = Number(published && published.httpStatus);
    const rejected = code >= 400 && code < 500;
    const reported = writeProves(published, {}) ? provenPrivacy(published.status) : 'unknown';
    if (reported === 'private') {
      privacy = 'private';
    } else if (reported === 'public' || !rejected) {
      step = 'pull_private';
      const pulled = await update({ ...base, privacyStatus: 'private' });
      privacy = writeProves(pulled, { privacyStatus: 'private' }) ? 'private' : 'unknown';
    }
    return { published: false, disclosure, hold: 'publish_unproven', privacy, detail: describeWrite(published) };
  } catch (error) {
    const failure = `${step}: ${String((error && error.message) || error).slice(0, 120)}`;
    if (step === 'publish') {
      // The publish request may have left and made the video public (Codex
      // 417e524804ab F2): one bounded pull-private follows, only a response
      // that proves private counts, and anything else stays unknown.
      let rollback;
      try {
        const pulled = await update({ ...base, privacyStatus: 'private' });
        privacy = writeProves(pulled, { privacyStatus: 'private' }) ? 'private' : 'unknown';
        rollback = describeWrite(pulled);
      } catch (rollbackError) {
        privacy = 'unknown';
        rollback = String((rollbackError && rollbackError.message) || rollbackError).slice(0, 60);
      }
      return { published: false, disclosure, hold: 'update_failed', privacy, detail: `${failure}; rollback: ${rollback}` };
    }
    // A failure before any write left (the receipt) or on the label write
    // leaves a proven private video private; one on the pull-private write
    // (already the second attempt after an unproven publish) stays unknown.
    return {
      published: false,
      disclosure: disclosure || 'unconfirmed',
      hold: step === 'receipt' ? 'receipt_failed' : 'update_failed',
      privacy: step === 'pull_private' ? 'unknown' : afterUnprovenPrivateWrite(),
      detail: failure,
    };
  }
}

// A held-private queue row: YouTube accepted the file (video id known) but
// the label or the publish is not yet proved. It never uploads again; a
// resume (POST /youtube/upload-now {"id"}) re-runs publishSyntheticUpload on
// the same video id.
const HELD_PRIVATE_STATUS = 'held-private';

function isHeldPrivateYouTubeUpload(queueItem = {}) {
  return (
    String(queueItem.status || '').toLowerCase() === HELD_PRIVATE_STATUS &&
    Boolean(String(queueItem.videoId || queueItem.youtube_video_id || '').trim())
  );
}

function holdQueueItemPrivate(
  queueItem,
  { videoId, url, videoSha256, disclosure = 'pending', hold = 'pending', privacy = 'unknown', detail = null, now = new Date() } = {},
) {
  const id = String(videoId || queueItem.videoId || '').trim();
  if (!id) throw new Error('a held-private queue row needs the accepted YouTube video id');
  // The accepted video id is bound to the bytes YouTube holds (Codex
  // 6627b57dbccb F3): the first hold records the uploaded file's SHA-256 and
  // no later approval or refresh may move the id onto other bytes.
  const heldSha = String(videoSha256 || queueItem.held_video_sha256 || queueItem.videoSha256 || '').trim();
  queueItem.status = HELD_PRIVATE_STATUS;
  queueItem.videoId = id;
  queueItem.held_video_sha256 = heldSha || null;
  queueItem.youtube_url = String(url || queueItem.youtube_url || '').trim() || youtubeUrlFor(id, youtubeFormatFor(queueItem));
  queueItem.synthetic_disclosure = String(disclosure);
  queueItem.youtube_hold = String(hold);
  queueItem.youtube_hold_detail = detail ? String(detail).slice(0, 200) : null;
  queueItem.youtube_privacy = String(privacy);
  queueItem.held_at = queueItem.held_at || now.toISOString();
  queueItem.hold_updated_at = now.toISOString();
  return queueItem;
}

// A held-private row is bound to the bytes YouTube accepted (Codex
// 6627b57dbccb F3). Null when the offered bytes are those bytes; otherwise
// the reason a replacement approval, a queue refresh or a resume is refused.
function heldUploadBytesProblem(queueItem = {}, videoSha256 = queueItem.videoSha256) {
  if (!isHeldPrivateYouTubeUpload(queueItem)) return null;
  const held = String(queueItem.held_video_sha256 || '').trim();
  const offered = String(videoSha256 || '').trim();
  if (held && offered && held === offered) return null;
  const videoId = String(queueItem.videoId || queueItem.youtube_video_id || '').trim();
  return (
    `${queueItem.id} is held private on YouTube video ${videoId} for bytes ${held || 'unrecorded'}, ` +
    `not ${offered || 'unrecorded'}; resume or cancel the held upload before approving replacement bytes`
  );
}

// A long-form upload must be a landscape file, or YouTube may still treat a
// vertical or square file of three minutes or less as a Short.
function longformDimensionProblem({ width, height } = {}) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return 'long-form upload needs a probed picture size';
  }
  if (w <= h) return `long-form upload must be landscape, got ${w}x${h}`;
  if (w < LONGFORM_MIN_WIDTH) return `long-form upload is ${w}x${h}, under ${LONGFORM_MIN_WIDTH} px wide`;
  return null;
}

function targetUploadChannel(manifestEntry = {}, sidecar = {}) {
  const manifestChannel =
    manifestEntry.source === 'viral_clip' ? '' : String(manifestEntry.channel || '').trim();
  const selected =
    String(sidecar.channel || '').trim() ||
    String(manifestEntry.publish_channel || '').trim() ||
    String(manifestEntry.target_channel || '').trim() ||
    manifestChannel ||
    DEFAULT_UPLOAD_CHANNEL;
  return UPLOAD_CHANNEL_ALIASES[selected] || selected;
}

function buildApprovedUploadQueueItem({
  manifestEntry,
  sidecar = {},
  videoPath,
  thumbnailPath = null,
  textFitGate,
  now = new Date(),
} = {}) {
  if (!manifestEntry || !manifestEntry.id)
    throw new Error('approved manifest entry id is required');
  if (!videoPath) throw new Error(`approved video file is missing for ${manifestEntry.id}`);
  if (!textFitGate || textFitGate.ok !== true) {
    throw new Error(`approved video text-fit proof is missing for ${manifestEntry.id}`);
  }
  if (!textFitGate.receiptPath || !textFitGate.videoSha256 || !textFitGate.receiptSha256) {
    throw new Error(`approved video text-fit proof is incomplete for ${manifestEntry.id}`);
  }

  const format = youtubeFormatFor({ ...manifestEntry, ...(sidecar && sidecar.youtube_format ? { youtube_format: sidecar.youtube_format } : {}) });
  // Codex 19ded1278880 (F10): the sidecar description normally wins, but a
  // synthetic-media row must upload with the disclosure line; when only the
  // manifest's description ends with the label, that one is used.
  const synthetic = isSyntheticMedia(manifestEntry, sidecar);
  const label = String(sidecar.synthetic_media_label || manifestEntry.synthetic_media_label || '').trim();
  const sidecarDescription = String(sidecar.description || '');
  const manifestDescription = String(manifestEntry.description || '');
  const description =
    synthetic && label && !sidecarDescription.trimEnd().endsWith(label) && manifestDescription.trimEnd().endsWith(label)
      ? manifestDescription
      : sidecarDescription || manifestDescription;
  const metadata = {
    title: String(manifestEntry.title || sidecar.title || manifestEntry.id),
    description,
    tags: Array.isArray(sidecar.tags)
      ? sidecar.tags
      : Array.isArray(manifestEntry.tags)
        ? manifestEntry.tags
        : [],
  };
  return {
    id: String(manifestEntry.id),
    ...(format === LONGFORM ? longformUploadMetadata(metadata) : metadata),
    ...(format === LONGFORM ? { youtube_format: LONGFORM } : {}),
    ...(synthetic ? { synthetic_media: true, ...(label ? { synthetic_media_label: label } : {}) } : {}),
    channel: targetUploadChannel(manifestEntry, sidecar),
    videoPath,
    thumbnailPath,
    textFitReceiptPath: textFitGate.receiptPath,
    videoSha256: textFitGate.videoSha256,
    textFitReceiptSha256: textFitGate.receiptSha256,
    approved_at: manifestEntry.approved_at || null,
    queued_at: now.toISOString(),
    status: 'queued',
  };
}

function upsertApprovedUploadQueueItem(queue, item) {
  if (!Array.isArray(queue)) throw new Error('YouTube upload queue must be an array');
  if (!item || !item.id) throw new Error('YouTube upload queue item id is required');
  const index = queue.findIndex((queued) => queued && queued.id === item.id);
  if (index >= 0) {
    const existing = queue[index];
    // A re-approval never turns a held-private row (video already on
    // YouTube) back into a queued upload, and never moves its video id onto
    // other bytes (Codex 6627b57dbccb F3): the same bytes leave the held row
    // exactly as it is; different bytes are refused until the hold is
    // resumed or cancelled.
    if (isHeldPrivateYouTubeUpload(existing)) {
      const problem = heldUploadBytesProblem(existing, item.videoSha256);
      if (problem) throw new Error(problem);
      // The fresh approval's AI-presenter flag and label reach the held row
      // (Codex 1e96b5fc94a6 R3), so its receipt and the manifest hold carry
      // them; identity, bytes binding and hold stay exactly as they are.
      const heldBefore = JSON.stringify(existing);
      syncSyntheticDisclosureOntoQueueItem(existing, item);
      return { deduped: true, index, item: existing, held: true, changed: JSON.stringify(existing) !== heldBefore };
    }
    // The row is refreshed in place (Codex 1e96b5fc94a6 R2): an upload in
    // flight keeps the object it holds, so its receipt lands on this row.
    const before = JSON.stringify(existing);
    Object.assign(existing, item, { status: 'queued' });
    return { deduped: true, index, item: existing, changed: JSON.stringify(existing) !== before };
  }
  queue.push(item);
  return { deduped: false, index: queue.length - 1, item };
}

function isPersistedYouTubePublication(queueItem = {}) {
  return (
    String(queueItem.status || '').toLowerCase() === 'posted' &&
    Boolean(String(queueItem.videoId || queueItem.youtube_video_id || '').trim())
  );
}

function applySuccessfulYouTubePublication(manifest, queueItem, { now = new Date() } = {}) {
  if (!manifest || !Array.isArray(manifest.videos)) {
    throw new Error('approval manifest must contain a videos array');
  }
  if (!isPersistedYouTubePublication(queueItem)) {
    throw new Error('successful YouTube publication requires status posted and a video id');
  }
  const id = String(queueItem.id || '').trim();
  if (!id) throw new Error('published queue item id is required');
  const entry = manifest.videos.find((video) => video && String(video.id || '') === id);
  if (!entry) {
    throw new Error(`published queue item ${id} is missing from the approval manifest`);
  }

  const videoId = String(queueItem.videoId || queueItem.youtube_video_id).trim();
  const existingVideoId = String(entry.youtube_video_id || '').trim();
  if (existingVideoId && existingVideoId !== videoId) {
    throw new Error(
      `approval manifest item ${id} already points to a different YouTube video (${existingVideoId})`,
    );
  }
  entry.status = 'posted';
  entry.youtube_video_id = videoId;
  entry.youtube_url =
    String(queueItem.youtube_url || queueItem.url || '').trim() ||
    youtubeUrlFor(videoId, youtubeFormatFor(queueItem.youtube_format ? queueItem : entry));
  entry.youtube_channel = String(queueItem.channel || entry.youtube_channel || '').trim();
  entry.posted_at = String(queueItem.posted_at || entry.posted_at || now.toISOString());
  entry.publication_recorded_at = now.toISOString();
  // How the AI-presenter label was proved on this upload (confirmed on the
  // insert, or confirmed_by_update); a posted row is never held.
  if (queueItem.synthetic_disclosure) entry.synthetic_disclosure = String(queueItem.synthetic_disclosure);
  // The flag and label the X poster reads ride on every publication record
  // (Codex 1e96b5fc94a6 R3): a row approved without them, or settled from a
  // queue receipt, is never posted to X without the AI-presenter line.
  syncSyntheticDisclosureOntoManifestRow(entry, queueItem);
  delete entry.youtube_hold;
  delete entry.youtube_hold_detail;
  delete entry.youtube_privacy;
  return { manifest, entry, id, videoId };
}

function manifestEntryForQueueItem(manifest, queueItem) {
  if (!manifest || !Array.isArray(manifest.videos)) {
    throw new Error('approval manifest must contain a videos array');
  }
  const id = String((queueItem && queueItem.id) || '').trim();
  if (!id) throw new Error('queue item id is required');
  const entry = manifest.videos.find((video) => video && String(video.id || '') === id);
  if (!entry) throw new Error(`queue item ${id} is missing from the approval manifest`);
  return { id, entry };
}

// The accepted video id lands on the manifest row the moment YouTube returns
// it (Codex review 754882545a62 F2), with the hold state; the row's status
// stays as approved, so nothing reports a private hold as a post (F3).
function applyHeldYouTubeUpload(manifest, queueItem, { now = new Date() } = {}) {
  if (!isHeldPrivateYouTubeUpload(queueItem)) {
    throw new Error('a held YouTube upload record requires status held-private and a video id');
  }
  const { id, entry } = manifestEntryForQueueItem(manifest, queueItem);
  const videoId = String(queueItem.videoId || queueItem.youtube_video_id).trim();
  const existingVideoId = String(entry.youtube_video_id || '').trim();
  if (existingVideoId && existingVideoId !== videoId) {
    throw new Error(
      `approval manifest item ${id} already points to a different YouTube video (${existingVideoId})`,
    );
  }
  entry.youtube_video_id = videoId;
  entry.youtube_url =
    String(queueItem.youtube_url || '').trim() ||
    youtubeUrlFor(videoId, youtubeFormatFor(queueItem.youtube_format ? queueItem : entry));
  entry.youtube_channel = String(queueItem.channel || entry.youtube_channel || '').trim();
  entry.youtube_hold = String(queueItem.youtube_hold || 'pending');
  entry.youtube_hold_detail = queueItem.youtube_hold_detail || null;
  entry.youtube_privacy = String(queueItem.youtube_privacy || 'unknown');
  entry.youtube_held_sha256 = queueItem.held_video_sha256 || entry.youtube_held_sha256 || null;
  entry.synthetic_disclosure = String(queueItem.synthetic_disclosure || 'pending');
  entry.youtube_held_at = String(queueItem.held_at || entry.youtube_held_at || now.toISOString());
  entry.youtube_hold_recorded_at = now.toISOString();
  syncSyntheticDisclosureOntoManifestRow(entry, queueItem);
  return { manifest, entry, id, videoId };
}

function restoreQueuePublicationFromManifest(manifest, queueItem) {
  if (!manifest || !Array.isArray(manifest.videos) || !queueItem?.id) return false;
  const entry = manifest.videos.find(
    (video) => video && String(video.id || '') === String(queueItem.id),
  );
  const videoId = String(entry?.youtube_video_id || '').trim();
  if (!videoId) return false;
  if (String(entry?.status || '').toLowerCase() !== 'posted') {
    // A held row whose queue receipt was lost (persist failed after the
    // insert) comes back as held-private from the manifest, never as a
    // fresh upload.
    if (!entry.youtube_hold) return false;
    // Monotonic (Codex 6627b57dbccb F4): a queue row that already carries a
    // posted receipt finishes its settlement, and a queue hold recorded
    // after the manifest's stays; a stale manifest hold downgrades neither.
    if (isPersistedYouTubePublication(queueItem)) return false;
    if (
      isHeldPrivateYouTubeUpload(queueItem) &&
      String(queueItem.hold_updated_at || '') > String(entry.youtube_hold_recorded_at || '')
    ) {
      return false;
    }
    const recordedAt = Date.parse(String(entry.youtube_hold_recorded_at || ''));
    holdQueueItemPrivate(queueItem, {
      videoId,
      url: entry.youtube_url,
      videoSha256: entry.youtube_held_sha256,
      disclosure: entry.synthetic_disclosure || 'pending',
      hold: entry.youtube_hold,
      privacy: entry.youtube_privacy || 'unknown',
      detail: entry.youtube_hold_detail,
      now: Number.isFinite(recordedAt) ? new Date(recordedAt) : new Date(),
    });
    queueItem.held_at = String(entry.youtube_held_at || queueItem.held_at || '').trim() || queueItem.held_at;
    queueItem.channel = String(entry.youtube_channel || queueItem.channel || '').trim();
    // The disclosure rides the restore (Codex 417e524804ab F1): a held row
    // rebuilt from the manifest is synthetic media by construction, so the
    // resume declares the label again instead of taking the public path.
    syncSyntheticDisclosureOntoQueueItem(queueItem, entry);
    return true;
  }
  queueItem.status = 'posted';
  queueItem.videoId = videoId;
  queueItem.youtube_url =
    String(entry.youtube_url || '').trim() ||
    youtubeUrlFor(videoId, youtubeFormatFor(queueItem.youtube_format ? queueItem : entry));
  queueItem.channel = String(entry.youtube_channel || queueItem.channel || '').trim();
  queueItem.posted_at = String(entry.posted_at || queueItem.posted_at || '').trim();
  return true;
}

// The X poster reads the manifest row only, so an AI-presenter flag or label
// known only to the build sidecar is copied onto the row before X launches;
// each field on its own (Codex 6627b57dbccb F6: a row that already carried the
// flag kept no label, so X posted the generic line). True when the row changed.
function syncSyntheticDisclosureOntoManifestRow(row, receipt = {}) {
  if (!row || !receipt || receipt.synthetic_media !== true) return false;
  let changed = false;
  if (row.synthetic_media !== true) {
    row.synthetic_media = true;
    changed = true;
  }
  const label = String(receipt.synthetic_media_label || '').trim();
  if (label && !String(row.synthetic_media_label || '').trim()) {
    row.synthetic_media_label = label;
    changed = true;
  }
  return changed;
}

// The queue row takes the AI-presenter flag and label from the first source
// that declares the flag (the ingress body, the manifest row, the build
// sidecar), each field on its own (Codex 417e524804ab F3: ingress trusted
// only the caller's flag, and older persisted rows had none). True when the
// row changed. A label without the flag is nothing.
function syncSyntheticDisclosureOntoQueueItem(queueItem, ...sources) {
  if (!queueItem || typeof queueItem !== 'object') return false;
  const found = sources.filter((source) => source && typeof source === 'object');
  if (!found.some((source) => source.synthetic_media === true)) return false;
  let changed = false;
  if (queueItem.synthetic_media !== true) {
    queueItem.synthetic_media = true;
    changed = true;
  }
  if (!String(queueItem.synthetic_media_label || '').trim()) {
    const label = found.map((source) => String(source.synthetic_media_label || '').trim()).find(Boolean);
    if (label) {
      queueItem.synthetic_media_label = label;
      changed = true;
    }
  }
  return changed;
}

// The POST /youtube/queue body both stale-upload pushers send (Codex
// 417e524804ab F3): the text-fit proof and the AI-presenter flag and label
// ride along, so the server never has to guess them from an older row.
function queueIngressPayload(
  item,
  { remoteVideo, remoteTextFitReceipt, remoteThumb = undefined, textFitGate, defaultChannel = DEFAULT_UPLOAD_CHANNEL } = {},
) {
  if (!item || !item.id) throw new Error('queue ingress payload needs the item id');
  if (!remoteVideo || !remoteTextFitReceipt) {
    throw new Error(`queue ingress payload for ${item.id} needs the remote video and receipt paths`);
  }
  if (!textFitGate || textFitGate.ok !== true || !textFitGate.videoSha256 || !textFitGate.receiptSha256) {
    throw new Error(`queue ingress payload for ${item.id} needs a passing text-fit gate`);
  }
  const label = String(item.synthetic_media_label || '').trim();
  return {
    id: item.id,
    title: item.title,
    channel: item.channel || defaultChannel,
    description: item.description || '',
    tags: item.tags || [],
    videoPath: remoteVideo,
    textFitReceiptPath: remoteTextFitReceipt,
    videoSha256: textFitGate.videoSha256,
    textFitReceiptSha256: textFitGate.receiptSha256,
    thumbnailPath: remoteThumb,
    ...(isSyntheticMedia(item) ? { synthetic_media: true, ...(label ? { synthetic_media_label: label } : {}) } : {}),
  };
}

// A manifest row that holds a video private: a video id with a hold and no
// posted status. That row is the durable held identity (Codex 417e524804ab
// F6, F7): when its queue row is gone (a failed persist, a reset queue file)
// it is rebuilt here so no acceptance boundary (queue ingress, approval,
// the manual resume) can treat the id as a fresh upload.
function manifestEntryHoldsVideo(entry = {}) {
  return Boolean(
    entry &&
      String(entry.youtube_video_id || '').trim() &&
      entry.youtube_hold &&
      String(entry.status || '').toLowerCase() !== 'posted',
  );
}

function reconstructHeldQueueItem(entry) {
  if (!manifestEntryHoldsVideo(entry)) return null;
  const now = new Date().toISOString();
  const item = {
    id: String(entry.id),
    title: String(entry.title || entry.id),
    description: String(entry.description || ''),
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    ...(youtubeFormatFor(entry) === LONGFORM ? { youtube_format: LONGFORM } : {}),
    channel: String(entry.youtube_channel || '').trim() || targetUploadChannel(entry),
    // No local file: a held row never uploads again, it resumes on its id.
    videoPath: null,
    thumbnailPath: null,
    textFitReceiptPath: null,
    videoSha256: entry.youtube_held_sha256 || null,
    textFitReceiptSha256: null,
    approved_at: entry.approved_at || null,
    queued_at: String(entry.youtube_held_at || '').trim() || now,
    status: 'queued',
    reconstructed_from_manifest_at: now,
  };
  restoreQueuePublicationFromManifest({ videos: [entry] }, item);
  return item;
}

// Puts the manifest's hold onto the queue: an existing row for the id is
// restored to the hold (a queued re-push becomes held-private; a newer
// queue hold stays), a missing row is rebuilt. `changed` is true only when
// the queue differs afterwards, so callers persist only then.
function ensureHeldQueueRowFromManifest(queue, entry) {
  if (!Array.isArray(queue) || !manifestEntryHoldsVideo(entry)) {
    return { changed: false, index: -1, item: null, reconstructed: false };
  }
  const index = queue.findIndex((queued) => queued && String(queued.id || '') === String(entry.id));
  if (index >= 0) {
    const before = JSON.stringify(queue[index]);
    restoreQueuePublicationFromManifest({ videos: [entry] }, queue[index]);
    return { changed: JSON.stringify(queue[index]) !== before, index, item: queue[index], reconstructed: false };
  }
  const item = reconstructHeldQueueItem(entry);
  queue.push(item);
  return { changed: true, index: queue.length - 1, item, reconstructed: true };
}

function writeManifestAtomically(manifestPath, manifest, tag, fsImpl) {
  const tempPath = path.join(
    path.dirname(manifestPath),
    `.${path.basename(manifestPath)}.${tag}-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    fsImpl.writeFileSync(tempPath, JSON.stringify(manifest, null, 2));
    fsImpl.renameSync(tempPath, manifestPath);
  } finally {
    try {
      if (fsImpl.existsSync(tempPath)) fsImpl.unlinkSync(tempPath);
    } catch {}
  }
}

function recordSuccessfulYouTubePublication({
  manifestPath,
  queueItem,
  now = new Date(),
  fsImpl = fs,
} = {}) {
  if (!manifestPath) throw new Error('approval manifest path is required');
  const manifest = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
  const applied = applySuccessfulYouTubePublication(manifest, queueItem, { now });
  writeManifestAtomically(manifestPath, manifest, 'youtube-posted', fsImpl);
  return { changed: true, id: applied.id, videoId: applied.videoId };
}

function recordHeldYouTubeUpload({ manifestPath, queueItem, now = new Date(), fsImpl = fs } = {}) {
  if (!manifestPath) throw new Error('approval manifest path is required');
  const manifest = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
  const applied = applyHeldYouTubeUpload(manifest, queueItem, { now });
  writeManifestAtomically(manifestPath, manifest, 'youtube-held', fsImpl);
  return { changed: true, id: applied.id, videoId: applied.videoId, hold: applied.entry.youtube_hold };
}

// A held video publishes only for a manifest row that is approved right now
// and not deleted (Codex 1e96b5fc94a6 R1). The held identity is kept for a
// rejected or deleted row (its video id is never uploaded again); only the
// publish is refused. Tests pass `deleted` or a `tombstones` Set; the server
// lets the delete ledger decide.
function heldResumeProblem(entry, { deleted, tombstones, ledgerFile } = {}) {
  if (!entry || !entry.id) return 'held upload has no row on the approval manifest';
  const id = String(entry.id);
  const status = String(entry.status || '').trim() || 'missing';
  const isDeleted = typeof deleted === 'boolean' ? deleted : isVideoDeleted(entry, { tombstones, ledgerFile });
  if (isDeleted) {
    return `${id} is deleted (${status === 'deleted' ? 'status deleted' : 'tombstoned or regen-suppressed on the approval manifest'})`;
  }
  if (status !== 'approved') return `${id} is not currently approved (status ${status})`;
  return null;
}

// What a held log line may claim about the video's visibility: only what the
// recorded privacy proved (Codex 1e96b5fc94a6 R7).
function heldPrivacyWording(privacy) {
  const value = String(privacy || '').trim().toLowerCase();
  if (value === 'private') return 'private on YouTube';
  if (value === 'public') return 'PUBLIC on YouTube (privacy public)';
  return `visibility unproven on YouTube (privacy ${value || 'unknown'})`;
}

// The uploader's own item takes its id's place on the queue before a receipt
// is persisted (Codex 1e96b5fc94a6 R2): if a refresh detached the object the
// upload holds, or dropped it, the accepted video id still reaches the
// persisted queue instead of living only on a detached object.
function bindQueueRowForReceipt(queue, item) {
  if (!Array.isArray(queue)) throw new Error('YouTube upload queue must be an array');
  if (!item || !item.id) throw new Error('YouTube upload queue item id is required');
  const index = queue.findIndex((queued) => queued && queued.id === item.id);
  if (index < 0) {
    queue.push(item);
    return { index: queue.length - 1, rebound: true, restored: true };
  }
  if (queue[index] === item) return { index, rebound: false, restored: false };
  queue[index] = item;
  return { index, rebound: true, restored: false };
}

module.exports = {
  DEFAULT_UPLOAD_CHANNEL,
  LONGFORM,
  LONGFORM_MIN_WIDTH,
  longformDimensionProblem,
  longformUploadMetadata,
  stripShortsMarkers,
  youtubeFormatFor,
  youtubeUrlFor,
  UPLOAD_CHANNEL_ALIASES,
  isSyntheticMedia,
  syntheticDisclosureOutcome,
  youtubeUploadStatus,
  publishSyntheticUpload,
  provenPrivacy,
  HELD_PRIVATE_STATUS,
  isHeldPrivateYouTubeUpload,
  holdQueueItemPrivate,
  heldUploadBytesProblem,
  applyHeldYouTubeUpload,
  recordHeldYouTubeUpload,
  applySuccessfulYouTubePublication,
  buildApprovedUploadQueueItem,
  isPersistedYouTubePublication,
  recordSuccessfulYouTubePublication,
  restoreQueuePublicationFromManifest,
  syncSyntheticDisclosureOntoManifestRow,
  syncSyntheticDisclosureOntoQueueItem,
  queueIngressPayload,
  manifestEntryHoldsVideo,
  reconstructHeldQueueItem,
  ensureHeldQueueRowFromManifest,
  targetUploadChannel,
  upsertApprovedUploadQueueItem,
  heldResumeProblem,
  heldPrivacyWording,
  bindQueueRowForReceipt,
};
