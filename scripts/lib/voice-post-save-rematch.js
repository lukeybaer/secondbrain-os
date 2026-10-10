'use strict';

// Post-Save voiceprint re-match scoring.
//
// After ExampleCo saves one voice cluster as a person, other unknown clusters of the
// same voice stay split until the global rebuild. This module scores every
// unknown cluster against that person's confirmed members and classifies each
// as an auto-attach (only when an explicit, back-tested gate is enabled), a
// provisional proposal for ExampleCo's review, or nothing. The same code runs the
// historical back-test and the live worker, so the gate that was measured is
// the gate that ships.

const PAIR_FLOOR = 0.68;
const PROPOSAL_CENTROID_FLOOR = 0.65;
const DEFAULT_MAX_PERSON_MEMBERS = 400;

// People File picker preselect gate for a proposal (ExampleCo, 2026-10-06: "you know
// who it is but still you don't auto-select him"). A preselect is only the
// picker default; ExampleCo's Save stays the sole authority. Back-test 2026-10-06 on
// EC2 (74 confirmed people in recluster-latest, held-out calls scored against
// every person centroid, plus a stranger case with the true person removed):
// with probes of 2 or 3 calls, centroid >= 0.78 and a 0.10 lead over the next
// closest person picked the wrong person zero times in 2,568 known trials and
// zero times in 2,568 stranger trials, except PRIVATE_NAME vs PRIVATE_NAME (two
// files for one human). Recall was 96.6 percent (2 calls) and 99.6 percent
// (3 calls). Single-call probes produced real errors, so one call never
// preselects.
const PRESELECT_GATE = Object.freeze({ centroid: 0.78, margin: 0.1, minCalls: 2 });

function norm(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  const denom = norm(a) * norm(b);
  return denom ? dot / denom : 0;
}

function meanVector(vectors) {
  const rows = (vectors || []).filter((vector) => vector?.length);
  if (!rows.length) return [];
  const out = new Array(rows[0].length).fill(0);
  for (const vector of rows) {
    // Unit-normalize first so a loud clip cannot dominate the centroid.
    const length = norm(vector) || 1;
    for (let i = 0; i < out.length; i += 1) out[i] += vector[i] / length;
  }
  return out.map((value) => value / rows.length);
}

function scoreClusterAgainstPerson({ clusterVectors, personVectors, pairFloor = PAIR_FLOOR }) {
  const cluster = (clusterVectors || []).filter((vector) => vector?.length);
  const person = (personVectors || []).filter((vector) => vector?.length);
  if (!cluster.length || !person.length) return null;
  const centroid = cosine(meanVector(cluster), meanVector(person));
  let pairs = 0;
  let above = 0;
  let minPair = Infinity;
  for (const a of cluster) {
    for (const b of person) {
      const score = cosine(a, b);
      pairs += 1;
      if (score >= pairFloor) above += 1;
      if (score < minPair) minPair = score;
    }
  }
  return {
    centroid: Number(centroid.toFixed(4)),
    share: Number((above / pairs).toFixed(4)),
    min_pair: Number(minPair.toFixed(4)),
    pairs,
  };
}

// gate: { centroid, share, min_pair } or null. A null gate disables
// auto-attach entirely; near misses still become proposals.
function classifyScore(score, gate) {
  if (!score) return null;
  if (
    gate &&
    score.centroid >= gate.centroid &&
    score.share >= gate.share &&
    score.min_pair >= gate.min_pair
  ) {
    return 'attach';
  }
  if (score.centroid >= PROPOSAL_CENTROID_FLOOR) return 'propose';
  return null;
}

function isPersonCluster(cluster) {
  return Boolean(
    cluster?.frozen ||
      cluster?.confirmed_person_id ||
      /^person:/.test(String(cluster?.cluster_id || '')),
  );
}

function clusterPersonId(cluster) {
  return (
    String(cluster?.confirmed_person_id || '').trim() ||
    String(cluster?.cluster_id || '').match(/^person:(.+)$/)?.[1] ||
    ''
  );
}

function memberAudioPath(member) {
  return (
    member?.probe_audio_path ||
    (member?.source_probe_audio_paths || []).find(Boolean) ||
    ''
  );
}

// Deterministic, spread-out subsample so a person with 1,600 confirmed clips
// cannot blow the time budget.
function subsample(rows, max) {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  const out = [];
  for (let i = 0; i < max; i += 1) out.push(rows[Math.floor(i * step)]);
  return out;
}

