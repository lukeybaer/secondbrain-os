'use strict';

// Per-track voice check for group names (owner decision).
//
// A name that applies to a group (a voice cluster the owner confirmed, or an
// automatic group match) only counts as confirmed on a track whose own voice
// clears the auto-confirm bar for that person. A track whose voice clears the
// bar for someone else is renamed to that person; any other track keeps the
// name as probable, never confirmed. The bar is the shared
// referenceMatchDecision, so this check can never accept what the resolver
// would reject.
//
// The owner's own per-track decisions are never checked: they are the authority.

const { applyCanonicalSpeakerIdentity, canonicalPersonId } = require('./canonical-speaker-identity');

const PROBABLE_TIER = 'probable_reference_voiceprint_match';
const RENAME_EVIDENCE = 'per_track_voice_rename';
const BELOW_BAR_EVIDENCE = 'per_track_voice_below_bar';
const OWNER_TRACK_DECISION_EVIDENCE = 'owner_track_decision';
const TWO_PEOPLE_TIER = 'two_people_by_owner';
// Confirmed statuses a probable track must not keep in any status field.
const STATUS_FIELDS = ['identity_confirmation_status', 'identity_status', 'confidence_tier', 'status'];
const CONFIRMED_STATUS = /^confirmed_/;

/**
 * The outcome for one named track. `match` is bestPersonMatch's result for the
 * track's own vector, `verdict` the referenceMatchDecision for that match.
 * Returns { outcome: 'confirmed' | 'renamed' | 'probable', person_id, reason }.
 */
function trackNameCheck({ namedPersonId, match = null, verdict = null, netSpeechOk = true }) {
  const named = canonicalPersonId(namedPersonId);
  if (!match) return { outcome: 'probable', person_id: named, reason: 'no_usable_voice' };
  if (!verdict?.accept) return { outcome: 'probable', person_id: named, reason: 'below_bar' };
  if (!netSpeechOk) return { outcome: 'probable', person_id: named, reason: 'too_little_speech' };
  const voice = canonicalPersonId(match.person_id);
  if (voice === named) return { outcome: 'confirmed', person_id: named, reason: 'clears_bar' };
  return { outcome: 'renamed', person_id: voice, reason: 'voice_clears_bar_for_other_person' };
}

function voiceCheckRecord({ check, match, namedPersonId, at, source, sourceRevision }) {
  return {
    outcome: check.outcome,
    reason: check.reason,
    named_person_id: canonicalPersonId(namedPersonId) || null,
    voice_person_id: match ? canonicalPersonId(match.person_id) : null,
    score: match ? Number(Number(match.score).toFixed(4)) : null,
    margin: match ? Number(Number(match.margin).toFixed(4)) : null,
    checked_at: at || new Date().toISOString(),
    source: source || 'voice-track-name-check',
    source_revision: String(sourceRevision || ''),
    purity: check.purity || null,
  };
}

function isProbableIdentity(identity) {
  return String(identity?.identity_tier || '') === PROBABLE_TIER;
}

/**
 * The group name stays on the track, marked probable. The prior confirmed tier
 * is kept on voice_check so a later pass can restore it once the voice clears
 * the bar.
 */
function probableIdentity(identity, { check, match = null, at, source, sourceRevision } = {}) {
  const next = { ...identity };
  const priorTier = isProbableIdentity(identity)
    ? identity.voice_check?.prior_tier || null
    : String(identity?.identity_tier || '') || null;
  next.identity_tier = PROBABLE_TIER;
  for (const field of STATUS_FIELDS) {
    if (CONFIRMED_STATUS.test(String(next[field] || ''))) next[field] = PROBABLE_TIER;
  }
  if (CONFIRMED_STATUS.test(String(next.voice_cluster_resolution_status || ''))) {
    next.voice_cluster_resolution_status = PROBABLE_TIER;
  }
  if (match && Number.isFinite(Number(match.score))) {
    next.confidence = Number(Math.min(Number(next.confidence ?? 1), Number(match.score)).toFixed(3));
  }
  next.evidence = [...new Set([...(Array.isArray(next.evidence) ? next.evidence : []), BELOW_BAR_EVIDENCE])];
  next.voice_check = {
    ...voiceCheckRecord({ check, match, namedPersonId: identity?.person_id, at, source, sourceRevision }),
    prior_tier: priorTier,
  };
  return next;
}

/** The voice clears the bar for the probable track's own person again. */
function restoredIdentity(identity, { check, match = null, at, source, sourceRevision } = {}) {
  const tier = identity?.voice_check?.prior_tier || 'confirmed_reference_voiceprint_match';
  const next = { ...identity, identity_tier: tier };
  for (const field of STATUS_FIELDS) {
    if (String(next[field] || '') === PROBABLE_TIER) next[field] = tier;
  }
  if (String(next.voice_cluster_resolution_status || '') === PROBABLE_TIER) {
    next.voice_cluster_resolution_status = tier;
  }
  next.evidence = (Array.isArray(next.evidence) ? next.evidence : []).filter(
    (item) => item !== BELOW_BAR_EVIDENCE,
  );
  next.voice_check = voiceCheckRecord({ check, match, namedPersonId: identity?.person_id, at, source, sourceRevision });
  return next;
}

