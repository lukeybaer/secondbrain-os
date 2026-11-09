'use strict';

// Audio-only remix fast path (owner decision: "make the volume of the music
// 40% lower" took a 49-minute full re-render of 5,520 frames to change one
// number). Every model-session build saves an audio-stems bundle: the bed
// (voice plus sound effects, before final normalization) and the processed
// music at unity gain. A note that only changes the audio remixes those stems,
// re-encodes only the audio track, copies the video stream untouched, proves
// the frames are identical, and re-binds the release receipts to the new bytes.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { verifyVideoTextFitReleaseGate } = require('./video-text-fit-receipt');

const STEMS_SCHEMA = 'secondbrain.video-audio-stems';
const STEMS_SCHEMA_VERSION = 1;
const DEFAULT_LOUDNORM = Object.freeze({ I: -16.1, TP: -1.5, LRA: 11 });
const MAX_MUSIC_GAIN = 2;
const DURATION_TOLERANCE_SECONDS = 0.1;

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function stemsDirFor(repo, id) {
  return path.join(repo, 'data', 'viral-clip-builds', String(id), 'audio-stems');
}

function stemsFileFor(repo, id) {
  return path.join(stemsDirFor(repo, id), 'stems.json');
}

// A remix stages its next bundle here; it becomes stems.json only after the
// promotion succeeds, so a failed promote never compounds a scaled gain.
function pendingStemsFileFor(repo, id) {
  return path.join(stemsDirFor(repo, id), 'stems.pending.json');
}

function runTool(bin, args, { run = spawnSync } = {}) {
  const result = run(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`${bin} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${bin} ${args.slice(0, 6).join(' ')} exited ${result.status}: ${String(result.stderr || '').slice(-600)}`);
  }
  return result;
}

function probeAudio(file, opts = {}) {
  const out = runTool(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,bit_rate,sample_rate,channels', '-show_entries', 'format=duration', '-of', 'json', file],
    opts,
  );
  const json = JSON.parse(out.stdout || '{}');
  const stream = (json.streams || [])[0] || {};
  return {
    codec: stream.codec_name || null,
    bitrate: Number(stream.bit_rate) || null,
    sample_rate: Number(stream.sample_rate) || null,
    channels: Number(stream.channels) || null,
    duration_seconds: Number(json.format && json.format.duration) || null,
  };
}

// The video stream's own bytes, independent of the audio track and container.
function videoStreamSha256(file, opts = {}) {
  const out = runTool('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'], opts);
  const match = String(out.stdout || '').match(/SHA256=([0-9a-f]{64})/i);
  if (!match) throw new Error(`could not hash the video stream of ${path.basename(file)}`);
  return match[1].toLowerCase();
}

