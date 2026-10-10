#!/usr/bin/env node
'use strict';

// Post-Save voiceprint re-match, run by voice-confirmation-backprop.js after
// ExampleCo's Save has been applied, never inside the POST handler.
//
// Scores every unknown recluster cluster against the person ExampleCo just saved and
// records near misses as provisional proposals for his review. Auto-attach is
// OFF and this script never writes the registry. Evidence, 2026-09-23
// historical back-test (28 Saves replayed against the recluster-runs snapshot
// nearest before each Save; sweep centroid 0.70-0.92, share 0.5-1.0, min pair
// 0.45-0.68): the best zero-false-positive gate (0.92 / 0.9 / 0.55) recovered
// 1 of 13 later same-person merges (7.7 percent, ship bar 20 percent) and did
// not reproduce the PRIVATE_NAME merge (centroid 0.866, share 0.57, min pair 0.586).
// Re-run that back-test before enabling any gate here.
//
// Bounded: a hard deadline (default 60 s). On timeout it logs and exits 0
// without writing anything.

const fs = require('node:fs');
const path = require('node:path');
const {
  memberAudioPath,
  mergeProposals,
  proposalsPath,
  readProposals,
  rematchCandidates,
  resolutionStateFor,
  writeProposalsAtomic,
} = require('./lib/voice-post-save-rematch.js');

const REPO = path.resolve(__dirname, '..');

function argValue(name, argv) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? String(argv[index + 1]) : '';
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function normalizedAudioPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function loadVectorsForPaths(cacheDir, wanted, deadline, now) {
  const index = new Map();
  let names = [];
  try {
    names = fs.readdirSync(cacheDir).filter((name) => name.endsWith('.json'));
  } catch {
    return { index, timedOut: false };
  }
  for (const name of names) {
    if (now() > deadline) return { index, timedOut: true };
    let row = null;
    try {
      row = JSON.parse(fs.readFileSync(path.join(cacheDir, name), 'utf8'));
    } catch {
      continue;
    }
    const audioPath = normalizedAudioPath(row?.audio_path);
    if (!wanted.has(audioPath)) continue;
    if (!row?.embedding?.vector?.length || row.embedding?.quality?.usable === false) continue;
    index.set(audioPath, row.embedding.vector);
    if (index.size >= wanted.size) break;
  }
  return { index, timedOut: false };
}

function savedOtidsForRequest(actionsFile, requestId, clusterId) {
  if (!requestId) return null;
  let lines = [];
  try {
    lines = fs.readFileSync(actionsFile, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let row = null;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (row?.gitPeopleSyncRequestId !== requestId) continue;
    if (clusterId && row.voiceClusterId && row.voiceClusterId !== clusterId) continue;
    return Array.isArray(row.otidsAtDecision) && row.otidsAtDecision.length ? row.otidsAtDecision : null;
  }
  return null;
}

function readActionRows(actionsFile) {
  try {
    return fs
      .readFileSync(actionsFile, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function runPostSaveRematch({
  dataRoot,
  personId,
  savedClusterId,
  requestId = '',
  write = false,
  timeoutMs = 60000,
  now = () => Date.now(),
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const startedMs = now();
  const deadline = startedMs + timeoutMs;
  const voiceprints = path.join(dataRoot, 'life-archive', 'voiceprints');
  const actionsFile = path.join(dataRoot, 'life-archive', 'people', 'voice-confirmation-actions.jsonl');
  const base = {
    schema: 'life_archive_voice_post_save_rematch.v1',
    started_at: new Date(startedMs).toISOString(),
    person_id: personId,
    saved_cluster_id: savedClusterId,
    source_save_request_id: requestId,
    auto_attach: false,
  };
  if (!personId || !savedClusterId) return { ...base, ok: false, phase: 'missing_arguments', wrote: false };
  const recluster = readJson(path.join(voiceprints, 'recluster-latest.json'), null);
  if (!recluster?.clusters?.length) return { ...base, ok: true, phase: 'no_recluster_artifact', wrote: false };
  const registry = readJson(path.join(dataRoot, 'life-archive', 'voice-identity-registry.json'), {}) || {};
  const wanted = new Set();
  for (const cluster of recluster.clusters) {
    for (const member of cluster.members || []) {
      const audio = normalizedAudioPath(memberAudioPath(member));
      if (audio) wanted.add(audio);
    }
  }
  const vectors = loadVectorsForPaths(path.join(voiceprints, 'ecapa-embeddings'), wanted, deadline, now);
  if (vectors.timedOut) {
    log(`post-save rematch timed out loading embeddings after ${now() - startedMs} ms; nothing written`);
    return { ...base, ok: true, phase: 'timed_out', wrote: false };
  }
  // Measured 2026-09-23 on EC2: the full embedding scan plus scoring took
  // about 8 s of the 60 s budget with 26k embedding files.
  const savedOtids = savedOtidsForRequest(actionsFile, requestId, savedClusterId);
  if (requestId && !savedOtids) {
    log(`post-save rematch: no otidsAtDecision for request ${requestId}; scoring every saved-cluster member`);
  }
  const result = rematchCandidates({
    recluster,
    personId,
    savedClusterId,
    savedOtids,
    vectorFor: (member) => vectors.index.get(normalizedAudioPath(memberAudioPath(member))) || null,
    gate: null,
    deadline,
    now,
  });
  if (result.timedOut) {
    log(`post-save rematch timed out scoring after ${now() - startedMs} ms; nothing written`);
    return { ...base, ok: true, phase: 'timed_out', wrote: false };
  }
  const proposedAt = new Date(now()).toISOString();
  const contactFile =
    registry?.acoustic_group_resolutions?.[savedClusterId]?.contact_file ||
    registry?.people?.[personId]?.contact_file ||
    '';
  const incoming = result.rows
    .filter((row) => row.decision === 'propose')
    .map((row) => ({
      cluster_id: row.cluster_id,
      person_id: row.person_id,
      contact_file: contactFile,
      centroid: row.centroid,
      share: row.share,
      min_pair: row.min_pair,
      runner_up_person_id: row.runner_up_person_id,
      runner_up_centroid: row.runner_up_centroid,
      call_count: row.call_count,
      source_save_request_id: requestId,
      proposed_at: proposedAt,
    }));
  const file = proposalsPath(dataRoot);
  const merged = mergeProposals(readProposals(file), incoming, {
    ...resolutionStateFor(registry, readActionRows(actionsFile)),
    nowMs: now(),
  });
  if (write) writeProposalsAtomic(file, merged);
  return {
    ...base,
    ok: true,
    phase: 'completed',
    wrote: Boolean(write),
    person_vectors: result.personVectorCount,
    proposals_added: incoming.length,
    proposals_total: merged.length,
    proposals: incoming,
    elapsed_ms: now() - startedMs,
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const dataRoot = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data'));
  const report = runPostSaveRematch({
    dataRoot,
    personId: argValue('--person-id', argv),
    savedClusterId: argValue('--saved-cluster-id', argv),
    requestId: argValue('--job-request-id', argv),
    write: argv.includes('--write'),
    timeoutMs: Number(argValue('--timeout-ms', argv) || 60000),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

module.exports = { runPostSaveRematch, readActionRows };
