'use strict';

// scripts/lib/voice-save-carry-forward.js
//
// S-13 (owner decision): a voice Save names a call track. Reclustering can
// merge that track into another group after the click (a denial "not X" whose
// track later sat inside X's own person group), and the Save then failed until
// abandoned. The decision follows the track instead:
//   - a denial "not X" keeps the track out of X's group: the track is lifted
//     out of X's recluster group into its own unknown group, and the group's
//     name never derives onto it (apply-voice-cluster-resolutions);
//   - a confirmation on a group that no longer exists follows the reviewed
//     tracks (the group's members on the calls the owner reviewed) so the
//     resolution lands on the tracks wherever they now sit.
// Every write is idempotent: re-applying a Save adds no duplicate rows.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function equivalentTrackIds(value) {
  const id = String(value || '');
  const out = [id].filter(Boolean);
  const match = id.match(/^(?:speaker_|unknown_voice_track_)(\d+)$/i);
  if (match) out.push(`speaker_${match[1]}`, `unknown_voice_track_${match[1]}`);
  return [...new Set(out)];
}

function memberTrackIds(member = {}) {
  return [member.voice_cluster_id, ...(member.source_voice_cluster_ids || [])]
    .flatMap(equivalentTrackIds)
    .filter(Boolean);
}

function canonicalId(value) {
  return String(value || '').trim().toLowerCase();
}

// Every recluster group holding one of the tracks, with only the matching
// members.
function trackHolders(recluster, trackIds = []) {
  const wanted = new Set(trackIds.flatMap(equivalentTrackIds));
  const out = [];
  if (!wanted.size) return out;
  for (const cluster of recluster?.clusters || []) {
    const members = (cluster.members || []).filter((member) => memberTrackIds(member).some((id) => wanted.has(id)));
    if (members.length) {
      out.push({
        cluster_id: String(cluster.cluster_id || ''),
        confirmed_person_id: cluster.confirmed_person_id || null,
        frozen: Boolean(cluster.frozen),
        members,
      });
    }
  }
  return out;
}

// The groups that hold a denied track under the very person it was denied.
function holdersInDeniedGroup(recluster, trackIds, deniedPersonId) {
  const denied = canonicalId(deniedPersonId);
  if (!denied) return [];
  return trackHolders(recluster, trackIds).filter((holder) => {
    const groupPerson = canonicalId(holder.confirmed_person_id) || canonicalId(String(holder.cluster_id).replace(/^person:/, ''));
    return groupPerson === denied && (holder.confirmed_person_id || /^person:/.test(holder.cluster_id));
  });
}

function carriedClusterId(trackKey) {
  return `unknown_voice_carried_${crypto.createHash('sha1').update(String(trackKey)).digest('hex').slice(0, 16)}`;
}

function refreshClusterShape(cluster) {
  cluster.member_track_keys = (cluster.members || []).map((member) => member.track_key).filter(Boolean);
  cluster.otids = [...new Set((cluster.members || []).map((member) => member.otid).filter(Boolean))].sort();
  cluster.size = (cluster.members || []).length;
  cluster.centroid = [];
}

// Lifts each denied track out of the denied person's group into its own
// unknown group. Returns the moved track keys; a second call moves nothing.
function liftTracksOutOfDeniedGroup(recluster, trackIds, deniedPersonId) {
  const holders = holdersInDeniedGroup(recluster, trackIds, deniedPersonId);
  const moved = [];
  if (!holders.length) return moved;
  const byId = new Map((recluster.clusters || []).map((cluster) => [String(cluster.cluster_id || ''), cluster]));
  for (const holder of holders) {
    const group = byId.get(holder.cluster_id);
    if (!group) continue;
    const keys = new Set(holder.members.map((member) => member.track_key));
    group.members = (group.members || []).filter((member) => !keys.has(member.track_key));
    refreshClusterShape(group);
    for (const member of holder.members) {
      const id = carriedClusterId(member.track_key);
      let target = byId.get(id);
      if (!target) {
        target = {
          cluster_id: id,
          size: 0,
          frozen: false,
          confirmed_person_id: null,
          confirmed_display_name: null,
          reference_voiceprint_match: null,
          inherited_id: false,
          member_track_keys: [],
          members: [],
          otids: [],
          centroid: [],
          carried_from_cluster_id: holder.cluster_id,
          carried_denied_person_id: deniedPersonId,
        };
        recluster.clusters.push(target);
        byId.set(id, target);
      }
      if (!target.members.some((existing) => existing.track_key === member.track_key)) target.members.push(member);
      refreshClusterShape(target);
      moved.push(member.track_key);
    }
  }
  recluster.clusters = recluster.clusters.filter((cluster) => (cluster.members || []).length > 0);
  return moved;
}