// Gains are stored at four decimals; every comparison rounds the same way
// (Codex review e3d6c41d806b: a rendered 0.07555 is saved as 0.0756).
function roundGain(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function validateGain(value, label, { allowZero = true } = {}) {
  const gain = Number(value);
  if (!Number.isFinite(gain) || gain < 0 || gain > MAX_MUSIC_GAIN || (!allowZero && gain === 0)) {
    throw new Error(`${label} must be a number ${allowZero ? 'from 0' : 'above 0'} to ${MAX_MUSIC_GAIN}`);
  }
  return roundGain(gain);
}

// The release receipts beside a final video must already pass and bind to its
// bytes before their hashes are recorded or re-bound (Codex 45a38a5a9c23).
// A Sadie build writes no effects receipt (The owner), so its caller
// waives it; one found beside the video must still bind to these bytes.
function sourceReceiptsProblem(videoPath, recorded = null, { requireEffects = true } = {}) {
  const sha = sha256File(videoPath);
  const textFitPath = `${videoPath}.text-fit.json`;
  const effectsPath = `${videoPath}.effects.json`;
  const gate = verifyVideoTextFitReleaseGate({ videoPath, receiptPath: textFitPath });
  if (!gate.ok) return { problem: `text-fit receipt does not pass for ${path.basename(videoPath)}: ${gate.reason}` };
  const hasEffects = fs.existsSync(effectsPath);
  if (!hasEffects && requireEffects) return { problem: `no effects receipt beside ${path.basename(videoPath)}` };
  if (hasEffects) {
    let effects;
    try {
      effects = readReceipt(effectsPath);
    } catch (err) {
      return { problem: `effects receipt unreadable: ${err.message}` };
    }
    if (String(effects.video_sha256 || '').toLowerCase() !== sha) return { problem: 'effects receipt is bound to different video bytes' };
  }
  const hashes = { text_fit_sha256: sha256File(textFitPath), effects_sha256: hasEffects ? sha256File(effectsPath) : null };
  if (recorded && (recorded.text_fit_sha256 !== hashes.text_fit_sha256 || (recorded.effects_sha256 || null) !== hashes.effects_sha256)) {
    return { problem: 'a release receipt changed since the stems were saved' };
  }
  return { hashes };
}

// Saves the stems bundle for a finished build, bound to its final bytes.
function exportAudioStems({
  repo,
  id,
  videoPath,
  bedPath,
  musicBedPath,
  thumbnailPath,
  musicFile = null,
  musicGain = 0,
  proposalDate,
  loudnorm = DEFAULT_LOUDNORM,
  now = new Date(),
  probe = probeAudio,
  requireEffectsReceipt = true,
} = {}) {
  if (!repo || !id) throw new Error('export needs the repo and the video id');
  for (const [label, file] of [['--video', videoPath], ['--bed', bedPath], ['--music-bed', musicBedPath], ['--thumbnail', thumbnailPath]]) {
    if (!file || !fs.existsSync(file)) throw new Error(`export needs ${label} that exists`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(proposalDate || ''))) throw new Error('export needs --date <proposal date YYYY-MM-DD>');
  const exportGain = validateGain(musicGain, '--music-gain');
  const receipts = sourceReceiptsProblem(videoPath, null, { requireEffects: requireEffectsReceipt });
  if (receipts.problem) throw new Error(`export refused: ${receipts.problem}`);
  const dir = stemsDirFor(repo, id);
  fs.mkdirSync(dir, { recursive: true });
  const copy = (src, name) => {
    const dest = path.join(dir, name);
    if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest);
    return { file: name, sha256: sha256File(dest) };
  };
  const audio = probe(videoPath);
  const bundle = {
    schema: STEMS_SCHEMA,
    schemaVersion: STEMS_SCHEMA_VERSION,
    video_id: String(id),
    proposal_date: String(proposalDate),
    video_file: path.resolve(videoPath),
    video_sha256: sha256File(videoPath),
    receipts: receipts.hashes,
    bed: copy(bedPath, 'bed.wav'),
    music_bed: copy(musicBedPath, 'music_bed.wav'),
    thumbnail: copy(thumbnailPath, `thumbnail${path.extname(thumbnailPath) || '.jpg'}`),
    music_file: musicFile ? path.basename(String(musicFile)) : null,
    music_gain: exportGain,
    loudnorm: { I: Number(loudnorm.I), TP: Number(loudnorm.TP), LRA: Number(loudnorm.LRA) },
    audio: { codec: audio.codec || 'aac', bitrate: audio.bitrate || 256000, sample_rate: audio.sample_rate || 48000, channels: audio.channels || 2 },
    exported_at: now.toISOString(),
    history: [],
  };
  writeJson(stemsFileFor(repo, id), bundle);
  fs.rmSync(pendingStemsFileFor(repo, id), { force: true });
  return bundle;
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// { ok, bundle } or { ok: false, status: 'no_stems' | 'stems_invalid', reason }.
function loadAudioStems(repo, id, { file = stemsFileFor(repo, id), requireVideo = true } = {}) {
  if (!fs.existsSync(file)) return { ok: false, status: 'no_stems', reason: `no audio stems saved for ${id}; rebuild in full` };
  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, status: 'stems_invalid', reason: `stems.json unreadable: ${err.message}` };
  }
  if (bundle.schema !== STEMS_SCHEMA || bundle.schemaVersion !== STEMS_SCHEMA_VERSION || bundle.video_id !== String(id)) {
    return { ok: false, status: 'stems_invalid', reason: 'stems.json has an unknown contract or another video id' };
  }
  const dir = path.dirname(file);
  for (const key of ['bed', 'music_bed', 'thumbnail']) {
    const stem = bundle[key];
    const abs = stem && path.join(dir, path.basename(String(stem.file || '')));
    if (!abs || !fs.existsSync(abs) || sha256File(abs) !== stem.sha256) {
      return { ok: false, status: 'stems_invalid', reason: `${key} stem is missing or changed since export` };
    }
    stem.path = abs;
  }
  if (requireVideo && (!fs.existsSync(bundle.video_file) || sha256File(bundle.video_file) !== bundle.video_sha256)) {
    return { ok: false, status: 'stems_stale', reason: 'the video these stems belong to is gone or was rebuilt; rebuild in full' };
  }
  return { ok: true, bundle, file };
}

