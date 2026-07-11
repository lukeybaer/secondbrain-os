#!/usr/bin/env node
/**
 * Voice embedding model bake-off driver (voiceprint audit Phase D1).
 *
 * Codex amendment 17: an embedding-model upgrade (ECAPA -> CAM++ / ReDimNet)
 * is gated on a LOCAL bake-off over THIS corpus's genuine/impostor pairs plus
 * a licensing/runtime check, because meeting/far-field audio can reorder
 * lab-benchmark winners. This driver builds the pairs manifest, runs
 * scripts/voice-model-bakeoff.py once per backend, computes per-backend EER
 * and FRR at the FA 1% / 0.1% operating points, and writes the bake-off
 * artifact with the adoption verdict.
 *
 * Pairs manifest sources, in order:
 *   1. data/life-archive/voiceprints/calibration-sweep-latest.json, IF its
 *      schema ExampleCos per-pair audio paths (a pair_list array). The current
 *      v1 sweep schema stores only score distributions and counts, so:
 *   2. direct build from the identity artifacts: genuine pairs are clips of
 *      the SAME canonical person across DIFFERENT otids (gated registry
 *      enrollments plus probe clips of ExampleCo-confirmed clusters); impostor
 *      pairs are cross-pairs between DISTINCT durable ExampleCo clusters from
 *      the track probe index (2+ otids each, never same-otid, never clusters
 *      confirmed to a person, same-acoustic-group clusters merged so a split
 *      voice cannot impostor against itself).
 *
 * Honesty rules inherited from the calibration sweep: deterministic pair
 * selection (no randomness, no Date dependence in pair ids), person-vs-cluster
 * pairs never generated, and a backend that cannot run records
 * backend_unavailable instead of failing the whole run.
 *
 * Adoption rule (the verdict): adopt only if relative EER gain >= 25% on
 * local pairs, AND the winner's license is verified. Adoption itself then
 * goes through the cross-generation ledger (generation stamping, dual-write,
 * re-embed queue) per dev-plans/voiceprint-cross-generation-identity-2026-07-07.html.
 *
 * Usage:
 *   node scripts/voice-model-bakeoff.js \
 *     [--data-dir data] [--out data/life-archive/voiceprints/model-bakeoff-latest.json] \
 *     [--max-pairs 400] [--backends ecapa,campp,redimnet] [--max-seconds 30] \
 *     [--manifest-only] [--dry-run]
 *
 * Env: SECONDBRAIN_DATA_DIR (data root), BAKEOFF_PYTHON / BAKEOFF_SCRIPT
 * (interpreter/script overrides, also how tests stub the python side),
 * VOICE_ECAPA_PYTHON (shared with the ecapa bridge), BAKEOFF_TIMEOUT_MS.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const {
  computeEer,
  thresholdForFa,
  normalizeAudioKey,
  resolveDataDir,
} = require('./voiceprint-calibration-sweep');
const { buildCanonicalPersonMap } = require('./lib/voice-reference-people');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_MAX_PAIRS = 400;
const ADOPT_MIN_RELATIVE_EER_GAIN = 0.25;
const ADOPT_RULE = 'adopt only if relative EER gain >= 25% on local pairs';
const OPERATING_FA_RATES = [0.01, 0.001];
const DEFAULT_TIMEOUT_MS = Number(process.env.BAKEOFF_TIMEOUT_MS || '14400000') || 14400000; // 4h: archive-scale embedding is slow on CPU
const VENV_PYTHON = process.platform === 'win32'
  ? path.join(REPO, '.venv-voice', 'Scripts', 'python.exe')
  : path.join(REPO, '.venv-voice', 'bin', 'python');

/**
 * Exact model ids and licenses (deliverable of the licensing/runtime check).
 * license_verified means the license text/badge was actually read, not assumed;
 * an unverified license blocks adoption no matter how good the EER is.
 */
