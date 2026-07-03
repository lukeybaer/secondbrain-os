#!/usr/bin/env node
'use strict';

// kingdom-equipping.js -- pure logic for the KINGDOM EQUIPPING IDEAS briefing
// card. The generator (scripts/kingdom-equipping-ideas.js) wires real
// grounding data + the LLM ladder to these pure functions so the
// anti-fabrication, dedup, and strategy-link contracts are unit testable
// without a live model. Mirrors scripts/lib/comm-coaching.js.
//
// ExampleCo's ask (2026-07-02): ideas must traverse his real memory/contacts/
// transcripts, never repeat a prior concept, connect concepts across domains,
// and each idea must name the strategy it advances. Non-negotiables enforced
// here (not just by the prompt):
//   1. Every idea cites >=2 DISTINCT real sources from the grounding pool by
//      id. A cited sourceLabel must exist in the pool (no fabricated file or
//      transcript name).
//   2. Every idea names a strategy it advances (drawn from ExampleCo's real
//      strategic goals list).
//   3. No repeats: an idea whose CONCEPT (normalized topic + strategy pair,
//      not exact string) already appears in the history ledger is rejected so
//      the caller regenerates or drops it.

const DASH_CLASS = '[' + String.fromCharCode(0x2014) + String.fromCharCode(0x2013) + ']';

function stripFences(s) {
  const m = String(s || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : String(s || '')).trim();
}

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

// Parse "## Current Strategic Goals" bullets from ExampleCo_life_goals_current.md
// into a list of { key, text }. Each bullet is "- **Key**: rest of text".
function parseStrategies(lifeGoalsMd) {
  const lines = String(lifeGoalsMd || '').split(/\r?\n/);
  let inSection = false;
  const strategies = [];
  for (const line of lines) {
    if (/^##\s+/.test(line)) inSection = /strategic goals/i.test(line);
    if (!inSection) continue;
    const m = line.match(/^\s*-\s+\*\*(.+?)\*\*:\s*(.+)$/);
    if (!m) continue;
    strategies.push({ key: sanitize(m[1]), text: sanitize(m[2]) });
  }
  return strategies;
}

// Normalize a concept for dedup: strategy key + significant words from the
// title/summary, sorted, so "AI Leverage For ExampleCo" and "ExampleCo AI Leverage
// Push" collapse to the same concept while unrelated ideas with a shared
// filler word do not.
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'for',
  'to',
  'of',
  'in',
  'on',
  'with',
  'is',
  'are',
  'your',
  'you',
  'idea',
  'ideas',
  'today',
  'this',
  'that',
  'as',
  'at',
  'be',
  'it',
  'into',
  'from',
  'kingdom',
  'equipping',
]);

