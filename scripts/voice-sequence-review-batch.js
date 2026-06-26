#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PARETO_PATH = path.join(ROOT, 'data', 'life-archive', 'voiceprints', 'speaker-pareto-latest.json');
const QUEUE_PATH = path.join(ROOT, 'data', 'life-archive', 'people', 'briefing-voice-queue-latest.json');
const REGISTRY_PATH = path.join(ROOT, 'data', 'life-archive', 'voice-identity-registry.json');
const STATUS_PATH = path.join(ROOT, 'data', 'life-archive', 'voiceprints', 'voice-sequence-review-batch-latest.json');
const SEQUENCE_SCRIPT = path.join(ROOT, 'scripts', 'voice-sample-sequence-review-html.js');

function hasArg(name) {
  return process.argv.includes(name);
}

function argNum(name, fallback) {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeTarget(value) {
  return String(value || '').replace(/^(ExampleCo|known):/, '').trim();
}

function addTarget(targets, value, reason) {
  const target = normalizeTarget(value);
  if (!target) return;
  if (!/^(ExampleCo_voice_[a-z0-9_]+|speaker_\d+|person:[a-z0-9_-]+|[a-z0-9_-]+)$/i.test(target)) return;
  if (!targets.has(target)) targets.set(target, { target, reasons: [] });
  targets.get(target).reasons.push(reason);
}

function collectTargets() {
  const targets = new Map();
  const pareto = readJson(PARETO_PATH, {});
  const queue = readJson(QUEUE_PATH, {});
  const registry = readJson(REGISTRY_PATH, {});

  for (const row of pareto.known || []) addTarget(targets, row.speaker_key || row.display_name, 'pareto_known');
  for (const row of pareto.all_unresolved_relationships || []) {
    addTarget(targets, row.label || row.speaker_key || row.relationship_dossier?.speaker_key, 'pareto_unresolved');
  }
  for (const row of pareto.priority_ExampleCo_relationships || []) {
    addTarget(targets, row.label || row.speaker_key || row.relationship_dossier?.speaker_key, 'pareto_priority');
  }
  for (const row of queue.confirmation_queue || []) {
    addTarget(targets, row.voice_cluster_id || row.ExampleCo_speaker_id, 'briefing_confirmation_queue');
  }
  for (const row of queue.ExampleCo_voice_queue || []) {
    addTarget(targets, row.voice_cluster_id || row.ExampleCo_speaker_id, 'briefing_ExampleCo_queue');
  }
  for (const personId of Object.keys(registry.people || {})) {
    addTarget(targets, `person:${personId}`, 'voice_registry_person');
  }
  return [...targets.values()];
}

function main() {
  const write = hasArg('--write');
  const limit = argNum('--limit', 20);
  const maxTargets = argNum('--max-targets', Infinity);
  const targets = collectTargets().slice(0, maxTargets);
  const report = {
    schema: 'life_archive.voice_sequence_review_batch.v1',
    generated_at: new Date().toISOString(),
    write,
    requested_limit: limit,
    targets_seen: targets.length,
    generated: 0,
    failed: 0,
    results: [],
  };

  for (const row of targets) {
    const args = [SEQUENCE_SCRIPT, row.target, '--limit', String(limit), '--local-file'];
    const run = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const stdoutLines = String(run.stdout || '').split(/\r?\n/).filter(Boolean);
    const result = {
      target: row.target,
      reasons: [...new Set(row.reasons)],
      ok: !run.error && run.status === 0,
      html: stdoutLines[0] ? path.relative(ROOT, stdoutLines[0]).replace(/\\/g, '/') : '',
      manifest: stdoutLines[1] ? path.relative(ROOT, stdoutLines[1]).replace(/\\/g, '/') : '',
      error: run.error?.message || (run.status ? String(run.stderr || '').slice(0, 500) : ''),
    };
    if (result.ok) report.generated += 1;
    else report.failed += 1;
    report.results.push(result);
  }

  saveJson(STATUS_PATH, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) main();
