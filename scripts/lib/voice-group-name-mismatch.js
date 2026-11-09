'use strict';

// CROSS-CALL WRONG-NAME DETECTOR (Owner decision chat).
//
// "that's red if we have an error in the voice match... click into it and
//  decide if it's a defect... bar needs to be very high"
//
// A confirmed voice group can quietly absorb a second person. Four groups did:
// PRIVATE_NAME held PRIVATE_NAME, PRIVATE_NAME held PRIVATE_NAME, PRIVATE_NAME held PRIVATE_NAME, and PRIVATE_NAME
// held PRIVATE_NAME (7 tracks, addressed as PRIVATE_NAME 32 times and as PRIVATE_NAME never). The
// per-call direct-address gate (voice-direct-address-contradiction.js) only
// judges one call at promotion time, and Owner-confirmed groups are exempt
// from it, so nothing looked across calls at who a group's tracks answer to.
//
// This module does. It works on speaker TURNS (consecutive segments of one
// label merged), because segment-level reply logic missed PRIVATE_NAME and PRIVATE_NAME in
// the 2026-10-14 audit. When another speaker's turn names a known person and
// the very next turn is this track, the track "answered to" that name. A
// (group, heard name) pair is reported only when all of these hold:
//   - the name is a People file first name and not the group's own name
//     (nickname, prefix and ASR spelling families count as the same name);
//   - no other identified speaker in that call carries the name;
//   - a flagged track never answers to the group's own name;
//   - the flagged tracks answer to the name at least `minHits` times across
//     at least `minCalls` calls.
// It never changes an identity. It only queues the pair for the owner, and a
// "not a defect" decision is honoured forever.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  heardNamesInText,
  namesPossiblySame,
  personNameTokens,
} = require('./voice-direct-address-contradiction');

const GROUP_NAME_MISMATCH_LANE = 'group_name_mismatch_review_queue';
const DEFAULT_MIN_HITS = 3;
const DEFAULT_MIN_CALLS = 2;
const DEFAULT_WINDOW_SECONDS = 20;
const MENTION_PATTERN = /\b([A-Z][a-z]{2,})\b/g;
// Talk ABOUT someone is not talk TO them (Owner decision: all three queued
// pairs were false, and Codex showed a verb blacklist can never be complete:
// "Did you talk to PRIVATE_NAME?", "PRIVATE_NAME will send the deck."). So a mention counts
// only when its grammar is positively a direct address:
//   vocative: the name opens the turn or follows a comma or a greeting or
//     discourse word, and is followed by a comma or sentence end
//     ("Thanks, PRIVATE_NAME.", "And PRIVATE_NAME, what do you think?");
//   address question: the name opens a clause and is followed by a modal or
//     auxiliary plus "you" ("PRIVATE_NAME can you send the deck?").
// Everything else (possessives, objects, subjects of a statement) is talk
// about a third person and is ignored.
const VOCATIVE_BEFORE =
  /(?:^|[,.!?;:]\s*|\b(?:hi|hey|hello|thanks|thank you|okay|ok|so|and|well|yes|yeah|no|sorry|morning|right|alright|listen|look)\s+)$/i;
const VOCATIVE_AFTER = /^\s*(?:[,!?.]|$)/;
const CLAUSE_START_BEFORE = /(?:^|[,.!?;:]\s*|\b(?:and|so|okay|ok|hey|hi)\s+)$/i;
const ADDRESS_QUESTION_AFTER =
  /^,?\s+(?:can|could|would|will|do|did|are|have|should|when|what)\s+you\b/i;

function directAddressMention(text, index, length) {
  const before = text.slice(Math.max(0, index - 24), index);
  const after = text.slice(index + length);
  if (VOCATIVE_AFTER.test(after) && VOCATIVE_BEFORE.test(before)) return true;
  return CLAUSE_START_BEFORE.test(before) && ADDRESS_QUESTION_AFTER.test(after);
}

