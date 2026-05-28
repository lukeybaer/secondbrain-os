#!/usr/bin/env node
// skill-predictions.js
//
// Phase 3 of harness-evolution-loop. Before a skill runs, write the expected
// outcome to data/agent/predictions/<skill>/<date>-<runId>.json. After the
// run, record the actual outcome on the same file and compute a per-field
// diff. The diff is the learning signal for harness self-improvement.
//
// Storage:
//   data/agent/predictions/<skillName>/<YYYY-MM-DD>-<runId>.json
//
// Schema:
//   {
//     skillName: "video-aurora",
//     runId: "run-001",
//     expected: { videoCount: 4, minQuality: 85, ... },
//     predictedAt: "2026-05-10T10:00:00.000Z",
//     actual: { videoCount: 4, minQuality: 78, ... },     // added on recordActual
//     recordedAt: "2026-05-10T10:25:00.000Z",              // added on recordActual
//     diff: { videoCount: { expected, actual, match }, ... }, // computed
//     allMatched: false                                     // convenience flag
//   }

const fs = require('fs');
const path = require('path');

const REPO = process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..');

function predictionsDir(skillName) {
  return path.join(REPO, 'data', 'agent', 'predictions', skillName);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function filePath(skillName, dateStr, runId) {
  return path.join(predictionsDir(skillName), `${dateStr}-${runId}.json`);
}

function writePrediction(skillName, { expected, runId }) {
  if (!skillName || !runId || !expected) {
    throw new Error('writePrediction requires skillName, runId, expected');
  }
  const dir = predictionsDir(skillName);
  fs.mkdirSync(dir, { recursive: true });
  const date = todayStr();
  const file = filePath(skillName, date, runId);
  const data = {
    skillName,
    runId,
    expected,
    predictedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return { file, data };
}

function findPredictionFile(skillName, runId) {
  const dir = predictionsDir(skillName);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.endsWith(`-${runId}.json`));
  if (!files.length) return null;
  return path.join(dir, files[0]);
}

function diffOutcome(expected, actual) {
  const diff = {};
  const keys = new Set([...Object.keys(expected || {}), ...Object.keys(actual || {})]);
  for (const k of keys) {
    const e = expected ? expected[k] : undefined;
    const a = actual ? actual[k] : undefined;
    diff[k] = { expected: e, actual: a, match: JSON.stringify(e) === JSON.stringify(a) };
  }
  return diff;
}

function recordActual(skillName, { runId, actual }) {
  const file = findPredictionFile(skillName, runId);
  if (!file) {
    throw new Error(`no prediction found for skill=${skillName} runId=${runId}`);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.actual = actual;
  data.recordedAt = new Date().toISOString();
  data.diff = diffOutcome(data.expected, actual);
  data.allMatched = Object.values(data.diff).every(d => d.match);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return data;
}

function listPredictions(skillName) {
  const dir = predictionsDir(skillName);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

module.exports = {
  writePrediction,
  recordActual,
  listPredictions,
  diffOutcome,
  predictionsDir,
};
