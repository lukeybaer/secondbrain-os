'use strict';
// HD imagery for clip image accents and cutaways (v5 package).
//
// owner decision: "the animations are dumb - i really want them high def,
// visually beautiful, not cartoonish. Like one of them was like a dumb rocket
// that a 10 year old could have drawn with paint. that's lazy." Root cause: the
// model session hand-drew each accent as a few SVG paths (the 2026-10-20
// rocket was a gradient body, a circle window and two triangle fins). So an
// accent is now a real high-definition photograph or footage file, fetched
// with provenance (Pexels, free commercial license) or taken from the source,
// and the effects receipt hashes and probes that file. Keep the owner's approved
// timing and beat choices; only the picture quality changes.
//
// owner decision, later the same day: "no you can draw stuff, just not lame -
// like it should be beautiful, crisp, high def ... Like my Amy video on
// improving collatz saying bring a pencil, check our work, that was beautiful
// right?" So a designed picture is allowed again when it is a lit 3D render
// from the accent-3d template (real geometry, materials, light, depth, camera
// move), traced to its scene source by a render receipt. Beauty itself is not
// machine-checked: pixel metrics could not separate the Collatz frames from
// the flat drawings. The template, the art direction and the owner's review are
// what hold the bar; this check only proves the picture came from that rig.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// Kinds of picture an accent may use. Flat drawn shapes, clip art, emoji,
// icons and SVG illustrations are not on the list; `designed` is a lit 3D
// render from templates/accent-3d with its render receipt.
const ACCENT_MEDIA_KINDS = ['photo', 'video', 'source_footage', 'designed'];
// Cutaways may also flip to a real screen capture or a DOM-rendered data chart
// or headline (crisp HTML type at 2x, not a drawing).
const CUTAWAY_MEDIA_KINDS = [...ACCENT_MEDIA_KINDS, 'screen_capture', 'data_chart', 'headline'];
// Kinds rendered as HTML in the film. They still name a PNG still of the
// rendered screen so the decoded-frame proof has something to match.
const DOM_RENDERED_KINDS = ['data_chart', 'headline'];
// Media that needs a provider and license (not from the clip's own source).
const LICENSED_KINDS = ['photo', 'video'];
// The lit stage every designed render must come from.
const STAGE_FILE = path.join(__dirname, '..', '..', 'skills', 'work', 'video-production', 'templates', 'accent-3d', 'stage.html');
const RENDER_SCHEMA = 'accent-3d-render@1';
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.m4v'];
const BANNED_EXTENSIONS = ['.svg', '.gif', '.ico', '.emf', '.wmf'];
// The 9:16 cover crop of the picture must hold at least a 1080x1920 frame, so
// nothing is enlarged on the delivery canvas.
const MIN_COVER_WIDTH = 1080;
const PORTRAIT = 9 / 16;
// Long-form landscape (owner decision, Moonshots highlights are regular 16:9
// videos): the 16:9 cover crop must hold a full 1920x1080 frame.
const ORIENTATIONS = {
  portrait: { ratio: PORTRAIT, minWidth: MIN_COVER_WIDTH, label: '9:16' },
  landscape: { ratio: 16 / 9, minWidth: 1920, label: '16:9' },
};

function orientationSpec(orientation) {
  const spec = ORIENTATIONS[orientation || 'portrait'];
  if (!spec) throw new Error(`unknown media orientation ${orientation}`);
  return spec;
}

const PEXELS_PAGE = /^https:\/\/www\.pexels\.com\/(photo|video)\/(?:[a-z0-9-]*-)?(\d+)\/?$/;

// Width of the largest 9:16 (or, landscape, 16:9) frame a picture of this
// size can fill.
function coverCropWidth(width, height, orientation) {
  const { ratio } = orientationSpec(orientation);
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 0;
  return Math.floor(Math.min(w, h * ratio));
}

function meetsHd(width, height, orientation) {
  return coverCropWidth(width, height, orientation) >= orientationSpec(orientation).minWidth;
}

// Best Pexels photo: the first result (relevance order) that fills a 9:16
// frame at full resolution.
function pickPexelsPhotos(payload, count = 3, orientation) {
  const photos = (payload && Array.isArray(payload.photos)) ? payload.photos : [];
  return photos
    .filter((p) => p && p.src && p.src.original && meetsHd(p.width, p.height, orientation))
    .slice(0, count)
    .map((p) => ({
      kind: 'photo',
      provider: 'pexels',
      provider_id: String(p.id),
      page_url: p.url,
      credit: p.photographer || null,
      download_url: p.src.original,
      width: p.width,
      height: p.height,
      license: 'Pexels License (free commercial use, no attribution required)',
    }));
}

