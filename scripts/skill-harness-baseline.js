#!/usr/bin/env node
// skill-harness-baseline.js
//
// Phase 4 of harness-evolution-loop. Captures a baseline snapshot of a skill
// (SKILL.md content hash + chosen quality metrics) so that post-deploy
// metric drops can be flagged and, when paired with a SKILL.md hash change,
// trigger a revert recommendation.
//
// Storage:
//   scheduled-tasks/<skillName>/harness-baseline.json
//
// Schema:
//   {
//     skillName: "video-aurora",
//     skillHash: "<sha256 of SKILL.md>",
//     metrics: { quality: 85, approvalRate: 0.8, ... },
//     savedAt: "2026-05-10T10:00:00.000Z"
//   }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..');

// Tolerances for what counts as a degradation. Configurable per metric.
const DEFAULT_TOLERANCE = {
  // Numeric metrics: a drop greater than this fraction of the baseline is a degradation.
  numericDropFraction: 0.05, // 5% drop
  // Approval rate is sensitive; smaller drops count.
  approvalRateDropAbsolute: 0.05,
};

function skillDir(skillName) {
  return path.join(REPO, 'scheduled-tasks', skillName);
}

function skillFile(skillName) {
  return path.join(skillDir(skillName), 'SKILL.md');
}

function baselineFile(skillName) {
  return path.join(skillDir(skillName), 'harness-baseline.json');
}

function readSkillHash(skillName) {
  const f = skillFile(skillName);
  if (!fs.existsSync(f)) {
    throw new Error(`SKILL.md not found for skill=${skillName} at ${f}`);
  }
  const content = fs.readFileSync(f);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function saveBaseline(skillName, metrics) {
  const skillHash = readSkillHash(skillName);
  const data = {
    skillName,
    skillHash,
    metrics: metrics || {},
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(baselineFile(skillName), JSON.stringify(data, null, 2));
  return data;
}

function loadBaseline(skillName) {
  const f = baselineFile(skillName);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function isDegradation(metricName, baselineValue, currentValue) {
  // A baseline metric the current rollup does not measure is not a regression --
  // absence of a measurement is not the same as a quality drop. Baselines often
  // carry a richer metric set than the live rollup emits.
  if (currentValue === undefined || currentValue === null) return false;
  // A non-finite current value (NaN/Infinity, e.g. from corrupt source data)
  // against a real numeric baseline is a genuine problem, not "no measurement" --
  // it must not slip through the numeric comparison silently as not-a-drop.
  if (typeof baselineValue === 'number' && Number.isFinite(baselineValue)
      && typeof currentValue === 'number' && !Number.isFinite(currentValue)) {
    return true;
  }
  if (typeof baselineValue !== 'number' || typeof currentValue !== 'number') {
    return JSON.stringify(baselineValue) !== JSON.stringify(currentValue);
  }
  if (metricName === 'approvalRate') {
    return baselineValue - currentValue > DEFAULT_TOLERANCE.approvalRateDropAbsolute;
  }
  if (baselineValue <= 0) return false;
  const fractionalDrop = (baselineValue - currentValue) / baselineValue;
  return fractionalDrop > DEFAULT_TOLERANCE.numericDropFraction;
}

function compareToBaseline(skillName, currentMetrics) {
  const baseline = loadBaseline(skillName);
  if (!baseline) {
    return { degraded: false, degradations: [], baseline: null, currentMetrics };
  }
  const degradations = [];
  for (const [metric, baselineValue] of Object.entries(baseline.metrics || {})) {
    const currentValue = currentMetrics ? currentMetrics[metric] : undefined;
    if (isDegradation(metric, baselineValue, currentValue)) {
      degradations.push({ metric, baseline: baselineValue, current: currentValue });
    }
  }
  return {
    degraded: degradations.length > 0,
    degradations,
    baseline,
    currentMetrics,
  };
}

function recommendRevert(skillName, currentMetrics) {
  const baseline = loadBaseline(skillName);
  if (!baseline) {
    return { shouldRevert: false, reason: 'no baseline saved', skillChanged: false };
  }
  const currentHash = readSkillHash(skillName);
  const skillChanged = currentHash !== baseline.skillHash;
  const cmp = compareToBaseline(skillName, currentMetrics);
  if (cmp.degraded && skillChanged) {
    const reasons = cmp.degradations
      .map(d => `${d.metric} dropped from ${d.baseline} to ${d.current}`)
      .join('; ');
    return {
      shouldRevert: true,
      reason: `quality dropped after SKILL.md change: ${reasons}`,
      skillChanged: true,
      degradations: cmp.degradations,
      baselineHash: baseline.skillHash,
      currentHash,
    };
  }
  return {
    shouldRevert: false,
    reason: skillChanged
      ? 'SKILL.md changed but no degradation detected'
      : 'SKILL.md unchanged since baseline',
    skillChanged,
    degradations: cmp.degradations,
  };
}

module.exports = {
  saveBaseline,
  loadBaseline,
  compareToBaseline,
  recommendRevert,
  readSkillHash,
  baselineFile,
  DEFAULT_TOLERANCE,
};