const BACKEND_INFO = {
  ecapa: {
    model_id: 'speechbrain/spkrec-ecapa-voxceleb',
    source: 'speechbrain EncoderClassifier (production baseline, scripts/voice-embedding-ecapa.py)',
    license: 'Apache-2.0',
    license_verified: true,
    license_note:
      'SpeechBrain and the spkrec-ecapa-voxceleb model card are Apache-2.0; already shipped in the production Fargate image.',
  },
  campp: {
    model_id: 'iic/speech_campplus_sv_en_voxceleb_16k',
    source: 'modelscope speaker-verification pipeline (3D-Speaker project)',
    license: 'Apache-2.0',
    license_verified: true,
    license_note:
      '3D-Speaker (github.com/modelscope/3D-Speaker) is Apache-2.0, verified 2026-07-11; modelscope.cn hosts the CAM++ English VoxCeleb 16k model page under this exact id.',
  },
  redimnet: {
    model_id: 'torch.hub IDRnD/ReDimNet ReDimNet(model_name=b6, train_type=ft_lm, dataset=vox2)',
    source: 'torch.hub github.com/IDRnD/redimnet',
    license: 'MIT',
    license_verified: true,
    license_note:
      'Repo LICENSE is MIT, verified 2026-07-11 via github.com/IDRnD/redimnet. The pretrained b6 weights carry no separately stated terms; personal-scope use is fine, but re-verify before any redistribution.',
  },
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
    const text = fs.readFileSync(file, 'utf8');
    // Strip a UTF-8 BOM if present (same tolerance as the calibration sweep).
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
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

/**
 * Resolve a stored audio path to an absolute path. Artifact paths are
 * repo-relative ('data/otter/audio/...'), but the data root may live outside
 * the repo via SECONDBRAIN_DATA_DIR, so 'data/...' resolves against dataDir.
 */
function resolveAudioAbs(value, dataDir) {
  const cleaned = String(value || '').replace(/\\/g, '/');
  if (!cleaned) return '';
  if (path.isAbsolute(cleaned) || /^[A-Za-z]:\//.test(cleaned)) return path.resolve(cleaned);
  if (cleaned.startsWith('data/')) return path.join(dataDir, cleaned.slice('data/'.length));
  return path.join(REPO, cleaned);
}

/**
 * Deterministic pair id from the two (order-independent) audio keys: stable
 * across runs and hosts, no Date and no randomness by construction.
 */
function pairId(label, audioA, audioB) {
  const keys = [normalizeAudioKey(audioA), normalizeAudioKey(audioB)].sort();
  const digest = crypto.createHash('sha1').update(keys.join('|')).digest('hex').slice(0, 12);
  return `${label === 'genuine' ? 'gen' : 'imp'}_${digest}`;
}

/**
 * Pairs straight from the calibration sweep artifact IF a future schema adds a
 * per-pair list with audio paths. The v1 schema's `pairs` field is a count
 * object, which correctly returns null here (fall back to the direct build).
 */
function pairsFromCalibrationArtifact(artifact) {
  const list = Array.isArray(artifact?.pair_list)
    ? artifact.pair_list
    : Array.isArray(artifact?.pairs)
      ? artifact.pairs
      : null;
  if (!list || !list.length) return null;
  const rows = [];
  for (const row of list) {
    const audioA = row?.audio_a || row?.audio_path_a;
    const audioB = row?.audio_b || row?.audio_path_b;
    const label = row?.label === 'genuine' || row?.label === 'impostor' ? row.label : null;
    if (!audioA || !audioB || !label) return null; // schema lacks usable pair rows
    rows.push({
      pair_id: String(row.pair_id || pairId(label, audioA, audioB)),
      label,
      audio_a: String(audioA),
      audio_b: String(audioB),
    });
  }
  return rows;
}

/**
 * Direct pair construction from the registry + track probe index.
 *
 * Genuine: same canonical person, different otids. Person clip pools come from
 * gated registry enrollments (skip quarantined; require a ExampleCo-confirmed
 * person or cluster resolution, the resolver's own gate) plus probe clips
 * whose voice_cluster_id is ExampleCo-confirmed to a person.
 *
 * Impostor: cross-pairs between distinct durable ExampleCo clusters (2+ otids in
 * the probe index), same-otid pairs excluded. Clusters confirmed to a person
 * are NOT ExampleCo; clusters in the same acoustic group merge into one entity;
 * groups confirmed to a person are dropped entirely (they are a known human
 * and could otherwise impostor against their own enrollments). Person-vs-
 * cluster pairs are never generated: an unresolved cluster may BE one of the
 * enrolled people (same rule as the calibration sweep).
 */
function buildPairsFromRegistry(dataDir) {
  const registry = readJson(path.join(dataDir, 'life-archive', 'voice-identity-registry.json'), {}) || {};
  const aliases = readJson(path.join(dataDir, 'agent', 'voiceprint-contact-aliases.json'), {}) || {};
  const canonicalMap = buildCanonicalPersonMap(registry, aliases);
  const canonical = (pid) => canonicalMap.get(pid) || pid;

  const clusterPerson = new Map();
  for (const [vcid, resolution] of Object.entries(registry.voice_cluster_resolutions || {})) {
    if (resolution?.status === 'confirmed_by_ExampleCo' && resolution.person_id) {
      clusterPerson.set(String(vcid), canonical(String(resolution.person_id)));
    }
  }
  const confirmedGroups = new Set();
  for (const [groupId, resolution] of Object.entries(registry.acoustic_group_resolutions || {})) {
    if (resolution?.status === 'confirmed_by_ExampleCo' && resolution.person_id) {
      confirmedGroups.add(String(groupId));
    }
  }

  const groupsArtifact = readJson(
    path.join(dataDir, 'life-archive', 'voiceprints', 'ecapa-speaker-groups-latest.json'),
    null,
  );
  const clusterToGroup = new Map();
  for (const group of groupsArtifact?.groups || []) {
    const groupId = String(group.acoustic_ExampleCo_id || '');
    if (!groupId) continue;
    for (const vcid of group.voice_cluster_ids || []) {
      if (vcid && !clusterToGroup.has(String(vcid))) clusterToGroup.set(String(vcid), groupId);
    }
  }

  const personClips = new Map(); // canonical person -> [{audio, otid, key}]
  const seenKeys = new Set();
  const addPersonClip = (personId, audio, otid) => {
    const key = normalizeAudioKey(audio);
    if (!key || seenKeys.has(key)) return;
    seenKeys.add(key);
    if (!personClips.has(personId)) personClips.set(personId, []);
    personClips.get(personId).push({ audio: String(audio), otid: String(otid || ''), key });
  };

  for (const enrollment of registry.enrollments || []) {
    if (enrollment.calibration_quarantine_status === 'quarantined') continue;
    const audio = enrollment.reference_audio_rel || enrollment.reference_audio_path;
    if (!audio) continue;
    const person = registry.people?.[enrollment.person_id] || {};
    const resolution = enrollment.voice_cluster_id
      ? registry.voice_cluster_resolutions?.[enrollment.voice_cluster_id]
      : null;
    const personConfirmed =
      person.identity_confirmation_status === 'confirmed_by_ExampleCo' &&
      person.voiceprint_status === 'enrolled';
    if (!personConfirmed && resolution?.status !== 'confirmed_by_ExampleCo') continue;
    addPersonClip(canonical(String(enrollment.person_id)), audio, enrollment.otid);
  }

  const probeIndex = readJson(
    path.join(dataDir, 'life-archive', 'voiceprints', 'track-probe-index-latest.json'),
    null,
  );
  const ExampleCoClips = new Map(); // entity id -> [{audio, otid, key}]
  for (const row of probeIndex?.probes || []) {
    const audio = row?.probe_audio_path;
    if (!audio) continue;
    const vcid = String(row.voice_cluster_id || '');
    const person = vcid ? clusterPerson.get(vcid) : null;
    if (person) {
      addPersonClip(person, audio, row.otid);
      continue;
    }
    if (!vcid) continue;
    const groupId = clusterToGroup.get(vcid) || null;
    if (groupId && confirmedGroups.has(groupId)) continue; // known human, not an ExampleCo
    const entity = groupId ? `group:${groupId}` : `voice_cluster:${vcid}`;
    const key = normalizeAudioKey(audio);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (!ExampleCoClips.has(entity)) ExampleCoClips.set(entity, []);
    ExampleCoClips.get(entity).push({ audio: String(audio), otid: String(row.otid || ''), key });
  }

  const excludedSameOtid = { genuine: 0, impostor: 0 };

  // Genuine buckets, one per person, deterministic order.
  const genuineBuckets = [];
  for (const [personId, clips] of [...personClips.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (clips.length < 2) continue;
    const sorted = [...clips].sort((a, b) => a.key.localeCompare(b.key));
    const bucket = [];
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        if (sorted[i].otid === sorted[j].otid) {
          excludedSameOtid.genuine += 1;
          continue;
        }
        bucket.push({
          pair_id: pairId('genuine', sorted[i].audio, sorted[j].audio),
          label: 'genuine',
          audio_a: sorted[i].audio,
          audio_b: sorted[j].audio,
          otid_a: sorted[i].otid,
          otid_b: sorted[j].otid,
          person_id: personId,
        });
      }
    }
    if (bucket.length) genuineBuckets.push(bucket);
  }

  // Durable ExampleCo entities: clips spanning 2+ distinct otids.
  const durableEntities = [...ExampleCoClips.entries()]
    .filter(([, clips]) => new Set(clips.map((clip) => clip.otid)).size >= 2)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([entity, clips]) => ({ entity, clips: [...clips].sort((a, b) => a.key.localeCompare(b.key)) }));

  // Impostor buckets, one per entity pair.
  const impostorBuckets = [];
  for (let i = 0; i < durableEntities.length; i += 1) {
    for (let j = i + 1; j < durableEntities.length; j += 1) {
      const A = durableEntities[i];
      const B = durableEntities[j];
      const bucket = [];
      for (const a of A.clips) {
        for (const b of B.clips) {
          if (a.otid === b.otid) {
            excludedSameOtid.impostor += 1;
            continue;
          }
          bucket.push({
            pair_id: pairId('impostor', a.audio, b.audio),
            label: 'impostor',
            audio_a: a.audio,
            audio_b: b.audio,
            otid_a: a.otid,
            otid_b: b.otid,
            cluster_a: A.entity,
            cluster_b: B.entity,
          });
        }
      }
      if (bucket.length) impostorBuckets.push(bucket);
    }
  }

  return {
    genuineBuckets,
    impostorBuckets,
    stats: {
      registry_present: Boolean(Object.keys(registry).length),
      probe_index_present: Boolean(probeIndex),
      probe_index_rows: (probeIndex?.probes || []).length,
      persons_with_pairs: genuineBuckets.length,
      durable_ExampleCo_clusters: durableEntities.length,
      excluded_same_otid: excludedSameOtid,
    },
  };
}

