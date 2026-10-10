const fs = require('fs');
const path = require('path');

const DEFAULT_UPLOAD_CHANNEL = 'Examplechannel';
const UPLOAD_CHANNEL_ALIASES = Object.freeze({ Storiesniche: 'ExampleNiche' });

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

  return {
    id: String(manifestEntry.id),
    title: String(manifestEntry.title || sidecar.title || manifestEntry.id),
    description: String(sidecar.description || manifestEntry.description || ''),
    tags: Array.isArray(sidecar.tags)
      ? sidecar.tags
      : Array.isArray(manifestEntry.tags)
        ? manifestEntry.tags
        : [],
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
    queue[index] = { ...queue[index], ...item, status: 'queued' };
    return { deduped: true, index, item: queue[index] };
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
    `https://youtube.com/shorts/${videoId}`;
  entry.youtube_channel = String(queueItem.channel || entry.youtube_channel || '').trim();
  entry.posted_at = String(queueItem.posted_at || entry.posted_at || now.toISOString());
  entry.publication_recorded_at = now.toISOString();
  return { manifest, entry, id, videoId };
}

function restoreQueuePublicationFromManifest(manifest, queueItem) {
  if (!manifest || !Array.isArray(manifest.videos) || !queueItem?.id) return false;
  const entry = manifest.videos.find(
    (video) => video && String(video.id || '') === String(queueItem.id),
  );
  const videoId = String(entry?.youtube_video_id || '').trim();
  if (String(entry?.status || '').toLowerCase() !== 'posted' || !videoId) return false;
  queueItem.status = 'posted';
  queueItem.videoId = videoId;
  queueItem.youtube_url =
    String(entry.youtube_url || '').trim() || `https://youtube.com/shorts/${videoId}`;
  queueItem.channel = String(entry.youtube_channel || queueItem.channel || '').trim();
  queueItem.posted_at = String(entry.posted_at || queueItem.posted_at || '').trim();
  return true;
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
  const tempPath = path.join(
    path.dirname(manifestPath),
    `.${path.basename(manifestPath)}.youtube-posted-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    fsImpl.writeFileSync(tempPath, JSON.stringify(manifest, null, 2));
    fsImpl.renameSync(tempPath, manifestPath);
  } finally {
    try {
      if (fsImpl.existsSync(tempPath)) fsImpl.unlinkSync(tempPath);
    } catch {}
  }
  return { changed: true, id: applied.id, videoId: applied.videoId };
}

module.exports = {
  DEFAULT_UPLOAD_CHANNEL,
  UPLOAD_CHANNEL_ALIASES,
  applySuccessfulYouTubePublication,
  buildApprovedUploadQueueItem,
  isPersistedYouTubePublication,
  recordSuccessfulYouTubePublication,
  restoreQueuePublicationFromManifest,
  targetUploadChannel,
  upsertApprovedUploadQueueItem,
};
