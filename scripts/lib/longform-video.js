'use strict';
// Long-form highlights films (owner decision 2026-10-22): each new full
// podcast episode on the watched channel gets a three-minute highlights film,
// long format, not a Short.
//
// A long-form proposal carries `format: "longform"`. Its final must be a
// landscape film of about three minutes; its effects receipt is the long-form
// profile (clip-effects-receipt.js FORMATS.longform); its manifest row carries
// `youtube_format: "longform"` so the uploader sends a regular video, never a
// Short (youtube-approved-upload-handoff.js).

const { spawnSync } = require('child_process');

const LONGFORM = 'longform';
// Three minutes, with the 2:45 to 3:15 band the owner's brief allows plus a little
// room for the title and end cards.
const LONGFORM_SECONDS = { target: 180, min: 150, max: 210 };
const LONGFORM_FRAME = { width: 1920, height: 1080 };

function isLongformProposal(proposal) {
  const value = String((proposal && (proposal.format || proposal.youtube_format)) || '').trim().toLowerCase();
  return value === LONGFORM;
}

// { width, height, seconds } of the first video stream and the container.
function ffprobeVideo(file, { spawnSyncImpl = spawnSync, ffprobe = 'ffprobe' } = {}) {
  const r = spawnSyncImpl(
    ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file],
    { encoding: 'utf8', timeout: 60000 },
  );
  if (!r || r.status !== 0) throw new Error('ffprobe could not read the final video');
  const parsed = JSON.parse(String(r.stdout || '{}'));
  const stream = (parsed.streams || [])[0] || {};
  return {
    width: Number(stream.width),
    height: Number(stream.height),
    seconds: Number(parsed.format && parsed.format.duration),
  };
}

// A problem string, or null when the final is a 1920x1080 film of 150 to
// 210 seconds. Fails closed when the probe fails.
function longformFinalProblem(file, { probeVideo = ffprobeVideo } = {}) {
  let v;
  try {
    v = probeVideo(file);
  } catch (err) {
    return `long-form final could not be probed: ${err.message}`;
  }
  if (!v || v.width !== LONGFORM_FRAME.width || v.height !== LONGFORM_FRAME.height) {
    return `long-form final must be ${LONGFORM_FRAME.width}x${LONGFORM_FRAME.height} landscape, got ${v && v.width}x${v && v.height}`;
  }
  if (!Number.isFinite(v.seconds) || v.seconds < LONGFORM_SECONDS.min || v.seconds > LONGFORM_SECONDS.max) {
    return `long-form final must run ${LONGFORM_SECONDS.min} to ${LONGFORM_SECONDS.max} s, got ${v.seconds}`;
  }
  return null;
}

module.exports = {
  LONGFORM,
  LONGFORM_SECONDS,
  LONGFORM_FRAME,
  isLongformProposal,
  ffprobeVideo,
  longformFinalProblem,
};
