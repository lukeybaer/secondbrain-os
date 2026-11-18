'use strict';
// Build formats for the daily Examplechannel clip pipeline (owner decision:
// "Sadie for two video proposals, the usual pipeline for one, but apply the
// improvements to the usual pipeline, so the claim right off the bat";
// owner decision: "So three formats now - old, sadie with unique take then
// start, sadie then start (like today's). Also let sadie's all have the
// music tracks.").
//
// A proposal carries `build_format`. `source-cut` is the usual pipeline: the
// authentic speaker footage cut to the thesis, claim card on frame one. The
// `sadie-split-open` format opens on Sadie, the fully AI-generated presenter,
// speaking the claim over a muted preview of the source, then cuts to the
// source segments and closes on Sadie's take or question. The
// `sadie-take-open` format has Sadie say the claim right out of the gate and
// then her own take (why it matters, why it is BS, what is missing, what
// comes next, or a question she cannot settle) in at most 12 s on camera;
// the source segments then run to the end and close the Short. Every Sadie
// final is a 1080x1920 Short of at most 45 seconds with an approved registry
// music track under the whole film, its manifest row is synthetic media with
// the Kling line, and it is rebuilt from her private kit only
// (skills/work/video-production/references/sadie-ai-presenter.md).

const { ffprobeVideo } = require('./longform-video.js');

const SOURCE_CUT = 'source-cut';
const SADIE_SPLIT_OPEN = 'sadie-split-open';
// owner decision: "one of them make it more of an original take ... she
// can't go more than 12s but do the claim right out of the gate and then what
// she thinks ... her unique take". The take open has no Sadie close: the
// source's last line ends the Short.
const SADIE_TAKE_OPEN = 'sadie-take-open';
const SADIE_FORMATS = Object.freeze([SADIE_SPLIT_OPEN, SADIE_TAKE_OPEN]);
// Sadie's on-camera ceilings: the take open's claim plus her take, the split
// open's claim, and the split open's closing take or question.
const SADIE_TAKE_OPEN_MAX_SECONDS = 12;
const SADIE_SPLIT_OPEN_MAX_SECONDS = 8;
const SADIE_SPLIT_CLOSE_MAX_SECONDS = 6;
// The manifest flag each Sadie format sets on its row; a rebuild in the other
// format clears the first.
const SADIE_ROW_FLAGS = Object.freeze({
  [SADIE_SPLIT_OPEN]: 'sadie_split_open',
  [SADIE_TAKE_OPEN]: 'sadie_take_open',
});
const DEFAULT_VIRAL_CLIP_FORMAT = SOURCE_CUT;
// owner decision: under 45 seconds, claim on frame one, close on a take or a
// question. The same ceiling applies to the usual pipeline.
const SHORT_MAX_SECONDS = 45;
const SADIE_MAX_SECONDS = SHORT_MAX_SECONDS;
const SADIE_FRAME = { width: 1080, height: 1920 };
// The exact disclosure line every Sadie description ends with (The owner).
const SADIE_SYNTHETIC_LABEL = 'Presenter made with Kling AI.';
const SADIE_TEMPLATE_DIR = 'skills/work/video-production/templates/sadie-split-open';
const SADIE_REFERENCE = 'skills/work/video-production/references/sadie-ai-presenter.md';
// The kit staged on the build host by the operator (the EC2 instance role can
// neither list nor read the private backup prefix, verified 2026-10-28).
const SADIE_KIT_DIR = process.env.SADIE_KIT_DIR || '/opt/secondbrain/data/video-productions/_characters/sadie';

const VIRAL_CLIP_FORMATS = Object.freeze({
  [SOURCE_CUT]: Object.freeze({
    id: SOURCE_CUT,
    label: 'Source cut',
    description:
      'Authentic speaker footage cut to the thesis; the claim card is on frame one and the short closes on a take or a question.',
    syntheticPresenter: false,
    maxSeconds: SHORT_MAX_SECONDS,
  }),
  [SADIE_SPLIT_OPEN]: Object.freeze({
    id: SADIE_SPLIT_OPEN,
    label: 'Sadie split open',
    description:
      'Sadie speaks the claim over a muted source preview, the source segments carry the proof, and Sadie closes on a take or a question.',
    syntheticPresenter: true,
    maxSeconds: SADIE_MAX_SECONDS,
  }),
  [SADIE_TAKE_OPEN]: Object.freeze({
    id: SADIE_TAKE_OPEN,
    label: 'Sadie take open',
    description:
      'Sadie says the claim right out of the gate, then her own take (why it matters, why it is BS, what is missing, what comes next, or a question she cannot settle) in at most 12 s on camera; the source segments run to the end and close the Short; approved music under the whole film.',
    syntheticPresenter: true,
    maxSeconds: SADIE_MAX_SECONDS,
  }),
});

// Every owner entry point (the tool schema and both dashboard pickers) offers
// these, in registry order (Codex review 2d71b862e1c9 F2).
const VIRAL_CLIP_FORMAT_IDS = Object.freeze(Object.keys(VIRAL_CLIP_FORMATS));

