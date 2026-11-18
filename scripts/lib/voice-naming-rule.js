'use strict';

// The one speaker-naming rule (owner decision).
//
//   PRIVATE_NAME:          the owner confirmed it, or all three hold: the speaker's own voice
//                  scores 0.75 or more for PRIVATE_NAME with a 0.10 lead; the speaker
//                  talks for at least 10 seconds; and no other speaker on the
//                  call is PRIVATE_NAME, unless the two sound alike.
//   probably PRIVATE_NAME: the voice scores 0.56 or more but misses that line. A guess,
//                  never counted as PRIVATE_NAME.
//   unnamed:       everything else.
//
// Groups suggest and never name. Recorded calls never gain a name: the frozen
// baseline below records them, and only the owner's own click passes it.

const fs = require('fs');
const path = require('path');
const { AUTO_CONFIRM_SCORE, AUTO_CONFIRM_MARGIN } = require('./voice-score-normalization');
const {
  MACHINE_CONFIRMED_TIERS: AUTOMATIC_ROW_STATUSES,
  canonicalPersonId,
  isConfirmedIdentityStatus,
  isOwnerConfirmedTier,
  normalizeIdentityTier,
} = require('./canonical-speaker-identity');
const { sameCanonicalPerson } = require('./voice-track-name-check');
const { cosine } = require('./voice-reference-people');

const NAME_BAR = AUTO_CONFIRM_SCORE;
const NAME_MARGIN = AUTO_CONFIRM_MARGIN;
const PROBABLE_FLOOR = 0.56;
const MIN_NET_SPEECH_SECONDS = 10;
// Two speakers under one name are one person only when they sound alike.
const SAME_VOICE_PAIR = 0.75;
// A voice pointing at someone else this strongly removes the name, even under
// the naming bar: it may not name that other person, but it disproves this one.
const DISAGREE_SCORE = 0.65;
const PROBABLE_TIER = 'probable_reference_voiceprint_match';
const SUGGESTED_TIER = 'suggested_reference_voiceprint_match';
const BASELINE_SCHEMA = 'voice_naming_rule_baseline.v1';
// A new voice sample teaches every later call, so its bar sits far above naming
// (Owner decision: "what if new voice samples just have a really high bar").
const SAMPLE_SCORE = 0.85;
const SAMPLE_SECONDS = 20;
const SAMPLE_FIT = 0.5;

/** What a reader sees for a roster row: the name, "probably <name>", or the row's id. */
function rosterSpeakerLabel(speaker = {}) {
  if (speaker.probable_person_id) {
    return `probably ${speaker.probable_display_name || speaker.probable_person_id}`;
  }
  return speaker.display_name || speaker.speaker_id || 'unknown speaker';
}

