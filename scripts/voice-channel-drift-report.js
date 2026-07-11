#!/usr/bin/env node
/**
 * Voice channel drift report (audit Phase D2, Codex amendment 16).
 *
 * Decides the per-channel sub-print question WITH DATA: per-channel sub-prints
 * stay deferred unless recording channel/condition is measured to materially
 * shift genuine match scores. Materiality bar: the same-channel vs
 * cross-channel genuine score gap must reach 0.05 cosine with at least 30
 * pairs on each side; anything smaller or thinner is reported honestly as
 * not-material or inconclusive.
 *
 * Inputs (DATA_DIR via SECONDBRAIN_DATA_DIR || REPO/data):
 *   - data/life-archive/voiceprints/calibration-sweep-latest.json is checked
 *     for per-pair metadata; the v1 artifact ExampleCos aggregate distributions
 *     only, so pairs are recomputed from the ecapa embedding cache with the
 *     same identity evidence and purity rules the sweep uses (buildDataset is
 *     imported from scripts/voiceprint-calibration-sweep.js).
 *   - data/otter/enriched/*.json plus data/otter/audio-full/* supply the call
 *     metadata the channel proxy is derived from.
 *
 * Channel proxy, explicit and never fabricated. Coarse tags per otid via the
 * first eligible rung of a ladder (a rung is eligible when at least two
 * distinct tags each cover 2+ calls):
 *   1. title_keywords   phone-ish vs meeting-ish title hints
 *   2. audio_extension  full-call audio container (ext_mp3, ext_wav, ...)
 *   3. duration_bucket  under vs over 15 minutes
 * If no rung is eligible the artifact says channel_proxy 'unavailable' and
 * status inconclusive rather than inventing tags.
 *
 * Output: data/life-archive/voiceprints/channel-drift-latest.json
 *
 * Usage:
 *   node scripts/voice-channel-drift-report.js [--data-dir data] [--out <file>] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { cosine, DUPLICATE_CENTROID_COSINE } = require('./lib/voice-reference-people');
const { buildDataset, resolveDataDir, meanVector } = require('./voiceprint-calibration-sweep');

const SCHEMA = 'life_archive_voice_channel_drift.v1';
const GAP_MATERIAL_COSINE = 0.05;
const MIN_PAIRS_PER_SIDE = 30;
const MIN_OTIDS_PER_TAG = 2;
const DURATION_BUCKET_THRESHOLD_SECONDS = 900;
const CHANNEL_PROXY_LADDER = ['title_keywords', 'audio_extension', 'duration_bucket'];

const PHONE_TITLE_HINT = /\b(phone|cell|mobile|voicemail|dial(?:ed|ing)?)\b/i;
const MEETING_TITLE_HINT = /\b(meeting|zoom|teams|meet|webinar|stand-?up|sync|huddle|conference)\b/i;

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

function round6(value) {
  return value === null || value === undefined ? null : Number(Number(value).toFixed(6));
}

/** Coarse tag from a call title; ambiguity (both hints) yields no tag. */
function titleTag(title) {
  const value = String(title || '');
  const phone = PHONE_TITLE_HINT.test(value);
  const meeting = MEETING_TITLE_HINT.test(value);
  if (phone && !meeting) return 'phone';
  if (meeting && !phone) return 'meeting';
  return null;
}

function extTag(ext) {
  const clean = String(ext || '').replace(/^\./, '').toLowerCase();
  return clean ? `ext_${clean}` : null;
}

function durationTag(durationSec) {
  const n = Number(durationSec);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < DURATION_BUCKET_THRESHOLD_SECONDS ? 'duration_lt_15m' : 'duration_gte_15m';
}

/**
 * Derive one coarse channel tag per otid from call metadata rows
 * ({otid, title, duration_sec, audio_ext}). Walks the proxy ladder and picks
 * the first eligible rung; returns channel_proxy 'unavailable' with an empty
 * tag map when nothing discriminates. Candidate stats for every rung are
 * returned so the artifact can show WHY a rung was or was not used.
 */