// Promotion of a music-bearing model build requires stems bound to the exact
// bytes (saved, or staged by the remix being promoted). Returns a problem or null.
// With musicGain, the stems must also have been saved at that gain (Codex
// review 2d71b862e1c9 F3: a Sadie promote names the gain the final carries).
function audioStemsProblem(repo, id, videoSha256, { musicGain } = {}) {
  for (const file of [pendingStemsFileFor(repo, id), stemsFileFor(repo, id)]) {
    if (!fs.existsSync(file)) continue;
    const loaded = loadAudioStems(repo, id, { file, requireVideo: false });
    if (!loaded.ok || loaded.bundle.video_sha256 !== videoSha256) continue;
    if (musicGain !== undefined && musicGain !== null && roundGain(loaded.bundle.music_gain) !== roundGain(musicGain)) {
      return `the stems were saved at music gain ${loaded.bundle.music_gain}, not ${musicGain}; promote with the gain the final carries`;
    }
    return null;
  }
  return `no audio stems bound to these bytes; save them first with node scripts/video-audio-remix.js --export --id ${id} (see its usage)`;
}

function commitRemix(repo, id) {
  fs.renameSync(pendingStemsFileFor(repo, id), stemsFileFor(repo, id));
}

function discardRemix(repo, id) {
  fs.rmSync(pendingStemsFileFor(repo, id), { force: true });
}

function remixedPathFor(videoPath, gain) {
  const ext = path.extname(videoPath);
  const base = path.basename(videoPath, ext).replace(/-music-g[0-9p]+$/, '');
  return path.join(path.dirname(videoPath), `${base}-music-g${String(gain).replace('.', 'p')}${ext}`);
}

