#!/usr/bin/env node
/**
 * Voiceprint calibration sweep (audit Phase A item 3).
 *
 * Builds an HONEST impostor/genuine cosine-score sweep from artifacts that
 * already exist on disk, so the interim operating point (0.56/0.06) can be
 * placed on thousands of pairs instead of the original n=117 wrong-pairs.
 *
 * Genuine pairs:
 *   - person tier: same canonical person across DIFFERENT otids, where person
 *     identity comes only from human-confirmed evidence (registry
 *     voice_cluster_resolutions confirmed_by_ExampleCo, gated registry enrollments,
 *     or enriched resolved_speaker/speaker_identity_tracks at tier
 *     confirmed_by_ExampleCo_cluster). Machine-assigned voiceprint matches are
 *     deliberately NOT identity evidence here: they passed the very gate this
 *     sweep calibrates, so using them would be circular.
 *   - cluster tier: same durable ExampleCo cluster across different otids,
 *     reported separately (cluster membership was itself formed by a score
 *     threshold, so this tier is optimistically biased and never silently
 *     merged into the person tier).
 *
 * Impostor pairs: different canonical persons, or different durable clusters,
 * with purity rules: no same-otid pairs, no entity pairs whose centroids are
 * near-identical (cosine >= 0.999, alias suspicion), and no entity pairs that
 * share a ExampleCo confirmation (two stale clusters confirmed as the same human
 * must never count as impostors). Person-vs-cluster pairs are never generated:
 * an unresolved cluster may BE one of the enrolled people.
 *
 * Deterministic by construction: inputs are sorted, pair selection has no
 * randomness and no Date dependence. Never fabricates: when the corpus cannot
 * produce enough pairs the artifact says so via status insufficient_pairs.
 *
 * Usage:
 *   node scripts/voiceprint-calibration-sweep.js \
 *     [--data-dir data] [--out data/life-archive/voiceprints/calibration-sweep-latest.json] \
 *     [--min-pairs 200] [--duration-bands "0-6,6-12,12-30"]
 */

const fs = require('fs');
const path = require('path');
const {
  cosine,
  buildCanonicalPersonMap,
  DUPLICATE_CENTROID_COSINE,
} = require('./lib/voice-reference-people');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_DURATION_BANDS = '0-6,6-12,12-30';
const DEFAULT_MIN_PAIRS = 200;
const ALIAS_CENTROID_COSINE = DUPLICATE_CENTROID_COSINE; // 0.999, shared with the resolver
const HISTOGRAM_BIN_WIDTH = 0.02;
const CONFIRMED_ENRICHED_TIER = 'confirmed_by_ExampleCo_cluster';
const TARGET_FALSE_ACCEPT_RATES = [0.01, 0.001, 0.0001];

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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function resolveDataDir(cliDataDir = '') {
  return path.resolve(cliDataDir || process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data'));
}

/**
 * Slice an audio path at data/otter/audio/ (case preserved). Cache rows store
 * repo-relative paths; registry enrollments may store absolute (even
 * foreign-OS) paths; the probe index stores repo-relative.
 */
function sliceAtAudioMarker(value) {
  const cleaned = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
  const at = cleaned.toLowerCase().indexOf('data/otter/audio/');
  return at >= 0 ? cleaned.slice(at) : cleaned;
}

/**
 * Canonical join key for an audio path: sliced at the audio marker and
 * lowercased so all sources join across path-case differences (the archive
 * has lived on Windows and Linux both).
 */
function normalizeAudioKey(value) {
  return sliceAtAudioMarker(value).toLowerCase();
}

/**
 * Probe clips are cut by otter-track-probe-builder.js as
 * data/otter/audio/<otid>/track-label-<label>-start-<s>-dur-<d>.wav, so the
 * path itself ExampleCos otid, track label and clip duration. Case is PRESERVED
 * here: a path-parsed otid must compare equal to a probe-index otid, or the
 * same-otid exclusion silently stops firing for mixed-source rows.
 */
function parseTrackAudioPath(audioPath) {
  const m = sliceAtAudioMarker(audioPath).match(
    /^data\/otter\/audio\/([^/]+)\/track-label-(.+?)-start-([0-9.]+)-dur-([0-9.]+)\.wav$/i,
  );
  if (!m) return null;
  return {
    otid: m[1],
    speaker_model_label: m[2],
    start_seconds: Number(m[3]),
    duration_seconds: Number(m[4]),
  };
}

function parseDurationBands(spec) {
  const bands = [];
  for (const part of String(spec || DEFAULT_DURATION_BANDS).split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)-([0-9]+(?:\.[0-9]+)?)$/);
    if (!m) throw new Error(`invalid duration band "${trimmed}" (expected e.g. 0-6)`);
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (!(hi > lo)) throw new Error(`invalid duration band "${trimmed}" (hi must exceed lo)`);
    bands.push({ label: `${m[1]}-${m[2]}`, lo, hi });
  }
  if (!bands.length) throw new Error('no duration bands parsed');
  return bands;
}