function deriveChannelTags(callRows) {
  const proxies = {
    title_keywords: new Map(),
    audio_extension: new Map(),
    duration_bucket: new Map(),
  };
  for (const row of callRows || []) {
    const otid = String(row?.otid || '');
    if (!otid) continue;
    const byProxy = {
      title_keywords: titleTag(row.title),
      audio_extension: extTag(row.audio_ext),
      duration_bucket: durationTag(row.duration_sec),
    };
    for (const [proxy, tagValue] of Object.entries(byProxy)) {
      if (tagValue && !proxies[proxy].has(otid)) proxies[proxy].set(otid, tagValue);
    }
  }
  const candidates = {};
  let chosen = null;
  for (const proxy of CHANNEL_PROXY_LADDER) {
    const tagCounts = {};
    for (const tagValue of proxies[proxy].values()) {
      tagCounts[tagValue] = (tagCounts[tagValue] || 0) + 1;
    }
    const tagsAboveFloor = Object.values(tagCounts).filter((count) => count >= MIN_OTIDS_PER_TAG).length;
    const eligible = tagsAboveFloor >= 2;
    candidates[proxy] = { tag_counts: tagCounts, tagged_otids: proxies[proxy].size, eligible };
    if (!chosen && eligible) chosen = proxy;
  }
  return {
    channel_proxy: chosen || 'unavailable',
    tagsByOtid: chosen ? proxies[chosen] : new Map(),
    candidates,
  };
}

/** Call metadata per otid from enriched transcripts plus full-audio files. */
function loadCallMeta(dataDir) {
  const enrichedDir = path.join(dataDir, 'otter', 'enriched');
  const byOtid = new Map();
  if (fs.existsSync(enrichedDir)) {
    for (const name of fs.readdirSync(enrichedDir).filter((f) => f.endsWith('.json')).sort()) {
      const enriched = readJson(path.join(enrichedDir, name), null);
      if (!enriched) continue;
      const otid = String(enriched.otid || path.basename(name, '.json'));
      if (!byOtid.has(otid)) {
        byOtid.set(otid, {
          otid,
          title: String(enriched.title || ''),
          duration_sec: Number.isFinite(Number(enriched.duration_sec)) ? Number(enriched.duration_sec) : null,
          audio_ext: null,
        });
      }
    }
  }
  const audioFullDir = path.join(dataDir, 'otter', 'audio-full');
  if (fs.existsSync(audioFullDir)) {
    for (const name of fs.readdirSync(audioFullDir).sort()) {
      const parsed = path.parse(name);
      if (!parsed.ext) continue;
      const existing = byOtid.get(parsed.name);
      if (existing) {
        if (!existing.audio_ext) existing.audio_ext = parsed.ext.toLowerCase();
      } else {
        byOtid.set(parsed.name, { otid: parsed.name, title: '', duration_sec: null, audio_ext: parsed.ext.toLowerCase() });
      }
    }
  }
  return { enrichedDir, audioFullDir, rows: [...byOtid.values()] };
}

