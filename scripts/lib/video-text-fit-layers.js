'use strict';

// Pixel-true text-fit measurement for ffmpeg-composited text layers.
//
// Each text layer (an ASS subtitle file) is rendered ALONE on a black delivery
// canvas, and the bounds of its lit pixels are the measured text bounds. This
// is the method build-viral-clip.js uses; it lives here so the daily Shorts
// builder (ec2-build-from-queue.py) produces the same SHA-bound receipt
// instead of never producing one (2026-09-28: every daily short sat in the
// approval queue with RECEIPT_MISSING).
//
// A whole layer is rendered in ONE ffmpeg pass and only the sampled frames
// are read back, streamed, so a 70 s timeline is not re-rendered per sample.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TEXT_FIT_VIEWPORT = Object.freeze({ width: 1080, height: 1920 });
const TEXT_FIT_SAFE_RECT = Object.freeze({
  left: 54,
  top: 54,
  right: 1026,
  bottom: 1866,
  width: 972,
  height: 1812,
});
const TEXT_FIT_FPS = 30;

function renderedPixelBounds(
  rgb,
  width = TEXT_FIT_VIEWPORT.width,
  height = TEXT_FIT_VIEWPORT.height,
) {
  const expected = width * height * 3;
  if (!Buffer.isBuffer(rgb) || rgb.length < expected) {
    throw new Error(
      `text-only render returned ${rgb ? rgb.length : 0} bytes; expected ${expected}`,
    );
  }
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let pixel = 0, offset = 0; pixel < width * height; pixel += 1, offset += 3) {
    if (rgb[offset] <= 8 && rgb[offset + 1] <= 8 && rgb[offset + 2] <= 8) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  if (right < left || bottom < top) return null;
  return {
    left,
    top,
    right: right + 1,
    bottom: bottom + 1,
    width: right - left + 1,
    height: bottom - top + 1,
  };
}

function safeAreaElement(id, text, rect) {
  return {
    id,
    text,
    rect,
    clippingAncestors: [
      {
        key: 'delivery-title-safe-area',
        rect: TEXT_FIT_SAFE_RECT,
        clientWidth: TEXT_FIT_SAFE_RECT.width,
        clientHeight: TEXT_FIT_SAFE_RECT.height,
        scrollWidth: TEXT_FIT_SAFE_RECT.width,
        scrollHeight: TEXT_FIT_SAFE_RECT.height,
        overflowX: 'hidden',
        overflowY: 'hidden',
      },
    ],
  };
}