/**
 * Band for a pair: governed by the WEAKER side, so both durations must be
 * known (min of a known and an ExampleCo duration is not a real lower bound).
 */
function bandForPair(durationA, durationB, bands) {
  if (!Number.isFinite(durationA) || !Number.isFinite(durationB)) return 'ExampleCo';
  const d = Math.min(durationA, durationB);
  for (const band of bands) {
    if (d >= band.lo && d < band.hi) return band.label;
  }
  return 'outside_bands';
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

function percentile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (!n) return null;
  if (n === 1) return sortedAsc[0];
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(n - 1, lo + 1);
  const frac = idx - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

function round6(value) {
  return value === null || value === undefined ? null : Number(Number(value).toFixed(6));
}

function summarizeScores(scores) {
  if (!scores.length) return { count: 0 };
  const sorted = [...scores].sort((a, b) => a - b);
  const deciles = {};
  for (let p = 10; p <= 90; p += 10) deciles[`p${p}`] = round6(percentile(sorted, p));
  const binCounts = new Map();
  for (const score of sorted) {
    const bin = Math.min(
      Math.floor(2 / HISTOGRAM_BIN_WIDTH) - 1,
      Math.max(0, Math.floor((score + 1) / HISTOGRAM_BIN_WIDTH)),
    );
    binCounts.set(bin, (binCounts.get(bin) || 0) + 1);
  }
  const histogram = [...binCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bin, count]) => ({
      lo: round6(-1 + bin * HISTOGRAM_BIN_WIDTH),
      hi: round6(-1 + (bin + 1) * HISTOGRAM_BIN_WIDTH),
      count,
    }));
  return {
    count: sorted.length,
    min: round6(sorted[0]),
    max: round6(sorted[sorted.length - 1]),
    mean: round6(sorted.reduce((sum, v) => sum + v, 0) / sorted.length),
    deciles,
    histogram_bin_width: HISTOGRAM_BIN_WIDTH,
    histogram,
  };
}

/** First index in sortedAsc with value >= target (lower bound). */
function lowerBound(sortedAsc, target) {
  let lo = 0;
  let hi = sortedAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Accept rule everywhere: score >= threshold.
 *   FAR(t) = fraction of impostor scores >= t
 *   FRR(t) = fraction of genuine scores  <  t
 * EER: threshold (from the observed score values) minimizing |FAR - FRR|,
 * smallest such threshold on ties; EER = (FAR + FRR) / 2 there.
 */
function computeEer(genuineScores, impostorScores) {
  if (!genuineScores.length || !impostorScores.length) return null;
  const gen = [...genuineScores].sort((a, b) => a - b);
  const imp = [...impostorScores].sort((a, b) => a - b);
  const candidates = [...new Set([...gen, ...imp])].sort((a, b) => a - b);
  let best = null;
  for (const t of candidates) {
    const far = (imp.length - lowerBound(imp, t)) / imp.length;
    const frr = lowerBound(gen, t) / gen.length;
    const diff = Math.abs(far - frr);
    if (!best || diff < best.diff) best = { threshold: t, far, frr, diff };
  }
  return {
    eer: round6((best.far + best.frr) / 2),
    // Threshold stays full precision: it is an operating value, and rounding
    // it can silently move it to the other side of an observed score.
    threshold: best.threshold,
    far: round6(best.far),
    frr: round6(best.frr),
  };
}

/**
 * Smallest threshold whose measured false-accept rate on the impostor set is
 * <= targetFar, with the false-reject rate that threshold costs on the genuine
 * set. When 1/N(impostor) > targetFar the impostor set cannot resolve the
 * target rate (measured FAR is 0 but the true rate below 1/N is unknowable),
 * which is flagged instead of hidden.
 */
function thresholdForFa(genuineScores, impostorScores, targetFar) {
  if (!impostorScores.length) return null;
  const gen = [...genuineScores].sort((a, b) => a - b);
  const imp = [...impostorScores].sort((a, b) => a - b);
  const sentinel = imp[imp.length - 1] + 1e-6; // just above every impostor: FAR 0
  const candidates = [...new Set([...gen, ...imp, sentinel])].sort((a, b) => a - b);
  for (const t of candidates) {
    const far = (imp.length - lowerBound(imp, t)) / imp.length;
    if (far <= targetFar) {
      return {
        target_far: targetFar,
        // Full precision, deliberately (see computeEer).
        threshold: t,
        achieved_far: round6(far),
        frr: gen.length ? round6(lowerBound(gen, t) / gen.length) : null,
        impostor_count: imp.length,
        genuine_count: gen.length,
        fa_resolution_limited: 1 / imp.length > targetFar,
      };
    }
  }
  return null; // unreachable: the sentinel always yields FAR 0
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(dir, name));
}

