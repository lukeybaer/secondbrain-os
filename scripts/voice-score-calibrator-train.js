#!/usr/bin/env node
/**
 * Train the voiceprint score calibrator from the calibration sweep artifact
 * (Phase B2 of dev-plans/voiceprint-matching-audit-2026-07-11.html).
 *
 * Reads data/life-archive/voiceprints/calibration-sweep-latest.json (produced
 * by scripts/voiceprint-calibration-sweep.js from human-confirmed evidence
 * only), fits a global binned logistic model P(genuine | raw cosine) plus
 * per-duration-band models where the bands have enough mass, and derives the
 * precision-first operating points consumed by the resolver:
 *   - calibrated_probability_gate: probability at the raw-score threshold that
 *     achieves the strictest non-resolution-limited target FA rate.
 *   - calibrated_min_raw_floor: raw-score threshold at the 1% FA rate (safety
 *     floor under the calibrated path).
 * The raw 0.56/0.06 gates are NOT emitted here: they stay pinned in env /
 * taskdef and the resolver keeps them authoritative (drift-lint contract).
 *
 * Honest failure: a sweep with status insufficient_pairs, or with only
 * resolution-limited FA thresholds, trains nothing and writes status
 * "insufficient" so the resolver keeps running pure raw gates.
 */

const fs = require('fs');
const path = require('path');
const { fitLogisticBinned, logisticProbability } = require('./lib/voice-score-normalization');

const REPO = path.resolve(__dirname, '..');
const DATA_ROOT = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data'));
const VP_DIR = path.join(DATA_ROOT, 'life-archive', 'voiceprints');
const SWEEP_PATH = process.env.VOICE_CALIBRATION_SWEEP_PATH || path.join(VP_DIR, 'calibration-sweep-latest.json');
const OUT_PATH = process.env.OTTER_SPEAKER_SCORE_CALIBRATION_PATH || path.join(VP_DIR, 'score-calibration-latest.json');
const MIN_TIER_COUNT = Number(process.env.VOICE_CALIBRATION_MIN_TIER_COUNT || '50');

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function histogramToBins(genuineHist, impostorHist) {
  const byLo = new Map();
  for (const bin of genuineHist || []) {
    const key = Number(bin.lo).toFixed(4);
    byLo.set(key, { score: (Number(bin.lo) + Number(bin.hi)) / 2, genuine: Number(bin.count || 0), impostor: 0 });
  }
  for (const bin of impostorHist || []) {
    const key = Number(bin.lo).toFixed(4);
    const row = byLo.get(key) || { score: (Number(bin.lo) + Number(bin.hi)) / 2, genuine: 0, impostor: 0 };
    row.impostor += Number(bin.count || 0);
    byLo.set(key, row);
  }
  return [...byLo.values()].sort((a, b) => a.score - b.score);
}

function tierCounts(bins) {
  return bins.reduce(
    (acc, row) => ({ genuine: acc.genuine + row.genuine, impostor: acc.impostor + row.impostor }),
    { genuine: 0, impostor: 0 },
  );
}

function trainTierModel(distributions) {
  const genuine = distributions?.genuine_person?.histogram || [];
  const impostor = distributions?.impostor?.histogram || [];
  const bins = histogramToBins(genuine, impostor);
  const counts = tierCounts(bins);
  if (counts.genuine < MIN_TIER_COUNT || counts.impostor < MIN_TIER_COUNT) {
    return { trained: false, reason: `insufficient counts (genuine ${counts.genuine}, impostor ${counts.impostor}, need >= ${MIN_TIER_COUNT} each)`, counts };
  }
  const model = fitLogisticBinned(bins);
  return { ...model, counts };
}

function parseBandLabel(label) {
  const m = String(label || '').match(/^([0-9.]+)-([0-9.]+)$/);
  if (!m) return null;
  return { label, min: Number(m[1]), max: Number(m[2]) };
}

function deriveOps(sweep, globalModel) {
  const rows = Array.isArray(sweep?.suggested_thresholds) ? sweep.suggested_thresholds : [];
  const usable = rows.filter((row) => row && row.threshold != null && !row.fa_resolution_limited);
  if (!usable.length) return { ok: false, reason: 'all FA operating points are resolution-limited on this corpus' };
  const strictest = [...usable].sort((a, b) => Number(a.target_far) - Number(b.target_far))[0];
  const floorRow = [...usable].sort((a, b) => Number(b.target_far) - Number(a.target_far))[0];
  const probabilityGate = logisticProbability(globalModel, Number(strictest.threshold));
  if (probabilityGate == null) return { ok: false, reason: 'global model untrained' };
  return {
    ok: true,
    ops: {
      calibrated_probability_gate: Number(probabilityGate.toFixed(6)),
      calibrated_min_raw_floor: Number(Number(floorRow.threshold).toFixed(6)),
    },
    derivation: {
      probability_gate_from: { target_far: strictest.target_far, raw_threshold: strictest.threshold, achieved_far: strictest.achieved_far, frr: strictest.frr },
      raw_floor_from: { target_far: floorRow.target_far, raw_threshold: floorRow.threshold, achieved_far: floorRow.achieved_far, frr: floorRow.frr },
    },
  };
}

function train(sweep) {
  const base = {
    schema: 'life_archive_voice_score_calibration.v1',
    generated_at: new Date().toISOString(),
    trained_on: { sweep_generated_at: sweep?.generated_at || null, sweep_status: sweep?.status || 'missing' },
  };
  if (!sweep) return { ...base, status: 'insufficient', reason: 'no calibration sweep artifact' };
  if (sweep.status !== 'ok') return { ...base, status: 'insufficient', reason: `sweep status ${sweep.status}`, missing: sweep.missing || [] };
  const globalModel = trainTierModel(sweep.distributions);
  if (!globalModel.trained) return { ...base, status: 'insufficient', reason: globalModel.reason };
  const bands = [];
  const bandModels = {};
  for (const [label, tierSet] of Object.entries(sweep.duration_bands || {})) {
    const parsed = parseBandLabel(label);
    if (!parsed) continue;
    const model = trainTierModel(tierSet);
    if (model.trained) {
      bands.push(parsed);
      bandModels[label] = { weights: model.weights, trained: true, counts: model.counts };
    }
  }
  const ops = deriveOps(sweep, globalModel);
  if (!ops.ok) return { ...base, status: 'insufficient', reason: ops.reason };
  return {
    ...base,
    status: 'ok',
    models: {
      global: { weights: globalModel.weights, trained: true, counts: globalModel.counts },
      bands: bandModels,
    },
    bands,
    ops: ops.ops,
    derivation: ops.derivation,
    notes: [
      'Models calibrate RAW cosine scores; AS-Norm scores are recorded as evidence and will get their own calibration when the sweep emits per-pair features.',
      'raw_score_gate / raw_margin_gate stay pinned in env + taskdef (drift-linted); this artifact only ever ADDS the calibrated path.',
    ],
  };
}

function main() {
  const sweep = readJson(SWEEP_PATH, null);
  const result = train(sweep);
  if (process.argv.includes('--write')) saveJson(OUT_PATH, result);
  process.stdout.write(`${JSON.stringify({ status: result.status, reason: result.reason || null, ops: result.ops || null, bands_trained: Object.keys(result.models?.bands || {}).length, out: process.argv.includes('--write') ? OUT_PATH : null }, null, 2)}\n`);
  if (result.status !== 'ok') process.exitCode = 2;
}

if (require.main === module) main();

module.exports = { train, histogramToBins, trainTierModel, deriveOps };