function assTimeSeconds(value) {
  const match = String(value || '')
    .trim()
    .match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const fraction = Number(`0.${match[4] || '0'}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + fraction;
}

// Milliseconds after an event starts before its entrance motion settles:
// \move(x1,y1,x2,y2,t1,t2) ends at t2 (the whole event when omitted) and
// \fad(in,out) finishes fading in at `in`. Text that deliberately slides in
// from off-canvas is measured where it rests, never mid-entrance.
function entranceSettleMs(tags, durationMs) {
  let settle = 0;
  const move = tags.match(/\\move\(\s*[^,]+,[^,]+,[^,]+,[^,)]+(?:,\s*(-?\d+)\s*,\s*(-?\d+))?\s*\)/);
  if (move) settle = Math.max(settle, move[2] !== undefined ? Number(move[2]) : durationMs);
  const fad = tags.match(/\\fad\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (fad) settle = Math.max(settle, Number(fad[1]));
  return settle;
}

// Every \t transform boundary (ms from event start): \t(t1,t2[,accel],tags)
// peaks or settles at t1 and t2; a bare \t(tags) spans the whole event.
// Scale punches (for example \fscx150 then back to 100) hit their largest
// extent exactly at a boundary, so each boundary is measured (Codex deploy
// review 63c944b659a1).
function transformBoundariesMs(tags, durationMs) {
  const out = [];
  for (const match of tags.matchAll(/\\t\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    const timed = match[1].match(/^\s*(-?\d+)\s*,\s*(-?\d+)\s*,/);
    if (timed) {
      const t1 = Number(timed[1]);
      const t2 = Number(timed[2]);
      out.push(t1, t2, (t1 + t2) / 2);
    } else {
      out.push(0, durationMs);
    }
  }
  return out;
}

// Audience-readable text events of one ASS file with the times each is
// measured at, kept one frame inside the event: the later of its midpoint and
// its settled entrance, plus every transform boundary after the entrance
// settles. Vector drawings (\p1 boxes) are not text events; they still render
// in the layer, so their pixels count toward the bounds.
function assTextEvents(assPath) {
  if (!assPath || !fs.existsSync(assPath)) return [];
  const frame = 1 / TEXT_FIT_FPS;
  const events = [];
  for (const line of fs.readFileSync(assPath, 'utf8').split(/\r?\n/)) {
    if (!/^Dialogue:/i.test(line)) continue;
    const fields = line.replace(/^Dialogue:\s*/i, '').split(',');
    if (fields.length < 10) continue;
    const start = assTimeSeconds(fields[1]);
    const end = assTimeSeconds(fields[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const raw = fields.slice(9).join(',');
    const tags = (raw.match(/\{[^}]*\}/g) || []).join('');
    if (/\\p[1-9]/.test(tags)) continue;
    const text = raw
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nnh]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const durationMs = (end - start) * 1000;
    const settled = start + entranceSettleMs(tags, durationMs) / 1000;
    const clamp = (sec) => Math.max(start, Math.min(sec, end - frame));
    const times = new Set([clamp(Math.max(start + (end - start) / 2, settled + frame))]);
    for (const ms of transformBoundariesMs(tags, durationMs)) {
      const sec = start + ms / 1000;
      if (sec >= settled) times.add(clamp(Math.max(sec, start + frame)));
    }
    const sampleSecs = [...new Set([...times].map(frameIndex))]
      .sort((a, b) => a - b)
      .map((n) => n / TEXT_FIT_FPS);
    events.push({ start, end, atSec: sampleSecs[0], sampleSecs, text });
  }
  return events;
}

function ffmpegFilterPath(filePath) {
  return String(path.resolve(filePath))
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

function frameIndex(atSec) {
  return Math.max(0, Math.round(Number(atSec) * TEXT_FIT_FPS));
}

// ffmpeg's expression parser rejects a select list of a few hundred terms,
// so a layer is rendered in passes of this many sampled frames.
const SELECT_FRAMES_PER_PASS = 40;

// Render `filter` over a black canvas and return the lit-pixel bounds of each
// requested frame index. Each pass renders only its own time window (the
// canvas timestamps are shifted to the window start), so a whole layer costs
// about one timeline render. Streams frames so memory stays at one frame.
async function renderLayerFrameBounds(filter, frames, options = {}) {
  const wanted = [...new Set(frames)].sort((a, b) => a - b);
  const bounds = new Map();
  for (let i = 0; i < wanted.length; i += SELECT_FRAMES_PER_PASS) {
    const pass = await renderFramePass(filter, wanted.slice(i, i + SELECT_FRAMES_PER_PASS), options);
    for (const [frame, rect] of pass) bounds.set(frame, rect);
  }
  return bounds;
}

function renderFramePass(filter, wanted, { cwd, spawnFn = spawn } = {}) {
  if (!wanted.length) return Promise.resolve(new Map());
  const { width, height } = TEXT_FIT_VIEWPORT;
  const frameBytes = width * height * 3;
  const first = wanted[0];
  const durationSec = (wanted[wanted.length - 1] - first + 2) / TEXT_FIT_FPS;
  const select = wanted.map((n) => `eq(n\\,${n - first})`).join('+');
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${width}x${height}:d=${durationSec.toFixed(3)}:r=${TEXT_FIT_FPS}`,
    '-vf',
    `setpts=PTS+${first}/(${TEXT_FIT_FPS}*TB),${filter},select='${select}',format=rgb24`,
    '-fps_mode',
    'passthrough',
    '-f',
    'rawvideo',
    'pipe:1',
  ];
  return new Promise((resolve, reject) => {
    const child = spawnFn('ffmpeg', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const bounds = new Map();
    let pending = Buffer.alloc(0);
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        const index = bounds.size;
        if (index < wanted.length) {
          bounds.set(wanted[index], renderedPixelBounds(pending.subarray(0, frameBytes), width, height));
        }
        pending = pending.subarray(frameBytes);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg text-only layer render failed (${code}): ${stderr.trim()}`));
      } else if (bounds.size !== wanted.length) {
        reject(new Error(`text-only layer render returned ${bounds.size} of ${wanted.length} sampled frames`));
      } else {
        resolve(bounds);
      }
    });
  });
}

// Measure every text event of every ASS layer. Returns receipt samples with
// the first and last measured moments declared as the timeline extremes.
async function measureAssLayerSamples(assPaths, { renderFn = renderLayerFrameBounds } = {}) {
  const samples = [];
  for (const assPath of assPaths) {
    const layer = path.basename(assPath, path.extname(assPath));
    const events = assTextEvents(assPath);
    if (!events.length) continue;
    const bounds = await renderFn(
      `ass='${ffmpegFilterPath(assPath)}'`,
      events.flatMap((event) => event.sampleSecs.map(frameIndex)),
      { cwd: path.dirname(assPath) },
    );
    events.forEach((event, index) => {
      const measured = event.sampleSecs
        .map(frameIndex)
        .map((n) => ({ n, rect: bounds.get(n) }))
        .filter((row) => row.rect);
      // A transform frame can be fully transparent (a fade-out tag); with no
      // pixels there is nothing to clip. The event itself must render.
      if (!measured.length) {
        throw new Error(`${layer} text event ${index + 1} ("${event.text}") rendered no measurable pixels`);
      }
      for (const { n, rect } of measured) {
        samples.push({
          atMs: Math.round((n / TEXT_FIT_FPS) * 1000),
          phase: 'timeline-sample',
          elements: [safeAreaElement(`${layer}-${index + 1}`, event.text, rect)],
        });
      }
    });
  }
  if (!samples.length) throw new Error('no audience-readable text events were found in any layer');
  samples.sort((a, b) => a.atMs - b.atMs);
  samples[0] = { ...samples[0], phase: 'timeline-start' };
  if (samples.length === 1) samples.push({ ...samples[0], phase: 'timeline-end' });
  else samples[samples.length - 1] = { ...samples[samples.length - 1], phase: 'timeline-end' };
  return samples;
}

function sha256File(file) {
  return require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// The text layers a daily-builder build dir burned into its final.mp4. The
// layer list is never typed by hand (Codex deploy review 63c944b659a1): the
// builder records it in text-layers.json; a build from before that record
// existed is reconstructed from the builder's own rule, where every present
// ASS layer is included, so a stale extra layer can only fail closed. Refuses
// when the build's final bytes are not the video being certified, or when the
// Playwright alpha overlay (not measurable here) was burned in.
function burnedLayersFromBuildDir(buildDir, videoPath) {
  const dir = path.resolve(buildDir);
  const final = path.join(dir, 'final.mp4');
  if (!fs.existsSync(final)) throw new Error(`build dir has no final.mp4: ${dir}`);
  const finalSha = sha256File(final);
  if (finalSha !== sha256File(videoPath)) {
    throw new Error('build dir final.mp4 is not the same bytes as the video being certified');
  }
  const record = path.join(dir, 'text-layers.json');
  if (fs.existsSync(record)) {
    const parsed = JSON.parse(fs.readFileSync(record, 'utf8'));
    if (parsed.final_sha256 !== finalSha) {
      throw new Error('text-layers.json was written for different final bytes');
    }
    if (parsed.playwright_overlay) {
      throw new Error('the Playwright overlay was burned in and has no text-fit measurement');
    }
    const layers = (Array.isArray(parsed.ass) ? parsed.ass : []).map((name) =>
      path.join(dir, path.basename(String(name))),
    );
    const missing = layers.filter((file) => !fs.existsSync(file));
    if (!layers.length || missing.length) {
      throw new Error(`recorded text layer(s) missing: ${missing.join(', ') || '(none recorded)'}`);
    }
    return { layers, provenance: 'text-layers.json' };
  }
  if (fs.existsSync(path.join(dir, 'playwright_overlay.mov'))) {
    throw new Error('the Playwright overlay was burned in and has no text-fit measurement');
  }
  const layers = ['captions.ass', 'overlays.ass', 'animations.ass']
    .map((name) => path.join(dir, name))
    .filter((file) => fs.existsSync(file));
  if (!layers.some((file) => path.basename(file) === 'captions.ass')) {
    throw new Error(`build dir has no captions.ass: ${dir}`);
  }
  return { layers, provenance: 'reconstructed-from-build-dir' };
}

module.exports = {
  burnedLayersFromBuildDir,
  TEXT_FIT_VIEWPORT,
  TEXT_FIT_SAFE_RECT,
  TEXT_FIT_FPS,
  renderedPixelBounds,
  safeAreaElement,
  assTimeSeconds,
  entranceSettleMs,
  transformBoundariesMs,
  assTextEvents,
  frameIndex,
  renderLayerFrameBounds,
  measureAssLayerSamples,
};