// Mixes bed + gain x music_bed, normalizes to the bundle's recorded loudness
// in two linear passes, and muxes it under the untouched video stream.
function remixAudioTrack({ bundle, musicGain, outPath, workDir, opts = {} }) {
  const gain = validateGain(musicGain, 'music gain', { allowZero: false });
  const { I, TP, LRA } = bundle.loudnorm;
  fs.mkdirSync(workDir, { recursive: true });
  const premix = path.join(workDir, 'premix.wav');
  const finalWav = path.join(workDir, 'final_mix.wav');
  runTool('ffmpeg', ['-y', '-v', 'error', '-i', bundle.bed.path, '-i', bundle.music_bed.path, '-filter_complex', `[1:a]volume=${gain}[m];[0:a][m]amix=inputs=2:normalize=0[out]`, '-map', '[out]', '-c:a', 'pcm_f32le', '-ar', '48000', premix], opts);
  const measure = runTool('ffmpeg', ['-hide_banner', '-nostats', '-i', premix, '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`, '-f', 'null', '-'], opts);
  const jsonText = String(measure.stderr || '').match(/\{[^{}]*"input_i"[^{}]*\}/);
  if (!jsonText) throw new Error('loudnorm first pass printed no measurement');
  const m = JSON.parse(jsonText[0]);
  const second = `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  runTool('ffmpeg', ['-y', '-v', 'error', '-i', premix, '-af', second, '-ar', '48000', '-c:a', 'pcm_s16le', finalWav], opts);
  const { codec, bitrate, sample_rate: rate, channels } = bundle.audio;
  runTool('ffmpeg', ['-y', '-v', 'error', '-i', bundle.video_file, '-i', finalWav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', codec === 'aac' ? 'aac' : codec, '-b:a', String(bitrate), '-ar', String(rate), '-ac', String(channels), '-movflags', '+faststart', outPath], opts);
  return { gain, first_pass: m };
}

function readReceipt(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

// Re-binds the text-fit and effects receipts to the remixed bytes. Only valid
// because the caller proved the video stream is byte-identical.
function rebindReceipts({ sourceVideo, outVideo, provenance, now = new Date(), requireEffects = true }) {
  const newSha = sha256File(outVideo);
  const bytes = fs.statSync(outVideo).size;
  const textFitSrc = `${sourceVideo}.text-fit.json`;
  const effectsSrc = `${sourceVideo}.effects.json`;
  const hasEffects = fs.existsSync(effectsSrc);
  for (const file of [textFitSrc, ...(requireEffects ? [effectsSrc] : [])]) {
    if (!fs.existsSync(file)) throw new Error(`no ${path.basename(file)} beside the source video`);
  }
  const textFit = readReceipt(textFitSrc);
  const priorVerifiedAt = textFit.verifiedAt;
  textFit.finalVideo = { ...(textFit.finalVideo || {}), fileName: path.basename(outVideo), sha256: newSha, bytes };
  // The frames are proven identical, so the measured layout still holds for
  // these bytes; the timestamp moves so the promote's build time cannot mark it stale.
  textFit.verifiedAt = now.toISOString();
  textFit.audio_remix = { ...provenance, prior_verified_at: priorVerifiedAt || null };
  writeJson(`${outVideo}.text-fit.json`, textFit);
  if (hasEffects) {
    const effects = readReceipt(effectsSrc);
    effects.video_sha256 = newSha;
    effects.audio_remix = { ...provenance };
    writeJson(`${outVideo}.effects.json`, effects);
  } else {
    // A source without effects (a Sadie build) leaves no sidecar: drop one an
    // earlier remix wrote at this name (Codex review 2d71b862e1c9 F4).
    fs.rmSync(`${outVideo}.effects.json`, { force: true });
  }
  return { sha256: newSha, bytes, effects: hasEffects };
}

// Full fast path short of promotion. Returns { ok, status, ... }.
// With baselineSha (the rejected bytes), a rerun after a successful promote
// reports already_remixed instead of scaling the music a second time.
function remixFromStems({ repo, id, musicGain, musicScale, baselineSha = '', now = new Date(), opts = {} }) {
  const loaded = loadAudioStems(repo, id, { requireVideo: false });
  if (!loaded.ok) return loaded;
  const { bundle } = loaded;
  if (baselineSha && bundle.video_sha256 !== baselineSha) {
    const done = (bundle.history || []).find((row) => row.from_video_sha256 === baselineSha);
    if (done) return { ok: true, status: 'already_remixed', id: String(id), video_sha256: bundle.video_sha256, music_gain_to: bundle.music_gain };
    return { ok: false, status: 'stems_stale', reason: 'the saved stems belong to other bytes than the rejected video; rebuild in full' };
  }
  if (!fs.existsSync(bundle.video_file) || sha256File(bundle.video_file) !== bundle.video_sha256) {
    return { ok: false, status: 'stems_stale', reason: 'the video these stems belong to is gone or was rebuilt; rebuild in full' };
  }
  // Only stems that recorded no effects receipt (a Sadie build) remix without one.
  const requireEffects = !(bundle.receipts && bundle.receipts.effects_sha256 === null);
  const receipts = sourceReceiptsProblem(bundle.video_file, bundle.receipts || {}, { requireEffects });
  if (receipts.problem) return { ok: false, status: 'receipts_invalid', reason: receipts.problem };
  const fromGain = Number(bundle.music_gain);
  if (!bundle.music_file || !(fromGain > 0)) {
    return { ok: false, status: 'no_music', reason: 'this build has no music bed to change; rebuild in full' };
  }
  const target = musicGain !== undefined && musicGain !== '' ? musicGain : fromGain * Number(musicScale);
  const gain = validateGain(target, 'the new music gain', { allowZero: false });
  const outPath = remixedPathFor(bundle.video_file, gain);
  const workDir = path.join(path.dirname(loaded.file), `work-${process.pid}-${Date.now()}`);
  try {
    const before = videoStreamSha256(bundle.video_file, opts);
    const mix = remixAudioTrack({ bundle, musicGain: gain, outPath, workDir, opts });
    const after = videoStreamSha256(outPath, opts);
    if (before !== after) {
      fs.rmSync(outPath, { force: true });
      return { ok: false, status: 'video_changed', reason: 'the remux changed the video stream; refusing to re-bind receipts' };
    }
    const srcDuration = probeAudio(bundle.video_file, opts).duration_seconds;
    const outDuration = probeAudio(outPath, opts).duration_seconds;
    if (!(Math.abs(Number(srcDuration) - Number(outDuration)) <= DURATION_TOLERANCE_SECONDS)) {
      fs.rmSync(outPath, { force: true });
      return { ok: false, status: 'duration_changed', reason: `remixed length ${outDuration}s differs from ${srcDuration}s` };
    }
    const provenance = {
      at: now.toISOString(),
      from_video_sha256: bundle.video_sha256,
      video_stream_sha256: after,
      music_gain_from: fromGain,
      music_gain_to: mix.gain,
      loudnorm: bundle.loudnorm,
    };
    const bound = rebindReceipts({ sourceVideo: bundle.video_file, outVideo: outPath, provenance, now, requireEffects });
    // The remix is now the newest build: later remixes chain from it.
    const next = {
      ...bundle,
      video_file: outPath,
      video_sha256: bound.sha256,
      receipts: { text_fit_sha256: sha256File(`${outPath}.text-fit.json`), effects_sha256: bound.effects ? sha256File(`${outPath}.effects.json`) : null },
      music_gain: mix.gain,
      history: [...(bundle.history || []), { at: provenance.at, from_video_sha256: bundle.video_sha256, to_video_sha256: bound.sha256, music_gain_from: fromGain, music_gain_to: mix.gain }],
    };
    for (const key of ['bed', 'music_bed', 'thumbnail']) delete next[key].path;
    writeJson(pendingStemsFileFor(repo, id), next);
    return {
      ok: true,
      status: 'remixed',
      id: String(id),
      video: outPath,
      video_sha256: bound.sha256,
      video_stream_sha256: after,
      thumbnail: path.join(path.dirname(loaded.file), bundle.thumbnail.file),
      music_file: bundle.music_file,
      music_gain_from: fromGain,
      music_gain_to: mix.gain,
      proposal_date: bundle.proposal_date,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = {
  STEMS_SCHEMA,
  STEMS_SCHEMA_VERSION,
  DEFAULT_LOUDNORM,
  stemsDirFor,
  stemsFileFor,
  pendingStemsFileFor,
  audioStemsProblem,
  commitRemix,
  discardRemix,
  exportAudioStems,
  loadAudioStems,
  remixFromStems,
  remixAudioTrack,
  rebindReceipts,
  videoStreamSha256,
  probeAudio,
  remixedPathFor,
};
