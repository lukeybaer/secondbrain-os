'use strict';

// scripts/lib/name-judge-backend.js
//
// One per-host switch decides who judges speaker names:
//   'jev'    TypeSafe Jev decision lane (auth-jev-speaker-naming, ExampleCo 2026-09-18)
//   'ladder' the prior Claude/Codex subscription judge
// Rollback is a switch flip, never a deploy:
//   node scripts/name-judge-backend.js set ladder --by "<who>"
// NAME_JUDGE_BACKEND in the environment overrides the file for one run.
// No file means 'ladder', so a fresh host keeps the old behaviour until the
// owner's switch is written.

const fs = require('node:fs');
const path = require('node:path');

const BACKENDS = Object.freeze(['jev', 'ladder']);
const DEFAULT_BACKEND = 'ladder';

function switchFile(root = path.resolve(__dirname, '..', '..')) {
  const dataDir = process.env.SECONDBRAIN_DATA_DIR || path.join(root, 'data');
  return path.join(dataDir, 'agent', 'name-judge-backend.json');
}

function readNameJudgeBackend({ env = process.env, file = switchFile() } = {}) {
  const fromEnv = String(env.NAME_JUDGE_BACKEND || '').trim().toLowerCase();
  if (BACKENDS.includes(fromEnv)) return fromEnv;
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const backend = String(state && state.backend ? state.backend : '').trim().toLowerCase();
    if (BACKENDS.includes(backend)) return backend;
  } catch {
    // Absent or unreadable switch keeps the prior judge.
  }
  return DEFAULT_BACKEND;
}

function writeNameJudgeBackend({ backend, by = 'unknown', file = switchFile(), now = new Date() }) {
  const wanted = String(backend || '').trim().toLowerCase();
  if (!BACKENDS.includes(wanted)) {
    throw new Error(`unknown name-judge backend "${backend}" (allowed: ${BACKENDS.join(', ')})`);
  }
  const state = { backend: wanted, by, at: now.toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
}

module.exports = {
  BACKENDS,
  DEFAULT_BACKEND,
  switchFile,
  readNameJudgeBackend,
  writeNameJudgeBackend,
};
