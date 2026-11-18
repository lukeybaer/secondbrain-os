'use strict';
// English-only channel gate for Examplechannel clips.
//
// owner decision: "don't do videos in other languages like the second one you
// proposed today." That proposal (vtc-8a76efb341c8) was a Turkish-host
// Karpathy recap: Supadata returned English auto-captions, so every text check
// passed while the audio was Turkish. The Codex ec2-deploy review
// (cdf42c22df2d, high) then showed the first gate failed open: an unknown
// language was allowed through, `spoken_language` was optional, and nothing
// after the proposer checked the language again.
//
// This module is the one place that decides. Evidence, in order:
//   1. yt-dlp `language` (tr for that source; NA for many English ones);
//   2. yt-dlp `automatic_captions` keys ending in `-orig`, YouTube's original
//      spoken-language tracks (that source listed tr-orig and en-orig);
//   3. the Data API snippet `defaultAudioLanguage`.
// No evidence is a rejection, never a pass. The model then reports the
// `spoken_language` of the quoted words, which must also be English. The
// proposer persists both on the proposal (`language_gate`), and approve, build,
// promote and the spine build task all require that receipt, so a row without
// one (a legacy proposal, a hand-written one) never builds.

// scripts/lib/owner-video-request.js OWNER_REQUEST_ORIGIN (kept literal: that
// module requires the themes registry and this gate must stay dependency-free).
const OWNER_REQUEST_ORIGIN = 'owner_request';

function normalizeLanguageTag(value) {
  const tag = String(value || '')
    .trim()
    .toLowerCase();
  if (!tag || tag === 'na' || tag === 'und' || tag === 'null' || tag === 'none' || tag === 'unknown') return null;
  return tag;
}

// true, false, or null when the language is unknown.
function isEnglishLanguage(value) {
  const tag = normalizeLanguageTag(value);
  if (tag === null) return null;
  return /^en(?:[-_]|$)/.test(tag) || tag === 'english';
}