/**
 * Interleave buckets round-robin so a cap does not spend the whole budget on
 * one person or one cluster pair. Deterministic: bucket order and in-bucket
 * order are already sorted by the builder.
 */
function roundRobin(buckets) {
  const out = [];
  for (let i = 0; ; i += 1) {
    let added = false;
    for (const bucket of buckets) {
      if (i < bucket.length) {
        out.push(bucket[i]);
        added = true;
      }
    }
    if (!added) return out;
  }
}

/**
 * Cap total pairs at maxPairs. Genuine pairs are usually the scarce side, so
 * they get at least half the budget when available, and either side backfills
 * the other's shortfall.
 */
function capPairs(genuineBuckets, impostorBuckets, maxPairs) {
  const genuineAll = roundRobin(genuineBuckets);
  const impostorAll = roundRobin(impostorBuckets);
  const genuineTarget = Math.min(
    genuineAll.length,
    Math.max(Math.ceil(maxPairs / 2), maxPairs - impostorAll.length),
  );
  const genuineSelected = genuineAll.slice(0, genuineTarget);
  const impostorSelected = impostorAll.slice(0, Math.max(0, maxPairs - genuineSelected.length));
  return {
    genuineSelected,
    impostorSelected,
    genuineCandidates: genuineAll.length,
    impostorCandidates: impostorAll.length,
  };
}