// Adds a denial row for one track unless that track already holds one with the
// same review_action_key. Returns true when a row was added.
function upsertTrackDenial(registry, trackId, entry) {
  registry.voice_cluster_denials ||= {};
  const rows = (registry.voice_cluster_denials[trackId] ||= []);
  if (rows.some((row) => row?.review_action_key === entry.review_action_key)) return false;
  rows.push(entry);
  return true;
}

// Removes exact duplicates of one Save's rows (same key, same track, same
// type) that earlier non-idempotent runs left behind. Returns rows removed.
function dedupeSaveRows(registry, key) {
  let removed = 0;
  for (const [trackId, rows] of Object.entries(registry.voice_cluster_denials || {})) {
    if (!Array.isArray(rows)) continue;
    let seen = false;
    registry.voice_cluster_denials[trackId] = rows.filter((row) => {
      if (row?.review_action_key !== key) return true;
      if (seen) {
        removed += 1;
        return false;
      }
      seen = true;
      return true;
    });
  }
  const seenTypes = new Set();
  registry.manual_corrections = (registry.manual_corrections || []).filter((row) => {
    if (row?.review_action_key !== key) return true;
    const sig = `${row.type || ''}|${row.voice_cluster_id || ''}`;
    if (seenTypes.has(sig)) {
      removed += 1;
      return false;
    }
    seenTypes.add(sig);
    return true;
  });
  return removed;
}

// One durable record per Save key saying where its decision was carried.
function recordCarryForward(registry, key, record) {
  registry.voice_save_carry_forwards ||= {};
  const prior = registry.voice_save_carry_forwards[key];
  registry.voice_save_carry_forwards[key] = {
    ...record,
    first_carried_at: prior?.first_carried_at || record.carried_at,
  };
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(String(fs.readFileSync(file, 'utf8')).replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

// A confirmation on a group the current recluster no longer has: the tracks
// The owner reviewed are that group's members on his reviewed calls, read from the
// newest recluster snapshot that still holds the group. Track ids are stable,
// so the resolution follows them into whatever group holds them now.
function mergedGroupTrackIds(action = {}, { recluster = null, snapshotsDir = '', fsApi = fs } = {}) {
  const groupId = String(action.voiceClusterId || '');
  if (!groupId || /^speaker_\d+$/.test(groupId)) return [];
  if ((recluster?.clusters || []).some((cluster) => String(cluster.cluster_id) === groupId)) return [];
  const calls = new Set((action.otidsAtDecision || []).map(String));
  if (!calls.size || !snapshotsDir) return [];
  let names = [];
  try {
    names = fsApi.readdirSync(snapshotsDir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const ranked = names
    .map((name) => {
      try {
        return { file: path.join(snapshotsDir, name), mtimeMs: fsApi.statSync(path.join(snapshotsDir, name)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of ranked) {
    const snapshot = readJson(candidate.file, null);
    const group = snapshot?.clusters?.find((cluster) => String(cluster.cluster_id) === groupId);
    if (!group) continue;
    return [
      ...new Set(
        (group.members || [])
          .filter((member) => calls.has(String(member?.otid || '')))
          .map((member) => String(member.voice_cluster_id || ''))
          .filter((id) => /^speaker_\d+$/.test(id)),
      ),
    ];
  }
  return [];
}

module.exports = {
  equivalentTrackIds,
  trackHolders,
  holdersInDeniedGroup,
  liftTracksOutOfDeniedGroup,
  upsertTrackDenial,
  dedupeSaveRows,
  recordCarryForward,
  mergedGroupTrackIds,
  carriedClusterId,
};
