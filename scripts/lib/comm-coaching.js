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
// spiritual discipline; speak the truth in love). If the model ever reaches for
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

function buildPrompt({ qualities, groundingMd, literatureKeys, pool, priorTitles, date }) {
  const poolBlock = pool.map((q) => `${q.id} [${q.source}, ${q.when}]: ${q.text}`).join('\n');
  const litBlock = literatureKeys.map((k, i) => `${i + 1}. ${k}`).join('\n');
  const priorBlock = priorTitles && priorTitles.length ? priorTitles.join('; ') : '(none yet)';

  return [
    'You are Amy, ExampleCo\'s executive assistant and communication coach. Coach ExampleCo directly ("you"). Terse, direct, warm, honest. No em dashes. No flattery. No fabrication.',
    '',
    "TASK: From the evidence below, choose ExampleCo's TOP TWO communication STRENGTHS and TOP TWO RECOMMENDATIONS, to grow him into a confident, strategic, empathetic, loving, motivating, inspiring leader who is effective at making things happen and wise in his dealings with all.",
    '',
    'TARGET QUALITIES: ' + qualities.join(', ') + '.',
    '',
    "GROUNDING (ExampleCo's own foundational truths -- you may ground ONLY on these, never anything else):",
    groundingMd,
    '',
    'HARD RULE: Never recommend anything that needs lying, manipulation, flattery, spin, exaggeration, or stretched truth, even if it would "work." Effectiveness must serve truth and love. Speak the truth in love. If you cannot ground a point in ExampleCo\'s truth, drop it.',
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
    '  "strengths": [ { "title": "<=6 words", "oneLiner": "one crisp sentence", "evidenceQuoteId": "<id from EVIDENCE>", "evidenceQuote": "<verbatim subspan of that quote>", "literatureKey": "<exact key from ALLOWED LITERATURE>", "literaturePoint": "what that source says that supports this", "value": "<the ExampleCo foundational truth this serves>", "ExampleCoraph": "<= 85 words: the strength, tied to the quote, the literature, and the value" } ],',
    '  "recommendations": [ { same shape, but ExampleCoraph names a concrete next move ExampleCo can make } ]',
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
    'ExampleCoraph',
  ]) {
    if (!item[f] || !String(item[f]).trim()) return `${kind}: missing ${f}`;
  }
  const pooled = poolById.get(String(item.evidenceQuoteId));
  if (!pooled)
    return `${kind}: evidenceQuoteId ${item.evidenceQuoteId} not in pool (fabricated source)`;
  const quoteNorm = normalize(item.evidenceQuote);
  if (quoteNorm.length < 12) return `${kind}: evidenceQuote too short to verify`;
  if (!normalize(pooled.text).includes(quoteNorm))
    return `${kind}: evidenceQuote is not a verbatim subspan of ${item.evidenceQuoteId} (paraphrased or fabricated)`;
  if (!allowedNorm.has(normalize(item.literatureKey)))
    return `${kind}: literatureKey "${item.literatureKey}" is not in the vetted list (hallucinated source)`;
  const haystack = normalize(
    [item.oneLiner, item.ExampleCoraph, item.literaturePoint, item.title].join(' '),
  );
  for (const bad of MANIPULATION_DENYLIST) {
    if (haystack.includes(bad))
      return `${kind}: coaching reaches for "${bad}" which violates ExampleCo's truth (truthfulness, speak truth in love)`;
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
        source: pooled.source || 'ExampleCo',
        when: pooled.when || '',
        ref: pooled.ref || '',
        context: pooled.context || '',
      },
      literature: { cite: sanitize(item.literatureKey), point: sanitize(item.literaturePoint) },
      value: sanitize(item.value),
      ExampleCoraph: sanitize(item.ExampleCoraph),
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