function buildPairsManifest(dataDir, { maxPairs = DEFAULT_MAX_PAIRS } = {}) {
  const sweepPath = path.join(dataDir, 'life-archive', 'voiceprints', 'calibration-sweep-latest.json');
  const sweepArtifact = readJson(sweepPath, null);
  const sweepPairs = sweepArtifact ? pairsFromCalibrationArtifact(sweepArtifact) : null;

  let source;
  let genuineBuckets;
  let impostorBuckets;
  let builderStats = {};
  if (sweepPairs) {
    source = 'calibration_sweep_artifact';
    genuineBuckets = [sweepPairs.filter((row) => row.label === 'genuine')];
    impostorBuckets = [sweepPairs.filter((row) => row.label === 'impostor')];
  } else {
    source = 'registry_probe_index';
    const built = buildPairsFromRegistry(dataDir);
    genuineBuckets = built.genuineBuckets;
    impostorBuckets = built.impostorBuckets;
    builderStats = built.stats;
  }

  const capped = capPairs(genuineBuckets, impostorBuckets, maxPairs);
  const pairs = [...capped.genuineSelected, ...capped.impostorSelected].map((pair) => ({
    ...pair,
    audio_a: resolveAudioAbs(pair.audio_a, dataDir),
    audio_b: resolveAudioAbs(pair.audio_b, dataDir),
  }));
  const audioMissing = pairs.filter(
    (pair) => !fs.existsSync(pair.audio_a) || !fs.existsSync(pair.audio_b),
  ).length;

  return {
    schema: 'life_archive_voice_model_bakeoff_pairs.v1',
    generated_at: new Date().toISOString(),
    source,
    data_dir: dataDir,
    calibration_sweep_path: sweepPath,
    calibration_sweep_present: Boolean(sweepArtifact),
    max_pairs: maxPairs,
    stats: {
      ...builderStats,
      genuine_candidates: capped.genuineCandidates,
      impostor_candidates: capped.impostorCandidates,
      genuine_selected: capped.genuineSelected.length,
      impostor_selected: capped.impostorSelected.length,
      total_selected: pairs.length,
      audio_missing: audioMissing,
    },
    pairs,
  };
}