// Best Pexels video file per result: the smallest file that still fills a
// 9:16 frame at full resolution (4K is wasted bytes for a 0.7 s accent).
function pickPexelsVideos(payload, count = 3, orientation) {
  const videos = (payload && Array.isArray(payload.videos)) ? payload.videos : [];
  const picks = [];
  for (const v of videos) {
    const files = (Array.isArray(v && v.video_files) ? v.video_files : [])
      .filter((f) => f && f.link && /mp4/i.test(String(f.file_type || f.link)) && meetsHd(f.width, f.height, orientation))
      .sort((a, b) => coverCropWidth(a.width, a.height, orientation) - coverCropWidth(b.width, b.height, orientation));
    if (!files.length) continue;
    const f = files[0];
    picks.push({
      kind: 'video',
      provider: 'pexels',
      provider_id: String(v.id),
      page_url: v.url,
      credit: (v.user && v.user.name) || null,
      download_url: f.link,
      width: f.width,
      height: f.height,
      duration_seconds: v.duration,
      license: 'Pexels License (free commercial use, no attribution required)',
    });
    if (picks.length >= count) break;
  }
  return picks;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Pixel size of an image or video file via ffprobe. Throws on failure.
function ffprobeDimensions(file, { spawnSyncImpl = spawnSync, ffprobe = 'ffprobe' } = {}) {
  const result = spawnSyncImpl(
    ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file],
    { encoding: 'utf8', timeout: 60000 },
  );
  if (!result || result.status !== 0) throw new Error('ffprobe could not read the media');
  const stream = (JSON.parse(String(result.stdout || '{}')).streams || [])[0] || {};
  const width = Number(stream.width);
  const height = Number(stream.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error('ffprobe reported no picture size');
  return { width, height };
}

// How the decoded-frame proof treats a cue's media: a designed render is
// footage when it is the MP4, a still when it is the PNG.
function frameKindFor(media) {
  const kind = String((media && media.kind) || '');
  if (DOM_RENDERED_KINDS.includes(kind)) return 'photo';
  if (kind === 'designed') return VIDEO_EXTENSIONS.includes(path.extname(String(media.file || '')).toLowerCase()) ? 'video' : 'photo';
  return kind;
}

// A designed picture must be the render.js output of a scene on the lit
// stage: the receipt binds these bytes, the scene source and the stage.
function checkDesignedRender(media, sha, { label, baseDir, stageFile = STAGE_FILE, hashFile = sha256File, orientation }) {
  if (typeof media.render_receipt !== 'string' || !media.render_receipt.trim()) {
    return `${label}.media.render_receipt must name the <scene>.render.json that templates/accent-3d/render.js wrote`;
  }
  const file = path.isAbsolute(media.render_receipt) ? media.render_receipt : path.resolve(baseDir || '.', media.render_receipt);
  const r = readJson(file);
  if (!r) return `${label}.media.render_receipt not readable: ${file}`;
  if (r.schema !== RENDER_SCHEMA) return `${label}.media.render_receipt is not an ${RENDER_SCHEMA} receipt`;
  if (![r.video_sha256, r.still_sha256].map((x) => String(x || '').toLowerCase()).includes(sha)) {
    return `${label}.media is not the video or still that render receipt recorded`;
  }
  const { ratio, minWidth } = orientationSpec(orientation);
  const minH = Math.round(minWidth / ratio);
  if (!(Number(r.width) >= minWidth && Number(r.height) >= minH)) {
    return `${label}.media was rendered at ${r.width}x${r.height}, under ${minWidth}x${minH}`;
  }
  const src = String(r.source_file || '');
  if (!src || !fs.existsSync(src)) return `${label}.media render receipt's scene source is missing: ${src || '(none)'}`;
  if (hashFile(src) !== String(r.source_sha256 || '').toLowerCase()) return `${label}.media scene source changed since the render`;
  if (!fs.existsSync(stageFile) || hashFile(stageFile) !== String(r.stage_sha256 || '').toLowerCase()) {
    return `${label}.media was not rendered on the current lit stage (templates/accent-3d/stage.html)`;
  }
  return null;
}

function resolveMediaFile(media, baseDir) {
  return path.isAbsolute(media.file) ? media.file : path.resolve(baseDir || '.', media.file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

// Codex review dae2270ae8ee (high): provenance must be checked, not asserted.
// A licensed picture carries the sidecar fetch-accent-media.js wrote, bound to
// the same bytes and the same Pexels record; source footage points at the
// succeeded acquisition receipt for those exact bytes.
// `sourceAcquisitions` is the promotion's validated --source-receipts list
// ({ path, sha256 }); a receipt the build session wrote by hand is not on it.
function checkProvenance(media, file, sha, { label, kind, baseDir, sourceAcquisitions, stageFile, hashFile, orientation }) {
  if (kind === 'designed') return checkDesignedRender(media, sha, { label, baseDir, stageFile, hashFile, orientation });
  if (LICENSED_KINDS.includes(kind)) {
    if (media.provider !== 'pexels') return `${label}.media.provider must be pexels (fetched with scripts/fetch-accent-media.js)`;
    const side = readJson(`${file}.provenance.json`);
    if (!side) return `${label}.media has no readable ${path.basename(file)}.provenance.json sidecar`;
    if (String(side.sha256 || '').toLowerCase() !== sha) return `${label}.media provenance sidecar is for different bytes`;
    const id = String(media.provider_id || '');
    if (!/^\d+$/.test(id) || String(side.provider_id) !== id) return `${label}.media.provider_id does not match its provenance sidecar`;
    const page = PEXELS_PAGE.exec(String(side.page_url || ''));
    if (!page || page[2] !== id || (page[1] === 'photo') !== (kind === 'photo')) {
      return `${label}.media provenance page_url is not the Pexels ${kind} page for ${id}`;
    }
    return null;
  }
  if (kind === 'source_footage') {
    if (typeof media.source_acquisition !== 'string' || !media.source_acquisition.trim()) {
      return `${label}.media.source_acquisition must name the source-acquisition.json receipt for this footage`;
    }
    const acq = path.resolve(path.isAbsolute(media.source_acquisition) ? media.source_acquisition : path.resolve(baseDir || '.', media.source_acquisition));
    if (!Array.isArray(sourceAcquisitions)) {
      return `${label}.media source footage needs the promotion's validated --source-receipts`;
    }
    const sanctioned = sourceAcquisitions.find((a) => a && path.resolve(String(a.path)).toLowerCase() === acq.toLowerCase());
    if (!sanctioned) return `${label}.media.source_acquisition is not one of this clip's validated --source-receipts`;
    if (String(sanctioned.sha256 || '').toLowerCase() !== sha) {
      return `${label}.media is not the footage that acquisition receipt recorded`;
    }
  }
  return null;
}

// Check one accent or cutaway `media` block against the file it names.
// `baseDir` resolves a relative `file`. Returns a problem string or null.
function checkMedia(media, { label, allowedKinds, baseDir, probeDimensions = ffprobeDimensions, hashFile = sha256File, sourceAcquisitions, stageFile, orientation } = {}) {
  const spec = orientationSpec(orientation);
  if (!media || typeof media !== 'object') {
    return `${label}.media is required: a real HD photo, footage file or lit 3D render (v5, owner decision: nothing cartoonish)`;
  }
  const kind = String(media.kind || '');
  if (!allowedKinds.includes(kind)) {
    return `${label}.media.kind must be one of ${allowedKinds.join('|')} (flat drawn shapes, clip art, icons and SVG illustrations are refused; a designed picture is a lit 3D render from templates/accent-3d)`;
  }
  if (LICENSED_KINDS.includes(kind) && (!media.provider || !media.license)) {
    return `${label}.media needs provider and license for a ${kind}`;
  }
  if (typeof media.file !== 'string' || !media.file.trim()) {
    return DOM_RENDERED_KINDS.includes(kind)
      ? `${label}.media.file must name a PNG still of the rendered ${kind}`
      : `${label}.media.file must name the media file`;
  }
  if (BANNED_EXTENSIONS.includes(path.extname(media.file).toLowerCase())) {
    return `${label}.media.file ${path.basename(media.file)} is a drawing or low-fidelity format`;
  }
  const file = resolveMediaFile(media, baseDir);
  if (!fs.existsSync(file)) return `${label}.media.file not found: ${file}`;
  if (!/^[0-9a-f]{64}$/i.test(String(media.sha256 || ''))) return `${label}.media.sha256 must be the file's sha256`;
  const sha = hashFile(file);
  if (sha !== String(media.sha256).toLowerCase()) return `${label}.media.sha256 does not match ${path.basename(file)}`;
  const provenance = checkProvenance(media, file, sha, { label, kind, baseDir, sourceAcquisitions, stageFile, hashFile, orientation });
  if (provenance) return provenance;
  let dims;
  try {
    dims = probeDimensions(file);
  } catch (err) {
    return `${label}.media could not be probed: ${err.message}`;
  }
  if (!meetsHd(dims.width, dims.height, orientation)) {
    return `${label}.media is ${dims.width}x${dims.height}; its ${spec.label} crop is ${coverCropWidth(dims.width, dims.height, orientation)} px wide, under ${spec.minWidth} (not high definition)`;
  }
  return null;
}

module.exports = {
  ACCENT_MEDIA_KINDS,
  CUTAWAY_MEDIA_KINDS,
  DOM_RENDERED_KINDS,
  MIN_COVER_WIDTH,
  ORIENTATIONS,
  STAGE_FILE,
  RENDER_SCHEMA,
  frameKindFor,
  checkDesignedRender,
  coverCropWidth,
  meetsHd,
  pickPexelsPhotos,
  pickPexelsVideos,
  sha256File,
  ffprobeDimensions,
  resolveMediaFile,
  checkProvenance,
  checkMedia,
};