function firstName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z ]+/g, ' ')
    .trim()
    .split(/\s+/)[0] || '';
}

// first name -> sorted People file paths (memory/contacts/<file>.md)
function contactFirstNames(contactsDir, fsApi = fs) {
  const out = new Map();
  let names = [];
  try {
    names = fsApi.readdirSync(contactsDir);
  } catch {
    return out;
  }
  for (const file of names) {
    if (!file.endsWith('.md') || file === 'INDEX.md') continue;
    let head = '';
    try {
      head = fsApi.readFileSync(path.join(contactsDir, file), 'utf8').slice(0, 800);
    } catch {
      continue;
    }
    const match = head.match(/^name:\s*["']?([^"'\n]+)["']?/m);
    const first = firstName(match ? match[1] : file.replace(/\.md$/, '').replace(/_/g, ' '));
    if (!first || first.length < 3) continue;
    if (!out.has(first)) out.set(first, []);
    out.get(first).push(`memory/contacts/${file}`);
  }
  for (const list of out.values()) list.sort();
  return out;
}

function seconds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function callTurns(segments) {
  const turns = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    const label = String(segment?.speaker_model_label ?? '');
    const text = String(segment?.text || '');
    const last = turns[turns.length - 1];
    if (last && last.label === label) {
      last.text = `${last.text} ${text}`.trim();
      last.end = seconds(segment.end_seconds ?? segment.start_seconds);
      continue;
    }
    turns.push({
      label,
      text,
      start: seconds(segment?.start_seconds),
      end: seconds(segment?.end_seconds ?? segment?.start_seconds),
    });
  }
  return turns;
}

function namesInTurn(text, vocabulary, mode = 'vocative') {
  if (mode === 'vocative') {
    return heardNamesInText(text, vocabulary).map((name) => name.toLowerCase());
  }
  const names = new Set();
  MENTION_PATTERN.lastIndex = 0;
  let match = MENTION_PATTERN.exec(text);
  while (match) {
    const token = match[1].toLowerCase();
    if (vocabulary.has(token) && directAddressMention(text, match.index, match[0].length)) names.add(token);
    match = MENTION_PATTERN.exec(text);
  }
  return [...names];
}

// label -> name -> [{ start_seconds, by_label, text, reply_text }]
function namesAnsweredByLabel(
  segments,
  vocabulary,
  { windowSeconds = DEFAULT_WINDOW_SECONDS, mode = 'vocative' } = {},
) {
  const turns = callTurns(segments);
  const out = new Map();
  for (let index = 0; index < turns.length - 1; index += 1) {
    const turn = turns[index];
    const reply = turns[index + 1];
    if (reply.start - turn.end > windowSeconds) continue;
    const names = namesInTurn(turn.text, vocabulary, mode);
    if (!names.length) continue;
    if (!out.has(reply.label)) out.set(reply.label, new Map());
    const byName = out.get(reply.label);
    for (const name of names) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({
        start_seconds: Math.round(turn.start),
        by_label: turn.label,
        text: turn.text.slice(-220),
        reply_text: reply.text.slice(0, 160),
      });
    }
  }
  return out;
}

// How often a label answers to the group's own name. Own tokens of any
// length count here ("Ed" is below the shared vocabulary's 3-letter floor),
// so a group is never mistaken for one that does not answer to its name.
function ownNamePattern(tokens) {
  const words = [...new Set(tokens)]
    .filter((token) => token && token.length >= 2)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1));
  return words.length ? new RegExp(`\\b(?:${words.join('|')})\\b`) : null;
}

function answersToPattern(turns, label, pattern, windowSeconds = DEFAULT_WINDOW_SECONDS) {
  if (!pattern) return 0;
  let hits = 0;
  for (let index = 0; index < turns.length - 1; index += 1) {
    const reply = turns[index + 1];
    if (reply.label !== label || turns[index].label === label) continue;
    if (reply.start - turns[index].end > windowSeconds) continue;
    if (pattern.test(turns[index].text)) hits += 1;
  }
  return hits;
}

