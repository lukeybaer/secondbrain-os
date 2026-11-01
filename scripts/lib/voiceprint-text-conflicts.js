'use strict';

// VOICEPRINT CONFLICTS WITH TEXT (owner decision voice recording).
//
// "I'm supposed to be able to see somewhere where the name was hypothesized,
//  or the name that you see clearly is the person being named, doesn't match
//  the voice print. Where does that show up on the system health? It should.
//  It should be voice print conflicts with text."
//
// That state already existed and was invisible. The whole-call marked-target
// name judge produces two verdicts that both mean the same owner-visible
// thing: the transcript confidently named a person who ALREADY has an
// enrolled voiceprint, and this speaker's acoustics did not match it. Text
// never overwrites the acoustic identity, so the row is parked -- silently,
// until now.
//
// This module owns the exact `system_health:voiceprint-text-conflicts`
// measurement plus the click-through review surface. It reuses the playback
// machinery that already exists (`/life-archive/voice-audio` for the clip,
// `/life-archive/voice-sequence` for the full per-target sequence player) and
// the write path that already reaches runVoiceConfirmationBackprop
// (`POST /briefing/voice-confirm`). It never invents a second player and
// never writes voice-review-validation-notes.jsonl, which nothing reads back.
//
// Never fabricate a count: a missing queue artifact reports UNAVAILABLE, and a
// clean run reports an explicit zero rather than disappearing from the card.

const fs = require('fs');
const path = require('path');

const VOICEPRINT_TEXT_CONFLICT_WORK_UNIT_ID = 'system_health:voiceprint-text-conflicts';
const VOICEPRINT_TEXT_CONFLICT_WORK_UNIT_NAME = 'Voiceprint conflicts with text';
const VOICEPRINT_NAME_HYPOTHESIS_WORK_UNIT_ID = 'system_health:voiceprint-name-hypotheses';
const VOICEPRINT_NAME_HYPOTHESIS_WORK_UNIT_NAME = 'Voiceprint name hypotheses awaiting identity';
const VOICEPRINT_TEXT_CONFLICT_REVIEW_PATH = '/life-archive/voiceprint-text-conflicts';
const VOICE_CONFIRM_ENDPOINT = '/briefing/voice-confirm';
const VOICE_CONFIRM_STATUS_ENDPOINT = '/briefing/voice-confirm-status';
const VOICE_CONFIRM_OWNER_ACTION_ENDPOINT = '/briefing/voice-confirm-owner-action';
const QUEUE_RELATIVE_PARTS = Object.freeze([
  'life-archive',
  'people',
  'briefing-voice-queue-latest.json',
]);
const QUEUE_FILE_NAME = 'briefing-voice-queue-latest.json';
// Cross-call wrong-name review (owner decision): "that's red if we have an
// error in the voice match... click into it and decide if it's a defect".
const GROUP_NAME_MISMATCH_LANE = 'group_name_mismatch_review_queue';
const GROUP_NAME_MISMATCH_DECISION_ENDPOINT = '/life-archive/voice-group-name-mismatch-decision';
const GROUP_NAME_MISMATCH_DECISIONS_PARTS = Object.freeze([
  'life-archive',
  'voiceprints',
  'voice-group-name-mismatch-decisions.jsonl',
]);

// Only a genuine contradiction belongs here. Keyed by status so the rendered
// explanation stays producer-true.
//
// Wording rule, same date: when the transcript carries a name and the voiceprint
// disagrees, the speaker is an UNKNOWN VOICE. The transcript was context about
// who might be present, never a claim about who was speaking, so no explanation
// may imply the text asserted the person and was contradicted.
const VOICEPRINT_TEXT_CONFLICT_REASONS = Object.freeze({
  known_name_needs_acoustic_confirmation:
    'the exact-receipt name hypothesis names a person with an enrolled voiceprint, but this acoustic identity did not match that voiceprint and remains an unknown voice',
  known_name_without_acoustic_match:
    'this acoustic cluster did not match the enrolled voiceprint for the name heard nearby, so it is an unknown voice rather than that person',
});
const VOICEPRINT_TEXT_CONFLICT_STATUSES = Object.freeze(
  Object.keys(VOICEPRINT_TEXT_CONFLICT_REASONS),
);

// Owner correction (owner decision): a TRUE voiceprint
// conflict needs a CONFIDENT acoustic match to a DIFFERENT enrollment, i.e.
// calibrated evidence and raw margin favoring another enrollment (pipeline
// invariant, dev-plans/core/otter-transcript-pipeline.md), disagreeing with a
// confident transcript name. An unknown voice that matched NO enrolled
// voiceprint plus a text name whose person has a print is the weaker category:
// a name hypothesis awaiting identity, never a voiceprint contradiction.
// Review-queue honesty is the point; the owner's attention is the scarce resource.
const TRUE_CONFLICT_BUCKET = 'true_conflict';
const NAME_HYPOTHESIS_BUCKET = 'name_hypothesis';

function normalizePersonKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^person:/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Producer-authored calibrated acoustic match evidence only. A true conflict
// cannot be inferred from prose, and absence of this evidence means the voice
// matched no enrollment.
function calibratedEnrollmentMatch(row) {
  const match =
    row?.calibrated_acoustic_match || row?.identity_guard?.calibrated_acoustic_match || null;
  if (!match || typeof match !== 'object') return null;
  const personId = String(match.person_id || match.display_name || '').trim();
  const score = Number(match.score);
  const margin = Number(match.margin);
  if (!personId || !Number.isFinite(score) || !Number.isFinite(margin) || margin <= 0) {
    return null;
  }
  return {
    personId,
    displayName: String(match.display_name || match.person_id || '').trim(),
    score,
    margin,
  };
}

function conflictBucketForRow(row) {

  const matched = calibratedEnrollmentMatch(row);
  if (!matched) return NAME_HYPOTHESIS_BUCKET;
  const named = normalizePersonKey(rowConflictName(row));
  if (
    named &&
    (named === normalizePersonKey(matched.displayName) ||
      named === normalizePersonKey(matched.personId))
  ) {
    // Acoustics agree with the heard name, so nothing contradicts anything.
    return NAME_HYPOTHESIS_BUCKET;
  }
  return TRUE_CONFLICT_BUCKET;
}

// Every lane the queue publishes. A conflicting voice can sit in more than one,
// so identity is the durable acoustic id, never the lane it was found in.
const QUEUE_LANES = Object.freeze([
  'unknown_voice_queue',
  'unresolved_voice_queue',
  'reviewable_voice_queue',
  'confirmation_queue',
  'recluster_repair_queue',
  'pending_name_judge_queue',
]);

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeOtterAudioPath(value) {
  const normalized = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!normalized) return '';
  if (normalized.startsWith('data/otter/audio/')) return normalized;
  const marker = '/data/otter/audio/';
  const index = normalized.toLowerCase().lastIndexOf(marker);
  if (index >= 0) return `data/otter/audio/${normalized.slice(index + marker.length)}`;
  return '';
}

function voiceAudioUrl(repoRelativePath) {
  const rel = normalizeOtterAudioPath(repoRelativePath);
  return rel ? `/life-archive/voice-audio?path=${encodeURIComponent(rel)}` : '';
}

function voiceSequenceUrl(voiceClusterId) {
  const id = String(voiceClusterId || '').trim();
  return id ? `/life-archive/voice-sequence?target=${encodeURIComponent(id)}` : '';
}

function rowVoiceClusterId(row) {
  return String(
    row?.acoustic_unknown_id ||
      row?.voice_cluster_id ||
      (Array.isArray(row?.voice_cluster_ids) ? row.voice_cluster_ids[0] : '') ||
      row?.unknown_speaker_id ||
      '',
  ).trim();
}

// Producer-authored names only. Prose in the judge rationale is never parsed
// back into a display name, because a parsed name is an invented name.
function rowConflictName(row) {
  return String(
    row?.name_judge_conflict_name ||
      row?.guess?.display_name ||
      row?.current_identity_hypothesis?.display_name ||
      row?.full_script_name_hypothesis?.display_name ||
      '',
  ).trim();
}

