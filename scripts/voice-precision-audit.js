#!/usr/bin/env node
/**
 * Rolling precision audit for the auto-assign tier (Phase C2 of
 * dev-plans/voiceprint-matching-audit-2026-07-11.html, Codex amendments 3/15).
 *
 * The fused auto-tier is an UNCERTIFIED risk score until sampled auto-tier
 * assignments are verified and the Wilson lower bound of the measured
 * precision clears the target (default 0.999). This script:
 *   --sample N     draw a deterministic sample of auto-tier decisions into a
 *                  worksheet for ExampleCo / a second acoustic check to label.
 *   --score        read the labelled worksheet, compute precision + Wilson
 *                  interval, and write the audit result the briefing surfaces.
 * Precision and coverage are reported as SEPARATE numbers (never blended), and
 * the audit refuses to certify from too few samples.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DATA_ROOT = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data'));
const VP_DIR = path.join(DATA_ROOT, 'life-archive', 'voiceprints');
const FUSION = path.join(VP_DIR, 'identity-fusion-latest.json');
const WORKSHEET = process.env.VOICE_PRECISION_AUDIT_WORKSHEET || path.join(VP_DIR, 'precision-audit-worksheet.json');
const AUDIT_OUT = process.env.VOICE_PRECISION_AUDIT_PATH || path.join(VP_DIR, 'precision-audit-latest.json');

const DEFAULT_TARGET_LOWER_BOUND = Number(process.env.VOICE_PRECISION_TARGET_LOWER_BOUND || '0.999') || 0.999;
const DEFAULT_MIN_SAMPLES = Number(process.env.VOICE_PRECISION_MIN_SAMPLES || '100') || 100;

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

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

// Wilson score interval lower bound at 95% (z = 1.96). Correct for small n and
// for p near 1, unlike the normal approximation.
function wilsonLowerBound(successes, n, z = 1.96) {
  if (!n) return 0;
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return Math.max(0, (center - margin) / denom);
}

function computePrecision(samples, options = {}) {
  const targetLowerBound = Number(options.targetLowerBound ?? DEFAULT_TARGET_LOWER_BOUND);
  const minSamples = Number(options.minSamples ?? DEFAULT_MIN_SAMPLES);
  const labelled = (Array.isArray(samples) ? samples : []).filter(
    (row) => row && typeof row.correct === 'boolean',
  );
  const n = labelled.length;
  const successes = labelled.filter((row) => row.correct).length;
  const precision = n ? successes / n : null;
  const wilsonLower = wilsonLowerBound(successes, n);
  if (n < minSamples) {
    return {
      n,
      successes,
      precision,
      wilson_lower: wilsonLower,
      target_lower_bound: targetLowerBound,
      certified: false,
      reason: `insufficient labelled samples: ${n} < ${minSamples}`,
    };
  }
  const certified = wilsonLower >= targetLowerBound;
  return {
    n,
    successes,
    precision,
    wilson_lower: wilsonLower,
    target_lower_bound: targetLowerBound,
    certified,
    reason: certified
      ? `Wilson lower bound ${wilsonLower.toFixed(5)} >= target ${targetLowerBound}`
      : `Wilson lower bound ${wilsonLower.toFixed(5)} < target ${targetLowerBound}`,
  };
}

// Deterministic sample: sort auto-tier decisions by a stable key and take the
// lowest-risk-score N (the auto rows most likely to be wrong are the ones just
// over the gate, so sampling the lowest scores audits the weakest promotions).
function sampleAutoTier(fusion, size) {
  const auto = (fusion?.decisions || []).filter((d) => d.tier === 'auto');
  const sorted = [...auto].sort(
    (a, b) =>
      Number(a.fused_risk_score || 0) - Number(b.fused_risk_score || 0) ||
      String(a.target?.otid).localeCompare(String(b.target?.otid)),
  );
  return sorted.slice(0, size).map((d) => ({
    otid: d.target?.otid || '',
    speaker_model_label: d.target?.speaker_model_label || '',
    candidate_person_id: d.candidate_person_id || '',
    display_name: d.display_name || '',
    fused_risk_score: d.fused_risk_score,
    probe_provenance: d.provenance?.acoustic || {},
    // Reviewer fills this in: true if the assigned person actually spoke.
    correct: null,
  }));
}

function main() {
  if (process.argv.includes('--sample')) {
    const size = Number(argValue('--sample', '100')) || 100;
    const fusion = readJson(FUSION, { decisions: [] });
    const worksheet = {
      schema: 'life_archive_voice_precision_audit_worksheet.v1',
      generated_at: new Date().toISOString(),
      auto_tier_total: (fusion.decisions || []).filter((d) => d.tier === 'auto').length,
      sample_size: size,
      instructions: 'For each row, listen to the clip and set correct=true if the assigned person actually spoke, false otherwise. Then run --score.',
      samples: sampleAutoTier(fusion, size),
    };
    saveJson(WORKSHEET, worksheet);
    process.stdout.write(`${JSON.stringify({ wrote: WORKSHEET, sampled: worksheet.samples.length, auto_tier_total: worksheet.auto_tier_total }, null, 2)}\n`);
    return;
  }
  if (process.argv.includes('--score')) {
    const worksheet = readJson(WORKSHEET, { samples: [] });
    const result = computePrecision(worksheet.samples || []);
    const audit = {
      schema: 'life_archive_voice_precision_audit.v1',
      generated_at: new Date().toISOString(),
      ...result,
      note: 'Auto-tier precision is measured, not assumed. Coverage is reported separately (see identity-fusion-latest.json tier_counts). Until certified, auto-tier assignments remain uncertified risk-score promotions.',
    };
    if (process.argv.includes('--write')) saveJson(AUDIT_OUT, audit);
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    if (!result.certified) process.exitCode = 2;
    return;
  }
  process.stdout.write('usage: voice-precision-audit.js --sample <N> | --score [--write]\n');
}

if (require.main === module) main();

module.exports = { computePrecision, wilsonLowerBound, sampleAutoTier };
