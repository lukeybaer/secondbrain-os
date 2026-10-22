'use strict';
// Decoded-frame proof that an accent or cutaway picture is actually in the
// final video (Codex ec2-deploy review dae2270ae8ee, high: a receipt that only
// proves an HD file exists lets a build keep a hand-drawn rocket while naming
// an unused photo).
//
// For each cue, decode the final MP4 at the middle of the cue and the named
// picture (or footage frames), reduce both to a small grayscale grid, and
// require a strong Pearson correlation outside the caption band and the
// logo corner, both on brightness and on fine detail (each pixel minus its
// 3x3 neighborhood mean). Brightness alone lets a drawn glow match a dark
// photo with a bright center; the detail term needs the real texture.

const { spawnSync } = require('child_process');

const GRID_W = 72;
const GRID_H = 128;
// Rows outside the comparison: logo and attribution at the top, captions low.
const MASK_ROWS = [[0, 18], [76, 102]];
// Calibrated 2026-10-20 on real frames (see accent-frame-proof.test.js): the
// same photo or footage pushed, graded, wrapped and captioned scores well above
// this; the hand-drawn rocket, atom and gear accents, the speaker and the
// drawn cutaway cards score below it against any of the candidate photos.
// Measured: real photo cue 0.66, real footage cue 0.84; drawn rocket, atom,
// gear, speaker and drawn cards at most 0.06 against the same pictures.
const MATCH_THRESHOLD = 0.4;
// The final frame is compared both as the full canvas and as the approved
// mobile-safe wrapper (990x1760 at 45,160), and the media at a few push levels.
const FINAL_CROPS = ['iw:ih:0:0', '990:1760:45:160'];
const MEDIA_ZOOMS = [1, 1.04, 1.08];

// Long-form landscape profile (owner decision 2026-10-22: three-minute
// podcast highlights are regular 16:9 videos, not Shorts). Same proof, a 128x72 grid,
// the logo band and the low caption band masked, the full canvas only.
const PROFILES = {
  portrait: { gridW: GRID_W, gridH: GRID_H, maskRows: MASK_ROWS, finalCrops: FINAL_CROPS },
  landscape: { gridW: 128, gridH: 72, maskRows: [[0, 10], [54, 68]], finalCrops: ['iw:ih:0:0'] },
};

function profileFor(orientation) {
  const profile = PROFILES[orientation || 'portrait'];
  if (!profile) throw new Error(`unknown frame-proof orientation ${orientation}`);
  return profile;
}

function grayGrid(file, { seekSeconds = 0, crop = null, zoom = 1, orientation, spawnSyncImpl = spawnSync, ffmpeg = 'ffmpeg' } = {}) {
  const { gridW, gridH } = profileFor(orientation);
  const filters = [];
  if (crop) filters.push(`crop=${crop}`);
  const w = Math.round(gridW * zoom);
  const h = Math.round(gridH * zoom);
  filters.push(`scale=${w}:${h}:force_original_aspect_ratio=increase:flags=area`, `crop=${gridW}:${gridH}`, 'format=gray');
  const args = ['-v', 'error'];
  if (seekSeconds > 0) args.push('-ss', String(seekSeconds));
  args.push('-i', file, '-frames:v', '1', '-vf', filters.join(','), '-f', 'rawvideo', '-');
  const result = spawnSyncImpl(ffmpeg, args, { maxBuffer: 1 << 20, timeout: 60000 });
  if (!result || result.status !== 0 || !result.stdout || result.stdout.length !== gridW * gridH) {
    throw new Error(`could not decode a frame from ${file} at ${seekSeconds}s`);
  }
  return result.stdout;
}

function masked(index, profile = PROFILES.portrait) {
  const row = Math.floor(index / profile.gridW);
  return profile.maskRows.some(([a, b]) => row >= a && row < b);
}

function highPass(g, profile = PROFILES.portrait) {
  const GRID_W = profile.gridW;
  const GRID_H = profile.gridH;
  const out = new Float64Array(g.length);
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= GRID_H || xx < 0 || xx >= GRID_W) continue;
          sum += g[yy * GRID_W + xx]; n++;
        }
      }
      out[y * GRID_W + x] = g[y * GRID_W + x] - sum / n;
    }
  }
  return out;
}

// The weaker of the brightness and fine-detail correlations.
function similarity(a, b, orientation) {
  const profile = profileFor(orientation);
  return Math.min(correlation(a, b, orientation), correlation(highPass(a, profile), highPass(b, profile), orientation));
}

function correlation(a, b, orientation) {
  const profile = profileFor(orientation);
  let n = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { if (masked(i, profile)) continue; n++; sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) {
    if (masked(i, profile)) continue;
    const da = a[i] - ma, db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  if (va === 0 || vb === 0) return 0;
  return cov / Math.sqrt(va * vb);
}

// Points inside the cue that must each show the media. The first and last
// 20 percent are left for the cut in and out (Codex deploy review
// 6015ce693c88: one midpoint frame let a clip show the picture for a single
// frame and a drawing for the rest of the accent).
const SAMPLE_FRACTIONS = [0.2, 0.5, 0.8];

// Weakest match across the cue's sample points; at each point, the best
// match over final crops, media push levels and (footage) nearby offsets.
// `media.start_seconds` (footage only) is where the clip's piece starts.
function cueMatchScore({ videoPath, atSeconds, durationSeconds, mediaFile, mediaKind, mediaStartSeconds = 0, orientation = 'portrait', grid = grayGrid }) {
  const { finalCrops } = profileFor(orientation);
  const footage = mediaKind === 'video' || mediaKind === 'source_footage';
  const mediaCache = new Map();
  const mediaGrid = (offset, zoom) => {
    const key = `${offset}|${zoom}`;
    if (!mediaCache.has(key)) {
      let m = null;
      try { m = grid(mediaFile, { seekSeconds: offset, zoom, orientation }); } catch { /* try the next */ }
      mediaCache.set(key, m);
    }
    return mediaCache.get(key);
  };
  let worst = Infinity;
  for (const fraction of SAMPLE_FRACTIONS) {
    const t = atSeconds + durationSeconds * fraction;
    const finals = [];
    for (const crop of finalCrops) {
      try { finals.push(grid(videoPath, { seekSeconds: t, crop, orientation })); } catch { /* crop may not fit */ }
    }
    if (!finals.length) throw new Error(`could not decode the final video at ${t.toFixed(2)}s`);
    const offsets = footage
      ? [-0.15, 0, 0.15].map((d) => Math.max(0, mediaStartSeconds + durationSeconds * fraction + d))
      : [0];
    let best = -1;
    let decoded = false;
    for (const offset of offsets) {
      for (const zoom of MEDIA_ZOOMS) {
        const m = mediaGrid(offset, zoom);
        if (!m) continue;
        decoded = true;
        for (const f of finals) best = Math.max(best, similarity(f, m, orientation));
      }
    }
    if (!decoded) throw new Error(`could not decode the media ${mediaFile}`);
    worst = Math.min(worst, best);
  }
  return worst;
}

module.exports = {
  GRID_W,
  GRID_H,
  MATCH_THRESHOLD,
  SAMPLE_FRACTIONS,
  PROFILES,
  profileFor,
  grayGrid,
  correlation,
  similarity,
  cueMatchScore,
};
