#!/usr/bin/env node
'use strict';

// ExampleCo-quote-pool.js
//
// Assembles a pool of REAL things ExampleCo actually said or wrote, for the daily
// communication-coaching briefing card (scripts/comm-coaching-card.js).
//
// Anti-fabrication is the whole point: the coaching generator may only cite
// quotes that appear in this pool, and each pool entry carries the source and a
// reference so the citation traces back to a real artifact. We never invent a
// quote. Every loader is best-effort and wrapped so one bad source can never
// take down the pool.
//
// Communication Coaching is intentionally Otter-only. It coaches ExampleCo's spoken
// communication in real meetings, not email composition, dashboard directives,
// or old curated quotations. The recent-call readiness contract decides whether
// an honest empty state is possible before this pool is read.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ExampleCo_EMAIL = 'ExampleCo@gmail.com';
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

function observedAtIso(value) {
  if (value == null || value === '') return '';
  let ms;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const n = Number(value);
    ms = n < 1e12 ? n * 1000 : n;
  } else {
    ms = Date.parse(String(value));
  }
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function quoteObservedAtIso(callStart, quoteStartSeconds) {
  const callStartIso = observedAtIso(callStart);
  const callStartMs = Date.parse(callStartIso);
  const offsetSeconds = Number(quoteStartSeconds);
  if (!Number.isFinite(callStartMs)) return '';
  if (!Number.isFinite(offsetSeconds) || offsetSeconds < 0) return callStartIso;
  return new Date(callStartMs + offsetSeconds * 1000).toISOString();
}

function inObservationWindow(observedAt, start, end) {
  const ts = Date.parse(String(observedAt || ''));
  const lo = start instanceof Date ? start.getTime() : Date.parse(String(start || ''));
  const hi = end instanceof Date ? end.getTime() : Date.parse(String(end || ''));
  return Number.isFinite(ts) && Number.isFinite(lo) && Number.isFinite(hi) && ts >= lo && ts <= hi;
}

function latestJsonlRow(file) {
  const raw = safe(() => fs.readFileSync(file, 'utf8'), '');
  if (!raw) return null;
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const row = safe(() => JSON.parse(lines[index]), null);
    if (row) return row;
  }
  return null;
}

function heartbeatReachability(file, windowEnd, maxAgeMinutes = 30) {
  if (!fs.existsSync(file)) return { reachable: false, reason: `heartbeat missing: ${file}` };
  const row = latestJsonlRow(file);
  const observedAt = observedAtIso(row && (row.ts || row.generatedAt || row.checkedAt));
  if (!row || !observedAt) return { reachable: false, reason: `heartbeat unreadable: ${file}` };
  const endMs = (windowEnd instanceof Date ? windowEnd : new Date(windowEnd)).getTime();
  const ageMinutes = (endMs - Date.parse(observedAt)) / 60000;
  if (!Number.isFinite(ageMinutes) || ageMinutes < -5 || ageMinutes > maxAgeMinutes) {
    return {
      reachable: false,
      reason: `heartbeat stale by ${Number.isFinite(ageMinutes) ? Math.round(ageMinutes) : 'unknown'} minutes`,
      observedAt,
    };
  }
  return { reachable: true, reason: '', observedAt, ageMinutes: Math.max(0, ageMinutes) };
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
          observedAt: observedAtIso(
            msg.date || msg.sent_at || msg.sentAt || msg.internalDate || msg.internal_date,
          ),
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
  if (!/^(ExampleCo|PRIVATE_NAME)$/i.test(person)) return false;
  return CONFIRMED_ExampleCo_IDENTITY_TIERS.has(tier);
}

function confirmedNonExampleCoHumanSegment(segment) {
  const resolved = (segment && segment.resolved_speaker) || {};
  const person = String(resolved.person_id || resolved.resolved_person || '').trim();
  const tier = String(resolved.identity_tier || '').toLowerCase();
  if (!person || /^(ExampleCo|PRIVATE_NAME)$/i.test(person)) return false;
  if (!CONFIRMED_ExampleCo_IDENTITY_TIERS.has(tier)) return false;
  return isSubstantiveQuote(segment && segment.text);
}

function hasConfirmedHumanCounterpart(segments) {
  return (Array.isArray(segments) ? segments : []).some(confirmedNonExampleCoHumanSegment);
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
  let end = null;
  let startIndex = null;
  let endIndex = null;
  const flush = () => {
    const text = cleanText(current.join(' '));
    if (isSubstantiveQuote(text)) {
      out.push({
        text,
        startSeconds: start,
        endSeconds: end,
        startIndex,
        endIndex,
      });
    }
    current = [];
    start = null;
    end = null;
    startIndex = null;
    endIndex = null;
  };
  for (const [segmentIndex, segment] of (Array.isArray(segments) ? segments : []).entries()) {
    if (!confirmedExampleCoSegment(segment)) {
      flush();
      continue;
    }
    const segmentStart = Number(segment.start_seconds) || 0;
    const segmentEnd =
      Number(segment.end_seconds) ||
      Number(segment.end) ||
      segmentStart + Math.max(1, cleanText(segment.text).split(/\s+/).length / 2.5);
    for (const text of boundedTextChunks(segment.text, maxChars)) {
      if (start == null) {
        start = segmentStart;
        startIndex = segmentIndex;
      }
      const prospective = cleanText([...current, text].join(' '));
      if (prospective.length > maxChars && current.length) {
        flush();
        start = segmentStart;
        startIndex = segmentIndex;
      }
      current.push(text);
      end = segmentEnd;
      endIndex = segmentIndex;
      // Produce several usable quotes from a long ExampleCo monologue instead of one
      // enormous transcript wall. The text remains verbatim and traceable.
      if (cleanText(current.join(' ')).length >= 180) flush();
    }
  }
  flush();
  return out;
}

