'use strict';

// Owner-confirmed track provenance for the recluster prune.
//
// The enriched speaker label carries no provenance, so an automatic voiceprint
// label looks exactly like ExampleCo's own decision. This module answers one
// question from owner evidence only: did ExampleCo himself identify THIS exact
// track (otid + speaker label) as a person? It never reads the enriched label
// and never matches names or aliases.
//
// Owner evidence, latest decision per track wins:
// - Dashboard Saves (voice-confirmation-actions.jsonl) that carry
//   otidsAtDecision. The tracks ExampleCo saw are the saved cluster's members in the
//   nearest recluster-runs snapshot taken BEFORE the Save, restricted to
//   otidsAtDecision. Saves without otidsAtDecision are unverified and ignored.
// - Owner direct corrections that name one exact otid + speakerModelLabel.
// - Registry voice_cluster_resolutions keyed by the track's source voice
//   cluster id, and acoustic_group_resolutions keyed by a recluster cluster id
//   (membership from the nearest earlier snapshot), with owner statuses only.
//   confirmed_reference_voiceprint_match is automatic and never counts.

const fs = require('node:fs');
const path = require('node:path');

const PERSON_ACTIONS = new Set(['confirm', 'correct', 'link_person_file', 'create_people_file']);
const NON_PERSON_ACTIONS = new Set(['not_them', 'dont_know', 'non_speech']);
const OWNER_PERSON_STATUS = 'confirmed_by_ExampleCo';
const OWNER_NON_PERSON_STATUSES = new Set(['left_unknown_by_ExampleCo', 'non_speech_by_ExampleCo']);
const CACHE_SCHEMA = 'voice_owner_decision_track_cache.v1';

