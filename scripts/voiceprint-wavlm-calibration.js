#!/usr/bin/env node
/**
 * Calibrate WavLM voiceprint matching on ExampleCo-confirmed enrollments.
 *
 * This answers the concrete safety question: if we use a shorter embedding
 * window for speed, do the confirmed voiceprints still separate correctly from
 * other confirmed people?
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { embedOne } = require('./voice-embedding-wavlm.js');

const REPO = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(REPO, 'data', 'life-archive', 'voice-identity-registry.json');
const VP_DIR = path.join(REPO, 'data', 'life-archive', 'voiceprints');
const CACHE_DIR = path.join(VP_DIR, 'wavlm-calibration-embeddings');
const OUT_PATH = path.join(VP_DIR, 'wavlm-calibration-latest.json');
const PROGRESS_PATH = path.join(VP_DIR, 'wavlm-calibration-progress.json');

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function repoAbs(file) {
  if (!file) return '';
  return path.isAbsolute(file) ? file : path.join(REPO, file);
}

function repoRel(file) {
  return path.relative(REPO, repoAbs(file)).replace(/\\/g, '/');
}

function sha16(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
}

function cachePath(audioPath, seconds) {
  const abs = repoAbs(audioPath);
  let statKey = 'missing';
  try {
    const st = fs.statSync(abs);
    statKey = `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {}
  return path.join(CACHE_DIR, `${sha16(`${repoRel(abs)}:${statKey}:seconds-${seconds}`)}.json`);
}

async function embedding(audioPath, seconds) {
  const abs = repoAbs(audioPath);
  if (!fs.existsSync(abs)) return { error: 'missing_audio', audio_path: repoRel(abs) };
  const cache = cachePath(abs, seconds);
  const cached = readJson(cache, null);
  if (cached?.embedding?.vector?.length) return cached;
  const row = {
    schema: 'life_archive_wavlm_calibration_embedding.v1',
    generated_at: new Date().toISOString(),
    audio_path: repoRel(abs),
    max_seconds: seconds,
    embedding: await embedOne(abs, { maxSeconds: seconds }),
  };
  saveJson(cache, row);
  return row;
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

function confirmedEnrollments(registry) {
  const confirmedPeople = new Set(Object.entries(registry.people || {})
    .filter(([, person]) => person.identity_confirmation_status === 'confirmed_by_ExampleCo' && person.voiceprint_status === 'enrolled')
    .map(([personId]) => personId));
  return (registry.enrollments || [])
    .filter((row) => confirmedPeople.has(row.person_id))
    .map((row) => ({
      person_id: row.person_id,
      display_name: row.display_name || registry.people?.[row.person_id]?.display_name || row.person_id,
      enrollment_id: row.enrollment_id,
      voice_cluster_id: row.voice_cluster_id || null,
      reference_audio_path: row.reference_audio_rel || row.reference_audio_path,
    }))
    .filter((row) => row.reference_audio_path && fs.existsSync(repoAbs(row.reference_audio_path)));
}

function nearest(vector, centroids, excludePersonId = '') {
  return centroids
    .filter((row) => row.person_id !== excludePersonId)
    .map((row) => ({ ...row, score: cosine(vector, row.centroid) }))
    .sort((a, b) => b.score - a.score)[0] || null;
}

async function main() {
  const write = hasArg('--write');
  const seconds = Number(argValue('--seconds', process.env.VOICE_EMBEDDING_MAX_SECONDS || '12')) || 12;
  const matchScore = Number(argValue('--match-score', process.env.WAVLM_MATCH_SCORE || '0.968')) || 0.968;
  const matchMargin = Number(argValue('--match-margin', process.env.WAVLM_MATCH_MARGIN || '0.015')) || 0.015;
  const registry = readJson(REGISTRY_PATH, {});
  const enrollments = confirmedEnrollments(registry);
  const rows = [];
  for (const [index, enrollment] of enrollments.entries()) {
    const cached = await embedding(enrollment.reference_audio_path, seconds);
    rows.push({
      ...enrollment,
      audio_path: cached.audio_path,
      quality: cached.embedding?.quality || null,
      vector: cached.embedding?.vector || null,
      error: cached.error || null,
    });
    if (write) saveJson(PROGRESS_PATH, {
      schema: 'life_archive_wavlm_calibration_progress.v1',
      updated_at: new Date().toISOString(),
      processed: index + 1,
      total: enrollments.length,
      seconds,
      latest: {
        person_id: enrollment.person_id,
        display_name: enrollment.display_name,
        reference_audio_path: enrollment.reference_audio_path,
      },
    });
  }
  const usable = rows.filter((row) => row.vector?.length && row.quality?.usable !== false);
  const byPerson = new Map();
  for (const row of usable) {
    if (!byPerson.has(row.person_id)) byPerson.set(row.person_id, []);
    byPerson.get(row.person_id).push(row);
  }
  const centroids = [...byPerson.entries()].map(([personId, refs]) => ({
    person_id: personId,
    display_name: refs[0]?.display_name || personId,
    reference_count: refs.length,
    centroid: meanVector(refs.map((row) => row.vector)),
  }));

  const enrollmentTests = usable.map((row) => {
    const ownRefs = (byPerson.get(row.person_id) || []).filter((ref) => ref.enrollment_id !== row.enrollment_id);
    const ownComparison = ownRefs.length
      ? { mode: 'leave_one_out_other_confirmed_reference', score: cosine(row.vector, meanVector(ownRefs.map((ref) => ref.vector))) }
      : { mode: 'single_reference_only_self_centroid_not_independent', score: cosine(row.vector, centroids.find((c) => c.person_id === row.person_id)?.centroid || []) };
    const wrong = nearest(row.vector, centroids, row.person_id);
    const allNearest = nearest(row.vector, centroids, '');
    const margin = wrong ? ownComparison.score - wrong.score : ownComparison.score;
    return {
      person_id: row.person_id,
      display_name: row.display_name,
      enrollment_id: row.enrollment_id,
      voice_cluster_id: row.voice_cluster_id,
      audio_path: row.audio_path,
      quality: row.quality,
      own_match_mode: ownComparison.mode,
      own_score: Number(ownComparison.score.toFixed(6)),
      nearest_wrong_person_id: wrong?.person_id || null,
      nearest_wrong_display_name: wrong?.display_name || null,
      nearest_wrong_score: wrong ? Number(wrong.score.toFixed(6)) : null,
      margin_vs_wrong: Number(margin.toFixed(6)),
      nearest_any_person_id: allNearest?.person_id || null,
      nearest_any_display_name: allNearest?.display_name || null,
      nearest_any_score: allNearest ? Number(allNearest.score.toFixed(6)) : null,
      passes_current_gate: ownComparison.mode.startsWith('leave_one_out')
        ? ownComparison.score >= matchScore && margin >= matchMargin
        : margin >= matchMargin,
      test_limitation: ownComparison.mode.startsWith('single_reference')
        ? 'Only one ExampleCo-confirmed reference exists for this person, so this tests separation from wrong people, not same-person repeatability.'
        : null,
    };
  });

  const pairwiseWrong = [];
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      if (usable[i].person_id === usable[j].person_id) continue;
      pairwiseWrong.push({
        a: usable[i].display_name,
        a_person_id: usable[i].person_id,
        b: usable[j].display_name,
        b_person_id: usable[j].person_id,
        score: Number(cosine(usable[i].vector, usable[j].vector).toFixed(6)),
      });
    }
  }
  pairwiseWrong.sort((a, b) => b.score - a.score);

  const repeatable = enrollmentTests.filter((row) => row.own_match_mode.startsWith('leave_one_out'));
  const singleRef = enrollmentTests.filter((row) => row.own_match_mode.startsWith('single_reference'));
  const risky = enrollmentTests.filter((row) => row.margin_vs_wrong < matchMargin || (row.own_match_mode.startsWith('leave_one_out') && row.own_score < matchScore));
  const report = {
    schema: 'life_archive_wavlm_calibration.v1',
    generated_at: new Date().toISOString(),
    wrote: write,
    seconds,
    thresholds: { match_score: matchScore, match_margin: matchMargin },
    confirmed_enrollments_seen: enrollments.length,
    usable_enrollments: usable.length,
    confirmed_people: centroids.length,
    independently_repeatable_tests: repeatable.length,
    single_reference_people_tests: singleRef.length,
    risky_or_failed_tests: risky.length,
    conclusion: risky.length
      ? 'Do not use this window as an automatic known-speaker match gate until risky rows are reviewed or thresholds adjusted.'
      : 'No confirmed enrollment became nearest to the wrong person under this window; single-reference people still need more confirmed clips for real repeatability testing.',
    enrollment_tests: enrollmentTests.sort((a, b) => a.margin_vs_wrong - b.margin_vs_wrong),
    top_wrong_person_similarities: pairwiseWrong.slice(0, 25),
    missing_or_unusable: rows.filter((row) => row.error || !row.vector?.length || row.quality?.usable === false).map((row) => ({
      person_id: row.person_id,
      display_name: row.display_name,
      audio_path: row.reference_audio_path,
      error: row.error || 'unusable_quality',
      quality: row.quality,
    })),
  };
  if (write) saveJson(OUT_PATH, report);
  process.stdout.write(`${JSON.stringify({
    schema: report.schema,
    generated_at: report.generated_at,
    seconds,
    confirmed_enrollments_seen: report.confirmed_enrollments_seen,
    usable_enrollments: report.usable_enrollments,
    confirmed_people: report.confirmed_people,
    independently_repeatable_tests: report.independently_repeatable_tests,
    single_reference_people_tests: report.single_reference_people_tests,
    risky_or_failed_tests: report.risky_or_failed_tests,
    conclusion: report.conclusion,
    riskiest: report.enrollment_tests.slice(0, 10).map((row) => ({
      display_name: row.display_name,
      own_mode: row.own_match_mode,
      own_score: row.own_score,
      nearest_wrong: row.nearest_wrong_display_name,
      nearest_wrong_score: row.nearest_wrong_score,
      margin: row.margin_vs_wrong,
      passes: row.passes_current_gate,
      limitation: row.test_limitation,
    })),
    top_wrong_person_similarities: report.top_wrong_person_similarities.slice(0, 8),
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
