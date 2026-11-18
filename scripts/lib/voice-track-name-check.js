'use strict';

// Per-track voice check (owner decision; rule raised 2026-11-08).
//
// A name only counts on a track whose own voice clears the naming bar for that
// person. A track whose voice clears the bar for someone else is renamed on a
// new call; any other track keeps the name as "probably" while its own voice
// reaches the probable floor, and loses it below that. "Probably" never goes
// back to a name. The bar is the shared referenceMatchDecision, so this check
// can never accept what the resolver would reject.
//
// The owner's own decisions are never checked: they are the authority.

const {
  NEEDS_RECONFIRMATION_TIER,
  applyCanonicalSpeakerIdentity,
  canonicalPersonId,
  isConfirmedIdentityStatus,
  isNeedsReconfirmationTier,
  isOwnerConfirmedTier,
} = require('./canonical-speaker-identity');

const PROBABLE_TIER = 'probable_reference_voiceprint_match';
const RENAME_EVIDENCE = 'per_track_voice_rename';
const BELOW_BAR_EVIDENCE = 'per_track_voice_below_bar';
const NAME_REMOVED_EVIDENCE = 'per_track_voice_name_removed';
const OWNER_TRACK_DECISION_EVIDENCE = 'owner_track_decision';
const OWNER_CLEARED_ANSWER = 'cleared_for_rename';
const TWO_PEOPLE_TIER = 'two_people_by_owner';
// Confirmed statuses a probable track must not keep in any status field.
const STATUS_FIELDS = ['identity_confirmation_status', 'identity_status', 'confidence_tier', 'status'];

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
 * The name stays on the track, marked probable. The prior confirmed tier is kept
 * on voice_check as a record of what the track said; nothing raises the track
 * back from it.
 */
