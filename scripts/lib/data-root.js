'use strict';
const fs = require('fs');
const path = require('path');

// C6 one-data-root contract.
//
// WHY: two data roots exist -- the REPO-relative data/ dir (git-tracked,
// stubs/fixtures live here) and SECONDBRAIN_DATA_DIR (default
// /opt/secondbrain/data on EC2, the LIVE artifact store the cron writers
// actually target). Three incidents in one day (voice-confirmation card,
// people-files-snapshot card, memory-delta-snapshot card) were caused by a
// reader probing only one root while the writer used the other: a stale
// REPO stub (empty registry, calls_seen:0, 0/0 completeness -- committed to
// git and re-stamped on every checkout) shadowed fresh live data, or a fresh
// live write was invisible to a REPO-only reader.
//
// This module is the ONE shared resolver: it reads BOTH roots and returns
// the copy with the most real substance, so a stale/empty stub can never
// win over a copy with actual data, breaking ties by freshness
// (generated_at, then mtime). Extracted from the proven
// readFreshestVoiceArtifact implementation (scripts/refresh-briefing-
// generated-sections.js, commit ddc13805) so every card-builder reader/
// writer shares one code path instead of re-deriving its own candidate list.

// Absolute path into the live cloud/desktop data store. On EC2 the cron runs
// from the REPO checkout but the durable artifacts live under
// SECONDBRAIN_DATA_DIR (/opt/secondbrain/data), NOT REPO/data.
function dataDirPath(...segments) {
  const base = process.env.SECONDBRAIN_DATA_DIR || '/opt/secondbrain/data';
  return path.join(base, ...segments);
}

function repoRoot() {
  return path.resolve(process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..', '..'));
}

function readJsonFileMaybe(absPath) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

// Freshness stamp for a candidate artifact: prefer the embedded generated_at
// (authoritative), fall back to the file mtime, and treat a missing/
// unparseable file as -Infinity so it can never win.
function artifactFreshnessMs(json, absPath) {
  const gen = json && json.generated_at ? Date.parse(json.generated_at) : NaN;
  if (Number.isFinite(gen)) return gen;
  try {
    return fs.statSync(absPath).mtimeMs;
  } catch {
    return -Infinity;
  }
}

// Substance score: how much real data a candidate ExampleCos. A stale STUB (an
// empty registry {voice_cluster_resolutions:{}}, a calls_seen:0 roster, a
// 0-real-calls completeness snapshot, an empty allEntries list) scores 0 and
// must never beat a copy with actual data, even when the stub happens to
// carry a newer checkout mtime.
//
// Schema-agnostic by design: this resolver serves multiple unrelated
// artifact shapes (voice registries, memory-delta snapshots, people-files
// snapshots, and whatever a future caller passes). A hand-maintained
// allowlist of known field names (calls_seen, commits, totalFiles, ...) risks
// an accidental cross-domain collision -- e.g. a voice artifact that happens
// to carry an unrelated "commits" key would silently pick up a memory-delta
// scoring rule. Instead, recursively count every array element and every
// OBJECT KEY (each named entry -- a person, an enrollment, a queued item --
// is one fact, whether or not its own value is further populated) plus every
// positive finite numeric leaf, depth-capped so a pathological payload can't
// blow the stack. Top-level scalar metadata (generated_at, hours, empty
// flags, free-text subjects) intentionally scores 0 on its own -- only
// container size (arrays/objects) and positive counters carry substance, so
// "more real content, at any depth" always outscores an empty stub without
// caring what the field is called.
const SUBSTANCE_MAX_DEPTH = 6;
function artifactSubstance(json, depth = 0) {
  if (depth > SUBSTANCE_MAX_DEPTH) return 0;
  if (Array.isArray(json)) {
    let score = json.length;
    for (const item of json) score += artifactSubstance(item, depth + 1);
    return score;
  }
  if (json && typeof json === 'object') {
    const keys = Object.keys(json);
    let score = keys.length;
    for (const key of keys) score += artifactSubstance(json[key], depth + 1);
    return score;
  }
  if (typeof json === 'number' && Number.isFinite(json) && json > 0) return json;
  return 0;
}

// The two absolute candidate paths for a data/-relative artifact path, in a
// stable order (REPO copy first, then the SECONDBRAIN_DATA_DIR copy). `rel`
// is relative to the data/ dir, e.g. 'agent/people-files-snapshot.json' or
// 'life-archive/voiceprints/ecapa-speaker-resolver-latest.json'.
function dataRootCandidates(rel, opts = {}) {
  const relPosix = String(rel || '').replace(/\\/g, '/');
  const segments = relPosix.split('/').filter(Boolean);
  const repo = opts.repo || repoRoot();
  const dataDir = opts.dataDir || dataDirPath();
  return [...new Set([path.join(repo, 'data', ...segments), path.join(dataDir, ...segments)])];
}

// Read BOTH data roots for `rel` and return the copy with the most real
// substance, tie-broken by freshness (generated_at, then mtime), so a stale/
// empty stub can never shadow live data. `rel` is data/-relative (e.g.
// 'agent/people-files-snapshot.json'). Returns { json, absPath, freshnessMs }
// -- json is null when neither candidate parses.
function resolveDataArtifact(rel, opts = {}) {
  const candidates = dataRootCandidates(rel, opts);
  let best = null;
  let bestPath = null;
  let bestSubstance = -1;
  let bestFreshness = -Infinity;
  for (const abs of candidates) {
    const json = readJsonFileMaybe(abs);
    if (!json) continue;
    const substance = artifactSubstance(json);
    const freshness = artifactFreshnessMs(json, abs);
    const wins =
      best === null ||
      substance > bestSubstance ||
      (substance === bestSubstance && freshness > bestFreshness);
    if (wins) {
      best = json;
      bestPath = abs;
      bestSubstance = substance;
      bestFreshness = freshness;
    }
  }
  return {
    json: best,
    absPath: bestPath,
    freshnessMs: Number.isFinite(bestFreshness) ? bestFreshness : null,
  };
}

// The single absolute path a writer should target for `rel`: SECONDBRAIN_DATA_DIR
// when set (the live cloud/desktop store), else the REPO-relative data/ dir so
// local/test behavior is unchanged. Ensures the parent directory exists.
function writeDataArtifact(rel, data, opts = {}) {
  const relPosix = String(rel || '').replace(/\\/g, '/');
  const segments = relPosix.split('/').filter(Boolean);
  const dataDir = opts.dataDir || process.env.SECONDBRAIN_DATA_DIR || path.join(repoRoot(), 'data');
  const absPath = path.join(dataDir, ...segments);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(absPath, body);
  return absPath;
}

module.exports = {
  dataDirPath,
  dataRootCandidates,
  resolveDataArtifact,
  writeDataArtifact,
  artifactSubstance,
  artifactFreshnessMs,
};
