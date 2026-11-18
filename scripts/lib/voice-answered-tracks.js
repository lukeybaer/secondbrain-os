'use strict';

// Nov 4 #otter (owner decision): "I just labeled everything ... Please track
// those actions." An answer is saved against the voice id that was on the card,
// but exact-receipt rows are re-keyed to a new canonical target and recluster
// rows are re-cut, so an id-keyed answer (dont_know included) stops matching
// and the same speaker comes back. The one identity that survives a re-key is
// the track itself: `otid|label`, one speaker on one call. Each answer records
// the track keys of the voice the owner saw (`trackKeys`); the queue builder drops a
// row once every one of its tracks has been answered, and keeps it while any
// track is new.
const { rowsFromQueue, rowMatchesId } = require('./voice-review-action-guard');

// Actions that settle who a track is. add_notes and keep_voiceprint say nothing
// about the speaker, and undo_two_people is handled as a reopen below.
const ANSWER_ACTIONS = new Set([
  'confirm',
  'correct',
  'link_person_file',
  'create_people_file',
  'not_them',
  'dont_know',
  'non_speech',
  'two_people',
  'ignore',
  'dismiss',
]);

// `<otid>|<label>` from a track key of either producer: the queue artifact
// writes `<otid>|<label>`, the recluster artifact `<otid>|<label>|<cluster>`.
// Empty when either part is missing, so a bare otid never becomes a track.
function normalizeTrackKey(raw) {
  const parts = String(raw == null ? '' : raw).split('|');
  const otid = String(parts[0] || '').trim();
  const label = String(parts[1] || '').trim();
  return otid && label ? `${otid}|${label}` : '';
}

function trackKeysFromRow(row) {
  const keys = new Set();
  for (const raw of Array.isArray(row?.member_track_keys) ? row.member_track_keys : []) {
    const key = normalizeTrackKey(raw);
    if (key) keys.add(key);
  }
  for (const member of Array.isArray(row?.exact_track_members) ? row.exact_track_members : []) {
    const key = normalizeTrackKey(`${member?.otid || ''}|${member?.speaker_model_label || ''}`);
    if (key) keys.add(key);
  }
  return [...keys];
}

// Every id a row answers to, including the ids an exact-receipt row was re-keyed
// away from (the signed receipt targets and the overlapping fragments).
function idsOfRow(row) {
  const ids = new Set();
  const add = (value) => {
    const id = String(value == null ? '' : value).trim();
    if (id) ids.add(id);
  };
  add(row?.acoustic_unknown_id);
  add(row?.voice_cluster_id);
  for (const id of Array.isArray(row?.voice_cluster_ids) ? row.voice_cluster_ids : []) add(id);
  for (const id of Array.isArray(row?.receipt_target_ids) ? row.receipt_target_ids : []) add(id);
  for (const id of Array.isArray(row?.overlapping_fragment_ids) ? row.overlapping_fragment_ids : [])
    add(id);
  for (const member of Array.isArray(row?.exact_track_members) ? row.exact_track_members : []) {
    add(member?.receipt_target);
    add(member?.canonical_target);
    for (const id of member?.current_voice_cluster_ids || []) add(id);
  }
  return [...ids];
}

// The fields a Save adds to its action record: the track keys of the voice that
// was on the card, limited to calls the browser actually rendered. Like
// otidsAtDecision, an absent or empty snapshot banks nothing, so a call that
// landed between render and click is never recorded as answered.
// ec2-server.js passes them through the record's `extra` field.
function answerTrackFields(queue, voiceClusterId, renderedOtids = null) {
  if (!queue || typeof queue !== 'object') return {};
  const rendered = new Set(
    (Array.isArray(renderedOtids) ? renderedOtids : [])
      .map((value) => String(value == null ? '' : value).trim())
      .filter(Boolean),
  );
  if (!rendered.size) return {};
  const keys = new Set();
  const rows = [
    ...rowsFromQueue(queue),
    // The older-backlog lane is answerable even before the action guard lists it.
    ...(Array.isArray(queue.older_backlog_voice_queue) ? queue.older_backlog_voice_queue : []),
  ];
  for (const row of rows) {
    if (!rowMatchesId(row, voiceClusterId)) continue;
    for (const key of trackKeysFromRow(row)) {
      if (rendered.has(key.split('|')[0])) keys.add(key);
    }
  }
  return keys.size ? { trackKeys: [...keys].sort() } : {};
}

