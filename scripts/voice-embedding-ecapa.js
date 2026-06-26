#!/usr/bin/env node
/**
 * Node bridge for the SpeechBrain ECAPA-TDNN embedding helper.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
// Platform-aware venv interpreter: Windows venvs put python.exe under Scripts/,
// POSIX venvs put python under bin/. The old Windows-only default silently
// failed on EC2/Linux (no Scripts/python.exe), which was masked by a detached
// stdio:'ignore' spawn in the caller. Override with VOICE_ECAPA_PYTHON.
const VENV_PYTHON = process.platform === 'win32'
  ? path.join(REPO, '.venv-voice', 'Scripts', 'python.exe')
  : path.join(REPO, '.venv-voice', 'bin', 'python');
const PYTHON = process.env.VOICE_ECAPA_PYTHON || VENV_PYTHON;
const SCRIPT = path.join(REPO, 'scripts', 'voice-embedding-ecapa.py');
const DEFAULT_MAX_SECONDS = Number(process.env.VOICE_EMBEDDING_MAX_SECONDS || '30') || 30;
const DEFAULT_TIMEOUT_MS = Number(process.env.VOICE_ECAPA_TIMEOUT_MS || '480000') || 480000;

const { resolveRepoAudioPath } = require('./lib/repo-audio-path');

function repoAbs(value) {
  // Normalize foreign-absolute (e.g. legacy Windows) audio paths to this repo
  // so reference clips resolve on the Linux container, not just the PC.
  return resolveRepoAudioPath(value, REPO);
}

function embedOne(audioPath, opts = {}) {
  const abs = repoAbs(audioPath);
  if (!fs.existsSync(abs)) throw new Error(`audio not found: ${audioPath}`);
  if (!fs.existsSync(PYTHON)) throw new Error(`ECAPA Python runtime not found: ${PYTHON}`);
  const maxSeconds = Number(opts.maxSeconds || DEFAULT_MAX_SECONDS) || DEFAULT_MAX_SECONDS;
  const run = spawnSync(PYTHON, [SCRIPT, abs, '--max-seconds', String(maxSeconds)], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
    timeout: DEFAULT_TIMEOUT_MS,
  });
  if (run.status !== 0) {
    const detail = run.error?.message || run.stderr || run.stdout || '';
    throw new Error(`ECAPA embedding failed: ${String(detail).slice(0, 2000)}`);
  }
  const parsed = JSON.parse(run.stdout);
  if (parsed.error) throw new Error(parsed.error);
  if (!parsed.embedding?.vector?.length) throw new Error(`ECAPA embedding missing vector for ${audioPath}`);
  return parsed.embedding;
}

function embedMany(audioPaths, opts = {}) {
  const absPaths = audioPaths.map(repoAbs);
  const missing = absPaths.filter((abs) => !fs.existsSync(abs));
  if (missing.length) throw new Error(`audio not found: ${missing[0]}`);
  if (!fs.existsSync(PYTHON)) throw new Error(`ECAPA Python runtime not found: ${PYTHON}`);
  const maxSeconds = Number(opts.maxSeconds || DEFAULT_MAX_SECONDS) || DEFAULT_MAX_SECONDS;
  const run = spawnSync(PYTHON, [SCRIPT, ...absPaths, '--max-seconds', String(maxSeconds), '--jsonl'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env },
    timeout: DEFAULT_TIMEOUT_MS,
  });
  if (run.status !== 0) {
    const detail = run.error?.message || run.stderr || run.stdout || '';
    throw new Error(`ECAPA batch embedding failed: ${String(detail).slice(0, 4000)}`);
  }
  const byPath = new Map();
  for (const line of String(run.stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line);
    byPath.set(path.resolve(parsed.path), parsed);
  }
  return audioPaths.map((audioPath) => {
    const parsed = byPath.get(path.resolve(repoAbs(audioPath)));
    if (!parsed) return { path: audioPath, error: 'missing_batch_result' };
    return parsed;
  });
}

function embedManyAsync(audioPaths, opts = {}) {
  const absPaths = audioPaths.map(repoAbs);
  const missing = absPaths.filter((abs) => !fs.existsSync(abs));
  if (missing.length) return Promise.reject(new Error(`audio not found: ${missing[0]}`));
  if (!fs.existsSync(PYTHON)) return Promise.reject(new Error(`ECAPA Python runtime not found: ${PYTHON}`));
  const maxSeconds = Number(opts.maxSeconds || DEFAULT_MAX_SECONDS) || DEFAULT_MAX_SECONDS;
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [SCRIPT, ...absPaths, '--max-seconds', String(maxSeconds), '--jsonl'], {
      cwd: REPO,
      env: { ...process.env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`ECAPA batch embedding timed out after ${DEFAULT_TIMEOUT_MS}ms`));
    }, DEFAULT_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`ECAPA batch embedding failed: ${String(stderr || stdout || '').slice(0, 4000)}`));
        return;
      }
      const byPath = new Map();
      try {
        for (const line of String(stdout || '').split(/\r?\n/)) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line);
          byPath.set(path.resolve(parsed.path), parsed);
        }
      } catch (error) {
        reject(error);
        return;
      }
      resolve(audioPaths.map((audioPath) => {
        const parsed = byPath.get(path.resolve(repoAbs(audioPath)));
        if (!parsed) return { path: audioPath, error: 'missing_batch_result' };
        return parsed;
      }));
    });
  });
}

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function main() {
  const jsonl = hasArg('--jsonl');
  const maxSeconds = Number(argValue('--max-seconds', DEFAULT_MAX_SECONDS)) || DEFAULT_MAX_SECONDS;
  const audioPaths = process.argv.slice(2).filter((arg, index, args) => {
    if (arg.startsWith('--')) return false;
    if (args[index - 1] === '--max-seconds') return false;
    return true;
  });
  if (!audioPaths.length) throw new Error('usage: node scripts/voice-embedding-ecapa.js <audio.wav> [more.wav] [--max-seconds 30] [--jsonl]');
  const rows = [];
  for (const audioPath of audioPaths) {
    try {
      const row = { path: audioPath, embedding: embedOne(audioPath, { maxSeconds }) };
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
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
}

module.exports = { embedOne, embedMany, embedManyAsync };