function loadEmbeddingCache(dataDir) {
  const cacheDir = path.join(dataDir, 'life-archive', 'voiceprints', 'ecapa-embeddings');
  const files = listJsonFiles(cacheDir);
  const byAudio = new Map();
  let unusable = 0;
  let deduped = 0;
  for (const file of files) {
    const row = readJson(file, null);
    const vector = row?.embedding?.vector;
    if (!Array.isArray(vector) || !vector.length || row?.embedding?.quality?.usable === false) {
      unusable += 1;
      continue;
    }
    const key = normalizeAudioKey(row.audio_path);
    if (!key) {
      unusable += 1;
      continue;
    }
    const candidate = {
      audio_path: String(row.audio_path || ''),
      key,
      vector,
      generated_at: String(row.generated_at || ''),
      cache_file: path.basename(file),
      net_speech_seconds: Number.isFinite(row?.embedding?.quality?.net_speech_seconds)
        ? row.embedding.quality.net_speech_seconds
        : null,
    };
    const existing = byAudio.get(key);
    if (!existing) {
      byAudio.set(key, candidate);
      continue;
    }
    deduped += 1;
    // Same clip cached more than once (re-cut audio changes the stat key in
    // the cache filename): keep the newest row, filename as deterministic tie.
    if (
      candidate.generated_at > existing.generated_at ||
      (candidate.generated_at === existing.generated_at &&
        candidate.cache_file > existing.cache_file)
    ) {
      byAudio.set(key, candidate);
    }
  }
  return {
    cacheDir,
    filesRead: files.length,
    rows: [...byAudio.values()].sort((a, b) => a.key.localeCompare(b.key)),
    unusable,
    deduped,
  };
}

function loadProbeIndex(dataDir) {
  const file = path.join(dataDir, 'life-archive', 'voiceprints', 'track-probe-index-latest.json');
  const index = readJson(file, null);
  const byAudio = new Map();
  for (const row of index?.probes || []) {
    const key = normalizeAudioKey(row.probe_audio_path);
    if (key && !byAudio.has(key)) byAudio.set(key, row);
  }
  return { file, present: Boolean(index), rowCount: (index?.probes || []).length, byAudio };
}

function loadGroups(dataDir) {
  const file = path.join(dataDir, 'life-archive', 'voiceprints', 'ecapa-speaker-groups-latest.json');
  const artifact = readJson(file, null);
  const clusterToGroup = new Map();
  const groupToClusters = new Map();
  for (const group of artifact?.groups || []) {
    const groupId = String(group.acoustic_ExampleCo_id || '');
    if (!groupId) continue;
    if (!groupToClusters.has(groupId)) groupToClusters.set(groupId, new Set());
    for (const vcid of group.voice_cluster_ids || []) {
      const id = String(vcid || '');
      if (!id) continue;
      groupToClusters.get(groupId).add(id);
      if (!clusterToGroup.has(id)) clusterToGroup.set(id, groupId);
    }
  }
  return {
    file,
    present: Boolean(artifact),
    groupCount: (artifact?.groups || []).length,
    clusterToGroup,
    groupToClusters,
  };
}

