'use strict';

// VOICEPRINT CONFLICTS WITH TEXT (ExampleCo 2026-08-16 voice recording).
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

// Owner correction (ExampleCo, 2026-08-24, live review surface): a TRUE voiceprint
// conflict needs a CONFIDENT acoustic match to a DIFFERENT enrollment, i.e.
// calibrated evidence and raw margin favoring another enrollment (pipeline
// invariant, dev-plans/core/otter-transcript-pipeline.md), disagreeing with a
// confident transcript name. An unknown voice that matched NO enrolled
// voiceprint plus a text name whose person has a print is the weaker category:
// a name hypothesis awaiting identity, never a voiceprint contradiction.
// Review-queue honesty is the point; ExampleCo's attention is the scarce resource.
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
          conflictReason: 'ExampleCo made an identity decision and Amy completed its backpropagation',
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
        'ExampleCo made a decision and Amy must show the applied result until ExampleCo acknowledges it',
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

// ExampleCo reads people, not cluster hashes. Name the people the metric can name,
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
 * Owner correction (ExampleCo, 2026-08-24): the counts are separated. A TRUE
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
  if (trueConflicts.length === 0) {
    units.push({
      id: VOICEPRINT_TEXT_CONFLICT_WORK_UNIT_ID,
      name: VOICEPRINT_TEXT_CONFLICT_WORK_UNIT_NAME,
      status: 'green',
      actionable: false,
      detail: `0 true conflicts where a confident acoustic match favors a different enrollment than a confident heard name, across ${judgedPhrase}.`,
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
  // 2026-08-24 ExampleCo: "I don't need to review where I don't know voices and know
  // names, in that one metric, I have the voice confirmation card for that."
  // The name-hypothesis backlog is NOT a measurement any more. It emits no work
  // unit, so it can never appear on his board as work. The hypothesis rows are
  // still classified above and still feed the voice_confirmation card and the
  // People projection; they simply stop asking ExampleCo for a verdict here.
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
  </div>
  <div class="conflict-correct"${conflict.reviewJobId ? ' hidden' : ''}>
    <input type="text" class="conflict-name" placeholder="Or type who this actually is" />
    <button type="button" data-voice-action="correct"${conflict.playable ? '' : ' disabled'}>Save the corrected name</button>
  </div>
  ${ownerReview}
  <p class="conflict-status" role="status">${escapeHtml(conflict.reviewJobId ? conflict.reviewResult || 'Amy is applying this decision.' : '')}</p>
</article>`;
}

/**
 * The click-through ExampleCo asked for: the conflicting voices, each playable,
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
  code { background: #e9eee8; border-radius: 5px; padding: 2px 5px; overflow-wrap: anywhere; }
</style>
</head>
<body>
<main>
  <h1>Voiceprint conflicts with text</h1>
  <p class="subtle">One situation lives here: a confident acoustic match that disagrees with a confident transcript name, so someone may be misidentified. Every verdict saves through the same review flow into the People file.</p>
  <p class="subtle">Unknown voices carrying only a heard name are deliberately NOT on this page. ExampleCo, 2026-08-24: "I don't need to review where I don't know voices and know names, in that one metric, I have the voice confirmation card for that." Those rows still feed the voice confirmation card and the People projection; they are reviewed there, not here.</p>
  ${banner}
  <section aria-labelledby="pending-review-heading">
    <h2 id="pending-review-heading">Waiting for ExampleCo now</h2>
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
  document.addEventListener('click', function (event) {
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
        correctedNameWasTyped: action === 'correct'
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
  collectVoiceprintTextConflicts,
  conflictBucketForRow,
  normalizeOtterAudioPath,
  readVoiceprintTextConflicts,
  renderVoiceprintTextConflictReviewHtml,
  voiceAudioUrl,
  voiceSequenceUrl,
  voiceprintTextConflictWorkUnits,
};
