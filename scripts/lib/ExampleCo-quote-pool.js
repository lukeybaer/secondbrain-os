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
//   2. gmail-sent       -- emails ExampleCo himself wrote to real people (last N days).
//   3. telegram         -- ExampleCo's own directives (data/agent/telegram-inbound.jsonl).
//   4. dispatch         -- ExampleCo's own dashboard feedback (amy-dispatch-log.jsonl).

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ExampleCo_EMAIL = 'ExampleCo.d.ExampleCo@gmail.com';

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

// ---- Source 3 + 4: ExampleCo's directives / dashboard feedback ------------------
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

  const profileCurated = safe(() => loadProfileCurated(root), []).filter((q) =>
    withinDays(q.when, days, today),
  );
  // The grounding file proves values and allowed literature, but its quotes do
  // not carry an observation date. It cannot satisfy a recent-speech card.
  const groundingReference = [];
  const gmailSent = safe(() => loadGmailSent(root, days, today), []);
  const telegram = safe(() => loadTelegram(root, days, today), []);
  const dispatch = safe(() => loadDispatch(root, days, today), []);

  const quotes = finalize(
    [...profileCurated, ...groundingReference, ...gmailSent, ...telegram, ...dispatch],
    max,
  );
  return {
    quotes,
    counts: {
      profileCurated: profileCurated.length,
      groundingReference: groundingReference.length,
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
  recentDayParts,
  topOfEmailBody,
  finalize,
};