/** Clip length from a probe path such as track-label-2-start-10.00-dur-30.00.wav. */
function clipDurationFromPath(probeAudioPath) {
  const match = String(probeAudioPath || '').match(/-dur-(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function baselinePath(dataDir) {
  return path.join(dataDir, 'life-archive', 'voiceprints', 'voice-naming-rule-baseline.json');
}

/**
 * Null until the rule has been applied. An unreadable file stops the writer:
 * guessing here could put a name on a recorded call.
 */
function readNamingBaseline(dataDir) {
  let text;
  try {
    text = fs.readFileSync(baselinePath(dataDir), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const baseline = JSON.parse(text);
  if (baseline?.schema !== BASELINE_SCHEMA || !baseline.calls) {
    throw new Error(`naming baseline is not ${BASELINE_SCHEMA}: ${baselinePath(dataDir)}`);
  }
  return baseline;
}

function isFrozenCall(baseline, otid, sourceRevision) {
  if (!baseline) return false;
  const frozen = baseline.calls?.[String(otid)];
  if (frozen === undefined) return false;
  return String(frozen).toLowerCase() === String(sourceRevision || '').toLowerCase();
}

/** True when this registry row was written after the rule was applied: the owner's new word. */
function rowPostdatesBaseline(baseline, row) {
  const frozenAt = Date.parse(baseline?.frozen_at || '');
  const rowAt = Date.parse(row?.updated_at || '');
  return Number.isFinite(frozenAt) && Number.isFinite(rowAt) && rowAt > frozenAt;
}

/**
 * True when a re-running writer may not make this change on a recorded call.
 * A named or "probably" track keeps its person and its tier, and an unnamed
 * track stays unnamed: only the daily check and the owner change labels there, and
 * they do not ask this. The owner's answer on an unnamed track ("not them", "not
 * speech") stays too: a writer with no name to give would replace it with a plain
 * unknown. A new call, or a new revision of a recorded one, follows the rule and
 * is not blocked.
 */
function namingWriteBlocked({ baseline, otid, sourceRevision, existing, incoming }) {
  if (!isFrozenCall(baseline, otid, sourceRevision)) return false;
  const before = canonicalPersonId(existing?.person_id);
  const after = canonicalPersonId(incoming?.person_id);
  if (!after) return Boolean(before) || isOwnerTier(existing?.identity_tier) || Boolean(existing?.owner_track_decision);
  if (!before) return true;
  if (before !== after) return true;
  return String(existing?.identity_tier || '') !== String(incoming?.identity_tier || '');
}

/**
 * C3: how far a group member's own voice supports the group's name. A group
 * suggests and never names. `passes` is the shared naming decision run on the
 * member's own score. Missing evidence is never a pass.
 */
function groupMemberOutcome({ ownScore = null, passes = false, netSpeechSeconds = null, purityVerdict = '' } = {}) {
  if (ownScore == null) return { outcome: 'unnamed', reason: 'no_usable_voice' };
  if (purityVerdict === 'mixed') return { outcome: 'unnamed', reason: 'two_voices_in_clip' };
  const speechOk = netSpeechSeconds != null && Number(netSpeechSeconds) >= MIN_NET_SPEECH_SECONDS;
  if (passes && speechOk) return { outcome: 'named', reason: 'clears_bar' };
  if (Number(ownScore) < PROBABLE_FLOOR) return { outcome: 'unnamed', reason: 'below_bar' };
  return { outcome: 'probable', reason: passes ? 'too_little_speech' : 'below_bar' };
}

/** Voice groups the owner named himself, group id to person. */
function ownerGroupIndex(registry) {
  const out = new Map();
  for (const table of ['voice_cluster_resolutions', 'acoustic_group_resolutions']) {
    for (const [id, row] of Object.entries(registry?.[table] || {})) {
      if (id.startsWith('person:')) continue;
      if (/confirmed_by_owner/.test(String(row?.status || ''))) out.set(id, canonicalPersonId(row.person_id));
    }
  }
  return out;
}

/**
 * True when the owner named this exact speaker himself. A click on one speaker writes
 * a speaker_ row with no group on it, and a speaker_ id sits on one track. A
 * click on a group writes the group id on every member's row, and that is a
 * suggestion: each member still faces its own voice.
 */
function ownerClickedSpeaker(registry, clusterIds, personId) {
  const aliases = registry?.person_id_aliases;
  return (clusterIds || []).some((id) => {
    const value = String(id || '');
    if (!/^speaker_\d+$/.test(value)) return false;
    const row = registry?.voice_cluster_resolutions?.[value];
    return (
      String(row?.status || '') === 'confirmed_by_owner' &&
      !row.acoustic_group_id &&
      !row.derived_from_acoustic_group &&
      sameCanonicalPerson(row.person_id, personId, aliases)
    );
  });
}

function isOwnerTier(tier) {
  const value = String(tier || '').toLowerCase();
  return value === 'confirmed_by_owner' || /owner_track|denied|left_unknown|non_speech|two_people|needs_reconfirmation/.test(value);
}

/**
 * Where a named track's name came from: 'owner_track', 'owner_group_or_cluster'
 * or 'automatic'. The first two keep their label when the rule is applied.
 */
function trackNameSource({ identity, trackKey, ownerGroups, ownerTrackKeys }) {
  if (isOwnerTier(identity?.identity_tier) || identity?.owner_track_decision || ownerTrackKeys?.has(trackKey)) {
    return 'owner_track';
  }
  const person = canonicalPersonId(identity?.person_id);
  const groupIds = [
    identity?.voice_cluster_id,
    identity?.source_voice_cluster_id,
    identity?.acoustic_unknown_id,
    identity?.source_acoustic_group_id,
    identity?.unknown_speaker_id,
  ].filter((value) => value && !String(value).startsWith('person:'));
  // Owner decision (decision 5): his confirmation shows named. A track whose
  // tier says he confirmed its group (cluster, acoustic group or cluster
  // binding, old spellings included) is his even when the group row has since
  // moved to another id. His per-track tier is handled above.
  const ownerGroupTier = (tier) => isOwnerConfirmedTier(tier) && normalizeIdentityTier(tier) !== 'confirmed_by_owner';
  if (
    ownerGroupTier(identity?.identity_tier) ||
    ownerGroupTier(identity?.voice_check?.prior_tier) ||
    groupIds.some((id) => ownerGroups?.get(id) === person)
  ) {
    return 'owner_group_or_cluster';
  }
  return 'automatic';
}

/**
 * C4: on one call, a name may sit on two speakers only if they sound alike.
 * `rows` are the call's displayed names, each { key, person, owner, own, vector }.
 * Speakers joined by a voice match of SAME_VOICE_PAIR or more count as one
 * person (Recorder split them). A component holding a Owner-held speaker wins;
 * otherwise the component with the strongest own-voice score wins. Returns the
 * keys of the automatic speakers that lose.
 */
function duplicateNameLosers(rows, { samePerson, cosine }) {
  const losers = new Set();
  const used = new Set();
  rows.forEach((row, i) => {
    if (used.has(i)) return;
    const group = [row];
    used.add(i);
    rows.forEach((other, j) => {
      if (j > i && !used.has(j) && samePerson(row.person, other.person)) {
        group.push(other);
        used.add(j);
      }
    });
    if (group.length < 2 || group.every((member) => member.owner)) return;
    const parent = group.map((_, k) => k);
    const find = (x) => {
      if (parent[x] !== x) parent[x] = find(parent[x]);
      return parent[x];
    };
    for (let a = 0; a < group.length; a += 1) {
      for (let b = a + 1; b < group.length; b += 1) {
        const va = group[a].vector;
        const vb = group[b].vector;
        if (va && vb && cosine(va, vb) >= SAME_VOICE_PAIR) parent[find(a)] = find(b);
      }
    }
    const components = new Map();
    group.forEach((member, k) => {
      const root = find(k);
      if (!components.has(root)) components.set(root, []);
      components.get(root).push(member);
    });
    const ownScore = (member) => (member.own == null ? -1 : member.own);
    const ownerComponents = [...components.values()].filter((members) => members.some((member) => member.owner));
    let winners;
    if (ownerComponents.length) {
      winners = new Set(ownerComponents.flat());
    } else {
      let best = null;
      let bestScore = -Infinity;
      for (const members of components.values()) {
        const score = Math.max(...members.map(ownScore));
        if (score > bestScore) {
          bestScore = score;
          best = members;
        }
      }
      winners = new Set(best);
    }
    for (const member of group) {
      if (!member.owner && !winners.has(member)) losers.add(member.key);
    }
  });
  return losers;
}

/**
 * C6: when a track loses an automatic name, the voice-group rows that gave it
 * stop reading as a confirmed name. Ids come from the identity before the
 * change, because the change clears some of them. A row keeps its person as a
 * suggestion and its old status as a record. Returns the rows changed.
 */
function demoteAutomaticRegistryRows(registry, identity, { personId, at, source, reason } = {}) {
  const person = canonicalPersonId(personId || identity?.person_id);
  if (!registry || !person) return 0;
  const ids = [
    identity?.source_voice_cluster_id,
    identity?.voice_cluster_id,
    identity?.source_acoustic_group_id,
    identity?.acoustic_unknown_id,
    identity?.unknown_speaker_id,
  ]
    .map((value) => String(value || '').trim())
    .filter((value) => value && !/^person:/i.test(value));
  let changed = 0;
  for (const id of new Set(ids)) {
    for (const table of ['voice_cluster_resolutions', 'acoustic_group_resolutions']) {
      const row = registry[table]?.[id];
      if (!row || !AUTOMATIC_ROW_STATUSES.has(String(row.status || ''))) continue;
      if (canonicalPersonId(row.person_id) !== person) continue;
      registry[table][id] = {
        ...row,
        status: SUGGESTED_TIER,
        prior_status: row.status,
        voice_check: { reason: reason || '', source: source || '', at: at || '' },
      };
      changed += 1;
    }
  }
  return changed;
}

/** The display class every reader must agree on. */
function displayClass(identity) {
  if (!identity?.person_id) return 'unnamed';
  return String(identity.identity_tier || '') === PROBABLE_TIER ? 'probable' : 'named';
}

/** True only for a name a reader may state as fact. */
function isStatedName(identity) {
  return Boolean(identity?.person_id) && isConfirmedIdentityStatus(identity.identity_tier);
}

/** A sample set aside by the calibration gate or by the owner teaches nothing. */
function sampleIsSetAside(row) {
  return String(row?.calibration_quarantine_status || '') === 'quarantined';
}

/** the owner set this sample aside or put it back: the calibration gate leaves it. */
function sampleDecidedByOwner(row) {
  return row?.calibration_quarantine_source === 'owner' || row?.calibration_release_source === 'owner';
}

/**
 * True when the owner's own word names this sample's speaker: a sample he added, his
 * click on that track, or his click on that exact speaker. A click on a group is
 * not one, since the group only suggests its members.
 */
function sampleFromOwner(row, registry) {
  if (row?.automatic_strengthening !== true) return true;
  if (row.identity_evidence === 'confirmed_by_owner_track_decision') return true;
  return ownerClickedSpeaker(registry, [row.source_voice_cluster_id], row.person_id);
}

/** How well a clip sits with the person's other samples; null when unproven. */
function sampleFit(vector, others) {
  const usable = (others || []).filter((other) => other?.length && other.length === vector?.length);
  if (!vector?.length || !usable.length) return null;
  const mean = vector.map((_, i) => usable.reduce((sum, other) => sum + other[i], 0) / usable.length);
  return cosine(vector, mean);
}

module.exports = {
  AUTOMATIC_ROW_STATUSES,
  BASELINE_SCHEMA,
  DISAGREE_SCORE,
  MIN_NET_SPEECH_SECONDS,
  NAME_BAR,
  NAME_MARGIN,
  PROBABLE_FLOOR,
  SAME_VOICE_PAIR,
  SAMPLE_FIT,
  SAMPLE_SCORE,
  SAMPLE_SECONDS,
  SUGGESTED_TIER,
  baselinePath,
  clipDurationFromPath,
  demoteAutomaticRegistryRows,
  displayClass,
  duplicateNameLosers,
  groupMemberOutcome,
  isFrozenCall,
  isOwnerTier,
  isStatedName,
  ownerClickedSpeaker,
  ownerGroupIndex,
  namingWriteBlocked,
  readNamingBaseline,
  rosterSpeakerLabel,
  rowPostdatesBaseline,
  sampleDecidedByOwner,
  sampleFit,
  sampleFromOwner,
  sampleIsSetAside,
  trackNameSource,
};
