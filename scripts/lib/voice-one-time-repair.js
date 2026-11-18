'use strict';

// What a one-time repair of the call archive must do around its write: keep a
// checked backup, refuse if a file moved while it was working, prove it changed
// only the speakers it meant to, and print no names.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

/**
 * Reads a JSON file once and records the hash of those same bytes, so a later
 * assertUnchanged proves the file on disk is the one this value came from.
 */
function readJsonHashed(file, hashes) {
  const bytes = fs.readFileSync(file);
  const value = JSON.parse(bytes.toString('utf8'));
  hashes.set(file, sha256Bytes(bytes));
  return value;
}

/** First two letters and length: enough to tell people apart in a report. */
function nameShape(value) {
  return value ? `${String(value).slice(0, 2)}.${String(value).length}` : null;
}

function segmentsOf(enriched, label) {
  return (enriched?.segments || []).filter(
    (segment) => String(segment?.speaker_model_label ?? '') === String(label),
  );
}

function wordsOf(enriched, label) {
  return segmentsOf(enriched, label).reduce(
    (total, segment) => total + String(segment.text || '').split(/\s+/).filter(Boolean).length,
    0,
  );
}

/**
 * Copies every file into dir, keeping its path below dataRoot, and checks each
 * copy against the original. Writes manifest.sha256 last.
 */
function backupFiles(dir, files, dataRoot) {
  const lines = [];
  for (const file of [...new Set(files)]) {
    const relative = path.relative(dataRoot, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`backup: ${file} is outside the data root`);
    }
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
    const original = sha256File(file);
    if (sha256File(target) !== original) throw new Error(`backup: copy of ${relative} does not match`);
    lines.push(`${original}  ${relative.replace(/\\/g, '/')}`);
  }
  fs.writeFileSync(path.join(dir, 'manifest.sha256'), `${lines.join('\n')}\n`, 'utf8');
  return lines.length;
}

/** Stops the repair when a file changed after it was read. */
function assertUnchanged(hashes) {
  for (const [file, hash] of hashes) {
    if (sha256File(file) !== hash) {
      const error = new Error(`changed while the repair was working: ${path.basename(file)}`);
      error.code = 'FILE_MOVED';
      throw error;
    }
  }
}

/** Writes a file only if it is still the one that was read. */
function saveIfUnchanged(file, value, hashes, save) {
  assertUnchanged(new Map([[file, hashes.get(file)]]));
  save(file, value);
}

function withoutSpeakers(enriched, labels) {
  const copy = JSON.parse(JSON.stringify(enriched));
  for (const label of labels) {
    if (copy.speaker_identity_tracks) delete copy.speaker_identity_tracks[String(label)];
    for (const segment of segmentsOf(copy, label)) delete segment.resolved_speaker;
  }
  return JSON.stringify(copy);
}

/**
 * Throws unless the only differences are these speakers' identity on the track
 * and on their segments. Words, times and every other speaker stay byte equal.
 */
function assertOnlySpeakersChanged(before, after, labels) {
  if (withoutSpeakers(before, labels) !== withoutSpeakers(after, labels)) {
    throw new Error('repair changed something other than the named speakers');
  }
}

module.exports = {
  assertOnlySpeakersChanged,
  assertUnchanged,
  backupFiles,
  nameShape,
  readJsonHashed,
  saveIfUnchanged,
  segmentsOf,
  sha256File,
  wordsOf,
};
