#!/usr/bin/env node
/**
 * Resolve Otter speaker tracks with WavLM speaker embeddings.
 *
 * This deliberately separates:
 * - ExampleCo-confirmed exact cluster truth.
 * - high-margin WavLM voice matches.
 * - durable acoustic unknown groups.
 * - text/context hypotheses, which stay provisional.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { runSpeakerIdentityChangeHook } = require('./lib/run-speaker-identity-change-hook');
const { createEnrichedStore } = require('./lib/otter-enriched-store');
const { bestPersonMatch, buildCanonicalPersonMap } = require('./lib/voice-reference-people');
const { referenceEligibility } = require('./lib/voice-reference-provenance');
const { applyCanonicalSpeakerIdentity } = require('./lib/canonical-speaker-identity');
const {
  buildNormalizer,
  referenceMatchDecision,
  acceptedMatchConfidence,
} = require('./lib/voice-score-normalization');

const SPEAKER_BACKEND = String(process.env.VOICE_SPEAKER_BACKEND || 'ecapa').toLowerCase();
// VOICE_SPEAKER_BACKEND_MODULE is a test seam: it lets the regression suite
// inject a deterministic stub backend so run-death behavior (partial writes,
// dead letters, preflight) is testable without speechbrain installed.
const embeddingBackend = process.env.VOICE_SPEAKER_BACKEND_MODULE
  ? require(path.resolve(process.env.VOICE_SPEAKER_BACKEND_MODULE))
  : SPEAKER_BACKEND === 'wavlm'
    ? require('./voice-embedding-wavlm.js')
    : require('./voice-embedding-ecapa.js');
const { embedOne, embedMany, embedManyAsync } = embeddingBackend;

const REPO = path.resolve(__dirname, '..');
// Section 4.5 contract: every reader/writer resolves its data root the same
// way (SECONDBRAIN_DATA_DIR || REPO/data). On EC2 that is /opt/secondbrain/data
// and in the Fargate container REPO/data IS the EFS mount, so production
// behavior is unchanged; tests get an isolated data root.
const DATA_ROOT = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data'));
const ENRICHED_DIR = path.join(DATA_ROOT, 'otter', 'enriched');
const VP_DIR = path.join(DATA_ROOT, 'life-archive', 'voiceprints');
const PEOPLE_DIR = path.join(DATA_ROOT, 'life-archive', 'people');
const IDENTITY_REGISTRY = path.join(DATA_ROOT, 'life-archive', 'voice-identity-registry.json');
const REVIEW_QUEUE = path.join(VP_DIR, 'voice-review-queue.json');
const ROSTER = path.join(VP_DIR, 'voice-discovery-roster-latest.json');
const TRACK_PROBE_INDEX =
  process.env.OTTER_TRACK_PROBE_INDEX_PATH || path.join(VP_DIR, 'track-probe-index-latest.json');
const STATUS_PATH =
  process.env.OTTER_SPEAKER_RESOLVER_STATUS_PATH ||
  path.join(VP_DIR, `${SPEAKER_BACKEND}-speaker-resolver-latest.json`);
const LEGACY_STATUS_PATH =
  process.env.OTTER_SPEAKER_RESOLVER_TRANSIENT === '1'
    ? ''
    : path.join(VP_DIR, 'wavlm-speaker-resolver-latest.json');
const EMBED_CACHE = path.join(VP_DIR, `${SPEAKER_BACKEND}-embeddings`);
const TRACK_GROUPS_PATH =
  process.env.OTTER_SPEAKER_GROUPS_PATH ||
  path.join(VP_DIR, `${SPEAKER_BACKEND}-speaker-groups-latest.json`);
const LEGACY_TRACK_GROUPS_PATH =
  process.env.OTTER_SPEAKER_RESOLVER_TRANSIENT === '1'
    ? ''
    : path.join(VP_DIR, 'wavlm-speaker-groups-latest.json');
const UNKNOWN_DOSSIER_PATH =
  process.env.OTTER_UNKNOWN_DOSSIER_PATH ||
  path.join(VP_DIR, 'unknown-speaker-dossiers-latest.json');
const PROGRESS_PATH =
  process.env.OTTER_SPEAKER_RESOLVER_PROGRESS_PATH ||
  path.join(VP_DIR, `${SPEAKER_BACKEND}-speaker-resolver-progress.json`);
// Sandbox mode (Phase A4, Codex amendment 2): automatic reference-voiceprint
// matches are surfaced as review candidates, never written as durable identity.
// ExampleCo-confirmed cluster truth and anonymous unknown clustering still write.
const SANDBOX = process.env.SPEAKER_RESOLVER_SANDBOX === '1' || process.argv.includes('--sandbox');
const SANDBOX_CANDIDATES_PATH =
  process.env.OTTER_SPEAKER_SANDBOX_CANDIDATES_PATH ||
  path.join(VP_DIR, 'sandbox-candidate-assignments-latest.json');
// Dead letters (Phase A1, Codex amendment 18): every track that failed gets a
// durable record with a taxonomy class so a failing run can never read as
// silently empty again.
const DEAD_LETTERS_PATH =
  process.env.OTTER_SPEAKER_RESOLVER_DEAD_LETTERS_PATH ||
  path.join(VP_DIR, 'resolver-dead-letters-latest.json');
// Phase B2 (Codex amendments 7-8): calibrated scoring artifacts. When both are
// present and healthy, the resolver ADDS a precision-audited calibrated accept
// path on top of the unchanged raw 0.56/0.06 gates. Absent artifacts = pure
// legacy behavior. SPEAKER_SCORE_NORMALIZATION=0 is the kill switch.
const SCORE_CALIBRATION_PATH =
  process.env.OTTER_SPEAKER_SCORE_CALIBRATION_PATH ||
  path.join(VP_DIR, 'score-calibration-latest.json');
const ASNORM_COHORT_PATH =
  process.env.OTTER_SPEAKER_ASNORM_COHORT_PATH || path.join(VP_DIR, 'asnorm-cohort-latest.json');

const MATCH_SCORE = Number(
  process.env.SPEAKER_MATCH_SCORE ||
    process.env.ECAPA_MATCH_SCORE ||
    (SPEAKER_BACKEND === 'ecapa' ? '0.56' : process.env.WAVLM_MATCH_SCORE || '0.968'),
);
const MATCH_MARGIN = Number(
  process.env.SPEAKER_MATCH_MARGIN ||
    process.env.ECAPA_MATCH_MARGIN ||
    (SPEAKER_BACKEND === 'ecapa' ? '0.06' : process.env.WAVLM_MATCH_MARGIN || '0.015'),
);
const UNKNOWN_CLUSTER_SCORE = Number(
  process.env.SPEAKER_UNKNOWN_CLUSTER_SCORE ||
    process.env.ECAPA_UNKNOWN_CLUSTER_SCORE ||
    (SPEAKER_BACKEND === 'ecapa' ? '0.62' : process.env.WAVLM_UNKNOWN_CLUSTER_SCORE || '0.965'),
);
const UNKNOWN_CLUSTER_MIN_PAIR_SCORE = Number(
  process.env.SPEAKER_UNKNOWN_CLUSTER_MIN_PAIR_SCORE ||
    process.env.ECAPA_UNKNOWN_CLUSTER_MIN_PAIR_SCORE ||
    (SPEAKER_BACKEND === 'ecapa'
      ? '0.68'
      : process.env.WAVLM_UNKNOWN_CLUSTER_MIN_PAIR_SCORE || '0.975'),
);
const UNKNOWN_CLUSTER_MIN_CORE_MATCHES = Number(
  process.env.SPEAKER_UNKNOWN_CLUSTER_MIN_CORE_MATCHES ||
    process.env.ECAPA_UNKNOWN_CLUSTER_MIN_CORE_MATCHES ||
    '3',
);
const UNKNOWN_CLUSTER_SAME_CALL_DIFFERENT_LABEL_SCORE = Number(
  process.env.SPEAKER_UNKNOWN_CLUSTER_SAME_CALL_DIFFERENT_LABEL_SCORE ||
    process.env.ECAPA_UNKNOWN_CLUSTER_SAME_CALL_DIFFERENT_LABEL_SCORE ||
    (SPEAKER_BACKEND === 'ecapa'
      ? '0.82'
      : process.env.WAVLM_UNKNOWN_CLUSTER_SAME_CALL_DIFFERENT_LABEL_SCORE || '0.985'),
);
const EMBED_MAX_SECONDS =
  Number(process.env.VOICE_EMBEDDING_MAX_SECONDS || (SPEAKER_BACKEND === 'ecapa' ? '30' : '12')) ||
  (SPEAKER_BACKEND === 'ecapa' ? 30 : 12);
// Phase B1 (Codex amendment 9): a named-identity decision requires this much
// clean net speech across the track's windows; short_weak windows count half.
// Tracks below the floor keep their match as evidence but stay unknown.
const MIN_NET_SPEECH_SECONDS = Number(process.env.SPEAKER_MIN_NET_SPEECH_SECONDS || '10') || 10;
const ENABLE_KNOWN_MATCHES =
  process.env.SPEAKER_ENABLE_KNOWN_MATCHES === '1' ||
  process.env.WAVLM_ENABLE_KNOWN_MATCHES === '1' ||
  (SPEAKER_BACKEND === 'ecapa' && process.env.SPEAKER_ENABLE_KNOWN_MATCHES !== '0');
const ENABLE_UNKNOWN_GROUPING =
  process.env.SPEAKER_ENABLE_UNKNOWN_GROUPING === '1' ||
  process.env.WAVLM_ENABLE_UNKNOWN_GROUPING === '1' ||
  (SPEAKER_BACKEND === 'ecapa' && process.env.SPEAKER_ENABLE_UNKNOWN_GROUPING !== '0');
const SKIP_EMBEDDINGS =
  process.env.SPEAKER_SKIP_EMBEDDINGS === '1' ||
  process.env.WAVLM_SKIP_EMBEDDINGS === '1' ||
  (!ENABLE_KNOWN_MATCHES && !ENABLE_UNKNOWN_GROUPING);

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
  const text = `${JSON.stringify(value, null, 2)}\n`;
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.writeFileSync(file, text, 'utf8');
      return;
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * (attempt + 1));
    }
  }
  throw lastError;
}

function persistTerminalBelowIdentityGrade(row, embeddingQuality) {
  const index = readJson(TRACK_PROBE_INDEX, null);
  if (!index || !Array.isArray(index.probes)) {
    throw new Error('terminal below-grade disposition cannot read the canonical probe index');
  }
  const exactRevision = String(row.source_revision || row.source_revision_hash || '');
  const probe = index.probes.find(
    (candidate) =>
      String(candidate.otid || '') === String(row.otid || '') &&
      String(candidate.speaker_model_label || '') === String(row.speaker_model_label || '') &&
      (!exactRevision ||
        String(candidate.source_revision || candidate.source_revision_hash || '') ===
          exactRevision),
  );
  if (!probe) {
    throw new Error('terminal below-grade disposition lacks an exact canonical probe row');
  }
  const reason =
    'All available exact-call probe windows failed the speaker-embedding quality gate.';
  probe.identity_grade = false;
  probe.evidence_tier = 'archive_weak';
  probe.acoustic_assignment_status = 'unresolved_below_identity_grade';
  probe.uncertainty_reason = reason;
  probe.probe_quality = {
    ...(probe.probe_quality || {}),
    identity_grade: false,
    terminal_embedding_quality_disposition: true,
    terminal_embedding_quality_reason: reason,
    embedding_quality: embeddingQuality || {},
  };
  index.generated_at = new Date().toISOString();
  saveJson(TRACK_PROBE_INDEX, index);
  return {
    otid: String(row.otid || ''),
    source_revision: exactRevision,
    speaker_model_label: String(row.speaker_model_label || ''),
    voice_cluster_id: String(row.voice_cluster_id || ''),
    probe_audio_path: String(row.probe_audio_path || ''),
    identity_grade: false,
    evidence_tier: 'archive_weak',
    acoustic_assignment_status: 'unresolved_below_identity_grade',
    uncertainty_reason: reason,
    embedding_quality: embeddingQuality || {},
  };
}

function repoRel(file) {
  if (!file) return '';
  const abs = path.resolve(path.isAbsolute(file) ? file : path.join(REPO, file));
  const dataRel = path.relative(DATA_ROOT, abs);
  if (dataRel && !dataRel.startsWith('..') && !path.isAbsolute(dataRel)) {
    return `data/${dataRel.replace(/\\/g, '/')}`;
  }
  return path.relative(REPO, abs).replace(/\\/g, '/');
}

const { resolveRepoAudioPath } = require('./lib/repo-audio-path');

function repoAbs(file) {
  if (!file) return '';
  // An absolute path that actually exists is authoritative (covers a data root
  // outside the repo, e.g. SECONDBRAIN_DATA_DIR in tests). Only paths that do
  // NOT resolve as-is go through legacy-Windows normalization below.
  const asIs = String(file);
  if (path.isAbsolute(asIs) && fs.existsSync(asIs)) return asIs;
  // Normalize foreign-absolute (legacy Windows) reference paths to this repo so
  // enrollment audio resolves on the Linux container (reference_people:0 fix).
  return resolveRepoAudioPath(file, REPO);
}

// Failure taxonomy (Phase A1): classify an error message (plus the phase that
// produced it) into a stable class for dead letters and health reporting.
function classifyError(message, source = '') {
  const text = String(message || '');
  if (/embedding_unusable/i.test(text)) return 'embedding_unusable';
  if (/missing_audio|audio not found/i.test(text)) return 'missing_audio';
  if (/runtime not found|No module named|ModuleNotFoundError|backend unavailable/i.test(text))
    return 'backend_unavailable';
  if (/timed out/i.test(text)) return 'backend_timeout';
  if (/EACCES|EPERM|ENOSPC|EROFS|EMFILE/i.test(text)) return 'io_error';
  if (/missing_batch_result|missing_embedding_vector|embedding failed/i.test(text))
    return 'backend_error';
  return source === 'embedding' ? 'backend_error' : 'exception';
}

function sha16(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
}

function cachePathFor(audioPath) {
  const abs = repoAbs(audioPath);
  let statKey = '';
  try {
    const st = fs.statSync(abs);
    statKey = `${st.size}:${Math.round(st.mtimeMs)}:${SPEAKER_BACKEND}-max-${EMBED_MAX_SECONDS}`;
  } catch {
    statKey = 'missing';
  }
  return path.join(EMBED_CACHE, `${sha16(`${repoRel(abs)}:${statKey}`)}.json`);
}

async function embeddingFor(audioPath) {
  const abs = repoAbs(audioPath);
  if (!fs.existsSync(abs)) return { error: 'missing_audio', audio_path: repoRel(abs) };
  const cache = cachePathFor(abs);
  const cached = readJson(cache, null);
  if (cached?.embedding?.vector?.length) return cached;
  const row = {
    schema: 'life_archive_wavlm_embedding_cache.v1',
    generated_at: new Date().toISOString(),
    audio_path: repoRel(abs),
    embedding: await embedOne(abs, { maxSeconds: EMBED_MAX_SECONDS }),
  };
  saveJson(cache, row);
  return row;
}

// How many embedding workers to run at once. The ecapa backend spawns a torch
// process per worker, each holding 300 to 700 MB, and the whole tree runs inside
// the systemd scope whose MemoryMax is 2,048 MB on the production host. The old
// flat default of 4 predates that cap: on the 2-core EC2 box it drives load
// average past 25 and puts four torch processes inside a 2 GB cgroup, so the
// second ceiling would bite as soon as the first one (the enriched-corpus heap)
// was fixed. Scale with the cores actually present, keep the env override.
function embedConcurrency() {
  const override = Number(process.env.SPEAKER_EMBED_CONCURRENCY);
  if (Number.isFinite(override) && override >= 1) return Math.floor(override);
  if (SPEAKER_BACKEND !== 'ecapa') return 1;
  const cpus = Number(os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1;
  return Math.max(1, Math.min(4, cpus - 1));
}

async function preloadEmbeddings(audioPaths) {
  if (SKIP_EMBEDDINGS || typeof embedMany !== 'function')
    return { attempted: 0, written: 0, errors: [], concurrency: 0, chunk_size: 0 };
  const unique = [...new Set(audioPaths.map(repoAbs).filter((abs) => fs.existsSync(abs)))];
  const missing = unique.filter(
    (abs) => !readJson(cachePathFor(abs), null)?.embedding?.vector?.length,
  );
  const errors = [];
  let written = 0;
  const chunkSize =
    Number(process.env.SPEAKER_EMBED_BATCH_SIZE || (SPEAKER_BACKEND === 'ecapa' ? '48' : '8')) ||
    48;
  const embedBatch = async (chunk) => {
    if (typeof embedManyAsync === 'function')
      return embedManyAsync(chunk, { maxSeconds: EMBED_MAX_SECONDS });
    return embedMany(chunk, { maxSeconds: EMBED_MAX_SECONDS });
  };
  const robustEmbedMany = async (chunk) => {
    try {
      return await embedBatch(chunk);
    } catch (error) {
      if (chunk.length <= 1) {
        return [{ path: chunk[0], error: error.message || String(error) }];
      }
      errors.push({
        phase: 'embedding_preload_split',
        audio_path: chunk.map(repoRel).slice(0, 5).join(';'),
        chunk_size: chunk.length,
        error: error.message || String(error),
      });
      const mid = Math.ceil(chunk.length / 2);
      return [
        ...(await robustEmbedMany(chunk.slice(0, mid))),
        ...(await robustEmbedMany(chunk.slice(mid))),
      ];
    }
  };
  const chunks = [];
  for (let i = 0; i < missing.length; i += chunkSize)
    chunks.push({ index: i, chunk: missing.slice(i, i + chunkSize) });
  let nextChunk = 0;
  const concurrency = embedConcurrency();
  async function processChunk({ index: i, chunk }) {
    saveJson(PROGRESS_PATH, {
      schema: 'life_archive_otter_speaker_resolver_progress.v2',
      backend: SPEAKER_BACKEND,
      phase: 'embedding_preload',
      updated_at: new Date().toISOString(),
      attempted: missing.length,
      processed: i,
      written,
      errors_so_far: errors.length,
      latest_chunk: chunk.slice(0, 5).map(repoRel),
    });
    try {
      const rows = await robustEmbedMany(chunk);
      for (const row of rows) {
        if (row.error || !row.embedding?.vector?.length) {
          errors.push({
            audio_path: repoRel(row.path || ''),
            error: row.error || 'missing_embedding_vector',
          });
          continue;
        }
        saveJson(cachePathFor(row.path), {
          schema: `life_archive_${SPEAKER_BACKEND}_embedding_cache.v1`,
          generated_at: new Date().toISOString(),
          audio_path: repoRel(row.path),
          embedding: row.embedding,
        });
        written += 1;
      }
    } catch (error) {
      errors.push({ audio_path: chunk.map(repoRel).join(';'), error: error.message });
    }
    saveJson(PROGRESS_PATH, {
      schema: 'life_archive_otter_speaker_resolver_progress.v2',
      backend: SPEAKER_BACKEND,
      phase: 'embedding_preload',
      updated_at: new Date().toISOString(),
      attempted: missing.length,
      processed: Math.min(i + chunk.length, missing.length),
      written,
      errors_so_far: errors.length,
      latest_chunk: chunk.slice(0, 5).map(repoRel),
    });
  }
  async function worker() {
    while (true) {
      const index = nextChunk;
      nextChunk += 1;
      if (index >= chunks.length) return;
      await processChunk(chunks[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()));
  return { attempted: missing.length, written, errors, concurrency, chunk_size: chunkSize };
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

// Duration/quality-weighted centroid over a track's window embeddings
// (Phase B1): weight = min(duration, EMBED_MAX_SECONDS), halved for
// short_weak windows, then L2-renormalized.
function weightedMeanVector(parts) {
  const rows = (parts || []).filter((p) => Array.isArray(p.vector) && p.vector.length);
  if (!rows.length) return [];
  const n = rows[0].vector.length;
  const out = Array(n).fill(0);
  let total = 0;
  for (const part of rows) {
    const dur = Math.min(
      Number(part.quality?.duration_seconds || 0) || EMBED_MAX_SECONDS,
      EMBED_MAX_SECONDS,
    );
    const weight = Math.max(0.1, dur) * (part.tier === 'short_weak' ? 0.5 : 1);
    total += weight;
    for (let i = 0; i < n; i += 1) out[i] += (part.vector[i] || 0) * weight;
  }
  const mean = out.map((v) => v / (total || 1));
  const norm = Math.sqrt(mean.reduce((sum, v) => sum + v * v, 0));
  return norm ? mean.map((v) => v / norm) : mean;
}

function netSpeechSecondsOf(parts) {
  return Number(
    (parts || [])
      .reduce((sum, part) => {
        const dur = Math.min(Number(part.quality?.duration_seconds || 0), EMBED_MAX_SECONDS);
        return sum + dur * (part.tier === 'short_weak' ? 0.5 : 1);
      }, 0)
      .toFixed(2),
  );
}

function personName(identity, personId) {
  return (
    identity.people?.[personId]?.display_name ||
    (identity.enrollments || []).find((row) => row.person_id === personId)?.display_name ||
    personId
  );
}

// person_id -> contact_file fallback for ids with no registry people entry
// (e.g. steve/PRIVATE_NAME), maintained by the confirmation-apply flow.
const CONTACT_ALIASES_PATH = path.join(DATA_ROOT, 'agent', 'voiceprint-contact-aliases.json');

let canonicalPersonMapCache = null;
function canonicalPersonId(identity, personId) {
  if (!personId) return personId;
  if (!canonicalPersonMapCache) {
    canonicalPersonMapCache = buildCanonicalPersonMap(identity, readJson(CONTACT_ALIASES_PATH, {}));
  }
  return canonicalPersonMapCache.get(personId) || personId;
}

function normalizedReferenceClip(audioPath) {
  return String(audioPath || '')
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/^.*data\/otter\/audio\//, '');
}

async function loadReferenceEmbeddings(identity) {
  const byPerson = new Map();
  const rows = [];
  const seenPersonClips = new Set();
  if (!ENABLE_KNOWN_MATCHES) return { references: rows, people: [] };
  await preloadEmbeddings(
    (identity.enrollments || [])
      .filter(
        (enrollment) =>
          referenceEligibility(identity, enrollment, {
            dataDir: DATA_ROOT,
          }).acoustic_matchable,
      )
      .map((enrollment) => enrollment.reference_audio_rel || enrollment.reference_audio_path)
      .filter(Boolean),
  );
  for (const enrollment of identity.enrollments || []) {
    const provenance = referenceEligibility(identity, enrollment, {
      dataDir: DATA_ROOT,
    });
    if (!provenance.eligible || !provenance.acoustic_matchable) continue;
    const clusterId = enrollment.voice_cluster_id || null;
    const resolution = clusterId ? identity.voice_cluster_resolutions?.[clusterId] : null;
    const person = identity.people?.[enrollment.person_id] || {};
    const ownerAllowed =
      enrollment.person_id === 'ExampleCo' &&
      person.identity_confirmation_status === 'confirmed_by_ExampleCo' &&
      person.voiceprint_status === 'enrolled';
    const personConfirmed =
      person.identity_confirmation_status === 'confirmed_by_ExampleCo' &&
      person.voiceprint_status === 'enrolled';
    if (!ownerAllowed && !personConfirmed && resolution?.status !== 'confirmed_by_ExampleCo') continue;
    const audio = enrollment.reference_audio_rel || enrollment.reference_audio_path;
    if (!audio) continue;
    const cached = await embeddingFor(audio);
    if (!cached.embedding?.vector?.length || cached.embedding?.quality?.usable === false) continue;
    // Aliases of the same human (same contact_file) collapse into ONE reference
    // person; otherwise each alias becomes its own candidate with an identical
    // centroid and margin computes to ~0 forever (the alias margin-0 bug).
    const canonicalId = canonicalPersonId(identity, enrollment.person_id);
    // One vote per clip per person: the same reference clip enrolled under two
    // alias ids must not double-weight the collapsed centroid.
    const clipKey = `${canonicalId}|${normalizedReferenceClip(audio)}`;
    if (seenPersonClips.has(clipKey)) continue;
    seenPersonClips.add(clipKey);
    const row = {
      person_id: canonicalId,
      display_name: personName(identity, canonicalId),
      enrollment_id: enrollment.enrollment_id,
      voice_cluster_id: clusterId,
      audio_path: cached.audio_path,
      vector: cached.embedding.vector,
      quality: cached.embedding.quality,
      reference_authority: ownerAllowed
        ? 'owner_confirmed_reference'
        : resolution?.status === 'confirmed_by_ExampleCo'
          ? 'ExampleCo_confirmed_voice_cluster_resolution'
          : 'ExampleCo_confirmed_person_reference',
      reference_provenance: {
        enrollment_id: enrollment.enrollment_id,
        eligibility_basis: provenance.eligibility_basis,
        acoustic_capability: provenance.acoustic_capability,
        evidence_hash: provenance.evidence_hash,
        enrollment_record_sha256: provenance.enrollment_record_sha256,
      },
    };
    rows.push(row);
    if (!byPerson.has(row.person_id)) byPerson.set(row.person_id, []);
    byPerson.get(row.person_id).push(row);
  }
  const people = [...byPerson.entries()].map(([personId, refs]) => ({
    person_id: personId,
    display_name: personName(identity, personId),
    reference_count: refs.length,
    centroid: meanVector(refs.map((row) => row.vector)),
    references: refs.map((row) => ({
      enrollment_id: row.enrollment_id,
      voice_cluster_id: row.voice_cluster_id,
      audio_path: row.audio_path,
      quality: row.quality,
    })),
    reference_provenance: refs.map((row) => row.reference_provenance),
  }));
  return { references: rows, people };
}

function queueRows() {
  const q = readJson(REVIEW_QUEUE, {});
  const rows = Array.isArray(q.items) ? q.items : [];
  return rows.map((row) => ({
    source: 'voice-review-queue',
    otid: row.otid,
    title: row.title,
    enriched_path: row.enriched_path,
    speaker_model_label: String(row.speaker_model_label || ''),
    voice_cluster_id:
      row.voice_cluster_id || row.canonical_speaker_id || row.unknown_speaker_id || '',
    unknown_speaker_id: row.unknown_speaker_id || row.voice_cluster_id || '',
    source_voice_cluster_id: row.source_voice_cluster_id || '',
    source_revision: row.source_revision || row.source_revision_hash || '',
    probe_audio_path: row.probe_audio_path || '',
    identity_grade: row.identity_grade !== false,
    evidence_tier: row.evidence_tier || row.probe_quality?.tier || 'legacy_unspecified',
    sample_text: Array.isArray(row.sample_transcript)
      ? row.sample_transcript.join(' ')
      : String(row.sample_transcript || ''),
    context_candidates: row.candidates || [],
  }));
}

function trackProbeRows() {
  const index = readJson(TRACK_PROBE_INDEX, {});
  return (index.probes || []).map((row) => ({
    source: 'track-probe-index',
    otid: row.otid,
    title: row.title,
    enriched_path: row.enriched_path,
    speaker_model_label: String(row.speaker_model_label || ''),
    voice_cluster_id: row.voice_cluster_id || row.unknown_speaker_id || '',
    unknown_speaker_id: row.unknown_speaker_id || row.voice_cluster_id || '',
    source_voice_cluster_id: row.source_voice_cluster_id || '',
    source_revision: row.source_revision || row.source_revision_hash || '',
    probe_audio_path: row.probe_audio_path || '',
    sample_text: row.sample_transcript || '',
    context_candidates: [],
    segment_count: row.segment_count || 0,
    word_count: row.word_count || 0,
    probe_quality: row.probe_quality || {},
    identity_grade: row.identity_grade !== false,
    evidence_tier: row.evidence_tier || row.probe_quality?.tier || 'identity_grade',
    extra_windows: Array.isArray(row.extra_windows) ? row.extra_windows : [],
  }));
}

function candidateRows() {
  // In transient (per-task Fargate) mode, process ONLY this run's probe index;
  // do NOT pull in the shared review queue (all otids). This scopes a per-task
  // resolver to its own transcript so concurrent tasks never share candidate
  // state or thrash the embedding cache on each other's otids (concurrency fix,
  // defense in depth on top of the per-run probe index).
  const transient = process.env.OTTER_SPEAKER_RESOLVER_TRANSIENT === '1';
  const merged = transient ? [...trackProbeRows()] : [...trackProbeRows(), ...queueRows()];
  const seen = new Set();
  const out = [];
  for (const row of merged) {
    // One call-local diarized observation is one acoustic sample. The
    // authoritative track-probe index is ordered first, so a stale review
    // queue row with a changed generated id cannot duplicate it or override
    // its identity-grade exclusion.
    const key = `${row.otid}|${row.speaker_model_label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function rosterMap() {
  const r = readJson(ROSTER, {});
  const map = new Map();
  for (const row of r.roster || []) {
    map.set(row.voice_cluster_id, row);
  }
  return map;
}

// Bounded-memory replacement for the old `enrichedFilesByOtid()` helper, which
// parsed every enriched transcript into one resident Map before the first track
// was scored. That killed the run on 2026-08-15/16/17: the corpus reached 1,321
// files holding 1.8 GB of JSON, and the eager parse blew the 1,967 MB Node heap
// (and the 2,048 MB systemd MemoryMax) inside JSON.parse, so no voice was named
// after 15 August. See scripts/lib/otter-enriched-store.js for the parity rules.
// Peak memory is now set by ENRICHED_CACHE_MAX, not by corpus size.
//
// A sibling `rawFilesByOtid()` helper with the same eager-parse hazard over the
// 1.3 GB raw corpus was removed here: nothing called it.
const ENRICHED_CACHE_MAX =
  Math.max(1, Number(process.env.OTTER_ENRICHED_CACHE_MAX || '4') || 4) || 4;

function enrichedStore() {
  return createEnrichedStore({ dir: ENRICHED_DIR, cacheMax: ENRICHED_CACHE_MAX });
}

// bestPersonMatch lives in lib/voice-reference-people.js: it skips runner-up
// candidates whose centroid is near-identical to the winner's, so a duplicate
// enrollment of the same human can never zero the margin and permanently block
// attribution (the jenna/PRIVATE_NAME margin-0 regression).

function deniedPeople(identity, voiceClusterId) {
  const out = new Set();
  for (const row of identity.voice_cluster_denials?.[voiceClusterId] || []) {
    // Canonicalize so a denial recorded against an alias id also covers the
    // canonical reference person the resolver actually scores against.
    if (row.denied_person_id) out.add(canonicalPersonId(identity, row.denied_person_id));
  }
  return out;
}

function confirmedResolution(identity, voiceClusterId) {
  const canonicalMatch = String(voiceClusterId || '').match(/^person:(.+)$/);
  if (canonicalMatch) {
    const person = identity.people?.[canonicalMatch[1]];
    if (
      person?.identity_confirmation_status === 'confirmed_by_ExampleCo' &&
      person?.voiceprint_status === 'enrolled'
    ) {
      return {
        status: 'confirmed_by_ExampleCo',
        person_id: canonicalMatch[1],
        display_name: person.display_name || canonicalMatch[1],
      };
    }
  }
  const resolution = identity.voice_cluster_resolutions?.[voiceClusterId];
  if (resolution?.status === 'confirmed_by_ExampleCo' && resolution.person_id) return resolution;
  return null;
}

function probeDurationSeconds(row) {
  let dur = Number(row?.probe_quality?.duration_seconds || 0);
  if (!dur) {
    const m = String(row?.probe_audio_path || '').match(/dur-([0-9.]+)/);
    if (m) dur = Number(m[1]);
  }
  return dur || null;
}

function buildScoringContext({ people }) {
  if (process.env.SPEAKER_SCORE_NORMALIZATION === '0') {
    return { enabled: false, reason: 'disabled_by_env' };
  }
  const opsArtifact = readJson(SCORE_CALIBRATION_PATH, null);
  if (!opsArtifact || opsArtifact.status !== 'ok' || !opsArtifact.models?.global?.trained) {
    return {
      enabled: false,
      reason: opsArtifact
        ? `calibration_status_${opsArtifact.status || 'unknown'}`
        : 'no_calibration_artifact',
    };
  }
  const cohortArtifact = readJson(ASNORM_COHORT_PATH, null);
  const cohort = cohortArtifact?.status === 'ok' ? cohortArtifact.cohort || [] : [];
  const normalizer =
    cohort.length >= 30
      ? buildNormalizer(cohort, { topK: Number(process.env.SPEAKER_ASNORM_TOP_K || '100') || 100 })
      : null;
  return {
    enabled: true,
    artifact: opsArtifact,
    // Env-pinned raw gates stay authoritative over anything in the artifact
    // (drift-lint contract at the Fargate boundary).
    ops: {
      ...opsArtifact.ops,
      raw_score_gate: MATCH_SCORE,
      raw_margin_gate: MATCH_MARGIN,
    },
    models: opsArtifact.models,
    normalizer,
    peopleById: new Map(people.map((person) => [person.person_id, person])),
    cohort_size: cohort.length,
  };
}

function buildTrackIdentity({ row, identity, referencePeople, vector, scoring, netSpeechSeconds }) {
  const sourceVoiceClusterId = row.source_voice_cluster_id || row.voice_cluster_id;
  const exact =
    confirmedResolution(identity, sourceVoiceClusterId) ||
    confirmedResolution(identity, row.voice_cluster_id);
  if (exact) {
    // Confirmations recorded against an alias id (jenna, PRIVATE_NAME,
    // PRIVATE_NAME, ...) emit the canonical person so one human never splits
    // into two identities across resolver generations.
    const exactPersonId = canonicalPersonId(identity, exact.person_id);
    return applyCanonicalSpeakerIdentity(
      {
        resolved_person: personName(identity, exactPersonId),
        person_id: exactPersonId,
        identity_tier: 'confirmed_by_ExampleCo_cluster',
        confidence: 1,
        evidence: ['ExampleCo_confirmation', 'exact_voice_cluster_id'],
        voice_cluster_id: row.voice_cluster_id,
        unknown_speaker_id: null,
        wavlm: null,
      },
      exactPersonId,
      { sourceVoiceClusterId },
    );
  }
  const match = bestPersonMatch(
    vector,
    referencePeople,
    deniedPeople(identity, sourceVoiceClusterId),
  );
  // Calibrated scoring (Phase B2): compute the calibrated probability and the
  // AS-Norm score as evidence. The decision gate is precision-first: the raw
  // 0.56/0.06 path is unchanged; calibration can only ADD accepts that clear
  // the audited probability gate plus raw safety floors.
  let calibration = null;
  if (scoring?.enabled && match) {
    const person = scoring.peopleById.get(match.person_id) || null;
    const normalized =
      scoring.normalizer && person && vector?.length
        ? scoring.normalizer.normalize(match.score, person.centroid, vector, {
            excludeOtids: new Set([row.otid]),
          })
        : null;
    calibration = { normalized_score: normalized == null ? null : Number(normalized.toFixed(4)) };
  }
  // The shared reference-match decision: the global recluster calls the same
  // function, so no path can name a speaker this gate rejects.
  const verdict = referenceMatchDecision({
    rawScore: match?.score ?? 0,
    rawMargin: match?.margin ?? 0,
    calibration: scoring?.enabled && match ? scoring.artifact : null,
    durationSeconds: probeDurationSeconds(row),
    rawScoreGate: MATCH_SCORE,
    rawMarginGate: MATCH_MARGIN,
  });
  if (calibration) {
    calibration = {
      probability: verdict.calibration?.probability ?? null,
      normalized_score: calibration.normalized_score,
      duration_band: verdict.calibration?.duration_band ?? null,
      band_model_used: Boolean(verdict.calibration?.band_model_used),
    };
  }
  // Net-speech floor (Phase B1): a named identity requires enough clean
  // speech; below the floor the match survives as evidence only.
  const netSpeechOk = netSpeechSeconds == null || netSpeechSeconds >= MIN_NET_SPEECH_SECONDS;
  if (ENABLE_KNOWN_MATCHES && match && verdict.accept && netSpeechOk) {
    const acceptedConfidence = acceptedMatchConfidence({
      probability: calibration?.probability ?? null,
      rawScore: match.score,
    });
    return applyCanonicalSpeakerIdentity(
      {
        resolved_person: match.display_name,
        person_id: match.person_id,
        identity_tier: 'confirmed_reference_voiceprint_match',
        net_speech_seconds: netSpeechSeconds,
        confidence: acceptedConfidence.value,
        confidence_basis: acceptedConfidence.basis,
        evidence: [
          `${SPEAKER_BACKEND}_speaker_embedding`,
          'confirmed_reference_voiceprint',
          'margin_gate',
          `gate_${verdict.path}`,
        ],
        voice_cluster_id: row.voice_cluster_id,
        unknown_speaker_id: null,
        voice_embedding_match: match,
        calibration,
        wavlm: SPEAKER_BACKEND === 'wavlm' ? match : null,
        ecapa: SPEAKER_BACKEND === 'ecapa' ? match : null,
      },
      match.person_id,
      { sourceVoiceClusterId },
    );
  }
  return {
    resolved_person: null,
    person_id: null,
    identity_tier: 'durable_unknown_voice',
    confidence: 0,
    net_speech_seconds: netSpeechSeconds,
    evidence: [
      `${SPEAKER_BACKEND}_speaker_embedding_available`,
      verdict.accept && !netSpeechOk
        ? 'match_below_net_speech_minimum'
        : 'no_confirmed_reference_cleared_margin',
    ],
    voice_cluster_id: row.voice_cluster_id,
    unknown_speaker_id: row.unknown_speaker_id || row.voice_cluster_id,
    voice_embedding_match: match,
    calibration,
    wavlm: SPEAKER_BACKEND === 'wavlm' ? match : null,
    ecapa: SPEAKER_BACKEND === 'ecapa' ? match : null,
  };
}

function assignUnknownGroups(trackRows) {
  const groups = [];
  for (const row of trackRows.filter(
    (item) => item.identity.identity_tier === 'durable_unknown_voice',
  )) {
    if (!ENABLE_UNKNOWN_GROUPING) {
      groups.push({
        acoustic_unknown_id: `unknown_voice_${SPEAKER_BACKEND}_ungrouped_${sha16(row.voice_cluster_id || row.probe_audio_path)}`,
        centroid: row.vector || [],
        members: [row],
        max_pair_score: 1,
      });
      continue;
    }
    if (!row.vector?.length) continue;
    let best = null;
    for (const group of groups) {
      const score = cosine(row.vector, group.centroid);
      const pairScores = group.members.map((member) => cosine(row.vector, member.vector));
      const minPairScore = pairScores.length ? Math.min(...pairScores) : score;
      const supportCount = pairScores.filter(
        (pairScore) => pairScore >= UNKNOWN_CLUSTER_MIN_PAIR_SCORE,
      ).length;
      const sameCallDifferentLabel = group.members.some(
        (member) =>
          member.otid === row.otid &&
          String(member.speaker_model_label || '') !== String(row.speaker_model_label || ''),
      );
      if (!best || score > best.score) {
        best = {
          group,
          score,
          minPairScore,
          supportCount,
          sameCallDifferentLabel,
        };
      }
    }
    const passesCentroid = best && best.score >= UNKNOWN_CLUSTER_SCORE;
    const seedSize = Math.min(best?.group.members.length || 0, UNKNOWN_CLUSTER_MIN_CORE_MATCHES);
    const passesCoreSupport =
      best &&
      (best.group.members.length < UNKNOWN_CLUSTER_MIN_CORE_MATCHES
        ? best.minPairScore >= UNKNOWN_CLUSTER_MIN_PAIR_SCORE
        : best.supportCount >= seedSize);
    const passesSameCallGate =
      !best?.sameCallDifferentLabel ||
      (best.score >= UNKNOWN_CLUSTER_SAME_CALL_DIFFERENT_LABEL_SCORE &&
        best.minPairScore >= UNKNOWN_CLUSTER_SAME_CALL_DIFFERENT_LABEL_SCORE);
    if (passesCentroid && passesCoreSupport && passesSameCallGate) {
      best.group.members.push(row);
      best.group.centroid = meanVector(best.group.members.map((item) => item.vector));
      best.group.max_pair_score = Math.max(
        best.group.max_pair_score,
        Number(best.score.toFixed(6)),
      );
      best.group.min_pair_score = Math.min(
        best.group.min_pair_score ?? 1,
        Number(best.minPairScore.toFixed(6)),
      );
      best.group.min_core_matches = UNKNOWN_CLUSTER_MIN_CORE_MATCHES;
    } else {
      groups.push({
        acoustic_unknown_id: `unknown_voice_${SPEAKER_BACKEND}_${sha16(row.voice_cluster_id || row.probe_audio_path)}`,
        centroid: row.vector,
        members: [row],
        max_pair_score: 1,
        min_pair_score: 1,
        min_core_matches: UNKNOWN_CLUSTER_MIN_CORE_MATCHES,
      });
    }
  }
  for (const group of groups) {
    for (const member of group.members) {
      member.identity.acoustic_unknown_id = group.acoustic_unknown_id;
      member.identity.evidence.push('durable_acoustic_unknown_group');
    }
  }
  return groups
    .map((group) => ({
      acoustic_unknown_id: group.acoustic_unknown_id,
      member_count: group.members.length,
      conversation_count: new Set(group.members.map((item) => item.otid)).size,
      voice_cluster_ids: group.members.map((item) => item.voice_cluster_id).filter(Boolean),
      sample_titles: group.members
        .slice(0, 6)
        .map((item) => item.title)
        .filter(Boolean),
      sample_text: group.members
        .map((item) => item.sample_text)
        .filter(Boolean)
        .slice(0, 4),
      max_pair_score: group.max_pair_score,
      min_pair_score: group.min_pair_score,
      min_core_matches: group.min_core_matches,
    }))
    .sort((a, b) => b.member_count - a.member_count || b.conversation_count - a.conversation_count);
}

function wordsForTrack(enriched, label) {
  return (enriched.segments || [])
    .filter((segment) => String(segment.speaker_model_label || '') === String(label))
    .map((segment) => segment.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function terms(text) {
  return [
    ...String(text || '')
      .toLowerCase()
      .matchAll(/\b[a-z][a-z0-9-]{3,}\b/g),
  ]
    .map((m) => m[0])
    .filter(
      (word) =>
        !new Set([
          'that',
          'this',
          'with',
          'have',
          'from',
          'they',
          'there',
          'would',
          'about',
          'right',
          'yeah',
          'like',
          'just',
          'what',
          'when',
          'then',
          'into',
          'them',
          'your',
          'weve',
          'were',
          'going',
          'think',
          'know',
          'okay',
          'sure',
          'because',
        ]).has(word),
    );
}

function topTerms(text, n = 12) {
  const counts = new Map();
  for (const term of terms(text)) counts.set(term, (counts.get(term) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([term, count]) => ({ term, count }));
}

function buildUnknownDossiers(groups, roster) {
  const rows = [];
  for (const group of groups) {
    const members = group.voice_cluster_ids.map((id) => roster.get(id)).filter(Boolean);
    const allText = [
      ...group.sample_text,
      ...members.flatMap((m) => (m.examples || []).map((ex) => ex.snippet || '')),
      ...members.map((m) => m.own_words_sample || m.sample_text || ''),
    ].join(' ');
    const guesses = new Map();
    for (const m of members) {
      const guess = m.top_name_guess;
      if (guess?.display_name) {
        const key = guess.person_id || guess.display_name;
        const current = guesses.get(key) || { ...guess, occurrences: 0 };
        current.occurrences += 1;
        guesses.set(key, current);
      }
    }
    const topGuess =
      [...guesses.values()].sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;
    rows.push({
      acoustic_unknown_id: group.acoustic_unknown_id,
      call_count: group.conversation_count,
      voice_cluster_count: group.member_count,
      known_name: null,
      current_identity_hypothesis: topGuess
        ? {
            display_name: topGuess.display_name,
            person_id: topGuess.person_id,
            confidence: topGuess.confidence || 'context_only',
            score: topGuess.score || null,
            warning: 'context hypothesis only; not a voice-confirmed identity',
          }
        : null,
      what_they_talk_about: topTerms(allText, 12),
      why_they_matter: members
        .slice(0, 5)
        .map((m) => m.top_name_guess?.description || m.representative_title || m.title)
        .filter(Boolean),
      likely_relationship_to_ExampleCo: inferRelationship(allText),
      representative_moments: [
        ...group.sample_text.map((text) => ({
          source: 'speaker_sample',
          text: text.slice(0, 420),
        })),
        ...members.flatMap((m) =>
          (m.name_candidates || []).flatMap((c) =>
            (c.evidence || []).slice(0, 1).map((e) => ({
              source: e.type || 'context_evidence',
              title: e.title || m.representative_title || '',
              date: e.date || '',
              text: String(e.snippet || '').slice(0, 420),
            })),
          ),
        ),
      ]
        .filter((m) => m.text)
        .slice(0, 8),
      voice_cluster_ids: group.voice_cluster_ids.slice(0, 20),
    });
  }
  return rows
    .filter((row) => !row.known_name)
    .sort((a, b) => b.call_count - a.call_count || b.voice_cluster_count - a.voice_cluster_count)
    .slice(0, 40);
}

function inferRelationship(text) {
  const t = String(text || '').toLowerCase();
  if (
    /\b(team|roadmap|review|follow up|deliver|dashboard|model|forecast|pricing)\b/.test(
      t,
    )
  )
    return 'likely work collaborator or project counterpart';
  if (/\b(report|approval|decision|strategy|leadership|senior|budget)\b/.test(t))
    return 'possibly senior stakeholder or decision partner';
  if (/\b(can you|could you|please|send me|need you)\b/.test(t))
    return 'possibly task partner or direct collaborator';
  return 'relationship unclear from current text; needs more context/confirmation';
}

function applyToEnriched(enriched, identitiesByLabel) {
  let changed = 0;
  enriched.speaker_identity_tracks ||= {};
  for (const [label, identity] of identitiesByLabel.entries()) {
    enriched.speaker_identity_tracks[label] = identity;
  }
  for (const segment of enriched.segments || []) {
    const label = String(segment.speaker_model_label || '');
    const identity = identitiesByLabel.get(label);
    if (!identity) continue;
    segment.resolved_speaker = {
      otter_speaker: label,
      resolved_person: identity.resolved_person,
      person_id: identity.person_id,
      identity_tier: identity.identity_tier,
      confidence: identity.confidence,
      confidence_basis: identity.confidence_basis || null,
      evidence: identity.evidence,
      canonical_speaker_id: identity.canonical_speaker_id || null,
      speaker_id: identity.speaker_id || identity.voice_cluster_id,
      voice_cluster_id: identity.voice_cluster_id,
      source_voice_cluster_id: identity.source_voice_cluster_id || null,
      unknown_speaker_id: identity.unknown_speaker_id,
      acoustic_unknown_id: identity.acoustic_unknown_id || null,
      source_acoustic_group_id: identity.source_acoustic_group_id || null,
    };
    changed += 1;
  }
  return changed;
}

async function main() {
  const write = hasArg('--write');
  const limit = Number(argValue('--limit', '0')) || Infinity;
  const requestedOtids = new Set(
    String(argValue('--otids', ''))
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  // Fail-fast preflight (Phase A1): a backend that cannot run at all (missing
  // venv, missing speechbrain) must fail the run in seconds with a distinct
  // exit code and an honest status artifact, never grind through hundreds of
  // per-chunk errors with written=0 (the 2026-07-10 dead run).
  if (!SKIP_EMBEDDINGS && typeof embeddingBackend.preflight === 'function') {
    let pf = null;
    try {
      pf = await Promise.resolve(embeddingBackend.preflight());
    } catch (error) {
      pf = { ok: false, reason: error.message || String(error) };
    }
    if (!pf || pf.ok !== true) {
      const failure = {
        schema: 'life_archive_otter_speaker_resolver.v2',
        backend: SPEAKER_BACKEND,
        generated_at: new Date().toISOString(),
        status: 'backend_unavailable',
        failure_reason: (pf && pf.reason) || 'speaker embedding backend preflight failed',
        failure_taxonomy: { backend_unavailable: 1 },
        candidate_tracks_seen: 0,
        tracks_resolved: 0,
        wrote: false,
        sandbox: SANDBOX,
      };
      if (write) {
        saveJson(STATUS_PATH, failure);
        if (SPEAKER_BACKEND === 'ecapa' && LEGACY_STATUS_PATH)
          saveJson(LEGACY_STATUS_PATH, failure);
      }
      process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
      process.exitCode = 3;
      return;
    }
  }
  const identity = readJson(IDENTITY_REGISTRY, {});
  const { references, people } = await loadReferenceEmbeddings(identity);
  const scoring = buildScoringContext({ people });
  const enrichedByOtid = enrichedStore();
  const roster = rosterMap();
  const rows = candidateRows()
    .filter((row) => requestedOtids.size === 0 || requestedOtids.has(String(row.otid || '')))
    .filter((row) => row.probe_audio_path && fs.existsSync(repoAbs(row.probe_audio_path)))
    .slice(0, limit);
  const preload = await preloadEmbeddings(
    rows.flatMap((row) => [
      row.probe_audio_path,
      ...(row.extra_windows || []).map((w) => w.probe_audio_path),
    ]),
  );

  const trackRows = [];
  const errors = (preload.errors || []).map((row) => ({
    ...row,
    class: row.class || classifyError(row.error, 'embedding'),
  }));

  // Incremental per-otid flush (Phase A1): as soon as every candidate row of an
  // otid has been processed, its raw/enriched updates persist. A run that dies
  // mid-loop keeps everything already completed instead of writing nothing.
  const remainingByOtid = new Map();
  for (const row of rows) remainingByOtid.set(row.otid, (remainingByOtid.get(row.otid) || 0) + 1);
  const trackRowsByOtid = new Map();
  const enrichedFilesTouched = new Set();
  let enrichedSegmentsTagged = 0;
  const sandboxCandidates = [];
  const sandboxRejectedCandidates = [];
  const archiveOnlyEmbeddings = [];
  const terminalBelowIdentityGradeDispositions = [];

  const includeInDurableWrites = (identityResult) =>
    !SANDBOX || identityResult.identity_tier !== 'confirmed_reference_voiceprint_match';

  function flushOtid(otid, countStats = true) {
    if (!write) return;
    const rowsForOtid = trackRowsByOtid.get(otid) || [];
    const identitiesByLabel = new Map();
    for (const trackRow of rowsForOtid) {
      if (!includeInDurableWrites(trackRow.identity)) continue;
      identitiesByLabel.set(String(trackRow.speaker_model_label || ''), trackRow.identity);
    }
    if (!identitiesByLabel.size) return;
    const enrichedRow = enrichedByOtid.get(otid);
    if (enrichedRow) {
      const changed = applyToEnriched(enrichedRow.enriched, identitiesByLabel);
      if (changed) {
        saveJson(enrichedRow.file, enrichedRow.enriched);
        enrichedFilesTouched.add(otid);
        if (countStats) enrichedSegmentsTagged += changed;
      }
    }
  }

  function rowDone(row) {
    const left = (remainingByOtid.get(row.otid) || 1) - 1;
    remainingByOtid.set(row.otid, left);
    if (left <= 0) {
      flushOtid(row.otid);
      // Every row of this otid is processed and its enriched file is already
      // written, so drop the parsed transcript. Peak memory then tracks the
      // batch, not the number of calls seen so far.
      enrichedByOtid.release(row.otid);
    }
  }

  for (const [index, row] of rows.entries()) {
    let failed = false;
    try {
      const exact =
        row.identity_grade === false ? null : confirmedResolution(identity, row.voice_cluster_id);
      let cached;
      let terminalEmbeddingQualityRejection = false;
      if (exact) {
        cached = {
          embedding: {
            vector: [],
            quality: {
              skipped: true,
              reason: 'exact_ExampleCo_confirmed_identity_does_not_require_embedding',
            },
          },
        };
      } else if (SKIP_EMBEDDINGS) {
        cached = {
          embedding: {
            vector: [],
            quality: { skipped: true, reason: 'wavlm_auto_matching_disabled_by_calibration' },
          },
        };
      } else {
        try {
          const primary = await embeddingFor(row.probe_audio_path);
          const parts = [];
          const windowOutcomes = [];
          if (
            primary?.embedding?.vector?.length &&
            primary.embedding?.quality?.usable !== false &&
            !primary.error
          ) {
            parts.push({
              vector: primary.embedding.vector,
              quality: primary.embedding.quality,
              tier: 'standard',
            });
            windowOutcomes.push('usable');
          } else if (
            primary?.embedding?.vector?.length &&
            primary.embedding?.quality?.usable === false &&
            !primary.error
          ) {
            windowOutcomes.push('quality_rejected');
          } else {
            windowOutcomes.push(
              classifyError(primary?.error || 'missing_embedding_vector', 'embedding'),
            );
          }
          // Multi-window aggregation (Phase B1): extras are best effort; a
          // failed extra never dead-letters the track, the primary path does.
          for (const extra of row.extra_windows || []) {
            if (!extra?.probe_audio_path) continue;
            try {
              const extraCached = await embeddingFor(extra.probe_audio_path);
              if (
                extraCached?.embedding?.vector?.length &&
                extraCached.embedding?.quality?.usable !== false &&
                !extraCached.error
              ) {
                parts.push({
                  vector: extraCached.embedding.vector,
                  quality: extraCached.embedding.quality,
                  tier: extra.tier || 'standard',
                });
                windowOutcomes.push('usable');
              } else if (
                extraCached?.embedding?.vector?.length &&
                extraCached.embedding?.quality?.usable === false &&
                !extraCached.error
              ) {
                windowOutcomes.push('quality_rejected');
              } else {
                windowOutcomes.push(
                  classifyError(extraCached?.error || 'missing_embedding_vector', 'embedding'),
                );
              }
            } catch (error) {
              windowOutcomes.push(classifyError(error.message, 'embedding'));
            }
          }
          if (parts.length > 1) {
            cached = {
              embedding: {
                vector: weightedMeanVector(parts),
                quality: {
                  usable: true,
                  duration_seconds: netSpeechSecondsOf(parts),
                  windows: parts.length,
                  aggregation: 'duration_weighted_centroid',
                },
              },
            };
          } else if (parts.length === 1 && windowOutcomes[0] !== 'usable') {
            cached = {
              embedding: {
                vector: parts[0].vector,
                quality: {
                  ...(parts[0].quality || {}),
                  windows: 1,
                  aggregation: 'single_usable_extra_window',
                },
              },
            };
          } else {
            cached = primary;
          }
          terminalEmbeddingQualityRejection =
            parts.length === 0 &&
            windowOutcomes.length === 1 + (row.extra_windows || []).length &&
            windowOutcomes.every((outcome) => outcome === 'quality_rejected');
        } catch (error) {
          errors.push({
            voice_cluster_id: row.voice_cluster_id,
            probe_audio_path: row.probe_audio_path,
            error: error.message,
            class: classifyError(error.message, 'embedding'),
          });
          failed = true;
        }
      }
      if (!failed && !exact && !SKIP_EMBEDDINGS && terminalEmbeddingQualityRejection) {
        const disposition = {
          otid: String(row.otid || ''),
          source_revision: String(row.source_revision || row.source_revision_hash || ''),
          speaker_model_label: String(row.speaker_model_label || ''),
          voice_cluster_id: String(row.voice_cluster_id || ''),
          probe_audio_path: String(row.probe_audio_path || ''),
          identity_grade: false,
          evidence_tier: 'archive_weak',
          acoustic_assignment_status: 'unresolved_below_identity_grade',
          uncertainty_reason:
            'All available exact-call probe windows failed the speaker-embedding quality gate.',
          embedding_quality: cached?.embedding?.quality || {},
        };
        if (write) persistTerminalBelowIdentityGrade(row, cached?.embedding?.quality || {});
        Object.assign(row, disposition);
        terminalBelowIdentityGradeDispositions.push(disposition);
      }
      if (
        !failed &&
        !exact &&
        !SKIP_EMBEDDINGS &&
        (cached.error ||
          !cached.embedding?.vector?.length ||
          (row.identity_grade !== false && cached.embedding?.quality?.usable === false))
      ) {
        errors.push({
          voice_cluster_id: row.voice_cluster_id,
          probe_audio_path: row.probe_audio_path,
          error: cached.error || 'embedding_unusable',
          class: cached.error === 'missing_audio' ? 'missing_audio' : 'embedding_unusable',
        });
        failed = true;
      }
      if (!failed) {
        if (row.identity_grade === false) {
          archiveOnlyEmbeddings.push({
            otid: row.otid,
            speaker_model_label: row.speaker_model_label,
            voice_cluster_id: row.voice_cluster_id,
            probe_audio_path: row.probe_audio_path,
            evidence_tier: row.evidence_tier,
            embedding_quality: cached.embedding.quality,
            excluded_from_identity: true,
          });
        } else {
          const enriched = enrichedByOtid.get(row.otid)?.enriched;
          if (enriched) row.own_track_text = wordsForTrack(enriched, row.speaker_model_label);
          const netSpeechSeconds =
            exact || SKIP_EMBEDDINGS
              ? null
              : Number(cached?.embedding?.quality?.duration_seconds || 0) || null;
          const identityResult = buildTrackIdentity({
            row,
            identity,
            referencePeople: people,
            vector: cached.embedding.vector,
            scoring,
            netSpeechSeconds,
          });
          if (SANDBOX && identityResult.voice_embedding_match) {
            const sandboxCandidate = {
              otid: row.otid,
              source_revision: row.source_revision || row.source_revision_hash || '',
              title: row.title,
              speaker_model_label: row.speaker_model_label,
              voice_cluster_id: row.voice_cluster_id,
              candidate_person_id: identityResult.voice_embedding_match?.person_id || null,
              display_name: identityResult.voice_embedding_match?.display_name || null,
              score: identityResult.voice_embedding_match?.score ?? null,
              margin: identityResult.voice_embedding_match?.margin ?? null,
              // bestPersonMatch returns one winning person plus its runner-up
              // margin. The sandbox intentionally emits that winner only.
              rank: 1,
              probe_audio_path: row.probe_audio_path,
              reference_provenance:
                identityResult.voice_embedding_match?.reference_provenance || [],
              suppressed_by: 'sandbox',
            };
            if (identityResult.identity_tier === 'confirmed_reference_voiceprint_match') {
              sandboxCandidates.push(sandboxCandidate);
            } else {
              const score = Number(identityResult.voice_embedding_match?.score);
              const margin = Number(identityResult.voice_embedding_match?.margin);
              const rejectionReason = (identityResult.evidence || []).includes(
                'match_below_net_speech_minimum',
              )
                ? 'net_speech_below_identity_minimum'
                : !Number.isFinite(score) || score < MATCH_SCORE
                  ? 'score_below_threshold'
                  : !Number.isFinite(margin) || margin < MATCH_MARGIN
                    ? 'margin_below_threshold'
                    : 'canonical_confirmation_gate_not_cleared';
              sandboxRejectedCandidates.push({
                ...sandboxCandidate,
                rejection_reason: rejectionReason,
              });
            }
          }
          const trackRow = {
            ...row,
            vector: cached.embedding.vector,
            embedding_quality: cached.embedding.quality,
            identity: {
              ...identityResult,
              probe_audio_path: row.probe_audio_path,
              source_full_audio_path: row.source_full_audio_path,
              sample_transcript: row.sample_transcript,
            },
          };
          trackRows.push(trackRow);
          if (!trackRowsByOtid.has(row.otid)) trackRowsByOtid.set(row.otid, []);
          trackRowsByOtid.get(row.otid).push(trackRow);
        }
      }
    } catch (error) {
      errors.push({
        voice_cluster_id: row.voice_cluster_id,
        probe_audio_path: row.probe_audio_path,
        error: error.message,
        class: classifyError(error.message),
      });
    }
    rowDone(row);
    if (write && ((index + 1) % 5 === 0 || index + 1 === rows.length)) {
      saveJson(PROGRESS_PATH, {
        schema: 'life_archive_otter_speaker_resolver_progress.v2',
        backend: SPEAKER_BACKEND,
        updated_at: new Date().toISOString(),
        processed: index + 1,
        total: rows.length,
        resolved_so_far: trackRows.length,
        errors_so_far: errors.length,
        latest: {
          otid: row.otid,
          speaker_model_label: row.speaker_model_label,
          voice_cluster_id: row.voice_cluster_id,
          probe_audio_path: row.probe_audio_path,
        },
      });
    }
  }
  const unknownGroups = assignUnknownGroups(trackRows);
  const unknownDossiers = buildUnknownDossiers(unknownGroups, roster);

  // Second flush pass: unknown-group ids are assigned globally after all rows,
  // so re-persist every otid that carries a durable unknown track to pick up
  // its acoustic_unknown_id (stats already counted in pass one).
  if (write) {
    const unknownOtids = new Set(
      trackRows
        .filter((row) => row.identity.identity_tier === 'durable_unknown_voice')
        .map((row) => row.otid),
    );
    for (const otid of unknownOtids) flushOtid(otid, false);
  }
  const enrichedFilesUpdated = enrichedFilesTouched.size;
  const pareto = [
    ...trackRows
      .reduce((map, row) => {
        const key = row.identity.person_id
          ? `person:${row.identity.person_id}`
          : `unknown:${row.identity.acoustic_unknown_id || row.identity.unknown_speaker_id || row.voice_cluster_id}`;
        const current = map.get(key) || {
          speaker_key: key,
          display_name:
            row.identity.resolved_person ||
            row.identity.acoustic_unknown_id ||
            row.identity.unknown_speaker_id ||
            row.voice_cluster_id,
          identity_tier: row.identity.identity_tier,
          track_count: 0,
          conversation_count: 0,
          voice_cluster_ids: new Set(),
          otids: new Set(),
        };
        current.track_count += 1;
        current.voice_cluster_ids.add(row.voice_cluster_id);
        current.otids.add(row.otid);
        current.conversation_count = current.otids.size;
        map.set(key, current);
        return map;
      }, new Map())
      .values(),
  ]
    .map((row) => ({
      ...row,
      voice_cluster_ids: [...row.voice_cluster_ids].slice(0, 20),
      otids: undefined,
    }))
    .sort((a, b) => b.track_count - a.track_count || b.conversation_count - a.conversation_count);

  const failureTaxonomy = {};
  for (const err of errors) {
    err.class = err.class || classifyError(err.error);
    failureTaxonomy[err.class] = (failureTaxonomy[err.class] || 0) + 1;
  }
  const report = {
    schema: 'life_archive_otter_speaker_resolver.v2',
    backend: SPEAKER_BACKEND,
    generated_at: new Date().toISOString(),
    wrote: write,
    status: errors.length ? 'completed_with_errors' : 'complete',
    failure_taxonomy: failureTaxonomy,
    sandbox: SANDBOX,
    sandbox_suppressed_matches: sandboxCandidates.length,
    dead_letters_path: repoRel(DEAD_LETTERS_PATH),
    thresholds: {
      match_score: MATCH_SCORE,
      match_margin: MATCH_MARGIN,
      unknown_cluster_score: UNKNOWN_CLUSTER_SCORE,
      unknown_cluster_min_pair_score: UNKNOWN_CLUSTER_MIN_PAIR_SCORE,
      unknown_cluster_min_core_matches: UNKNOWN_CLUSTER_MIN_CORE_MATCHES,
      unknown_cluster_same_call_different_label_score:
        UNKNOWN_CLUSTER_SAME_CALL_DIFFERENT_LABEL_SCORE,
      embedding_max_seconds: EMBED_MAX_SECONDS,
      min_net_speech_seconds: MIN_NET_SPEECH_SECONDS,
      known_matches_enabled: ENABLE_KNOWN_MATCHES,
      unknown_grouping_enabled: ENABLE_UNKNOWN_GROUPING,
      embeddings_skipped: SKIP_EMBEDDINGS,
      score_calibration: scoring.enabled
        ? {
            enabled: true,
            cohort_size: scoring.cohort_size,
            calibrated_probability_gate: scoring.ops.calibrated_probability_gate,
            calibrated_min_raw_floor: scoring.ops.calibrated_min_raw_floor,
          }
        : { enabled: false, reason: scoring.reason },
    },
    embedding_preload: preload,
    // Memory receipt (RC-2): parsed_files far below indexed_files, and
    // peak_resident_files at or under cache_max, is the proof that the run is
    // no longer sized by the corpus. A regression shows up here before it shows
    // up as a heap death.
    enriched_store: enrichedByOtid.stats(),
    reference_people: people.length,
    reference_enrollments_usable: references.length,
    candidate_tracks_seen: rows.length,
    tracks_resolved: trackRows.length,
    archive_only_tracks_embedded: archiveOnlyEmbeddings.length,
    archive_only_embeddings: archiveOnlyEmbeddings,
    terminal_below_identity_grade_dispositions: terminalBelowIdentityGradeDispositions,
    confirmed_by_ExampleCo_cluster: trackRows.filter(
      (row) => row.identity.identity_tier === 'confirmed_by_ExampleCo_cluster',
    ).length,
    confirmed_reference_voiceprint_matches: trackRows.filter(
      (row) => row.identity.identity_tier === 'confirmed_reference_voiceprint_match',
    ).length,
    durable_unknown_voice_tracks: trackRows.filter(
      (row) => row.identity.identity_tier === 'durable_unknown_voice',
    ).length,
    durable_unknown_acoustic_groups: unknownGroups.length,
    unknown_dossiers: unknownDossiers.length,
    raw_files_updated: 0,
    raw_assignments_updated: 0,
    enriched_files_updated: enrichedFilesUpdated,
    enriched_segments_tagged: enrichedSegmentsTagged,
    errors,
    pareto: pareto.slice(0, 80),
    known_matches: trackRows
      .filter((row) => row.identity.identity_tier !== 'durable_unknown_voice')
      .map((row) => ({
        otid: row.otid,
        title: row.title,
        speaker_model_label: row.speaker_model_label,
        voice_cluster_id: row.voice_cluster_id,
        resolved_person: row.identity.resolved_person,
        person_id: row.identity.person_id,
        tier: row.identity.identity_tier,
        score:
          row.identity.voice_embedding_match?.score ||
          row.identity.wavlm?.score ||
          row.identity.ecapa?.score ||
          null,
        margin:
          row.identity.voice_embedding_match?.margin ||
          row.identity.wavlm?.margin ||
          row.identity.ecapa?.margin ||
          null,
        probe_audio_path: row.probe_audio_path,
      })),
  };
  if (write) {
    saveJson(DEAD_LETTERS_PATH, {
      schema: 'life_archive_resolver_dead_letters.v1',
      backend: SPEAKER_BACKEND,
      generated_at: report.generated_at,
      run_status: report.status,
      counts: failureTaxonomy,
      dead_letters: errors,
    });
    if (SANDBOX) {
      saveJson(SANDBOX_CANDIDATES_PATH, {
        schema: 'life_archive_sandbox_candidate_assignments.v1',
        backend: SPEAKER_BACKEND,
        generated_at: report.generated_at,
        thresholds: report.thresholds,
        candidate_count: sandboxCandidates.length,
        rejected_candidate_count: sandboxRejectedCandidates.length,
        candidates: sandboxCandidates,
        rejected_candidates: sandboxRejectedCandidates,
      });
    }
    saveJson(STATUS_PATH, report);
    if (SPEAKER_BACKEND === 'ecapa' && LEGACY_STATUS_PATH) saveJson(LEGACY_STATUS_PATH, report);
    saveJson(TRACK_GROUPS_PATH, {
      schema: 'life_archive_speaker_groups.v2',
      backend: SPEAKER_BACKEND,
      generated_at: report.generated_at,
      thresholds: report.thresholds,
      groups: unknownGroups,
      pareto: report.pareto,
    });
    if (SPEAKER_BACKEND === 'ecapa' && LEGACY_TRACK_GROUPS_PATH)
      saveJson(LEGACY_TRACK_GROUPS_PATH, {
        schema: 'life_archive_speaker_groups.v2',
        backend: SPEAKER_BACKEND,
        generated_at: report.generated_at,
        thresholds: report.thresholds,
        groups: unknownGroups,
        pareto: report.pareto,
      });
    saveJson(UNKNOWN_DOSSIER_PATH, {
      schema: 'life_archive_unknown_speaker_dossiers.v1',
      generated_at: report.generated_at,
      dossiers: unknownDossiers,
    });
    report.speaker_identity_change_hook = runSpeakerIdentityChangeHook(
      `otter-${SPEAKER_BACKEND}-speaker-resolver`,
    );
    saveJson(STATUS_PATH, report);
    if (SPEAKER_BACKEND === 'ecapa' && LEGACY_STATUS_PATH) saveJson(LEGACY_STATUS_PATH, report);
    if (report.speaker_identity_change_hook.ok === false) process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (errors.length) process.exitCode = 2;
}

main().catch((error) => {
  // Fatal-crash honesty (Phase A1): even an unhandled error leaves an honest
  // status artifact so health can distinguish "crashed" from "never ran".
  try {
    saveJson(STATUS_PATH, {
      schema: 'life_archive_otter_speaker_resolver.v2',
      backend: SPEAKER_BACKEND,
      generated_at: new Date().toISOString(),
      status: 'fatal',
      failure_reason: error && error.message ? error.message : String(error),
      failure_taxonomy: { fatal: 1 },
      sandbox: SANDBOX,
      wrote: false,
    });
  } catch {
    /* best effort */
  }
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
