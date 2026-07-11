#!/usr/bin/env node
/**
 * Build the AS-Norm impostor cohort (Phase B2, Codex amendment 8).
 *
 * Purity-controlled cohort of distinct-voice embeddings for adaptive score
 * normalization. Preferred source: the versioned global recluster artifact
 * (data/life-archive/voiceprints/recluster-latest.json), whose clusters are
 * distinct voices by construction and carry centroids + member otids (the
 * otids power per-trial same-call exclusion). Fallback: one embedding per
 * distinct voice_cluster_id joined from the track probe index and the ECAPA
 * embedding cache by recorded audio_path.
 *
 * Trial-time purity (near-duplicate exclusion vs both trial sides) lives in
 * scripts/lib/voice-score-normalization.js; this builder guarantees entry
 * distinctness and otid provenance.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DATA_ROOT = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data'));
const VP_DIR = path.join(DATA_ROOT, 'life-archive', 'voiceprints');
const RECLUSTER_LATEST = path.join(VP_DIR, 'recluster-latest.json');
const TRACK_PROBE_INDEX = path.join(VP_DIR, 'track-probe-index-latest.json');
const EMBED_CACHE = path.join(VP_DIR, 'ecapa-embeddings');
const OUT_PATH = process.env.OTTER_SPEAKER_ASNORM_COHORT_PATH || path.join(VP_DIR, 'asnorm-cohort-latest.json');

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

function fromRecluster(recluster, cap) {
  const clusters = (recluster?.clusters || []).filter(
    (row) => Array.isArray(row?.centroid) && row.centroid.length,
  );
  clusters.sort((a, b) => Number(b.size || 0) - Number(a.size || 0) || String(a.cluster_id).localeCompare(String(b.cluster_id)));
  return clusters.slice(0, cap).map((row) => ({
    id: row.cluster_id,
    otids: row.otids || [],
    vector: row.centroid,
    size: row.size || 1,
  }));
}

function audioPathTail(value) {
  const s = String(value || '').replace(/\\/g, '/').toLowerCase();
  const idx = s.lastIndexOf('data/otter/audio/');
  return idx >= 0 ? s.slice(idx) : s;
}

function fromCacheAndProbes(cap) {
  const index = readJson(TRACK_PROBE_INDEX, {});
  const byAudio = new Map();
  if (fs.existsSync(EMBED_CACHE)) {
    for (const name of fs.readdirSync(EMBED_CACHE)) {
      if (!name.endsWith('.json')) continue;
      const row = readJson(path.join(EMBED_CACHE, name), null);
      if (!row?.embedding?.vector?.length) continue;
      if (row.embedding?.quality?.usable === false) continue;
      byAudio.set(audioPathTail(row.audio_path), row.embedding.vector);
    }
  }
  const byCluster = new Map();
  for (const probe of index?.probes || []) {
    const cluster = probe.voice_cluster_id || probe.ExampleCo_speaker_id || '';
    if (!cluster || byCluster.has(cluster)) continue;
    const vector = byAudio.get(audioPathTail(probe.probe_audio_path));
    if (!vector) continue;
    byCluster.set(cluster, {
      id: cluster,
      otids: probe.otid ? [probe.otid] : [],
      vector,
      size: 1,
    });
  }
  return [...byCluster.values()]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .slice(0, cap);
}

function buildCohort({ cap = 400 } = {}) {
  const recluster = readJson(RECLUSTER_LATEST, null);
  if (recluster?.clusters?.length) {
    return { source: 'recluster-latest', cohort: fromRecluster(recluster, cap) };
  }
  return { source: 'probe-index-and-embedding-cache', cohort: fromCacheAndProbes(cap) };
}

function main() {
  const cap = Number(argValue('--cap', '400')) || 400;
  const { source, cohort } = buildCohort({ cap });
  const artifact = {
    schema: 'life_archive_voice_asnorm_cohort.v1',
    generated_at: new Date().toISOString(),
    source,
    count: cohort.length,
    cap,
    status: cohort.length >= 30 ? 'ok' : 'insufficient',
    cohort,
  };
  if (process.argv.includes('--write')) saveJson(OUT_PATH, artifact);
  process.stdout.write(
    `${JSON.stringify({ source, count: cohort.length, status: artifact.status, out: process.argv.includes('--write') ? OUT_PATH : null }, null, 2)}\n`,
  );
  if (artifact.status !== 'ok') process.exitCode = 2;
}

if (require.main === module) main();

module.exports = { buildCohort, fromRecluster, fromCacheAndProbes };