function medianOfSorted(sortedAsc) {
  const n = sortedAsc.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

function statBlock(scores) {
  if (!scores.length) return { n: 0, mean: null, median: null };
  const sorted = [...scores].sort((a, b) => a - b);
  return {
    n: sorted.length,
    mean: round6(sorted.reduce((sum, v) => sum + v, 0) / sorted.length),
    median: round6(medianOfSorted(sorted)),
  };
}

/**
 * The decision math, pure so tests can prove it on synthetic pair rows.
 * pairRows: [{tier: 'genuine'|'impostor', score, channel_a, channel_b}].
 * Pairs missing a channel tag on either side are excluded and counted, never
 * guessed. Gap definition: mean(same-channel genuine) minus
 * mean(cross-channel genuine); positive means cross-channel scores are
 * depressed, i.e. channel drift.
 */
function analyzePairs(pairRows, opts = {}) {
  const gapMaterial = Number.isFinite(opts.gapMaterialCosine) ? opts.gapMaterialCosine : GAP_MATERIAL_COSINE;
  const minPerSide = Number.isFinite(opts.minPairsPerSide) ? opts.minPairsPerSide : MIN_PAIRS_PER_SIDE;

  const perChannel = new Map();
  const sameGenuine = [];
  const crossGenuine = [];
  const sameImpostor = [];
  const crossImpostor = [];
  let ExampleCoExcluded = 0;

  for (const row of pairRows || []) {
    const tier = row?.tier === 'genuine' ? 'genuine' : row?.tier === 'impostor' ? 'impostor' : null;
    const score = Number(row?.score);
    if (!tier || !Number.isFinite(score)) continue;
    const a = row.channel_a || null;
    const b = row.channel_b || null;
    if (!a || !b) {
      ExampleCoExcluded += 1;
      continue;
    }
    if (a === b) {
      if (!perChannel.has(a)) perChannel.set(a, { genuine: [], impostor: [] });
      perChannel.get(a)[tier].push(score);
      (tier === 'genuine' ? sameGenuine : sameImpostor).push(score);
    } else {
      (tier === 'genuine' ? crossGenuine : crossImpostor).push(score);
    }
  }

  const same = statBlock(sameGenuine);
  const cross = statBlock(crossGenuine);
  const sameImp = statBlock(sameImpostor);
  const crossImp = statBlock(crossImpostor);
  const genuineGap = same.mean !== null && cross.mean !== null ? round6(same.mean - cross.mean) : null;
  const impostorGap = sameImp.mean !== null && crossImp.mean !== null ? round6(sameImp.mean - crossImp.mean) : null;

  const nFloorMet = same.n >= minPerSide && cross.n >= minPerSide;
  const driftMaterial = Boolean(nFloorMet && genuineGap !== null && genuineGap >= gapMaterial);

  let rationale;
  if (!nFloorMet) {
    rationale = `insufficient pairs to call drift: same-channel genuine n=${same.n}, cross-channel genuine n=${cross.n}, need >= ${minPerSide} per side; small samples never claim material drift`;
  } else if (driftMaterial) {
    rationale = `same-channel genuine mean ${same.mean} vs cross-channel ${cross.mean}: gap ${genuineGap} >= ${gapMaterial} cosine with n >= ${minPerSide} per side; channel drift is a measured error source, per-channel sub-prints recommended (Codex amendment 16)`;
  } else {
    rationale = `gap ${genuineGap} < ${gapMaterial} cosine with adequate n (same ${same.n} / cross ${cross.n}); channel drift is not a top error source, per-channel sub-prints stay deferred (Codex amendment 16)`;
  }

  const perChannelOut = {};
  for (const [tagValue, scores] of [...perChannel.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const g = statBlock(scores.genuine);
    const imp = statBlock(scores.impostor);
    perChannelOut[tagValue] = {
      genuine_score_mean: g.mean,
      genuine_score_median: g.median,
      genuine_n: g.n,
      impostor_score_mean: imp.mean,
      impostor_score_median: imp.median,
      impostor_n: imp.n,
    };
  }

  return {
    status: nFloorMet ? 'ok' : 'inconclusive',
    per_channel: perChannelOut,
    counts: {
      same_channel_genuine: same.n,
      cross_channel_genuine: cross.n,
      same_channel_impostor: sameImp.n,
      cross_channel_impostor: crossImp.n,
      ExampleCo_channel_pairs_excluded: ExampleCoExcluded,
    },
    same_channel_genuine: same,
    cross_channel_genuine: cross,
    same_channel_impostor: sameImp,
    cross_channel_impostor: crossImp,
    cross_channel_vs_same_channel_genuine_gap: genuineGap,
    cross_channel_vs_same_channel_impostor_gap: impostorGap,
    verdict: {
      drift_material: driftMaterial,
      sub_prints_recommended: driftMaterial,
      rationale,
    },
  };
}

/**
 * Genuine/impostor pair rows with channel tags, rebuilt from the sweep's
 * dataset with the sweep's purity rules: same-otid pairs never count,
 * alias-suspect entity pairs (centroid cosine >= 0.999) and entity pairs
 * sharing a ExampleCo confirmation never feed the impostor set, and person vs
 * cluster pairs are never generated (an unresolved cluster may BE an enrolled
 * person).
 */
function buildPairRows(dataset, tagsByOtid) {
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
  const personEntities = [...persons.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(toEntity('person'));
  const clusterEntities = [...clusters.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(toEntity('cluster'));

  const confirmedPersonsFor = (entity) => {
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
      const person = dataset.registry.clusterPerson.get(entity.id.slice('voice_cluster:'.length));
      if (person) out.add(person);
    }
    return out;
  };

  const tagFor = (otid) => tagsByOtid.get(otid) || null;
  const pairs = [];
  const excluded = {
    same_otid: 0,
    alias_suspicion_entity_pairs: 0,
    shared_confirmation_entity_pairs: 0,
  };

  const genuineWithin = (entity) => {
    for (let i = 0; i < entity.members.length; i += 1) {
      for (let j = i + 1; j < entity.members.length; j += 1) {
        const a = entity.members[i];
        const b = entity.members[j];
        if (a.otid === b.otid) {
          excluded.same_otid += 1;
          continue;
        }
        pairs.push({
          tier: 'genuine',
          genuine_tier: entity.type,
          score: round6(cosine(a.vector, b.vector)),
          channel_a: tagFor(a.otid),
          channel_b: tagFor(b.otid),
        });
      }
    }
  };
  for (const entity of personEntities) genuineWithin(entity);
  for (const entity of clusterEntities) genuineWithin(entity);

  const impostorAcross = (entities) => {
    for (let i = 0; i < entities.length; i += 1) {
      for (let j = i + 1; j < entities.length; j += 1) {
        const A = entities[i];
        const B = entities[j];
        if (cosine(A.centroid, B.centroid) >= DUPLICATE_CENTROID_COSINE) {
          excluded.alias_suspicion_entity_pairs += 1;
          continue;
        }
        const confirmedA = confirmedPersonsFor(A);
        const confirmedB = confirmedPersonsFor(B);
        if ([...confirmedA].some((person) => confirmedB.has(person))) {
          excluded.shared_confirmation_entity_pairs += 1;
          continue;
        }
        for (const a of A.members) {
          for (const b of B.members) {
            if (a.otid === b.otid) {
              excluded.same_otid += 1;
              continue;
            }
            pairs.push({
              tier: 'impostor',
              score: round6(cosine(a.vector, b.vector)),
              channel_a: tagFor(a.otid),
              channel_b: tagFor(b.otid),
            });
          }
        }
      }
    }
  };
  impostorAcross(personEntities);
  impostorAcross(clusterEntities);

  return {
    pairs,
    excluded,
    entityCounts: { persons: personEntities.length, clusters: clusterEntities.length },
  };
}

function runReport({ dataDir: dataDirIn = '', outPath: outIn = '', write = true, gapMaterialCosine, minPairsPerSide } = {}) {
  const dataDir = resolveDataDir(dataDirIn);
  const outPath = path.resolve(
    outIn || path.join(dataDir, 'life-archive', 'voiceprints', 'channel-drift-latest.json'),
  );
  const sweepPath = path.join(dataDir, 'life-archive', 'voiceprints', 'calibration-sweep-latest.json');
  const sweepArtifact = readJson(sweepPath, null);
  const ExampleCosPerPair = Boolean(Array.isArray(sweepArtifact?.pair_rows) && sweepArtifact.pair_rows.length);
  const callMeta = loadCallMeta(dataDir);
  const proxy = deriveChannelTags(callMeta.rows);

  const artifact = {
    schema: SCHEMA,
    generated_at: new Date().toISOString(),
    status: 'inconclusive',
    data_dir: dataDir,
    out_path: outPath,
    channel_proxy: proxy.channel_proxy,
    channel_proxy_detail: {
      ladder: CHANNEL_PROXY_LADDER,
      min_otids_per_tag: MIN_OTIDS_PER_TAG,
      candidates: proxy.candidates,
      calls_seen: callMeta.rows.length,
    },
    calibration_sweep: {
      path: sweepPath,
      present: Boolean(sweepArtifact),
      ExampleCos_per_pair_metadata: ExampleCosPerPair,
      note: ExampleCosPerPair
        ? 'per-pair rows present in the sweep artifact, but pairs are recomputed here so channel tags stay consistent with this run'
        : 'calibration-sweep artifact ExampleCos aggregate distributions only; pairs recomputed from the ecapa embedding cache with the sweep purity rules',
    },
    pair_source: null,
    config: {
      gap_material_cosine: Number.isFinite(gapMaterialCosine) ? gapMaterialCosine : GAP_MATERIAL_COSINE,
      min_pairs_per_side: Number.isFinite(minPairsPerSide) ? minPairsPerSide : MIN_PAIRS_PER_SIDE,
      duration_bucket_threshold_seconds: DURATION_BUCKET_THRESHOLD_SECONDS,
      gap_definition:
        'same_channel_genuine_mean minus cross_channel_genuine_mean; positive means cross-channel genuine scores are depressed',
    },
    per_channel: {},
    cross_channel_vs_same_channel_genuine_gap: null,
    cross_channel_vs_same_channel_impostor_gap: null,
    verdict: { drift_material: false, sub_prints_recommended: false, rationale: '' },
  };

  if (proxy.channel_proxy === 'unavailable') {
    artifact.verdict.rationale =
      'no channel proxy derivable from enriched titles, full-audio extensions, or durations; refusing to fabricate channel tags, so drift is unmeasured and sub-prints stay deferred';
    if (write) saveJson(outPath, artifact);
    return artifact;
  }

  const dataset = buildDataset(dataDir);
  const built = buildPairRows(dataset, proxy.tagsByOtid);
  const analysis = analyzePairs(built.pairs, {
    gapMaterialCosine: artifact.config.gap_material_cosine,
    minPairsPerSide: artifact.config.min_pairs_per_side,
  });

  artifact.pair_source = 'recomputed_from_embedding_cache';
  artifact.entities = built.entityCounts;
  artifact.pairs = {
    genuine: built.pairs.filter((pair) => pair.tier === 'genuine').length,
    impostor: built.pairs.filter((pair) => pair.tier === 'impostor').length,
    excluded: built.excluded,
    counts: analysis.counts,
  };
  artifact.status = analysis.status;
  artifact.per_channel = analysis.per_channel;
  artifact.same_channel_genuine = analysis.same_channel_genuine;
  artifact.cross_channel_genuine = analysis.cross_channel_genuine;
  artifact.same_channel_impostor = analysis.same_channel_impostor;
  artifact.cross_channel_impostor = analysis.cross_channel_impostor;
  artifact.cross_channel_vs_same_channel_genuine_gap = analysis.cross_channel_vs_same_channel_genuine_gap;
  artifact.cross_channel_vs_same_channel_impostor_gap = analysis.cross_channel_vs_same_channel_impostor_gap;
  artifact.verdict = analysis.verdict;

  if (write) saveJson(outPath, artifact);
  return artifact;
}

function main() {
  const artifact = runReport({
    dataDir: argValue('--data-dir', ''),
    outPath: argValue('--out', ''),
    write: !hasArg('--dry-run'),
  });
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}

module.exports = {
  SCHEMA,
  GAP_MATERIAL_COSINE,
  MIN_PAIRS_PER_SIDE,
  MIN_OTIDS_PER_TAG,
  DURATION_BUCKET_THRESHOLD_SECONDS,
  CHANNEL_PROXY_LADDER,
  titleTag,
  extTag,
  durationTag,
  deriveChannelTags,
  loadCallMeta,
  analyzePairs,
  buildPairRows,
  runReport,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
}