// id -> Set(track keys) over the rows a build holds, so an answer recorded
// before track keys existed can be resolved through today's membership.
function trackKeysById(rows) {
  const byId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const keys = trackKeysFromRow(row);
    if (!keys.length) continue;
    for (const id of idsOfRow(row)) {
      const set = byId.get(id) || new Set();
      for (const key of keys) set.add(key);
      byId.set(id, set);
    }
  }
  return byId;
}

function explicitTrackKeys(action) {
  const raw = action?.trackKeys ?? action?.track_keys;
  return [...new Set((Array.isArray(raw) ? raw : []).map(normalizeTrackKey).filter(Boolean))];
}

// Answered tracks from the raw action ledger, newest answer per track wins.
//   - An answer with `trackKeys` uses them exactly.
//   - An older answer has none, so its tracks are the current members of the
//     cluster it named, limited to the calls the owner had on screen
//     (otidsAtDecision). Without that snapshot nothing is assumed.
// undo_two_people reopens the tracks the earlier two_people covered.
// Returns Map(trackKey -> { action, ts, voiceClusterId, requestId, exact }).
function answeredTrackIndex(actionRows, { idTracks = new Map() } = {}) {
  const rows = (Array.isArray(actionRows) ? actionRows : [])
    .filter((row) => row && row.voiceClusterId && row.action)
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        (Date.parse(a.row.ts || '') || 0) - (Date.parse(b.row.ts || '') || 0) || a.index - b.index,
    )
    .map(({ row }) => row);
  const answered = new Map();
  const twoPeopleTracks = new Map();
  for (const row of rows) {
    const action = String(row.action);
    const voiceClusterId = String(row.voiceClusterId);
    const exactKeys = explicitTrackKeys(row);
    let keys = exactKeys;
    if (!keys.length) {
      const otids = new Set(
        (Array.isArray(row.otidsAtDecision) ? row.otidsAtDecision : [])
          .map((value) => String(value == null ? '' : value).trim())
          .filter(Boolean),
      );
      if (otids.size) {
        keys = [...(idTracks.get(voiceClusterId) || [])].filter((key) =>
          otids.has(key.split('|')[0]),
        );
      }
    }
    if (action === 'undo_two_people') {
      for (const key of [...keys, ...(twoPeopleTracks.get(voiceClusterId) || [])]) {
        if (answered.get(key)?.action === 'two_people') answered.delete(key);
      }
      twoPeopleTracks.delete(voiceClusterId);
      continue;
    }
    if (!ANSWER_ACTIONS.has(action)) continue;
    for (const key of keys) {
      answered.set(key, {
        action,
        ts: String(row.ts || ''),
        voiceClusterId,
        requestId: String(row.gitPeopleSyncRequestId || ''),
        exact: exactKeys.length > 0,
      });
    }
    if (action === 'two_people') {
      twoPeopleTracks.set(voiceClusterId, [
        ...new Set([...(twoPeopleTracks.get(voiceClusterId) || []), ...keys]),
      ]);
    }
  }
  return answered;
}

// How much of a row the owner has already answered.
//   fully:      every track of the row has an answer, so asking again is a repeat
//   reopenable: every answer was a dont_know, the only answer a later post-save
//               voiceprint rematch may reopen (never a confirm or non-speech)
function answeredTrackStatus(row, answered) {
  const keys = trackKeysFromRow(row);
  if (!keys.length || !(answered instanceof Map) || !answered.size) {
    return { total: keys.length, answered: 0, fully: false, reopenable: false, hits: [] };
  }
  const hits = keys.map((key) => answered.get(key)).filter(Boolean);
  const fully = hits.length === keys.length;
  return {
    total: keys.length,
    answered: hits.length,
    fully,
    reopenable: fully && hits.every((hit) => hit.action === 'dont_know'),
    hits,
  };
}

module.exports = {
  ANSWER_ACTIONS,
  answerTrackFields,
  answeredTrackIndex,
  answeredTrackStatus,
  idsOfRow,
  normalizeTrackKey,
  trackKeysById,
  trackKeysFromRow,
};
