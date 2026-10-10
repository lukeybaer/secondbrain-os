const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = 'ecapa';
const MAX_SECONDS = 30;
const EMBED_CACHE_DIR = path.join(ROOT, 'data', 'life-archive', 'voiceprints', 'ecapa-embeddings');

const clips = [
  ['1', 'data/otter/audio/ofP6NpZUi5l83n9wEJCeyLiViMM/track-label-1-start-680.96-dur-17.92.wav'],
  ['2', 'data/otter/audio/3VWXJWhWSC-AiU1uToLSaRy56uo/track-label-14-start-4459.28-dur-30.00.wav'],
  ['3', 'data/otter/audio/3VWXJWhWSC-AiU1uToLSaRy56uo/track-label-7-start-1240.42-dur-30.00.wav'],
];

function sha16(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
}

function repoRel(file) {
  return path.relative(ROOT, path.resolve(ROOT, file)).replace(/\\/g, '/');
}

function cachePathFor(audioPath) {
  const abs = path.resolve(ROOT, audioPath);
  const stat = fs.statSync(abs);
  const statKey = `${stat.size}:${Math.round(stat.mtimeMs)}:${BACKEND}-max-${MAX_SECONDS}`;
  return path.join(EMBED_CACHE_DIR, `${sha16(`${repoRel(abs)}:${statKey}`)}.json`);
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

function loadEmbedding(audioPath) {
  const cachePath = cachePathFor(audioPath);
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  return {
    audio_path: audioPath,
    cache_path: repoRel(cachePath),
    vector: cached.embedding.vector,
    quality: cached.embedding.quality,
  };
}

const loaded = Object.fromEntries(clips.map(([id, audioPath]) => [id, loadEmbedding(audioPath)]));
const pairwise = {};
for (const [a, b] of [['1', '2'], ['1', '3'], ['2', '3']]) {
  pairwise[`${a}-${b}`] = Number(cosine(loaded[a].vector, loaded[b].vector).toFixed(6));
}

const oldThreshold = 0.62;
const minPairThreshold = 0.68;
const coreMatchesRequired = 3;

const clip3AgainstSeed = [pairwise['1-3'], pairwise['2-3']];
const clip3OldCentroidBridgeAccepted = pairwise['2-3'] >= oldThreshold;
const clip3CoreRuleAccepted =
  clip3AgainstSeed.length >= coreMatchesRequired
    ? clip3AgainstSeed.filter((score) => score >= minPairThreshold).length >= coreMatchesRequired
    : Math.min(...clip3AgainstSeed) >= minPairThreshold;

console.log(JSON.stringify({
  thresholds: {
    old_centroid_bridge_score: oldThreshold,
    new_min_pair_score: minPairThreshold,
    new_core_matches_required: coreMatchesRequired,
  },
  verdict: {
    clip_1_and_2_same_person_feedback: 'accepted by ExampleCo',
    clip_3_same_person_feedback: 'rejected by ExampleCo',
    old_rule_would_accept_clip_3_via_clip_2_bridge: clip3OldCentroidBridgeAccepted,
    new_core_rule_accepts_clip_3_into_seed_1_2: clip3CoreRuleAccepted,
    reason: 'With only two seed clips, a new clip must clear the min-pair threshold against both; clip 3 is below threshold against clip 1.',
  },
  clips: Object.fromEntries(Object.entries(loaded).map(([id, row]) => [id, {
    audio_path: row.audio_path,
    cache_path: row.cache_path,
    quality: row.quality,
  }])),
  pairwise,
}, null, 2));