// recluster: a recluster artifact (latest or a historical snapshot).
// personId: canonical person id just enrolled.
// savedClusterId: the cluster ExampleCo saved (its members count as confirmed).
// savedOtids: optional otidsAtDecision restriction for the saved cluster.
// vectorFor(member) -> number[] | null.
// canonical(id) -> canonical person id.
function rematchCandidates({
  recluster,
  personId,
  savedClusterId,
  savedOtids = null,
  vectorFor,
  gate = null,
  canonical = (id) => String(id || ''),
  maxPersonMembers = DEFAULT_MAX_PERSON_MEMBERS,
  minCentroidToReport = PROPOSAL_CENTROID_FLOOR,
  deadline = Infinity,
  now = () => Date.now(),
}) {
  const target = canonical(personId);
  const clusters = recluster?.clusters || [];
  const allowedSaved = savedOtids ? new Set(savedOtids.map(String)) : null;
  const personMembers = [];
  const seenPersonAudio = new Set();
  for (const cluster of clusters) {
    const isSaved = String(cluster?.cluster_id || '') === String(savedClusterId || '');
    const isPerson = isPersonCluster(cluster) && canonical(clusterPersonId(cluster)) === target;
    if (!isSaved && !isPerson) continue;
    for (const member of cluster.members || []) {
      if (isSaved && allowedSaved && !allowedSaved.has(String(member?.otid || ''))) continue;
      // A saved member can also sit in the frozen person cluster; count it once.
      const key = memberAudioPath(member) || member?.track_key || '';
      if (key && seenPersonAudio.has(key)) continue;
      if (key) seenPersonAudio.add(key);
      personMembers.push(member);
    }
  }
  const personVectors = subsample(
    personMembers.map((member) => vectorFor(member)).filter((vector) => vector?.length),
    maxPersonMembers,
  );
  if (!personVectors.length) return { timedOut: false, personVectorCount: 0, rows: [] };
  const personCentroid = meanVector(personVectors);
  // Every other confirmed person's centroid, so each proposal records how far
  // it leads the next closest person (the preselect gate's margin).
  const otherVectors = new Map();
  for (const cluster of clusters) {
    if (!isPersonCluster(cluster)) continue;
    const other = canonical(clusterPersonId(cluster));
    if (!other || other === target) continue;
    const list = otherVectors.get(other) || [];
    for (const member of cluster.members || []) {
      const vector = vectorFor(member);
      if (vector?.length) list.push(vector);
    }
    otherVectors.set(other, list);
  }
  const otherCentroids = [];
  for (const [other, vectors] of otherVectors) {
    if (vectors.length) otherCentroids.push([other, meanVector(subsample(vectors, maxPersonMembers))]);
  }
  const rows = [];
  for (const cluster of clusters) {
    if (now() > deadline) return { timedOut: true, personVectorCount: personVectors.length, rows };
    if (isPersonCluster(cluster)) continue;
    if (String(cluster?.cluster_id || '') === String(savedClusterId || '')) continue;
    const clusterVectors = (cluster.members || [])
      .map((member) => vectorFor(member))
      .filter((vector) => vector?.length);
    if (!clusterVectors.length) continue;
    // Cheap centroid prefilter before the quadratic pair scan.
    if (cosine(meanVector(clusterVectors), personCentroid) < minCentroidToReport) continue;
    const score = scoreClusterAgainstPerson({ clusterVectors, personVectors });
    if (!score || score.centroid < minCentroidToReport) continue;
    const clusterCentroid = meanVector(clusterVectors);
    let runnerUp = null;
    for (const [other, centroid] of otherCentroids) {
      const value = cosine(clusterCentroid, centroid);
      if (!runnerUp || value > runnerUp.centroid) runnerUp = { person_id: other, centroid: value };
    }
    const callCount = new Set(
      (cluster.members || []).map((member) => String(member?.otid || '')).filter(Boolean),
    ).size;
    rows.push({
      cluster_id: String(cluster.cluster_id),
      person_id: target,
      ...score,
      runner_up_person_id: runnerUp ? runnerUp.person_id : '',
      runner_up_centroid: runnerUp ? Number(runnerUp.centroid.toFixed(4)) : null,
      call_count: callCount,
      decision: classifyScore(score, gate),
    });
  }
  rows.sort((a, b) => b.centroid - a.centroid);
  return { timedOut: false, personVectorCount: personVectors.length, rows };
}