/**
 * The voice clears the bar for a different person. The renamed track is an
 * automatic voiceprint match, without the margin_gate receipt the reference
 * strengthener requires, so a rename never becomes a reference clip until the owner
 * confirms it.
 */
function renamedIdentity(identity, { check, match, displayName, at, source, sourceRevision } = {}) {
  const personId = canonicalPersonId(match.person_id);
  const name = String(displayName || match.display_name || personId);
  const next = {
    ...identity,
    resolved_person: name,
    display_name: name,
    person_id: personId,
    confirmed_person_id: personId,
    confirmed_display_name: name,
    identity_tier: 'confirmed_reference_voiceprint_match',
    confidence: Number(Math.min(0.99, Math.max(0, Number(match.score))).toFixed(3)),
    voice_embedding_match: match,
  };
  for (const field of STATUS_FIELDS) {
    if (next[field] != null && next[field] !== '') next[field] = 'confirmed_reference_voiceprint_match';
  }
  next.evidence = [
    ...new Set([
      ...(Array.isArray(identity?.evidence) ? identity.evidence : []).filter(
        (item) =>
          item !== BELOW_BAR_EVIDENCE &&
          item !== 'incremental_confirmed_cluster_membership' &&
          item !== 'margin_gate',
      ),
      RENAME_EVIDENCE,
    ]),
  ];
  next.voice_check = voiceCheckRecord({ check, match, namedPersonId: identity?.person_id, at, source, sourceRevision });
  return applyCanonicalSpeakerIdentity(next, personId, {
    sourceVoiceClusterId: identity?.source_voice_cluster_id || '',
    sourceAcousticGroupId: identity?.source_acoustic_group_id || '',
  });
}

/**
 * The owner's own click on the conflict queue. 'voice' names the track as the
 * voice's person, 'name' keeps the name, 'neither' leaves it unknown. The
 * owner tier makes every automatic writer skip the track, and the evidence
 * lets the reference strengthener use it as a reference clip.
 */
function ownerDecidedIdentity(identity, { personId, displayName, answer, at, sourceRevision }) {
  const decision = {
    answer,
    decided_at: at || new Date().toISOString(),
    source: 'voice-name-conflict-queue',
    source_revision: String(sourceRevision || ''),
  };
  if (answer === 'two_people') return twoPeopleIdentity(identity, { decision });
  if (answer === 'neither') {
    const denied = [
      ...new Set(
        [identity?.person_id, identity?.voice_check?.named_person_id, identity?.voice_check?.voice_person_id]
          .map(canonicalPersonId)
          .filter(Boolean),
      ),
    ];
    const voiceId = identity?.source_voice_cluster_id || null;
    const acousticId = identity?.source_acoustic_group_id || voiceId;
    return {
      ...identity,
      resolved_person: null,
      display_name: null,
      person_id: null,
      confirmed_person_id: null,
      confirmed_display_name: null,
      canonical_speaker_id: null,
      speaker_id: voiceId,
      voice_cluster_id: voiceId,
      unknown_speaker_id: acousticId,
      acoustic_unknown_id: acousticId,
      // Older readers check the single field; the list carries both names.
      denied_person_id: denied[0] || null,
      denied_person_ids: denied,
      identity_tier: 'denied_by_owner_unknown',
      identity_confirmation_status: 'denied_by_owner_unknown',
      confidence: 0,
      evidence: [
        ...new Set([...(Array.isArray(identity?.evidence) ? identity.evidence : []), OWNER_TRACK_DECISION_EVIDENCE]),
      ],
      owner_track_decision: decision,
    };
  }
  const id = canonicalPersonId(personId);
  const next = {
    ...identity,
    resolved_person: displayName || id,
    display_name: displayName || id,
    person_id: id,
    confirmed_person_id: id,
    confirmed_display_name: displayName || id,
    identity_tier: 'confirmed_by_owner',
    identity_confirmation_status: 'confirmed_by_owner',
    confidence: 1,
    evidence: [
      ...new Set([
        ...(Array.isArray(identity?.evidence) ? identity.evidence : []).filter(
          (item) => item !== BELOW_BAR_EVIDENCE && item !== RENAME_EVIDENCE,
        ),
        OWNER_TRACK_DECISION_EVIDENCE,
      ]),
    ],
    owner_track_decision: decision,
  };
  delete next.voice_check;
  return applyCanonicalSpeakerIdentity(next, id, {
    sourceVoiceClusterId: identity?.source_voice_cluster_id || '',
    sourceAcousticGroupId: identity?.source_acoustic_group_id || '',
  });
}

// Identity fields a segment must never keep from an earlier identity: a merge
// that left them would leave the segment claiming the old person or authority.
const IDENTITY_FIELDS = [
  'resolved_person',
  'display_name',
  'person_id',
  'confirmed_person_id',
  'confirmed_display_name',
  'confirmed_at',
  'confirmed_enrollment_id',
  'canonical_speaker_id',
  'identity_tier',
  'identity_confirmation_status',
  'identity_status',
  'identity_source',
  'confidence_tier',
  'confidence',
  'evidence',
  'voice_cluster_resolution_status',
  'denied_person_id',
  'denied_person_ids',
  'voice_check',
  'owner_track_decision',
  'mixed_by_owner',
  'voice_embedding_match',
];