function probableIdentity(identity, { check, match = null, at, source, sourceRevision } = {}) {
  const next = { ...identity };
  const priorTier = isProbableIdentity(identity)
    ? identity.voice_check?.prior_tier || null
    : String(identity?.identity_tier || '') || null;
  next.identity_tier = PROBABLE_TIER;
  for (const field of STATUS_FIELDS) {
    if (isConfirmedIdentityStatus(next[field])) next[field] = PROBABLE_TIER;
  }
  if (isConfirmedIdentityStatus(next.voice_cluster_resolution_status)) {
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

/**
 * The name comes off the track. The dropped name and its reason stay on
 * voice_check, and every field that could carry the person back is cleared:
 * a stray `person:` id would otherwise re-name the track on the next pass.
 */
function unnamedIdentity(identity, { check, match = null, at, source, sourceRevision } = {}) {
  const clean = (value) => (value && !/^person:/i.test(String(value)) ? value : null);
  const voiceId = clean(identity?.source_voice_cluster_id) || clean(identity?.voice_cluster_id) || null;
  const acousticId =
    clean(identity?.source_acoustic_group_id) ||
    clean(identity?.acoustic_unknown_id) ||
    clean(identity?.unknown_speaker_id) ||
    voiceId;
  const priorTier = isProbableIdentity(identity)
    ? identity.voice_check?.prior_tier || PROBABLE_TIER
    : String(identity?.identity_tier || '') || null;
  const next = {
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
    identity_tier: 'durable_unknown_voice',
    identity_confirmation_status: 'durable_unknown_voice',
    confidence: 0,
  };
  for (const field of STATUS_FIELDS) {
    if (next[field] != null && next[field] !== '') next[field] = 'durable_unknown_voice';
  }
  if (next.voice_cluster_resolution_status != null) next.voice_cluster_resolution_status = 'durable_unknown_voice';
  for (const field of ['confirmed_at', 'confirmed_enrollment_id', 'voice_embedding_match', 'registry_resolution_id']) {
    delete next[field];
  }
  next.evidence = [...new Set([...(Array.isArray(identity?.evidence) ? identity.evidence : []), NAME_REMOVED_EVIDENCE])];
  next.voice_check = {
    ...voiceCheckRecord({ check, match, namedPersonId: identity?.person_id, at, source, sourceRevision }),
    prior_tier: priorTier,
  };
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
function ownerDecidedIdentity(identity, { personId, displayName, answer, at, sourceRevision, trackEvidence = null }) {
  const decision = {
    answer,
    decided_at: at || new Date().toISOString(),
    source: 'voice-name-conflict-queue',
    source_revision: String(sourceRevision || ''),
  };
  // What the track looked like when the owner clicked, so a later call revision can
  // prove it still holds the same speaker before the click is carried forward.
  if (trackEvidence) decision.track_evidence = trackEvidence;
  // A fresh click settles any earlier re-confirmation request on this track.
  if (identity?.needs_reconfirmation) {
    identity = { ...identity };
    delete identity.needs_reconfirmation;
  }
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
  'owner_group_hold',
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
 * "Just clear the speaker id and I'll re-name it later" (owner decision).
 * The track names no one and no person is denied, so his later click can name
 * anyone, including the person it read before. owner_track_decision makes every
 * automatic writer skip it until then; ownerRenameLiftsClear is the one way out.
 */
function ownerClearedIdentity(identity, { at, sourceRevision, trackEvidence = null, source = 'owner-direct-clear' }) {
  const voiceId = identity?.source_voice_cluster_id || null;
  const acousticId = identity?.source_acoustic_group_id || voiceId;
  const next = {
    ...identity,
    resolved_person: null,
    display_name: null,
    person_id: null,
    confirmed_person_id: null,
    confirmed_display_name: null,
    confirmed_at: null,
    confirmed_enrollment_id: null,
    canonical_speaker_id: null,
    speaker_id: voiceId,
    voice_cluster_id: voiceId,
    unknown_speaker_id: acousticId,
    acoustic_unknown_id: acousticId,
    identity_tier: 'durable_unknown_voice',
    identity_confirmation_status: 'durable_unknown_voice',
    identity_status: 'durable_unknown_voice',
    confidence_tier: 'durable_unknown_voice',
    voice_cluster_resolution_status: 'left_unknown_by_owner',
    identity_source: OWNER_TRACK_DECISION_EVIDENCE,
    confidence: 0,
    evidence: [OWNER_TRACK_DECISION_EVIDENCE],
    owner_track_decision: {
      answer: OWNER_CLEARED_ANSWER,
      decided_at: at || new Date().toISOString(),
      source,
      source_revision: String(sourceRevision || ''),
      ...(trackEvidence ? { track_evidence: trackEvidence } : {}),
    },
  };
  delete next.voice_check;
  delete next.voice_embedding_match;
  return next;
}

/**
 * True when this resolution is the owner's own answer, made after he cleared the
 * track. Only his click ends a clear: a machine status, or a row carried over
 * from a group, does not.
 */
function ownerRenameLiftsClear(identity, resolution) {
  const decision = identity?.owner_track_decision;
  if (decision?.answer !== OWNER_CLEARED_ANSWER) return false;
  if (String(resolution?.status || '') !== 'confirmed_by_owner' || !resolution?.person_id) return false;
  if (resolution.derived_from_acoustic_group) return false;
  const answeredAt = Date.parse(String(resolution.updated_at || ''));
  const clearedAt = Date.parse(String(decision.decided_at || ''));
  return Number.isFinite(answeredAt) && Number.isFinite(clearedAt) && answeredAt > clearedAt;
}

/**
 * True when the track is the owner's: he clicked it on the conflict queue, or it
 * waits for his re-confirmation after a call revision. No automatic writer
 * (group resolver, recluster, per-track check) may rename such a track.
 */
function ownerHeldIdentity(identity) {
  return Boolean(identity?.owner_track_decision) || isNeedsReconfirmationTier(identity?.identity_tier);
}

/**
 * A speaker whose name came from the owner's group or cluster confirmation when the
 * naming rule was applied keeps its label on that revision. A new revision can
 * hold different audio, so the hold lapses with it, and a stamp for another
 * person means the track has since changed hands.
 */
function ownerGroupHoldStands(identity, sourceRevision = '') {
  const hold = identity?.owner_group_hold;
  if (!hold) return false;
  if (canonicalPersonId(hold.person_id) !== canonicalPersonId(identity?.person_id)) return false;
  const revision = String(hold.source_revision || '');
  return !(revision && sourceRevision && revision !== String(sourceRevision));
}

/**
 * True when an automatic writer must leave this track as it is: the owner clicked
 * it on the conflict queue (or it waits for his re-confirmation), or the
 * per-track check already judged the name the writer would apply (or no name)
 * on this call revision. A group writer re-applying that name would undo the
 * check. A different person is new evidence and goes through.
 *
 * The revision cutoff applies only to the machine check: its voice verdict was
 * computed on the audio of an older revision, and a revised transcript can
 * change which audio a track holds. The owner's own click never lapses with the
 * revision (state-machine audit #17); reconcileOwnerTrackRevision carries it
 * forward or asks him again.
 */
function trackCheckHolds(identity, { personId = null, sourceRevision = '' } = {}) {
  if (ownerHeldIdentity(identity)) return true;
  const incomingPerson = canonicalPersonId(personId);
  if (
    ownerGroupHoldStands(identity, sourceRevision) &&
    (!incomingPerson || incomingPerson === canonicalPersonId(identity.person_id))
  ) {
    return true;
  }
  const record = identity?.voice_check;
  if (!record) return false;
  const revision = String(record.source_revision || '');
  if (revision && sourceRevision && revision !== String(sourceRevision)) return false;
  const incoming = canonicalPersonId(personId);
  if (!incoming) return true;
  return [identity.person_id, record.named_person_id, record.voice_person_id]
    .map(canonicalPersonId)
    .includes(incoming);
}

// A carried confirmation needs this much of the track's speaking time to still
// fall inside the time ranges the owner confirmed it on (both ways).
const MIN_RANGE_OVERLAP = 0.8;
// The most intervals one evidence record keeps; it is copied onto every segment
// of the track, so it stays small on a long call.
const MAX_EVIDENCE_INTERVALS = 160;

// Merges intervals that overlap or lie within `gap` seconds. Evidence uses gap
// 0 only: a wider gap would count silence, or another speaker's turn, as this
// track's speech (Codex review of batch 2, F1).
function mergeIntervals(intervals, gap) {
  const sorted = intervals.map((pair) => [...pair]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start - last[1] <= gap) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

function totalSeconds(ranges) {
  return Number(ranges.reduce((sum, [a, b]) => sum + (b - a), 0).toFixed(1));
}

// Keeps a record small by dropping intervals, never by widening them: the kept
// ranges are always a subset of the real speech, so a bound can lose evidence
// but never invent it. The longest turns stay (earliest first on a tie), in
// time order, so two revisions of one call keep nearly the same turns.
function boundIntervals(intervals, max = MAX_EVIDENCE_INTERVALS) {
  if (intervals.length <= max) return intervals;
  return intervals
    .map((pair, index) => ({ pair, index, length: pair[1] - pair[0] }))
    .sort((a, b) => b.length - a.length || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.pair);
}

/**
 * The speaking time ranges of one track label, from the call's segments:
 * { intervals: [[start, end], ...], speech_seconds }. Only turns that touch or
 * overlap are merged, so every second in `intervals` is real speech of this
 * label. A call with more than MAX_EVIDENCE_INTERVALS separate turns keeps the
 * longest ones (`intervals_sampled`); `speech_seconds` stays the label's real
 * total.
 */
function trackSpeakingRanges(enriched, label) {
  const raw = [];
  for (const segment of enriched?.segments || []) {
    if (String(segment?.speaker_model_label ?? '') !== String(label)) continue;
    const start = Number(segment.start_seconds);
    const end = Number(segment.end_seconds);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      raw.push([Number(start.toFixed(1)), Number(end.toFixed(1))]);
    }
  }
  const merged = mergeIntervals(raw, 0);
  const intervals = boundIntervals(merged);
  const range = { intervals, speech_seconds: totalSeconds(merged) };
  if (intervals.length < merged.length) range.intervals_sampled = true;
  return range;
}

// Seconds both sets of ranges cover. Each side is merged first, so a range
// listed twice counts once and the result never exceeds either side's total.
function overlapSeconds(left, right) {
  const a = mergeIntervals(left, 0);
  const b = mergeIntervals(right, 0);
  let total = 0;
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    const lo = Math.max(a[i][0], b[j][0]);
    const hi = Math.min(a[i][1], b[j][1]);
    if (hi > lo) total += hi - lo;
    if (a[i][1] < b[j][1]) i += 1;
    else j += 1;
  }
  return total;
}

/** What a decision records about the track it was made on. */
function trackEvidenceOf(enriched, label, identity = null) {
  const track = identity || enriched?.speaker_identity_tracks?.[String(label)] || {};
  return {
    source_revision: String(enriched?.source_revision || ''),
    source_voice_cluster_id: track.source_voice_cluster_id || null,
    source_acoustic_group_id: track.source_acoustic_group_id || null,
    ...trackSpeakingRanges(enriched, label),
  };
}

function clusterIdsOf(values) {
  return [
    ...new Set(
      values
        .map((value) => String(value || '').trim())
        .filter((value) => value && !/^person:/i.test(value)),
    ),
  ];
}

/**
 * Does the track on a newer call revision still hold the speaker the owner
 * confirmed? Any one of three kinds of evidence proves it:
 *   same_track_identity  the revision gives the track the same voice cluster
 *                        or acoustic group the click was made on
 *   voiceprint_match     the revision's own voiceprint check for the track
 *                        clears the bar for the confirmed person
 *   time_range_overlap   at least MIN_RANGE_OVERLAP of the speaking time still
 *                        falls in the ranges the click was made on
 * `current` is what the new revision says about the track, independent of the
 * identity record: { cluster_ids, voice_person_id, intervals }.
 */
function sameSpeakerEvidence({ decision, identity, current = {}, aliases = null }) {
  const before = decision?.track_evidence || {};
  const recorded = [before.source_voice_cluster_id, before.source_acoustic_group_id];
  // A click recorded before evidence snapshots existed was made on the ids the
  // identity carried then.
  const beforeIds = clusterIdsOf(
    recorded.some(Boolean) ? recorded : [identity?.source_voice_cluster_id, identity?.source_acoustic_group_id],
  );
  const nowIds = clusterIdsOf(current.cluster_ids || []);
  if (beforeIds.some((id) => nowIds.includes(id))) return { mapped: true, basis: 'same_track_identity' };
  if (current.voice_person_id && sameCanonicalPerson(current.voice_person_id, identity?.person_id, aliases)) {
    return { mapped: true, basis: 'voiceprint_match' };
  }
  const oldRanges = mergeIntervals(Array.isArray(before.intervals) ? before.intervals : [], 0);
  const newRanges = mergeIntervals(Array.isArray(current.intervals) ? current.intervals : [], 0);
  if (oldRanges.length && newRanges.length) {
    const inter = overlapSeconds(oldRanges, newRanges);
    const oldTotal = totalSeconds(oldRanges);
    const newTotal = totalSeconds(newRanges);
    if (oldTotal > 0 && newTotal > 0 && Math.min(inter / oldTotal, inter / newTotal) >= MIN_RANGE_OVERLAP) {
      return { mapped: true, basis: 'time_range_overlap' };
    }
    return { mapped: false, reason: 'speaking_time_moved' };
  }
  return { mapped: false, reason: 'no_matching_evidence' };
}

/**
 * The owner's name decision on a track whose call has a newer source revision. His
 * confirmation is never dropped silently: it is carried forward when the new
 * revision still maps the track to the same speaker evidence, and otherwise
 * the track moves to the needs-reconfirmation tier with the old confirmed name
 * kept on `needs_reconfirmation`. Decisions that name no one (Neither, Two
 * people) keep holding as they are.
 * Returns { action: 'none' | 'carry' | 'needs_reconfirmation', identity, proof }.
 */
function reconcileOwnerTrackRevision(identity, { sourceRevision = '', current = {}, at, aliases = null } = {}) {
  const decision = identity?.owner_track_decision;
  const revision = String(sourceRevision || '');
  const decidedRevision = String(decision?.source_revision || '');
  const namesSomeone =
    (decision?.answer === 'name' || decision?.answer === 'voice') &&
    Boolean(canonicalPersonId(identity?.person_id)) &&
    isOwnerConfirmedTier(identity?.identity_tier);
  if (!namesSomeone || !revision || !decidedRevision || decidedRevision === revision) {
    return { action: 'none', identity };
  }
  const when = at || new Date().toISOString();
  const proof = sameSpeakerEvidence({ decision, identity, current, aliases });
  const intervals = Array.isArray(current.intervals) ? current.intervals : [];
  if (proof.mapped) {
    return {
      action: 'carry',
      proof,
      identity: {
        ...identity,
        owner_track_decision: {
          ...decision,
          source_revision: revision,
          carried_from_revision: decision.carried_from_revision || decidedRevision,
          carried_at: when,
          carried_basis: proof.basis,
          track_evidence: {
            source_revision: revision,
            source_voice_cluster_id: identity.source_voice_cluster_id || null,
            source_acoustic_group_id: identity.source_acoustic_group_id || null,
            intervals,
            speech_seconds: Number.isFinite(current.speech_seconds)
              ? current.speech_seconds
              : totalSeconds(mergeIntervals(intervals, 0)),
            ...(current.intervals_sampled ? { intervals_sampled: true } : {}),
          },
        },
      },
    };
  }
  const next = { ...identity, identity_tier: NEEDS_RECONFIRMATION_TIER };
  for (const field of STATUS_FIELDS) {
    if (isConfirmedIdentityStatus(next[field])) next[field] = NEEDS_RECONFIRMATION_TIER;
  }
  if (isConfirmedIdentityStatus(next.voice_cluster_resolution_status)) {
    next.voice_cluster_resolution_status = NEEDS_RECONFIRMATION_TIER;
  }
  // The old click stays on owner_track_decision; this records what it confirmed.
  next.needs_reconfirmation = {
    since: when,
    reason: proof.reason,
    from_revision: decidedRevision,
    to_revision: revision,
    prior_tier: String(identity.identity_tier || ''),
    prior_person_id: canonicalPersonId(identity.person_id) || null,
    prior_display_name: identity.confirmed_display_name || identity.display_name || identity.resolved_person || null,
    prior_decided_at: decision.decided_at || null,
  };
  delete next.confirmed_person_id;
  delete next.confirmed_display_name;
  delete next.confirmed_at;
  return { action: 'needs_reconfirmation', proof, identity: next };
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
  MIN_RANGE_OVERLAP,
  IDENTITY_FIELDS,
  NAME_REMOVED_EVIDENCE,
  OWNER_TRACK_DECISION_EVIDENCE,
  TWO_PEOPLE_TIER,
  twoPeopleIdentity,
  PROBABLE_TIER,
  RENAME_EVIDENCE,
  callDate,
  sameCanonicalPerson,
  deniedPersonIds,
  isProbableIdentity,
  ownerGroupHoldStands,
  ownerDecidedIdentity,
  OWNER_CLEARED_ANSWER,
  ownerClearedIdentity,
  ownerHeldIdentity,
  ownerRenameLiftsClear,
  reconcileOwnerTrackRevision,
  sameSpeakerEvidence,
  trackEvidenceOf,
  trackSpeakingRanges,
  probableIdentity,
  renamedIdentity,
  setTrackIdentity,
  trackCheckHolds,
  trackNameCheck,
  unnamedIdentity,
};
