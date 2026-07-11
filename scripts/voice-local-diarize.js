#!/usr/bin/env node
/**
 * Flag-gated local overlap-aware diarization (audit Phase D2, Phase D bullet 2).
 *
 * Node bridge for scripts/voice-local-diarize.py (pyannote community-1).
 * DEFAULT OFF, mirroring the VOICE_FARGATE_ENABLED convention: every entry
 * point except --preflight refuses with a clean JSON object unless
 * VOICE_LOCAL_DIARIZE=1. The python side exits 4 with
 * {error: 'diarization_unavailable', detail} when pyannote or the HF token
 * (HF_TOKEN / HUGGINGFACE_TOKEN) is missing; that surfaces here as a
 * structured error object, never a crash.
 *
 * Modes:
 *   node scripts/voice-local-diarize.js <audio>                 diarize one file
 *   node scripts/voice-local-diarize.js --preflight             backend readiness (ungated, read-only)
 *   node scripts/voice-local-diarize.js --compare --otids a,b   diarize full call audio
 *       (data/otter/audio-full/<otid>.*) and compare against Otter's segments in
 *       data/otter/enriched/<otid>.json: speaker-count delta, overlap seconds
 *       Otter cannot represent, boundary agreement %. Writes
 *       data/life-archive/voiceprints/local-diarize-compare-latest.json.
 *
 * Env:
 *   VOICE_LOCAL_DIARIZE=1   enables diarization (required)
 *   DIARIZE_PYTHON          python interpreter override (default .venv-voice)
 *   DIARIZE_SCRIPT          python script override (tests stub the backend here)
 *   SECONDBRAIN_DATA_DIR    data dir override (default REPO/data)
 *
 * Exit codes (CLI): 0 ok, 1 failure, 2 partial compare errors, 3 gate refusal,
 * 4 backend unavailable.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const EXIT_UNAVAILABLE = 4;
const DEFAULT_TIMEOUT_MS = Number(process.env.VOICE_DIARIZE_TIMEOUT_MS || '1800000') || 1800000;
const DEFAULT_BOUNDARY_TOLERANCE_SECONDS = 0.5;
const COMPARE_SCHEMA = 'life_archive_local_diarize_compare.v1';

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function round3(value) {
  return value === null || value === undefined ? null : Number(Number(value).toFixed(3));
}

function dataDirResolve(dataDirIn = '') {
  return path.resolve(dataDirIn || process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data'));
}

function pythonBin() {
  if (process.env.DIARIZE_PYTHON) return process.env.DIARIZE_PYTHON;
  return process.platform === 'win32'
    ? path.join(REPO, '.venv-voice', 'Scripts', 'python.exe')
    : path.join(REPO, '.venv-voice', 'bin', 'python');
}

function diarizeScript() {
  return process.env.DIARIZE_SCRIPT || path.join(REPO, 'scripts', 'voice-local-diarize.py');
}

/** Null when enabled; otherwise the clean JSON refusal object. */
function gateRefusal() {
  if (process.env.VOICE_LOCAL_DIARIZE === '1') return null;
  return {
    error: 'local_diarize_disabled',
    detail:
      'local diarization is default-off (mirrors VOICE_FARGATE_ENABLED gating); set VOICE_LOCAL_DIARIZE=1 to enable',
  };
}

function parseLastJsonLine(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

/** Total seconds where 2+ speakers are active. Touching turns never overlap. */
function overlapSeconds(segments) {
  const events = [];
  for (const segment of segments || []) {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      events.push([start, 1], [end, -1]);
    }
  }
  // Ends sort before starts at the same instant, so touching turns never overlap.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let depth = 0;
  let previous = 0;
  let total = 0;
  for (const [timePoint, delta] of events) {
    if (depth >= 2) total += timePoint - previous;
    previous = timePoint;
    depth += delta;
  }
  return round3(total);
}

function distinctSpeakerCount(segments) {
  const speakers = new Set();
  for (const segment of segments || []) {
    const speaker = String(segment?.speaker ?? '');
    if (speaker) speakers.add(speaker);
  }
  return speakers.size;
}

function boundaries(segments) {
  const out = [];
  for (const segment of segments || []) {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    if (Number.isFinite(start)) out.push(start);
    if (Number.isFinite(end)) out.push(end);
  }
  return out;
}