function conflictFromRow(row) {
  const status = String(row?.name_judge_status || '');
  const voiceClusterId = rowVoiceClusterId(row);
  const probeAudioPath = normalizeOtterAudioPath(row?.probe_audio_path);
  const audioUrl = voiceAudioUrl(probeAudioPath);
  const explicitlyUnreviewable = row?.reviewable === false;
  const playable = Boolean(audioUrl) && !explicitlyUnreviewable;
  const heardName = rowConflictName(row);
  return {
    voiceClusterId,
    status,
    bucket: conflictBucketForRow(row),
    matchedEnrollment: calibratedEnrollmentMatch(row),
    heardName,
    heardNameRecorded: Boolean(heardName),
    conflictReason: VOICEPRINT_TEXT_CONFLICT_REASONS[status] || '',
    calls: Number(row?.conversation_count || row?.calls || 0) || 0,
    probeAudioPath,
    audioUrl,
    playable,
    blockedReason: playable
      ? ''
      : !probeAudioPath
        ? 'no playable review clip has been mirrored for this voice yet'
        : String(row?.review_block_reason || '') === 'recluster_repair'
          ? 'no playable review clip until current recluster membership is rebuilt'
          : 'no playable review clip is currently available for this voice',
    sequenceReviewUrl: voiceSequenceUrl(voiceClusterId),
    firstSeen: String(row?.first_seen || ''),
    lastSeen: String(row?.last_seen || ''),
    rationale: String(row?.identity_evidence?.rationale || ''),
  };
}

/**
 * Measure the conflicts from an already-loaded queue artifact.
 * A missing or structurally unusable artifact is UNAVAILABLE, never zero.
 */
function collectVoiceprintTextConflicts({ queue, sourcePath = '' } = {}) {
  const unavailable = (reason) => ({
    available: false,
    reason,
    conflicts: [],
    conflictCount: null,
    trueConflictCount: null,
    nameHypothesisCount: null,
    playableCount: null,
    unplayableCount: null,
    judgedRowCount: null,
    sourcePath,
    generatedAt: '',
  });
  if (!queue || typeof queue !== 'object' || Array.isArray(queue)) {
    return unavailable(
      `${QUEUE_FILE_NAME} is unavailable, so the voiceprint/text conflict count cannot be measured.`,
    );
  }
  const lanes = QUEUE_LANES.filter((lane) => Array.isArray(queue[lane]));
  if (!lanes.length) {
    return unavailable(
      `${QUEUE_FILE_NAME} carries no voice review lanes, so the voiceprint/text conflict count cannot be measured.`,
    );
  }

  const seen = new Set();
  const conflicts = [];
  let judgedRowCount = 0;
  const judgedIds = new Set();
  for (const lane of lanes) {
    for (const row of queue[lane]) {
      const status = String(row?.name_judge_status || '');
      const voiceClusterId = rowVoiceClusterId(row);
      if (status && voiceClusterId && !judgedIds.has(voiceClusterId)) {
        judgedIds.add(voiceClusterId);
        judgedRowCount += 1;
      }
      if (!VOICEPRINT_TEXT_CONFLICT_STATUSES.includes(status)) continue;
      if (!voiceClusterId || seen.has(voiceClusterId)) continue;
      seen.add(voiceClusterId);
      conflicts.push(conflictFromRow(row));
    }
  }
  conflicts.sort(
    (a, b) =>
      b.calls - a.calls ||
      String(a.heardName).localeCompare(String(b.heardName)) ||
      a.voiceClusterId.localeCompare(b.voiceClusterId),
  );
  const playableCount = conflicts.filter((row) => row.playable).length;
  const trueConflictCount = conflicts.filter((row) => row.bucket === TRUE_CONFLICT_BUCKET).length;
  return {
    available: true,
    reason: '',
    conflicts,
    conflictCount: conflicts.length,
    trueConflictCount,
    nameHypothesisCount: conflicts.length - trueConflictCount,
    playableCount,
    unplayableCount: conflicts.length - playableCount,
    judgedRowCount,
    sourcePath,
    generatedAt: String(queue.generated_at || ''),
  };
}

// Group the per-track queue rows back into one review item per (group, heard
// name). A "not a defect" decision hides its item at once, before the next
// sweep runs. A queue built before the sweep existed is UNAVAILABLE, not zero.
function collectGroupNameMismatches({ queue, decisions = [] } = {}) {
  if (!queue || !Array.isArray(queue[GROUP_NAME_MISMATCH_LANE]) || !queue.group_name_mismatch_sweep_at) {
    // Carry why, so the row says which thing is wrong instead of one phrase
    // for every cause. "absent" means no sweep ever published into this queue.
    return {
      available: false,
      items: [],
      sweepAt: '',
      reason: String(queue?.group_name_mismatch_unavailable_reason || ''),
      sweepRanAt: String(queue?.group_name_mismatch_sweep_ran_at || ''),
      inlineError: String(queue?.group_name_mismatch_inline_sweep_error || ''),
      absent: !queue?.group_name_mismatch_sweep_ran_at && !Array.isArray(queue?.[GROUP_NAME_MISMATCH_LANE]),
    };
  }
  // A decision hides the tracks the owner reviewed, not the pair: a track the group
  // absorbs later still shows. A legacy decision without tracks hides the pair.
  const silenced = new Map();
  for (const row of decisions) {
    if (!row?.item_id) continue;
    const prior = silenced.get(row.item_id) || { all: false, tracks: new Set() };
    const keys = Array.isArray(row.track_keys) ? row.track_keys.filter(Boolean) : [];
    if (!keys.length) prior.all = true;
    for (const key of keys) prior.tracks.add(key);
    silenced.set(row.item_id, prior);
  }
  const byItem = new Map();
  for (const row of queue[GROUP_NAME_MISMATCH_LANE]) {
    const itemId = String(row?.item_id || '');
    const decided = silenced.get(itemId);
    if (!itemId || decided?.all || decided?.tracks.has(String(row.track_key || ''))) continue;
    if (!byItem.has(itemId)) {
      byItem.set(itemId, {
        itemId,
        groupId: String(row.group_id || ''),
        groupName: String(row.group_name || ''),
        groupPersonId: String(row.guess?.person_id || ''),
        groupSize: Number(row.group_size || 0),
        heardName: String(row.heard_name || ''),
        heardPeopleFiles: Array.isArray(row.heard_people_files) ? row.heard_people_files : [],
        hits: Number(row.item_hits || 0),
        calls: Number(row.item_calls || 0),
        tracks: [],
      });
    }
    const probeAudioPath = normalizeOtterAudioPath(row.probe_audio_path);
    byItem.get(itemId).tracks.push({
      voiceClusterId: String(row.voice_cluster_id || ''),
      trackKey: String(row.track_key || ''),
      otid: String(row.otid || ''),
      title: String(row.title || ''),
      date: String(row.date || ''),
      hits: Number(row.hits || 0),
      evidence: Array.isArray(row.evidence) ? row.evidence : [],
      judgeNamed: row.judge_named?.name
        ? { name: String(row.judge_named.name), judgedAt: String(row.judge_named.judged_at || '').slice(0, 10) }
        : null,
      audioUrl: voiceAudioUrl(probeAudioPath),
    });
  }
  const items = [...byItem.values()].sort((a, b) => b.hits - a.hits || a.itemId.localeCompare(b.itemId));
  return {
    available: true,
    items,
    sweepAt: String(queue.group_name_mismatch_sweep_at || ''),
    confirmedCalls: Number(queue.group_name_mismatch_confirmed_calls || 0),
    uncheckedCalls: Number(queue.group_name_mismatch_calls_unchecked || 0),
    // null when the queue predates the run stamp, so no proof line is invented.
    groupsChecked:
      queue.group_name_mismatch_groups_checked === undefined || queue.group_name_mismatch_groups_checked === null
        ? null
        : Number(queue.group_name_mismatch_groups_checked || 0),
    tracksChecked: Number(queue.group_name_mismatch_tracks_checked || 0),
  };
}

const MISMATCH_INPUT_NAMES = Object.freeze({
  recluster_unreadable: 'the voice recluster',
  registry_unreadable: 'the voice identity registry',
  contacts_unreadable: 'the People contacts folder',
  enriched_calls_unreadable: 'the enriched call transcripts',
  lineage_receipt_unreadable: 'the name-judge lineage receipt',
  lineage_history_unreadable: 'the name-judge lineage history',
});

