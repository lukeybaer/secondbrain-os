#!/usr/bin/env node
/**
 * Nightly GLOBAL re-clustering of ExampleCo voice embeddings with stability
 * discipline (Phase B3 / item 8 of dev-plans/voiceprint-matching-audit-2026-07-11.html,
 * Codex amendment 10).
 *
 * Replaces the resolver's greedy, order-dependent, batch-scoped ExampleCo
 * grouping with a full-corpus agglomerative pass:
 *
 * - Complete-linkage agglomerative clustering on cosine similarity. A merge
 *   requires BOTH the centroid similarity >= --threshold (default 0.62, the
 *   resolver's ExampleCo_CLUSTER_SCORE semantics) AND the complete-linkage
 *   minimum cross-pair similarity >= --pair-floor (default 0.68, the
 *   resolver's ExampleCo_CLUSTER_MIN_PAIR_SCORE semantics).
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
 *   ExampleCo_voice_ecapa_<sha16 of the sorted member seed>, consistent with
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

const REPO = path.resolve(__dirname, '..');
const SPEAKER_BACKEND = String(process.env.VOICE_SPEAKER_BACKEND || 'ecapa').toLowerCase();

const DEFAULTS = {
  threshold: Number(
    process.env.SPEAKER_ExampleCo_CLUSTER_SCORE || process.env.ECAPA_ExampleCo_CLUSTER_SCORE || '0.62',
  ),
  pairFloor: Number(
    process.env.SPEAKER_ExampleCo_CLUSTER_MIN_PAIR_SCORE ||
      process.env.ECAPA_ExampleCo_CLUSTER_MIN_PAIR_SCORE ||
      '0.68',
  ),
  frozenThreshold: Number(process.env.VOICE_RECLUSTER_FROZEN_THRESHOLD || '0.70'),
  sameCallGate: Number(
    process.env.SPEAKER_ExampleCo_CLUSTER_SAME_CALL_DIFFERENT_LABEL_SCORE ||
      process.env.ECAPA_ExampleCo_CLUSTER_SAME_CALL_DIFFERENT_LABEL_SCORE ||
      '0.82',
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
    probeIndex:
      process.env.OTTER_TRACK_PROBE_INDEX_PATH || path.join(vpDir, 'track-probe-index-latest.json'),
    reviewQueue: path.join(vpDir, 'voice-review-queue.json'),
    embedCacheDir: path.join(vpDir, `${SPEAKER_BACKEND}-embeddings`),
    runsDir: path.join(vpDir, 'recluster-runs'),
    latest: path.join(vpDir, 'recluster-latest.json'),
  };
}

function normPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

// Same discovery approach as the resolver's candidateRows(): the track probe
// index plus the shared review queue, deduped by otid|label|voice_cluster_id.
function discoverTrackRows(paths) {
  const index = readJson(paths.probeIndex, {});
  const probeRows = (index.probes || []).map((row) => ({
    source: 'track-probe-index',
    otid: row.otid,
    title: row.title,
    speaker_model_label: String(row.speaker_model_label || ''),
    voice_cluster_id: row.voice_cluster_id || row.ExampleCo_speaker_id || '',
    probe_audio_path: row.probe_audio_path || '',
  }));
  const queue = readJson(paths.reviewQueue, {});
  const queueRows = (Array.isArray(queue.items) ? queue.items : []).map((row) => ({
    source: 'voice-review-queue',
    otid: row.otid,
    title: row.title,
    speaker_model_label: String(row.speaker_model_label || ''),
    voice_cluster_id:
      row.voice_cluster_id || row.canonical_speaker_id || row.ExampleCo_speaker_id || '',
    probe_audio_path: row.probe_audio_path || '',
  }));
  const seen = new Set();
  const out = [];
  for (const row of [...probeRows, ...queueRows]) {
    const key = `${row.otid}|${row.speaker_model_label}|${row.voice_cluster_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...row, track_key: key });
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
  }
  return index;
}

function lookupEmbedding(index, probeAudioPath, paths) {
  const candidates = [normPath(probeAudioPath)];
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
  if (!voiceClusterId) return null;
  const resolution = registry.voice_cluster_resolutions?.[voiceClusterId];
  if (resolution?.status === 'confirmed_by_ExampleCo' && resolution.person_id) {
    return { person_id: resolution.person_id, display_name: resolution.display_name || '' };
  }
  const acoustic = registry.acoustic_group_resolutions?.[voiceClusterId];
  if (acoustic?.status === 'confirmed_by_ExampleCo' && acoustic.person_id) {
    return { person_id: acoustic.person_id, display_name: acoustic.display_name || '' };
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

// The durable id a human confirmation attached to (voice-acoustic-group-confirm
// writes acoustic_group_resolutions keyed by the reviewed acoustic id). Sorted
// key pick keeps it deterministic if one person ExampleCos several confirmations.
function registryAcousticIdFor(registry, personId) {
  const entries = Object.entries(registry.acoustic_group_resolutions || {})
    .filter(([, value]) => value?.status === 'confirmed_by_ExampleCo' && value.person_id === personId)
    .map(([key]) => key)
    .sort();
  return entries[0] || '';
}

function buildItems(rows, embeddingIndex, registry, paths) {
  const items = [];
  let missingEmbedding = 0;
  let withoutProbe = 0;
  for (const row of rows) {
    if (!row.probe_audio_path) {
      withoutProbe += 1;
      continue;
    }
    const hit = lookupEmbedding(embeddingIndex, row.probe_audio_path, paths);
    if (!hit) {
      missingEmbedding += 1;
      continue;
    }
    const confirmed = confirmedPersonFor(registry, row.voice_cluster_id);
    items.push({
      key: row.track_key,
      otid: row.otid,
      label: row.speaker_model_label,
      voiceClusterId: row.voice_cluster_id,
      probeAudioPath: row.probe_audio_path,
      vector: hit.vector,
      confirmedPersonId: confirmed?.person_id || null,
      confirmedDisplayName: confirmed?.display_name || '',
      denied: deniedPeopleFor(registry, row.voice_cluster_id),
    });
  }
  return { items, missingEmbedding, withoutProbe };
}

function mintClusterId(members) {
  const seed = members
    .map((m) => m.key)
    .sort()
    .join('\n');
  return `ExampleCo_voice_${SPEAKER_BACKEND}_${sha16(seed)}`;
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
      if (!slot.displayName && item.confirmedDisplayName) slot.displayName = item.confirmedDisplayName;
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
    const pairBar = frozenInvolved ? Math.max(opts.pairFloor, opts.frozenThreshold) : opts.pairFloor;
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
    prevInfo.set(prev.cluster_id, {
      keys,
      confirmedPersonId: prev.confirmed_person_id || null,
    });
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
        (overlap === bestOverlap && overlap > 0 && bestIdx >= 0 && clusterTieKey(clusters[idx]) < clusterTieKey(clusters[bestIdx]))
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
        ...restored.map((r) => ({ target: r.members, centroid: meanVector(r.members.map((m) => m.vector)) })),
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
        cluster_id: frozenClusterId(cluster, primaryId, registry),
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
        id: frozenClusterId(cluster, primaryId, registry),
        members: primaryMembers,
        frozen: cluster.frozen,
        personId: cluster.personId,
        displayName: cluster.displayName,
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
      id = inherited[0];
      inheritedFlag = true;
    }
    if (cluster.frozen) {
      // A human-confirmed cluster keeps its confirmed identity and durable id
      // regardless of overlap arithmetic.
      id = frozenClusterId(cluster, id, registry);
      inheritedFlag = true;
    }
    if (!id) id = mintClusterId(cluster.members);
    finalClusters.push({
      id,
      members: cluster.members,
      frozen: cluster.frozen,
      personId: cluster.personId,
      displayName: cluster.displayName,
      inherited: inheritedFlag,
    });
  });

  // Split ledger: a previous cluster whose (present) members now span multiple
  // final clusters. Splits touching a confirmed cluster are review_required;
  // the confirmed cluster itself keeps its id and identity either way.
  const keyToFinal = new Map();
  for (const cluster of finalClusters) for (const m of cluster.members) keyToFinal.set(m.key, cluster.id);
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

function frozenClusterId(cluster, inheritedId, registry) {
  const registryId = cluster.personId ? registryAcousticIdFor(registry, cluster.personId) : '';
  return registryId || inheritedId || mintClusterId(cluster.members);
}

// Run id from the input set hash (tracks, vectors, constraints, thresholds),
// never from Date.now alone: identical inputs re-produce the same artifact.
function deriveRunId(items, opts) {
  const lines = items
    .map(
      (item) =>
        `${item.key}|${sha16(item.vector.map((v) => Number(v).toFixed(6)).join(','))}|${item.confirmedPersonId || ''}|${[...item.denied].sort().join(',')}`,
    )
    .sort();
  lines.push(
    `thresholds:${opts.threshold}:${opts.pairFloor}:${opts.frozenThreshold}:${opts.sameCallGate}`,
  );
  return sha16(lines.join('\n'));
}

function runRecluster(options = {}) {
  const opts = {
    threshold: options.threshold ?? DEFAULTS.threshold,
    pairFloor: options.pairFloor ?? DEFAULTS.pairFloor,
    frozenThreshold: options.frozenThreshold ?? DEFAULTS.frozenThreshold,
    sameCallGate: options.sameCallGate ?? DEFAULTS.sameCallGate,
    maxEmbeddings: options.maxEmbeddings ?? DEFAULTS.maxEmbeddings,
  };
  const paths = resolvePaths(options.dataDir);
  const registry = readJson(paths.registry, {});
  const rows = discoverTrackRows(paths);
  const embeddingIndex = loadEmbeddingIndex(paths.embedCacheDir);
  const { items, missingEmbedding, withoutProbe } = buildItems(rows, embeddingIndex, registry, paths);
  if (items.length > opts.maxEmbeddings) {
    throw new Error(
      `voice-global-recluster: ${items.length} embeddings exceed the --max-embeddings cap of ${opts.maxEmbeddings}. ` +
        'This job never silently samples; raise --max-embeddings deliberately if the corpus really is that large.',
    );
  }
  const previousRun = options.previousRunPath
    ? readJson(options.previousRunPath, null)
    : readJson(paths.latest, null);
  const { clusters, blocks, blockCount } = clusterItems(items, opts);
  const { finalClusters, merges, splits } = applyStability(clusters, previousRun, registry);
  const runId = options.runId || deriveRunId(items, opts);

  const clusterRows = finalClusters
    .map((cluster) => ({
      cluster_id: cluster.id,
      size: cluster.members.length,
      frozen: Boolean(cluster.frozen),
      confirmed_person_id: cluster.personId || null,
      confirmed_display_name: cluster.displayName || null,
      inherited_id: Boolean(cluster.inherited),
      member_track_keys: cluster.members.map((m) => m.key).sort(),
      members: cluster.members
        .map((m) => ({
          track_key: m.key,
          otid: m.otid,
          speaker_model_label: m.label,
          voice_cluster_id: m.voiceClusterId,
          probe_audio_path: m.probeAudioPath,
        }))
        .sort((x, y) => (x.track_key < y.track_key ? -1 : 1)),
      otids: [...new Set(cluster.members.map((m) => m.otid))].sort(),
      centroid: meanVector(cluster.members.map((m) => m.vector)).map((v) => Number(v.toFixed(6))),
    }))
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
      max_embeddings: opts.maxEmbeddings,
    },
    inputs: {
      probe_index: paths.probeIndex,
      review_queue: paths.reviewQueue,
      registry: paths.registry,
      embedding_cache_dir: paths.embedCacheDir,
      previous_run_path: options.previousRunPath || paths.latest,
      track_rows_seen: rows.length,
      tracks_clustered: items.length,
      tracks_missing_embedding: missingEmbedding,
      tracks_without_probe: withoutProbe,
      confirmed_tracks: items.filter((item) => item.confirmedPersonId).length,
      unconfirmed_tracks: items.filter((item) => !item.confirmedPersonId).length,
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
    },
    clusters: clusterRows,
    ledger: {
      merges,
      splits,
      cannot_link_blocks: blocks,
    },
  };

  if (options.write) {
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
  buildItems,
  clusterItems,
  applyStability,
  deriveRunId,
  mintClusterId,
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