/**
 * Otter-vs-local comparison math, pure so tests can prove it on synthetic
 * segment sets. Both inputs are [{start, end, speaker}].
 *   - speaker_count_delta: local minus Otter (positive = local finds more voices)
 *   - overlap_seconds_otter_cannot_represent: local overlap beyond whatever
 *     overlap Otter's segments already encode
 *   - boundary_agreement_pct: % of LOCAL segment boundaries within tolerance
 *     of some Otter boundary (null when local produced no boundaries)
 */
function compareSegments(otterSegments, localSegments, opts = {}) {
  const tolerance = Number.isFinite(Number(opts.toleranceSeconds))
    ? Number(opts.toleranceSeconds)
    : DEFAULT_BOUNDARY_TOLERANCE_SECONDS;
  const otterOverlap = overlapSeconds(otterSegments);
  const localOverlap = Number.isFinite(Number(opts.localOverlapSeconds))
    ? round3(Number(opts.localOverlapSeconds))
    : overlapSeconds(localSegments);
  const otterSpeakers = distinctSpeakerCount(otterSegments);
  const localSpeakers = distinctSpeakerCount(localSegments);
  const otterBoundaries = boundaries(otterSegments);
  const localBoundaries = boundaries(localSegments);
  let matched = 0;
  for (const boundary of localBoundaries) {
    if (otterBoundaries.some((other) => Math.abs(other - boundary) <= tolerance)) matched += 1;
  }
  return {
    otter_segment_count: (otterSegments || []).length,
    local_segment_count: (localSegments || []).length,
    otter_speaker_count: otterSpeakers,
    local_speaker_count: localSpeakers,
    speaker_count_delta: localSpeakers - otterSpeakers,
    otter_overlap_seconds: otterOverlap,
    local_overlap_seconds: localOverlap,
    overlap_seconds_otter_cannot_represent: round3(Math.max(0, (localOverlap || 0) - (otterOverlap || 0))),
    boundary_tolerance_seconds: tolerance,
    boundaries_local_total: localBoundaries.length,
    boundaries_local_matched: matched,
    boundary_agreement_pct: localBoundaries.length
      ? Number(((matched / localBoundaries.length) * 100).toFixed(2))
      : null,
  };
}