function pythonRuntime() {
  return {
    python: process.env.BAKEOFF_PYTHON || process.env.VOICE_ECAPA_PYTHON || VENV_PYTHON,
    script: process.env.BAKEOFF_SCRIPT || path.join(REPO, 'scripts', 'voice-model-bakeoff.py'),
  };
}

/** Run one backend; exit code 4 is the clean backend_unavailable contract. */
function runBackend(name, manifestPath, opts = {}) {
  const runtime = pythonRuntime();
  const python = opts.python || runtime.python;
  const script = opts.script || runtime.script;
  if (!fs.existsSync(python)) {
    return { status: 'backend_unavailable', detail: `python runtime not found: ${python}`, rows: [], parse_errors: 0 };
  }
  const args = [script, manifestPath, '--backend', name];
  if (opts.maxSeconds) args.push('--max-seconds', String(opts.maxSeconds));
  const run = spawnSync(python, args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env },
    timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
  });
  const stdout = String(run.stdout || '');
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
  if (run.status === 4) {
    let detail = '';
    for (const line of [...lines].reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.error === 'backend_unavailable') {
          detail = String(parsed.detail || '');
          break;
        }
      } catch {
        // keep scanning
      }
    }
    return {
      status: 'backend_unavailable',
      detail: detail || String(run.stderr || stdout).slice(0, 2000),
      rows: [],
      parse_errors: 0,
    };
  }
  if (run.status !== 0) {
    const detail = run.error?.message || run.stderr || stdout || `exit ${run.status}`;
    return { status: 'error', detail: String(detail).slice(0, 2000), rows: [], parse_errors: 0 };
  }
  const rows = [];
  let parseErrors = 0;
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      parseErrors += 1;
    }
  }
  return { status: 'ok', detail: '', rows, parse_errors: parseErrors };
}

/**
 * Per-backend metrics from the scored JSONL rows: EER plus FRR at the FA 1%
 * and 0.1% operating points (accept rule score >= threshold throughout,
 * reusing the calibration sweep's audited math). Error rows are counted, never
 * silently dropped.
 */
function scoreMetrics(rows) {
  const genuine = [];
  const impostor = [];
  let errors = 0;
  let unlabeled = 0;
  for (const row of rows || []) {
    if (!row || typeof row !== 'object' || row.error || !Number.isFinite(Number(row.score))) {
      errors += 1;
      continue;
    }
    if (row.label === 'genuine') genuine.push(Number(row.score));
    else if (row.label === 'impostor') impostor.push(Number(row.score));
    else unlabeled += 1;
  }
  const eer = computeEer(genuine, impostor);
  const fa1 = thresholdForFa(genuine, impostor, OPERATING_FA_RATES[0]);
  const fa01 = thresholdForFa(genuine, impostor, OPERATING_FA_RATES[1]);
  return {
    pairs_used: genuine.length + impostor.length,
    genuine_count: genuine.length,
    impostor_count: impostor.length,
    pair_errors: errors,
    pairs_unlabeled: unlabeled,
    eer: eer ? eer.eer : null,
    eer_threshold: eer ? eer.threshold : null,
    frr_at_fa1: fa1 ? fa1.frr : null,
    frr_at_fa1_threshold: fa1 ? fa1.threshold : null,
    fa1_resolution_limited: fa1 ? fa1.fa_resolution_limited : null,
    frr_at_fa01: fa01 ? fa01.frr : null,
    frr_at_fa01_threshold: fa01 ? fa01.threshold : null,
    fa01_resolution_limited: fa01 ? fa01.fa_resolution_limited : null,
  };
}

