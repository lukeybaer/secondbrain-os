'use strict';

/**
 * News card title quality: reject a title that names nothing.
 *
 * NEWS-3, from ExampleCo's 2026-08-17 #otter feedback. The title he rejected was
 * item 6 of the AI & TECH NEWS card:
 *
 *   "The reviewer tested both phones and found each excels in distinct areas"
 *
 * Evidence: the rendered card in
 * data/agent/heal-sessions/agentic-heal-mswshds4-6w9xyv-ai_tech_news.log, where
 * it sits on the numbered title line above "ZDNet AI - Aug 16" and the article
 * URL, not inside the summary body. The article is a Pixel 11 Pro vs iPhone 17
 * Pro comparison, so a title that names neither phone tells the reader nothing.
 *
 * His bar (directive 27): a crisp, information-rich label of what is IN the
 * article, never the publisher's headline verbatim, and never a vague "the
 * reviewer found things differ" construction.
 *
 * Two failure shapes are gated here, and they are shapes rather than strings so
 * the next vague title fails too:
 *
 * 1. ARTICLE-INTERNAL SUBJECT. The grammatical subject is the article or one of
 *    its participants ("the reviewer", "this comparison", "the roundup") rather
 *    than a real-world actor. cloud-morning-briefing.js already rejected nine
 *    such nouns; this is a strict superset of that list, so nothing that used to
 *    pass starts failing.
 *
 * 2. HEDGE-ONLY CLAIM. The whole assertion is a non-fact: each excels in
 *    distinct areas, both have their own strengths, pros and cons, results vary,
 *    room for improvement. These are rejected whether or not the title also
 *    names an entity, because naming the phones does not make "each has its own
 *    strengths" informative.
 *
 * A third, weaker shape (no named entity at all plus a soft evaluative verb) is
 * gated only when the title names no entity, so a concrete claim with no proper
 * noun such as "Federal judge blocks new asylum rule" still passes.
 *
 * Deliberately NOT gated here: title length. Directive 27 caps a generated
 * label at 22 words, and cloud-morning-briefing.js already applies that cap when
 * it builds candidates (executiveNewsTitleWords). Rejecting a 23-word
 * informative title inside this predicate would push the render down its
 * fallback chain to something vaguer, which is the opposite of what was asked.
 */

// Nouns that can only refer to the article or the people who made it. The first
// nine were already rejected by cloud-morning-briefing.js; the rest are the gap
// that let "The reviewer ..." through.
const ARTICLE_INTERNAL_SUBJECT_RE =
  /^(?:the|this|that|these|those|a|an|our|its|their)\s+(?:article|story|report|author|reporter|piece|column|op-?ed|analysis|review|reviewer|reviewers|writer|writers|journalist|journalists|tester|testers|roundup|round-?up|rundown|run-?down|comparison|shoot-?out|showdown|walkthrough|walk-?through|explainer|hands-?on|write-?up|recap|preview|listicle)\b/i;

// A claim that cannot be wrong is not news. Rejected regardless of whether the
// title also names an entity: "Pixel and iPhone each have their own strengths"
// is no more informative than the unnamed version.
const HEDGE_ONLY_CLAIM_RE = new RegExp(
  [
    // "excels in distinct areas", "shines in different ways"
    /(?:excels?|excelled|shines?|shone|stands?\s+out|performs?\s+(?:well|better))\s+in\s+(?:distinct|different|differing|varying|various|certain|separate|several|some|its\s+own|their\s+own)\s+(?:areas|ways|respects|regards|categories|scenarios|situations|conditions)/,
    // "each has its own strengths", "both have their own tradeoffs"
    /(?:each|both|all|either|every\s+\w+)\s+(?:has|have|had|bring|brings)\s+(?:its|their|his|her)\s+(?:own\s+)?(?:strengths?|weaknesses|merits?|drawbacks?|advantages?|disadvantages|tradeoffs?|trade-?offs?|upsides?|downsides?|quirks?|pros)/,
    /\bpros\s+and\s+cons\b/,
    /\bups\s+and\s+downs\b/,
    /\broom\s+for\s+improvement\b/,
    /\bstrengths\s+and\s+weaknesses\b/,
    // "results vary", "your mileage may vary", "it depends"
    /\b(?:results?|outcomes?|experiences?|performance|mileage)\s+(?:may\s+|will\s+|can\s+|could\s+)?(?:vary|varies|varied|differ|differs|differed)\b/,
    /\byour\s+mileage\s+may\s+vary\b/,
    /\bit\s+(?:all\s+)?depends\b/,
    // "some are better than others", "each is better at some things"
    /\b(?:some|certain|a\s+few)\s+(?:\w+\s+){0,2}are\s+better\s+than\s+others\b/,
    /\bbetter\s+at\s+(?:some|certain|different)\s+things\b/,
    // "worth a look", "worth considering" as the entire verdict
    /\b(?:is|are|remains?)\s+(?:well\s+)?worth\s+(?:a\s+look|considering|your\s+time)\b/,
  ]
    .map((re) => `(?:${re.source})`)
    .join('|'),
  'i',
);

// NEWS-4d (ExampleCo, 2026-08-17): a title about the news item itself rather than about
// what happened. Measured on the AI tech card, the deriver was producing "The
// update matters while it ties adoption of personal AI agents to platform control"
// for every row. That names nothing, and because every article's summary carries
// the same "the update matters" framing, ten different stories produced ten
// near-identical titles and the dedup stage merged them into one row. So this
// shape costs the card its contents as well as its clarity.
//
// Tighter than the article-internal subject list above: the referent noun has to
// be followed by a meta verb, so a real headline like "The development cleared
// phase three trials" is untouched.
const ITEM_ABOUT_ITSELF_RE =
  /^(?:the|this)\s+(?:update|development|announcement|news|item|change|move|report|story|piece|warning)\s+(?:matters|means|shows|showed|highlights|highlighted|underscores|underscored|signals|signaled|suggests|suggested|comes|came|ties|tied|connects|connected|reflects|reflected|points|pointed|concerns|concerned)\b/i;