function runPython(args) {
  const python = pythonBin();
  if (!process.env.DIARIZE_PYTHON && !fs.existsSync(python)) {
    return { unavailable: `python runtime not found: ${python}` };
  }
  const run = spawnSync(python, [diarizeScript(), ...args], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
    timeout: DEFAULT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (run.error) return { unavailable: run.error.message };
  return { run, parsed: parseLastJsonLine(run.stdout) };
}

/**
 * Diarize one audio file. Returns the python payload
 * ({segments, overlap_seconds, speaker_count, ...}) or a structured error
 * object ({error, detail}); never throws for gate/availability problems.
 */
function diarizeOne(audioPath) {
  const refusal = gateRefusal();
  if (refusal) return refusal;
  const abs = path.isAbsolute(audioPath) ? audioPath : path.join(REPO, audioPath);
  if (!fs.existsSync(abs)) return { error: 'audio_not_found', detail: String(audioPath) };
  const { run, parsed, unavailable } = runPython([abs]);
  if (unavailable) return { error: 'diarization_unavailable', detail: unavailable };
  if (run.status === EXIT_UNAVAILABLE) {
    return {
      error: 'diarization_unavailable',
      detail: parsed?.detail || parsed?.error || String(run.stderr || '').slice(0, 500),
    };
  }
  if (run.status !== 0 || !parsed) {
    return {
      error: 'diarization_failed',
      detail: parsed?.detail || String(run.stderr || run.stdout || `exit ${run.status}`).slice(0, 2000),
    };
  }
  if (parsed.error) return { error: parsed.error, detail: parsed.detail || '' };
  return parsed;
}

/** Backend readiness, ungated and read-only (mirrors the ecapa preflight). */
function preflight() {
  const { run, parsed, unavailable } = runPython(['--preflight']);
  if (unavailable) return { ok: false, reason: unavailable };
  if (parsed?.ok === true) return { ok: true };
  return {
    ok: false,
    reason: parsed?.reason || parsed?.detail || `preflight not ok (exit ${run.status})`,
  };
}

function findFullAudio(otid, dataDir) {
  const dir = path.join(dataDir, 'otter', 'audio-full');
  if (!fs.existsSync(dir)) return '';
  return (
    fs
      .readdirSync(dir)
      .filter((name) => path.parse(name).name === otid)
      .map((name) => path.join(dir, name))
      .find((file) => {
        try {
          return fs.statSync(file).size > 0;
        } catch {
          return false;
        }
      }) || ''
  );
}

function otterSegmentsFromEnriched(enriched) {
  return (enriched?.segments || [])
    .map((segment) => ({
      start: Number(segment?.start_seconds),
      end: Number(segment?.end_seconds),
      speaker: String(segment?.speaker_model_label ?? ''),
    }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end));
}

/**
 * Compare mode: diarize full audio per otid and compare against Otter's
 * segments from the enriched file. Backend unavailability aborts the run and
 * returns the error object (no partial artifact); per-otid problems land in
 * artifact.errors and the rest still complete.
 */
function runCompare({ otids = [], dataDir: dataDirIn = '', outPath: outIn = '', toleranceSeconds, write = true } = {}) {
  const refusal = gateRefusal();
  if (refusal) return refusal;
  const dataDir = dataDirResolve(dataDirIn);
  const outPath = path.resolve(
    outIn || path.join(dataDir, 'life-archive', 'voiceprints', 'local-diarize-compare-latest.json'),
  );
  const tolerance = Number.isFinite(Number(toleranceSeconds))
    ? Number(toleranceSeconds)
    : DEFAULT_BOUNDARY_TOLERANCE_SECONDS;
  const artifact = {
    schema: COMPARE_SCHEMA,
    generated_at: new Date().toISOString(),
    flag_gate: 'VOICE_LOCAL_DIARIZE=1',
    data_dir: dataDir,
    out_path: outPath,
    boundary_tolerance_seconds: tolerance,
    otids_requested: [...otids],
    results: [],
    errors: [],
  };
  for (const otid of otids) {
    const audio = findFullAudio(otid, dataDir);
    if (!audio) {
      artifact.errors.push({ otid, error: 'full_audio_missing' });
      continue;
    }
    const enriched = readJson(path.join(dataDir, 'otter', 'enriched', `${otid}.json`), null);
    if (!enriched) {
      artifact.errors.push({ otid, error: 'enriched_missing' });
      continue;
    }
    const local = diarizeOne(audio);
    if (local.error === 'diarization_unavailable') return { error: local.error, detail: local.detail };
    if (local.error) {
      artifact.errors.push({ otid, error: local.error, detail: local.detail || '' });
      continue;
    }
    const compare = compareSegments(otterSegmentsFromEnriched(enriched), local.segments || [], {
      toleranceSeconds: tolerance,
      localOverlapSeconds: Number(local.overlap_seconds),
    });
    artifact.results.push({
      otid,
      audio_path: path.relative(REPO, audio).replace(/\\/g, '/'),
      ...compare,
    });
  }
  if (write) saveJson(outPath, artifact);
  return artifact;
}

function main() {
  if (hasArg('--preflight')) {
    const result = preflight();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.ok ? 0 : 1);
  }
  const refusal = gateRefusal();
  if (refusal) {
    process.stdout.write(`${JSON.stringify(refusal, null, 2)}\n`);
    process.exit(3);
  }
  if (hasArg('--compare')) {
    const otids = argValue('--otids', '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (!otids.length) {
      throw new Error('usage: node scripts/voice-local-diarize.js --compare --otids a,b [--data-dir data] [--out <file>] [--tolerance-seconds 0.5]');
    }
    const artifact = runCompare({
      otids,
      dataDir: argValue('--data-dir', ''),
      outPath: argValue('--out', ''),
      toleranceSeconds: argValue('--tolerance-seconds', '') || undefined,
      write: !hasArg('--dry-run'),
    });
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
    if (artifact.error === 'diarization_unavailable') process.exit(EXIT_UNAVAILABLE);
    if (artifact.errors?.length) process.exitCode = 2;
    return;
  }
  const audio = process.argv.slice(2).find((arg, index, args) => {
    if (arg.startsWith('--')) return false;
    if (String(args[index - 1] || '').startsWith('--') && ['--otids', '--data-dir', '--out', '--tolerance-seconds'].includes(args[index - 1])) return false;
    return true;
  });
  if (!audio) {
    throw new Error('usage: node scripts/voice-local-diarize.js <audio> | --preflight | --compare --otids a,b');
  }
  const result = diarizeOne(audio);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.error === 'diarization_unavailable') process.exit(EXIT_UNAVAILABLE);
  if (result.error) process.exit(1);
}

module.exports = {
  EXIT_UNAVAILABLE,
  DEFAULT_BOUNDARY_TOLERANCE_SECONDS,
  COMPARE_SCHEMA,
  gateRefusal,
  overlapSeconds,
  compareSegments,
  otterSegmentsFromEnriched,
  findFullAudio,
  diarizeOne,
  preflight,
  runCompare,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
}
