#!/usr/bin/env node
// check-harness-regressions.js
//
// Phase 5 of harness-evolution-loop. For each priority skill, load the
// current baseline, compare against the latest measured quality metrics,
// and append any revert recommendations to
// data/agent/revert-recommendations.jsonl for later review.
//
// Intended caller: scheduled-tasks/nightly-heal-tests/ (or a sibling cron)
// once per night, AFTER the night's quality scoring step has produced
// per-skill metrics.
//
// Usage as a library:
//   const { checkRegressions } = require('./check-harness-regressions');
//   const result = checkRegressions({ skillNames, currentMetricsBySkill });
//
// Usage as a CLI:
//   node scripts/check-harness-regressions.js \
//     --skills video-aurora,captions-aurora \
//     --metrics-file data/agent/latest-skill-metrics.json
//
// The metrics file format is:
//   { "video-aurora": { "quality": 87 }, "captions-aurora": { "quality": 90 }, ... }

const fs = require('fs');
const path = require('path');

const REPO = process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..');
const baseline = require('./skill-harness-baseline');

const PRIORITY_SKILLS = [
  'video-aurora',
  'captions-aurora',
  'thumbnail-aurora',
  'daily-briefing',
  'daily-linkedin-scan',
];

function jsonlPath() {
  return path.join(REPO, 'data', 'agent', 'revert-recommendations.jsonl');
}

function appendRecommendation(rec) {
  const file = jsonlPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
}

function checkRegressions({ skillNames, currentMetricsBySkill }) {
  const recommendations = [];
  const skipped = [];
  const skills = skillNames && skillNames.length ? skillNames : PRIORITY_SKILLS;
  for (const skillName of skills) {
    const current = (currentMetricsBySkill || {})[skillName];
    const existingBaseline = baseline.loadBaseline(skillName);
    if (!existingBaseline) {
      skipped.push({ skillName, reason: 'no baseline saved' });
      continue;
    }
    if (!current) {
      skipped.push({ skillName, reason: 'no current metrics provided' });
      continue;
    }
    let rec;
    try {
      rec = baseline.recommendRevert(skillName, current);
    } catch (err) {
      skipped.push({ skillName, reason: `recommend error: ${err.message}` });
      continue;
    }
    if (rec.shouldRevert) {
      const fullRec = {
        timestamp: new Date().toISOString(),
        skillName,
        ...rec,
        currentMetrics: current,
      };
      recommendations.push(fullRec);
      appendRecommendation(fullRec);
    }
  }
  return { recommendations, skipped };
}

function parseCliArgs(argv) {
  const out = { skills: null, metricsFile: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skills' && argv[i + 1]) {
      out.skills = argv[i + 1].split(',').map(s => s.trim()).filter(Boolean);
      i++;
    } else if (argv[i] === '--metrics-file' && argv[i + 1]) {
      out.metricsFile = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main() {
  const { skills, metricsFile } = parseCliArgs(process.argv.slice(2));
  let currentMetricsBySkill = {};
  if (metricsFile) {
    const fullPath = path.isAbsolute(metricsFile) ? metricsFile : path.join(REPO, metricsFile);
    if (fs.existsSync(fullPath)) {
      currentMetricsBySkill = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } else {
      console.error(`metrics file not found: ${fullPath}`);
      process.exit(1);
    }
  } else {
    // No --metrics-file given: auto-rollup from existing artifacts.
    const rollup = require('./skill-metrics-rollup');
    currentMetricsBySkill = rollup.rollupAll();
  }
  const result = checkRegressions({ skillNames: skills, currentMetricsBySkill });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

module.exports = { checkRegressions, PRIORITY_SKILLS, jsonlPath };

if (require.main === module) {
  main();
}