function loadRegistry(dataDir) {
  const file = path.join(dataDir, 'life-archive', 'voice-identity-registry.json');
  const raw = readJson(file, null);
  const registry = raw || {};
  const aliasesFile = path.join(dataDir, 'agent', 'voiceprint-contact-aliases.json');
  const aliases = readJson(aliasesFile, {}) || {};
  const canonicalMap = buildCanonicalPersonMap(registry, aliases);
  const canonical = (personId) => canonicalMap.get(personId) || personId;

  // ExampleCo-confirmed cluster -> person resolutions.
  const clusterPerson = new Map();
  for (const [vcid, resolution] of Object.entries(registry.voice_cluster_resolutions || {})) {
    if (resolution?.status === 'confirmed_by_ExampleCo' && resolution.person_id) {
      clusterPerson.set(String(vcid), canonical(String(resolution.person_id)));
    }
  }

  // ExampleCo-confirmed acoustic-group -> person resolutions (stale-cluster guard).
  const groupPerson = new Map();
  for (const [groupId, resolution] of Object.entries(registry.acoustic_group_resolutions || {})) {
    if (resolution?.status === 'confirmed_by_ExampleCo' && resolution.person_id) {
      groupPerson.set(String(groupId), canonical(String(resolution.person_id)));
    }
  }

  // Enrollment reference clips, gated exactly like the resolver's
  // loadReferenceEmbeddings: skip quarantined clips, and require a
  // human-confirmed person or a ExampleCo-confirmed cluster resolution.
  const enrollmentByAudio = new Map();
  for (const enrollment of registry.enrollments || []) {
    if (enrollment.calibration_quarantine_status === 'quarantined') continue;
    const audio = enrollment.reference_audio_rel || enrollment.reference_audio_path;
    if (!audio) continue;
    const person = registry.people?.[enrollment.person_id] || {};
    const clusterId = enrollment.voice_cluster_id || null;
    const resolution = clusterId
      ? registry.voice_cluster_resolutions?.[clusterId]
      : null;
    const personConfirmed =
      person.identity_confirmation_status === 'confirmed_by_ExampleCo' &&
      person.voiceprint_status === 'enrolled';
    if (!personConfirmed && resolution?.status !== 'confirmed_by_ExampleCo') continue;
    const key = normalizeAudioKey(audio);
    if (!key || enrollmentByAudio.has(key)) continue;
    enrollmentByAudio.set(key, {
      person_id: canonical(String(enrollment.person_id)),
      otid: String(enrollment.otid || ''),
      duration_seconds: Number.isFinite(enrollment.duration_seconds)
        ? enrollment.duration_seconds
        : null,
    });
  }

  return {
    file,
    present: Boolean(raw),
    aliasesFile,
    aliasEntryCount: Object.keys(aliases).length,
    canonical,
    clusterPerson,
    groupPerson,
    enrollmentByAudio,
  };
}

function loadEnrichedIdentity(dataDir, canonical) {
  const dir = path.join(dataDir, 'otter', 'enriched');
  const files = listJsonFiles(dir);
  const confirmedByTrack = new Map(); // `${otid}|${label}` -> canonical person id
  const clusterByTrack = new Map(); // `${otid}|${label}` -> voice_cluster_id
  for (const file of files) {
    const enriched = readJson(file, null);
    if (!enriched) continue;
    const otid = String(enriched.otid || path.basename(file, '.json'));
    for (const [label, identity] of Object.entries(enriched.speaker_identity_tracks || {})) {
      const key = `${otid}|${label}`;
      if (identity?.voice_cluster_id && !clusterByTrack.has(key)) {
        clusterByTrack.set(key, String(identity.voice_cluster_id));
      }
      if (
        identity?.identity_tier === CONFIRMED_ENRICHED_TIER &&
        identity.person_id &&
        !confirmedByTrack.has(key)
      ) {
        confirmedByTrack.set(key, canonical(String(identity.person_id)));
      }
    }
    for (const segment of enriched.segments || []) {
      const resolved = segment?.resolved_speaker;
      if (!resolved) continue;
      const key = `${otid}|${String(segment.speaker_model_label || '')}`;
      if (resolved.voice_cluster_id && !clusterByTrack.has(key)) {
        clusterByTrack.set(key, String(resolved.voice_cluster_id));
      }
      if (
        resolved.identity_tier === CONFIRMED_ENRICHED_TIER &&
        resolved.person_id &&
        !confirmedByTrack.has(key)
      ) {
        confirmedByTrack.set(key, canonical(String(resolved.person_id)));
      }
    }
  }
  return { dir, filesScanned: files.length, confirmedByTrack, clusterByTrack };
}