function escapeOptionText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function viralClipFormatOptionsHtml(selected = DEFAULT_VIRAL_CLIP_FORMAT) {
  return VIRAL_CLIP_FORMAT_IDS.map(
    (id) => `<option value="${escapeOptionText(id)}"${id === selected ? ' selected' : ''}>${escapeOptionText(VIRAL_CLIP_FORMATS[id].label)}</option>`,
  ).join('');
}

function normalizeViralClipFormat(value, { fallback = DEFAULT_VIRAL_CLIP_FORMAT } = {}) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return fallback;
  const normalized = raw
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!Object.prototype.hasOwnProperty.call(VIRAL_CLIP_FORMATS, normalized)) {
    throw new Error(
      `unknown viral clip format: ${raw}; choose ${Object.keys(VIRAL_CLIP_FORMATS).join(' or ')}`,
    );
  }
  return normalized;
}

function applyViralClipFormat(
  proposal,
  value,
  { now = () => new Date(), selectedBy = 'briefing-dashboard' } = {},
) {
  if (!proposal || typeof proposal !== 'object') throw new Error('proposal object required');
  const format = normalizeViralClipFormat(value);
  proposal.build_format = format;
  proposal.build_format_selected_at = now().toISOString();
  proposal.build_format_selected_by = selectedBy;
  return format;
}

// The format a proposal or manifest row was built under; an unset field is the
// usual source cut so every row written before 2026-10-27 keeps its meaning.
function viralClipFormatOf(record) {
  return normalizeViralClipFormat(record && record.build_format, {
    fallback: DEFAULT_VIRAL_CLIP_FORMAT,
  });
}

function isSadieSplitOpenProposal(record) {
  try {
    return viralClipFormatOf(record) === SADIE_SPLIT_OPEN;
  } catch {
    return false;
  }
}

// True for every Sadie format (the split open and the take open).
function isSadieProposal(record) {
  try {
    return SADIE_FORMATS.includes(viralClipFormatOf(record));
  } catch {
    return false;
  }
}

// A problem string, or null when the final is a 1080x1920 Short of at most
// SADIE_MAX_SECONDS. Fails closed when the probe fails.
function sadieFinalProblem(file, { probeVideo = ffprobeVideo } = {}) {
  let v;
  try {
    v = probeVideo(file);
  } catch (err) {
    return `Sadie final could not be probed: ${err.message}`;
  }
  if (!v || v.width !== SADIE_FRAME.width || v.height !== SADIE_FRAME.height) {
    return `Sadie final must be ${SADIE_FRAME.width}x${SADIE_FRAME.height} portrait, got ${v && v.width}x${v && v.height}`;
  }
  if (!Number.isFinite(v.seconds) || v.seconds <= 0 || v.seconds > SADIE_MAX_SECONDS) {
    return `Sadie final must run at most ${SADIE_MAX_SECONDS} s, got ${v.seconds}`;
  }
  return null;
}

// A problem string, or null when the description ends with the disclosure
// line. Trailing whitespace is tolerated; nothing may follow the line.
function sadieDescriptionProblem(description) {
  const text = String(description == null ? '' : description).replace(/\s+$/, '');
  if (!text) return `Sadie description must end with "${SADIE_SYNTHETIC_LABEL}"; it is empty`;
  if (!text.endsWith(SADIE_SYNTHETIC_LABEL)) {
    return `Sadie description must end with "${SADIE_SYNTHETIC_LABEL}"`;
  }
  return null;
}

// Manifest fields every Sadie row carries so the uploader declares synthetic
// media and the X caption carries the label (youtube-approved-upload-handoff.js,
// x-video-post.js).
function sadieManifestFields(durationSeconds, format = SADIE_SPLIT_OPEN) {
  if (!SADIE_FORMATS.includes(format)) throw new Error(`${format} is not a Sadie format`);
  return {
    build_format: format,
    synthetic_media: true,
    synthetic_media_label: SADIE_SYNTHETIC_LABEL,
    [SADIE_ROW_FLAGS[format]]: true,
    ...(Number.isFinite(durationSeconds)
      ? { duration_seconds: Number(durationSeconds.toFixed(2)) }
      : {}),
  };
}

module.exports = {
  SOURCE_CUT,
  SADIE_SPLIT_OPEN,
  SADIE_TAKE_OPEN,
  SADIE_FORMATS,
  SADIE_ROW_FLAGS,
  SADIE_TAKE_OPEN_MAX_SECONDS,
  SADIE_SPLIT_OPEN_MAX_SECONDS,
  SADIE_SPLIT_CLOSE_MAX_SECONDS,
  DEFAULT_VIRAL_CLIP_FORMAT,
  SHORT_MAX_SECONDS,
  SADIE_MAX_SECONDS,
  SADIE_FRAME,
  SADIE_SYNTHETIC_LABEL,
  SADIE_TEMPLATE_DIR,
  SADIE_REFERENCE,
  SADIE_KIT_DIR,
  VIRAL_CLIP_FORMATS,
  VIRAL_CLIP_FORMAT_IDS,
  viralClipFormatOptionsHtml,
  normalizeViralClipFormat,
  applyViralClipFormat,
  viralClipFormatOf,
  isSadieSplitOpenProposal,
  isSadieProposal,
  sadieFinalProblem,
  sadieDescriptionProblem,
  sadieManifestFields,
};
