'use strict';

// Speech-equivalent raw revisions.
//
// A July segment backfill wrote a second raw file per older call that only
// adds Otter timing metadata. The ledger ranks that file as the current
// revision, so artifacts produced from the original revision look stale even
// though they describe the same speech. This module proves, per call, that an
// artifact's revision carries the identical ordered speech of the current raw
// revision, and stores that proof as an immutable content-addressed receipt.
// Consumers may accept the artifact revision only with a verified receipt; any
// difference in call id, speaker label, text, or order is not equivalent.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RECEIPT_SCHEMA = 'life_archive_otter_revision_equivalence_receipt.v1';
const RECEIPT_DIR_NAME = 'otter-revision-equivalence-receipts';
const REVISION_RE = /^[a-f0-9]{64}$/;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function normalizeRevision(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeLabel(value) {
  return String(value ?? '').trim() || 'unknown';
}

function segmentSequence(segments) {
  return segments.map((segment) => [
    normalizeLabel(segment?.speaker_model_label),
    normalizeText(segment?.text),
  ]);
}

// Ordered speech of the current raw revision. Segments win; the flat
// transcript is only a fallback for raw files that carry no segments.
function rawSpeech(raw) {
  if (Array.isArray(raw?.otter_segments) && raw.otter_segments.length) {
    return { basis: 'otter_segments', sequence: segmentSequence(raw.otter_segments) };
  }
  const transcript = normalizeText(raw?.transcript);
  if (transcript) return { basis: 'transcript_text', sequence: [transcript] };
  return { basis: 'none', sequence: [] };
}

function artifactSpeech(artifact, basis) {
  const segments = Array.isArray(artifact?.segments) ? artifact.segments : [];
  if (!segments.length) return [];
  if (basis === 'transcript_text') {
    return [normalizeText(segments.map((segment) => normalizeText(segment?.text)).join(' '))];
  }
  return segmentSequence(segments);
}

function speechDigest(basis, sequence) {
  return sha256(JSON.stringify({ basis, sequence }));
}

function artifactSpeechDigest(artifact, basis = 'otter_segments') {
  const sequence = artifactSpeech(artifact, basis);
  return sequence.length ? speechDigest(basis, sequence) : '';
}

function rawOtid(raw) {
  return String(raw?.id || raw?.otid || raw?.speech_id || '').trim();
}

function artifactRevisionOf(artifact) {
  return normalizeRevision(artifact?.source_revision || artifact?.source_revision_hash);
}

/**
 * Pure proof. Returns { equivalent, reason, ... }. Equivalent only when both
 * revisions are well-formed and differ, both documents name the same call,
 * and the ordered (label, normalized text) sequences are identical.
 */
function proveSpeechEquivalence({
  otid,
  currentRaw,
  currentRevision,
  artifact,
  artifactRevision = artifactRevisionOf(artifact),
} = {}) {
  const id = String(otid || '').trim();
  const current = normalizeRevision(currentRevision);
  const prior = normalizeRevision(artifactRevision);
  const fail = (reason) => ({ equivalent: false, reason, otid: id });
  if (!id) return fail('missing_otid');
  if (!REVISION_RE.test(current)) return fail('current_revision_malformed');
  if (!REVISION_RE.test(prior)) return fail('artifact_revision_malformed');
  if (current === prior) return fail('same_revision');
  if (rawOtid(currentRaw) !== id) return fail('current_raw_otid_mismatch');
  if (String(artifact?.otid || '').trim() !== id) return fail('artifact_otid_mismatch');
  const { basis, sequence: currentSequence } = rawSpeech(currentRaw);
  if (!currentSequence.length) return fail('current_raw_has_no_speech');
  const artifactSequence = artifactSpeech(artifact, basis);
  if (!artifactSequence.length) return fail('artifact_has_no_segments');
  if (artifactSequence.length !== currentSequence.length) return fail('segment_count_differs');
  for (let index = 0; index < currentSequence.length; index += 1) {
    if (JSON.stringify(artifactSequence[index]) !== JSON.stringify(currentSequence[index])) {
      return { ...fail('speech_differs'), first_difference_index: index };
    }
  }
  const currentSpeech = speechDigest(basis, currentSequence);
  const artifactSpeechHash = speechDigest(basis, artifactSequence);
  if (currentSpeech !== artifactSpeechHash) return fail('speech_digest_differs');
  return {
    equivalent: true,
    reason: 'speech_equivalent',
    otid: id,
    basis,
    segment_count: currentSequence.length,
    // Text-only proofs (raw without segments) cannot bind speaker labels, so
    // consumers refuse them for label-keyed voice evidence.
    labels_bound: basis === 'otter_segments',
    current_revision: current,
    artifact_revision: prior,
    current_speech_sha256: currentSpeech,
    artifact_speech_sha256: artifactSpeechHash,
  };
}

function proofDigest(receipt) {
  return sha256(
    JSON.stringify({
      schema: RECEIPT_SCHEMA,
      otid: receipt.otid,
      current_revision: receipt.current_revision,
      artifact_revision: receipt.artifact_revision,
      basis: receipt.basis,
      segment_count: receipt.segment_count,
      labels_bound: receipt.labels_bound,
      current_speech_sha256: receipt.current_speech_sha256,
      artifact_speech_sha256: receipt.artifact_speech_sha256,
    }),
  );
}

function buildEquivalenceReceipt(proof, { producedAt = new Date().toISOString() } = {}) {
  if (!proof?.equivalent) throw new Error('equivalence receipt requires a positive proof');
  const receipt = {
    schema: RECEIPT_SCHEMA,
    otid: proof.otid,
    current_revision: proof.current_revision,
    artifact_revision: proof.artifact_revision,
    basis: proof.basis,
    segment_count: proof.segment_count,
    labels_bound: proof.labels_bound === true,
    current_speech_sha256: proof.current_speech_sha256,
    artifact_speech_sha256: proof.artifact_speech_sha256,
  };
  return { ...receipt, proof_digest: proofDigest(receipt), produced_at: producedAt };
}

function receiptRoot(dataDir) {
  return path.join(dataDir, 'life-archive', 'voiceprints', RECEIPT_DIR_NAME);
}

function receiptPath(dataDir, receipt) {
  return path.join(receiptRoot(dataDir), receipt.otid, `${receipt.proof_digest}.json`);
}

// Immutable: an existing receipt with the same content address is never
// rewritten; a same-address file with different proof content fails closed.
function writeEquivalenceReceipt({ dataDir, receipt, fsApi = fs } = {}) {
  const file = receiptPath(dataDir, receipt);
  if (fsApi.existsSync(file)) {
    const existing = verifyReceipt(readJsonSafe(file, fsApi), file);
    if (!existing.ok || existing.receipt.proof_digest !== receipt.proof_digest) {
      throw new Error(`equivalence receipt address collision: ${file}`);
    }
    return { written: false, idempotent: true, file };
  }
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fsApi.writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  // link never replaces an existing file, so a concurrent writer of the same
  // content address cannot be overwritten; EEXIST is the idempotent case.
  try {
    fsApi.linkSync(tmp, file);
  } catch (error) {
    try {
      fsApi.unlinkSync(tmp);
    } catch {}
    if (error?.code !== 'EEXIST') throw error;
    const existing = verifyReceipt(readJsonSafe(file, fsApi), file);
    if (!existing.ok || existing.receipt.proof_digest !== receipt.proof_digest) {
      throw new Error(`equivalence receipt address collision: ${file}`);
    }
    return { written: false, idempotent: true, file };
  }
  fsApi.unlinkSync(tmp);
  return { written: true, idempotent: false, file };
}

function readJsonSafe(file, fsApi = fs) {
  try {
    return JSON.parse(String(fsApi.readFileSync(file, 'utf8')).replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function verifyReceipt(receipt, file = '') {
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) return { ok: false, problem: 'schema' };
  if (!REVISION_RE.test(receipt.current_revision || '')) return { ok: false, problem: 'current' };
  if (!REVISION_RE.test(receipt.artifact_revision || '')) return { ok: false, problem: 'artifact' };
  if (receipt.current_revision === receipt.artifact_revision) return { ok: false, problem: 'same' };
  if (typeof receipt.labels_bound !== 'boolean') return { ok: false, problem: 'labels_bound' };
  if (!receipt.current_speech_sha256 || receipt.current_speech_sha256 !== receipt.artifact_speech_sha256) {
    return { ok: false, problem: 'speech_hash' };
  }
  if (proofDigest(receipt) !== receipt.proof_digest) return { ok: false, problem: 'digest' };
  if (file && path.basename(file, '.json') !== receipt.proof_digest) {
    return { ok: false, problem: 'address' };
  }
  return { ok: true, receipt };
}

function readRawText(file, fsApi) {
  try {
    // Same BOM handling as the ledger's rawInventory revision hash.
    return String(fsApi.readFileSync(file, 'utf8')).replace(/^﻿/, '');
  } catch {
    return null;
  }
}

// The raw document whose bytes hash to `revision`, for this OTID. A supplied
// file is the only candidate; otherwise raw files naming the OTID are tried
// first, then the rest (legacy names need not contain it). Only reached when
// the call has receipts.
function findCurrentRaw({ dataDir, otid, revision, currentRawFile = '', fsApi = fs }) {
  const matches = (file) => {
    const text = readRawText(file, fsApi);
    if (text === null || sha256(text) !== revision) return null;
    try {
      const row = JSON.parse(text);
      return rawOtid(row) === otid ? row : null;
    } catch {
      return null;
    }
  };
  if (currentRawFile) return matches(currentRawFile);
  const dir = path.join(dataDir, 'otter', 'raw');
  let names = [];
  try {
    names = fsApi.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return null;
  }
  const ordered = [
    ...names.filter((name) => name.includes(otid)),
    ...names.filter((name) => !name.includes(otid)),
  ];
  for (const name of ordered) {
    const row = matches(path.join(dir, name));
    if (row) return row;
  }
  return null;
}

/**
 * Verified receipts for one call's CURRENT revision, keyed by artifact
 * revision. Receipts for any other current revision are ignored, so a later
 * raw change silently retires every older proof. Each used receipt is
 * re-checked against the raw file on disk: its bytes must hash to the
 * receipt's current revision and its speech to the receipt's current speech.
 */
function loadRevisionEquivalences({
  dataDir,
  otid,
  currentRevision,
  currentRawFile = '',
  fsApi = fs,
} = {}) {
  const byArtifactRevision = new Map();
  const current = normalizeRevision(currentRevision);
  const id = String(otid || '').trim();
  if (!id || !REVISION_RE.test(current)) return byArtifactRevision;
  const dir = path.join(receiptRoot(dataDir), id);
  let names = [];
  try {
    names = fsApi.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return byArtifactRevision;
  }
  let currentSpeech;
  const currentRawSpeech = () => {
    if (currentSpeech !== undefined) return currentSpeech;
    const raw = findCurrentRaw({ dataDir, otid: id, revision: current, currentRawFile, fsApi });
    const speech = raw ? rawSpeech(raw) : null;
    currentSpeech = speech?.sequence.length
      ? { basis: speech.basis, sha: speechDigest(speech.basis, speech.sequence) }
      : null;
    return currentSpeech;
  };
  for (const name of names) {
    const file = path.join(dir, name);
    const checked = verifyReceipt(readJsonSafe(file, fsApi), file);
    if (!checked.ok) continue;
    const receipt = checked.receipt;
    if (receipt.otid !== id || receipt.current_revision !== current) continue;
    const speech = currentRawSpeech();
    if (!speech || speech.basis !== receipt.basis || speech.sha !== receipt.current_speech_sha256) {
      continue;
    }
    byArtifactRevision.set(receipt.artifact_revision, { ...receipt, receipt_file: file });
  }
  return byArtifactRevision;
}

/**
 * True when `artifactRevision` is the current revision or a receipt-proven
 * equivalent of it. When the artifact document is supplied, its speech must
 * still hash to the receipt's proven speech, so a later rewrite of the
 * artifact cannot ride an old proof.
 */
function revisionAcceptedAsCurrent({ artifactRevision, currentRevision, equivalences, artifact = null }) {
  const prior = normalizeRevision(artifactRevision);
  const current = normalizeRevision(currentRevision);
  // Plain equality keeps each caller's prior semantics unchanged.
  if (prior === current) return true;
  if (!prior || !current) return false;
  const receipt = equivalences?.get?.(prior);
  if (!receipt || receipt.labels_bound !== true) return false;
  if (artifact) {
    if (String(artifact?.otid || '').trim() !== receipt.otid) return false;
    return artifactSpeechDigest(artifact, receipt.basis) === receipt.artifact_speech_sha256;
  }
  return true;
}

module.exports = {
  RECEIPT_SCHEMA,
  RECEIPT_DIR_NAME,
  normalizeText,
  normalizeLabel,
  rawSpeech,
  artifactRevisionOf,
  artifactSpeechDigest,
  proveSpeechEquivalence,
  buildEquivalenceReceipt,
  receiptRoot,
  receiptPath,
  writeEquivalenceReceipt,
  verifyReceipt,
  loadRevisionEquivalences,
  revisionAcceptedAsCurrent,
};
