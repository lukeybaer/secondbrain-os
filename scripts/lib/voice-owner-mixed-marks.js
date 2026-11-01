'use strict';

/**
 * Clips the owner marked "Two people, skip" (2026-11-01). The clip holds two
 * voices, so it must never name a track or serve as a reference voice, the
 * same as a clip the purity index judged mixed. The mark is an append-only
 * ledger beside the purity index; the index itself is machine output and is
 * never edited by hand. Each mark carries a `ref` (the review item that made
 * it: a conflict-queue track key or a voice confirmation action key) and an
 * Undo of that item removes only its own mark, so a clip two items marked
 * stays mixed until both are undone.
 *
 * A missing ledger is legitimately empty. Any other read or parse failure is
 * surfaced (OwnerMarksUnreadableError), never cached, and every eligibility
 * check fails closed on it: an unreadable ledger never turns a marked clip
 * back into a usable one.
 */

const fs = require('fs');
const path = require('path');

const MARKS_SCHEMA = 'voice_owner_mixed_mark.v1';

class OwnerMarksUnreadableError extends Error {
  constructor(file, cause) {
    super(`owner mixed-clip marks unreadable at ${file}: ${cause?.message || cause}`);
    this.name = 'OwnerMarksUnreadableError';
    this.code = 'OWNER_MARKS_UNREADABLE';
    this.file = file;
  }
}

function marksPath(dataDir) {
  return path.join(dataDir, 'life-archive', 'voiceprints', 'voice-owner-mixed-marks.jsonl');
}

/** Clip path as the purity index keys it: from `otter/audio/`, forward slashes. */
function markKey(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const i = s.indexOf('otter/audio/');
  return i < 0 ? '' : s.slice(i);
}

/** Every line must parse: a torn or garbled ledger is a failure, never "no marks". */
function parseRows(text, file = '') {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new OwnerMarksUnreadableError(file, error);
    }
    if (row && row.schema === MARKS_SCHEMA && row.key && row.ref) rows.push(row);
  }
  return rows;
}

const cache = new Map();

/** clip key -> Set(ref) of the marks that currently stand. Throws when unreadable. */
function liveMarks(dataDir, fsApi = fs) {
  const file = marksPath(dataDir);
  let stat = null;
  let text = '';
  try {
    stat = fsApi.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.stamp === `${stat.mtimeMs}:${stat.size}`) return hit.live;
    text = fsApi.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw new OwnerMarksUnreadableError(file, error);
  }
  const live = new Map();
  for (const row of parseRows(text, file)) {
    const refs = live.get(row.key) || new Set();
    if (row.type === 'mark') refs.add(row.ref);
    else if (row.type === 'unmark') refs.delete(row.ref);
    if (refs.size) live.set(row.key, refs);
    else live.delete(row.key);
  }
  cache.set(file, { stamp: `${stat.mtimeMs}:${stat.size}`, live });
  return live;
}

/**
 * { marked, error } for one clip. `error` is set when the ledger cannot be
 * read; every identity writer must then treat the clip as not eligible.
 */
function ownerMarkState(dataDir, clipPath, fsApi = fs) {
  const key = markKey(clipPath);
  if (!key || !dataDir) return { marked: false, error: '' };
  try {
    return { marked: liveMarks(dataDir, fsApi).has(key), error: '' };
  } catch (error) {
    return { marked: false, error: String(error?.message || error) };
  }
}

/**
 * True when the owner marked this clip as holding two people and has not undone
 * it. Fails closed: an unreadable ledger counts as marked.
 */
function clipOwnerMarkedMixed(dataDir, clipPath, fsApi = fs) {
  const state = ownerMarkState(dataDir, clipPath, fsApi);
  return state.marked || Boolean(state.error);
}

/** True when the mark this ref made on the clip currently stands. Throws when unreadable. */
function clipMarkedBy(dataDir, clipPath, ref, fsApi = fs) {
  const key = markKey(clipPath);
  if (!key || !ref) return false;
  return Boolean(liveMarks(dataDir, fsApi).get(key)?.has(String(ref)));
}

/** Throws OwnerMarksUnreadableError when the ledger exists but cannot be read. */
function assertOwnerMarksReadable(dataDir, fsApi = fs) {
  liveMarks(dataDir, fsApi);
}

function append(dataDir, row) {
  const file = marksPath(dataDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ schema: MARKS_SCHEMA, ...row })}\n`, 'utf8');
  } finally {
    cache.delete(file);
  }
}

/** Mark a clip as holding two people. Returns false when it has no usable path. */
function markClipMixed(dataDir, clipPath, { ref, at = new Date().toISOString(), source = '' } = {}) {
  const key = markKey(clipPath);
  if (!key || !ref) return false;
  append(dataDir, { type: 'mark', key, ref: String(ref), at, source });
  return true;
}

/** Take back the mark one review item made. */
function unmarkClipMixed(dataDir, clipPath, { ref, at = new Date().toISOString(), source = '' } = {}) {
  const key = markKey(clipPath);
  if (!key || !ref) return false;
  append(dataDir, { type: 'unmark', key, ref: String(ref), at, source });
  return true;
}

module.exports = {
  MARKS_SCHEMA,
  OwnerMarksUnreadableError,
  assertOwnerMarksReadable,
  clipMarkedBy,
  clipOwnerMarkedMixed,
  liveMarks,
  markClipMixed,
  markKey,
  marksPath,
  ownerMarkState,
  unmarkClipMixed,
};
