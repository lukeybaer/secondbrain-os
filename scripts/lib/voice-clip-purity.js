'use strict';

/**
 * One voice or two? A clip recorder filed under one speaker can hold a merged
 * back-and-forth (The owner and PRIVATE_NAME in one 86 second block, 2026-10-28). The
 * clip is cut into 5 second pieces (scripts/voice-clip-purity.py) and each
 * piece is compared with every other one. A clip is mixed when its pieces
 * fall into two groups, each at least MIN_GROUP pieces long, that sound like
 * different people. A mixed clip proves nothing about who is speaking, so it
 * never names a track and never serves as a reference voice.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ownerMarkState } = require('./voice-owner-mixed-marks');

const PURITY_SCHEMA = 'voice_clip_purity_index.v1';
const MIN_PIECES = 4;
const MIN_GROUP = 2;
// Calibrated 2026-10-28 on EC2 against owner-confirmed clips and two-person
// mixes built from them (LESSONS 2026-10-28): no single-voice clip flagged
// (largest gap 0.08 of 22), 159 of 185 mixes caught. The gap does the work;
// a 10 second second speaker is the hardest case (46 of 64).
const CROSS_MAX = 0.35;
const GAP_MIN = 0.2;

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

/** The two-group split whose groups sound most unlike each other. */
function bestSplit(similarity) {
  const n = similarity.length;
  let best = null;
  // Piece 0 always sits in group A, so each split is tried once.
  for (let mask = 0; mask < 1 << (n - 1); mask += 1) {
    const inB = (i) => i > 0 && ((mask >> (i - 1)) & 1) === 1;
    const a = [];
    const b = [];
    for (let i = 0; i < n; i += 1) (inB(i) ? b : a).push(i);
    if (a.length < MIN_GROUP || b.length < MIN_GROUP) continue;
    const withinA = [];
    const withinB = [];
    const cross = [];
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        (inB(i) !== inB(j) ? cross : inB(i) ? withinB : withinA).push(similarity[i][j]);
      }
    }
    // Each group must sound like one voice on its own, so a stray noisy
    // piece paired with a good one is not a second person.
    const split = {
      within: Math.min(mean(withinA), mean(withinB)),
      cross: mean(cross),
      minor: Math.min(a.length, b.length),
    };
    split.gap = split.within - split.cross;
    if (!best || split.gap > best.gap) best = split;
  }
  return best;
}

/** Verdict for one clip's piece similarity matrix. */
function decidePurity(row) {
  const similarity = Array.isArray(row?.similarity) ? row.similarity : [];
  const pieces = similarity.length;
  if (pieces < MIN_PIECES) return { verdict: 'too_short', pieces };
  const split = bestSplit(similarity);
  const round = (v) => Math.round(v * 1000) / 1000;
  const mixed = Boolean(split && split.cross <= CROSS_MAX && split.gap >= GAP_MIN);
  return {
    verdict: mixed ? 'mixed' : 'one_voice',
    pieces,
    cross: split ? round(split.cross) : null,
    within: split ? round(split.within) : null,
    gap: split ? round(split.gap) : null,
    minor_pieces: split ? split.minor : 0,
  };
}

function purityIndexPath(dataDir) {
  return path.join(dataDir, 'life-archive', 'voiceprints', 'voice-clip-purity-index.json');
}

/** One line per saved batch: how many clips are left, so a stall is visible. */
function purityProgressPath(dataDir) {
  return path.join(dataDir, 'life-archive', 'voiceprints', 'voice-clip-purity-progress.jsonl');
}

/** Clip path as the index keys it: relative to the data dir, forward slashes. */
function clipKey(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const i = s.indexOf('otter/audio/');
  return i < 0 ? '' : s.slice(i);
}

const cache = new Map();

/** The index on disk, re-read only when the file changes. */
function readPurityIndex(dataDir, fsApi = fs) {
  const file = purityIndexPath(dataDir);
  let stat = null;
  try {
    stat = fsApi.statSync(file);
  } catch {
    return { clips: {} };
  }
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const hit = cache.get(file);
  if (hit && hit.stamp === stamp) return hit.index;
  let index = { clips: {} };
  try {
    const parsed = JSON.parse(fsApi.readFileSync(file, 'utf8'));
    if (parsed?.schema === PURITY_SCHEMA && parsed.clips) index = parsed;
  } catch {
    // An unreadable index proves nothing either way; clips stay unjudged.
  }
  cache.set(file, { stamp, index });
  return index;
}