function segmentSpeakerLabel(segment) {
  if (confirmedExampleCoSegment(segment)) return 'ExampleCo';
  const resolved = (segment && segment.resolved_speaker) || {};
  return cleanText(
    resolved.resolved_person ||
      resolved.person_name ||
      resolved.person_id ||
      segment.speaker_name ||
      segment.speaker ||
      segment.speaker_id ||
      'Unidentified speaker',
  );
}

function clockLabel(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function quoteConversationContext({ call, doc, quote }) {
  const segments = Array.isArray(doc && doc.segments) ? doc.segments : [];
  const title = cleanText((call && call.title) || (doc && doc.title) || 'Recent conversation');
  const participants = [];
  for (const segment of segments) {
    const label = segmentSpeakerLabel(segment);
    if (!label || /^unidentified speaker$/i.test(label) || participants.includes(label)) continue;
    participants.push(label);
  }
  if (!participants.includes('ExampleCo')) participants.unshift('ExampleCo');
  const startIndex = Number.isInteger(quote.startIndex) ? quote.startIndex : 0;
  const endIndex = Number.isInteger(quote.endIndex) ? quote.endIndex : startIndex;
  const nearby = segments
    .slice(Math.max(0, startIndex - 2), Math.min(segments.length, endIndex + 3))
    .map((segment) => {
      const text = cleanText(segment && segment.text);
      if (!text) return '';
      const shortened = text.length > 180 ? `${text.slice(0, 177).trim()}...` : text;
      return `${segmentSpeakerLabel(segment)}: ${shortened}`;
    })
    .filter(Boolean)
    .join(' | ');
  const midpoint = segments.length ? (startIndex + endIndex) / 2 / segments.length : 0;
  const stage = midpoint < 0.25 ? 'opening' : midpoint > 0.75 ? 'closing' : 'middle';
  return [
    `Conversation: ${title}.`,
    `Participants: ${participants.join(', ') || 'ExampleCo and unidentified participant(s)'}.`,
    `Timestamp: ${clockLabel(quote.startSeconds)}-${clockLabel(quote.endSeconds)}.`,
    `Stage: ${stage} of the conversation.`,
    `Nearby turns: ${nearby || 'No adjacent transcript turns were available.'}`,
  ].join(' ');
}

// ExampleCo, 2026-09-25: the labeled context above "is very log speak. You need to
// just prove it to me, like you said X, the context is Y." This is the same
// evidence as one or two plain sentences for the card face. The labeled form
// stays as the machine-checked proof that every field was present.
function quotePlainContext({ call, doc, quote }) {
  const segments = Array.isArray(doc && doc.segments) ? doc.segments : [];
  const title = cleanText((call && call.title) || (doc && doc.title) || 'a recent conversation');
  const others = [];
  for (const segment of segments) {
    const label = segmentSpeakerLabel(segment);
    if (!label || label === 'ExampleCo' || /^unidentified speaker$/i.test(label) || others.includes(label)) continue;
    others.push(label);
  }
  const startIndex = Number.isInteger(quote.startIndex) ? quote.startIndex : 0;
  const endIndex = Number.isInteger(quote.endIndex) ? quote.endIndex : startIndex;
  const midpoint = segments.length ? (startIndex + endIndex) / 2 / segments.length : 0;
  const stage = midpoint < 0.25 ? 'near the start' : midpoint > 0.75 ? 'near the end' : 'in the middle';
  const withWhom = others.length ? ` with ${others.slice(0, 4).join(', ')}` : '';
  let prior = '';
  for (let i = startIndex - 1; i >= 0 && i >= startIndex - 3; i -= 1) {
    const label = segmentSpeakerLabel(segments[i]);
    const text = cleanText(segments[i] && segments[i].text);
    if (!text || !label || label === 'ExampleCo') continue;
    const shortened = text.length > 160 ? `${text.slice(0, 157).trim()}...` : text;
    prior = ` Right before, ${/^unidentified speaker$/i.test(label) ? 'someone' : label} said: "${shortened}"`;
    break;
  }
  return `On "${title}"${withWhom}, ${stage} of the call (${clockLabel(quote.startSeconds)}).${prior}`;
}

// ---- Source 2: confirmed ExampleCo speech from recent Otter calls ---------------
function loadOtterExampleCo(root, days, today, dataDir = path.join(root, 'data')) {
  const rosterFile = path.join(
    dataDir,
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
    const file = path.join(dataDir, 'otter', 'enriched', `${otid}.json`);
    const doc = safe(() => JSON.parse(fs.readFileSync(file, 'utf8')), null);
    if (!doc) continue;
    // Communication Coaching is about ExampleCo speaking with real people. A solo
    // voice note, a prompt to Amy, or a transcript containing only unknown/noise
    // tracks is not a coaching conversation and must not enter this evidence pool.
    if (!hasConfirmedHumanCounterpart(doc.segments)) continue;
    const callStart =
      doc.start_time ||
      doc.startTime ||
      doc.created_at ||
      doc.createdAt ||
      call.start_time ||
      call.created_at;
    for (const quote of ExampleCoTranscriptQuoteWindows(doc.segments)) {
      out.push({
        text: quote.text,
        speaker: 'ExampleCo',
        source: 'otter',
        when,
        observedAt: quoteObservedAtIso(callStart, quote.startSeconds),
        ref: `otter:${otid}:${Number(quote.startSeconds || 0).toFixed(2)}`,
        context: quoteConversationContext({ call, doc, quote }),
        plainContext: quotePlainContext({ call, doc, quote }),
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
      observedAt: observedAtIso(r.raw.ts),
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
      observedAt: observedAtIso(r.raw.ts || r.raw.date),
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
  const dateRank = (q) =>
    String(q.observedAt || '') ||
    (/^\d{4}-\d{2}-\d{2}$/.test(String(q.when)) ? String(q.when) : '');
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
  const dataDir = opts.dataDir || path.join(root, 'data');
  const days = opts.days || 7;
  const max = opts.max || 60;
  const today = opts.today || (opts.windowEnd ? new Date(opts.windowEnd) : new Date());
  const windowStart = opts.windowStart ? new Date(opts.windowStart) : null;
  const windowEnd = opts.windowEnd ? new Date(opts.windowEnd) : null;
  const exactWindow = !!(
    windowStart &&
    windowEnd &&
    Number.isFinite(windowStart.getTime()) &&
    Number.isFinite(windowEnd.getTime())
  );
  const allowedDates = new Set(
    (Array.isArray(opts.allowedDates) ? opts.allowedDates : [])
      .map((value) => String(value || '').slice(0, 10))
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)),
  );
  const inAllowedDates = (quote) =>
    allowedDates.size === 0 || allowedDates.has(String((quote && quote.when) || '').slice(0, 10));

  const profileCurated = [];
  const groundingReference = [];
  const scanDays = exactWindow ? Math.max(days, 3) : days;
  const exactFilter = (quote) =>
    !exactWindow || inObservationWindow(quote && quote.observedAt, windowStart, windowEnd);
  const otter = safe(() => loadOtterExampleCo(root, scanDays, today, dataDir), [])
    .filter(inAllowedDates)
    .filter(exactFilter);
  const gmailSent = [];
  const telegram = [];
  const dispatch = [];

  const otterRoster = path.join(
    dataDir,
    'life-archive',
    'voiceprints',
    'otter-call-speaker-rosters-latest.json',
  );
  const otterDir = path.join(dataDir, 'otter', 'enriched');
  const otterHeartbeat = exactWindow
    ? heartbeatReachability(
        path.join(dataDir, 'agent', 'otter-ingest-heartbeat.jsonl'),
        windowEnd,
      )
    : { reachable: fs.existsSync(otterRoster), reason: '' };
  const rosterReadable = safe(() => {
    const parsed = JSON.parse(fs.readFileSync(otterRoster, 'utf8'));
    return Array.isArray(parsed.calls);
  }, false);
  const otterState = {
    ...otterHeartbeat,
    reachable:
      !!otterHeartbeat.reachable && rosterReadable && fs.existsSync(otterDir),
    count: otter.length,
  };
  if (!rosterReadable) otterState.reason = 'Otter speaker roster missing or unreadable';
  else if (!fs.existsSync(otterDir)) otterState.reason = 'Otter enriched transcript directory missing';

  const sourceReachability = { otter: otterState };
  const allRequiredReachable = Object.values(sourceReachability).every(
    (state) => state.reachable,
  );

  const quotes = finalize([...otter], max);
  return {
    quotes,
    window:
      exactWindow
        ? { start: windowStart.toISOString(), end: windowEnd.toISOString(), hours: 24 }
        : null,
    sourceReachability,
    allRequiredReachable,
    counts: {
      profileCurated: profileCurated.length,
      groundingReference: groundingReference.length,
      otter: otter.length,
      gmailSent: gmailSent.length,
      telegram: telegram.length,
      dispatch: dispatch.length,
      ownerDirectives: telegram.length + dispatch.length,
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
  quoteConversationContext,
  quotePlainContext,
  hasConfirmedHumanCounterpart,
  recentDayParts,
  topOfEmailBody,
  finalize,
  observedAtIso,
  inObservationWindow,
  heartbeatReachability,
};