// Soft evaluative verbs that only carry weight when something is named.
const SOFT_EVALUATIVE_RE =
  /\b(?:found|finds|shows?|showed|reveals?|revealed|explains?|explained|discusses?|discussed|compares?|compared|explores?|explored|looks?\s+at|weighs?\s+in|breaks?\s+down|tested|tests?|tries?|tried)\b/i;

// Vague objects that carry no fact even next to a soft evaluative verb.
const VAGUE_OBJECT_RE =
  /\b(?:differences?|similarities|distinctions?|nuances?|considerations?|factors?|options?|choices?|takeaways?|insights?|things?|areas?|ways?|aspects?|details?|changes?|improvements?|issues?|challenges?|benefits?|features?)\b/i;

const UNNAMED_ENTITY_RE =
  /\b(?:both|the|these|those)\s+(?:companies|firms|agencies|lenders|investors)\b/i;

// Brands that are genuinely lowercase-initial: iPhone, eBay, xAI, nVidia.
const LOWERCASE_BRAND_RE = /^(?:i|e|x|n)[A-Z]/;

const STYLIZED_LOWERCASE_BRAND_PREFIX_BLOCK_RE =
  /^(?:a|about|after|all|an|and|as|at|but|by|for|from|has|he|her|his|if|in|into|is|it|its|more|new|no|not|now|of|on|one|or|over|said|says|she|so|that|the|their|them|these|they|this|those|to|told|we|when|while|will|with|you)$/;

function stylizedLowercaseBrandLeadToken(title) {
  const firstToken = (String(title || '').match(/^[A-Za-z0-9]+/) || [''])[0];
  const lowercasePrefix = (firstToken.match(/^[a-z]+(?=[A-Z])/) || [''])[0].toLowerCase();
  if (!lowercasePrefix || STYLIZED_LOWERCASE_BRAND_PREFIX_BLOCK_RE.test(lowercasePrefix)) {
    return '';
  }
  return firstToken;
}

// Terminal live QC sees the rendered title and source URL, but not the hidden
// publisher headline. Require the same mixed-case token in the URL slug so the
// independent live surface can contradict producer admission on different
// source evidence instead of trusting casing alone.
function newsVisibleTitleHasStylizedLowercaseBrandLead(title, sourceUrl = '') {
  const firstToken = stylizedLowercaseBrandLeadToken(title);
  if (!firstToken) return false;
  let rawUrl = String(sourceUrl || '').trim();
  if (/^\/\//.test(rawUrl)) rawUrl = `https:${rawUrl}`;
  else if (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:[/:?#]|$)/.test(rawUrl)) {
    rawUrl = `https://${rawUrl}`;
  }
  let pathname = '';
  try {
    pathname = new URL(rawUrl, 'https://briefing.invalid').pathname;
  } catch {
    pathname = rawUrl.split(/[?#]/, 1)[0].replace(/^[a-z]+:\/\/[^/]+/i, '');
  }
  return (pathname.match(/[A-Za-z0-9]+/g) || []).some(
    (token) => token.toLowerCase() === firstToken.toLowerCase(),
  );
}

function newsTitleHasStylizedLowercaseBrandLead(title, publisherTitle = '') {
  const firstToken = stylizedLowercaseBrandLeadToken(title);
  if (!firstToken) return false;
  return (String(publisherTitle || '').match(/[A-Za-z0-9]+/g) || []).some(
    (token) => token.toLowerCase() === firstToken.toLowerCase(),
  );
}

function titleTokens(title) {
  return String(title || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Does the title name anything a reader could look up: a proper noun anywhere
 * after the opening word, a lowercase-initial brand, a number, or a currency or
 * percentage figure.
 */
function namesSomething(title) {
  const s = String(title || '');
  if (/\d/.test(s)) return true;
  const tokens = titleTokens(s);
  for (let i = 0; i < tokens.length; i += 1) {
    const bare = tokens[i].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (bare.length < 2) continue;
    if (LOWERCASE_BRAND_RE.test(bare)) return true;
    // The opening word is capitalized by sentence case, so it proves nothing.
    if (i === 0) continue;
    if (/^[A-Z]/.test(bare)) return true;
  }
  return false;
}

/**
 * True when the title is too vague to be a news label. Callers treat this the
 * same way they treat "this looks like a body fragment": drop the candidate and
 * fall through to the next title source.
 *
 * @param {string} title
 * @returns {boolean}
 */
function newsTitleIsVagueOrReferentless(title) {
  const s = String(title || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return false; // emptiness is another predicate's job
  if (ARTICLE_INTERNAL_SUBJECT_RE.test(s)) return true;
  if (HEDGE_ONLY_CLAIM_RE.test(s)) return true;
  if (ITEM_ABOUT_ITSELF_RE.test(s)) return true;
  if (!namesSomething(s) && UNNAMED_ENTITY_RE.test(s)) return true;
  if (!namesSomething(s) && SOFT_EVALUATIVE_RE.test(s) && VAGUE_OBJECT_RE.test(s)) return true;
  return false;
}

module.exports = {
  newsTitleIsVagueOrReferentless,
  newsTitleHasStylizedLowercaseBrandLead,
  newsVisibleTitleHasStylizedLowercaseBrandLead,
  namesSomething,
  ARTICLE_INTERNAL_SUBJECT_RE,
  HEDGE_ONLY_CLAIM_RE,
  ITEM_ABOUT_ITSELF_RE,
};