// ---- Provisional proposals -------------------------------------------------
// A proposal is a review hint only. It never writes the registry, never links
// a People file, and expires when its cluster is resolved or after 30 days.

const PROPOSALS_SCHEMA = 'voice_post_save_rematch_proposals.v1';
const PROPOSAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PROPOSAL_SOURCE = 'post_save_voiceprint_rematch';

function proposalsPath(dataRoot) {
  return require('node:path').join(
    dataRoot,
    'life-archive',
    'voiceprints',
    'post-save-rematch-proposals.json',
  );
}

function readProposals(file, fsImpl = require('node:fs')) {
  try {
    const json = JSON.parse(fsImpl.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(json?.proposals) ? json.proposals : [];
  } catch {
    return [];
  }
}

function isExpired(proposal, nowMs) {
  const at = Date.parse(proposal?.proposed_at || '');
  return !Number.isFinite(at) || nowMs - at > PROPOSAL_TTL_MS;
}

// resolvedClusterIds: cluster ids with any registry resolution.
// latestActionAtByCluster: Map cluster id -> ISO ts of ExampleCo's latest action on
// it; an action at or after the proposal resolves it.
function activeProposals(
  proposals,
  { resolvedClusterIds = new Set(), latestActionAtByCluster = new Map(), nowMs = Date.now() } = {},
) {
  return (proposals || []).filter((row) => {
    if (!row?.cluster_id || !row?.person_id) return false;
    const clusterId = String(row.cluster_id);
    if (resolvedClusterIds.has(clusterId)) return false;
    const actedAt = Date.parse(latestActionAtByCluster.get(clusterId) || '');
    const proposedAt = Date.parse(row.proposed_at || '');
    if (Number.isFinite(actedAt) && (!Number.isFinite(proposedAt) || actedAt >= proposedAt)) return false;
    return !isExpired(row, nowMs);
  });
}

// Proposals are keyed by recluster cluster id (unknown_voice_ecapa_*), which is
// the acoustic_group_resolutions namespace; voice_cluster_resolutions is keyed
// by per-call source voice ids and cannot resolve a recluster cluster.
// "Left unknown" is not a final answer: it means no named person fit at the
// time. A later Save that names a close sibling is new evidence, so it only
// retires proposals made before that decision instead of blocking all hints.
const REOPENABLE_RESOLUTION_STATUSES = new Set(['left_unknown_by_ExampleCo']);

function resolutionStateFor(registry, actionRows) {
  const resolvedClusterIds = new Set();
  const latestActionAtByCluster = new Map();
  const noteAction = (id, ts) => {
    if (!id || !ts) return;
    const prior = Date.parse(latestActionAtByCluster.get(id) || '');
    if (!Number.isFinite(prior) || Date.parse(ts) > prior) latestActionAtByCluster.set(id, ts);
  };
  for (const [id, resolution] of Object.entries(registry?.acoustic_group_resolutions || {})) {
    if (REOPENABLE_RESOLUTION_STATUSES.has(String(resolution?.status || ''))) {
      noteAction(id, String(resolution?.updated_at || ''));
    } else {
      resolvedClusterIds.add(id);
    }
  }
  for (const row of actionRows || []) {
    noteAction(String(row?.voiceClusterId || ''), String(row?.ts || ''));
  }
  return { resolvedClusterIds, latestActionAtByCluster };
}

// One proposal per (cluster, person); the newest score wins.
function mergeProposals(existing, incoming, options = {}) {
  const byKey = new Map();
  for (const row of activeProposals([...(existing || []), ...(incoming || [])], options)) {
    byKey.set(`${row.cluster_id}|${row.person_id}`, row);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      String(a.cluster_id).localeCompare(String(b.cluster_id)) ||
      Number(b.centroid || 0) - Number(a.centroid || 0),
  );
}

function writeProposalsAtomic(file, proposals, fsImpl = require('node:fs')) {
  const pathMod = require('node:path');
  fsImpl.mkdirSync(pathMod.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(
    tmp,
    `${JSON.stringify({ schema: PROPOSALS_SCHEMA, updated_at: new Date().toISOString(), proposals }, null, 2)}\n`,
  );
  fsImpl.renameSync(tmp, file);
}

function hasStrongerHypothesis(item) {
  const hypothesis = item?.current_identity_hypothesis || item?.guess || null;
  return Boolean(
    hypothesis && (String(hypothesis.person_id || '').trim() || String(hypothesis.display_name || '').trim()),
  );
}

// Decide whether a proposal may preselect its People File in the picker.
// `rivalCentroid` is the best score any OTHER proposed person has on the same
// cluster; it counts as a runner-up alongside the recorded one.
// Accepts a stored proposal (`centroid`) or the card hypothesis built from it (`score`).
// Fails closed: every input must be a real finite number, and a proposal with
// no other confirmed person to compare against never preselects.
function preselectVerdict(proposal, rivalCentroid = 0) {
  const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
  const centroid = proposal?.centroid ?? proposal?.score;
  const calls = proposal?.call_count;
  const runnerUpCentroid = proposal?.runner_up_centroid;
  if (!isNum(centroid) || !isNum(calls) || !isNum(rivalCentroid)) {
    return { eligible: false, reason: 'its voice match scores are incomplete' };
  }
  if (!isNum(runnerUpCentroid)) {
    return { eligible: false, reason: 'no next-closest-person check was recorded' };
  }
  const runnerUp = Math.max(runnerUpCentroid, rivalCentroid);
  const margin = Number((centroid - runnerUp).toFixed(4));
  if (calls < PRESELECT_GATE.minCalls) {
    return { eligible: false, margin, reason: 'heard on only one call' };
  }
  if (centroid < PRESELECT_GATE.centroid) {
    return {
      eligible: false,
      margin,
      reason: `voice match ${centroid.toFixed(2)} is below the ${PRESELECT_GATE.centroid.toFixed(2)} preselect bar`,
    };
  }
  if (margin < PRESELECT_GATE.margin) {
    return {
      eligible: false,
      margin,
      reason: `another person scores within ${margin.toFixed(2)} of this match`,
    };
  }
  return { eligible: true, margin, reason: '' };
}

// Surface the best active proposal for this cluster as a provisional
// hypothesis, only when nothing stronger already names the voice.
function applyProposalHypothesis(item, proposalsByCluster, displayNameFor = (id) => id) {
  // A preselected People file is also stronger than a voiceprint near miss.
  if (!item || hasStrongerHypothesis(item) || item.people_file_id) return item;
  const clusterId = String(item.acoustic_unknown_id || item.voice_cluster_id || '');
  const candidates = proposalsByCluster.get(clusterId) || [];
  if (!candidates.length) return item;
  const best = [...candidates].sort((a, b) => Number(b.centroid || 0) - Number(a.centroid || 0))[0];
  const rivalCentroid = Math.max(
    0,
    ...candidates
      .filter((row) => String(row.person_id) !== String(best.person_id))
      .map((row) => (typeof row.centroid === 'number' ? row.centroid : Number.NaN)),
  );
  const verdict = preselectVerdict(best, rivalCentroid);
  const hypothesis = {
    display_name: displayNameFor(best.person_id),
    person_id: best.person_id,
    confidence: 'provisional_post_save_voiceprint_rematch',
    score: best.centroid,
    share: best.share,
    min_pair: best.min_pair,
    // Raw values, not coerced: the server recomputes the gate from these and
    // must see a malformed field as malformed.
    call_count: best.call_count,
    runner_up_person_id: best.runner_up_person_id || '',
    runner_up_centroid: best.runner_up_centroid,
    rival_centroid: rivalCentroid,
    margin: verdict.margin ?? null,
    preselect_eligible: verdict.eligible,
    preselect_blocked_reason: verdict.reason,
    source: PROPOSAL_SOURCE,
    source_save_request_id: best.source_save_request_id || '',
    proposed_at: best.proposed_at || '',
    warning: 'review only; no people-file link is banked',
    is_provisional: true,
  };
  return {
    ...item,
    guess: hypothesis,
    current_identity_hypothesis: hypothesis,
    people_file_id: null,
    suggested_action: item.suggested_action || 'review_then_confirm_or_link',
  };
}

module.exports = {
  PRESELECT_GATE,
  PROPOSALS_SCHEMA,
  PROPOSAL_SOURCE,
  PROPOSAL_TTL_MS,
  activeProposals,
  applyProposalHypothesis,
  mergeProposals,
  preselectVerdict,
  proposalsPath,
  resolutionStateFor,
  readProposals,
  writeProposalsAtomic,
  PAIR_FLOOR,
  PROPOSAL_CENTROID_FLOOR,
  classifyScore,
  cosine,
  memberAudioPath,
  meanVector,
  rematchCandidates,
  scoreClusterAgainstPerson,
};
