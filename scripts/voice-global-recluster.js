#!/usr/bin/env node
/**
 * Nightly GLOBAL re-clustering of unknown voice embeddings with stability
 * discipline (Phase B3 / item 8 of dev-plans/voiceprint-matching-audit-2026-07-11.html,
 * Codex amendment 10).
 *
 * Replaces the resolver's greedy, order-dependent, batch-scoped unknown
 * grouping with a full-corpus agglomerative pass:
 *
 * - Complete-linkage agglomerative clustering on cosine similarity. A merge
 *   requires BOTH the centroid similarity >= --threshold (default 0.62, the
 *   resolver's UNKNOWN_CLUSTER_SCORE semantics) AND the complete-linkage
 *   minimum cross-pair similarity >= --pair-floor (default 0.68, the
 *   resolver's UNKNOWN_CLUSTER_MIN_PAIR_SCORE semantics).
 * - Cannot-link constraints: registry voice_cluster_denials (ExampleCo denial
 *   records: a denied person/cluster combination never joins that person),
 *   and same-otid different-Otter-label pairs (two labels in the same call
 *   are different people unless pair similarity >= --same-call-gate, default
 *   0.82, mirroring the resolver's same-call gate).
 * - Frozen ids: a cluster containing a member with a ExampleCo confirmation
 *   (voice_cluster_resolutions / acoustic_group_resolutions) keeps that
 *   confirmed identity and its durable id. Other members may join it only
 *   above --frozen-threshold (default 0.70), and joining never renames or
 *   reassigns the confirmed identity. Two different confirmed identities
 *   never merge.
 * - Stability discipline: every run writes a versioned artifact
 *   data/life-archive/voiceprints/recluster-runs/<runId>.json plus
 *   recluster-latest.json. New clusters inherit a previous run's cluster id
 *   by maximum member overlap (>= 50% of the previous cluster's members that
 *   are present this run); otherwise a new id is minted as
 *   unknown_voice_ecapa_<sha16 of the sorted member seed>, consistent with
 *   the resolver's id scheme. Splits and merges land in a ledger with member
 *   counts; merges or splits touching a human-confirmed cluster are marked
 *   review_required: true and a merge is NOT applied to the confirmed
 *   cluster: the artifact keeps the confirmed cluster and the other previous
 *   cluster separate, and only proposes the union in the ledger.
 *
 * O(n^2) pairwise similarity is acceptable up to ~10k embeddings; the
 * --max-embeddings cap (default 10000) fails loud instead of silently
 * sampling.
 *
 * Data root follows the section 4.5 contract:
 *   SECONDBRAIN_DATA_DIR || <repo>/data
 *
 * Usage:
 *   node scripts/voice-global-recluster.js                 # dry run, prints report
 *   node scripts/voice-global-recluster.js --write         # persists run + latest artifacts
 *   Flags: --threshold, --pair-floor, --frozen-threshold, --same-call-gate,
 *          --max-embeddings, --run-id, --previous <path>, --write
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  canonicalDisplayName,
  canonicalSpeakerId,
  confirmedVoiceprintPerson,
} = require('./lib/canonical-speaker-identity');
const { bestPersonMatch, buildCanonicalPersonMap } = require('./lib/voice-reference-people');
const { buildAcousticAssignmentAudit } = require('./lib/voice-name-conflicts');
const { referenceMatchDecision } = require('./lib/voice-score-normalization');
const { saveJsonAtomic, withReclusterPublishLock } = require('./lib/recluster-publish-lock');

const REPO = path.resolve(__dirname, '..');
const SPEAKER_BACKEND = String(process.env.VOICE_SPEAKER_BACKEND || 'ecapa').toLowerCase();

const DEFAULTS = {
  threshold: Number(
    process.env.SPEAKER_UNKNOWN_CLUSTER_SCORE || process.env.ECAPA_UNKNOWN_CLUSTER_SCORE || '0.62',
  ),
  pairFloor: Number(
    process.env.SPEAKER_UNKNOWN_CLUSTER_MIN_PAIR_SCORE ||
      process.env.ECAPA_UNKNOWN_CLUSTER_MIN_PAIR_SCORE ||
      '0.68',
  ),
  frozenThreshold: Number(process.env.VOICE_RECLUSTER_FROZEN_THRESHOLD || '0.70'),
  sameCallGate: Number(
    process.env.SPEAKER_UNKNOWN_CLUSTER_SAME_CALL_DIFFERENT_LABEL_SCORE ||
      process.env.ECAPA_UNKNOWN_CLUSTER_SAME_CALL_DIFFERENT_LABEL_SCORE ||
      '0.82',
  ),
  referenceMatchScore: Number(
    process.env.SPEAKER_MATCH_SCORE || process.env.ECAPA_MATCH_SCORE || '0.56',
  ),
  referenceMatchMargin: Number(
    process.env.SPEAKER_MATCH_MARGIN || process.env.ECAPA_MATCH_MARGIN || '0.06',
  ),
  maxEmbeddings: Number(process.env.VOICE_RECLUSTER_MAX_EMBEDDINGS || '10000'),
};

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  saveJsonAtomic(file, value);
}

function sha16(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
}

function cosine(a, b) {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  const n = Math.min(a?.length || 0, b?.length || 0);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

function meanVector(vectors) {
  if (!vectors.length) return [];
  const n = vectors[0].length;
  const out = Array(n).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < n; i += 1) out[i] += vector[i] || 0;
  }
  const mean = out.map((v) => v / vectors.length);
  const norm = Math.sqrt(mean.reduce((sum, v) => sum + v * v, 0));
  return norm ? mean.map((v) => v / norm) : mean;
}

// Section 4.5 contract: every reader/writer resolves its data root the same
// way (SECONDBRAIN_DATA_DIR || REPO/data). Same layout as the resolver.
function resolvePaths(dataDirOverride) {
  const dataDir = path.resolve(
    dataDirOverride || process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data'),
  );
  const vpDir = path.join(dataDir, 'life-archive', 'voiceprints');
  return {
    dataDir,
    vpDir,
    registry: path.join(dataDir, 'life-archive', 'voice-identity-registry.json'),
    contactAliases: path.join(dataDir, 'agent', 'voiceprint-contact-aliases.json'),
    probeIndex:
      process.env.OTTER_TRACK_PROBE_INDEX_PATH || path.join(vpDir, 'track-probe-index-latest.json'),
    reviewQueue: path.join(vpDir, 'voice-review-queue.json'),
    embedCacheDir: path.join(vpDir, `${SPEAKER_BACKEND}-embeddings`),
    runsDir: path.join(vpDir, 'recluster-runs'),
    latest: path.join(vpDir, 'recluster-latest.json'),
    scoreCalibration: path.join(vpDir, 'score-calibration-latest.json'),
  };
}

function normPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function canonicalDataPath(p) {
  const normalized = normPath(p);
  if (normalized.startsWith('data/')) return normalized;
  // Probe builders rooted at SECONDBRAIN_DATA_DIR persist paths relative to
  // that root (otter/audio/...), while embedding cache rows historically use
  // repo-relative data/otter/audio/... paths. They identify the same file.
  if (normalized.startsWith('otter/')) return `data/${normalized}`;
  const marker = normalized.lastIndexOf('/data/');
  return marker >= 0 ? `data/${normalized.slice(marker + '/data/'.length)}` : normalized;
}

// Same discovery approach as the resolver's candidateRows(): the track probe
// index plus the shared review queue. otid|label is the observation key, not
// identity: the same diarized track may carry a newer generated source id in
// the index and a stale one in the queue, but it is still exactly one acoustic
// sample. The index is authoritative because it is ordered first.
function discoverTrackRows(paths) {
  const index = readJson(paths.probeIndex, {});
  const probeRows = (index.probes || []).map((row) => ({
    source: 'track-probe-index',
    otid: row.otid,
    title: row.title,
    speaker_model_label: String(row.speaker_model_label || ''),
    voice_cluster_id: row.voice_cluster_id || row.unknown_speaker_id || '',
    probe_audio_path: row.probe_audio_path || '',
    source_revision: row.source_revision || '',
    identity_grade: row.identity_grade !== false,
    evidence_tier: row.evidence_tier || row.probe_quality?.tier || 'identity_grade',
  }));
  const queue = readJson(paths.reviewQueue, {});
  const queueRows = (Array.isArray(queue.items) ? queue.items : []).map((row) => ({
    source: 'voice-review-queue',
    otid: row.otid,
    title: row.title,
    speaker_model_label: String(row.speaker_model_label || ''),
    voice_cluster_id:
      row.voice_cluster_id || row.canonical_speaker_id || row.unknown_speaker_id || '',
    probe_audio_path: row.probe_audio_path || '',
    source_revision: row.source_revision || '',
    identity_grade: row.identity_grade !== false,
    evidence_tier: row.evidence_tier || row.probe_quality?.tier || 'legacy_unspecified',
  }));
  const byObservation = new Map();
  const out = [];
  for (const row of [...probeRows, ...queueRows]) {
    const observationKey = `${row.otid}|${row.speaker_model_label}`;
    const sourceVoiceClusterId = String(row.voice_cluster_id || '');
    const existing = byObservation.get(observationKey);
    if (existing) {
      if (
        sourceVoiceClusterId &&
        !existing.source_voice_cluster_ids.includes(sourceVoiceClusterId)
      ) {
        existing.source_voice_cluster_ids.push(sourceVoiceClusterId);
      }
      if (
        row.probe_audio_path &&
        !existing.source_probe_audio_paths.includes(row.probe_audio_path)
      ) {
        existing.source_probe_audio_paths.push(row.probe_audio_path);
      }
      if (
        row.source_revision &&
        !existing.source_revisions.includes(row.source_revision)
      ) {
        existing.source_revisions.push(row.source_revision);
      }
      continue;
    }
    const discovered = {
      ...row,
      track_key: `${observationKey}|${row.voice_cluster_id}`,
      observation_key: observationKey,
      source_voice_cluster_ids: sourceVoiceClusterId ? [sourceVoiceClusterId] : [],
      source_probe_audio_paths: row.probe_audio_path ? [row.probe_audio_path] : [],
      source_revisions: row.source_revision ? [row.source_revision] : [],
    };
    byObservation.set(observationKey, discovered);
    out.push(discovered);
  }
  for (const row of out) {
    row.source_voice_cluster_ids.sort();
    row.source_revisions.sort();
    row.source_probe_audio_paths = [
      row.probe_audio_path,
      ...row.source_probe_audio_paths.filter((audioPath) => audioPath !== row.probe_audio_path),
    ].filter(Boolean);
  }
  return out;
}

// The embedding cache is keyed on disk by sha16(repoRel:size:mtime:...) which
// does not survive rsync/copy stat drift, so we index the cache rows by the
// audio_path each row RECORDS instead of recomputing the stat key. Newest
// generated_at wins when the same clip was embedded more than once.
function loadEmbeddingIndex(cacheDir) {
  const index = new Map();
  if (!fs.existsSync(cacheDir)) return index;
  for (const name of fs.readdirSync(cacheDir)) {
    if (!name.endsWith('.json')) continue;
    const row = readJson(path.join(cacheDir, name), null);
    if (!row?.embedding?.vector?.length) continue;
    if (row.embedding?.quality?.usable === false) continue;
    const key = normPath(row.audio_path);
    if (!key) continue;
    const existing = index.get(key);
    if (!existing || String(row.generated_at || '') > String(existing.generated_at || '')) {
      index.set(key, { vector: row.embedding.vector, generated_at: row.generated_at || '' });
    }
    const canonicalKey = canonicalDataPath(key);
    const canonicalExisting = index.get(canonicalKey);
    if (
      canonicalKey &&
      (!canonicalExisting ||
        String(row.generated_at || '') > String(canonicalExisting.generated_at || ''))
    ) {
      index.set(canonicalKey, {
        vector: row.embedding.vector,
        generated_at: row.generated_at || '',
      });
    }
  }
  return index;
}

function lookupEmbedding(index, probeAudioPath, paths) {
  const candidates = [normPath(probeAudioPath), canonicalDataPath(probeAudioPath)];
  if (path.isAbsolute(String(probeAudioPath || ''))) {
    candidates.push(normPath(path.relative(REPO, probeAudioPath)));
    const dataRel = normPath(path.relative(paths.dataDir, probeAudioPath));
    if (dataRel && !dataRel.startsWith('..')) candidates.push(`data/${dataRel}`);
  }
  for (const key of candidates) {
    const hit = index.get(key);
    if (hit) return hit;
  }
  return null;
}

function confirmedPersonFor(registry, voiceClusterId) {
  const canonicalMatch = String(voiceClusterId || '').match(/^person:(.+)$/);
  if (canonicalMatch) {
    const person = registry.people?.[canonicalMatch[1]];
    if (confirmedVoiceprintPerson(person)) {
      return {
        person_id: canonicalMatch[1],
        display_name: person.display_name || canonicalMatch[1],
      };
    }
  }
  const resolution = voiceClusterId ? registry.voice_cluster_resolutions?.[voiceClusterId] : null;
  if (resolution?.status === 'confirmed_by_ExampleCo' && resolution.person_id) {
    return {
      person_id: resolution.person_id,
      display_name: canonicalDisplayName(registry, resolution.person_id, resolution.display_name || ''),
    };
  }
  const acoustic = voiceClusterId ? registry.acoustic_group_resolutions?.[voiceClusterId] : null;
  if (acoustic?.status === 'confirmed_by_ExampleCo' && acoustic.person_id) {
    return {
      person_id: acoustic.person_id,
      display_name: canonicalDisplayName(registry, acoustic.person_id, acoustic.display_name || ''),
    };
  }
  return null;
}

function deniedPeopleFor(registry, voiceClusterId) {
  const out = new Set();
  for (const row of registry.voice_cluster_denials?.[voiceClusterId] || []) {
    if (row?.denied_person_id) out.add(row.denied_person_id);
  }
  return out;
}

function buildItems(rows, embeddingIndex, registry, paths) {
  const items = [];
  let missingEmbedding = 0;
  let withoutProbe = 0;
  let excludedNonIdentityGrade = 0;
  for (const row of rows) {
    if (row.identity_grade === false) {
      excludedNonIdentityGrade += 1;
      continue;
    }
    const sourceProbeAudioPaths = [
      ...new Set([row.probe_audio_path, ...(row.source_probe_audio_paths || [])].filter(Boolean)),
    ];
    if (!sourceProbeAudioPaths.length) {
      withoutProbe += 1;
      continue;
    }
    let hit = null;
    let matchedProbeAudioPath = '';
    for (const audioPath of sourceProbeAudioPaths) {
      hit = lookupEmbedding(embeddingIndex, audioPath, paths);
      if (hit) {
        matchedProbeAudioPath = audioPath;
        break;
      }
    }
    if (!hit) {
      missingEmbedding += 1;
      continue;
    }
    const sourceVoiceClusterIds = [
      ...new Set([row.voice_cluster_id, ...(row.source_voice_cluster_ids || [])].filter(Boolean)),
    ].sort();
    const confirmedCandidates = sourceVoiceClusterIds
      .map((voiceClusterId) => confirmedPersonFor(registry, voiceClusterId))
      .filter(Boolean);
    const confirmedPeople = new Set(confirmedCandidates.map((candidate) => candidate.person_id));
    const confirmed = confirmedPeople.size === 1 ? confirmedCandidates[0] : null;
    const denied = new Set();
    for (const voiceClusterId of sourceVoiceClusterIds) {
      for (const personId of deniedPeopleFor(registry, voiceClusterId)) denied.add(personId);
    }
    items.push({
      key: row.track_key,
      otid: row.otid,
      label: row.speaker_model_label,
      voiceClusterId: row.voice_cluster_id,
      sourceVoiceClusterIds,
      probeAudioPath: matchedProbeAudioPath,
      sourceProbeAudioPaths,
      sourceRevision: row.source_revision || row.source_revisions?.[0] || '',
      sourceRevisions: row.source_revisions || [row.source_revision].filter(Boolean),
      vector: hit.vector,
      confirmedPersonId: confirmed?.person_id || null,
      confirmedDisplayName: confirmed?.display_name || '',
      denied,
    });
  }
  return { items, missingEmbedding, withoutProbe, excludedNonIdentityGrade };
}

function buildReferencePeople(registry, embeddingIndex, paths) {
  const canonicalMap = buildCanonicalPersonMap(registry, readJson(paths.contactAliases, {}));
  const grouped = new Map();
  const seen = new Set();
  for (const enrollment of Array.isArray(registry.enrollments) ? registry.enrollments : []) {
    if (enrollment?.quarantined || enrollment?.status === 'quarantined') continue;
    const originalPersonId = String(enrollment?.person_id || '');
    const personId = canonicalMap.get(originalPersonId) || originalPersonId;
    const person = registry.people?.[personId] || registry.people?.[originalPersonId];
    if (!personId || !confirmedVoiceprintPerson(person)) continue;
    const audioPath =
      enrollment.reference_audio_rel ||
      enrollment.reference_audio_path ||
      enrollment.audio_path ||
      '';
    const hit = lookupEmbedding(embeddingIndex, audioPath, paths);
    if (!hit) continue;
    const clipKey = `${personId}|${normPath(audioPath)}`;
    if (seen.has(clipKey)) continue;
    seen.add(clipKey);
    if (!grouped.has(personId)) {
      grouped.set(personId, {
        person_id: personId,
        display_name: person.display_name || personId,
        vectors: [],
      });
    }
    grouped.get(personId).vectors.push(hit.vector);
  }
  return [...grouped.values()]
    .map((person) => ({
      person_id: person.person_id,
      display_name: person.display_name,
      reference_count: person.vectors.length,
      centroid: meanVector(person.vectors),
    }))
    .sort((a, b) => a.person_id.localeCompare(b.person_id));
}

function clusterProbeDurationSeconds(cluster) {
  // A one-clip cluster keeps its clip's duration band; a pooled centroid has
  // no single duration, so it is judged by the global calibration model.
  if (cluster.members.length !== 1) return null;
  const m = String(cluster.members[0].probeAudioPath || '').match(/dur-([0-9.]+)/);
  return m ? Number(m[1]) : null;
}

function matchClustersToConfirmedReferences(clusters, referencePeople, opts, calibration = null) {
  let matched = 0;
  for (const cluster of clusters) {
    if (cluster.frozen || !cluster.centroid?.length) continue;
    const denied = new Set();
    for (const member of cluster.members) {
      for (const personId of member.denied || []) denied.add(personId);
    }
    const match = bestPersonMatch(cluster.centroid, referencePeople, denied);
    if (!match) continue;
    // Same decision the per-track resolver uses: a raw pass the trained
    // calibration contradicts never freezes a cluster under a confirmed name.
    const verdict = referenceMatchDecision({
      rawScore: match.score,
      rawMargin: match.margin,
      calibration,
      durationSeconds: clusterProbeDurationSeconds(cluster),
      rawScoreGate: opts.referenceMatchScore,
      rawMarginGate: opts.referenceMatchMargin,
    });
    if (!verdict.accept) continue;
    cluster.frozen = true;
    cluster.personId = match.person_id;
    cluster.displayName = match.display_name || match.person_id;
    cluster.referenceVoiceprintMatch = {
      status: 'confirmed_reference_voiceprint_match',
      ...match,
      gate_path: verdict.path,
      calibrated_probability: verdict.calibration?.probability ?? null,
    };
    matched += 1;
  }
  return matched;
}

function consolidateConfirmedPersonClusters(clusters) {
  const byPerson = new Map();
  const output = [];
  for (const cluster of clusters) {
    if (!cluster.personId) {
      output.push(cluster);
      continue;
    }
    if (!byPerson.has(cluster.personId)) byPerson.set(cluster.personId, []);
    byPerson.get(cluster.personId).push(cluster);
  }
  for (const group of byPerson.values()) {
    const ranked = [...group].sort((a, b) => {
      const aExisting = a.referenceVoiceprintMatch ? 0 : 1;
      const bExisting = b.referenceVoiceprintMatch ? 0 : 1;
      return (
        bExisting - aExisting ||
        Number(b.referenceVoiceprintMatch?.score || 0) -
          Number(a.referenceVoiceprintMatch?.score || 0) ||
        clusterTieKey(a).localeCompare(clusterTieKey(b))
      );
    });
    // A diarizer may split one real voice into multiple labels within a call.
    // Once separate acoustic clusters independently resolve to the same
    // confirmed reference voiceprint, that generated-label boundary is not an
    // identity veto. Canonical identity follows the confirmed voiceprint.
    const accepted = ranked;
    if (!accepted.length) continue;
    const base = accepted[0];
    for (const cluster of accepted.slice(1)) {
      base.members.push(...cluster.members);
      if (!base.referenceVoiceprintMatch && cluster.referenceVoiceprintMatch) {
        base.referenceVoiceprintMatch = cluster.referenceVoiceprintMatch;
      } else if (
        cluster.referenceVoiceprintMatch &&
        Number(cluster.referenceVoiceprintMatch.score || 0) >
          Number(base.referenceVoiceprintMatch?.score || 0)
      ) {
        base.referenceVoiceprintMatch = cluster.referenceVoiceprintMatch;
      }
    }
    base.centroid = meanVector(base.members.map((member) => member.vector));
    output.push(base);
  }
  return { clusters: output, rejectedReferenceMatches: 0 };
}

function mintClusterId(members) {
  const seed = members
    .map((m) => m.key)
    .sort()
    .join('\n');
  return `unknown_voice_${SPEAKER_BACKEND}_${sha16(seed)}`;
}

// A member-set hash can equal an id another cluster still carries (a cluster
// keeps its inherited id after the member that originally minted it leaves).
// Mint deterministically, skipping any id already in use: the base id first,
// then the same seed salted with a collision counter.
function mintUniqueClusterId(members, usedIds) {
  const used = usedIds instanceof Set ? usedIds : new Set(usedIds || []);
  const base = mintClusterId(members);
  if (!used.has(base)) return base;
  const seed = members
    .map((m) => m.key)
    .sort()
    .join('\n');
  for (let counter = 1; counter < 10000; counter += 1) {
    const candidate = `unknown_voice_${SPEAKER_BACKEND}_${sha16(`${seed}\n#collision:${counter}`)}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`could not mint a unique cluster id for seed ${sha16(seed)}`);
}

function findDuplicateClusterIds(clusters) {
  const indexesById = new Map();
  (clusters || []).forEach((cluster, index) => {
    const id = String(cluster?.cluster_id ?? cluster?.id ?? '');
    if (!indexesById.has(id)) indexesById.set(id, []);
    indexesById.get(id).push(index);
  });
  return [...indexesById.entries()]
    .filter(([, indexes]) => indexes.length > 1)
    .map(([clusterId, indexes]) => ({ cluster_id: clusterId, indexes }));
}

// Fail closed: every id-keyed consumer (name judgments, orphan scans, the
// confirmation queue) assumes one cluster per id, so a duplicate never publishes.
function assertUniqueClusterIds(clusters, context = 'recluster') {
  const duplicates = findDuplicateClusterIds(clusters);
  if (duplicates.length) {
    const detail = duplicates
      .map((row) => `${row.cluster_id} at indexes ${row.indexes.join(',')}`)
      .join('; ');
    const error = new Error(`${context}: refusing to publish duplicate cluster ids: ${detail}`);
    error.code = 'DUPLICATE_CLUSTER_IDS';
    error.duplicates = duplicates;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Agglomerative complete-linkage clustering with constraints.
// ---------------------------------------------------------------------------

function mkSlot(members, frozen, personId, displayName) {
  const slot = {
    active: true,
    version: 0,
    members,
    frozen,
    personId: personId || null,
    displayName: displayName || '',
    denied: new Set(),
    otidLabels: new Map(),
    centroid: [],
  };
  for (const m of members) addMemberMeta(slot, m);
  slot.centroid = meanVector(members.map((m) => m.vector));
  return slot;
}

function addMemberMeta(slot, member) {
  for (const p of member.denied) slot.denied.add(p);
  if (!slot.otidLabels.has(member.otid)) slot.otidLabels.set(member.otid, new Set());
  slot.otidLabels.get(member.otid).add(String(member.label));
}

// Complete linkage between two clusters: the MINIMUM cross-pair cosine.
// Returns null when any pair falls below `floor` (a below-floor link can only
// decrease under further merges, so it is permanently unmergeable and we never
// have to store it).
function clusterLink(a, b, floor) {
  let min = Infinity;
  for (const x of a.members) {
    for (const y of b.members) {
      const s = cosine(x.vector, y.vector);
      if (s < floor) return null;
      if (s < min) min = s;
    }
  }
  return min === Infinity ? null : min;
}

function sameCallViolation(a, b, gate) {
  for (const x of a.members) {
    const labels = b.otidLabels.get(x.otid);
    if (!labels) continue;
    for (const y of b.members) {
      if (y.otid !== x.otid || String(y.label) === String(x.label)) continue;
      const s = cosine(x.vector, y.vector);
      if (s < gate) return { otid: x.otid, pair: [x.key, y.key], score: Number(s.toFixed(6)) };
    }
  }
  return null;
}

function denialViolation(a, b) {
  if (a.personId && b.denied.has(a.personId)) {
    const member = b.members.find((m) => m.denied.has(a.personId));
    return { person_id: a.personId, denied_member_key: member?.key || '' };
  }
  if (b.personId && a.denied.has(b.personId)) {
    const member = a.members.find((m) => m.denied.has(b.personId));
    return { person_id: b.personId, denied_member_key: member?.key || '' };
  }
  return null;
}

function heapPush(heap, entry) {
  heap.push(entry);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heapBefore(heap[i], heap[parent])) {
      [heap[i], heap[parent]] = [heap[parent], heap[i]];
      i = parent;
    } else break;
  }
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    let i = 0;
    while (true) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let best = i;
      if (l < heap.length && heapBefore(heap[l], heap[best])) best = l;
      if (r < heap.length && heapBefore(heap[r], heap[best])) best = r;
      if (best === i) break;
      [heap[i], heap[best]] = [heap[best], heap[i]];
      i = best;
    }
  }
  return top;
}

function heapBefore(x, y) {
  if (x.sim !== y.sim) return x.sim > y.sim;
  if (x.a !== y.a) return x.a < y.a;
  return x.b < y.b;
}

function clusterItems(items, opts) {
  const slots = [];
  const frozenByPerson = new Map();
  for (const item of items) {
    if (item.confirmedPersonId) {
      if (!frozenByPerson.has(item.confirmedPersonId)) {
        const slot = mkSlot([], true, item.confirmedPersonId, item.confirmedDisplayName);
        frozenByPerson.set(item.confirmedPersonId, slot);
        slots.push(slot);
      }
      const slot = frozenByPerson.get(item.confirmedPersonId);
      slot.members.push(item);
      addMemberMeta(slot, item);
      if (!slot.displayName && item.confirmedDisplayName)
        slot.displayName = item.confirmedDisplayName;
    } else {
      slots.push(mkSlot([item], false, null, ''));
    }
  }
  for (const slot of slots) slot.centroid = meanVector(slot.members.map((m) => m.vector));

  const storeFloor = Math.min(opts.pairFloor, opts.frozenThreshold);
  const links = slots.map(() => new Map());
  const heap = [];
  for (let i = 0; i < slots.length; i += 1) {
    for (let j = i + 1; j < slots.length; j += 1) {
      const link = clusterLink(slots[i], slots[j], storeFloor);
      if (link === null) continue;
      links[i].set(j, link);
      links[j].set(i, link);
      heapPush(heap, { sim: link, a: i, b: j, va: 0, vb: 0 });
    }
  }

  const blocks = [];
  const blockSeen = new Set();
  let blockCount = 0;
  const recordBlock = (type, detail) => {
    blockCount += 1;
    const dedupeKey = `${type}|${JSON.stringify(detail)}`;
    if (blockSeen.has(dedupeKey)) return;
    blockSeen.add(dedupeKey);
    if (blocks.length < 100) blocks.push({ type, ...detail });
  };

  while (heap.length) {
    const entry = heapPop(heap);
    const A = slots[entry.a];
    const B = slots[entry.b];
    if (!A.active || !B.active || A.version !== entry.va || B.version !== entry.vb) continue;
    const link = links[entry.a].get(entry.b);
    if (link === undefined) continue;
    if (A.frozen && B.frozen) {
      recordBlock('frozen_frozen_confirmed_identities', {
        persons: [A.personId, B.personId].sort(),
      });
      continue;
    }
    const frozenInvolved = A.frozen || B.frozen;
    const pairBar = frozenInvolved
      ? Math.max(opts.pairFloor, opts.frozenThreshold)
      : opts.pairFloor;
    const centroidBar = frozenInvolved
      ? Math.max(opts.threshold, opts.frozenThreshold)
      : opts.threshold;
    if (link < pairBar) continue;
    if (cosine(A.centroid, B.centroid) < centroidBar) continue;
    const denial = denialViolation(A, B);
    if (denial) {
      recordBlock('denied_person_cluster', denial);
      continue;
    }
    const sameCall = sameCallViolation(A, B, opts.sameCallGate);
    if (sameCall) {
      recordBlock('same_call_different_label', sameCall);
      continue;
    }
    // Merge B into A. Joining a frozen cluster never renames or reassigns the
    // confirmed identity: personId survives on the merged slot.
    A.members.push(...B.members);
    A.frozen = A.frozen || B.frozen;
    A.personId = A.personId || B.personId;
    A.displayName = A.displayName || B.displayName;
    for (const p of B.denied) A.denied.add(p);
    for (const [otid, labels] of B.otidLabels) {
      if (!A.otidLabels.has(otid)) A.otidLabels.set(otid, new Set());
      for (const label of labels) A.otidLabels.get(otid).add(label);
    }
    A.centroid = meanVector(A.members.map((m) => m.vector));
    A.version += 1;
    B.active = false;
    const aMap = links[entry.a];
    const bMap = links[entry.b];
    const merged = new Map();
    for (const [c, sim] of aMap) {
      if (c === entry.b || !slots[c].active) continue;
      const other = bMap.get(c);
      if (other === undefined) continue; // below floor on one side: unmergeable forever
      merged.set(c, Math.min(sim, other));
    }
    links[entry.a] = merged;
    links[entry.b] = new Map();
    for (const [c] of bMap) links[c]?.delete(entry.b);
    for (const [c, sim] of merged) {
      links[c].delete(entry.b);
      links[c].set(entry.a, sim);
      const lo = Math.min(entry.a, c);
      const hi = Math.max(entry.a, c);
      heapPush(heap, { sim, a: lo, b: hi, va: slots[lo].version, vb: slots[hi].version });
    }
  }

  const clusters = slots
    .filter((slot) => slot.active && slot.members.length)
    .map((slot) => ({
      members: slot.members,
      frozen: slot.frozen,
      personId: slot.personId,
      displayName: slot.displayName,
      centroid: slot.centroid,
    }));
  return { clusters, blocks, blockCount };
}

// ---------------------------------------------------------------------------
// Stability discipline: durable ids, split/merge ledger, frozen protection.
// ---------------------------------------------------------------------------

function applyStability(clusters, previousRun, registry) {
  const prevClusters = previousRun?.clusters || [];
  const prevInfo = new Map();
  const keyToPrev = new Map();
  for (const prev of prevClusters) {
    const keys = new Set(prev.member_track_keys || []);
    const existing = prevInfo.get(prev.cluster_id);
    if (existing) {
      for (const key of keys) existing.keys.add(key);
      if (!existing.confirmedPersonId && prev.confirmed_person_id) {
        existing.confirmedPersonId = prev.confirmed_person_id;
      }
    } else {
      prevInfo.set(prev.cluster_id, {
        keys,
        confirmedPersonId: prev.confirmed_person_id || null,
      });
    }
    for (const key of keys) keyToPrev.set(key, prev.cluster_id);
  }
  const currentKeys = new Set();
  for (const cluster of clusters) for (const m of cluster.members) currentKeys.add(m.key);
  const presentCount = new Map();
  for (const [prevId, info] of prevInfo) {
    let count = 0;
    for (const key of info.keys) if (currentKeys.has(key)) count += 1;
    presentCount.set(prevId, count);
  }

  // Max-member-overlap claims: a new cluster inheriting >= 50% of a previous
  // cluster's (present) members keeps its id; each previous id is claimed by
  // at most one new cluster (the one with the largest overlap).
  const overlaps = clusters.map((cluster) => {
    const byPrev = new Map();
    for (const m of cluster.members) {
      const prevId = keyToPrev.get(m.key);
      if (!prevId) continue;
      byPrev.set(prevId, (byPrev.get(prevId) || 0) + 1);
    }
    return byPrev;
  });
  const claims = new Map(); // prevId -> cluster index
  for (const [prevId] of prevInfo) {
    const present = presentCount.get(prevId) || 0;
    if (!present) continue;
    let bestIdx = -1;
    let bestOverlap = 0;
    clusters.forEach((cluster, idx) => {
      const overlap = overlaps[idx].get(prevId) || 0;
      if (
        overlap > bestOverlap ||
        (overlap === bestOverlap &&
          overlap > 0 &&
          bestIdx >= 0 &&
          clusterTieKey(clusters[idx]) < clusterTieKey(clusters[bestIdx]))
      ) {
        bestOverlap = overlap;
        bestIdx = idx;
      }
    });
    if (bestIdx >= 0 && bestOverlap * 2 >= present) claims.set(prevId, bestIdx);
  }
  const inheritedByCluster = clusters.map(() => []);
  for (const [prevId, idx] of claims) inheritedByCluster[idx].push(prevId);
  for (const list of inheritedByCluster) list.sort();

  const merges = [];
  const finalClusters = [];
  clusters.forEach((cluster, idx) => {
    const inherited = inheritedByCluster[idx];
    const confirmedInherited = inherited.filter((id) => prevInfo.get(id).confirmedPersonId);
    const referencePersonId = cluster.referenceVoiceprintMatch?.person_id || null;
    const strictReferenceClosure = Boolean(
      referencePersonId &&
      confirmedInherited.length &&
      confirmedInherited.every((id) => prevInfo.get(id).confirmedPersonId === referencePersonId),
    );
    if (inherited.length >= 2 && strictReferenceClosure) {
      const id = canonicalSpeakerId(referencePersonId);
      merges.push({
        cluster_id: id,
        previous_clusters: inherited.map((previousId) => ({
          previous_cluster_id: previousId,
          member_count: overlaps[idx].get(previousId) || 0,
          confirmed_person_id: prevInfo.get(previousId).confirmedPersonId || null,
        })),
        review_required: false,
        applied: true,
        reason: 'strict_confirmed_reference_voiceprint_closure',
      });
      finalClusters.push({
        id,
        members: cluster.members,
        frozen: true,
        personId: referencePersonId,
        displayName: cluster.displayName,
        referenceVoiceprintMatch: cluster.referenceVoiceprintMatch,
        inherited: true,
      });
      return;
    }
    if (inherited.length >= 2 && confirmedInherited.length) {
      // A merge touching a human-confirmed cluster is proposed, never applied:
      // restore the other previous clusters, keep the confirmed cluster's id
      // and identity untouched.
      const primaryId = confirmedInherited[0];
      const others = inherited.filter((id) => id !== primaryId);
      const restored = others.map((prevId) => ({
        id: prevId,
        members: cluster.members.filter((m) => prevInfo.get(prevId).keys.has(m.key)),
        frozen: false,
        personId: prevInfo.get(prevId).confirmedPersonId || null,
        displayName: '',
      }));
      const claimedKeys = new Set(restored.flatMap((r) => r.members.map((m) => m.key)));
      const primaryMembers = cluster.members.filter(
        (m) => prevInfo.get(primaryId).keys.has(m.key) && !claimedKeys.has(m.key),
      );
      for (const m of primaryMembers) claimedKeys.add(m.key);
      const free = cluster.members.filter((m) => !claimedKeys.has(m.key));
      const candidates = [
        ...restored.map((r) => ({
          target: r.members,
          centroid: meanVector(r.members.map((m) => m.vector)),
        })),
        { target: primaryMembers, centroid: meanVector(primaryMembers.map((m) => m.vector)) },
      ];
      for (const m of free) {
        let best = 0;
        let bestScore = -Infinity;
        candidates.forEach((candidate, i) => {
          const score = cosine(m.vector, candidate.centroid);
          if (score > bestScore) {
            bestScore = score;
            best = i;
          }
        });
        candidates[best].target.push(m);
      }
      merges.push({
        cluster_id: frozenClusterId(cluster, primaryId),
        previous_clusters: inherited.map((id) => ({
          previous_cluster_id: id,
          member_count: overlaps[idx].get(id) || 0,
          confirmed_person_id: prevInfo.get(id).confirmedPersonId || null,
        })),
        review_required: true,
        applied: false,
        reason: 'merge_touches_human_confirmed_cluster',
      });
      finalClusters.push({
        id: frozenClusterId(cluster, primaryId),
        members: primaryMembers,
        frozen: cluster.frozen,
        personId: cluster.personId,
        displayName: cluster.displayName,
        referenceVoiceprintMatch: cluster.referenceVoiceprintMatch || null,
        inherited: true,
      });
      for (const r of restored) {
        if (!r.members.length) continue;
        finalClusters.push({ ...r, inherited: true });
      }
      return;
    }
    let id;
    let inheritedFlag = false;
    if (inherited.length >= 2) {
      // Merge among unconfirmed previous clusters: applied; the id with the
      // largest member overlap survives, the rest are recorded in the ledger.
      const ranked = [...inherited].sort(
        (x, y) => (overlaps[idx].get(y) || 0) - (overlaps[idx].get(x) || 0) || (x < y ? -1 : 1),
      );
      id = ranked[0];
      inheritedFlag = true;
      merges.push({
        cluster_id: id,
        previous_clusters: inherited.map((pid) => ({
          previous_cluster_id: pid,
          member_count: overlaps[idx].get(pid) || 0,
          confirmed_person_id: null,
        })),
        review_required: false,
        applied: true,
        reason: 'unconfirmed_clusters_merged',
      });
    } else if (inherited.length === 1) {
      const inheritedId = inherited[0];
      const inheritedPersonId = prevInfo.get(inheritedId).confirmedPersonId;
      // A previous canonical person id belongs to that confirmed identity,
      // never to whichever unconfirmed split fragment wins overlap math. The
      // current cluster may retain it only when current acoustic evidence
      // still resolves to the same person.
      if (!inheritedPersonId || (cluster.frozen && cluster.personId === inheritedPersonId)) {
        id = inheritedId;
        inheritedFlag = true;
      }
    }
    if (cluster.frozen) {
      // A human-confirmed cluster keeps its confirmed identity and durable id
      // regardless of overlap arithmetic.
      id = frozenClusterId(cluster, id);
      inheritedFlag = true;
    }
    if (!id) id = mintClusterId(cluster.members);
    finalClusters.push({
      id,
      members: cluster.members,
      frozen: cluster.frozen,
      personId: cluster.personId,
      displayName: cluster.displayName,
      referenceVoiceprintMatch: cluster.referenceVoiceprintMatch || null,
      inherited: inheritedFlag,
    });
  });

  // Inherited and confirmed ids are durable and win; a freshly minted id that
  // collides with one of them (or with an earlier mint) is re-minted.
  const usedIds = new Set(finalClusters.filter((c) => c.inherited).map((c) => c.id));
  for (const cluster of finalClusters) {
    if (cluster.inherited) continue;
    if (usedIds.has(cluster.id)) cluster.id = mintUniqueClusterId(cluster.members, usedIds);
    usedIds.add(cluster.id);
  }

  // Split ledger: a previous cluster whose (present) members now span multiple
  // final clusters. Splits touching a confirmed cluster are review_required;
  // the confirmed cluster itself keeps its id and identity either way.
  const keyToFinal = new Map();
  for (const cluster of finalClusters)
    for (const m of cluster.members) keyToFinal.set(m.key, cluster.id);
  const splits = [];
  for (const [prevId, info] of prevInfo) {
    const counts = new Map();
    for (const key of info.keys) {
      const finalId = keyToFinal.get(key);
      if (!finalId) continue;
      counts.set(finalId, (counts.get(finalId) || 0) + 1);
    }
    if (counts.size <= 1) continue;
    splits.push({
      previous_cluster_id: prevId,
      previous_member_count_present: presentCount.get(prevId) || 0,
      resulting_clusters: [...counts.entries()]
        .map(([clusterId, count]) => ({ cluster_id: clusterId, member_count: count }))
        .sort((x, y) => y.member_count - x.member_count || (x.cluster_id < y.cluster_id ? -1 : 1)),
      review_required: Boolean(info.confirmedPersonId),
    });
  }

  return { finalClusters, merges, splits };
}

function clusterTieKey(cluster) {
  return cluster.members
    .map((m) => m.key)
    .sort()
    .join('\n');
}

function frozenClusterId(cluster, inheritedId) {
  const canonicalId = cluster.personId ? canonicalSpeakerId(cluster.personId) : '';
  return canonicalId || inheritedId || mintClusterId(cluster.members);
}

// Run id from the input set hash (tracks, vectors, constraints, thresholds),
// never from Date.now alone: identical inputs re-produce the same artifact.
function deriveRunId(items, opts, referencePeople = []) {
  const lines = items
    .map(
      (item) =>
        `${item.key}|${sha16(item.vector.map((v) => Number(v).toFixed(6)).join(','))}|${item.confirmedPersonId || ''}|${[...item.denied].sort().join(',')}`,
    )
    .sort();
  lines.push(
    `thresholds:${opts.threshold}:${opts.pairFloor}:${opts.frozenThreshold}:${opts.sameCallGate}:${opts.referenceMatchScore}:${opts.referenceMatchMargin}`,
  );
  for (const person of referencePeople) {
    lines.push(
      `reference:${person.person_id}:${person.reference_count}:${sha16(
        person.centroid.map((v) => Number(v).toFixed(6)).join(','),
      )}`,
    );
  }
  return sha16(lines.join('\n'));
}

function runRecluster(options = {}) {
  const paths = resolvePaths(options.dataDir);
  if (!options.write) return runReclusterCore(options, paths);
  // Hold the artifact lock across the whole read-compute-publish transaction:
  // locking only the final write still lets an incremental publish between
  // this run's input snapshot and its write, and the stale snapshot wins.
  return withReclusterPublishLock(paths.latest, () => runReclusterCore(options, paths), options.lockOptions);
}

function runReclusterCore(options, paths) {
  const opts = {
    threshold: options.threshold ?? DEFAULTS.threshold,
    pairFloor: options.pairFloor ?? DEFAULTS.pairFloor,
    frozenThreshold: options.frozenThreshold ?? DEFAULTS.frozenThreshold,
    sameCallGate: options.sameCallGate ?? DEFAULTS.sameCallGate,
    referenceMatchScore: options.referenceMatchScore ?? DEFAULTS.referenceMatchScore,
    referenceMatchMargin: options.referenceMatchMargin ?? DEFAULTS.referenceMatchMargin,
    maxEmbeddings: options.maxEmbeddings ?? DEFAULTS.maxEmbeddings,
  };
  const registry = readJson(paths.registry, {});
  const rows = discoverTrackRows(paths);
  const embeddingIndex = loadEmbeddingIndex(paths.embedCacheDir);
  const { items, missingEmbedding, withoutProbe, excludedNonIdentityGrade } = buildItems(
    rows,
    embeddingIndex,
    registry,
    paths,
  );
  if (items.length > opts.maxEmbeddings) {
    throw new Error(
      `voice-global-recluster: ${items.length} embeddings exceed the --max-embeddings cap of ${opts.maxEmbeddings}. ` +
        'This job never silently samples; raise --max-embeddings deliberately if the corpus really is that large.',
    );
  }
  const previousRun = options.previousRunPath
    ? readJson(options.previousRunPath, null)
    : readJson(paths.latest, null);
  const clustered = clusterItems(items, opts);
  let clusters = clustered.clusters;
  const { blocks, blockCount } = clustered;
  const referencePeople = buildReferencePeople(registry, embeddingIndex, paths);
  const scoreCalibration = readJson(paths.scoreCalibration, null);
  let matchedToConfirmedReference = matchClustersToConfirmedReferences(
    clusters,
    referencePeople,
    opts,
    scoreCalibration,
  );
  const consolidated = consolidateConfirmedPersonClusters(clusters);
  clusters = consolidated.clusters;
  matchedToConfirmedReference -= consolidated.rejectedReferenceMatches;
  const { finalClusters, merges, splits } = applyStability(clusters, previousRun, registry);
  const runId = options.runId || deriveRunId(items, opts, referencePeople);

  const clusterRows = finalClusters
    .map((cluster) => {
      const row = {
        cluster_id: cluster.id,
        size: cluster.members.length,
        frozen: Boolean(cluster.frozen),
        confirmed_person_id: cluster.personId || null,
        confirmed_display_name: cluster.displayName || null,
        reference_voiceprint_match: cluster.referenceVoiceprintMatch || null,
        inherited_id: Boolean(cluster.inherited),
        member_track_keys: cluster.members.map((m) => m.key).sort(),
        members: cluster.members
          .map((m) => ({
            track_key: m.key,
            otid: m.otid,
            speaker_model_label: m.label,
            voice_cluster_id: m.voiceClusterId,
            source_voice_cluster_ids:
              m.sourceVoiceClusterIds || [m.voiceClusterId].filter(Boolean),
            probe_audio_path: m.probeAudioPath,
            source_probe_audio_paths:
              m.sourceProbeAudioPaths || [m.probeAudioPath].filter(Boolean),
          }))
          .sort((x, y) => (x.track_key < y.track_key ? -1 : 1)),
        otids: [...new Set(cluster.members.map((m) => m.otid))].sort(),
        centroid: meanVector(cluster.members.map((m) => m.vector)).map((v) =>
          Number(v.toFixed(6)),
        ),
      };
      if (row.confirmed_person_id) {
        row.acoustic_assignment_audit = buildAcousticAssignmentAudit({
          cluster: row,
          referencePeople,
          calibration: scoreCalibration,
          registry,
        });
      }
      return row;
    })
    .sort((x, y) => y.size - x.size || (x.cluster_id < y.cluster_id ? -1 : 1));

  const report = {
    schema: 'life_archive_voice_global_recluster.v1',
    backend: SPEAKER_BACKEND,
    run_id: runId,
    generated_at: new Date().toISOString(),
    wrote: Boolean(options.write),
    previous_run_id: previousRun?.run_id || null,
    thresholds: {
      threshold: opts.threshold,
      pair_floor: opts.pairFloor,
      frozen_threshold: opts.frozenThreshold,
      same_call_gate: opts.sameCallGate,
      reference_match_score: opts.referenceMatchScore,
      reference_match_margin: opts.referenceMatchMargin,
      max_embeddings: opts.maxEmbeddings,
    },
    inputs: {
      probe_index: paths.probeIndex,
      review_queue: paths.reviewQueue,
      registry: paths.registry,
      embedding_cache_dir: paths.embedCacheDir,
      contact_aliases: paths.contactAliases,
      previous_run_path: options.previousRunPath || paths.latest,
      track_rows_seen: rows.length,
      tracks_clustered: items.length,
      tracks_missing_embedding: missingEmbedding,
      tracks_without_probe: withoutProbe,
      tracks_excluded_non_identity_grade: excludedNonIdentityGrade,
      confirmed_tracks: items.filter((item) => item.confirmedPersonId).length,
      unconfirmed_tracks: items.filter((item) => !item.confirmedPersonId).length,
      reference_people: referencePeople.length,
      reference_enrollments_usable: referencePeople.reduce(
        (sum, person) => sum + person.reference_count,
        0,
      ),
    },
    summary: {
      clusters: clusterRows.length,
      frozen_clusters: clusterRows.filter((row) => row.frozen).length,
      multi_member_clusters: clusterRows.filter((row) => row.size > 1).length,
      singleton_clusters: clusterRows.filter((row) => row.size === 1).length,
      ids_inherited: clusterRows.filter((row) => row.inherited_id).length,
      ids_minted: clusterRows.filter((row) => !row.inherited_id).length,
      splits: splits.length,
      merges: merges.length,
      merges_applied: merges.filter((m) => m.applied).length,
      merges_review_required: merges.filter((m) => m.review_required).length,
      splits_review_required: splits.filter((s) => s.review_required).length,
      cannot_link_blocks: blockCount,
      clusters_matched_to_confirmed_reference: matchedToConfirmedReference,
    },
    clusters: clusterRows,
    ledger: {
      merges,
      splits,
      cannot_link_blocks: blocks,
    },
  };

  if (options.write) {
    assertUniqueClusterIds(report.clusters, 'voice-global-recluster');
    saveJson(path.join(paths.runsDir, `${runId}.json`), report);
    saveJson(paths.latest, report);
  }
  return report;
}

function main() {
  const numFlag = (name, fallback) => {
    const raw = argValue(name, '');
    return raw === '' ? fallback : Number(raw);
  };
  const report = runRecluster({
    threshold: numFlag('--threshold', undefined),
    pairFloor: numFlag('--pair-floor', undefined),
    frozenThreshold: numFlag('--frozen-threshold', undefined),
    sameCallGate: numFlag('--same-call-gate', undefined),
    referenceMatchScore: numFlag('--reference-match-score', undefined),
    referenceMatchMargin: numFlag('--reference-match-margin', undefined),
    maxEmbeddings: numFlag('--max-embeddings', undefined),
    runId: argValue('--run-id', '') || undefined,
    previousRunPath: argValue('--previous', '') || undefined,
    write: hasArg('--write'),
  });
  // Keep the terminal report readable: full centroids live in the artifact.
  const stdoutReport = {
    ...report,
    clusters: report.clusters.map(({ centroid, members, ...rest }) => ({
      ...rest,
      centroid_dims: centroid.length,
    })),
  };
  process.stdout.write(`${JSON.stringify(stdoutReport, null, 2)}\n`);
}

module.exports = {
  DEFAULTS,
  cosine,
  meanVector,
  sha16,
  resolvePaths,
  discoverTrackRows,
  loadEmbeddingIndex,
  canonicalDataPath,
  buildItems,
  buildReferencePeople,
  clusterItems,
  matchClustersToConfirmedReferences,
  consolidateConfirmedPersonClusters,
  applyStability,
  deriveRunId,
  mintClusterId,
  mintUniqueClusterId,
  findDuplicateClusterIds,
  assertUniqueClusterIds,
  runRecluster,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
}
