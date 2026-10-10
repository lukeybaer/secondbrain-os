#!/usr/bin/env node
'use strict';

// comm-coaching.js -- pure logic for the daily communication-coaching card.
//
// The generator (scripts/comm-coaching-card.js) wires real data + the LLM ladder
// to these pure functions so the anti-fabrication and grounding guards are unit
// testable without a live model.
//
// Three non-negotiables, enforced mechanically here (not just by the prompt):
//   1. Evidence is real. Every cited quote must be a verbatim subspan of a quote
//      in the pool, referenced by its id. Paraphrase or invented quotes are rejected.
//   2. Literature is real. Every citation must be one of the vetted keys parsed
//      from memory/reference_communication_coaching.md. Hallucinated sources rejected.
//   3. Grounding is ExampleCo's truth. Coaching that reaches for lying, manipulation,
//      flattery, or spin is rejected by a denylist backstop on top of the prompt.

// Coaching that contradicts ExampleCo's foundational truth (truthfulness as a
// core commitment; say hard things with care). If the model ever reaches for
// these as a tactic, the card is rejected rather than shipped.
const MANIPULATION_DENYLIST = [
  'white lie',
  'little lie',
  'tell them what they want to hear',
  'tell people what they want to hear',
  'exaggerate',
  'overstate',
  'manipulat', // manipulate / manipulation / manipulative
  'deceiv', // deceive / deception
  'mislead',
  'spin it',
  'spin the',
  'stretch the truth',
  'bend the truth',
  'flatter',
  'fake it',
  'pretend to',
  'butter them up',
  'half-truth',
];

// em dash (U+2014) + en dash (U+2013), built from char codes so this source
// file never contains the literal characters (the repo blocks them).
const DASH_CLASS = '[' + String.fromCharCode(0x2014) + String.fromCharCode(0x2013) + ']';

function stripFences(s) {
  const m = String(s || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : String(s || '')).trim();
}