function trackKeyParts(key) {
  const [otid = '', label = '', speakerId = ''] = String(key || '').split('|');
  return { otid, label, voiceClusterId: speakerId };
}

function mismatchItemId(groupId, heardName) {
  return `gnm_${crypto
    .createHash('sha1')
    .update(`${groupId}|${heardName}`)
    .digest('hex')
    .slice(0, 16)}`;
}

function callDate(call) {
  return String(call?.date || call?.start_time || call?.created_at || '').slice(0, 10);
}

// decisions: rows from group-name-mismatch-decisions.jsonl. Every decision is
// scoped to the tracks the owner reviewed: those tracks never return, and a track
// the group absorbs later re-opens the item. A legacy decision without
// track_keys covers the whole pair.
function latestDecisions(rows) {
  const byItem = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.item_id) continue;
    const prior = byItem.get(row.item_id) || { all: false, track_keys: new Set() };
    const keys = Array.isArray(row.track_keys) ? row.track_keys.filter(Boolean) : [];
    if (!keys.length) prior.all = true;
    for (const key of keys) prior.track_keys.add(key);
    byItem.set(row.item_id, prior);
  }
  return byItem;
}

// The owner said this exact track is not the group person ("not them"), and the
// apply step recorded that denial in the voice registry. The registry row is
// the durable proof, so the page alone can never hide a track. The voice then
// belongs to the unknown-voice queue, not to this group's mixup review.
function deniedForGroup(registry, voiceClusterId, personId) {
  const denials = registry?.voice_cluster_denials?.[voiceClusterId];
  return Boolean(personId) && Array.isArray(denials) && denials.some((row) => row?.denied_person_id === personId);
}

