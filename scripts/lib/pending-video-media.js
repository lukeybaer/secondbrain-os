'use strict';

const path = require('node:path');

function resolvePendingMediaPath(video, kind = 'video', opts = {}) {
  if (!video || !video.id) throw new Error('media resolution requires a video id');
  if (!['video', 'thumbnail'].includes(kind)) {
    throw new Error(`unsupported pending media kind: ${kind}`);
  }
  const declared = kind === 'video' ? video.video_file : video.thumbnail_file;
  const fallback = kind === 'video' ? `${video.id}.mp4` : `${video.id}_thumb.jpg`;
  const filename = String(declared || fallback).trim();
  if (!filename || path.basename(filename) !== filename) {
    throw new Error(`unsafe manifest ${kind}_file for ${video.id}: ${filename || '(empty)'}`);
  }
  const repoRoot = opts.repoRoot || path.resolve(__dirname, '..', '..');
  const pendingDir = opts.pendingDir || path.join(repoRoot, 'content-review', 'pending');
  return path.join(pendingDir, filename);
}

module.exports = { resolvePendingMediaPath };
