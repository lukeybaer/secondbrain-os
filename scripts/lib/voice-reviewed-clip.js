'use strict';

/**
 * The exact clip the owner judged when he answered "Two people, skip" on a voice
 * review card (Codex review ac814107d300, F2). The clip is fixed at the click:
 * its path, byte hash and size are written into the durable action record, and
 * the applier marks that clip only after it proves the same bytes are still on
 * disk. The review queue and roster are rebuilt between the click and the
 * apply, so reading the clip from them at apply time could mark a different
 * clip than the one the owner heard.
 *
 * Also owns the "Undo two people" lookup, so the endpoint and the applier find
 * the undone Save the same way.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CLIP_PREFIX = 'data/otter/audio/';
// Additive owner actions: never an answer that replaces another.
const NON_DECISION_ACTIONS = new Set(['add_notes', 'keep_voiceprint']);

/**
 * 'data/otter/audio/...' from a repo path, an absolute path or a
 * `/life-archive/voice-audio?path=...` player URL. '' when it is not an
 * Recorder audio clip or tries to leave that folder.
 */
function reviewedClipRel(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  const query = s.indexOf('?');
  if (query >= 0) {
    const params = new URLSearchParams(s.slice(query + 1));
    s = params.get('path') || '';
  }
  s = s.replace(/\\/g, '/');
  const i = s.indexOf('otter/audio/');
  if (i < 0) return '';
  const rel = `data/${s.slice(i)}`;
  if (rel.split('/').some((part) => part === '..' || part === '.')) return '';
  return rel.startsWith(CLIP_PREFIX) && rel.length > CLIP_PREFIX.length ? rel : '';
}

/** Absolute file for a 'data/otter/audio/...' rel under one data dir. */
function reviewedClipAbs(dataDir, rel) {
  return path.join(dataDir, rel.slice('data/'.length));
}

function fileDigest(file) {
  const bytes = fs.readFileSync(file);
  return { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}

/** The clip a queue row would play for this voice, used only when the page sent none. */
function queueProbeClip(queue, voiceClusterId) {
  for (const field of [
    'confirmation_queue',
    'candidate_voiceprint_queue',
    'unknown_voice_queue',
    'group_name_mismatch_review_queue',
  ]) {
    const rows = Array.isArray(queue?.[field]) ? queue[field] : [];
    const row = rows.find((r) => (r?.voice_cluster_id || r?.unknown_speaker_id) === voiceClusterId);
    if (row?.probe_audio_path) return row.probe_audio_path;
  }
  return '';
}

/**
 * Fix the reviewed clip at click time: { ok, clip: { path, sha256, size } } or
 * { ok: false, error }. Without a verifiable clip the Save is refused, so a
 * Two people answer can never be accepted and then mark nothing.
 */
function captureReviewedClip({ dataDir, clip }) {
  const rel = reviewedClipRel(clip);
  if (!rel) return { ok: false, error: 'two people needs the clip you heard; reload the card and try again' };
  const abs = reviewedClipAbs(dataDir, rel);
  try {
    return { ok: true, clip: { path: rel, ...fileDigest(abs) } };
  } catch {
    return { ok: false, error: 'the clip you heard is no longer on the server; reload the card and try again' };
  }
}

/**
 * Prove the recorded clip is the one on disk now: { ok, rel, abs } or
 * { ok: false, reason }.
 */
function verifyReviewedClip({ dataDir, reviewedClip }) {
  const rel = reviewedClipRel(reviewedClip?.path);
  if (!rel || !reviewedClip?.sha256) return { ok: false, reason: 'reviewed_clip_not_recorded' };
  const abs = reviewedClipAbs(dataDir, rel);
  let digest = null;
  try {
    digest = fileDigest(abs);
  } catch {
    return { ok: false, reason: 'reviewed_clip_missing', rel };
  }
  if (digest.sha256 !== reviewedClip.sha256 || (reviewedClip.size != null && digest.size !== reviewedClip.size)) {
    return { ok: false, reason: 'reviewed_clip_changed', rel };
  }
  return { ok: true, rel, abs };
}

/**
 * The Two people Save an Undo names, and the Undo already recorded for it.
 * `rows` are voice confirmation action records.
 */
function findTwoPeopleUndoTarget(rows, { voiceClusterId, undoesRequestId }) {
  const id = String(undoesRequestId || '');
  if (!id) return { error: 'undo needs the Save it undoes' };
  const target = (rows || []).find(
    (row) => row?.action === 'two_people' && row.gitPeopleSyncRequestId === id,
  );
  if (!target) return { error: 'that Two people answer was not found' };
  if (target.voiceClusterId !== voiceClusterId) return { error: 'that Two people answer is for another voice' };
  const existingUndo = (rows || []).find(
    (row) => row?.action === 'undo_two_people' && row.undoesRequestId === id,
  );
  if (existingUndo) return { target, existingUndo };
  // Undo reverts only the answer that still stands. A newer answer for the
  // voice replaced it already, and undoing it now would overwrite that answer.
  const targetAt = Date.parse(target.ts || '') || 0;
  const newer = (rows || []).find(
    (row) =>
      row !== target &&
      row?.voiceClusterId === voiceClusterId &&
      !NON_DECISION_ACTIONS.has(String(row.action || '')) &&
      (Date.parse(row.ts || '') || 0) > targetAt,
  );
  if (newer) return { error: 'a newer answer for this voice already replaced that Two people answer' };
  return { target, existingUndo: null };
}

/** Voice confirmation action records; a torn line is skipped. */
function readActionRows(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A torn line is not a record.
    }
  }
  return rows;
}

/**
 * What the voice-confirm endpoint adds to a Two people or Undo two people
 * record: { ok, extra }, { ok, existingUndo } for a resent Undo, or
 * { ok: false, status, error, code } to refuse the Save.
 */
function twoPeopleRecordExtra({ action, body = {}, dataDir, queue, voiceClusterId, actionsPath }) {
  if (action === 'two_people') {
    const captured = captureReviewedClip({
      dataDir,
      clip: body.reviewedClip || queueProbeClip(queue, voiceClusterId),
    });
    if (!captured.ok) return { ok: false, status: 409, error: captured.error, code: 'two_people_clip_unverifiable' };
    return { ok: true, extra: { reviewedClip: captured.clip } };
  }
  if (action === 'undo_two_people') {
    const found = findTwoPeopleUndoTarget(readActionRows(actionsPath), {
      voiceClusterId,
      undoesRequestId: body.undoesRequestId,
    });
    if (found.error) return { ok: false, status: 409, error: found.error, code: 'two_people_undo_refused' };
    if (found.existingUndo) return { ok: true, existingUndo: found.existingUndo };
    return { ok: true, extra: { undoesRequestId: found.target.gitPeopleSyncRequestId } };
  }
  return { ok: true, extra: {} };
}

module.exports = {
  captureReviewedClip,
  findTwoPeopleUndoTarget,
  queueProbeClip,
  readActionRows,
  reviewedClipAbs,
  reviewedClipRel,
  twoPeopleRecordExtra,
  verifyReviewedClip,
};