function detectGroupNameMismatches({
  clusters = [],
  readCall,
  vocabulary,
  contactsByFirstName = new Map(),
  registry = {},
  decisions = [],
  minHits = DEFAULT_MIN_HITS,
  minCalls = DEFAULT_MIN_CALLS,
  windowSeconds = DEFAULT_WINDOW_SECONDS,
  mode = 'vocative',
  minTrackHits = 1,
  minShare = 0,
  minConcentration = 0,
} = {}) {
  const decided = latestDecisions(decisions);
  const resolutions = registry?.voice_cluster_resolutions || {};
  const answered = new Map();
  const turnsByCall = new Map();
  const answeredFor = (otid, call) => {
    if (!answered.has(otid)) {
      answered.set(
        otid,
        namesAnsweredByLabel(call?.segments || [], vocabulary, { windowSeconds, mode }),
      );
    }
    return answered.get(otid);
  };
  const turnsFor = (otid, call) => {
    if (!turnsByCall.has(otid)) turnsByCall.set(otid, callTurns(call?.segments || []));
    return turnsByCall.get(otid);
  };
  const items = [];
  let tracksChecked = 0;
  for (const cluster of Array.isArray(clusters) ? clusters : []) {
    if (!cluster?.confirmed_person_id) continue;
    const groupName = cluster.confirmed_display_name || cluster.confirmed_person_id;
    const own = personNameTokens(cluster.confirmed_person_id, groupName);
    const isOwn = (name) => own.some((token) => namesPossiblySame(name, token));
    const ownPattern = ownNamePattern(own);
    const probeByTrack = new Map(
      (cluster.members || []).map((member) => [member?.track_key, member?.probe_audio_path || '']),
    );
    const byHeard = new Map();
    let ownNameTracks = 0;
    const foreignTracks = new Set();
    for (const key of cluster.member_track_keys || []) {
      const { otid, label, voiceClusterId } = trackKeyParts(key);
      const call = readCall(otid);
      if (!call) continue;
      tracksChecked += 1;
      // The owner already decided this exact track (for this person, or split it
      // out to another one that the recluster has not moved yet): never re-ask.
      if (resolutions[voiceClusterId]?.status === 'confirmed_by_owner') continue;
      if (deniedForGroup(registry, voiceClusterId, cluster.confirmed_person_id)) continue;
      const ownHits = answersToPattern(turnsFor(otid, call), label, ownPattern, windowSeconds);
      const heard = answeredFor(otid, call).get(label);
      if (ownHits > 0 || (heard && [...heard.keys()].some(isOwn))) {
        ownNameTracks += 1;
        continue;
      }
      if (!heard) continue;
      const carried = [];
      for (const [otherLabel, track] of Object.entries(call.speaker_identity_tracks || {})) {
        if (String(otherLabel) === label || !track?.person_id) continue;
        carried.push(...personNameTokens(track.person_id, track.resolved_person || track.display_name));
      }
      for (const [name, evidence] of heard) {
        if (!contactsByFirstName.has(name) || evidence.length < minTrackHits) continue;
        if (carried.some((token) => namesPossiblySame(name, token))) continue;
        foreignTracks.add(key);
        if (!byHeard.has(name)) byHeard.set(name, []);
        byHeard.get(name).push({
          track_key: key,
          otid,
          label,
          voice_cluster_id: voiceClusterId,
          probe_audio_path: probeByTrack.get(key) || '',
          title: String(call.title || '').slice(0, 80),
          date: callDate(call),
          hits: evidence.length,
          evidence: evidence.slice(0, 3),
        });
      }
    }
    for (const [name, tracks] of byHeard) {
      const hits = tracks.reduce((sum, track) => sum + track.hits, 0);
      const calls = new Set(tracks.map((track) => track.otid)).size;
      if (hits < minHits || calls < minCalls) continue;
      // Size-independent bar: the tracks answering to the other name must be a
      // real share of the tracks answering to the group's own name. A big group
      // collects stray mentions of every coworker; a mixed group does not.
      const share = tracks.length / Math.max(1, ownNameTracks);
      if (share < minShare) continue;
      // One foreign name must dominate. A talkative speaker answers after many
      // different names; a group holding a second person answers to that one.
      const concentration = tracks.length / Math.max(1, foreignTracks.size);
      if (concentration < minConcentration) continue;
      const itemId = mismatchItemId(cluster.cluster_id, name);
      const decision = decided.get(itemId);
      if (decision?.all) continue;
      const decidedTracks = decision?.track_keys || new Set();
      const open = tracks.filter((track) => !decidedTracks.has(track.track_key));
      if (!open.length) continue;
      const heardDisplay = name.charAt(0).toUpperCase() + name.slice(1);
      items.push({
        item_id: itemId,
        lane: GROUP_NAME_MISMATCH_LANE,
        group_id: cluster.cluster_id,
        group_person_id: cluster.confirmed_person_id,
        group_name: groupName,
        group_size: cluster.size || (cluster.member_track_keys || []).length,
        heard_name: heardDisplay,
        heard_people_files: contactsByFirstName.get(name) || [],
        hits,
        calls,
        own_name_tracks: ownNameTracks,
        foreign_name_tracks: foreignTracks.size,
        share: Number(share.toFixed(2)),
        concentration: Number(concentration.toFixed(2)),
        tracks: open.sort((a, b) => b.hits - a.hits || a.date.localeCompare(b.date)),
      });
    }
  }
  items.sort((a, b) => b.hits - a.hits);
  return { items, tracks_checked: tracksChecked };
}