/**
 * True only when the index judged this very clip as two voices. A clip
 * replaced at the same path (new size or mtime) is unjudged until re-indexed.
 */
function clipIsMixed(dataDir, clipPath, fsApi = fs) {
  const status = clipPurityStatus(dataDir, clipPath, fsApi);
  if (status.verdict === 'mixed') return true;
  // An unreadable owner-mark ledger fails closed: the clip may be one the owner marked.
  if (status.reason === 'owner_marks_unreadable') return true;
  // Missing audio cannot clear an existing mixed-reference exclusion.
  return status.reason === 'clip_unavailable' && readPurityIndex(dataDir, fsApi).clips?.[status.key]?.verdict === 'mixed';
}

/**
 * The current verdict for these exact clip bytes. Unlike clipIsMixed, this
 * preserves the difference between checked-one-voice and not checked. Identity
 * writers must require `one_voice`; every other value is review-only.
 */
function clipPurityStatus(dataDir, clipPath, fsApi = fs) {
  const key = clipKey(clipPath);
  if (!key || !dataDir) return { verdict: 'unchecked', key };
  // The owner said this clip holds two people ("Two people, skip"): mixed, whatever
  // the index says, and until he undoes it. An unreadable mark ledger proves
  // nothing, so the clip is unchecked (never one_voice) until it reads again.
  const owner = ownerMarkState(dataDir, clipPath, fsApi);
  if (owner.error) return { verdict: 'unchecked', key, reason: 'owner_marks_unreadable', error: owner.error };
  if (owner.marked) return { verdict: 'mixed', key, reason: 'owner_two_people' };
  const hit = readPurityIndex(dataDir, fsApi).clips?.[key];
  try {
    const stat = fsApi.statSync(path.join(dataDir, key));
    if (!hit || stat.size !== hit.size || Math.round(stat.mtimeMs) !== hit.mtime_ms) {
      return { verdict: 'unchecked', key, reason: hit ? 'stale_clip_bytes' : 'missing_purity_evidence' };
    }
    return { ...hit, key, verdict: String(hit.verdict || 'unchecked') };
  } catch {
    return { verdict: 'unchecked', key, reason: 'clip_unavailable' };
  }
}

/** Byte-bound evidence safe to carry from Fargate to EC2. */
function clipPurityEvidence(dataDir, clipPath, fsApi = fs) {
  const status = clipPurityStatus(dataDir, clipPath, fsApi);
  if (status.verdict !== 'one_voice') return status;
  const absolute = path.join(dataDir, status.key);
  const bytes = fsApi.readFileSync(absolute);
  return {
    schema: 'voice_clip_purity_evidence.v1',
    verdict: status.verdict,
    key: status.key,
    size: bytes.length,
    clip_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    judged_at: status.judged_at || '',
    rule: status.rule || '',
    pieces: Number(status.pieces || 0),
  };
}

function verifyClipPurityEvidence(dataDir, clipPath, evidence, fsApi = fs) {
  if (evidence?.schema !== 'voice_clip_purity_evidence.v1' || evidence.verdict !== 'one_voice') {
    return { ok: false, reason: 'clip_purity_unchecked' };
  }
  const key = clipKey(clipPath);
  if (!key || key !== evidence.key) return { ok: false, reason: 'clip_purity_path_mismatch' };
  // A receipt saved before the owner marked the clip "Two people, skip" no longer
  // admits it: the owner mark is read now, at the promotion boundary.
  const owner = ownerMarkState(dataDir, clipPath, fsApi);
  if (owner.error) return { ok: false, reason: 'owner_marks_unreadable' };
  if (owner.marked) return { ok: false, reason: 'clip_owner_marked_two_people' };
  try {
    const bytes = fsApi.readFileSync(path.join(dataDir, key));
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== Number(evidence.size) || sha256 !== evidence.clip_sha256) {
      return { ok: false, reason: 'clip_purity_bytes_mismatch' };
    }
    return { ok: true, evidence };
  } catch {
    return { ok: false, reason: 'clip_purity_clip_unavailable' };
  }
}

module.exports = {
  PURITY_SCHEMA,
  MIN_PIECES,
  CROSS_MAX,
  GAP_MIN,
  bestSplit,
  decidePurity,
  purityIndexPath,
  purityProgressPath,
  clipKey,
  readPurityIndex,
  clipIsMixed,
  clipPurityStatus,
  clipPurityEvidence,
  verifyClipPurityEvidence,
};