function readJsonDefault(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function ownerPaths(dataDir) {
  const lifeArchive = path.join(dataDir, 'life-archive');
  return {
    actions: path.join(lifeArchive, 'people', 'voice-confirmation-actions.jsonl'),
    registry: path.join(lifeArchive, 'voice-identity-registry.json'),
    snapshotsDir: path.join(lifeArchive, 'voiceprints', 'recluster-runs'),
    cache: path.join(lifeArchive, 'voiceprints', 'owner-decision-track-cache.json'),
  };
}

// Compare instants, not strings: a timestamp with an offset sorts wrongly as text.
function tsMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

function trackKey(otid, label) {
  return `${String(otid || '')}|${String(label || '')}`;
}

function listSnapshots(snapshotsDir, fsImpl = fs) {
  let names = [];
  try {
    names = fsImpl.readdirSync(snapshotsDir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      try {
        return { file: path.join(snapshotsDir, name), mtimeMs: fsImpl.statSync(path.join(snapshotsDir, name)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function nearestSnapshotBefore(snapshots, isoTs) {
  const at = Date.parse(isoTs || '');
  if (!Number.isFinite(at)) return null;
  let best = null;
  for (const snapshot of snapshots) {
    if (snapshot.mtimeMs < at) best = snapshot;
    else break;
  }
  return best;
}

function clusterTracksAtDecision(snapshotJson, clusterId, otidFilter) {
  const cluster = (snapshotJson?.clusters || []).find(
    (row) => String(row?.cluster_id || '') === String(clusterId || ''),
  );
  if (!cluster) return [];
  const allow = otidFilter ? new Set(otidFilter.map(String)) : null;
  const tracks = [];
  for (const member of cluster.members || []) {
    const otid = String(member?.otid || '');
    const label = String(member?.speaker_model_label || '');
    if (!otid || !label) continue;
    if (allow && !allow.has(otid)) continue;
    tracks.push(trackKey(otid, label));
  }
  return [...new Set(tracks)].sort();
}

// The People file ExampleCo chose names the person; a new file created by the Save
// carries its id only in the file path.
function decisionPersonId(action) {
  const selected = String(action?.selectedPersonId || '').trim();
  if (selected) return selected;
  const file = String(action?.createdPeopleFile || action?.personFilePath || '').trim();
  const match = file.split('\\').join('/').match(/(?:^|\/)contacts\/([^/]+)\.md$/);
  return match ? match[1] : '';
}

// Build every owner decision as { ts, kind: 'person'|'non_person', personId,
// tracks | voiceClusterIds, source }. Snapshot-resolved track lists are cached
// by decision key because snapshots and past decisions are immutable.
function collectOwnerDecisions({ dataDir, readJsonFn = readJsonDefault, fsImpl = fs, useCache = true } = {}) {
  const paths = ownerPaths(dataDir);
  const actions = readJsonl(paths.actions);
  const registry = readJsonFn(paths.registry, {}) || {};
  const cache = (useCache && readJsonFn(paths.cache, null)) || { schema: CACHE_SCHEMA, decisions: {} };
  if (cache.schema !== CACHE_SCHEMA || typeof cache.decisions !== 'object') {
    cache.schema = CACHE_SCHEMA;
    cache.decisions = {};
  }
  let cacheDirty = false;
  let snapshots = null;
  const snapshotCache = new Map();
  const tracksFromSnapshot = (cacheKey, ts, clusterId, otidFilter) => {
    if (Array.isArray(cache.decisions[cacheKey])) return cache.decisions[cacheKey];
    if (!snapshots) snapshots = listSnapshots(paths.snapshotsDir, fsImpl);
    const snapshot = nearestSnapshotBefore(snapshots, ts);
    if (!snapshot) return null;
    if (!snapshotCache.has(snapshot.file)) {
      // Hold at most two parsed snapshots. Actions and group resolutions are
      // each walked in time order, so two slots keep both passes from
      // thrashing; resolved track lists are also cached on disk.
      if (snapshotCache.size >= 2) snapshotCache.delete(snapshotCache.keys().next().value);
      snapshotCache.set(snapshot.file, readJsonFn(snapshot.file, null));
    }
    const json = snapshotCache.get(snapshot.file);
    if (!json) return null;
    // mtime only selects the candidate; the snapshot's own generated_at must
    // also precede the decision, or the membership is not what ExampleCo saw.
    const generatedAt = Date.parse(json.generated_at || '');
    if (Number.isFinite(generatedAt) && generatedAt >= Date.parse(ts)) return null;
    const tracks = clusterTracksAtDecision(json, clusterId, otidFilter);
    cache.decisions[cacheKey] = tracks;
    cacheDirty = true;
    return tracks;
  };

  const decisions = [];
  const ordered = [...actions].sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
  for (const action of ordered) {
    const kind = PERSON_ACTIONS.has(action.action)
      ? 'person'
      : NON_PERSON_ACTIONS.has(action.action)
        ? 'non_person'
        : '';
    if (!kind) continue;
    const personId = kind === 'person' ? decisionPersonId(action) : '';
    if (kind === 'person' && !personId) continue;
    const ts = String(action.ts || '');
    // Exact single-track owner correction.
    if (action.otid && action.speakerModelLabel) {
      decisions.push({
        ts,
        kind,
        personId,
        tracks: [trackKey(action.otid, action.speakerModelLabel)],
        source: `action:${action.action}:exact_track`,
      });
      continue;
    }
    if (!Array.isArray(action.otidsAtDecision) || !action.otidsAtDecision.length) continue;
    if (!action.voiceClusterId) continue;
    const cacheKey = `action|${ts}|${action.voiceClusterId}`;
    const tracks = tracksFromSnapshot(cacheKey, ts, action.voiceClusterId, action.otidsAtDecision);
    if (!tracks || !tracks.length) continue;
    decisions.push({ ts, kind, personId, tracks, source: `action:${action.action}:cluster_at_decision` });
  }

  for (const [voiceClusterId, row] of Object.entries(registry.voice_cluster_resolutions || {})) {
    const status = String(row?.status || '');
    const kind =
      status === OWNER_PERSON_STATUS ? 'person' : OWNER_NON_PERSON_STATUSES.has(status) ? 'non_person' : '';
    if (!kind) continue;
    const personId = kind === 'person' ? String(row?.person_id || '').trim() : '';
    if (kind === 'person' && !personId) continue;
    decisions.push({
      ts: String(row?.updated_at || ''),
      kind,
      personId,
      voiceClusterIds: [voiceClusterId],
      source: `registry:voice_cluster_resolutions:${status}`,
    });
  }

  const groupRows = Object.entries(registry.acoustic_group_resolutions || {}).sort(
    (a, b) => tsMs(a[1]?.updated_at) - tsMs(b[1]?.updated_at),
  );
  for (const [groupId, row] of groupRows) {
    const status = String(row?.status || '');
    const kind =
      status === OWNER_PERSON_STATUS ? 'person' : OWNER_NON_PERSON_STATUSES.has(status) ? 'non_person' : '';
    if (!kind) continue;
    const personId = kind === 'person' ? String(row?.person_id || '').trim() : '';
    if (kind === 'person' && !personId) continue;
    const ts = String(row?.updated_at || '');
    const tracks = tracksFromSnapshot(`group|${ts}|${groupId}`, ts, groupId, null);
    if (!tracks || !tracks.length) continue;
    decisions.push({ ts, kind, personId, tracks, source: `registry:acoustic_group_resolutions:${status}` });
  }

  if (useCache && cacheDirty) {
    try {
      const tmp = `${paths.cache}.${process.pid}.tmp`;
      fs.mkdirSync(path.dirname(paths.cache), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(cache)}\n`);
      fs.renameSync(tmp, paths.cache);
    } catch {
      // The cache is an optimization; a failed write only costs a re-read.
    }
  }
  return decisions;
}

// Returns { lookup(member) -> { personId, source, ts } | null } where a hit
// means ExampleCo's latest decision on that exact track identifies a person.
function buildOwnerConfirmedTrackIndex(options = {}) {
  const decisions = collectOwnerDecisions(options);
  const byTrack = new Map();
  const byVoiceCluster = new Map();
  const keep = (map, key, decision) => {
    const prior = map.get(key);
    if (!prior || tsMs(decision.ts) >= tsMs(prior.ts)) map.set(key, decision);
  };
  for (const decision of decisions) {
    for (const key of decision.tracks || []) keep(byTrack, key, decision);
    for (const id of decision.voiceClusterIds || []) keep(byVoiceCluster, id, decision);
  }
  const lookup = (member) => {
    const otid = String(member?.otid || '');
    const label = String(member?.speaker_model_label || '');
    if (!otid || !label) return null;
    const candidates = [];
    const exact = byTrack.get(trackKey(otid, label));
    if (exact) candidates.push(exact);
    const voiceIds = [member?.voice_cluster_id, ...(member?.source_voice_cluster_ids || [])].filter(Boolean);
    for (const id of new Set(voiceIds)) {
      const hit = byVoiceCluster.get(String(id));
      if (hit) candidates.push(hit);
    }
    if (!candidates.length) return null;
    const latest = candidates.reduce((best, row) => (tsMs(row.ts) >= tsMs(best.ts) ? row : best));
    if (latest.kind !== 'person') return null;
    return { personId: latest.personId, source: latest.source, ts: latest.ts };
  };
  return { lookup, decisionCount: decisions.length };
}

module.exports = {
  decisionPersonId,
  buildOwnerConfirmedTrackIndex,
  clusterTracksAtDecision,
  collectOwnerDecisions,
  nearestSnapshotBefore,
  ownerPaths,
};