/**
 * Write one track's identity into the call file (track and its segments).
 * Every identity field the old or new identity carried is replaced, never
 * merged, so the segments say exactly what the track says.
 */
function setTrackIdentity(enriched, label, identity) {
  enriched.speaker_identity_tracks ||= {};
  const previous = enriched.speaker_identity_tracks[String(label)] || {};
  enriched.speaker_identity_tracks[String(label)] = identity;
  const owned = new Set([...IDENTITY_FIELDS, ...Object.keys(previous), ...Object.keys(identity || {})]);
  for (const segment of enriched.segments || []) {
    if (String(segment?.speaker_model_label ?? '') !== String(label)) continue;
    const kept = { ...(segment.resolved_speaker || {}) };
    for (const field of owned) delete kept[field];
    segment.resolved_speaker = {
      ...kept,
      ...identity,
      otter_speaker: segment.resolved_speaker?.otter_speaker ?? String(label),
    };
  }
  return enriched;
}

/** Every person the owner denied on this track, from the single field or the list. */
function deniedPersonIds(identity) {
  return new Set(
    [identity?.denied_person_id, ...(Array.isArray(identity?.denied_person_ids) ? identity.denied_person_ids : [])]
      .map(canonicalPersonId)
      .filter(Boolean),
  );
}

/**
 * "Two people, skip" (owner decision): the track's clip holds two voices, so
 * it names no one. Unlike Neither, no person is denied (neither side is wrong
 * about who is in the call), and the owner tier plus owner_track_decision make
 * every automatic writer skip the track. With no person_id the reference
 * strengthener never enrolls it.
 */
function twoPeopleIdentity(identity, { decision }) {
  const voiceId = identity?.source_voice_cluster_id || null;
  const acousticId = identity?.source_acoustic_group_id || voiceId;
  return {
    ...identity,
    resolved_person: null,
    display_name: null,
    person_id: null,
    confirmed_person_id: null,
    confirmed_display_name: null,
    canonical_speaker_id: null,
    speaker_id: voiceId,
    voice_cluster_id: voiceId,
    unknown_speaker_id: acousticId,
    acoustic_unknown_id: acousticId,
    identity_tier: TWO_PEOPLE_TIER,
    identity_confirmation_status: TWO_PEOPLE_TIER,
    mixed_by_owner: true,
    confidence: 0,
    evidence: [
      ...new Set([...(Array.isArray(identity?.evidence) ? identity.evidence : []), OWNER_TRACK_DECISION_EVIDENCE]),
    ],
    owner_track_decision: decision,
  };
}

/**
 * True when an automatic writer must leave this track as it is: the owner clicked
 * it on the conflict queue, or the per-track check already judged the name the
 * writer would apply (or no name) on this call revision. A group writer
 * re-applying that name would undo the check. A different call revision, or a
 * different person, is new evidence and goes through.
 */
function trackCheckHolds(identity, { personId = null, sourceRevision = '' } = {}) {
  const record = identity?.owner_track_decision || identity?.voice_check;
  if (!record) return false;
  const revision = String(record.source_revision || '');
  if (revision && sourceRevision && revision !== String(sourceRevision)) return false;
  if (identity.owner_track_decision) return true;
  const incoming = canonicalPersonId(personId);
  if (!incoming) return true;
  return [identity.person_id, record.named_person_id, record.voice_person_id]
    .map(canonicalPersonId)
    .includes(incoming);
}

/**
 * True when the named person and the voice's person are the same canonical
 * person (a `person:` prefix or a registry alias is not a second person).
 * Such a pair is never a conflict, so it is never queued for the owner.
 */
function sameCanonicalPerson(a, b, aliases = null) {
  const resolve = (id) => {
    let cur = canonicalPersonId(id);
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const next = canonicalPersonId(aliases?.[cur]);
      if (!next || next === cur) break;
      cur = next;
    }
    return cur;
  };
  const left = resolve(a);
  return Boolean(left) && left === resolve(b);
}

/**
 * A call's date as YYYY-MM-DD. Recorder stores created_at as epoch seconds, so
 * the queue showed "1753716638" until 2026-10-28.
 */
function callDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  return s.slice(0, 10);
}

module.exports = {
  BELOW_BAR_EVIDENCE,
  IDENTITY_FIELDS,
  OWNER_TRACK_DECISION_EVIDENCE,
  TWO_PEOPLE_TIER,
  twoPeopleIdentity,
  PROBABLE_TIER,
  RENAME_EVIDENCE,
  callDate,
  sameCanonicalPerson,
  deniedPersonIds,
  isProbableIdentity,
  ownerDecidedIdentity,
  probableIdentity,
  renamedIdentity,
  restoredIdentity,
  setTrackIdentity,
  trackCheckHolds,
  trackNameCheck,
};
