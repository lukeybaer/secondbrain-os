#!/usr/bin/env node
// prediction-accuracy-rollup.js
//
// Per-skill / per-field accuracy rollup over the prediction history written by
// skill-predictions.js. The companion module is single-run only:
// writePrediction() / recordActual() / diffOutcome() per call. This module is
// the date-range aggregation Amy's briefing needs to answer:
//
//   - "How often is each skill matching its own prediction?"
//   - "Which prediction field is systematically wrong?" (the calibration gap)
//   - "How accurate were predictions over the last 7 / 30 days?"
//
// Why this exists: Agno 2026's multi-level metric rollup pattern (per-message,
// per-tool, per-run) treats the per-run prediction record as the unit and
// rolls up. DSPy's optimizer treats per-field accuracy as the signal that
// drives prompt tuning. Combining the two: per-skill, per-field rolling
// accuracy is the smallest object that surfaces a real calibration gap
// (e.g. videoCount always matches, but minQuality is wrong 70% of the time).
//
// Pure module, env-configurable root, tmp-dir-isolated tests.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = () => process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..');

function predictionsRoot() {
  return path.join(REPO_ROOT(), 'data', 'agent', 'predictions');
}

function listSkillsWithPredictions() {
  const dir = predictionsRoot();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => {
    try {
      return fs.statSync(path.join(dir, name)).isDirectory();
    } catch {
      return false;
    }
  }).sort();
}

function loadSkillPredictions(skillName) {
  const dir = path.join(predictionsRoot(), skillName);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function _withinWindow(timestampIso, sinceMs, untilMs) {
  if (!timestampIso) return false;
  const t = new Date(timestampIso).getTime();
  if (Number.isNaN(t)) return false;
  if (sinceMs != null && t < sinceMs) return false;
  if (untilMs != null && t > untilMs) return false;
  return true;
}

function _resolveWindow({ since, until, windowDays } = {}) {
  let sinceMs = null;
  let untilMs = null;
  if (since != null) sinceMs = since instanceof Date ? since.getTime() : new Date(since).getTime();
  if (until != null) untilMs = until instanceof Date ? until.getTime() : new Date(until).getTime();
  if (sinceMs == null && windowDays != null) {
    const now = Date.now();
    sinceMs = now - windowDays * 86_400_000;
  }
  return { sinceMs, untilMs };
}

function rollupSkill(skillName, options = {}) {
  const { sinceMs, untilMs } = _resolveWindow(options);
  const all = loadSkillPredictions(skillName);
  const windowed = all.filter((r) => _withinWindow(r.recordedAt || r.predictedAt, sinceMs, untilMs));
  const evaluated = windowed.filter((r) => r.diff && typeof r.allMatched === 'boolean');
  const pending = windowed.length - evaluated.length;

  const fieldStats = {};
  let matchedRuns = 0;
  for (const r of evaluated) {
    if (r.allMatched) matchedRuns += 1;
    for (const [field, info] of Object.entries(r.diff)) {
      if (!fieldStats[field]) fieldStats[field] = { evaluated: 0, matched: 0, mismatches: [] };
      fieldStats[field].evaluated += 1;
      if (info.match) fieldStats[field].matched += 1;
      else fieldStats[field].mismatches.push({ runId: r.runId, expected: info.expected, actual: info.actual, recordedAt: r.recordedAt });
    }
  }
  const fields = Object.entries(fieldStats)
    .map(([field, s]) => ({
      field,
      evaluated: s.evaluated,
      matched: s.matched,
      accuracy: s.evaluated === 0 ? null : s.matched / s.evaluated,
      recent_mismatches: s.mismatches.slice(-3),
    }))
    .sort((a, b) => (a.accuracy ?? 1) - (b.accuracy ?? 1));

  return {
    skill: skillName,
    total_runs: windowed.length,
    evaluated_runs: evaluated.length,
    pending_runs: pending,
    matched_runs: matchedRuns,
    overall_accuracy: evaluated.length === 0 ? null : matchedRuns / evaluated.length,
    fields,
  };
}

function rollupAll(options = {}) {
  return listSkillsWithPredictions().map((s) => rollupSkill(s, options));
}

function identifyWorstFields(options = {}) {
  const minSamples = options.minSamples ?? 3;
  const maxAccuracy = options.maxAccuracy ?? 0.7;
  const limit = options.limit ?? 5;
  const rollups = rollupAll(options);
  const flagged = [];
  for (const r of rollups) {
    for (const f of r.fields) {
      if (f.evaluated >= minSamples && f.accuracy != null && f.accuracy < maxAccuracy) {
        flagged.push({ skill: r.skill, field: f.field, accuracy: f.accuracy, evaluated: f.evaluated, recent_mismatches: f.recent_mismatches });
      }
    }
  }
  return flagged
    .sort((a, b) => a.accuracy - b.accuracy || b.evaluated - a.evaluated)
    .slice(0, limit);
}

function buildBriefingDigest(options = {}) {
  const rollups = rollupAll(options);
  const totalSkills = rollups.length;
  const skillsWithEval = rollups.filter((r) => r.evaluated_runs > 0);
  const worst = identifyWorstFields(options);

  let tier1;
  if (totalSkills === 0) tier1 = 'Predictions: no skill has logged a prediction yet.';
  else if (skillsWithEval.length === 0) tier1 = `Predictions: ${totalSkills} skills tracked, none with recorded outcomes in window.`;
  else {
    const avg = skillsWithEval.reduce((s, r) => s + (r.overall_accuracy || 0), 0) / skillsWithEval.length;
    const pct = Math.round(avg * 100);
    if (worst.length === 0) tier1 = `Predictions: ${skillsWithEval.length}/${totalSkills} skills evaluated, avg ${pct}% match, no field below threshold.`;
    else tier1 = `Predictions: ${skillsWithEval.length}/${totalSkills} skills evaluated, avg ${pct}% match, ${worst.length} field${worst.length === 1 ? '' : 's'} below threshold.`;
  }
  const tier2 = [];
  for (const r of skillsWithEval) {
    const pct = Math.round((r.overall_accuracy || 0) * 100);
    tier2.push(`${r.skill}: ${r.matched_runs}/${r.evaluated_runs} runs matched (${pct}%)`);
  }
  for (const w of worst) {
    const pct = Math.round(w.accuracy * 100);
    tier2.push(`Calibration gap ${w.skill}.${w.field}: ${pct}% over ${w.evaluated} runs`);
  }
  if (tier2.length === 0) tier2.push('Nothing to surface.');
  return {
    generated_at: new Date().toISOString(),
    window: options,
    tier1,
    tier2,
    tier3: { rollups, worst_fields: worst, total_skills: totalSkills },
    all_clear: worst.length === 0,
  };
}

module.exports = {
  predictionsRoot,
  listSkillsWithPredictions,
  loadSkillPredictions,
  rollupSkill,
  rollupAll,
  identifyWorstFields,
  buildBriefingDigest,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--window-days' && args[i + 1]) {
      opts.windowDays = Number(args[i + 1]);
      i++;
    }
  }
  process.stdout.write(JSON.stringify(buildBriefingDigest(opts), null, 2) + '\n');
}