// The bar the owner asked for ("very high"), validated on the 2026-10-14 EC2 data:
// both passes require the foreign name to own at least half of the group's
// foreign-name tracks and to rival the tracks answering to the group's own
// name. Mention pass: 2+ answers per track, 4+ across 2+ calls. Vocative pass:
// direct address only, 3+ across 2+ calls. Caught PRIVATE_NAME<-PRIVATE_NAME,
// PRIVATE_NAME<-PRIVATE_NAME and PRIVATE_NAME<-PRIVATE_NAME; PRIVATE_NAME<-PRIVATE_NAME sits below the bar.
const HIGH_BAR_PASSES = [
  { mode: 'mention', minTrackHits: 2, minHits: 4, minCalls: 2 },
  { mode: 'vocative', minTrackHits: 1, minHits: 3, minCalls: 2 },
];
const HIGH_BAR_MIN_SHARE = 0.5;
const HIGH_BAR_MIN_CONCENTRATION = 0.5;

function detectHighBarGroupNameMismatches(options = {}) {
  const byId = new Map();
  let tracksChecked = 0;
  for (const pass of HIGH_BAR_PASSES) {
    const result = detectGroupNameMismatches({
      ...options,
      ...pass,
      minShare: HIGH_BAR_MIN_SHARE,
      minConcentration: HIGH_BAR_MIN_CONCENTRATION,
    });
    tracksChecked = Math.max(tracksChecked, result.tracks_checked);
    for (const item of result.items) {
      const prior = byId.get(item.item_id);
      if (!prior) {
        byId.set(item.item_id, { ...item, passes: [pass.mode] });
        continue;
      }
      prior.passes.push(pass.mode);
      const known = new Set(prior.tracks.map((track) => track.track_key));
      for (const track of item.tracks) if (!known.has(track.track_key)) prior.tracks.push(track);
      prior.hits = Math.max(prior.hits, item.hits);
      prior.calls = new Set(prior.tracks.map((track) => track.otid)).size;
    }
  }
  const items = [...byId.values()].sort((a, b) => b.hits - a.hits);
  return { items, tracks_checked: tracksChecked };
}

