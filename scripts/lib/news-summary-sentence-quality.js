'use strict';
// ExampleCo rejected: "The reviewer tested both phones and found each excels in
// distinct areas." His objection: "Both phones to test for what? It's supposed
// to be an informative revelation of what's in the article."
//
// The category: a sentence that reports the EXISTENCE of a result rather than
// the result. It passes every grounding check because it echoes the source
// without adding anything. "found each excels in distinct areas" names no area.
// "experts are divided" names no position.

const EMPTY_FRAMES = [
  /\bfound (?:that )?each\b/i,
  /\bexcels? in distinct\b/i,
  /\bin (?:distinct|different|various|several) (?:areas|ways|respects)\b/i,
  /\b(?:experts?|analysts?|observers?) (?:are|remain) divided\b/i,
  /\bhighlights? (?:several|a number of|various) (?:challenges|issues|factors|concerns)\b/i,
  /\bhas implications for\b/i,
  /\bremains? to be seen\b/i,
];

// A sentence with none of these is almost always framing, not content.
const CONCRETE = [
  /\d/,                                   // number, percent, price, date, version
  /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)*\b/, // proper noun
  /\b(?:because|after|despite|instead of|rather than|which means)\b/i, // causal link
];

const MAX_WORDS = 22; // ExampleCo's stated ceiling

function splitSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

function gradeSentence(sentence) {
  const reasons = [];
  const w = String(sentence || '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return { ok: false, reasons: ['empty sentence'] };
  if (w.length > MAX_WORDS) reasons.push(`over ${MAX_WORDS} words (${w.length})`);
  if (EMPTY_FRAMES.some(rx => rx.test(sentence))) {
    reasons.push('states that a finding exists without stating the finding');
  }
  if (!CONCRETE.some(rx => rx.test(sentence))) {
    reasons.push('carries no number, name, or causal link the reader can use');
  }
  return { ok: reasons.length === 0, reasons };
}

function gradeSummary(text) {
  const weak = [];
  for (const sentence of splitSentences(text)) {
    const g = gradeSentence(sentence);
    if (!g.ok) weak.push({ sentence, reasons: g.reasons });
  }
  return { ok: weak.length === 0, weakCount: weak.length, weak: weak.slice(0, 10) };
}

module.exports = { MAX_WORDS, EMPTY_FRAMES, gradeSentence, gradeSummary, splitSentences };
