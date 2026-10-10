#!/usr/bin/env node
/**
 * Speaker embedding helper using WavLM XVector.
 *
 * This is the first real speaker-verification backend for the Otter pipeline.
 * It outputs normalized 512-d embeddings suitable for same-speaker comparison.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_MODEL = process.env.VOICE_EMBEDDING_MODEL || 'Xenova/wavlm-base-plus-sv';
const DEFAULT_CACHE = path.join(REPO, 'data', 'life-archive', 'voiceprints', 'model-cache');
const DEFAULT_MAX_SECONDS = Number(process.env.VOICE_EMBEDDING_MAX_SECONDS || '12') || 12;

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function repoAbs(value) {
  return path.isAbsolute(value) ? value : path.join(REPO, value);
}

function normalizeVector(values) {
  const data = Array.from(values, Number);
  const norm = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? data.map((value) => value / norm) : data;
}

function audioQuality(audio) {
  const samples = Array.from(audio || []);
  const frame = 400;
  const hop = 160;
  const rms = [];
  let peak = 0;
  for (let i = 0; i + frame <= samples.length; i += hop) {
    let energy = 0;
    for (let j = 0; j < frame; j += 1) {
      const v = samples[i + j];
      energy += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    rms.push(Math.sqrt(energy / frame));
  }
  const sorted = rms.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const q = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))] : 0;
  const floor = Math.max(0.004, q(0.35) * 1.35);
  const voiced = sorted.filter((value) => value >= floor);
  const duration = samples.length / 16000;
  return {
    duration_seconds: Number(duration.toFixed(3)),
    total_frames: sorted.length,
    voiced_frames: voiced.length,
    voiced_ratio: sorted.length ? Number((voiced.length / sorted.length).toFixed(4)) : 0,
    rms_p50: Number(q(0.5).toFixed(8)),
    rms_p90: Number(q(0.9).toFixed(8)),
    peak: Number(peak.toFixed(8)),
    usable: duration >= 6 && voiced.length >= 120 && (sorted.length ? voiced.length / sorted.length : 0) >= 0.22,
  };
}

function decodeAudio(abs, maxSeconds = DEFAULT_MAX_SECONDS) {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    abs,
  ];
  if (maxSeconds > 0) args.push('-t', String(maxSeconds));
  args.push(
    '-ar',
    '16000',
    '-ac',
    '1',
    '-f',
    'f32le',
    'pipe:1',
  );
  const run = spawnSync('ffmpeg', args, { encoding: null, maxBuffer: 120 * 1024 * 1024 });
  if (run.status !== 0 || !run.stdout?.length) {
    throw new Error(`ffmpeg decode failed: ${String(run.stderr || run.stdout || '').slice(0, 500)}`);
  }
  return new Float32Array(run.stdout.buffer, run.stdout.byteOffset, Math.floor(run.stdout.byteLength / 4));
}

async function loadTransformers() {
  const mod = await import('@xenova/transformers');
  const { env } = mod;
  fs.mkdirSync(DEFAULT_CACHE, { recursive: true });
  env.cacheDir = DEFAULT_CACHE;
  env.allowRemoteModels = true;
  return mod;
}

async function embedOne(audioPath, opts = {}) {
  const abs = repoAbs(audioPath);
  if (!fs.existsSync(abs)) throw new Error(`audio not found: ${audioPath}`);
  const { AutoProcessor, AutoModel } = await loadTransformers();
  if (!globalThis.__voiceEmbeddingWavlm) {
    const modelId = opts.model || DEFAULT_MODEL;
    const processor = await AutoProcessor.from_pretrained(modelId);
    const model = await AutoModel.from_pretrained(modelId);
    globalThis.__voiceEmbeddingWavlm = { modelId, processor, model };
  }
  const { modelId, processor, model } = globalThis.__voiceEmbeddingWavlm;
  const maxSeconds = Number(opts.maxSeconds || DEFAULT_MAX_SECONDS) || DEFAULT_MAX_SECONDS;
  const audio = decodeAudio(abs, maxSeconds);
  const quality = audioQuality(audio);
  const inputs = await processor(audio);
  const outputs = await model(inputs);
  const raw = outputs.embeddings?.data || outputs.logits?.data;
  if (!raw) throw new Error('WavLM output did not contain embeddings/logits');
  const vector = normalizeVector(raw).map((value) => Number(value.toFixed(8)));
  return {
    schema: 'life_archive_voice_embedding.v3',
    model: 'wavlm_xvector.transformersjs',
    model_id: modelId,
    sample_rate: 16000,
    max_duration_seconds: maxSeconds,
    dimensions: vector.length,
    quality,
    vector,
  };
}

async function main() {
  const jsonl = hasArg('--jsonl');
  const model = argValue('--model', DEFAULT_MODEL);
  const audioPaths = process.argv.slice(2).filter((arg) => !arg.startsWith('--') && !['true', 'false'].includes(arg));
  const filtered = audioPaths.filter((arg) => arg !== model);
  if (!filtered.length) throw new Error('usage: node scripts/voice-embedding-wavlm.js <audio.wav> [more.wav] [--jsonl]');
  const rows = [];
  for (const audioPath of filtered) {
    try {
      const row = { path: audioPath, embedding: await embedOne(audioPath, { model }) };
      if (jsonl) process.stdout.write(`${JSON.stringify(row)}\n`);
      else rows.push(row);
    } catch (error) {
      const row = { path: audioPath, error: error.message };
      if (jsonl) process.stdout.write(`${JSON.stringify(row)}\n`);
      else rows.push(row);
    }
  }
  if (!jsonl) process.stdout.write(`${JSON.stringify(rows.length === 1 ? rows[0] : rows, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = { embedOne };
