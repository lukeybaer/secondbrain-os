#!/usr/bin/env node
/**
 * Assemble the weekly uncertainty-ranked labeling queue (Phase C3 of
 * dev-plans/voiceprint-matching-audit-2026-07-11.html).
 *
 * Reads the three lanes from their existing artifacts and ranks them into one
 * capped weekly budget the briefing voice card surfaces:
 *   - re-enrollment lane          (briefing-voice-queue-latest.json)
 *   - recurring ExampleCo lane       (briefing-voice-queue-latest.json)
 *   - audit backlog (weakest auto) (identity-fusion-latest.json)
 */

const fs = require('fs');
const path = require('path');
const { buildWeeklyLabelingQueue } = require('./lib/voice-people-note-gate');

const REPO = path.resolve(__dirname, '..');
const DATA_ROOT = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data'));
const VP_DIR = path.join(DATA_ROOT, 'life-archive', 'voiceprints');
const VOICE_QUEUE = path.join(DATA_ROOT, 'life-archive', 'people', 'briefing-voice-queue-latest.json');
const FUSION = path.join(VP_DIR, 'identity-fusion-latest.json');
const OUT_PATH = process.env.VOICE_WEEKLY_QUEUE_PATH || path.join(VP_DIR, 'weekly-labeling-queue-latest.json');

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

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function build({ weeklyBudget = 10 } = {}) {
  const voiceQueue = readJson(VOICE_QUEUE, {});
  const fusion = readJson(FUSION, {});
  const auditBacklog = (fusion.decisions || [])
    .filter((d) => d.tier === 'auto')
    .sort((a, b) => Number(a.fused_risk_score || 0) - Number(b.fused_risk_score || 0))
    .slice(0, weeklyBudget)
    .map((d) => ({
      otid: d.target?.otid || '',
      speaker_model_label: d.target?.speaker_model_label || '',
      fused_risk_score: d.fused_risk_score,
    }));
  const queue = buildWeeklyLabelingQueue({
    reenrollment: voiceQueue.reenrollment_queue || [],
    recurringExampleCos: voiceQueue.ExampleCo_voice_queue || [],
    auditBacklog,
    weeklyBudget,
  });
  return {
    ...queue,
    generated_at: new Date().toISOString(),
    sources: {
      voice_queue_present: Boolean(voiceQueue.schema),
      fusion_present: Boolean(fusion.schema),
    },
  };
}

function main() {
  const queue = build({ weeklyBudget: Number(argValue('--budget', '10')) || 10 });
  if (process.argv.includes('--write')) saveJson(OUT_PATH, queue);
  process.stdout.write(`${JSON.stringify({ schema: queue.schema, items: queue.items.length, lane_counts: queue.lane_counts, out: process.argv.includes('--write') ? OUT_PATH : null }, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = { build };
