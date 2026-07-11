#!/usr/bin/env node
/**
 * Apply Bayesian identity fusion over the resolver's per-track output (Phase C2
 * of dev-plans/voiceprint-matching-audit-2026-07-11.html).
 *
 * Reads the enriched speaker_identity_tracks (which carry the acoustic match +
 * calibration probability from the B2 resolver) and the C1 context-priors
 * artifact, fuses them into a risk score per track, assigns a tier
 * (auto / review / ExampleCo), and writes:
 *   - data/life-archive/voiceprints/identity-fusion-latest.json (all decisions
 *     with full provenance)
 *   - the auto-tier subset, which is what people-notes curation (Phase C3) may
 *     consume, and which the precision audit samples.
 *
 * This never writes identity back onto enriched files or the registry: fusion
 * is a decision layer with provenance, and auto-tier promotions still flow
 * through the existing confirmation/apply path so the audit gates them.
 */

const fs = require('fs');
const path = require('path');
const { fuseTrack } = require('./lib/voice-identity-fusion');

const REPO = path.resolve(__dirname, '..');
const DATA_ROOT = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data'));
const ENRICHED_DIR = path.join(DATA_ROOT, 'otter', 'enriched');
const VP_DIR = path.join(DATA_ROOT, 'life-archive', 'voiceprints');
const CONTEXT_PRIORS = path.join(VP_DIR, 'context-priors-latest.json');
const OUT_PATH = process.env.OTTER_IDENTITY_FUSION_PATH || path.join(VP_DIR, 'identity-fusion-latest.json');

const OPS = {
  auto_gate: Number(process.env.VOICE_FUSION_AUTO_GATE || '0.999') || 0.999,
  review_floor: Number(process.env.VOICE_FUSION_REVIEW_FLOOR || '0.9') || 0.9,
  min_net_speech_seconds: Number(process.env.SPEAKER_MIN_NET_SPEECH_SECONDS || '10') || 10,
};

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

function argList(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return new Set();
  return new Set(String(process.argv[i + 1]).split(',').map((s) => s.trim()).filter(Boolean));
}

// Index context-prior rows by otid + speaker label so each track gets only its
// own evidence, and carry the target cluster for the circularity guard.
function priorsByTrack(artifact) {
  const map = new Map();
  for (const row of artifact?.rows || []) {
    const otid = row?.target?.otid || '';
    const label = String(row?.target?.speaker_model_label ?? '');
    const key = `${otid}|${label}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function fuseAll({ otids = new Set() } = {}) {
  const priors = priorsByTrack(readJson(CONTEXT_PRIORS, { rows: [] }));
  const decisions = [];
  const tierCounts = { auto: 0, review: 0, ExampleCo: 0 };
  if (!fs.existsSync(ENRICHED_DIR)) {
    return { decisions, tierCounts, enriched_files: 0, context_priors_present: false };
  }
  let files = 0;
  for (const name of fs.readdirSync(ENRICHED_DIR)) {
    if (!name.endsWith('.json')) continue;
    const enriched = readJson(path.join(ENRICHED_DIR, name), {});
    const otid = String(enriched.otid || path.basename(name, '.json'));
    if (otids.size && !otids.has(otid)) continue;
    files += 1;
    const tracks = enriched.speaker_identity_tracks || {};
    for (const [label, track] of Object.entries(tracks)) {
      // ExampleCo-confirmed exact truth is not a fusion decision; skip.
      if (track.identity_tier === 'confirmed_by_ExampleCo_cluster') continue;
      const match = track.voice_embedding_match || {};
      const acoustic = {
        person_id: track.person_id || match.person_id || null,
        display_name: track.resolved_person || match.display_name || null,
        score: match.score ?? null,
        margin: match.margin ?? null,
        probability: track.calibration?.probability ?? null,
      };
      const key = `${otid}|${label}`;
      const result = fuseTrack({
        target: { otid, speaker_model_label: String(label), voice_cluster_id: track.voice_cluster_id || '' },
        acoustic,
        netSpeechSeconds: track.net_speech_seconds ?? null,
        priorRows: priors.get(key) || [],
        ops: OPS,
      });
      tierCounts[result.tier] = (tierCounts[result.tier] || 0) + 1;
      decisions.push(result);
    }
  }
  return { decisions, tierCounts, enriched_files: files, context_priors_present: priors.size > 0 };
}

function main() {
  const { decisions, tierCounts, enriched_files, context_priors_present } = fuseAll({
    otids: argList('--otids'),
  });
  const autoTier = decisions.filter((d) => d.tier === 'auto');
  const artifact = {
    schema: 'life_archive_voice_identity_fusion.v1',
    generated_at: new Date().toISOString(),
    ops: OPS,
    score_kind: 'uncertified_risk_score',
    note: 'Fused values are risk scores, not certified probabilities, until voice-precision-audit certifies the auto-tier operating point. Coverage and precision are reported separately.',
    enriched_files,
    context_priors_present,
    tier_counts: tierCounts,
    auto_tier_count: autoTier.length,
    decisions,
  };
  if (process.argv.includes('--write')) saveJson(OUT_PATH, artifact);
  process.stdout.write(
    `${JSON.stringify({ schema: artifact.schema, generated_at: artifact.generated_at, tier_counts: tierCounts, auto_tier_count: autoTier.length, context_priors_present, out: process.argv.includes('--write') ? OUT_PATH : null }, null, 2)}\n`,
  );
}

if (require.main === module) main();

module.exports = { fuseAll, priorsByTrack, OPS };
