'use strict';
// The v4 effects receipt: proof that a model-session clip carries the package
// The owner set on 2026-10-19 ("weave in some cool images like for 0.7 seconds at
// the funny or fun or happy parts and it's never accentuating fear or pain, it
// accentuates the message, the good stuff, and intersperse at tasteful times
// some other screens that the video flips over to that, and then comes back.
// Also add a couple interesting but subtle sound effects").
//
// Codex ec2-deploy review cdf42c22df2d (high): prompts and docs alone do not
// make an MP4 carry these effects, and promotion stamped the v4 theme without
// proof. So the model session writes `<final.mp4>.effects.json`, SHA-bound to
// the exact final bytes, listing every accent, cutaway and sound effect with
// its onset, duration and the beat it serves. `--promote` refuses a clip
// without a passing receipt and the spine completion check re-verifies it. The
// labeled deterministic fallback renders none of these and records
// `effects: null`; it never claims the package.
//
// Codex review dc2c51103d63 (high): a well-formed receipt is still only a
// claim. So the receipt's `clip_seconds` is required and checked against the
// ffprobe length of the queued bytes (fail closed when the probe fails), every
// sound effect carries an onset and a duration inside the clip, and each one
// must sit on the accent, cutaway start or cutaway edge it says it is bound
// to. Frame-level proof that an image was composited stays open: there is no
// renderer separate from the model session to attest it.
//
// v5 (owner decision, "high def, visually beautiful, not cartoonish"): every
// accent and every cutaway names its picture in a `media` block. Accents use a
// real HD photo, HD footage or the clip's own source; the receipt hashes and
// probes that file (9:16 crop at least 1080 px wide). Hand-drawn SVG shapes,
// clip art and icons are refused. A v4 receipt (already promoted rows) is
// checked under the v4 rules it was written to.
//
// Codex review dae2270ae8ee (high): naming an HD file does not prove the film
// shows it. So each v5 cue is matched against the decoded final frame at the
// cue (accent-frame-proof.js) and must score at least MATCH_THRESHOLD; the
// scores are recorded in the summary. A DOM-rendered chart or headline names a
// PNG still of the rendered screen for this match.
//
// Oct 1 research proposal 9 (warning only, never a gate): the summary records
// the longest stretch of the final clip with no accent or cutaway on screen,
// and the review card shows it. STATIC_GAP_WARN_SECONDS is an unvalidated
// threshold tuned only from the owner's notes. The fallback build records no cues,
// so its gap is unknown, never 0.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const { ACCENT_MEDIA_KINDS, CUTAWAY_MEDIA_KINDS, checkMedia, resolveMediaFile, frameKindFor } = require('./accent-media.js');
const { MATCH_THRESHOLD, cueMatchScore } = require('./accent-frame-proof.js');

const V4_THEME_VERSION = 'examplechannel-narrator-themes-v4-no-header-pure-clip-2026-10-19';

const SCHEMA = 'clip-effects-receipt@1';
// An accent carries the message or the good news; nothing that heightens
// dread, loss, injury or anger, even when the speaker names them.
const ACCENT_MOODS = ['fun', 'funny', 'happy', 'message', 'good-news'];
const SOUND_EFFECT_BINDINGS = ['accent', 'cutaway', 'transition'];
const ACCENT_SECONDS = { min: 0.4, max: 1.2 };
const CUTAWAY_SECONDS = { min: 0.3, max: 6 };
const SOUND_EFFECT_SECONDS = { min: 0.05, max: 3 };
// A sound effect bound to a cue must start within this of the cue.
const BINDING_TOLERANCE_SECONDS = 0.25;
// The receipt's clip length must match the probed final within this.
const DURATION_TOLERANCE_SECONDS = 0.5;
const LIMITS = { accents: [1, 6], cutaways: [1, 6], sound_effects: [1, 4] };
const STATIC_GAP_WARN_SECONDS = 6; // Oct 1 research proposal 9; unvalidated; warning only, never a gate.