// The unavailable wording is reason-specific, because "has not published" was
// wrong for most causes (owner decision): the sweep had run and found zero,
// but an incremental recluster had moved the generation after it. Unavailable
// stays red and never becomes a zero. forPage swaps the closing clause only.
function mismatchUnavailableText(mismatch, forPage = false) {
  const reasons = String(mismatch?.reason || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const ranDate = String(mismatch?.sweepRanAt || '').slice(0, 10);
  let clause;
  let closing = forPage ? 'so mixed voice groups cannot be listed' : 'so mixed voice groups cannot be counted';
  if (mismatch?.absent || (reasons.length === 1 && reasons[0] === 'sweep_missing')) {
    clause = 'the cross-call wrong-name sweep has never run on this data';
  } else if (reasons.length === 1 && reasons[0] === 'sweep_older_than_recluster') {
    clause = `the cross-call wrong-name sweep ${ranDate ? `last ran on ${ranDate}` : 'last ran'} against an older voice recluster than the live one`;
    closing += ' until it re-runs';
  } else if (reasons.length === 1 && reasons[0] === 'recluster_moved_during_build') {
    clause = 'the voice recluster moved while the voice review queue was being built';
    closing += ' until the next queue build re-checks them';
  } else if (reasons.length === 1 && reasons[0] === 'sweep_inline_failed') {
    const why = mismatch?.inlineError ? ` (${mismatch.inlineError})` : '';
    clause = `the cross-call wrong-name sweep failed when the voice review queue was built${why}`;
    closing += ' until it runs cleanly';
  } else if (reasons.length && reasons.every((reason) => MISMATCH_INPUT_NAMES[reason])) {
    const inputs = reasons.map((reason) => MISMATCH_INPUT_NAMES[reason]);
    clause = `the cross-call wrong-name sweep could not run (${inputs.join(' and ')} ${inputs.length === 1 ? 'is' : 'are'} unreadable)`;
  } else {
    clause = 'the cross-call wrong-name sweep has no result for the live voice recluster';
  }
  return `Unavailable: ${clause}, ${closing}.${forPage ? ' No zero is shown.' : ''}`;
}

// Proof that a zero came from a sweep that ran: how many confirmed voice groups
// and calls it covered, and when. Absent on queues built before the run stamp.
function mismatchSweepProof(mismatch) {
  if (!mismatch || !mismatch.available || mismatch.groupsChecked === null || mismatch.groupsChecked === undefined) return '';
  const groups = Number(mismatch.groupsChecked || 0);
  const calls = Number(mismatch.confirmedCalls || 0);
  const date = String(mismatch.sweepAt || '').slice(0, 10);
  return ` Sweep checked ${groups.toLocaleString()} confirmed voice group${groups === 1 ? '' : 's'} across ${calls.toLocaleString()} call${calls === 1 ? '' : 's'}${date ? ` on ${date}` : ''}.`;
}

// One "keep in the group" decision row. trackKeys narrows it to the tracks
// The owner answered, so an item that holds two people keeps its other tracks open.
// Every requested key must belong to the current item; omitted means all.
function groupNameMismatchDecisionRow({ itemId, rows, trackKeys, ts = new Date().toISOString() } = {}) {
  const current = (Array.isArray(rows) ? rows : []).filter((row) => row?.item_id === itemId);
  if (!current.length) return { error: 'this item is no longer in the current review queue; refresh the page', status: 409 };
  const known = current.map((row) => String(row.track_key || '')).filter(Boolean);
  let keys = known;
  if (trackKeys !== undefined) {
    if (!Array.isArray(trackKeys) || !trackKeys.length) return { error: 'trackKeys must list at least one track', status: 400 };
    keys = [...new Set(trackKeys.map((key) => String(key || '')))];
    const stray = keys.filter((key) => !known.includes(key));
    if (stray.length) return { error: `track not in this item: ${stray[0]}; refresh the page`, status: 409 };
  }
  return {
    row: {
      ts,
      item_id: itemId,
      decision: 'not_defect',
      group_id: current[0].group_id || '',
      group_name: current[0].group_name || '',
      heard_name: current[0].heard_name || '',
      track_keys: keys,
      source: 'briefing-dashboard',
    },
  };
}

function readGroupNameMismatchDecisions(dataDir, fsApi = fs) {
  try {
    return fsApi
      .readFileSync(path.join(String(dataDir || ''), ...GROUP_NAME_MISMATCH_DECISIONS_PARTS), 'utf8')
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

function readVoiceprintTextConflicts({ dataDir, fsApi = fs } = {}) {
  const queuePath = path.join(String(dataDir || ''), ...QUEUE_RELATIVE_PARTS);
  let queue = null;
  try {
    queue = JSON.parse(fsApi.readFileSync(queuePath, 'utf8'));
  } catch {
    queue = null;
  }
  const health = collectVoiceprintTextConflicts({
    queue,
    sourcePath: QUEUE_RELATIVE_PARTS.join('/'),
  });
  if (!health.available) return health;
  health.groupNameMismatches = collectGroupNameMismatches({
    queue,
    decisions: readGroupNameMismatchDecisions(dataDir, fsApi),
  });
  const actionsPath = path.join(
    String(dataDir || ''),
    'life-archive',
    'people',
    'voice-confirmation-actions.jsonl',
  );
  const tasksDir = path.join(String(dataDir || ''), 'tasks');
  const latestActionByVoice = new Map();
  const reviewHistory = [];
  try {
    for (const line of fsApi.readFileSync(actionsPath, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (row?.voiceClusterId && row?.gitPeopleSyncRequestId) {
        latestActionByVoice.set(String(row.voiceClusterId), row);
      }
    }
  } catch {
    // A missing action log simply means there are no owner decisions to project.
  }
  const existing = new Map(health.conflicts.map((row) => [row.voiceClusterId, row]));
  for (const [voiceClusterId, action] of latestActionByVoice) {
    const taskId = `voice-confirmation-${String(action.gitPeopleSyncRequestId).replace(/^voice-people-sync-/, '')}`;
    let task = null;
    try {
      task = JSON.parse(fsApi.readFileSync(path.join(tasksDir, `${taskId}.json`), 'utf8'));
    } catch {
      task = null;
    }
    if (!task) continue;
    if (task.status === 'done') {
      const priorConflict = existing.get(voiceClusterId);
      existing.delete(voiceClusterId);
      reviewHistory.push({
        ...(priorConflict || {
          voiceClusterId,
          status: 'owner_decision_resolved',
          bucket: NAME_HYPOTHESIS_BUCKET,
          matchedEnrollment: null,
          heardName: String(action.guessedName || action.correctedName || ''),
          heardNameRecorded: Boolean(action.guessedName || action.correctedName),
          conflictReason: 'The owner made an identity decision and Amy completed its backpropagation',
          calls: 0,
          probeAudioPath: '',
          audioUrl: '',
          playable: false,
          blockedReason:
            'the original single review clip is no longer required; the full sample history remains linked below',
          sequenceReviewUrl: voiceSequenceUrl(voiceClusterId),
          firstSeen: '',
          lastSeen: '',
          rationale: '',
        }),
        reviewJobId: action.gitPeopleSyncRequestId,
        reviewTaskStatus: task.status,
        reviewResult: String(task.resultSummary || 'Amy completed this decision.'),
        submittedAction: String(action.action || ''),
        resolvedAt: String(task.updatedAt || task.updated_at || action.ts || ''),
      });
      continue;
    }
    const conflict = existing.get(voiceClusterId) || {
      voiceClusterId,
      status: 'owner_decision_pending_acknowledgment',
      bucket: NAME_HYPOTHESIS_BUCKET,
      matchedEnrollment: null,
      heardName: String(action.guessedName || action.correctedName || ''),
      heardNameRecorded: Boolean(action.guessedName || action.correctedName),
      conflictReason:
        'The owner made a decision and Amy must show the applied result until the owner acknowledges it',
      calls: 0,
      probeAudioPath: '',
      audioUrl: '',
      playable: false,
      blockedReason: 'the original review clip is no longer needed for the completion decision',
      sequenceReviewUrl: voiceSequenceUrl(voiceClusterId),
      firstSeen: '',
      lastSeen: '',
      rationale: '',
    };
    existing.set(voiceClusterId, {
      ...conflict,
      reviewJobId: action.gitPeopleSyncRequestId,
      reviewTaskStatus: task.status,
      reviewResult: String(task.resultSummary || ''),
      submittedAction: String(action.action || ''),
    });
  }
  health.conflicts = [...existing.values()].sort(
    (a, b) => b.calls - a.calls || a.voiceClusterId.localeCompare(b.voiceClusterId),
  );
  health.conflictCount = health.conflicts.length;
  health.trueConflictCount = health.conflicts.filter(
    (row) => row.bucket === TRUE_CONFLICT_BUCKET,
  ).length;
  health.nameHypothesisCount = health.conflicts.length - health.trueConflictCount;
  health.playableCount = health.conflicts.filter((row) => row.playable).length;
  health.unplayableCount = health.conflicts.length - health.playableCount;
  health.reviewHistory = reviewHistory.sort((a, b) =>
    String(b.resolvedAt || '').localeCompare(String(a.resolvedAt || '')),
  );
  return health;
}

// The owner reads people, not cluster hashes. Name the people the metric can name,
// then say honestly how many conflicting voices carry no recorded heard name
// (older artifacts that predate the `name_judge_conflict_name` producer field).
function conflictNameList(conflicts, limit = 4) {
  const names = [
    ...new Set(conflicts.filter((row) => row.heardNameRecorded).map((row) => row.heardName)),
  ];
  const unnamed = conflicts.filter((row) => !row.heardNameRecorded).length;
  const shown = names.slice(0, limit).join(', ');
  const namedPart = names.length
    ? names.length > limit
      ? `${shown}, +${names.length - limit} more name${names.length - limit === 1 ? '' : 's'}`
      : shown
    : '';
  const unnamedPart = unnamed
    ? `${unnamed} with no recorded heard name in the current artifact`
    : '';
  return [namedPart, unnamedPart].filter(Boolean).join('; ') || 'no names recorded';
}

/**
 * The System Health measurement work units. Same shape as every sibling
 * metric: a stable id, a display name, a status, an actionable flag, and one
 * itemized proof detail. A healthy state stays visible with an explicit zero.
 *
 * Owner correction (owner decision): the counts are separated. A TRUE
 * conflict, calibrated acoustic evidence with raw margin favoring a different
 * enrollment than the confident heard name, stays red-worthy because it means
 * a possible misidentification. The name-hypothesis backlog, unknown voices
 * with no acoustic match whose transcript names an already-enrolled person, is
 * an advisory yellow count and never masquerades as conflicts.
 */
function voiceprintTextConflictWorkUnits(health) {
  if (!health) return [];
  if (!health.available) {
    return [
      {
        id: VOICEPRINT_TEXT_CONFLICT_WORK_UNIT_ID,
        name: VOICEPRINT_TEXT_CONFLICT_WORK_UNIT_NAME,
        status: 'red',
        actionable: true,
        detail: `Unavailable: ${health.reason || 'the voice review queue artifact could not be read, so conflicts cannot be counted.'}`,
      },
    ];
  }
  const conflicts = Array.isArray(health.conflicts) ? health.conflicts : [];
  const trueConflicts = conflicts.filter((row) => row.bucket === TRUE_CONFLICT_BUCKET);
  const judged = Number(health.judgedRowCount || 0);
  const judgedPhrase = `${judged.toLocaleString()} name-judged voice row${judged === 1 ? '' : 's'}`;
  const playableIn = (rows) => rows.filter((row) => row.playable).length;
  const units = [];
  // readVoiceprintTextConflicts always attaches the mixed-group result; a
  // health object built from the queue alone simply does not measure it.
  const mismatch = health.groupNameMismatches || null;
  const mismatchItems = mismatch?.items || [];
  // Confirmed calls with no readable transcript were not checked, so a zero
  // from the sweep is a lower bound, never green.
  const unchecked = mismatch?.available ? Number(mismatch.uncheckedCalls || 0) : 0;
  const uncheckedText = unchecked
    ? ` ${unchecked.toLocaleString()} of ${Number(mismatch.confirmedCalls || 0).toLocaleString()} confirmed-voice calls have no readable transcript, so they were not checked for this.`
    : '';
  if (mismatch && mismatch.available && !mismatchItems.length && unchecked && trueConflicts.length === 0) {
    units.push({
      id: VOICEPRINT_TEXT_CONFLICT_WORK_UNIT_ID,
      name: VOICEPRINT_TEXT_CONFLICT_WORK_UNIT_NAME,
      status: 'yellow',
      actionable: false,
      detail: `0 confirmed voice groups answering to another person's name in the calls checked, and 0 single-voice conflicts across ${judgedPhrase}.${uncheckedText} Until they are, the zero is a lower bound.${mismatchSweepProof(mismatch)}`,
    });
    return units;
  }
  if (mismatch && (!mismatch.available || mismatchItems.length)) {
    const what = !mismatch.available
      ? mismatchUnavailableText(mismatch)
      : `${mismatchItems.length.toLocaleString()} confirmed voice group${mismatchItems.length === 1 ? '' : 's'} answer${mismatchItems.length === 1 ? 's' : ''} to another person's name across calls (${mismatchItems
          .slice(0, 4)
          .map((item) => `${item.groupName} answers to ${item.heardName}`)
          .join('; ')}${mismatchItems.length > 4 ? `; +${mismatchItems.length - 4} more` : ''}); a second person may be mixed into a voiceprint.`;
    const trueText = trueConflicts.length
      ? ` Also ${trueConflicts.length.toLocaleString()} voice${trueConflicts.length === 1 ? '' : 's'} where calibrated acoustic evidence favors a different enrollment than the confident heard name (${conflictNameList(trueConflicts)}).`
      : ` 0 single-voice conflicts across ${judgedPhrase}.`;
    units.push({
      id: VOICEPRINT_TEXT_CONFLICT_WORK_UNIT_ID,
      name: VOICEPRINT_TEXT_CONFLICT_WORK_UNIT_NAME,
      status: 'red',
      actionable: true,
      detail: `${what}${trueText}${uncheckedText} Decide each one at ${VOICEPRINT_TEXT_CONFLICT_REVIEW_PATH}.`,
    });
    return units;
  }
  if (trueConflicts.length === 0) {
    units.push({
      id: VOICEPRINT_TEXT_CONFLICT_WORK_UNIT_ID,
      name: VOICEPRINT_TEXT_CONFLICT_WORK_UNIT_NAME,
      status: 'green',
      actionable: false,
      detail: `0 true conflicts where a confident acoustic match favors a different enrollment than a confident heard name, across ${judgedPhrase}${mismatch ? ", and 0 confirmed voice groups answering to another person's name" : ''}.${mismatchSweepProof(mismatch)}`,
    });
  } else {
    units.push({
      id: VOICEPRINT_TEXT_CONFLICT_WORK_UNIT_ID,
      name: VOICEPRINT_TEXT_CONFLICT_WORK_UNIT_NAME,
      status: 'red',
      actionable: true,
      detail: `${trueConflicts.length.toLocaleString()} voice${trueConflicts.length === 1 ? '' : 's'} where calibrated acoustic evidence with raw margin favors a different enrollment than the confident heard name (${conflictNameList(trueConflicts)}), across ${judgedPhrase}; a person may be misidentified. ${playableIn(trueConflicts)} playable for review, ${trueConflicts.length - playableIn(trueConflicts)} without a clip. Listen and correct them at ${VOICEPRINT_TEXT_CONFLICT_REVIEW_PATH}.`,
    });
  }
  // 2026-08-24 the owner: "I don't need to review where I don't know voices and know
  // names, in that one metric, I have the voice confirmation card for that."
  // The name-hypothesis backlog is NOT a measurement any more. It emits no work
  // unit, so it can never appear on his board as work. The hypothesis rows are
  // still classified above and still feed the voice_confirmation card and the
  // People projection; they simply stop asking the owner for a verdict here.
  return units;
}

function conflictCardHtml(conflict, index, { history = false } = {}) {
  const isTrueConflict = conflict.bucket === TRUE_CONFLICT_BUCKET;
  const matchedName = conflict.matchedEnrollment
    ? conflict.matchedEnrollment.displayName || conflict.matchedEnrollment.personId
    : '';
  const heading = isTrueConflict
    ? conflict.heardNameRecorded
      ? `Voice matched ${escapeHtml(matchedName)}, text says ${escapeHtml(conflict.heardName)}`
      : `Voice matched ${escapeHtml(matchedName)}, and no heard name is recorded for ${escapeHtml(conflict.voiceClusterId)}`
    : conflict.heardNameRecorded
      ? `Text names ${escapeHtml(conflict.heardName)}; this voice is still an unknown voice`
      : `Heard name is not recorded in this artifact for ${escapeHtml(conflict.voiceClusterId)}`;
  const why = isTrueConflict
    ? `Why this is a true conflict: calibrated acoustic evidence favors ${escapeHtml(matchedName)} with raw margin ${escapeHtml(String(conflict.matchedEnrollment.margin))}, while the transcript confidently names ${escapeHtml(conflict.heardName || 'a different person')}. One of the two is wrong.`
    : `Why this is an unknown voice, not a voiceprint conflict: ${escapeHtml(conflict.conflictReason || 'this acoustic cluster did not match the enrolled voiceprint for the name heard nearby, so it is an unknown voice rather than that person')}.`;
  const player = conflict.playable
    ? `<audio class="conflict-audio" controls preload="none" src="${escapeHtml(conflict.audioUrl)}"></audio>`
    : `<p class="conflict-blocked">This voice has ${escapeHtml(conflict.blockedReason)}. Nothing is playable here yet, so no player is shown.</p>`;
  const sequence = conflict.sequenceReviewUrl
    ? `<p class="conflict-sequence"><a href="${escapeHtml(conflict.sequenceReviewUrl)}" target="_blank" rel="noopener">Open every sample for this voice</a></p>`
    : '';
  const rationale = conflict.rationale
    ? `<p class="conflict-rationale">${escapeHtml(conflict.rationale)}</p>`
    : '';
  const ownerReview = conflict.reviewJobId
    ? `<div class="conflict-owner-review" data-job-id="${escapeHtml(conflict.reviewJobId)}"><p class="conflict-result">${escapeHtml(conflict.reviewResult || 'Amy is applying this decision.')}</p><div class="conflict-owner-actions"${conflict.reviewTaskStatus === 'awaiting-review' ? '' : ' hidden'}><button type="button" data-owner-action="done">Acknowledge and clear</button><input type="text" class="conflict-feedback" placeholder="Or tell Amy what is still wrong" /><button type="button" data-owner-action="feedback">Send feedback</button></div></div>`
    : '';
  return `<article class="conflict${history ? ' conflict-history' : ''}" data-item="${escapeHtml(conflict.voiceClusterId)}" data-voice-cluster-id="${escapeHtml(conflict.voiceClusterId)}" data-heard-name="${escapeHtml(conflict.heardName)}"${conflict.reviewJobId && !history ? ` data-job-id="${escapeHtml(conflict.reviewJobId)}"` : ''}>
  <header>
    <span class="conflict-rank">${index + 1}</span>
    <h2>${heading}</h2>
  </header>
  <p class="conflict-why">${why}</p>
  <p class="conflict-meta">${conflict.calls.toLocaleString()} call${conflict.calls === 1 ? '' : 's'} &middot; <code>${escapeHtml(conflict.voiceClusterId)}</code>${conflict.lastSeen ? ` &middot; last heard ${escapeHtml(conflict.lastSeen)}` : ''}</p>
  ${rationale}
  ${player}
  ${sequence}
  <div class="conflict-actions"${conflict.reviewJobId ? ' hidden' : ''}>
    <button type="button" data-voice-action="not_them">No, this is not ${escapeHtml(conflict.heardName || 'that person')}</button>
    <button type="button" data-voice-action="confirm"${conflict.playable ? '' : ' disabled'}>Yes, that is ${escapeHtml(conflict.heardName || 'this person')}</button>
    <button type="button" data-voice-action="dont_know">Not sure</button>
    <button type="button" data-voice-action="two_people">Two people, skip</button>
  </div>
  <div class="conflict-correct"${conflict.reviewJobId ? ' hidden' : ''}>
    <input type="text" class="conflict-name" placeholder="Or type who this actually is" />
    <button type="button" data-voice-action="correct"${conflict.playable ? '' : ' disabled'}>Save the corrected name</button>
  </div>
  ${ownerReview}
  <p class="conflict-status" role="status">${escapeHtml(conflict.reviewJobId ? conflict.reviewResult || 'Amy is applying this decision.' : '')}</p>
</article>`;
}

// One mixed-group item: the exchanges where other speakers named the heard
// person and this group's track answered, a clip per track, and the two
// per-track answer. Owner decision: "Defect / Not a defect" was confusing
// and one item can hold two different people, so every track asks "who is
// talking?" with the group person, the heard person and "someone else".
// Moving a track goes through the normal Save path, which also records
// "not <group person>"; keeping a track records not_defect for that track only.
function mismatchCardHtml(item, index) {
  const files = item.heardPeopleFiles || [];
  const fileName = (rel) => String(rel).replace(/^memory\/contacts\//, '').replace(/\.md$/, '').replace(/_/g, ' ');
  const picker = files.length > 1
    ? `<select class="mismatch-file">${files.map((rel) => `<option value="${escapeHtml(rel)}">${escapeHtml(fileName(rel))}</option>`).join('')}</select>`
    : files.length === 1
      ? `<input type="hidden" class="mismatch-file" value="${escapeHtml(files[0])}" />`
      : '';
  const tracks = item.tracks
    .map((track, trackIndex) => {
      const quotes = track.evidence
        .map((row) => `<blockquote><span class="who">Other speaker:</span> &hellip;${escapeHtml(row.text)}<br /><span class="who">This voice replied:</span> ${escapeHtml(row.reply_text)}</blockquote>`)
        .join('');
      const player = track.audioUrl
        ? `<audio class="conflict-audio" controls preload="none" src="${escapeHtml(track.audioUrl)}"></audio>`
        : '<p class="conflict-blocked">No clip mirrored for this track yet; the quotes are the evidence.</p>';
      const named = track.judgeNamed
        ? `<p class="conflict-why">The name judge heard this voice as ${escapeHtml(track.judgeNamed.name)}${track.judgeNamed.judgedAt ? ` on ${escapeHtml(track.judgeNamed.judgedAt)}` : ''}, before it was grouped with ${escapeHtml(item.groupName)}.</p>`
        : '';
      const answered = track.hits > 0 ? ` &middot; answered to ${escapeHtml(item.heardName)} ${track.hits}&times;` : ' &middot; named by the name judge';
      const radio = `who-${escapeHtml(item.itemId)}-${trackIndex}`;
      const choices = [
        `<label><input type="radio" name="${radio}" value="group" /> ${escapeHtml(item.groupName)}</label>`,
        files.length ? `<label><input type="radio" name="${radio}" value="heard" /> ${escapeHtml(item.heardName)}</label>${picker}` : '',
        `<label><input type="radio" name="${radio}" value="other" /> Someone else</label>`,
        `<input type="text" class="mismatch-other-name" placeholder="Who? Leave blank if you don't know" hidden />`,
      ].join('');
      return `<li class="mismatch-track" data-voice-cluster-id="${escapeHtml(track.voiceClusterId)}" data-track-key="${escapeHtml(track.trackKey || '')}">
      <p class="mismatch-track-title">${escapeHtml(track.date)} &middot; ${escapeHtml(track.title || track.otid)}${answered}</p>
      ${named}
      ${player}
      ${quotes}
      <fieldset class="mismatch-who"><legend>Who is talking on this track?</legend>${choices}</fieldset>
    </li>`;
    })
    .join('\n');
  return `<article class="conflict mismatch" data-item="${escapeHtml(item.itemId)}" data-item-id="${escapeHtml(item.itemId)}" data-group-name="${escapeHtml(item.groupName)}" data-group-id="${escapeHtml(item.groupId)}" data-heard-name="${escapeHtml(item.heardName)}">
  <header>
    <span class="conflict-rank">${index + 1}</span>
    <h2>${escapeHtml(item.groupName)}'s voice group answers to ${escapeHtml(item.heardName)}</h2>
  </header>
  <p class="conflict-why">${item.hits > 0
    ? `On ${item.tracks.length} track${item.tracks.length === 1 ? '' : 's'} across ${item.calls} call${item.calls === 1 ? '' : 's'}, another speaker said "${escapeHtml(item.heardName)}" and the next voice to talk was this group's speaker, ${item.hits} times, and that track never answered to ${escapeHtml(item.groupName)}.`
    : `On ${item.tracks.length} track${item.tracks.length === 1 ? '' : 's'} across ${item.calls} call${item.calls === 1 ? '' : 's'}, the name judge heard this voice as ${escapeHtml(item.heardName)} before it was grouped with ${escapeHtml(item.groupName)}, and the track never answered to ${escapeHtml(item.groupName)}.`} ${escapeHtml(item.groupName)}'s group holds ${item.groupSize} tracks. Listen, then decide.</p>
  <ul class="mismatch-tracks">${tracks}</ul>
  <div class="conflict-actions">
    <button type="button" data-mismatch-action="save">Save answers</button>
  </div>
  <p class="subtle">Tracks you leave unanswered stay here for later. "${escapeHtml(item.groupName)}" keeps the track where it is. ${files.length ? `"${escapeHtml(item.heardName)}" moves it to ${escapeHtml(item.heardName)}'s People file.` : `No People file named ${escapeHtml(item.heardName)} exists yet, so to move a track to ${escapeHtml(item.heardName)}, pick "Someone else" and type the name; Amy creates the file.`} "Someone else" takes it out of ${escapeHtml(item.groupName)}'s group, under the name you type or as unknown.</p>
  <p class="conflict-status" role="status"></p>
</article>`;
}

/**
 * The click-through the owner asked for: the conflicting voices, each playable,
 * each with a "no, you're wrong" that flows into the People file through the
 * write path that already exists.
 */
function renderVoiceprintTextConflictReviewHtml({ health, date = '' } = {}) {
  const available = Boolean(health?.available);
  const conflicts = Array.isArray(health?.conflicts) ? health.conflicts : [];
  const reviewHistory = Array.isArray(health?.reviewHistory) ? health.reviewHistory : [];
  const trueConflicts = conflicts.filter((row) => row.bucket === TRUE_CONFLICT_BUCKET);
  const truePlayable = trueConflicts.filter((row) => row.playable).length;
  const judgedPhrase = `${Number(health?.judgedRowCount || 0).toLocaleString()} name-judged voice rows`;
  const banner = !available
    ? `<p class="banner banner-bad">Unavailable: ${escapeHtml(health?.reason || 'the voice review queue artifact could not be read.')} No count is shown, because an invented zero would be worse than an honest gap.</p>`
    : trueConflicts.length === 0
      ? `<p class="banner banner-ok">No voiceprint conflicts right now. Every confident acoustic match agreed with the confident heard name across ${judgedPhrase}.</p>`
      : `<p class="banner banner-bad">${trueConflicts.length.toLocaleString()} voiceprint conflict${trueConflicts.length === 1 ? '' : 's'}, where calibrated acoustic evidence favors a different enrollment than the confident heard name. ${truePlayable} playable, ${trueConflicts.length - truePlayable} waiting on a clip.</p>`;
  const trueCards = available
    ? trueConflicts.map((row, index) => conflictCardHtml(row, index)).join('\n')
    : '';
  const historyCards = available
    ? reviewHistory.map((row, index) => conflictCardHtml(row, index, { history: true })).join('\n')
    : '';
  const mismatch = health?.groupNameMismatches || null;
  const mismatchSection = !available || !mismatch
    ? ''
    : !mismatch.available
      ? `<p class="banner banner-bad">${escapeHtml(mismatchUnavailableText(mismatch, true))}</p>`
      : mismatch.items.length
        ? mismatch.items.map((item, index) => mismatchCardHtml(item, index)).join('\n')
        : mismatch.uncheckedCalls
          ? `<p class="banner banner-warn">No confirmed voice group answers to another person's name in the calls checked. ${Number(mismatch.uncheckedCalls).toLocaleString()} confirmed-voice calls have no readable transcript and were not checked, so this is a lower bound.</p>`
          : '<p class="banner banner-ok">No confirmed voice group answers to another person\'s name right now.</p>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Voiceprint conflicts with text</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; background: #f4f7f3; color: #1f2320; line-height: 1.45; }
  main { max-width: 940px; margin: 0 auto; padding: 24px 18px 48px; }
  h1 { font-size: 25px; margin: 0 0 6px; }
  .banner { border-radius: 8px; padding: 12px 14px; margin: 12px 0 20px; }
  .banner-ok { background: #e4f7f2; border: 1px solid #0f766e; }
  .banner-bad { background: #fff3ec; border: 1px solid #9a3412; }
  .banner-warn { background: #fdf7e7; border: 1px solid #a16207; }
  h3 { font-size: 20px; margin: 18px 0 6px; }
  .conflict { background: #fffef9; border: 1px solid #d7ddd7; border-radius: 8px; padding: 14px 16px; margin-bottom: 14px; }
  .conflict header { display: flex; align-items: baseline; gap: 10px; }
  .conflict h2 { font-size: 18px; margin: 0 0 4px; }
  .conflict-rank { color: #666f68; font-variant-numeric: tabular-nums; }
  .conflict-why, .conflict-meta, .conflict-rationale { color: #3d443e; font-size: 14px; margin: 4px 0; }
  .conflict-blocked { background: #fff3ec; border: 1px solid #9a3412; border-radius: 6px; padding: 8px 10px; font-size: 14px; }
  .conflict-audio { width: 100%; margin: 8px 0; }
  .conflict-actions, .conflict-correct { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  button { font: inherit; padding: 7px 12px; border-radius: 6px; border: 1px solid #0f766e; background: #e4f7f2; cursor: pointer; }
  button[disabled] { opacity: 0.5; cursor: not-allowed; }
  input { font: inherit; padding: 7px 10px; border-radius: 6px; border: 1px solid #d7ddd7; flex: 1 1 240px; }
  .conflict-status { font-size: 14px; min-height: 20px; margin: 8px 0 0; }
  .conflict-owner-review { margin-top: 10px; padding: 10px; border: 1px solid #0f766e; border-radius: 6px; background: #eefaf6; }
  .conflict-owner-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .conflict-owner-actions[hidden] { display: none; }
  .conflict-actions[hidden], .conflict-correct[hidden] { display: none; }
  .conflict-feedback { min-width: 260px; }
  .mismatch-tracks { list-style: none; padding: 0; margin: 8px 0; display: grid; gap: 10px; }
  .mismatch-track { border-top: 1px solid #d7ddd7; padding-top: 8px; }
  .mismatch-track blockquote { margin: 6px 0 0; padding: 6px 10px; border-left: 3px solid #a16207; background: #fdf7e7; font-size: 14px; }
  .mismatch-track .who { color: #666f68; font-size: 13px; }
  .mismatch-track-title { font-weight: 600; margin: 0 0 4px; }
  .mismatch-who { border: 1px solid #d7ddd7; border-radius: 6px; margin: 8px 0 0; padding: 6px 10px; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
  .mismatch-who legend { font-size: 14px; font-weight: 600; padding: 0 4px; }
  .mismatch-who label { display: inline-flex; gap: 6px; align-items: center; }
  .mismatch-who input[type="text"] { flex: 1 1 220px; }
  .mismatch-who input[hidden] { display: none; }
  select { font: inherit; padding: 7px 10px; border-radius: 6px; border: 1px solid #d7ddd7; }
  code { background: #e9eee8; border-radius: 5px; padding: 2px 5px; overflow-wrap: anywhere; }
</style>
</head>
<body>
<main>
  <h1>Voiceprint conflicts with text</h1>
  <p class="subtle">One situation lives here: a confident acoustic match that disagrees with a confident transcript name, so someone may be misidentified. Every verdict saves through the same review flow into the People file.</p>
  <p class="subtle">Unknown voices carrying only a heard name are deliberately NOT on this page. Owner decision: "I don't need to review where I don't know voices and know names, in that one metric, I have the voice confirmation card for that." Those rows still feed the voice confirmation card and the People projection; they are reviewed there, not here.</p>
  ${banner}
  <section aria-labelledby="mixed-group-heading">
    <h2 id="mixed-group-heading">Voice groups answering to another name</h2>
    <p class="subtle">A confirmed voice group can quietly absorb a second person. Here, across several calls, this group's tracks answer when someone else is named and never when the group's own person is named. Nothing changes until you decide. For each track, pick who is actually talking, then Save answers.</p>
    ${mismatchSection}
  </section>
  <section aria-labelledby="pending-review-heading">
    <h2 id="pending-review-heading">Waiting for the owner now</h2>
    <p class="subtle">Calibrated acoustic evidence, with raw margin, says this voice belongs to one enrolled person while the transcript confidently names a different person. One of the two is wrong. A verdict here corrects a possible misidentification and flows into the People file.</p>
    ${trueCards || '<p class="banner banner-ok">No voiceprint conflicts right now.</p>'}
  </section>
  <section aria-labelledby="review-history-heading">
    <h2 id="review-history-heading">Already reviewed and resolved</h2>
    <p class="subtle">These decisions are history, not current red. Open every sample to hear the complete voice sequence and read the surrounding call context retained for review.</p>
    ${historyCards || '<p class="banner banner-ok">No resolved voice decisions are available in the current action ledger.</p>'}
  </section>
</main>
<script>
(function () {
  var endpoint = ${JSON.stringify(VOICE_CONFIRM_ENDPOINT)};
  var statusEndpoint = ${JSON.stringify(VOICE_CONFIRM_STATUS_ENDPOINT)};
  var ownerActionEndpoint = ${JSON.stringify(VOICE_CONFIRM_OWNER_ACTION_ENDPOINT)};
  var briefingDate = ${JSON.stringify(String(date || ''))};
  function showJob(card, result) {
    var status = card.querySelector('.conflict-status');
    var owner = card.querySelector('.conflict-owner-review');
    if (!owner) {
      owner = document.createElement('div');
      owner.className = 'conflict-owner-review';
      owner.innerHTML = '<p class="conflict-result"></p><div class="conflict-owner-actions" hidden><button type="button" data-owner-action="done">Acknowledge and clear</button><input type="text" class="conflict-feedback" placeholder="Or tell Amy what is still wrong" /><button type="button" data-owner-action="feedback">Send feedback</button></div>';
      status.parentNode.insertBefore(owner, status);
    }
    owner.setAttribute('data-job-id', result.jobId || card.getAttribute('data-job-id') || '');
    card.setAttribute('data-job-id', result.jobId || card.getAttribute('data-job-id') || '');
    var text = result.result || (result.jobStatus === 'failed' ? 'Amy found a defect and opened an exact repair.' : 'Amy is applying this decision.');
    owner.querySelector('.conflict-result').textContent = text;
    status.textContent = text;
    owner.querySelector('.conflict-owner-actions').hidden = !result.reviewReady;
    if (result.acknowledged) card.remove();
  }
  function pollJob(card) {
    var jobId = card.getAttribute('data-job-id');
    if (!jobId) return;
    fetch(statusEndpoint + '?jobId=' + encodeURIComponent(jobId))
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result || result.ok !== true) throw new Error((result && result.error) || 'status unavailable');
        showJob(card, result);
        if (!result.reviewReady && !result.acknowledged) window.setTimeout(function () { pollJob(card); }, 3000);
      })
      .catch(function (error) {
        card.querySelector('.conflict-status').textContent = 'Decision saved, but live status is unavailable: ' + error.message;
        window.setTimeout(function () { pollJob(card); }, 10000);
      });
  }
  document.querySelectorAll('.conflict[data-job-id]').forEach(pollJob);
  var mismatchEndpoint = ${JSON.stringify(GROUP_NAME_MISMATCH_DECISION_ENDPOINT)};
  function postJson(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result || result.ok !== true) throw new Error((result && result.error) || 'unknown server error');
        return result;
      });
  }
  document.addEventListener('change', function (event) {
    var radio = event.target.closest('.mismatch-who input[type="radio"]');
    if (!radio) return;
    var box = radio.closest('.mismatch-who').querySelector('.mismatch-other-name');
    if (box) box.hidden = radio.value !== 'other';
  });
  document.addEventListener('click', function (event) {
    var mismatchButton = event.target.closest('button[data-mismatch-action]');
    if (mismatchButton) {
      var item = mismatchButton.closest('.mismatch');
      var itemStatus = item.querySelector('.conflict-status');
      var groupName = item.getAttribute('data-group-name') || '';
      var heardName = item.getAttribute('data-heard-name') || '';
      var answers = Array.prototype.slice.call(item.querySelectorAll('.mismatch-track'))
        .map(function (li) {
          var chosen = li.querySelector('.mismatch-who input[type="radio"]:checked');
          if (!chosen || chosen.disabled) return null;
          return {
            li: li,
            who: chosen.value,
            voiceClusterId: li.getAttribute('data-voice-cluster-id'),
            trackKey: li.getAttribute('data-track-key') || '',
            file: (li.querySelector('.mismatch-file') || {}).value || '',
            otherName: ((li.querySelector('.mismatch-other-name') || {}).value || '').trim()
          };
        })
        .filter(Boolean);
      if (!answers.length) { itemStatus.textContent = 'Pick who is talking on at least one track first.'; return; }
      // Freeze every answer while saving, so what is shown is what was sent.
      var controls = Array.prototype.slice.call(item.querySelectorAll('.mismatch-who input, .mismatch-who select'));
      controls.forEach(function (control) { control.disabled = true; });
      mismatchButton.disabled = true;
      var lock = function (answer) { answer.li.setAttribute('data-saved', '1'); };
      var unfreeze = function () {
        Array.prototype.slice.call(item.querySelectorAll('.mismatch-track')).forEach(function (li) {
          if (li.getAttribute('data-saved') === '1') return;
          li.querySelectorAll('.mismatch-who input, .mismatch-who select').forEach(function (control) { control.disabled = false; });
        });
      };
      var saved = 0;
      itemStatus.textContent = 'Saving\u2026';
      var keep = answers.filter(function (a) { return a.who === 'group'; });
      var first = keep.length
        ? postJson(mismatchEndpoint, { itemId: item.getAttribute('data-item-id'), decision: 'not_defect', trackKeys: keep.map(function (a) { return a.trackKey; }) })
          .then(function () { keep.forEach(lock); saved += keep.length; })
        : Promise.resolve();
      answers.filter(function (a) { return a.who !== 'group'; }).reduce(function (chain, answer) {
        return chain.then(function () {
          var body = {
            date: briefingDate,
            section: 'SYSTEM HEALTH / VOICE GROUP ANSWERS TO ANOTHER NAME',
            voiceClusterId: answer.voiceClusterId,
            guessedName: groupName
          };
          if (answer.who === 'heard') { body.action = 'link_person_file'; body.personFilePath = answer.file; }
          else if (answer.otherName) { body.action = 'correct'; body.correctedName = answer.otherName; body.correctedNameWasTyped = true; }
          else { body.action = 'not_them'; }
          return postJson(endpoint, body).then(function () {
            lock(answer);
            saved += 1;
            itemStatus.textContent = 'Saved ' + saved + ' of ' + answers.length + '\u2026';
          });
        });
      }, first)
        .then(function () {
          unfreeze();
          var left = item.querySelectorAll('.mismatch-track:not([data-saved])').length;
          itemStatus.textContent = 'Saved ' + saved + ' track' + (saved === 1 ? '' : 's') + '. Amy is applying each one.' + (left ? ' Unanswered tracks stay here.' : ' This item clears on the next sweep.');
          mismatchButton.disabled = left === 0;
        })
        .catch(function (error) {
          unfreeze();
          mismatchButton.disabled = false;
          itemStatus.textContent = 'Not saved: ' + (saved ? saved + ' saved, then ' : '') + error.message + '. Click Save answers again to retry the rest.';
        });
      return;
    }
    // Undo two people: takes back only that answer and only its own clip mark.
    var undoButton = event.target.closest('button[data-undo-two-people]');
    if (undoButton) {
      var undoCard = undoButton.closest('.conflict');
      var undoStatus = undoCard.querySelector('.conflict-status');
      undoButton.disabled = true;
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: briefingDate,
          section: 'SYSTEM HEALTH / VOICEPRINT CONFLICTS WITH TEXT',
          voiceClusterId: undoCard.getAttribute('data-voice-cluster-id'),
          action: 'undo_two_people',
          undoesRequestId: undoButton.getAttribute('data-undo-two-people')
        })
      }).then(function (r) { return r.json(); }).then(function (result) {
        if (!result || result.ok !== true) throw new Error((result && result.error) || 'unknown server error');
        undoButton.remove();
        undoCard.setAttribute('data-job-id', result.jobId);
        undoCard.querySelectorAll('button[data-voice-action]').forEach(function (b) { b.disabled = false; });
        undoStatus.textContent = 'Undone. Amy is taking back the Two people answer; answer this voice again when ready.';
        pollJob(undoCard);
      }).catch(function (error) {
        undoButton.disabled = false;
        undoStatus.textContent = 'Undo not saved: ' + error.message + '. Click Undo again.';
      });
      return;
    }
    var ownerButton = event.target.closest('button[data-owner-action]');
    if (ownerButton) {
      var ownerCard = ownerButton.closest('.conflict');
      var ownerAction = ownerButton.getAttribute('data-owner-action');
      var feedback = (ownerCard.querySelector('.conflict-feedback') || {}).value || '';
      if (ownerAction === 'feedback' && !feedback.trim()) {
        ownerCard.querySelector('.conflict-status').textContent = 'Write the feedback first.';
        return;
      }
      ownerButton.disabled = true;
      fetch(ownerActionEndpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: ownerCard.getAttribute('data-job-id'), action: ownerAction, comment: feedback.trim() })
      }).then(function (r) { return r.json(); }).then(function (result) {
        if (!result || result.ok !== true) throw new Error((result && result.error) || 'owner action failed');
        if (ownerAction === 'done') ownerCard.remove();
        else { ownerCard.querySelector('.conflict-status').textContent = 'Feedback sent. Amy reopened the same task.'; pollJob(ownerCard); }
      }).catch(function (error) {
        ownerButton.disabled = false;
        ownerCard.querySelector('.conflict-status').textContent = 'Could not save review: ' + error.message;
      });
      return;
    }
    var button = event.target.closest('button[data-voice-action]');
    if (!button) return;
    var card = button.closest('.conflict');
    if (!card) return;
    var status = card.querySelector('.conflict-status');
    var action = button.getAttribute('data-voice-action');
    var typed = (card.querySelector('.conflict-name') || {}).value || '';
    if (action === 'correct' && !typed.trim()) {
      status.textContent = 'Type who this actually is first.';
      return;
    }
    button.disabled = true;
    status.textContent = 'Saving\\u2026';
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: briefingDate,
        section: 'SYSTEM HEALTH / VOICEPRINT CONFLICTS WITH TEXT',
        voiceClusterId: card.getAttribute('data-voice-cluster-id'),
        action: action,
        guessedName: card.getAttribute('data-heard-name') || '',
        correctedName: action === 'correct' ? typed.trim() : '',
        correctedNameWasTyped: action === 'correct',
        // Two people marks the exact clip the owner heard, so send the one he played.
        reviewedClip: action === 'two_people' && card.querySelector('.conflict-audio')
          ? card.querySelector('.conflict-audio').getAttribute('src') || ''
          : ''
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result || result.ok !== true) {
          var failure = new Error((result && result.error) || 'unknown server error');
          failure.staleQueue = Boolean(result && result.code === 'voice_not_reviewable');
          throw failure;
        }
        card.setAttribute('data-job-id', result.jobId);
        status.textContent = 'Saved. Amy is applying this exact decision and will show what changed here.';
        card.querySelectorAll('button[data-voice-action]').forEach(function (b) { b.disabled = true; });
        if (action === 'two_people' && !card.querySelector('button[data-undo-two-people]')) {
          var undo = document.createElement('button');
          undo.type = 'button';
          undo.setAttribute('data-undo-two-people', result.jobId);
          undo.textContent = 'Undo two people';
          status.parentNode.insertBefore(undo, status.nextSibling);
        }
        pollJob(card);
      })
      .catch(function (error) {
        button.disabled = false;
        var message = error && error.message ? error.message : 'unknown error';
        // A rotated-out voice needs a fresh page, not a blind re-click.
        status.textContent = error && error.staleQueue
          ? 'Not saved: ' + message + '.'
          : 'Not saved: ' + message + '. Click again to retry.';
      });
  });
})();
</script>
</body>
</html>`;
}

// Owner decision: one voice-review button on the board header (beside News
// topics) and on the failing System Health line, red only while a voice
// decision is waiting on him. Pending = undecided wrong-name groups plus true
// single-voice conflicts, the same items the review page asks him to judge.
// Null means the count cannot be read, which is not the same as zero. A true
// conflict counts only while the owner can act on it: undecided, or awaiting his ack.
function voiceReviewPendingCount(health) {
  if (!health || !health.available) return null;
  const mismatch = health.groupNameMismatches;
  if (!mismatch || !mismatch.available || !Array.isArray(mismatch.items)) return null;
  const conflicts = (Array.isArray(health.conflicts) ? health.conflicts : [])
    .filter((row) => row.bucket === TRUE_CONFLICT_BUCKET
      && (!row.reviewJobId || row.reviewTaskStatus === 'awaiting-review')).length;
  return mismatch.items.length + conflicts;
}

// Pure and self-contained: the board ships this function to the browser, which
// re-asks /briefing/voice-review-status on load, so a durable dashboard
// snapshot never shows a stale red or idle button (Codex 2a3f5ffd16e5).
function voiceReviewButtonState(pending, label) {
  const known = pending !== null && pending !== undefined && pending !== '' && Number.isFinite(Number(pending));
  const count = known ? Math.max(0, Math.floor(Number(pending))) : 0;
  return {
    known,
    count,
    text: !known ? label + ' (status unknown)' : count ? label + ' (' + count + ' waiting)' : label,
    title: !known
      ? 'Voice decisions could not be counted right now'
      : count ? count + ' voice decision' + (count === 1 ? '' : 's') + ' waiting for you' : 'No voice decisions waiting',
    stateClass: !known ? 'voice-review-btn-unknown' : count ? 'voice-review-btn-pending' : '',
  };
}

function voiceReviewButtonHtml(pending, { className = 'top-btn', label = 'Voice review' } = {}) {
  const classes = String(className).split(/\s+/).filter((token) => /^[A-Za-z][\w-]*$/.test(token)).join(' ') || 'top-btn';
  const state = voiceReviewButtonState(pending, label);
  return `<a class="${classes} voice-review-btn${state.stateClass ? ' ' + state.stateClass : ''}" href="${VOICEPRINT_TEXT_CONFLICT_REVIEW_PATH}" target="_blank" rel="noopener" data-voice-review-pending="${state.known ? state.count : 'unknown'}" data-voice-review-label="${escapeHtml(label)}" title="${escapeHtml(state.title)}">${escapeHtml(state.text)}</a>`;
}

module.exports = {
  NAME_HYPOTHESIS_BUCKET,
  QUEUE_RELATIVE_PARTS,
  TRUE_CONFLICT_BUCKET,
  VOICEPRINT_NAME_HYPOTHESIS_WORK_UNIT_ID,
  VOICEPRINT_NAME_HYPOTHESIS_WORK_UNIT_NAME,
  VOICEPRINT_TEXT_CONFLICT_REASONS,
  VOICEPRINT_TEXT_CONFLICT_REVIEW_PATH,
  VOICEPRINT_TEXT_CONFLICT_STATUSES,
  VOICEPRINT_TEXT_CONFLICT_WORK_UNIT_ID,
  VOICEPRINT_TEXT_CONFLICT_WORK_UNIT_NAME,
  GROUP_NAME_MISMATCH_DECISION_ENDPOINT,
  GROUP_NAME_MISMATCH_DECISIONS_PARTS,
  GROUP_NAME_MISMATCH_LANE,
  collectGroupNameMismatches,
  groupNameMismatchDecisionRow,
  collectVoiceprintTextConflicts,
  conflictBucketForRow,
  normalizeOtterAudioPath,
  readVoiceprintTextConflicts,
  renderVoiceprintTextConflictReviewHtml,
  voiceAudioUrl,
  voiceSequenceUrl,
  voiceprintTextConflictWorkUnits,
  voiceReviewButtonHtml,
  voiceReviewButtonState,
  voiceReviewPendingCount,
};
