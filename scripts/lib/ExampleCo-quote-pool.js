#!/usr/bin/env node
'use strict';

// ExampleCo-quote-pool.js
//
// Assembles a pool of REAL things ExampleCo actually said or wrote, for the daily
// communication-coaching briefing card (scripts/comm-coaching-card.js).
//
// Anti-fabrication is the whole point: the coaching generator may only cite
// quotes that appear in this pool, and each pool entry ExampleCos the source and a
// reference so the citation traces back to a real artifact. We never invent a
// quote. Every loader is best-effort and wrapped so one bad source can never
// take down the pool.
//
// Sources, ranked by leadership-communication signal:
//   1. profile-curated  -- the resolved-ExampleCo Otter quotes already distilled into
//                          memory/user_profile.md (dated, leadership context).
//                          Guaranteed non-empty, so the card is never thin.
//   2. otter            -- recent transcript segments with explicit confirmed
//                          ExampleCo speaker identity.
//   3. gmail-sent       -- emails ExampleCo himself wrote to real people (last N days).
//   4. telegram         -- ExampleCo's own directives (data/agent/telegram-inbound.jsonl).
//   5. dispatch         -- ExampleCo's own dashboard feedback (amy-dispatch-log.jsonl).

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ExampleCo_EMAIL = 'ExampleCo.d.ExampleCo@gmail.com';
const CONFIRMED_ExampleCo_IDENTITY_TIERS = new Set([
  'confirmed_by_ExampleCo_cluster',
  'confirmed_reference_voiceprint_match',
]);

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// Collapse whitespace, drop the soft-hyphen / zero-width junk that marketing
// emails inject, and trim. Returns '' for anything that is not real prose.
function cleanText(raw) {
  return String(raw || '')
    .replace(/[­​‌‍͏⁠﻿]/g, '')
    .replace(/[ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A quote is only useful as evidence if it is a real sentence ExampleCo composed:
// long enough to carry meaning, not a URL, not a list of headers.
function isSubstantiveQuote(text) {
  const t = cleanText(text);
  if (t.length < 40 || t.length > 600) return false;
  if (/^https?:\/\//i.test(t)) return false;
  const letters = (t.match(/[a-zA-Z]/g) || []).length;
  if (letters < t.length * 0.5) return false; // mostly punctuation / junk
  const words = t.split(' ').filter(Boolean);
  return words.length >= 8;
}

// ---- Source 1: curated ExampleCo quotes from user_profile.md --------------------
// Lines look like:  `- 2026-03-30 / Leadership and Career Guidance (164 segments, 11595 words): I really appreciate...`
function loadProfileCurated(root) {
  const file = path.join(root, 'memory', 'user_profile.md');
  const md = safe(() => fs.readFileSync(file, 'utf8'), '');
  if (!md) return [];
  const out = [];
  const re = /^-\s*(\d{4}-\d{2}-\d{2})\s*\/\s*(.+?):\s*(.+)$/;
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(re);
    if (!m) continue;
    const when = m[1];
    const context = m[2].replace(/\s*\(\d+\s*segments?,\s*[\d,]+\s*words?\)\s*$/i, '').trim();
    const text = cleanText(m[3]);
    if (!isSubstantiveQuote(text)) continue;
    out.push({ text, speaker: 'ExampleCo', source: 'meeting', when, ref: context, context });
  }
  return out;
}

// ---- Source 1b: vetted ExampleCo quotes embedded in the coaching grounding -------
//
// The EC2 live build can temporarily miss the curated profile evidence file
// while still carrying the communication-coaching grounding contract. That
// contract includes explicit ExampleCo truth used by this exact card. Keep it as a
// narrow safety source so the card stays honest and sourced instead of rendering
// a held tile when the broader archive is unavailable.
function loadGroundingReference(root) {
  const file = path.join(root, 'memory', 'reference_communication_coaching.md');
  const md = safe(() => fs.readFileSync(file, 'utf8'), '');
  if (!md) return [];
  const groundingSection = md.split(/^##\s+Vetted literature/im)[0] || md;
  const out = [];
  const quoteRe = /["“]([^"”]{40,600})["”]/g;
  let m;
  while ((m = quoteRe.exec(groundingSection))) {
    const text = cleanText(m[1]);
    if (!isSubstantiveQuote(text)) continue;
    if (!/\b(I|me|my)\b/i.test(text)) continue;
    if (/^\d+\.\s*\*\*/.test(text)) continue;
    out.push({
      text,
      speaker: 'ExampleCo',
      source: 'grounding',
      when: 'reference_communication_coaching',
      ref: file,
      context: 'communication coaching grounding contract',
    });
  }
  return out;
}

// Build the YYYY/MM/DD path fragments for the last `days` days WITHOUT globbing
// the (enormous) gmail tree. `today` is injectable so tests are deterministic.
function recentDayParts(days, today) {
  const parts = [];
  const base = today instanceof Date ? today : new Date(today);
  for (let i = 0; i < days; i++) {
    const d = new Date(base.getTime() - i * 86400000);
    parts.push([
      String(d.getUTCFullYear()),
      String(d.getUTCMonth() + 1).padStart(2, '0'),
      String(d.getUTCDate()).padStart(2, '0'),
    ]);
  }
  return parts;
}

// Strip quoted reply chains and signatures so we only keep what ExampleCo newly wrote.
function topOfEmailBody(body) {
  const lines = cleanText(body)
    .split(/(?<=[.!?])\s+/) // sentence-ish
    .filter(Boolean);
  const kept = [];
  for (const s of lines) {
    if (/^On .+wrote:|^>|^From:|^Sent:|^-----Original/i.test(s)) break;
    kept.push(s);
    if (kept.join(' ').length > 500) break;
  }
  return kept;
}

// ---- Source 2: ExampleCo's sent Gmail (last N days) -----------------------------
function loadGmailSent(root, days, today) {
  const out = [];
  for (const [y, mo, da] of recentDayParts(days, today)) {
    const dayDir = path.join(root, 'data', 'gmail', 'raw', y, mo, da);
    const entries = safe(() => fs.readdirSync(dayDir), []);
    for (const entry of entries) {
      const file = path.join(dayDir, entry, 'message.json');
      const msg = safe(() => JSON.parse(fs.readFileSync(file, 'utf8')), null);
      if (!msg) continue;
      const from = String(msg.from || '').toLowerCase();
      const to = String(msg.to || '').toLowerCase();
      if (!from.includes(ExampleCo_EMAIL)) continue; // outbound only
      // Skip machine recipients: we want human dealings, not list traffic.
      if (
        !to.includes('@') ||
        /no-?reply|donotreply|notifications?@|@.*\.(amazonses|sendgrid)/i.test(to)
      )
        continue;
      for (const s of topOfEmailBody(msg.body)) {
        if (!isSubstantiveQuote(s)) continue;
        out.push({
          text: cleanText(s),
          speaker: 'ExampleCo',
          source: 'email',
          when: `${y}-${mo}-${da}`,
          ref: msg.gmail_url || msg.subject || 'sent email',
          context: msg.subject ? `email: ${msg.subject}` : 'sent email',
        });
      }
    }
  }
  return out;
}

function confirmedExampleCoSegment(segment) {
  const resolved = (segment && segment.resolved_speaker) || {};
  const person = String(resolved.person_id || resolved.resolved_person || '').trim();
  const tier = String(resolved.identity_tier || '').toLowerCase();
  if (!/^(ExampleCo|ExampleCo ExampleCo)$/i.test(person)) return false;
  return CONFIRMED_ExampleCo_IDENTITY_TIERS.has(tier);
}

function boundedTextChunks(text, maxChars) {
  const chunks = [];
  let current = '';
  const flush = () => {
    const value = cleanText(current);
    if (value) chunks.push(value);
    current = '';
  };
  const sentences = cleanText(text).split(/(?<=[.!?])\s+/).filter(Boolean);
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean);
    for (const word of words) {
      if (word.length > maxChars) {
        flush();
        for (let offset = 0; offset < word.length; offset += maxChars) {
          chunks.push(word.slice(offset, offset + maxChars));
        }
        continue;
      }
      const prospective = current ? `${current} ${word}` : word;
      if (prospective.length > maxChars) flush();
      current = current ? `${current} ${word}` : word;
    }
  }
  flush();
  return chunks;
}

function ExampleCoTranscriptQuoteWindows(segments, maxChars = 520) {
  const out = [];
  let current = [];
  let start = null;
  const flush = () => {
    const text = cleanText(current.join(' '));
    if (isSubstantiveQuote(text)) out.push({ text, startSeconds: start });
    current = [];
    start = null;
  };
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (!confirmedExampleCoSegment(segment)) {
      flush();
      continue;
    }
    const segmentStart = Number(segment.start_seconds) || 0;
    for (const text of boundedTextChunks(segment.text, maxChars)) {
      if (start == null) start = segmentStart;
      const prospective = cleanText([...current, text].join(' '));
      if (prospective.length > maxChars && current.length) {
        flush();
        start = segmentStart;
      }
      current.push(text);
      // Produce several usable quotes from a long ExampleCo monologue instead of one
      // enormous transcript wall. The text remains verbatim and traceable.
      if (cleanText(current.join(' ')).length >= 180) flush();
    }
  }
  flush();
  return out;
}

// ---- Source 2: confirmed ExampleCo speech from recent Otter calls ---------------
function loadOtterExampleCo(root, days, today) {
  const rosterFile = path.join(
    root,
    'data',
    'life-archive',
    'voiceprints',
    'otter-call-speaker-rosters-latest.json',
  );
  const roster = safe(() => JSON.parse(fs.readFileSync(rosterFile, 'utf8')), null);
  const calls = roster && Array.isArray(roster.calls) ? roster.calls : [];
  const out = [];
  for (const call of calls) {
    const when = String((call && call.date) || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(when) || !withinDays(when, days, today)) continue;
    const otid = String((call && call.otid) || '').trim();
    if (!otid || /[^A-Za-z0-9_-]/.test(otid)) continue;
    const file = path.join(root, 'data', 'otter', 'enriched', `${otid}.json`);
    const doc = safe(() => JSON.parse(fs.readFileSync(file, 'utf8')), null);
    if (!doc) continue;
    for (const quote of ExampleCoTranscriptQuoteWindows(doc.segments)) {
      out.push({
        text: quote.text,
        speaker: 'ExampleCo',
        source: 'otter',
        when,
        ref: `otter:${otid}:${Number(quote.startSeconds || 0).toFixed(2)}`,
        context: `Otter: ${call.title || doc.title || 'recent conversation'}`,
        speakerProof: 'confirmed ExampleCo identity on enriched transcript segment',
      });
    }
  }
  return out;
}

// ---- Source 4 + 5: ExampleCo's directives / dashboard feedback ------------------
function tailJsonl(file, max) {
  const raw = safe(() => fs.readFileSync(file, 'utf8'), '');
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  return lines
    .slice(-max)
    .map((l) => safe(() => JSON.parse(l), null))
    .filter(Boolean);
}

function withinDays(ts, days, today) {
  if (!ts) return true;
  const t = safe(() => new Date(ts).getTime(), NaN);
  if (Number.isNaN(t)) return true;
  const base = (today instanceof Date ? today : new Date(today)).getTime();
  return t <= base && base - t <= days * 86400000;
}

function loadTelegram(root, days, today) {
  const file = path.join(root, 'data', 'agent', 'telegram-inbound.jsonl');
  return tailJsonl(file, 300)
    .filter((r) => withinDays(r.ts, days, today))
    .map((r) => ({ text: cleanText(r.prompt || r.message || r.text), raw: r }))
    .filter((r) => isSubstantiveQuote(r.text))
    .map((r) => ({
      text: r.text,
      speaker: 'ExampleCo',
      source: 'directive',
      when: String(r.raw.ts || '').slice(0, 10),
      ref: r.raw.command_id || 'telegram',
      context: 'directive to Amy',
    }));
}

function loadDispatch(root, days, today) {
  const file = path.join(root, 'data', 'agent', 'amy-dispatch-log.jsonl');
  return tailJsonl(file, 300)
    .filter((r) => withinDays(r.ts, days, today))
    .map((r) => ({ text: cleanText(r.comment), raw: r }))
    .filter((r) => isSubstantiveQuote(r.text))
    .map((r) => ({
      text: r.text,
      speaker: 'ExampleCo',
      source: 'feedback',
      when: String(r.raw.ts || r.raw.date || '').slice(0, 10),
      ref: r.raw.section || 'dashboard',
      context: r.raw.section ? `feedback on: ${r.raw.section}` : 'dashboard feedback',
    }));
}

// De-dup on normalized text, assign stable ids, cap the pool.
function finalize(quotes, max) {
  const seen = new Set();
  const unique = [];
  for (const q of quotes) {
    const key = q.text.toLowerCase().slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(q);
  }
  // Newest dated material first so fresh archive evidence is preferred when we
  // cap. Non-date safety-net sources sort last.
  const dateRank = (q) => (/^\d{4}-\d{2}-\d{2}$/.test(String(q.when)) ? String(q.when) : '');
  unique.sort((a, b) => dateRank(b).localeCompare(dateRank(a)));
  return unique.slice(0, max).map((q, i) => ({ id: `q${i + 1}`, ...q }));
}

/**
 * @param {object} opts
 * @param {string} [opts.root]   repo root (data/ + memory/ live under here)
 * @param {number} [opts.days]   look-back window for fresh sources
 * @param {number} [opts.max]    cap on pool size handed to the LLM
 * @param {Date|string} [opts.today] injectable clock for deterministic tests
 * @returns {{quotes: Array, counts: object}}
 */
function loadExampleCoQuotePool(opts = {}) {
  const root = opts.root || REPO_ROOT;
  const days = opts.days || 7;
  const max = opts.max || 60;
  const today = opts.today || new Date();
  const allowedDates = new Set(
    (Array.isArray(opts.allowedDates) ? opts.allowedDates : [])
      .map((value) => String(value || '').slice(0, 10))
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)),
  );
  const inAllowedDates = (quote) =>
    allowedDates.size === 0 || allowedDates.has(String((quote && quote.when) || '').slice(0, 10));

  const profileCurated = safe(() => loadProfileCurated(root), [])
    .filter((q) => withinDays(q.when, days, today))
    .filter(inAllowedDates);
  // The grounding file proves values and allowed literature, but its quotes do
  // not carry an observation date. It cannot satisfy a recent-speech card.
  const groundingReference = [];
  const otter = safe(() => loadOtterExampleCo(root, days, today), []).filter(inAllowedDates);
  const gmailSent = safe(() => loadGmailSent(root, days, today), []).filter(inAllowedDates);
  const telegram = safe(() => loadTelegram(root, days, today), []).filter(inAllowedDates);
  const dispatch = safe(() => loadDispatch(root, days, today), []).filter(inAllowedDates);

  const quotes = finalize(
    [...profileCurated, ...groundingReference, ...otter, ...gmailSent, ...telegram, ...dispatch],
    max,
  );
  return {
    quotes,
    counts: {
      profileCurated: profileCurated.length,
      groundingReference: groundingReference.length,
      otter: otter.length,
      gmailSent: gmailSent.length,
      telegram: telegram.length,
      dispatch: dispatch.length,
      total: quotes.length,
    },
  };
}

module.exports = {
  loadExampleCoQuotePool,
  // exported for unit tests
  cleanText,
  isSubstantiveQuote,
  loadProfileCurated,
  loadGroundingReference,
  loadOtterExampleCo,
  confirmedExampleCoSegment,
  ExampleCoTranscriptQuoteWindows,
  recentDayParts,
  topOfEmailBody,
  finalize,
};