/**
 * Join every usable cached embedding to (otid, track/cluster id, optional
 * person, optional duration) using whatever mapping artifacts exist. Rows that
 * cannot be tied to an otid plus some track identity are dropped and counted.
 */
function buildDataset(dataDir) {
  const cache = loadEmbeddingCache(dataDir);
  const probeIndex = loadProbeIndex(dataDir);
  const groups = loadGroups(dataDir);
  const registry = loadRegistry(dataDir);
  const enriched = loadEnrichedIdentity(dataDir, registry.canonical);

  const sourcesUsed = new Set();
  if (cache.rows.length) sourcesUsed.add('ecapa-embedding-cache');

  // Pass 1: raw joins.
  const rows = [];
  let missingOtid = 0;
  for (const cached of cache.rows) {
    // Parse from the ORIGINAL path, not the lowercased join key: otids are
    // case-sensitive identifiers and must compare equal across sources.
    const parsed = parseTrackAudioPath(cached.audio_path);
    const probe = probeIndex.byAudio.get(cached.key) || null;
    const enrollment = registry.enrollmentByAudio.get(cached.key) || null;
    const otid = String(probe?.otid || enrollment?.otid || parsed?.otid || '');
    if (!otid) {
      missingOtid += 1;
      continue;
    }
    const label = String(probe?.speaker_model_label ?? parsed?.speaker_model_label ?? '');
    const trackKey = label ? `${otid}|${label}` : '';
    const voiceClusterId = String(
      probe?.voice_cluster_id || (trackKey && enriched.clusterByTrack.get(trackKey)) || '',
    );
    const duration = Number.isFinite(probe?.duration_seconds)
      ? probe.duration_seconds
      : Number.isFinite(parsed?.duration_seconds)
        ? parsed.duration_seconds
        : Number.isFinite(enrollment?.duration_seconds)
          ? enrollment.duration_seconds
          : Number.isFinite(probe?.probe_quality?.clip_seconds)
            ? probe.probe_quality.clip_seconds
            : null;

    let personId = null;
    let personSource = null;
    if (enrollment?.person_id) {
      personId = enrollment.person_id;
      personSource = 'registry-enrollments';
    } else if (voiceClusterId && registry.clusterPerson.has(voiceClusterId)) {
      personId = registry.clusterPerson.get(voiceClusterId);
      personSource = 'registry-voice-cluster-resolutions';
    } else if (trackKey && enriched.confirmedByTrack.has(trackKey)) {
      personId = enriched.confirmedByTrack.get(trackKey);
      personSource = 'enriched-resolved-speaker';
    }

    if (probe) sourcesUsed.add('track-probe-index');
    if (personSource) sourcesUsed.add(personSource);

    rows.push({
      audio_path: cached.audio_path,
      key: cached.key,
      vector: cached.vector,
      otid,
      speaker_model_label: label,
      track_key: trackKey,
      voice_cluster_id: voiceClusterId || null,
      person_id: personId,
      duration_seconds: duration,
      net_speech_seconds: cached.net_speech_seconds,
    });
  }

  // Vector dimensions must agree for cosine to mean anything (a backend swap
  // changes dimensionality); keep the dominant dimension, count the rest out.
  const dimCounts = new Map();
  for (const row of rows) dimCounts.set(row.vector.length, (dimCounts.get(row.vector.length) || 0) + 1);
  const dominantDim = [...dimCounts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] || 0;
  const dimensionMismatched = rows.filter((row) => row.vector.length !== dominantDim).length;
  const usable = rows.filter((row) => row.vector.length === dominantDim);

  // Pass 2: durable cluster ids for rows without a person.
  //   - primary: the groups artifact (acoustic_ExampleCo_id).
  //   - fallback: a voice_cluster_id seen in 2+ distinct otids among these
  //     rows is durable by observation (Otter reused the id across calls).
  const otidsByVcid = new Map();
  for (const row of usable) {
    if (!row.voice_cluster_id) continue;
    if (!otidsByVcid.has(row.voice_cluster_id)) otidsByVcid.set(row.voice_cluster_id, new Set());
    otidsByVcid.get(row.voice_cluster_id).add(row.otid);
  }
  for (const row of usable) {
    row.cluster_id = null;
    if (row.person_id || !row.voice_cluster_id) continue;
    const groupId = groups.clusterToGroup.get(row.voice_cluster_id);
    if (groupId) {
      row.cluster_id = `group:${groupId}`;
      sourcesUsed.add('ecapa-speaker-groups');
    } else if ((otidsByVcid.get(row.voice_cluster_id)?.size || 0) >= 2) {
      row.cluster_id = `voice_cluster:${row.voice_cluster_id}`;
      sourcesUsed.add('cross-otid-voice-cluster-fallback');
    }
  }

  return {
    rows: usable,
    stats: {
      cache_files_read: cache.filesRead,
      cache_rows_unusable: cache.unusable,
      cache_rows_deduped: cache.deduped,
      rows_missing_otid: missingOtid,
      rows_dimension_mismatched: dimensionMismatched,
      dominant_vector_dimension: dominantDim,
      embeddings_usable: usable.length,
      embeddings_with_person: usable.filter((row) => row.person_id).length,
      embeddings_with_cluster_only: usable.filter((row) => !row.person_id && row.cluster_id).length,
      embeddings_unmapped: usable.filter((row) => !row.person_id && !row.cluster_id).length,
    },
    inputs: {
      embedding_cache_dir: cache.cacheDir,
      probe_index_path: probeIndex.file,
      probe_index_present: probeIndex.present,
      probe_index_rows: probeIndex.rowCount,
      registry_path: registry.file,
      registry_present: registry.present,
      confirmed_cluster_resolutions: registry.clusterPerson.size,
      confirmed_acoustic_group_resolutions: registry.groupPerson.size,
      usable_enrollment_references: registry.enrollmentByAudio.size,
      contact_aliases_path: registry.aliasesFile,
      contact_alias_entries: registry.aliasEntryCount,
      groups_path: groups.file,
      groups_present: groups.present,
      durable_groups: groups.groupCount,
      enriched_dir: enriched.dir,
      enriched_files_scanned: enriched.filesScanned,
      enriched_confirmed_tracks: enriched.confirmedByTrack.size,
      sources_used: [...sourcesUsed].sort(),
    },
    registry,
    groups,
  };
}