// The strategy is kept as its own explicit token (not folded into the content
// word bag): every idea for the same strategy legitimately shares words like
// "ExampleCo" or "capital" from the strategy text itself, and mixing those into
// the overlap score caused short, genuinely distinct ideas on the same
// strategy to false-positive as repeats (two-word titles sharing only the
// strategy name plus one connector word crossed a naive threshold). Content
// overlap is computed ONLY from title + summary words; the strategy must
// match exactly (same key) before content overlap is even considered.
function conceptKey({ strategy, title, summary }) {
  const strategyWords = new Set(
    normalize(strategy || '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
  const words = normalize(`${title || ''} ${summary || ''}`)
    .split(/[^a-z0-9]+/)
    // Drop words that also appear in the strategy name itself (e.g. "ExampleCo")
    // so two distinct ideas on the same strategy do not overlap purely
    // because they both mention the strategy by name in the title.
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !strategyWords.has(w));
  const strategyToken = normalize(strategy || '').replace(/\s+/g, '_');
  return `strategy:${strategyToken}|${[...new Set(words)].sort().join(' ')}`;
}

function splitConceptKey(concept) {
  const m = String(concept || '').match(/^strategy:([^|]*)\|(.*)$/);
  if (!m)
    return {
      strategy: '',
      words: new Set(
        String(concept || '')
          .split(' ')
          .filter(Boolean),
      ),
    };
  return { strategy: m[1], words: new Set(m[2].split(' ').filter(Boolean)) };
}

// True Jaccard overlap (shared / union) of the content words in two concept
// keys, gated on an EXACT strategy match. Two ideas for different strategies
// are never a "repeat" no matter how much wording they share; two ideas for
// the same strategy only count as a repeat when their actual content
// (title + summary, strategy words excluded) is substantially the same idea.
function conceptOverlap(a, b) {
  const A = splitConceptKey(a);
  const B = splitConceptKey(b);
  if (A.strategy !== B.strategy) return 0;
  if (!A.words.size || !B.words.size) return 0;
  let shared = 0;
  for (const w of A.words) if (B.words.has(w)) shared += 1;
  const union = new Set([...A.words, ...B.words]).size;
  return union ? shared / union : 0;
}

function isRepeatOfHistory(concept, historyConcepts, threshold = 0.65) {
  return (historyConcepts || []).some((prior) => conceptOverlap(concept, prior) >= threshold);
}

function buildPrompt({ groundingFacts, strategies, historyTitles, date }) {
  const poolBlock = groundingFacts.map((f) => `${f.id} [${f.sourceLabel}]: ${f.text}`).join('\n');
  const strategyBlock = strategies.map((s, i) => `${i + 1}. ${s.key}: ${s.text}`).join('\n');
  const historyBlock =
    historyTitles && historyTitles.length ? historyTitles.slice(0, 40).join('; ') : '(none yet)';

  return [
    "You are Amy, ExampleCo ExampleCo's executive assistant. Write three KINGDOM EQUIPPING IDEAS for ExampleCo's daily briefing: concrete, Jesus-centered ideas that grow him toward the man and mission he has already described. No em dashes. No flattery. No fabrication. No generic filler ('start a podcast', 'read more books') that could apply to any person.",
    '',
    "TASK: Each idea MUST cite at least TWO DISTINCT real facts from the GROUNDING POOL below by id, and MUST connect concepts across at least two different domains of ExampleCo's real life (e.g. a skill + a person he knows + a stated goal). Each idea MUST name exactly one STRATEGY it advances, chosen from the STRATEGIES list.",
    '',
    "GROUNDING POOL -- REAL facts, quotes, and details from ExampleCo's own memory files, contacts, and transcripts. You MUST cite from these by id; never invent a fact, a name, or a source:",
    poolBlock,
    '',
    'STRATEGIES -- choose exactly one key per idea from this list (do not invent a strategy name):',
    strategyBlock,
    '',
    'AVOID REPEATING these prior idea titles/concepts unless the underlying grounding facts have genuinely changed: ' +
      historyBlock,
    '',
    'OUTPUT: strict JSON only, no prose, no code fence. Shape:',
    '{',
    '  "date": "' + date + '",',
    '  "ideas": [',
    '    {',
    '      "title": "<=8 words, specific, not generic",',
    '      "strategyKey": "<exact key from STRATEGIES>",',
    '      "sourceIds": ["<id from GROUNDING POOL>", "<a second, DIFFERENT id from GROUNDING POOL>"],',
    '      "connection": "<=40 words: the concrete concept-connection across domains this idea makes",',
    '      "body": "<=120 words: the idea itself, naming the cited facts and how it advances the strategy"',
    '    }',
    '  ]',
    '}',
    'Exactly three ideas. Each must have exactly one strategyKey and at least two distinct sourceIds. Every fact you reference must trace to a real id in the GROUNDING POOL.',
  ].join('\n');
}

// Validate one idea. Returns null on pass, or a string reason on failure.
function validateIdea(idea, poolById, allowedStrategyKeysNorm) {
  if (!idea || typeof idea !== 'object') return 'not an object';
  for (const f of ['title', 'strategyKey', 'connection', 'body']) {
    if (!idea[f] || !String(idea[f]).trim()) return `missing ${f}`;
  }
  const sourceIds = Array.isArray(idea.sourceIds) ? idea.sourceIds.map(String) : [];
  const distinctIds = [...new Set(sourceIds)];
  if (distinctIds.length < 2)
    return 'fewer than 2 distinct sourceIds (needs 2+ named real sources)';
  for (const id of distinctIds) {
    if (!poolById.has(id)) return `sourceId ${id} not in grounding pool (fabricated source)`;
  }
  if (!allowedStrategyKeysNorm.has(normalize(idea.strategyKey))) {
    return `strategyKey "${idea.strategyKey}" is not in the real strategies list (hallucinated strategy)`;
  }
  return null;
}

// Validate the full parsed card. Returns { ok:true, ideas } or { ok:false, reason }.
function validateIdeas(parsed, { groundingFacts, strategies, historyConcepts }) {
  if (!parsed || typeof parsed !== 'object')
    return { ok: false, reason: 'LLM output not an object' };
  const ideas = Array.isArray(parsed.ideas) ? parsed.ideas : [];
  if (ideas.length < 3) return { ok: false, reason: 'fewer than 3 ideas' };

  const poolById = new Map(groundingFacts.map((f) => [String(f.id), f]));
  const allowedStrategyKeysNorm = new Set(strategies.map((s) => normalize(s.key)));

  const chosen = ideas.slice(0, 3);
  const shaped = [];
  const concepts = [];
  for (const idea of chosen) {
    const reason = validateIdea(idea, poolById, allowedStrategyKeysNorm);
    if (reason) return { ok: false, reason: `idea "${idea && idea.title}": ${reason}` };

    const strategy = strategies.find((s) => normalize(s.key) === normalize(idea.strategyKey));
    const sources = [...new Set(idea.sourceIds.map(String))].map((id) => {
      const f = poolById.get(id);
      // Carry the REAL fact text (not just the label) so the renderer can show
      // ExampleCo the actual grounding fact verbatim, not only the LLM's paraphrase
      // of it. The LLM's body/connection is application/synthesis; the cited
      // fact text is the proof.
      return { id, sourceLabel: f.sourceLabel, sourceFile: f.sourceFile, text: f.text };
    });
    const concept = conceptKey({
      strategy: strategy.key,
      title: idea.title,
      summary: idea.connection,
    });
    if (isRepeatOfHistory(concept, historyConcepts)) {
      return {
        ok: false,
        reason: `idea "${idea.title}" repeats a prior concept in the history ledger`,
      };
    }
    // Also guard against the LLM returning near-duplicate ideas WITHIN the
    // same batch (e.g. two ideas for the same strategy that are really one
    // idea worded twice). concepts accumulates as we go, so idea N is checked
    // against ideas 1..N-1 already accepted in this call.
    if (isRepeatOfHistory(concept, concepts)) {
      return {
        ok: false,
        reason: `idea "${idea.title}" duplicates another idea in the same batch`,
      };
    }
    concepts.push(concept);

    shaped.push({
      title: sanitize(idea.title),
      strategy: { key: strategy.key, text: strategy.text },
      sources,
      connection: sanitize(idea.connection),
      body: sanitize(idea.body),
      concept,
    });
  }

  return { ok: true, ideas: shaped };
}

function blockedSnapshot(date, reason, counts) {
  return { date, status: 'blocked', reason, counts: counts || {}, generatedAt: null };
}

module.exports = {
  stripFences,
  sanitize,
  normalize,
  parseStrategies,
  conceptKey,
  conceptOverlap,
  isRepeatOfHistory,
  buildPrompt,
  validateIdea,
  validateIdeas,
  blockedSnapshot,
};