/**
 * The adoption verdict. Baseline is always ecapa: without the incumbent
 * measured on the SAME pairs there is no adoption decision. Winner is the
 * lowest EER among healthy backends (ties go to the incumbent). Adoption
 * requires relative EER gain >= 25% AND a verified license.
 */
function decideVerdict(backends) {
  const verdict = {
    rule: ADOPT_RULE,
    min_relative_eer_gain: ADOPT_MIN_RELATIVE_EER_GAIN,
    baseline: 'ecapa',
    winner: null,
    beats_ecapa_relative: null,
    adopt_recommended: false,
    reason: '',
  };
  const base = backends?.ecapa;
  if (!base || base.status !== 'ok' || !Number.isFinite(base.eer)) {
    verdict.reason =
      'ecapa_baseline_unavailable: the incumbent was not measured on these pairs, so no adoption decision is possible';
    return verdict;
  }
  let winnerName = 'ecapa';
  let winnerEer = base.eer;
  for (const [name, backend] of Object.entries(backends).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (name === 'ecapa' || !backend || backend.status !== 'ok' || !Number.isFinite(backend.eer)) continue;
    if (backend.eer < winnerEer) {
      winnerName = name;
      winnerEer = backend.eer;
    }
  }
  verdict.winner = winnerName;
  if (winnerName === 'ecapa') {
    verdict.beats_ecapa_relative = 0;
    verdict.reason = 'ecapa_remains_best: no candidate produced a lower EER on local pairs';
    return verdict;
  }
  // winnerEer < base.eer here, so base.eer > 0 and the ratio is well-defined.
  const relative = (base.eer - winnerEer) / base.eer;
  verdict.beats_ecapa_relative = round6(relative);
  if (relative < ADOPT_MIN_RELATIVE_EER_GAIN) {
    verdict.reason = `relative_eer_gain_below_25pct: ${winnerName} improves EER by ${round6(relative * 100)}% relative, under the 25% adoption bar`;
    return verdict;
  }
  if (backends[winnerName]?.license_verified !== true) {
    verdict.reason = `blocked_on_license_verification: ${winnerName} clears the EER bar but its license is not verified; adoption is blocked until it is`;
    return verdict;
  }
  verdict.adopt_recommended = true;
  verdict.reason = `${winnerName} beats ecapa by ${round6(relative * 100)}% relative EER on local pairs (>= 25%) and its license is verified; adoption still goes through the cross-generation ledger`;
  return verdict;
}

function backendNotes(info, metrics) {
  const notes = [`license: ${info.license}${info.license_verified ? ' (verified)' : ' (UNVERIFIED, blocks adoption)'}. ${info.license_note}`];
  if (metrics) {
    if (metrics.fa1_resolution_limited) {
      notes.push('FA 1% operating point is resolution-limited: too few impostor pairs to certify the rate.');
    }
    if (metrics.fa01_resolution_limited) {
      notes.push('FA 0.1% operating point is resolution-limited: too few impostor pairs to certify the rate.');
    }
    if (metrics.pair_errors) notes.push(`${metrics.pair_errors} pair(s) failed to score and were excluded.`);
    if (metrics.pairs_unlabeled) notes.push(`${metrics.pairs_unlabeled} row(s) ExampleCod an ExampleCo label and were ignored.`);
  }
  return notes;
}