// Second source: the lineage worker (lib/voice-name-judge-lineage.js) traced a
// retired name judgment by speaker track into a confirmed group whose person
// has a different name. On the 2026-10-14 EC2 data this caught all four known
// mixups, including PRIVATE_NAME<-PRIVATE_NAME, which the transcript pass misses. The bar
// stays high: the judgment already cleared the name judge's admissibility
// gate, the heard name has a People file and is not a spelling or nickname of
// the group's person, and a track that answers to the group's own name in its
// own call is dropped, and the traced tracks must span 2+ calls, the same
// call floor as the transcript pass. Owner-decided tracks never return; new
// tracks re-open the item.
function lineageNameMismatchItems({
  outcomes = [],
  clusters = [],
  readCall,
  contactsByFirstName = new Map(),
  registry = {},
  decisions = [],
  windowSeconds = DEFAULT_WINDOW_SECONDS,
  minCalls = DEFAULT_MIN_CALLS,
} = {}) {
  const decided = latestDecisions(decisions);
  const resolutions = registry?.voice_cluster_resolutions || {};
  const clusterById = new Map(
    (Array.isArray(clusters) ? clusters : []).map((cluster) => [String(cluster?.cluster_id || ''), cluster]),
  );
  const byId = new Map();
  for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
    // Any outcome with confirmed holders counts, including a record whose
    // unknown holders are still draining: the confirmed part is decided now.
    if (!outcome?.holder_tracks || !Object.keys(outcome.holder_tracks).length) continue;
    const name = firstName(outcome.best_name);
    if (!name || !contactsByFirstName.has(name)) continue;
    for (const [groupId, tracedKeys] of Object.entries(outcome.holder_tracks || {})) {
      const cluster = clusterById.get(groupId);
      if (!cluster?.confirmed_person_id) continue;
      const groupName =
        cluster.confirmed_display_name ||
        registry?.people?.[cluster.confirmed_person_id]?.display_name ||
        cluster.confirmed_person_id;
      const own = personNameTokens(cluster.confirmed_person_id, groupName);
      if (own.some((token) => namesPossiblySame(name, token))) continue;
      const ownPattern = ownNamePattern(own);
      const traced = new Set(tracedKeys);
      const itemId = mismatchItemId(groupId, name);
      const decision = decided.get(itemId);
      if (decision?.all) continue;
      const decidedTracks = decision?.track_keys || new Set();
      const probeByTrack = new Map(
        (cluster.members || []).map((member) => [member?.track_key, member?.probe_audio_path || '']),
      );
      const tracks = [];
      for (const key of cluster.member_track_keys || []) {
        const { otid, label, voiceClusterId } = trackKeyParts(key);
        if (!traced.has(`${otid}|${label}`) || decidedTracks.has(key)) continue;
        if (resolutions[voiceClusterId]?.status === 'confirmed_by_owner') continue;
        if (deniedForGroup(registry, voiceClusterId, cluster.confirmed_person_id)) continue;
        const call = typeof readCall === 'function' ? readCall(otid) : null;
        if (call && answersToPattern(callTurns(call.segments || []), label, ownPattern, windowSeconds) > 0) continue;
        tracks.push({
          track_key: key,
          otid,
          label,
          voice_cluster_id: voiceClusterId,
          probe_audio_path: probeByTrack.get(key) || '',
          title: String(call?.title || '').slice(0, 80),
          date: callDate(call),
          hits: 0,
          evidence: [],
          judge_named: { name: String(outcome.best_name), judged_at: String(outcome.judged_at || '') },
        });
      }
      if (!tracks.length) continue;
      if (!byId.has(itemId)) {
        byId.set(itemId, {
          item_id: itemId,
          lane: GROUP_NAME_MISMATCH_LANE,
          group_id: groupId,
          group_person_id: cluster.confirmed_person_id,
          group_name: groupName,
          group_size: cluster.size || (cluster.member_track_keys || []).length,
          heard_name: name.charAt(0).toUpperCase() + name.slice(1),
          heard_people_files: contactsByFirstName.get(name) || [],
          hits: 0,
          calls: 0,
          passes: ['name_judge_lineage'],
          tracks: [],
        });
      }
      const item = byId.get(itemId);
      const known = new Set(item.tracks.map((track) => track.track_key));
      for (const track of tracks) if (!known.has(track.track_key)) item.tracks.push(track);
      item.calls = new Set(item.tracks.map((track) => track.otid)).size;
    }
  }
  return [...byId.values()].filter((item) => item.calls >= minCalls);
}

// Merge lineage items into the transcript items by item_id (same group, same
// heard name), keeping every distinct track once.
function mergeMismatchItems(primary = [], extra = []) {
  const byId = new Map(primary.map((item) => [item.item_id, { ...item, tracks: [...item.tracks] }]));
  for (const item of extra) {
    const prior = byId.get(item.item_id);
    if (!prior) {
      byId.set(item.item_id, item);
      continue;
    }
    prior.passes = [...new Set([...(prior.passes || []), ...(item.passes || [])])];
    const known = new Set(prior.tracks.map((track) => track.track_key));
    for (const track of item.tracks) if (!known.has(track.track_key)) prior.tracks.push(track);
    prior.calls = new Set(prior.tracks.map((track) => track.otid)).size;
  }
  return [...byId.values()].sort((a, b) => b.hits - a.hits || b.tracks.length - a.tracks.length);
}

module.exports = {
  HIGH_BAR_PASSES,
  lineageNameMismatchItems,
  mergeMismatchItems,
  detectHighBarGroupNameMismatches,
  DEFAULT_MIN_CALLS,
  DEFAULT_MIN_HITS,
  GROUP_NAME_MISMATCH_LANE,
  callTurns,
  contactFirstNames,
  detectGroupNameMismatches,
  deniedForGroup,
  latestDecisions,
  mismatchItemId,
  namesAnsweredByLabel,
};