// Replace em/en dashes with commas (global "no em dashes" rule) and collapse ws.
function sanitize(s) {
  return String(s == null ? '' : s)
    .replace(new RegExp('\\s*' + DASH_CLASS + '\\s*', 'g'), ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‘’“”"']/g, '')
    .replace(new RegExp(DASH_CLASS, 'g'), '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// Curated Otter quotes arrive as ~300-char mid-word run-on fragments (they are
// truncated by the profile distiller). Dumping one raw makes the card an ugly
// wall of broken text. crispQuote returns a clean, readable VERBATIM subspan:
// it starts at the first real clause and ends at the last sentence or clause
// boundary within `max` chars, never cutting a word in half. The result is still
// a verbatim subspan of the source, so the anti-fabrication guard keeps passing.
function crispQuote(text, max = 160) {
  const clean = String(text || '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(new RegExp(DASH_CLASS, 'g'), ', ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  // Drop leading conversational filler so the snippet opens on substance while
  // staying a verbatim subspan (we only trim from the front, never rewrite).
  // Iterate because transcripts stack filler ("so, so", "yeah, in general").
  const FILLER =
    /^(?:okay|ok|so|and|but|well|yeah|yep|um|uh|like|i mean|you know|in general|generally|anyway|basically)[,\s]+/i;
  let body = clean;
  for (let i = 0; i < 4; i += 1) {
    const next = body.replace(FILLER, '');
    if (next === body || !next) break;
    body = next;
  }
  if (!body) body = clean;
  if (body.length <= max) return body;
  const window = body.slice(0, max + 1);
  // Prefer a sentence end, then a clause boundary, then a word boundary.
  const sentenceEnd = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('? '),
    window.lastIndexOf('! '),
  );
  if (sentenceEnd >= max * 0.5) return body.slice(0, sentenceEnd + 1).trim();
  const clauseEnd = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '));
  if (clauseEnd >= max * 0.5) return body.slice(0, clauseEnd).trim();
  const wordEnd = body.slice(0, max).lastIndexOf(' ');
  return (wordEnd > 0 ? body.slice(0, wordEnd) : body.slice(0, max)).trim();
}

// Relevance score of a quote to a topic keyword set. Used to pair each
// deterministic coaching point with a quote that actually supports it (the old
// fallback grabbed quotes[0..3] blindly, so "Names the why" got a delinquency
// quote). Cleaner + shorter quotes are preferred when relevance ties, because a
// tight quote reads far better on the card than a 300-char run-on.
function scoreQuoteForKeywords(text, keywords) {
  const hay = normalize(text);
  let score = 0;
  for (const kw of keywords || []) {
    if (hay.includes(normalize(kw))) score += 1;
  }
  return score;
}

// Pick the best UNUSED quote for a coaching topic and return a crisp verbatim
// subspan of it. Falls back to any unused quote so the card is never thin, and
// only reuses a quote if nothing unused remains. Returns { id, quote } or null.
function pickCrispQuoteFor({ quotes, keywords, usedIds, max = 160 }) {
  const pool = Array.isArray(quotes) ? quotes : [];
  if (!pool.length) return null;
  const used = usedIds instanceof Set ? usedIds : new Set(usedIds || []);
  const ranked = pool
    .map((q, i) => ({
      q,
      i,
      score: scoreQuoteForKeywords(q.text, keywords),
      len: String(q.text || '').length,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.len !== b.len) return a.len - b.len; // tighter quote reads better
      return a.i - b.i; // stable, newest-first (pool is date-sorted)
    });
  const firstUnused = ranked.find((r) => !used.has(String(r.q.id)));
  const chosen = firstUnused || ranked[0];
  if (!chosen) return null;
  return { id: chosen.q.id, quote: crispQuote(chosen.q.text, max) };
}

// Parse the allowed literature citation keys from the grounding markdown. A key
// is the text before the first " - " on each bullet in the vetted-literature
// section, markdown emphasis stripped. e.g. "Proverbs 15:1",
// "Stephen R. Covey, The 7 Habits of Highly Effective People".
function parseLiteratureKeys(groundingMd) {
  const lines = String(groundingMd || '').split(/\r?\n/);
  let inLit = false;
  const keys = [];
  for (const line of lines) {
    if (/^##\s+/.test(line)) inLit = /vetted literature/i.test(line);
    if (!inLit) continue;
    const m = line.match(/^\s*-\s+(.+)$/);
    if (!m) continue;
    const before = m[1].split(' - ')[0];
    const key = before.replace(/[*_]/g, '').trim();
    if (key) keys.push(key);
  }
  return keys;
}

// ExampleCo, 2026-09-25: "I really want the coaching to cycle through many
// different ranges of disciplines: psychology, persuasion, charisma, like all
// the different ways. And you need to be thinking about my goals." Each item
// names one discipline lens; the day's focus lenses rotate by date so the card
// does not keep landing on the same two or three ideas.
const DISCIPLINES = Object.freeze([
  'psychology',
  'persuasion',
  'charisma',
  'negotiation',
  'storytelling',
  'executive presence',
  'listening and empathy',
  'emotional intelligence',
  'conflict and hard conversations',
  'motivation and inspiration',
  'clarity and brevity',
  'servant leadership',
]);

const POOL_BLOCK_MAX_BYTES = 34000;

function focusDisciplines(date, count = 4) {
  const ms = Date.parse(String(date || ''));
  const day = Number.isFinite(ms) ? Math.floor(ms / 86400000) : 0;
  const n = DISCIPLINES.length;
  const start = (((day * 5) % n) + n) % n;
  return Array.from({ length: count }, (_, i) => DISCIPLINES[(start + i * 5) % n]);
}

function buildPrompt({ qualities, groundingMd, literatureKeys, pool, priorTitles, date, goalsMd = '' }) {
  const focus = focusDisciplines(date);
  // The briefing context budget refuses a prompt whose dynamic evidence tops
  // 64 KiB (2026-09-25: 71,950 bytes, so the model never ran and the card fell
  // back to templates). Evidence entries are added in pool order until the
  // block reaches its share of that budget.
  const entries = [];
  let poolBytes = 0;
  for (const q of pool) {
    const entry = `${q.id} [${q.source}, ${q.when}]\nCONTEXT: ${q.context || ''}\nQUOTE: ${q.text}`;
    const size = Buffer.byteLength(entry, 'utf8') + 2;
    if (entries.length && poolBytes + size > POOL_BLOCK_MAX_BYTES) break;
    entries.push(entry);
    poolBytes += size;
  }
  const poolBlock = entries.join('\n\n');
  const litBlock = literatureKeys.map((k, i) => `${i + 1}. ${k}`).join('\n');
  const priorBlock = priorTitles && priorTitles.length ? priorTitles.join('; ') : '(none yet)';

  return [
    'You are Amy, ExampleCo\'s executive assistant and communication coach. Coach ExampleCo directly ("you"). Terse, direct, warm, honest. No em dashes. No flattery. No fabrication.',
    '',
    "TASK: From the evidence below, choose ExampleCo's TOP TWO communication STRENGTHS and TOP TWO RECOMMENDATIONS, to grow him into a confident, strategic, empathetic, loving, motivating, inspiring leader who is effective at making things happen and wise in his dealings with all.",
    '',
    'TARGET QUALITIES: ' + qualities.join(', ') + '.',
    '',
    'DISCIPLINE LENSES: every item names exactly one lens from this list in "discipline": ' + DISCIPLINES.join(', ') + '.',
    "TODAY'S FOCUS LENSES (use at least three of these, and four different lenses across the four items): " + focus.join(', ') + '.',
    'Coach at expert depth for the chosen lens: name the specific mechanism (a persuasion principle, a charisma behavior, a cognitive bias, a negotiation move, a story structure) and show exactly how the quote exhibits it or misses it. Avoid generic advice such as "invite people in" or "listen first" unless the evidence makes it the single sharpest point today.',
    '',
    "ExampleCo'S CURRENT GOALS (put the specific goal each item serves in \"goal\", and make the paragraph show how the move advances it):",
    String(goalsMd || '(goals file unavailable)').slice(0, 4000),
    '',
    "GROUNDING (ExampleCo's own foundational truths -- you may ground ONLY on these, never anything else):",
    groundingMd,
    '',
    'HARD RULE: Never recommend anything that needs lying, manipulation, flattery, spin, exaggeration, or stretched truth, even if it would "work." Effectiveness must serve truth and love. Say hard things with care. If you cannot ground a point in ExampleCo\'s truth, drop it.',
    'HARD CONTEXT RULE: Use a quote only when its conversation title, participants, timestamp, stage, and nearby turns make the coaching conclusion understandable. Do not infer a participant goal or conversation fact beyond the supplied CONTEXT. If context is incomplete, drop that evidence item.',
    '',
    'EVIDENCE -- REAL things ExampleCo actually said or wrote. You MUST cite from these by id, quoting a VERBATIM subspan (copy the words exactly, do not paraphrase):',
    poolBlock,
    '',
    'ALLOWED LITERATURE -- you MUST cite by choosing exactly one key from this list per item (do not invent sources):',
    litBlock,
    '',
    'AVOID REPEATING these recent titles unless one is still clearly the single most important today: ' +
      priorBlock,
    '',
    'OUTPUT: strict JSON only, no prose, no code fence. Shape:',
    '{',
    '  "date": "' + date + '",',
    '  "strengths": [ { "title": "<=6 words", "oneLiner": "one crisp sentence", "discipline": "<one lens from DISCIPLINE LENSES>", "goal": "<the specific current ExampleCo goal this serves>", "evidenceQuoteId": "<id from EVIDENCE>", "evidenceQuote": "<verbatim subspan of that quote>", "literatureKey": "<exact key from ALLOWED LITERATURE>", "literaturePoint": "what that source says that supports this", "value": "<the ExampleCo foundational truth this serves>", "paragraph": "<= 85 words: the strength, tied to the quote, the literature, and the value" } ],',
    '  "recommendations": [ { same shape, but paragraph names a concrete next move ExampleCo can make } ]',
    '}',
    'Exactly two strengths and two recommendations. Every evidenceQuote must be copied verbatim from the cited id. Every literatureKey must be from the list.',
  ].join('\n');
}

// Validate one item against the pool + allowed literature. Returns null on pass,
// or a string reason on failure.
function validateItem(item, kind, poolById, allowedNorm) {
  if (!item || typeof item !== 'object') return `${kind}: not an object`;
  for (const f of [
    'title',
    'oneLiner',
    'evidenceQuoteId',
    'evidenceQuote',
    'literatureKey',
    'value',
    'paragraph',
  ]) {
    if (!item[f] || !String(item[f]).trim()) return `${kind}: missing ${f}`;
  }
  if (item.discipline != null && !DISCIPLINES.includes(String(item.discipline).trim().toLowerCase()))
    return `${kind}: discipline "${item.discipline}" is not a listed lens`;
  const pooled = poolById.get(String(item.evidenceQuoteId));
  if (!pooled)
    return `${kind}: evidenceQuoteId ${item.evidenceQuoteId} not in pool (fabricated source)`;
  const quoteNorm = normalize(item.evidenceQuote);
  if (quoteNorm.length < 12) return `${kind}: evidenceQuote too short to verify`;
  if (!normalize(pooled.text).includes(quoteNorm))
    return `${kind}: evidenceQuote is not a verbatim subspan of ${item.evidenceQuoteId} (paraphrased or fabricated)`;
  const context = String(pooled.context || '');
  for (const field of ['Conversation:', 'Participants:', 'Timestamp:', 'Stage:', 'Nearby turns:']) {
    if (!context.includes(field)) return `${kind}: evidence context is missing ${field}`;
  }
  if (!allowedNorm.has(normalize(item.literatureKey)))
    return `${kind}: literatureKey "${item.literatureKey}" is not in the vetted list (hallucinated source)`;
  const haystack = normalize(
    [item.oneLiner, item.paragraph, item.literaturePoint, item.title].join(' '),
  );
  for (const bad of MANIPULATION_DENYLIST) {
    if (haystack.includes(bad))
      return `${kind}: coaching reaches for "${bad}" which violates ExampleCo's truth (truthfulness, said with care)`;
  }
  return null;
}

// Validate the full parsed card. Returns { ok:true, card } or { ok:false, reason }.
function validateCard(parsed, { pool, literatureKeys }) {
  if (!parsed || typeof parsed !== 'object')
    return { ok: false, reason: 'LLM output not an object' };
  const strengths = Array.isArray(parsed.strengths) ? parsed.strengths : [];
  const recs = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
  if (strengths.length < 2) return { ok: false, reason: 'fewer than 2 strengths' };
  if (recs.length < 2) return { ok: false, reason: 'fewer than 2 recommendations' };

  const poolById = new Map(pool.map((q) => [String(q.id), q]));
  const allowedNorm = new Set(literatureKeys.map(normalize));

  const pick2 = (arr) => arr.slice(0, 2);
  const chosen = { strengths: pick2(strengths), recommendations: pick2(recs) };

  for (const [group, label] of [
    [chosen.strengths, 'strength'],
    [chosen.recommendations, 'recommendation'],
  ]) {
    for (const item of group) {
      const reason = validateItem(item, label, poolById, allowedNorm);
      if (reason) return { ok: false, reason };
    }
  }

  const shape = (item) => {
    const pooled = poolById.get(String(item.evidenceQuoteId)) || {};
    return {
      title: sanitize(item.title),
      oneLiner: sanitize(item.oneLiner),
      evidence: {
        quote: sanitize(item.evidenceQuote),
        speaker: pooled.speaker || 'unknown',
        source: pooled.source || 'unknown',
        when: pooled.when || '',
        observedAt: pooled.observedAt || '',
        ref: pooled.ref || '',
        context: pooled.context || '',
        plainContext: pooled.plainContext || '',
      },
      discipline: item.discipline ? sanitize(String(item.discipline).trim().toLowerCase()) : '',
      goal: item.goal ? sanitize(item.goal) : '',
      literature: { cite: sanitize(item.literatureKey), point: sanitize(item.literaturePoint) },
      value: sanitize(item.value),
      paragraph: sanitize(item.paragraph),
    };
  };

  return {
    ok: true,
    card: {
      date: parsed.date,
      strengths: chosen.strengths.map(shape),
      recommendations: chosen.recommendations.map(shape),
    },
  };
}

function blockedSnapshot(date, reason, counts) {
  return { date, status: 'blocked', reason, counts: counts || {}, generatedAt: null };
}

module.exports = {
  DISCIPLINES,
  focusDisciplines,
  MANIPULATION_DENYLIST,
  stripFences,
  sanitize,
  normalize,
  crispQuote,
  scoreQuoteForKeywords,
  pickCrispQuoteFor,
  parseLiteratureKeys,
  buildPrompt,
  validateItem,
  validateCard,
  blockedSnapshot,
};