// Long-form profile (owner decision: "These are not shorts; make it long
// format. In long format you can make your animations, drawings and clips a
// little longer, one to five seconds, even seven depending on how important").
// A long-form receipt says `format: "longform"`, its pictures are checked for a
// 16:9 1920x1080 frame, holds run up to 7 s and a three-minute film carries
// more cues. The verifier must be asked for long-form explicitly and a short's
// verifier refuses a long-form receipt, so neither gate passes the other's.
const FORMATS = {
  short: { accentSeconds: ACCENT_SECONDS, cutawaySeconds: CUTAWAY_SECONDS, limits: LIMITS, orientation: 'portrait' },
  longform: {
    accentSeconds: { min: 0.4, max: 7 },
    cutawaySeconds: { min: 0.3, max: 7 },
    limits: { accents: [1, 24], cutaways: [1, 16], sound_effects: [1, 20] },
    orientation: 'landscape',
  },
};

function formatSpec(format) {
  const spec = FORMATS[format || 'short'];
  if (!spec) throw new Error(`unknown effects receipt format ${format}`);
  return spec;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Length of the final video from its container, via ffprobe. Throws when the
// probe cannot run or returns nothing usable, so the caller fails closed.
function ffprobeDurationSeconds(file, { spawnSyncImpl = spawnSync, ffprobe = 'ffprobe' } = {}) {
  const result = spawnSyncImpl(
    ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file],
    { encoding: 'utf8', timeout: 60000 },
  );
  if (!result || result.status !== 0) {
    const detail = String((result && (result.stderr || (result.error && result.error.message))) || 'no output').trim();
    throw new Error(`ffprobe failed: ${detail.slice(0, 200)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout || '{}'));
  } catch (err) {
    throw new Error(`ffprobe output unreadable: ${err.message}`);
  }
  const seconds = Number(parsed && parsed.format && parsed.format.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('ffprobe reported no duration');
  return seconds;
}

// The cue onsets a sound effect may bind to: an accent start, a cutaway start,
// or (transition) a cutaway start or its return to the source.
function bindingAnchors(receipt, boundTo) {
  if (boundTo === 'accent') return receipt.accents.map((item) => finite(item.at_seconds));
  if (boundTo === 'cutaway') return receipt.cutaways.map((item) => finite(item.at_seconds));
  return receipt.cutaways.flatMap((item) => {
    const at = finite(item.at_seconds);
    return [at, at + finite(item.duration_seconds)];
  });
}

function checkList(receipt, key, perItem, limits = LIMITS) {
  const list = receipt[key];
  const [min, max] = limits[key];
  if (!Array.isArray(list)) return `${key} must be an array`;
  if (list.length < min || list.length > max) return `${key} needs ${min} to ${max} entries, got ${list.length}`;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') return `${key}[${i}] is not an object`;
    const at = finite(item.at_seconds);
    if (at === null || at < 0) return `${key}[${i}].at_seconds must be a non-negative number`;
    const problem = perItem(item, i);
    if (problem) return problem;
  }
  return null;
}

function validateReceiptShape(receipt, { themeVersion, clipSeconds, format = 'short' } = {}) {
  if (!receipt || typeof receipt !== 'object') return 'receipt is not an object';
  if (receipt.schema !== SCHEMA) return `schema must be ${SCHEMA}`;
  const spec = formatSpec(format);
  const receiptFormat = receipt.format == null ? 'short' : String(receipt.format);
  if (receiptFormat !== format) return `receipt format ${receiptFormat} is not the ${format} format this gate checks`;
  const ACCENT_SECONDS = spec.accentSeconds;
  const CUTAWAY_SECONDS = spec.cutawaySeconds;
  if (!/^[0-9a-f]{64}$/.test(String(receipt.video_sha256 || ''))) return 'video_sha256 must be a sha256 hex digest';
  if (themeVersion && receipt.theme_version !== themeVersion) {
    return `theme_version ${receipt.theme_version || '(missing)'} is not ${themeVersion}`;
  }
  const end = finite(receipt.clip_seconds);
  if (end === null || end <= 0) return 'clip_seconds must be the final clip length in seconds';
  const expected = finite(clipSeconds);
  if (clipSeconds != null && (expected === null || Math.abs(expected - end) > DURATION_TOLERANCE_SECONDS)) {
    return `clip_seconds ${end} does not match the clip length ${clipSeconds}s`;
  }
  const within = (key, i, item, duration) => {
    if (finite(item.at_seconds) + duration > end + 0.05) {
      return `${key}[${i}] ends after the clip (${end}s)`;
    }
    return null;
  };
  return (
    checkList(receipt, 'accents', (item, i) => {
      const d = finite(item.duration_seconds);
      if (d === null || d < ACCENT_SECONDS.min || d > ACCENT_SECONDS.max) {
        return `accents[${i}].duration_seconds must be ${ACCENT_SECONDS.min} to ${ACCENT_SECONDS.max}${format === 'short' ? ' (about 0.7)' : ''}`;
      }
      if (!ACCENT_MOODS.includes(String(item.mood || ''))) {
        return `accents[${i}].mood must be one of ${ACCENT_MOODS.join('|')} (never fear or pain)`;
      }
      if (!nonEmpty(item.beat)) return `accents[${i}].beat must name the spoken beat it accentuates`;
      if (!nonEmpty(item.image)) return `accents[${i}].image must name the image`;
      return within('accents', i, item, d);
    }, spec.limits) ||
    checkList(receipt, 'cutaways', (item, i) => {
      const d = finite(item.duration_seconds);
      if (d === null || d < CUTAWAY_SECONDS.min || d > CUTAWAY_SECONDS.max) {
        return `cutaways[${i}].duration_seconds must be ${CUTAWAY_SECONDS.min} to ${CUTAWAY_SECONDS.max}`;
      }
      if (!nonEmpty(item.screen)) return `cutaways[${i}].screen must describe the screen it flips to`;
      if (item.returns_to_source !== true) return `cutaways[${i}].returns_to_source must be true`;
      return within('cutaways', i, item, d);
    }, spec.limits) ||
    checkList(receipt, 'sound_effects', (item, i) => {
      if (!nonEmpty(item.name)) return `sound_effects[${i}].name is required`;
      const boundTo = String(item.bound_to || '');
      if (!SOUND_EFFECT_BINDINGS.includes(boundTo)) {
        return `sound_effects[${i}].bound_to must be one of ${SOUND_EFFECT_BINDINGS.join('|')}`;
      }
      const d = finite(item.duration_seconds);
      if (d === null || d < SOUND_EFFECT_SECONDS.min || d > SOUND_EFFECT_SECONDS.max) {
        return `sound_effects[${i}].duration_seconds must be ${SOUND_EFFECT_SECONDS.min} to ${SOUND_EFFECT_SECONDS.max}`;
      }
      const at = finite(item.at_seconds);
      if (!bindingAnchors(receipt, boundTo).some((anchor) => Math.abs(anchor - at) <= BINDING_TOLERANCE_SECONDS)) {
        const cue = boundTo === 'transition' ? 'cutaway start or return' : `${boundTo} start`;
        return `sound_effects[${i}] at ${at}s is bound to ${boundTo} but no ${cue} is within ${BINDING_TOLERANCE_SECONDS}s`;
      }
      return within('sound_effects', i, item, d);
    }, spec.limits)
  );
}

function receiptPathFor(videoPath) {
  return `${videoPath}.effects.json`;
}

// A number, or a non-blank string that reads as one; else null. Unlike
// finite(), null and '' never become 0.
function cueNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

// The longest span of the clip with no accent or cutaway on screen, as
// { seconds, from, to }, counting the clip start and end. Overlapping cues
// merge; on equal spans the earliest wins. Null when the receipt is missing or
// malformed, never 0.
function longestStaticGap(receipt, clipSeconds) {
  if (!receipt || typeof receipt !== 'object') return null;
  if (!Array.isArray(receipt.accents) || !Array.isArray(receipt.cutaways)) return null;
  const end = cueNumber(clipSeconds == null ? receipt.clip_seconds : clipSeconds);
  if (end === null || end <= 0) return null;
  const windows = [];
  for (const cue of [...receipt.accents, ...receipt.cutaways]) {
    if (!cue || typeof cue !== 'object') return null;
    const at = cueNumber(cue.at_seconds);
    const d = cueNumber(cue.duration_seconds);
    if (at === null || d === null || at < 0 || d < 0) return null;
    windows.push([Math.min(at, end), Math.min(at + d, end)]);
  }
  windows.sort((a, b) => a[0] - b[0]);
  let best = { seconds: 0, from: 0, to: 0 };
  const consider = (from, to) => {
    if (to - from > best.seconds) best = { seconds: to - from, from, to };
  };
  let cursor = 0;
  for (const [start, stop] of windows) {
    consider(cursor, start);
    cursor = Math.max(cursor, stop);
  }
  consider(cursor, end);
  return { seconds: round3(best.seconds), from: round3(best.from), to: round3(best.to) };
}

// The review-card line for a build's recorded effects summary. Advisory only:
// it never blocks approval. A fallback build (built_effects null) is unknown.
function staticGapCardNote(builtEffects) {
  if (!builtEffects || typeof builtEffects !== 'object') {
    return {
      level: 'unknown',
      text: 'Longest static shot: unknown. No cue data: the fallback build (or a build before effects receipts) records no accents or cutaways, so the gap is not measured.',
    };
  }
  const gap = builtEffects.static_gap;
  const s = gap && typeof gap === 'object' ? cueNumber(gap.seconds) : null;
  const from = gap && typeof gap === 'object' ? cueNumber(gap.from) : null;
  const to = gap && typeof gap === 'object' ? cueNumber(gap.to) : null;
  if (s === null || from === null || to === null) {
    return { level: 'unknown', text: "Longest static shot: unknown. This build's effects receipt predates the static-gap measure." };
  }
  if (s === 0) return { level: 'ok', text: 'Longest static shot: 0 s; accents or cutaways cover the whole clip.' };
  const where = `${s.toFixed(1)} s (${from.toFixed(1)} to ${to.toFixed(1)} s)`;
  if (builtEffects.format === 'longform') {
    return { level: 'unknown', text: `Longest static shot ${where}. The ${STATIC_GAP_WARN_SECONDS} s warning applies to Shorts only.` };
  }
  if (s > STATIC_GAP_WARN_SECONDS) {
    return {
      level: 'warn',
      text: `Warning: longest static shot ${where}, over the ${STATIC_GAP_WARN_SECONDS} s guide (unvalidated). Advisory only; it never blocks approval.`,
    };
  }
  return { level: 'ok', text: `Longest static shot ${where}, within the ${STATIC_GAP_WARN_SECONDS} s guide.` };
}

// { ok, reason, receiptPath, receipt, summary }. `summary` is what the
// proposal and the manifest row record. `probeDurationSeconds(videoPath)`
// defaults to ffprobe; a probe that throws or returns nothing fails closed.
// v5 media proof for every accent and cutaway. Relative media paths resolve
// against `production_dir` when the receipt names one, else beside the receipt.
// With `videoPath`, each cue is also matched against the decoded final frame
// (`frameProof`, cueMatchScore by default) and its score pushed to `scores`.
function checkReceiptMedia(receipt, { receiptFile, videoPath, probeDimensions, hashFile, frameProof = cueMatchScore, scores = [], sourceAcquisitions, format = 'short' } = {}) {
  if (receipt.theme_version === V4_THEME_VERSION) return null;
  const { orientation } = formatSpec(format);
  const baseDir = receipt.production_dir || path.dirname(receiptFile || '.');
  const opts = { baseDir, sourceAcquisitions, orientation };
  if (probeDimensions) opts.probeDimensions = probeDimensions;
  if (hashFile) opts.hashFile = hashFile;
  const cues = [
    ...receipt.accents.map((cue, i) => ({ cue, label: `accents[${i}]`, kinds: ACCENT_MEDIA_KINDS })),
    ...receipt.cutaways.map((cue, i) => ({ cue, label: `cutaways[${i}]`, kinds: CUTAWAY_MEDIA_KINDS })),
  ];
  for (const { cue, label, kinds } of cues) {
    const problem = checkMedia(cue.media, { ...opts, label, allowedKinds: kinds });
    if (problem) return problem;
  }
  if (!videoPath) return null;
  for (const { cue, label } of cues) {
    const kind = frameKindFor(cue.media);
    let score;
    try {
      score = frameProof({
        videoPath,
        atSeconds: finite(cue.at_seconds),
        durationSeconds: finite(cue.duration_seconds),
        mediaFile: resolveMediaFile(cue.media, baseDir),
        mediaKind: kind,
        mediaStartSeconds: finite(cue.media.start_seconds) || 0,
        orientation,
      });
    } catch (err) {
      return `${label} frame proof failed: ${err.message}`;
    }
    const rounded = Math.round(Number(score) * 1000) / 1000;
    scores.push({ cue: label, score: rounded });
    if (!(score >= MATCH_THRESHOLD)) {
      return `${label} is not in the final video: its frame at ${cue.at_seconds}s matches ${path.basename(cue.media.file)} at ${rounded}, under ${MATCH_THRESHOLD} (render the named HD picture or lit 3D render full-bleed, never a flat drawing)`;
    }
  }
  return null;
}

function verifyClipEffectsReceipt({ videoPath, receiptPath, themeVersion, clipSeconds, probeDurationSeconds, probeMediaDimensions, hashMediaFile, frameProof, sourceAcquisitions, format = 'short' } = {}) {
  if (!FORMATS[format]) return { ok: false, reason: `unknown effects receipt format ${format}` };
  if (!videoPath || !fs.existsSync(videoPath)) return { ok: false, reason: 'final video missing' };
  const file = receiptPath || receiptPathFor(videoPath);
  if (!fs.existsSync(file)) {
    return { ok: false, reason: `no effects receipt beside the final video (expected ${file})`, receiptPath: file };
  }
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    return { ok: false, reason: `effects receipt unreadable: ${err.message}`, receiptPath: file };
  }
  const shape = validateReceiptShape(receipt, { themeVersion, clipSeconds, format });
  if (shape) return { ok: false, reason: shape, receiptPath: file, receipt };
  const sha = sha256File(videoPath);
  if (String(receipt.video_sha256).toLowerCase() !== sha) {
    return { ok: false, reason: 'effects receipt is bound to different video bytes', receiptPath: file, receipt };
  }
  let probed;
  try {
    probed = (probeDurationSeconds || ffprobeDurationSeconds)(videoPath);
  } catch (err) {
    return { ok: false, reason: `could not probe the final video length: ${err.message}`, receiptPath: file, receipt };
  }
  if (!Number.isFinite(probed) || probed <= 0) {
    return { ok: false, reason: 'could not probe the final video length: no duration', receiptPath: file, receipt };
  }
  const claimed = finite(receipt.clip_seconds);
  if (Math.abs(probed - claimed) > DURATION_TOLERANCE_SECONDS) {
    return {
      ok: false,
      reason: `effects receipt clip_seconds ${claimed} does not match the final video length ${probed.toFixed(2)}s`,
      receiptPath: file,
      receipt,
    };
  }
  const frameScores = [];
  const media = checkReceiptMedia(receipt, {
    receiptFile: file,
    videoPath,
    probeDimensions: probeMediaDimensions,
    hashFile: hashMediaFile,
    frameProof: frameProof || undefined,
    scores: frameScores,
    sourceAcquisitions,
    format,
  });
  if (media) return { ok: false, reason: media, receiptPath: file, receipt };
  return {
    ok: true,
    reason: 'effects receipt verified',
    receiptPath: file,
    receipt,
    summary: {
      schema: SCHEMA,
      ...(format === 'short' ? {} : { format }),
      video_sha256: sha,
      theme_version: receipt.theme_version || null,
      clip_seconds: claimed,
      probed_seconds: Math.round(probed * 1000) / 1000,
      accents: receipt.accents.length,
      cutaways: receipt.cutaways.length,
      sound_effects: receipt.sound_effects.length,
      static_gap: longestStaticGap(receipt, claimed),
      frame_match: receipt.theme_version === V4_THEME_VERSION ? null : { threshold: MATCH_THRESHOLD, cues: frameScores },
    },
  };
}

module.exports = {
  SCHEMA,
  ACCENT_MOODS,
  SOUND_EFFECT_BINDINGS,
  ACCENT_SECONDS,
  CUTAWAY_SECONDS,
  SOUND_EFFECT_SECONDS,
  BINDING_TOLERANCE_SECONDS,
  DURATION_TOLERANCE_SECONDS,
  V4_THEME_VERSION,
  FORMATS,
  STATIC_GAP_WARN_SECONDS,
  longestStaticGap,
  staticGapCardNote,
  receiptPathFor,
  checkReceiptMedia,
  ffprobeDurationSeconds,
  validateReceiptShape,
  verifyClipEffectsReceipt,
};