/** ExampleCo-confirmed person ids attached to an entity, for the shared-confirmation purity rule. */
function confirmedPersonsForEntity(entity, dataset) {
  if (entity.type === 'person') return new Set([entity.id]);
  const out = new Set();
  if (entity.id.startsWith('group:')) {
    const groupId = entity.id.slice('group:'.length);
    const confirmed = dataset.registry.groupPerson.get(groupId);
    if (confirmed) out.add(confirmed);
    for (const vcid of dataset.groups.groupToClusters.get(groupId) || []) {
      const person = dataset.registry.clusterPerson.get(vcid);
      if (person) out.add(person);
    }
  } else if (entity.id.startsWith('voice_cluster:')) {
    const vcid = entity.id.slice('voice_cluster:'.length);
    const person = dataset.registry.clusterPerson.get(vcid);
    if (person) out.add(person);
  }
  return out;
}

function buildEntities(dataset) {
  const persons = new Map();
  const clusters = new Map();
  for (const row of dataset.rows) {
    if (row.person_id) {
      if (!persons.has(row.person_id)) persons.set(row.person_id, []);
      persons.get(row.person_id).push(row);
    } else if (row.cluster_id) {
      if (!clusters.has(row.cluster_id)) clusters.set(row.cluster_id, []);
      clusters.get(row.cluster_id).push(row);
    }
  }
  const toEntity = (type) => ([id, members]) => ({
    type,
    id,
    members: [...members].sort((a, b) => a.key.localeCompare(b.key)),
    centroid: meanVector(members.map((row) => row.vector)),
  });
  return {
    persons: [...persons.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(toEntity('person')),
    clusters: [...clusters.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(toEntity('cluster')),
  };
}

function buildPairs(dataset, { bands }) {
  const { persons, clusters } = buildEntities(dataset);
  const tiers = {
    genuine_person: { all: [], byBand: new Map() },
    genuine_cluster: { all: [], byBand: new Map() },
    impostor: { all: [], byBand: new Map() },
  };
  const excluded = {
    same_otid: { genuine_person: 0, genuine_cluster: 0, impostor: 0 },
    alias_suspicion_entity_pairs: 0,
    alias_suspicion_member_pairs: 0,
    shared_confirmation_entity_pairs: 0,
    shared_confirmation_member_pairs: 0,
  };

  const push = (tier, score, band) => {
    tiers[tier].all.push(score);
    if (!tiers[tier].byBand.has(band)) tiers[tier].byBand.set(band, []);
    tiers[tier].byBand.get(band).push(score);
  };

  const genuineWithin = (entity, tier) => {
    for (let i = 0; i < entity.members.length; i += 1) {
      for (let j = i + 1; j < entity.members.length; j += 1) {
        const a = entity.members[i];
        const b = entity.members[j];
        if (a.otid === b.otid) {
          excluded.same_otid[tier] += 1;
          continue;
        }
        push(tier, cosine(a.vector, b.vector), bandForPair(a.duration_seconds, b.duration_seconds, bands));
      }
    }
  };
  for (const entity of persons) genuineWithin(entity, 'genuine_person');
  for (const entity of clusters) genuineWithin(entity, 'genuine_cluster');

  const impostorAcross = (entities) => {
    for (let i = 0; i < entities.length; i += 1) {
      for (let j = i + 1; j < entities.length; j += 1) {
        const A = entities[i];
        const B = entities[j];
        const memberPairCount = A.members.length * B.members.length;
        if (cosine(A.centroid, B.centroid) >= ALIAS_CENTROID_COSINE) {
          excluded.alias_suspicion_entity_pairs += 1;
          excluded.alias_suspicion_member_pairs += memberPairCount;
          continue;
        }
        const confirmedA = confirmedPersonsForEntity(A, dataset);
        const confirmedB = confirmedPersonsForEntity(B, dataset);
        if ([...confirmedA].some((person) => confirmedB.has(person))) {
          excluded.shared_confirmation_entity_pairs += 1;
          excluded.shared_confirmation_member_pairs += memberPairCount;
          continue;
        }
        for (const a of A.members) {
          for (const b of B.members) {
            if (a.otid === b.otid) {
              excluded.same_otid.impostor += 1;
              continue;
            }
            push(
              'impostor',
              cosine(a.vector, b.vector),
              bandForPair(a.duration_seconds, b.duration_seconds, bands),
            );
          }
        }
      }
    }
  };
  // Person vs cluster pairs are never generated: an unresolved cluster can BE
  // one of the enrolled people, so treating it as an impostor would fabricate
  // false rejections of the truth.
  impostorAcross(persons);
  impostorAcross(clusters);

  return {
    tiers,
    excluded,
    entityCounts: { persons: persons.length, clusters: clusters.length },
  };
}

function runSweep({ dataDir: dataDirIn, outPath: outIn, minPairs = DEFAULT_MIN_PAIRS, durationBands = DEFAULT_DURATION_BANDS, write = true } = {}) {
  const dataDir = resolveDataDir(dataDirIn);
  const outPath = path.resolve(
    outIn || path.join(dataDir, 'life-archive', 'voiceprints', 'calibration-sweep-latest.json'),
  );
  const bands = parseDurationBands(durationBands);
  const dataset = buildDataset(dataDir);
  const { tiers, excluded, entityCounts } = buildPairs(dataset, { bands });

  const genuinePerson = tiers.genuine_person.all;
  const genuineCluster = tiers.genuine_cluster.all;
  const impostor = tiers.impostor.all;

  // EER and operating thresholds use the person-genuine tier when it exists.
  // The cluster-genuine tier is optimistically biased (membership was formed
  // by a score threshold), so it is only a fallback, and the artifact records
  // which tier the numbers came from.
  const genuineTierUsed = genuinePerson.length
    ? 'genuine_person'
    : genuineCluster.length
      ? 'genuine_cluster'
      : null;
  const genuineForOperating = genuineTierUsed === 'genuine_person' ? genuinePerson : genuineCluster;

  const eerBase =
    genuineTierUsed && impostor.length ? computeEer(genuineForOperating, impostor) : null;
  const eer = eerBase
    ? { ...eerBase, genuine_tier_used: genuineTierUsed, genuine_count: genuineForOperating.length, impostor_count: impostor.length }
    : null;
  const suggestedThresholds =
    genuineTierUsed && impostor.length
      ? TARGET_FALSE_ACCEPT_RATES.map((target) =>
          thresholdForFa(genuineForOperating, impostor, target),
        ).filter(Boolean)
      : [];

  const missing = [];
  if (impostor.length < minPairs) {
    missing.push(
      `impostor_pairs: have ${impostor.length}, need >= ${minPairs}; need more distinct confirmed persons or durable ExampleCo clusters with cross-call embeddings (or lower --min-pairs)`,
    );
  }
  if (!genuinePerson.length && !genuineCluster.length) {
    missing.push(
      'genuine_pairs: none; need the same confirmed person or the same durable ExampleCo cluster embedded in at least two different otids',
    );
  }

  const bandLabels = [...bands.map((band) => band.label), 'ExampleCo', 'outside_bands'];
  const durationBandsOut = {};
  for (const label of bandLabels) {
    const genuinePersonBand = tiers.genuine_person.byBand.get(label) || [];
    const genuineClusterBand = tiers.genuine_cluster.byBand.get(label) || [];
    const impostorBand = tiers.impostor.byBand.get(label) || [];
    if (
      !bands.some((band) => band.label === label) &&
      !genuinePersonBand.length &&
      !genuineClusterBand.length &&
      !impostorBand.length
    ) {
      continue; // only surface ExampleCo/outside_bands buckets that actually have pairs
    }
    durationBandsOut[label] = {
      genuine_person: summarizeScores(genuinePersonBand),
      genuine_cluster: summarizeScores(genuineClusterBand),
      impostor: summarizeScores(impostorBand),
    };
  }

  const artifact = {
    schema: 'life_archive_voiceprint_calibration_sweep.v1',
    generated_at: new Date().toISOString(),
    status: missing.length ? 'insufficient_pairs' : 'ok',
    missing,
    data_dir: dataDir,
    out_path: outPath,
    config: {
      min_pairs: minPairs,
      duration_bands: bands.map((band) => band.label),
      alias_centroid_cosine_exclusion: ALIAS_CENTROID_COSINE,
      histogram_bin_width: HISTOGRAM_BIN_WIDTH,
      target_false_accept_rates: TARGET_FALSE_ACCEPT_RATES,
      confirmed_identity_evidence_only: true,
      person_vs_cluster_pairs_generated: false,
      pair_duration_band_rule: 'min of both durations; ExampleCo unless both sides have a known duration',
    },
    inputs: dataset.inputs,
    dataset: dataset.stats,
    entities: entityCounts,
    pairs: {
      genuine_person: genuinePerson.length,
      genuine_cluster: genuineCluster.length,
      impostor: impostor.length,
      excluded,
    },
    distributions: {
      genuine_person: summarizeScores(genuinePerson),
      genuine_cluster: summarizeScores(genuineCluster),
      impostor: summarizeScores(impostor),
    },
    duration_bands: durationBandsOut,
    eer,
    suggested_thresholds: suggestedThresholds,
  };

  if (write) saveJson(outPath, artifact);
  return artifact;
}

function main() {
  const artifact = runSweep({
    dataDir: argValue('--data-dir', ''),
    outPath: argValue('--out', ''),
    minPairs: Number(argValue('--min-pairs', String(DEFAULT_MIN_PAIRS))) || DEFAULT_MIN_PAIRS,
    durationBands: argValue('--duration-bands', DEFAULT_DURATION_BANDS),
    write: !hasArg('--dry-run'),
  });
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}

module.exports = {
  DEFAULT_DURATION_BANDS,
  DEFAULT_MIN_PAIRS,
  ALIAS_CENTROID_COSINE,
  HISTOGRAM_BIN_WIDTH,
  TARGET_FALSE_ACCEPT_RATES,
  resolveDataDir,
  normalizeAudioKey,
  parseTrackAudioPath,
  parseDurationBands,
  bandForPair,
  meanVector,
  summarizeScores,
  computeEer,
  thresholdForFa,
  buildDataset,
  buildPairs,
  runSweep,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
}