// YouTube's original spoken-language caption tracks: automatic_captions keys
// such as `en-orig` or `tr-orig`, without the suffix, unique, in key order.
function originalCaptionLanguages(detail) {
  const captions = detail && detail.automatic_captions;
  if (!captions || typeof captions !== 'object') return [];
  const out = [];
  for (const key of Object.keys(captions)) {
    const m = /^([a-z]{2,3}(?:[-_][a-z0-9]+)*)-orig$/i.exec(String(key).trim());
    if (!m) continue;
    const tag = normalizeLanguageTag(m[1]);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

// The fields enrichYtDlpCandidate spreads onto the candidate.
function sourceLanguageEvidence(detail = {}, candidate = {}) {
  const originals = originalCaptionLanguages(detail);
  const fromField = normalizeLanguageTag(detail && detail.language);
  if (fromField) {
    return { audioLanguage: fromField, audioLanguageSource: 'yt-dlp language', originalCaptionLanguages: originals };
  }
  if (originals.length) {
    const foreign = originals.find((tag) => isEnglishLanguage(tag) === false);
    return {
      audioLanguage: foreign || originals[0],
      audioLanguageSource:
        originals.length > 1
          ? `yt-dlp original caption tracks (${originals.join(', ')})`
          : 'yt-dlp original caption track',
      originalCaptionLanguages: originals,
    };
  }
  const prior = normalizeLanguageTag(candidate && candidate.audioLanguage);
  if (prior) {
    return {
      audioLanguage: prior,
      audioLanguageSource: (candidate && candidate.audioLanguageSource) || 'youtube data api defaultAudioLanguage',
      originalCaptionLanguages: originals,
    };
  }
  return { audioLanguage: null, audioLanguageSource: null, originalCaptionLanguages: originals };
}

// A known non-English source, or null (English or unknown).
function nonEnglishSourceReason(cand) {
  const tag = normalizeLanguageTag(cand && cand.audioLanguage);
  return tag && isEnglishLanguage(tag) === false ? `non-English source (${tag})` : null;
}

// The proposer's pre-model gate: anything but positive English evidence is a
// rejection (fail closed).
function sourceLanguageReason(cand) {
  const nonEnglish = nonEnglishSourceReason(cand);
  if (nonEnglish) return nonEnglish;
  if (isEnglishLanguage(cand && cand.audioLanguage) === true) return null;
  return 'source language unknown (no yt-dlp language, original caption track or Data API audio language); English-only channel';
}

// The receipt the proposer persists on the proposal row.
function languageReceiptFor(cand, modelAnswer, now = new Date()) {
  const audio = normalizeLanguageTag(cand && cand.audioLanguage);
  const spoken = normalizeLanguageTag(modelAnswer && modelAnswer.spoken_language);
  return {
    ok: isEnglishLanguage(audio) === true && isEnglishLanguage(spoken) === true,
    audio_language: audio,
    audio_language_source: (cand && cand.audioLanguageSource) || null,
    spoken_language: spoken,
    rule: 'English-only channel (The owner)',
    checked_at: new Date(now).toISOString(),
  };
}

// The consumer-side check (approve route, builder, queue writer, promote,
// spine build task). Codex review dc2c51103d63 (high): top-level fields alone
// are not a receipt. A row passes only with the proposer's persisted
// `language_gate` receipt at ok === true, positively English on both
// languages, with any top-level field agreeing with it. The owner-request
// exemption applies only to a row carrying no language evidence at all.
function proposalLanguageGate(proposal) {
  const row = proposal && typeof proposal === 'object' ? proposal : {};
  const receipt = row.language_gate && typeof row.language_gate === 'object' ? row.language_gate : null;
  const topAudio = normalizeLanguageTag(row.audio_language);
  const topSpoken = normalizeLanguageTag(row.spoken_language);
  const receiptAudio = receipt ? normalizeLanguageTag(receipt.audio_language) : null;
  const receiptSpoken = receipt ? normalizeLanguageTag(receipt.spoken_language) : null;
  // Negative evidence on either layer refuses the row before anything else.
  for (const tag of [topAudio, receiptAudio]) {
    if (isEnglishLanguage(tag) === false) {
      return { ok: false, reason: `non-English source (${tag}); English-only channel` };
    }
  }
  for (const tag of [topSpoken, receiptSpoken]) {
    if (isEnglishLanguage(tag) === false) {
      return { ok: false, reason: `non-English speech (${tag}); English-only channel` };
    }
  }
  // An owner-requested source carries no proposer evidence: the owner chose the
  // URL himself. It passes with that stated; the build session stops on
  // non-English speech (video-production LEARNINGS 2026-10-19).
  if (row.origin === OWNER_REQUEST_ORIGIN && !receipt && topAudio === null && topSpoken === null) {
    return {
      ok: true,
      ownerRequest: true,
      reason: 'owner-requested source (no proposer language evidence); the build session must stop if the speech is not English',
      audio_language: null,
      spoken_language: null,
    };
  }
  if (!receipt || isEnglishLanguage(receiptAudio) !== true) {
    return {
      ok: false,
      reason: 'no English language receipt on the proposal (it predates the English-only gate or its source language is unknown); re-propose it',
    };
  }
  if (isEnglishLanguage(receiptSpoken) !== true) {
    return { ok: false, reason: 'spoken language not recorded on the proposal; re-propose it' };
  }
  if (receipt.ok !== true) {
    return { ok: false, reason: 'language receipt on the proposal is not ok; re-propose it' };
  }
  if (topAudio !== null && topAudio !== receiptAudio) {
    return { ok: false, reason: `audio_language (${topAudio}) disagrees with the language receipt (${receiptAudio}); re-propose it` };
  }
  if (topSpoken !== null && topSpoken !== receiptSpoken) {
    return { ok: false, reason: `spoken_language (${topSpoken}) disagrees with the language receipt (${receiptSpoken}); re-propose it` };
  }
  return {
    ok: true,
    reason: `English source (${receiptAudio}), English speech (${receiptSpoken})`,
    audio_language: receiptAudio,
    spoken_language: receiptSpoken,
  };
}

module.exports = {
  OWNER_REQUEST_ORIGIN,
  normalizeLanguageTag,
  isEnglishLanguage,
  originalCaptionLanguages,
  sourceLanguageEvidence,
  nonEnglishSourceReason,
  sourceLanguageReason,
  languageReceiptFor,
  proposalLanguageGate,
};