function runBakeoff(opts = {}) {
  const dataDir = resolveDataDir(opts.dataDir);
  const outPath = path.resolve(
    opts.out || path.join(dataDir, 'life-archive', 'voiceprints', 'model-bakeoff-latest.json'),
  );
  const manifestPath = path.resolve(
    opts.manifestOut || path.join(dataDir, 'life-archive', 'voiceprints', 'model-bakeoff-pairs-latest.json'),
  );
  const maxPairs = Number(opts.maxPairs) > 0 ? Number(opts.maxPairs) : DEFAULT_MAX_PAIRS;
  const backendNames = opts.backends?.length ? opts.backends : Object.keys(BACKEND_INFO);
  for (const name of backendNames) {
    if (!BACKEND_INFO[name]) throw new Error(`ExampleCo backend "${name}" (expected: ${Object.keys(BACKEND_INFO).join(', ')})`);
  }
  const write = opts.write !== false;

  const manifest = buildPairsManifest(dataDir, { maxPairs });
  if (write) saveJson(manifestPath, manifest);

  const backends = {};
  for (const name of backendNames) {
    const info = BACKEND_INFO[name];
    const base = {
      model_id: info.model_id,
      source: info.source,
      license: info.license,
      license_verified: info.license_verified,
    };
    if (opts.manifestOnly) {
      backends[name] = { status: 'skipped_manifest_only', ...base, notes: backendNotes(info, null) };
      continue;
    }
    if (!manifest.pairs.length) {
      backends[name] = {
        status: 'no_pairs',
        ...base,
        notes: [...backendNotes(info, null), 'no genuine/impostor pairs could be built from the corpus artifacts'],
      };
      continue;
    }
    const result = runBackend(name, manifestPath, opts);
    if (result.status !== 'ok') {
      backends[name] = {
        status: result.status,
        ...base,
        detail: result.detail,
        notes: backendNotes(info, null),
      };
      continue;
    }
    const metrics = scoreMetrics(result.rows);
    backends[name] = {
      status: metrics.eer === null ? 'error' : 'ok',
      ...base,
      ...metrics,
      parse_errors: result.parse_errors,
      notes: backendNotes(info, metrics),
    };
    if (metrics.eer === null) {
      backends[name].detail = `no scorable pairs: ${metrics.pair_errors} error row(s), genuine=${metrics.genuine_count}, impostor=${metrics.impostor_count}`;
    }
  }

  const artifact = {
    schema: 'life_archive_voice_model_bakeoff.v1',
    generated_at: new Date().toISOString(),
    data_dir: dataDir,
    out_path: outPath,
    config: {
      max_pairs: maxPairs,
      backends_requested: backendNames,
      adopt_rule: ADOPT_RULE,
      adopt_min_relative_eer_gain: ADOPT_MIN_RELATIVE_EER_GAIN,
      operating_fa_rates: OPERATING_FA_RATES,
      adoption_path:
        'a winning candidate is adopted only through the cross-generation ledger (generation stamping, dual-write, re-embed queue) per dev-plans/voiceprint-cross-generation-identity-2026-07-07.html',
    },
    pairs_manifest: {
      path: manifestPath,
      source: manifest.source,
      genuine: manifest.stats.genuine_selected,
      impostor: manifest.stats.impostor_selected,
      total: manifest.stats.total_selected,
      audio_missing: manifest.stats.audio_missing,
      stats: manifest.stats,
    },
    backends,
    verdict: decideVerdict(backends),
  };
  if (write) saveJson(outPath, artifact);
  return artifact;
}

function main() {
  const artifact = runBakeoff({
    dataDir: argValue('--data-dir', ''),
    out: argValue('--out', ''),
    manifestOut: argValue('--manifest-out', ''),
    maxPairs: Number(argValue('--max-pairs', String(DEFAULT_MAX_PAIRS))) || DEFAULT_MAX_PAIRS,
    backends: argValue('--backends', '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    maxSeconds: Number(argValue('--max-seconds', '0')) || 0,
    manifestOnly: hasArg('--manifest-only'),
    write: !hasArg('--dry-run'),
  });
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}

module.exports = {
  DEFAULT_MAX_PAIRS,
  ADOPT_MIN_RELATIVE_EER_GAIN,
  ADOPT_RULE,
  OPERATING_FA_RATES,
  BACKEND_INFO,
  resolveDataDir,
  resolveAudioAbs,
  pairId,
  pairsFromCalibrationArtifact,
  buildPairsFromRegistry,
  roundRobin,
  capPairs,
  buildPairsManifest,
  pythonRuntime,
  runBackend,
  scoreMetrics,
  decideVerdict,
  runBakeoff,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
}
