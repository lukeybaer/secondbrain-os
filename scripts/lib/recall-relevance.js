'use strict';
// Relevance scoring for the Recall Broker fallback fan-out.
//
// 2026-07-07: a PM2 infrastructure prompt injected the contacts "PRIVATE_NAME" and
// "PRIVATE_NAME McGowan" because the old fan-out substring-matched every 4+ char word
// (including the stopword "want") against contacts' free-text notes, and
// "ExampleCo wants him to..." contains "want". Result: noise, not context. This
// module fixes it: drop stopwords, and NEVER let a single common word pull a
// contact in on a notes match alone. A curated/structured field (name,
// relationship, goals, topics) is a real signal on one term; free-text notes
// need at least two distinct query terms to count.

const STOPWORDS = new Set(
  (
    'the a an and or but for with from into onto what when where which who whom whose why how ' +
    'can could should would will just that this these those there here about your my our their its ' +
    'is are was were be been being do does did have has had not no yes it in on at to of as by we ' +
    'you i me him her they them want need make made type thing things come came get got give given ' +
    'know knew think thought like look looks good great time work works help sure very much more most ' +
    'some any than then them were well also back even still lets let live gonna wanna kind sort stuff ' +
    'thing really actually maybe perhaps something anything everything nothing someone anyone else ' +
    'now today later soon again once always never often ever every each other another such same ' +
    'over under again down up out off only also too both few many lot lots bit '
  ).split(/\s+/).filter(Boolean),
);

function extractTerms(text, max = 16) {
  return Array.from(
    new Set(
      String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
    ),
  ).slice(0, max);
}

// Score one contact against the query terms. Structured fields carry weight per
// matched term; notes contribute only when >= 2 distinct terms appear there, so
// an incidental single word can never surface an irrelevant person.
function scoreContact(contact, terms) {
  const struct = [
    contact.name,
    contact.relationship,
    ...(Array.isArray(contact.active_goals) ? contact.active_goals : []),
    ...(Array.isArray(contact.ok_topics) ? contact.ok_topics : []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const notes = String(contact.notes || '').toLowerCase();

  const structMatched = new Set();
  const noteMatched = new Set();
  for (const t of terms) {
    if (struct.includes(t)) structMatched.add(t);
    else if (notes.includes(t)) noteMatched.add(t);
  }
  const noteScore = noteMatched.size >= 2 ? noteMatched.size : 0;
  const score = structMatched.size * 3 + noteScore;
  return { score, matched: [...structMatched, ...(noteScore ? [...noteMatched] : [])] };
}

function relevantContacts(contacts, terms, limit = 2) {
  if (!terms.length) return [];
  return (contacts || [])
    .map((c) => ({ c, ...scoreContact(c, terms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.c);
}

// Memory-index lines are relevant only when they carry >= 2 distinct query
// terms, killing the single-common-word line match.
function relevantMemoryLines(memoryText, terms, limit = 6) {
  if (!terms.length || !memoryText) return [];
  const out = [];
  for (const line of String(memoryText).split('\n')) {
    const lower = line.toLowerCase();
    if (line.trim().length < 12) continue;
    const hits = terms.filter((t) => lower.includes(t));
    if (hits.length >= 2) out.push({ line: line.trim(), hits: hits.length });
    if (out.length >= limit * 3) break;
  }
  return out
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map((x) => x.line);
}

module.exports = { STOPWORDS, extractTerms, scoreContact, relevantContacts, relevantMemoryLines };
