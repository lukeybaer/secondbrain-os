'use strict';
/**
 * Cloud news summarizer. Summarizing an article is just: fetch the URL, ask the
 * LLM to summarize. The cloud host has both (network + the askAI ladder), so the
 * cloud build does this itself -- no desktop required. The OLD cloud renderer
 * fabricated three identical generic commentary ExampleCoraphs per item instead of
 * summarizing; this replaces that with a real, grounded, 3-ExampleCoraph summary of
 * the actual article body.
 *
 * Anti-fabrication: we summarize ONLY real fetched article text (or a substantial
 * RSS excerpt). If neither exists we return null and the renderer shows an honest
 * headline-only note -- we never summarize from a bare headline.
 *
 * Pure + dependency-injected (fetchText, askAI, cache, now) so it is unit-testable
 * with no network and no LLM.
 */
const https = require('node:https');
const http = require('node:http');

// A news ExampleCoraph is "substantial" only when it clears the SAME floor the
// canonical briefing validator enforces (validate-briefing-quality.js: a
// too-thin ExampleCoraph is < 110 chars OR < 18 words). Centralized here so the
// cloud renderer gates full-summary rows at the exact bar the QC will judge
// them by -- a row that renders as a full 3-ExampleCoraph summary is guaranteed to
// clear the validator instead of being a "1/3 ExampleCoraphs" / "too-thin" defect.
const SUBSTANTIAL_ExampleCoRAPH_MIN_CHARS = 110;
const SUBSTANTIAL_ExampleCoRAPH_MIN_WORDS = 18;

// The per-ExampleCoraph upper bound when SHAPING a model summary. ExampleCo 2026-06-22:
// the ExampleCoraphs "used to be longer". The 2026-06-22 zero-silent-drops change
// trimmed each ExampleCoraph to 600 chars, which clipped the richer, multi-sentence
// summaries he wants. Raise the cap so a full 3-to-5-sentence ExampleCoraph survives
// whole (still trimmed only at a SENTENCE boundary, never mid-word). The
// canonical QC enforces only a LOWER floor (110 chars / 18 words), so a richer
// ExampleCoraph is always QC-valid; this cap just guards against a runaway wall of
// text on a pathologically long model response.
const ExampleCoRAPH_RICH_MAX_CHARS = 900;

function ExampleCoraphWordCount(p) {
  return String(p || '')
    .split(/\s+/)
    .filter(Boolean).length;
}

function isSubstantialNewsExampleCoraph(p) {
  const s = String(p || '').trim();
  return (
    s.length >= SUBSTANTIAL_ExampleCoRAPH_MIN_CHARS &&
    ExampleCoraphWordCount(s) >= SUBSTANTIAL_ExampleCoRAPH_MIN_WORDS
  );
}

function endsAsProse(p) {
  return /[.!?]["']?$/.test(String(p || '').trim());
}

const NEWS_SUMMARY_TERM_STOPWORDS = new Set(
  'about above after again against ahead also amid among before being between could daily from have into just more most news only other over said says that their them then there these they this those through under until what when where which while with would will'.split(
    /\s+/,
  ),
);

// Generic news-filler words. These appear in boilerplate "this matters because..."
// summaries and in many weak headlines, so a title-only grounding hit on one of
// these alone is NOT proof the summary is about the article (adversarial false-
// pass 2026-06-30: title "Markets brace for Fed decision" + filler that says
// "markets" hit titleHits >= 1 and published filler as a real summary). A hit on
// one of these counts toward the total but never as a DISTINCTIVE hit.
const NEWS_TITLE_BOILERPLATE_TERMS = new Set(
  'markets market leaders leader strategy strategies future reporting report reports public momentum stakeholders stakeholder headline headlines response responses coverage sources source development developments institutions planning information consequences outlook'.split(
    /\s+/,
  ),
);

function newsSummarySentences(ExampleCoraph) {
  return String(ExampleCoraph || '').match(/[.!?]["']?(?=\s|$)/g) || [];
}

function articleSummaryTerms(item = {}) {
  const raw = [item.title, item.excerpt, item.summaryText, item.sourceText]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const terms = raw.match(/\b[a-z][a-z0-9-]{3,}\b/g) || [];
  return [
    ...new Set(
      terms.filter((term) => !NEWS_SUMMARY_TERM_STOPWORDS.has(term) && !/^\d+$/.test(term)),
    ),
  ].slice(0, 12);
}

function isThreeExampleCoraphArticleSummary(paras, item = {}) {
  const list = Array.isArray(paras) ? paras : [];
  if (list.length !== 3) return false;
  if (!list.every(isSubstantialNewsExampleCoraph)) return false;
  if (!list.every(endsAsProse)) return false;
  if (!list.every((p) => newsSummarySentences(p).length >= 1)) return false;
  const terms = articleSummaryTerms(item);
  if (terms.length < 2) return true;
  const hasExpandedMetadata = Boolean(item.excerpt || item.summaryText || item.sourceText);
  if (!hasExpandedMetadata) {
    // Title-only grounding (no excerpt/body to match against): the summary must
    // reference at least one DISTINCTIVE term from the headline. A short title
    // ExampleCos few distinctive terms and a genuine on-topic summary often
    // paraphrases the headline verb (e.g. title "Repositioning retail for the AI
    // era" -> a real summary says "retail" but not "repositioning"/"era"), so
    // demanding 2-of-N wrongly stubbed legitimate articles. But >=1 of ANY term
    // is too lax: a generic-news word the headline shares with boilerplate filler
    // ("markets", "leaders", "future") gets hit by accident and publishes filler
    // as a real summary. So: accept on >=1 DISTINCTIVE (non-boilerplate) hit, or
    // >=2 total hits; reject a lone boilerplate hit and the zero-hit filler case.
    const titleHitTerms = terms.filter((term) => list.some((p) => p.toLowerCase().includes(term)));
    const titleHits = new Set(titleHitTerms).size;
    const distinctiveHits = new Set(
      titleHitTerms.filter((term) => !NEWS_TITLE_BOILERPLATE_TERMS.has(term)),
    ).size;
    return distinctiveHits >= 1 || titleHits >= 2;
  }
  const ExampleCoraphHits = list.map((ExampleCoraph) => {
    const lower = ExampleCoraph.toLowerCase();
    return terms.filter((term) => lower.includes(term)).length;
  });
  const totalHits = new Set(
    terms.filter((term) => list.some((ExampleCoraph) => ExampleCoraph.toLowerCase().includes(term))),
  ).size;
  const requiredHits = Math.min(3, terms.length);
  return totalHits >= requiredHits && ExampleCoraphHits.filter((n) => n > 0).length >= 2;
}

// Common abbreviations whose trailing period is NOT a sentence end. A naive
// "period + space + capital" boundary would cut a ExampleCoraph at "... the U.S."
// or "... said Dr." and leave a mid-sentence fragment that still ends in a
// period (so it would falsely pass endsAsProse). We reject any candidate
// boundary whose preceding token is one of these. (Codex review 2026-06-22.)
const SENTENCE_TRIM_ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'st',
  'sr',
  'jr',
  'prof',
  'gen',
  'sen',
  'rep',
  'gov',
  'lt',
  'sgt',
  'col',
  'capt',
  'inc',
  'ltd',
  'corp',
  'co',
  'vs',
  'etc',
  'no',
  'dept',
  'est',
  'fig',
  'al',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
]);

// Is the "." ending at index `endIdx` (exclusive) in `s` a REAL sentence end,
// not an abbreviation or a dotted initialism (U.S., e.g.)? The boundary already
// requires whitespace/end after it; here we reject when the token ending at the
// period is a known abbreviation, a single letter (initial / dotted initialism
// like U.S.), or itself ends in an inner period (e.g.).
function isRealSentenceEnd(s, endIdx, punctChar) {
  if (punctChar === '!' || punctChar === '?') return true; // never abbreviations
  // The word characters immediately before the period.
  const before = s.slice(0, endIdx - 1);
  const tokenMatch = before.match(/([A-Za-z][A-Za-z.]*)$/);
  if (!tokenMatch) return true;
  const token = tokenMatch[1];
  if (token.length === 1) return false; // a single-letter initial: "U." / "J."
  if (token.includes('.')) return false; // dotted initialism: "U.S" before final "." => "e.g", "U.S"
  if (SENTENCE_TRIM_ABBREVIATIONS.has(token.toLowerCase())) return false;
  return true;
}

// Trim a ExampleCoraph to <= max chars WITHOUT cutting mid-sentence. A naive
// slice(0, max) cut mid-word (cloud build: "item N has a ExampleCoraph that does
// not end as prose"). Instead keep only whole sentences that fit the budget:
// find the last REAL sentence-ending punctuation at or before `max` (skipping
// abbreviations / dotted initialisms like U.S. or Dr.) and cut there so the
// result always ends as a complete sentence. Returns '' when no sentence
// boundary fits (the caller then treats the summary as unusable and renders
// headline-only, never a truncated fragment).
function trimToSentenceBoundary(text, max) {
  const s = String(text || '').trim();
  if (!s) return '';
  if (s.length <= max && endsAsProse(s)) return s;
  const budget = s.slice(0, max);
  const re = /([.!?])["']?(?=\s|$)/g;
  let lastEnd = -1;
  let m;
  while ((m = re.exec(budget))) {
    const end = m.index + m[0].length;
    if (isRealSentenceEnd(budget, end, m[1])) lastEnd = end;
  }
  if (lastEnd <= 0) return '';
  return budget.slice(0, lastEnd).trim();
}

// The ONE canonical "honest headline-only" note. When an article body is too
// thin to ground a real 3-ExampleCoraph summary, the row renders the title + source
// link + this single factual line (never addressed to the reader, never
// fabricated). Every QC layer (validate-briefing-quality.js, the live dashboard
// verifier) recognizes this note via isHeadlineOnlyNote and EXEMPTS the row from
// the 3-ExampleCoraph rule while still COUNTING it as a rendered row -- so the title
// "(N)", the Coverage line, and the rendered row count stay equal with zero
// silent drops.
const HEADLINE_ONLY_NOTE =
  'Full summary unavailable: the article body was too thin to summarize; headline and source only.';

// Recognize the honest headline-only note in rendered text. Matches the
// canonical lead-in so paraphrase drift cannot smuggle an "in-between" thin
// summary past the gate; the distinguishing clause is the fixed
// "Full summary unavailable: the article body was too thin to summarize".
const HEADLINE_ONLY_NOTE_RE =
  /full summary unavailable:\s*the article body was too thin to summarize/i;

// ANCHORED whole-ExampleCoraph form: the ExampleCoraph must BE the canonical note start
// to end (allowing only surrounding whitespace), not merely CONTAIN the phrase.
// This is the strict gate used for the headline-only EXEMPTION so a single
// ExampleCoraph of "<note> + extra leaked prose" cannot skip the 3-ExampleCoraph rule
// (Codex review 2026-06-22). Drift-locked to HEADLINE_ONLY_NOTE.
const HEADLINE_ONLY_NOTE_ANCHORED_RE =
  /^full summary unavailable:\s*the article body was too thin to summarize;\s*headline and source only\.?$/i;

function isHeadlineOnlyNote(text) {
  return HEADLINE_ONLY_NOTE_RE.test(String(text || ''));
}

// ANCHORED row-level check (Codex review 2026-06-22): a row is an HONEST
// headline-only row only when its summary content is EXACTLY the canonical note
// and nothing else. An unanchored substring match would let an in-between row
// (a thin / truncated / sub-3-ExampleCoraph body that merely CONTAINS the note
// phrase) skip the 3-ExampleCoraph gate. `paras` is the list of NON-EMPTY summary
// ExampleCoraphs for the row (excluding title/source/meta lines): it must be a
// SINGLE ExampleCoraph that IS the note (anchored whole-string match, so trailing
// leaked prose in the same ExampleCoraph is rejected too).
function isHeadlineOnlyExampleCoraphs(paras) {
  const list = (Array.isArray(paras) ? paras : [])
    .map((p) => String(p || '').trim())
    .filter(Boolean);
  if (list.length !== 1) return false;
  return HEADLINE_ONLY_NOTE_ANCHORED_RE.test(list[0]);
}

const FETCH_TIMEOUT_MS = 12000;
const MAX_REDIRECTS = 4;
const MIN_BODY_CHARS = 400; // below this, treat as "no real body" (RSS-only)
const MIN_EXCERPT_CHARS = 200; // a substantial RSS excerpt we can still summarize
const MIN_CONTAINER_CHARS = 500; // a container shorter than this is a teaser, not the article
const RESOLVE_TIMEOUT_MS = 10000; // Google-News URL resolution budget (interstitial GET + batchexecute POST)

// Resilience contract for the LLM summarize step. Reproduced live on EC2
// (2026-06-22): the full cloud build left ~13 REAL fetchable articles
// (techcrunch, npr, technologyreview) as headline-only stubs, even though every
// one of them summarizes in <10s in isolation. Root cause: a SINGLE askAI call
// with no retry -- after dozens of earlier build LLM calls the codex rung
// transiently failed (starved / crashed / rate-limited) and returned null, so a
// perfectly summarizable body degraded to the honest stub on one hiccup.
//
// Category encoded (not the one incident): when the body IS substantial enough
// to summarize, an unusable LLM response is TRANSIENT and must be retried with
// exponential backoff before the row falls back to headline-only. The stub is
// reserved for genuinely-unsummarizable bodies (thin / unfetchable), never an
// LLM hiccup.
const NEWS_SUMMARIZE_RETRIES = 3; // total askAI attempts per item (1 try + 2 retries)
const NEWS_SUMMARIZE_RETRY_BASE_MS = 1500; // exponential backoff base between attempts
// Per-call LLM budget. A full 3-ExampleCoraph summary of a 5-6K-char article is a
// real generation; under build load a too-short rung timeout SIGTERMs an
// in-budget call (the 2026-05-30 90s-vs-120s incident). Match the documented
// 120s per-call budget so an in-budget summary is never killed mid-flight.
const NEWS_SUMMARIZE_RUNG_TIMEOUT_MS = 120000;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Compact, self-contained article fetch (returns plain text, '' on any failure).
function fetchArticleText(
  url,
  { timeoutMs = FETCH_TIMEOUT_MS } = {},
  redirectsLeft = MAX_REDIRECTS,
) {
  return new Promise((resolve) => {
    if (!url || !/^https?:\/\//i.test(url)) return resolve('');
    const lib = url.startsWith('https:') ? https : http;
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let req;
    try {
      req = lib.get(
        url,
        { headers: { 'user-agent': 'Mozilla/5.0 (SecondBrain briefing)' }, timeout: timeoutMs },
        (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            const next = new URL(res.headers.location, url).toString();
            return finish(fetchArticleText(next, { timeoutMs }, redirectsLeft - 1));
          }
          if (status !== 200) {
            res.resume();
            return finish('');
          }
          let html = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            html += c;
            if (html.length > 3_000_000) req.destroy();
          });
          res.on('end', () => finish(stripHtmlToText(html)));
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => finish(''));
    } catch {
      finish('');
    }
  });
}

// A news.google.com/rss/articles/<id> URL is a Google-News redirect stub, NOT
// the publisher article. It 302s to itself then 400s, and the CBMi... blob is an
// internal Google id, not a URL. We must resolve it to the real publisher URL
// before fetching the body, or the whole feed (immigration is ~100% these)
// summarizes 0 items.
function isGoogleNewsArticleUrl(url) {
  return /^https?:\/\/news\.google\.com\/rss\/articles\//i.test(String(url || ''));
}

// Raw HTTP GET that returns the body string ('' on any failure). Follows
// redirects. Unlike fetchArticleText this does NOT strip HTML -- the resolver
// needs the raw interstitial markup to read the signing params out of it.
function httpGetRaw(url, { timeoutMs = RESOLVE_TIMEOUT_MS } = {}, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve) => {
    if (!url || !/^https?:\/\//i.test(url)) return resolve('');
    const lib = url.startsWith('https:') ? https : http;
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let req;
    try {
      req = lib.get(
        url,
        {
          headers: { 'user-agent': 'Mozilla/5.0 (SecondBrain briefing)' },
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            let next;
            try {
              next = new URL(res.headers.location, url).toString();
            } catch {
              return finish('');
            }
            // A Google-News stub 302s to ITSELF; do not chase the self-loop.
            if (next === url) return finish('');
            return finish(httpGetRaw(next, { timeoutMs }, redirectsLeft - 1));
          }
          if (status !== 200) {
            res.resume();
            return finish('');
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            body += c;
            if (body.length > 3_000_000) req.destroy();
          });
          res.on('end', () => finish(body));
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => finish(''));
    } catch {
      finish('');
    }
  });
}

// Raw HTTP POST (form-encoded) that returns the body string ('' on any failure).
function httpPostForm(url, formBody, { timeoutMs = RESOLVE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!url || !/^https?:\/\//i.test(url)) return resolve('');
    const lib = url.startsWith('https:') ? https : http;
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let req;
    try {
      const u = new URL(url);
      req = lib.request(
        {
          method: 'POST',
          hostname: u.hostname,
          path: u.pathname + u.search,
          protocol: u.protocol,
          headers: {
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'user-agent': 'Mozilla/5.0 (SecondBrain briefing)',
            'content-length': Buffer.byteLength(formBody),
          },
          timeout: timeoutMs,
        },
        (res) => {
          if ((res.statusCode || 0) !== 200) {
            res.resume();
            return finish('');
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            body += c;
            if (body.length > 3_000_000) req.destroy();
          });
          res.on('end', () => finish(body));
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => finish(''));
      req.write(formBody);
      req.end();
    } catch {
      finish('');
    }
  });
}

// Build the batchexecute form body for the Fbv4je "garturlreq" RPC that decodes
// one Google-News article id into its real publisher URL.
function buildGarturlBody(articleId, ts, sig) {
  const inner = JSON.stringify([
    'garturlreq',
    [
      [
        'X',
        'X',
        ['X', 'X'],
        null,
        null,
        1,
        1,
        'US:en',
        null,
        1,
        null,
        null,
        null,
        null,
        null,
        0,
        1,
      ],
      'X',
      'X',
      1,
      [1, 1, 1],
      1,
      1,
      null,
      0,
      0,
      null,
      0,
    ],
    articleId,
    Number(ts),
    sig,
  ]);
  const payload = JSON.stringify([[['Fbv4je', inner, null, 'generic']]]);
  return 'f.req=' + encodeURIComponent(payload);
}

// Pull the resolved publisher URL out of a batchexecute response. The body is a
// )]}'-prefixed JSON-ish stream; the URL lives inside a "garturlres" tuple where
// quotes are backslash-escaped (e.g. ["garturlres","https://site/path",1]).
function parseGarturlResponse(text) {
  const s = String(text || '');
  const m = s.match(/garturlres\\?",\\?"(https?:\/\/[^"\\]+)/);
  return m ? m[1] : null;
}

/**
 * Resolve a news.google.com/rss/articles/<id> URL to the real publisher article
 * URL via Google News's batchexecute decode, the same path the desktop relies on
 * to escape the redirect stub. Best-effort and dependency-injected:
 *   - non-Google URLs pass straight through (returned unchanged)
 *   - any failure (no params, bad response, network/timeout) returns null
 *     so the caller summarizes nothing rather than the stub
 * httpGet/httpPost are injected so this is unit-testable with no network.
 */
async function resolveGoogleNewsUrl(
  url,
  { httpGet = httpGetRaw, httpPost = httpPostForm, timeoutMs = RESOLVE_TIMEOUT_MS } = {},
) {
  if (!isGoogleNewsArticleUrl(url)) return url; // not a stub: nothing to resolve
  try {
    const articleId = String(url).split('/articles/')[1].split('?')[0].split('/')[0];
    if (!articleId) return null;
    const html = await httpGet(url, { timeoutMs });
    if (!html) return null;
    const sig = (html.match(/data-n-a-sg="([^"]+)"/) || [])[1];
    const ts = (html.match(/data-n-a-ts="([^"]+)"/) || [])[1];
    if (!sig || !ts) return null;
    const resp = await httpPost(
      'https://news.google.com/_/DotsSplashUi/data/batchexecute',
      buildGarturlBody(articleId, ts, sig),
      { timeoutMs },
    );
    const real = parseGarturlResponse(resp);
    if (real && /^https?:\/\//i.test(real) && !/news\.google\.com/i.test(real)) return real;
    return null;
  } catch {
    return null;
  }
}

function htmlFragmentToText(h) {
  return String(h || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#8217;|&#39;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#[0-9]+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Publisher CHROME that the improved <p>-reconstruction now drags in alongside
// the real article body: NPR-style show credits, bylines / "<NAME> reports"
// credits, "Read full/more" prompts, newsletter/subscribe CTAs, "Related:" /
// "More from" recirculation, photo caption/credit lines, and social-share text.
// Incident 2026-06-23: the build QC failed on a leaked "Heard on All Things
// Considered" credit and a "publisher chrome instead of briefing prose" item.
// Each rule is anchored to the chrome's own shape so it strips the boilerplate
// WITHOUT eating real article prose (no over-strip): the body fed to the LLM and
// the excerpt fallback is clean article prose only.
//
// Category encoded (not the one incident): the canonical publisher-chrome
// patterns are removed from the extracted body before summarizing, the real
// prose survives. The set covers (and stays a subset of) the chrome the build QC
// bans (validate-briefing-quality.js: newsArtifactRe + banned) so chrome stripped
// here can never reach the QC gate; it is intentionally NOT exhaustive of every
// QC pattern (some QC bans are page-structure artifacts, not prose chrome).
//
// Over-strip is the cardinal sin (Codex review 2026-06-23): a rule must match the
// chrome's OWN boilerplate shape and nothing else. Every rule that could collide
// with real prose is anchored to a clause boundary (start-of-text or after
// sentence punctuation, via lookbehind so the prior sentence's period survives)
// AND is case-SENSITIVE where the chrome is a Capitalized label ("Heard on",
// "Read more" CTA) so the lowercase verb sense ("witnesses heard on", "read more
// books") is preserved.
const CLAUSE_START = '(?<=^|[.!?]\\s)';

// SINGLE SOURCE OF TRUTH for the categorical publisher/page-chrome LABELS that
// both this stripper AND the live render QC detector (verify-dashboard-cards-
// live.js NEWS_PUBLISHER_CHROME) treat as chrome. The detector compiles its
// chrome regex from newsPublisherChromeSource() below, and stripPublisherChrome
// runs a generic clause-anchored pass over these same labels, so the stripper
// and the detector can never disagree about what a chrome LABEL is: a label the
// detector flags is, by construction, a label the stripper removes.
//
// These are GENERALIZABLE Capitalized boilerplate labels (NPR/CBS show credits,
// caption toggles, navigation/recirculation CTAs, law-firm marketing banners).
// They are intentionally NOT incident-pinned literal place names, bare company
// names, or ordinary article sentences. A prior detector revision (commit
// 40b6a2e5) pinned real prose fragments ("Gulf of Oman", "Strait of Hormuz",
// "The move was highly unusual", "faking his own death", "Tankers and cargo
// vessels", ...) into the detector; those flagged legitimate world-news prose as
// chrome (world news routinely names those straits) and were removed. A chrome
// detector must encode the CATEGORY, never the one literal trigger
// (feedback_frugal_regression_tests.md).
//
// Over-strip guard: each label is a Capitalized boilerplate phrase, and the
// generic strip pass is clause-anchored AND case-SENSITIVE, so a lowercase
// in-prose sense survives. Bare company names / common lowercase phrases that
// over-flag prose ("Getty Images", "AP Photo", "more coverage") are deliberately
// NOT here -- they belong only inside a chrome SHAPE ("Credit: Getty Images"),
// which the shape rules in PUBLISHER_CHROME_RULES handle (Codex review
// 2026-06-30).
const NEWS_PUBLISHER_CHROME_LABELS = [
  'Image source',
  'Image caption',
  'Courtesy photo',
  'Business reporter',
  'BBC Verify',
  'hide caption',
  'toggle caption',
  'Share Twitter',
  'Share Copy URL',
  'Read more Overview',
  'Add NBC News to Google',
  'CBS News Sunday Morning',
  'Jane Pauley hosts',
  "Sunday Morning's familiar faces",
  'Essential American Songbook',
  'LISTEN & FOLLOW',
  'Audio will be available',
  'Download it here',
  'Leave your feedback',
  'Request a Consultation',
  'Start RFP Process',
  'A Global Law Firm',
  'JOIN AILA TODAY',
  'Trailblazer in Legal Technology',
  'Enhance your law practice',
];

// Structural chrome patterns the detector recognizes that are NOT fixed labels
// (relative/absolute datelines, NPR "Heard on <Show>", CBS broadcast promos, a
// raw "deltaMinutes" template token). The detector compiles these into its regex
// alongside the literal labels above; the stripper already covers each via a
// clause-anchored rule in PUBLISHER_CHROME_RULES. Exported so the detector and
// stripper share one definition of the structural shapes too. These are matched
// case-INSENSITIVELY by the detector (the detector regex ExampleCos the 'i' flag);
// the stripper rules that cover them stay case-sensitive + clause-anchored, which
// is a strict subset, so anything the stripper removes the detector also flags.
//
// The dateline + NPR-credit patterns must encode the chrome SHAPE, never a bare
// "<verb> N" count or a lowercase legal verb (live NEWS-CHROME false positive on
// US NEWS item 1 + US IMMIGRATION NEWS item 2, 2026-06-30). After Google-News
// URLs began resolving to the real publisher, full BODIES reached the summaries
// and the old loose `\bPublished \d+\b` / `\bUpdated \d+\b` / "Heard on <Cap>"
// flagged ordinary fresh prose -- "the rule was published 30 days before...", "the
// agency published 12 documents", "the policy was updated 3 times", "the bill was
// heard on Capitol Hill / heard on Tuesday". Because the detector compiles with
// the 'i' flag, case cannot be relied on: the SHAPE is the discriminator. A real
// publisher dateline is "Published|Updated" immediately followed by a DATE
// (day + month name) or a RELATIVE timestamp ("N minutes/hours/days ago") -- never
// a bare count that continues into ordinary words. (A bare "Published HH:MM" clock
// time with no date is deliberately NOT flagged: the stripper's dateline rules only
// remove the day+month and relative-"ago" forms, so flagging a clock-only shape the
// stripper leaves would reopen a detector/stripper gap. A real dateline that shows
// a time shows it WITH a date -- "Published 29 June 2026, 04:34 BST" -- which the
// month branch already flags.) A real NPR credit is "Heard on <named show>", not
// the lowercase "heard on <weekday/place>" legal/legislative sense. This keeps the
// stripper (which already only removes these dateline/credit SHAPES, case-
// sensitively + clause-anchored) and the detector reconciled: everything the
// tightened detector flags is still removed by the stripper, and the ordinary-prose
// false positives are gone.
const NEWS_PUBLISHER_CHROME_PATTERNS = [
  String.raw`\b(?:Published|Updated)\s+(?:\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b|\d{1,2}\s+(?:minutes?|hours?|days?)\s+ago\b)`,
  String.raw`\bHeard on\s+(?:All Things Considered|Weekend All Things Considered|Morning Edition|Weekend Edition(?:\s+(?:Saturday|Sunday))?|Fresh Air|All Songs Considered|Here and Now|On Point|The Takeaway|Marketplace)\b`,
  String.raw`\bbroadcast on (?:the )?CBS\b`,
  String.raw`\bstreams on (?:the )?CBS\b`,
  String.raw`\bwatch CBS News\b`,
  String.raw`\[?deltaMinutes?\]?`,
];

// Escape a literal label for use inside a RegExp source. "&" / "(" / "." etc. in
// a label ("LISTEN & FOLLOW") must match literally, not as a regex metachar.
function escapeRegExpLiteral(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build the word-boundary-anchored literal-label alternation source that both the
// detector regex and the stripper's generic label pass consume. A label that
// starts/ends with a word char gets a \b on that side so a partial-word match
// ("Sharer") is avoided.
function newsChromeLabelAlternationSource() {
  return NEWS_PUBLISHER_CHROME_LABELS.map((label) => {
    const escaped = escapeRegExpLiteral(label);
    const lead = /^\w/.test(label) ? '\\b' : '';
    const tail = /\w$/.test(label) ? '\\b' : '';
    return lead + escaped + tail;
  }).join('|');
}

// The full chrome-detector alternation source (labels + structural patterns).
// verify-dashboard-cards-live.js compiles this into NEWS_PUBLISHER_CHROME so the
// authoritative live QC definition of "chrome" stays reconciled with the stripper
// from a single place. Returned as a plain source string (no flags, no global
// state) so the importer can compile a fresh, stateless RegExp at each call site.
function newsPublisherChromeSource() {
  return [newsChromeLabelAlternationSource(), ...NEWS_PUBLISHER_CHROME_PATTERNS].join('|');
}

// The stripper's generic label pass: every shared label, clause-anchored and
// case-SENSITIVE, consuming only an optional immediately-trailing terminal mark
// (never a greedy tail). This is the rule that mechanically reconciles the
// stripper with the detector's literal-label set.
const SHARED_LABEL_CHROME_RE = new RegExp(
  CLAUSE_START + '(?:' + newsChromeLabelAlternationSource() + ')[.!?]?',
  'g',
);

const PUBLISHER_CHROME_RULES = [
  // NPR-style show credit: "Heard on All Things Considered". CASE-SENSITIVE
  // "Heard on" at a clause start -- the lowercase verb "witnesses heard on
  // Capitol Hill" is real prose and must survive.
  new RegExp(CLAUSE_START + 'Heard on [A-Z][^.!?\\n]{0,120}[.!?]?', 'g'),
  // "<NAME> reports/writes/wrote" credit (NPR/AP staff line). A reporting credit
  // is a STANDALONE clause: clause start + the verb ENDS the clause (period). A
  // mid-sentence "said PRIVATE_NAME Smith reported the findings to Congress" is real
  // prose (preceding subject, verb runs on) and must NOT match.
  new RegExp(
    CLAUSE_START +
      '[A-Z][a-z]+(?:\\s+[A-Z]\\.?)?\\s+[A-Z][a-z]+\\s+(?:reports|reported|writes|wrote)\\s*[.!?]',
    'g',
  ),
  // Wire-service byline, handled BEFORE the generic human-name byline so
  // "By The Associated Press" is removed whole (the generic rule would leave a
  // dangling "Press."). Clause-anchored.
  new RegExp(
    CLAUSE_START +
      'By (?:The Associated Press|Reuters|Agence France-Presse|AFP|Bloomberg|The Canadian Press)\\b[^.!?\\n]{0,40}[.!?]?',
    'g',
  ),
  // Byline with a desk role. Two safe shapes only (Codex review 2026-06-23 -- an
  // unanchored "<Name>, <Role> ..." ate real appositive prose like "the award
  // went to Jane Smith, Reporter of the Year, after ..."):
  //   (a) "By <Name>[ and <Name>], ...<ROLE>..." -- the leading "By" + a comma +
  //       a role KEYWORD anywhere in the byline tail makes it an unambiguous
  //       byline. Once a role keyword is present, the WHOLE byline line (any beat
  //       modifier: "Technology Reporter", "National Security Correspondent", plus
  //       "in Chief"/"for NPR" extensions) is consumed up to the clause end, so no
  //       role fragment leaks. The mandatory role keyword keeps a rare "By <Name>,
  //       who founded the firm, ..." prose opener (no role word) from matching.
  //   (c) clause-start role-FIRST "<Role>, <Name>" -- this is the only role byline
  //       the build QC bans (newsArtifactRe + banned), so it is the form worth
  //       stripping; clause-anchored so an embedded "..., including Editor, Jane
  //       Doe, ..." is not touched.
  // The role-SECOND no-"By" form ("Jane Smith, Reporter.") is intentionally NOT
  // stripped: QC does not ban it and it is indistinguishable from a real
  // title-case appositive ("Jane Smith, Editor In Chief, said ...").
  /\bBy [A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+(?:\s+and\s+[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+)?,\s+(?:[A-Za-z][^.!?\n]{0,58}?\s)?(?:Correspondent|Reporter|Editor|Staff Writer|Contributor|Columnist|Anchor|Bureau Chief)\b(?:\s+(?:in|for|of|at|and|the)\s+[A-Z][A-Za-z]*){0,4}[.!?]?(?=\s|$)/g,
  new RegExp(
    CLAUSE_START +
      '(?:Correspondent|Reporter|Editor),\\s+[A-Z][a-z]+(?:\\s+[A-Z]\\.?)?\\s+[A-Z][a-z]+(?![ \\t]+[a-z])[.!?]?(?=\\s|$)',
    'g',
  ),
  // Standalone "By <NAME>" credit line at a clause boundary (no role tag, no wire
  // service -- those are handled above).
  new RegExp(
    CLAUSE_START +
      'By [A-Z][a-z]+(?:\\s+[A-Z]\\.?)?\\s+[A-Z][a-z]+(?:\\s+and\\s+[A-Z][a-z]+\\s+[A-Z][a-z]+)?\\b[^.!?\\n]{0,40}?(?=[.!?]|\\s+[A-Z]|$)',
    'g',
  ),
  // "Read full article" / "Read the full article" / "Read more" CTA. CASE-
  // SENSITIVE and clause-anchored; the CTA is chrome ONLY when it ENDS its clause
  // -- immediately followed by sentence punctuation (which it consumes, leaving no
  // orphan period) or end-of-text. A real "Read more books than peers" continues
  // into a word, not punctuation, so it is preserved (Codex review 2026-06-23).
  // "Read more Overview" is the specific QC-banned heading: strip only the two-word
  // label, never the sentence that follows it.
  new RegExp(CLAUSE_START + 'Read more Overview\\b', 'g'),
  new RegExp(CLAUSE_START + 'Read (?:the )?(?:full article|more)(?![ \\t]+[A-Za-z])[.!?]?', 'g'),
  // Newsletter / subscribe CTAs (imperative at a clause start). The lowercase
  // "people who subscribe to the newsletter get updates" sense is preserved by
  // the clause-start anchor + capitalized imperative.
  new RegExp(
    CLAUSE_START +
      '(?:Sign up|Subscribe)(?:\\s+(?:for|to))?\\s+(?:our\\s+|the\\s+)?(?:free\\s+)?newsletter\\b[^.!?\\n]{0,140}[.!?]?',
    'g',
  ),
  // Recirculation: "Related: ..." (label + colon) and the QC-banned
  // "Related insights/offices/contacts" headings. CASE-SENSITIVE Capitalized
  // "Related" at a clause start, so "the memo used related: contacts" (lowercase,
  // mid-sentence) and "the agency posted related insights" are preserved as real
  // prose (Codex review 2026-06-23). "More from <Outlet>" is intentionally NOT
  // stripped: QC does not ban it and "More from Amazon will arrive next quarter"
  // is real sentence-start prose a rule cannot distinguish from a recirc heading.
  new RegExp(CLAUSE_START + 'Related:\\s*[^.!?\\n]{0,160}[.!?]?', 'g'),
  // The "Related insights/offices/contacts" heading is a FIXED label: strip only
  // the label plus an immediately-trailing terminal punctuation, never a greedy
  // run to the next sentence boundary (a label with no trailing punctuation must
  // not eat the following article sentence) (Codex review 2026-06-23).
  new RegExp(CLAUSE_START + 'Related (?:insights|offices|contacts)\\b[.!?]?', 'g'),
  // Misc standalone publisher chrome the QC bans, all CASE-SENSITIVE Capitalized
  // labels at a clause start (the lowercase "paid to sponsor message testing",
  // "users can download embed codes" senses are real prose and survive). A bare
  // "N hours ago" line is intentionally NOT stripped: flattened to one line it is
  // indistinguishable from real prose ("2 hours ago the agency issued ...").
  // These are FIXED labels: strip ONLY the exact label plus an immediately-
  // trailing terminal punctuation. A bounded "{0,N}" tail would eat the next real
  // article sentence when the label has no trailing punctuation ("Sponsor Message
  // The agency confirmed ...") (Codex review 2026-06-23).
  new RegExp(CLAUSE_START + 'Sponsor Message\\b[.!?]?', 'g'),
  new RegExp(CLAUSE_START + 'Courtesy photo\\b[.!?]?', 'g'),
  new RegExp(CLAUSE_START + 'Business reporter\\b[.!?]?', 'g'),
  new RegExp(CLAUSE_START + 'BBC Verify\\b[.!?]?', 'g'),
  new RegExp(
    CLAUSE_START + '(?:Published|Updated)\\s+\\d{1,2}\\s+(?:minutes?|hours?|days?)\\s+ago\\b[.!?]?',
    'g',
  ),
  new RegExp(
    CLAUSE_START +
      '(?:Published|Updated)\\s+\\d{1,2}\\s+[A-Z][a-z]+\\s+\\d{4}(?:,\\s*\\d{1,2}:\\d{2}\\s*[A-Z]{2,4})?\\b[.!?]?',
    'g',
  ),
  // ("Latest Big pharma", "Help ensure someone", "MAKING AMERICA SAFE AGAIN" were
  // removed here 2026-06-30: incident-pinned fragments, not proven general chrome.
  // They were also removed from the live detector. See NEWS_PUBLISHER_CHROME_LABELS.)
  /^Text settings Story text Size (?:Small|Standard|Large|\*){0,80}\s*Standard Wide Links Standard Orange \* Subscribers only Learn more Minimize to nav\s*/i,
  /^Listen Listen \(\d+\s+mins?\) Save Click here to share on social media share-nodes\b[\s\S]{0,260}?Add Al Jazeera on Google info\s*/i,
  /^Toggle Play\s+/i,
  /^News\s+(?:AI|Mobile Smartphones|EVs and Transportation)\s+/i,
  /^Big Tech\s+/i,
  // Leading date-fragment + relative-timestamp dateline (live WORLD NEWS miss
  // 2026-06-30: the body opened "une 2026 Updated 7 hours ago Many areas ..."
  // where an earlier strip left a partial month, followed by a relative "Updated
  // N hours ago" dateline). A "<word> <year> (Published|Updated) N
  // (minutes|hours|days) ago" run at the VERY START of the body is a publisher
  // dateline fragment, not article prose (real prose does not open that way).
  /^[A-Za-z]+ \d{4} (?:Published|Updated) \d{1,2} (?:minutes?|hours?|days?) ago\b[.!?]?\s*/,
  /^Why you can trust ZDNET\b[\s\S]{0,360}?(?:ZDNET Recommendations|Our process)\s*/i,
  new RegExp(CLAUSE_START + "Don'?t Miss an Update\\b[.!?]?", 'g'),
  new RegExp(CLAUSE_START + 'Download\\s+Embed\\b[.!?]?', 'g'),
  new RegExp(CLAUSE_START + 'Back transcript\\b[.!?]?', 'g'),
  new RegExp(CLAUSE_START + 'Transcript(?![ \\t]+[A-Za-z])[.!?]?', 'g'),
  new RegExp(
    CLAUSE_START +
      'To play this video you need to enable JavaScript in your browser\\.\\s*This video can not be played\\.?\\s*',
    'g',
  ),
  /\bFigure caption,\s*[^.!?\n]{0,180}[.!?]?/g,
  new RegExp(CLAUSE_START + 'Image source,\\s*[^.!?\\n]{0,180}\\s+Image caption,\\s*', 'g'),
  new RegExp(
    CLAUSE_START +
      'By [A-Z][A-Za-z .-]{2,80}\\s+(?:Business reporter|News reporter|Reporter|Correspondent|Technology reporter|Paris correspondent|BBC News)\\s+Published\\s+\\d{1,2}\\s+[A-Z][a-z]+\\s+\\d{4}(?:,\\s*\\d{1,2}:\\d{2}\\s*[A-Z]{3})?(?:\\s+Updated\\s+[^.!?\\n]{0,80})?',
    'g',
  ),
  /\bBy [A-Z][A-Za-z .-]{2,80}\s+(?:Business reporter|News reporter|Reporter|Correspondent|Technology reporter|Paris correspondent|BBC News)\s+Published\s+\d{1,2}\s+[A-Z][a-z]+\s+\d{4}(?:,\s*\d{1,2}:\d{2}\s*[A-Z]{3})?(?:\s+Updated\s+[^.!?\n]{0,80})?/g,
  // GENERAL inline byline + dateline run (live WORLD NEWS miss 2026-06-29). The
  // two BBC rules above only match a FIXED role list ("Reporter", "Correspondent",
  // ...) immediately after the name; live BBC chrome leaked a lowercase non-listed
  // role ("Seoul correspondent"), TWO authors joined by "and", and the run sat
  // MID-sentence with no preceding period ("...South Korea By PRIVATE_NAME Kwon, Seoul
  // correspondent and Fan Wang Published 29 June 2026, 04:34 BST Updated 3 hours
  // ago ..."). Category encoded: a "By <author run> ... Published|Updated <date>"
  // byline+dateline is page chrome wherever it sits. Over-strip is bounded by
  // making the "Published|Updated <date>" marker MANDATORY (a real "By Monday, the
  // committee ..." opener or a bare "By <Name>" with no dateline does NOT match)
  // and by stopping the author/role tail at the first sentence punctuation so the
  // preceding article sentence is never eaten. The date matches BOTH orders
  // ("29 June 2026" and "June 26, 2026"); the trailing time/timezone and any
  // "Updated ... ago" tail are consumed up to the clause end so no fragment leaks.
  /\bBy [A-Z][a-z]+[^.!?\n]{0,90}?(?:Published|Updated)\s+(?:\d{1,2}\s+[A-Z][a-z]+\s+\d{4}|[A-Z][a-z]+\s+\d{1,2},\s+\d{4}|\d{1,2}\s+(?:minutes?|hours?|days?)\s+ago)(?:,?\s*\d{1,2}:\d{2}\s*(?:[AP]M\s+)?[A-Z]{2,4})?(?:\s+Updated\s+[^.!?\n]{0,40}?ago)?[^.!?\n]{0,15}?(?=[.!?]|\s+[A-Z]|$)/g,
  // BBC-style "Reporting from" byline run (live WORLD NEWS miss 2026-06-30:
  // "By Nomsa Maseko, BBC Africa, Reporting from Durban." and "By Thomas Naadi,
  // BBC Africa, Reporting from Accra and Hafsa Khalil Published 33 minutes ago").
  // A leading "By <Name>" + a "Reporting from <Place>" tag is an unambiguous BBC
  // byline: real article prose never reads "By <Name>, BBC <section>, Reporting
  // from <Place>". CASE-SENSITIVE "Reporting" (the lowercase "reporting from the
  // field" and a no-"By" "Reporting from HQ, the analyst said" opener are real
  // prose and survive). The whole byline (optional second author) is consumed up
  // to the clause end so no name/place fragment leaks; any trailing
  // Published/Updated dateline on the same row is taken out by the rule above.
  /\bBy [A-Z][a-z]+[^.!?\n]{0,120}?\bReporting from [A-Z][^.!?\n]{0,80}?(?=[.!?]|$)/g,
  /\bShare Add [A-Z][A-Za-z ]{1,80} to Google\b[.!?\s]*/g,
  /\bLimited time:\s*Save\s+\d+%\s+on\s+[A-Z][A-Za-z ]{1,80}\s+subscription\b[.!?\s]*/g,
  // Photo caption / credit lines: a Capitalized label + colon at a clause start.
  // The colon REQUIRED form bounds the caption text up to the next sentence end,
  // which is correct for a caption ("Photo: a worker stands outside. Credit:
  // Getty."). "The photo: evidence dispute" (lowercase label, mid-sentence) is
  // real prose and is preserved by the clause-start + case-sensitive anchor.
  new RegExp(CLAUSE_START + '(?:Photo|Image|Caption|Photograph):\\s*[^.!?\\n]{0,160}[.!?]?', 'g'),
  new RegExp(CLAUSE_START + 'Credit:\\s*[^.!?\\n]{0,120}[.!?]?', 'g'),
  // Social-share boilerplate: "Share Twitter Facebook LinkedIn" (the QC-banned
  // run). CASE-SENSITIVE so "companies share on a pro-rata basis" survives, and
  // the platform run must actually follow "Share".
  /\bShare\s+(?:Twitter|Facebook|LinkedIn)(?:\s+(?:Twitter|Facebook|LinkedIn))*\b[^.!?\n]{0,40}[.!?]?/g,
  /\b(?:Twitter|Facebook|LinkedIn|Email|Print|Copy link)(?:\s+(?:Twitter|Facebook|LinkedIn|Email|Print|Copy link)){2,}\b/g,
];

// Strip the canonical publisher-chrome patterns from already-extracted plain
// text, leaving clean article prose. Whitespace-normalized at the end so a
// removed run does not leave a double space. Real prose is preserved because
// each rule is anchored to the chrome's own boilerplate shape.
function stripPublisherChrome(text) {
  // Normalize ALL whitespace (including newlines / blank-line ExampleCoraph breaks)
  // to single spaces FIRST so the clause-start lookbehind ((?<=^|[.!?]\s)) sees a
  // consistent "[.!?] " boundary even where chrome sits after a "\n\n" ExampleCoraph
  // break ("Real sentence.\n\nHeard on ..."). Without this a chrome label that
  // leads a ExampleCoraph escapes the clause anchor (Codex review 2026-06-23).
  let s = String(text || '').replace(/\s+/g, ' ');
  // Collapse whitespace BETWEEN each rule so the clause-start lookbehind always
  // sees a single space: an earlier rule that replaces a chrome run with a space
  // can leave ". <space><space>Sponsor Message ...", and a multi-space gap would
  // defeat the next rule's fixed lookbehind (keep anchored AND order-independent).
  for (const re of PUBLISHER_CHROME_RULES) {
    s = s
      .replace(re, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/^\s+/, '');
  }
  // GENERIC shared-label pass: strip every entry in NEWS_PUBLISHER_CHROME_LABELS
  // (the single source of truth the live detector also compiles from). This is
  // what GUARANTEES the stripper covers every chrome LABEL the detector flags --
  // a label cannot be in the detector list without also being removed here. The
  // pass is clause-anchored (start-of-text or after sentence punctuation, via the
  // CLAUSE_START lookbehind) AND case-SENSITIVE (matchLabelChromeRe ExampleCos no 'i'
  // flag), so a lowercase in-prose sense survives ("the editor said to leave your
  // feedback later" is preserved; a "Leave your feedback" CTA at a clause start is
  // removed). Each label is consumed with an optional immediately-trailing
  // terminal punctuation only -- never a greedy run -- so a label with no trailing
  // punctuation does not eat the following real sentence.
  s = s
    .replace(SHARED_LABEL_CHROME_RE, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^\s+/, '');
  // A removed chrome run can leave an orphaned punctuation island (". ." when a
  // CTA between two sentences was stripped). Collapse a lone punctuation mark
  // that is now stranded between spaces so the result reads as clean prose.
  s = s
    // Pull a stranded punctuation mark back onto the preceding word ("text . X"
    // -> "text. X") so a stripped CTA does not leave a floating period.
    .replace(/\s+([.!?,;:])/g, '$1')
    // Collapse a sentence mark that is EXACTLY doubled by a strip ("Tuesday.. The")
    // to one. A real ellipsis ("here...") is a run of 3+ and is left intact: the
    // pattern requires a non-dot (or start) before the pair and a non-dot (or end)
    // after, so it never bites into a 3+ run.
    .replace(/(^|[^.!?])([.!?])\2(?![.!?])/g, '$1$2')
    // Drop a comma/semicolon/colon that is now stranded right after a sentence
    // mark because a clause-start label that began with the orphan's clause was
    // stripped ("Markets fell. Image source, Reuters." -> "Markets fell., Reuters."
    // -> "Markets fell. Reuters."). Only a secondary mark immediately following a
    // terminal mark is collapsed; real prose never writes ".,".
    .replace(/([.!?])\s*[,;:]+\s*/g, '$1 ')
    // A clause-initial label whose rule stopped BEFORE the sentence period (the
    // "By <Name>" lookahead) leaves a leading orphan period once the label is
    // gone ("By Jane Smith. The agency" -> ". The agency"). Drop a sentence mark
    // that now LEADS the text (Codex review 2026-06-23).
    .replace(/^\s*[.!?,;:]+\s*/, '');
  return s.replace(/\s+/g, ' ').trim();
}

// A page whose visible text reads like an error / not-found / consent wall is NOT
// a real article body. Treating it as one (it can still be 1000+ chars of nav
// chrome) was how a removed/blocked story slipped past MIN_BODY_CHARS and got
// summarized from junk. We detect the canonical error signatures, but ONLY when
// they LEAD the candidate text -- a real article that merely mentions "access
// denied" or "page not found" mid-body (security / legal / tech reporting) leads
// with real article prose and must be preserved (Codex review 2026-06-22). The
// signature is matched anchored at the very start of the extracted text.
const ERROR_PAGE_LEAD_RE =
  /^(?:404\s+(?:page\s+)?not\s+found|page\s+not\s+found|we(?:'re| are)?\s+sorry[,!]?\s+we\s+seem\s+to\s+have\s+lost\s+this\s+page|we\s+seem\s+to\s+have\s+lost\s+this\s+page|access\s+denied|are\s+you\s+a\s+(?:robot|human)|enable\s+javascript\s+to\s+continue|please\s+verify\s+you\s+are\s+(?:a\s+human|human)|this\s+page\s+(?:could\s+not|couldn'?t)\s+be\s+found)\b/i;

// SHORT single-word error reasons that may follow an error lead after a dash or
// colon ("Access denied - blocked"). These are unambiguous: a real headline does
// not read "Access denied - forbidden", so we do not require an end anchor for
// them (Codex review rounds 7, 8).
const ERROR_REASON_WORD =
  '(?:blocked|forbidden|denied|restricted|unavailable|unauthori[sz]ed|prohibited|403|404|401|429)';

// The multi-word permission / authorization boilerplate that an error page shows
// after the lead ("you do not have permission", "permission denied", ...). This
// is conclusive ONLY when it COMPLETES the boilerplate sentence -- optionally a
// short generic completion ("to access this resource") then end-of-segment or
// sentence punctuation. A real news headline that quotes the phrase and then
// continues into reporting ("... you do not have permission lawsuit proceeds") is
// NOT matched, so that story is preserved (Codex review rounds 8, 9, 10).
const ERROR_BOILERPLATE_PHRASE =
  "(?:you\\s+(?:do\\s+not|don't|are\\s+not|aren't)\\s+(?:have\\s+(?:permission|access)|authori[sz]ed|allowed)|you\\s+don'?t\\s+have\\s+(?:permission|access)|permission\\s+denied|not\\s+authori[sz]ed|not\\s+allowed)";
// The boilerplate phrase is conclusive only when it COMPLETES: an optional short
// generic completion ("to access this resource"), then a sentence boundary
// (sentence punctuation or end-of-text). A headline that continues into a new
// word ("... permission lawsuit proceeds") has no boundary there and is preserved.
const ERROR_BOILERPLATE_COMPLETION =
  '(?:\\s+to\\s+(?:access|view|see|reach)\\s+this\\s+(?:resource|page|content|site|server))?(?=[\\s]*(?:[.!?:;,]|$))';

// The error phrase must be STANDALONE at the lead: immediately followed by
// end-of-text or sentence/clause punctuation -- NOT by a continuing word that
// turns it into a noun phrase. This keeps a real headline like "Access denied
// vulnerabilities are spreading" (the phrase runs on into more prose) from being
// treated as an error page, while still catching "Access denied." and "Access
// denied -- you do not have permission". A page whose error phrase is announced
// in a heading ("404 Page not found", "Access denied") with trailing chrome is
// caught separately by pageHasErrorHeading, which is the primary heading signal
// (Codex review 2026-06-22, round 4).
// The error phrase counts as a STANDALONE error lead when it is immediately
// followed by:
//   - end-of-text, or sentence-ending punctuation (. ! ?), or
//   - a colon / dash / comma / semicolon that introduces a KNOWN error reason
//     ("Access denied - blocked", "Access denied: forbidden"), or end/period.
// A colon/dash that introduces ORDINARY headline prose ("Access denied: banks
// face new attacks") is NOT an error lead, so that real story is preserved
// (Codex review rounds 5, 6, 7).
// After the error lead, accept: end-of-text / sentence punctuation, OR a
// dash/colon run followed by EITHER a short error word, OR end/sentence-punct, OR
// the permission boilerplate that COMPLETES (generic completion + end). The
// boilerplate must complete-or-end so a real "Access denied - you do not have
// permission lawsuit proceeds" headline is preserved.
const ERROR_PAGE_STANDALONE_RE = new RegExp(
  ERROR_PAGE_LEAD_RE.source +
    '(?:\\s*[.!?]|\\s*$|\\s*[-:;,\\u2013\\u2014]+\\s*(?:' +
    ERROR_REASON_WORD +
    '|[.!?]|$|' +
    ERROR_BOILERPLATE_PHRASE +
    ERROR_BOILERPLATE_COMPLETION +
    '))',
  'i',
);

// True when ANY of the supplied texts LEADS with a STANDALONE error/not-found
// signature (within the first ~120 chars). A real article that quotes the phrase
// deeper in its body, or whose long headline merely starts with it, never matches.
function looksLikeErrorPage(...texts) {
  return texts.some((t) =>
    ERROR_PAGE_STANDALONE_RE.test(
      String(t || '')
        .trim()
        .slice(0, 120),
    ),
  );
}

// A SHORT, standalone heading is the error page's self-announcement ("Access
// denied", "404 Page not found"). We scan ALL early headings + the <title> --
// publishers sometimes render a brand <h1> before the error <h1> -- but only
// treat a heading as error evidence when it is SHORT (<= 40 chars) AND the error
// signature is essentially the WHOLE heading, not just a prefix. This catches
// chrome-before-the-error-<h1> pages without rejecting a real article whose
// headline happens to start with "Access denied ..." and runs on (Codex review
// 2026-06-22, rounds 3 + 4).
// A short heading is an error heading when the error signature is essentially the
// whole heading. We allow trailing punctuation, OR a short dash/colon-separated
// reason that is itself a KNOWN single error word ("Access denied - blocked",
// "Access denied: forbidden"). We do NOT accept an arbitrary trailing clause: a
// real headline like "Access denied: banks face new attacks" must be preserved
// (Codex review rounds 5, 6, 7).
const ERROR_HEADING_RE = new RegExp(
  ERROR_PAGE_LEAD_RE.source +
    '(?:\\s*[-:\\u2013\\u2014]\\s*' +
    ERROR_REASON_WORD +
    ')?[\\s.!?:;,]*$',
  'i',
);
// The DEFINITIVE multi-word boilerplate continuation as a HEADING (any length):
// error lead + dash/colon + the permission/authorization boilerplate that
// COMPLETES (optional generic completion, then end-of-heading). A real news
// headline that quotes the phrase then continues into reporting is NOT matched
// (the boilerplate must end the heading) (Codex review rounds 9 + 10).
const ERROR_BOILERPLATE_HEADING_RE = new RegExp(
  ERROR_PAGE_LEAD_RE.source +
    '\\s*[-:\\u2013\\u2014]+\\s*' +
    ERROR_BOILERPLATE_PHRASE +
    ERROR_BOILERPLATE_COMPLETION,
  'i',
);
function pageHasErrorHeading(cleaned) {
  const s = String(cleaned || '');
  const heads = [];
  let m;
  const hRe = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi;
  while ((m = hRe.exec(s)) && heads.length < 6) heads.push(htmlFragmentToText(m[1]));
  const titleM = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleM) heads.push(htmlFragmentToText(titleM[1]));
  return heads.some((h) => {
    const t = h.trim();
    // Short heading that IS essentially the error self-announcement, OR a heading
    // (any length) that ExampleCos the definitive permission/authorization boilerplate.
    return (t.length <= 40 && ERROR_HEADING_RE.test(t)) || ERROR_BOILERPLATE_HEADING_RE.test(t);
  });
}

// A class TOKEN (one space-separated class) marks a recirculation / comments /
// promo region when it CONTAINS one of these stems (so hyphenated forms like
// "related-content", "promo-content", "comment-list" all match). Compared per
// token, not across the whole attribute (Codex review round 5).
const RECIRC_TOKEN_RE =
  /(?:comments?|related|recirc|recommend(?:ed|ations)?|promo|newsletter|subscribe|sharebar|social-share|trending|read-?more|more-from|outbrain|taboola|disqus)/i;
// Real content roles: a class TOKEN that is EXACTLY one of these means the
// element is the article, never a recirc block ("commentary article-body" keeps
// the "article-body" token). Exact-token match so "related-content" (a recirc
// token that merely ends in "content") is NOT treated as a content role
// (Codex review round 5).
const CONTENT_ROLE_TOKENS = new Set([
  'article',
  'article-body',
  'articlebody',
  'post',
  'post-content',
  'content',
  'entry',
  'entry-content',
  'story',
  'story-body',
  'prose',
  'main',
  'main-content',
  'body',
]);

function classTokens(cls) {
  return String(cls || '')
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}
// An element is a recirc block when SOME class token looks like recirc AND NO
// class token is an exact content role.
function isRecircClass(cls) {
  const toks = classTokens(cls);
  if (!toks.some((t) => RECIRC_TOKEN_RE.test(t))) return false;
  if (toks.some((t) => CONTENT_ROLE_TOKENS.has(t))) return false;
  return true;
}

// Remove recirc/comment/promo regions (tokenized class match), preserving any
// element that also ExampleCos a real content role. Walks element starts and skips
// to the matching close tag of the same tag name (depth-aware) so nested divs do
// not truncate the removal early.
function stripRecircRegions(html) {
  const s = String(html || '');
  const tagRe = /<(div|section|ul|ol|aside)\b[^>]*class="([^"]*)"[^>]*>/gi;
  let out = '';
  let last = 0;
  let m;
  while ((m = tagRe.exec(s))) {
    const tag = m[1].toLowerCase();
    const cls = m[2];
    if (!isRecircClass(cls)) continue;
    // Find the matching close tag from the end of this opening tag, depth-aware.
    const openRe = new RegExp(`<${tag}\\b`, 'gi');
    const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
    let depth = 1;
    let pos = tagRe.lastIndex;
    let end = -1;
    while (depth > 0) {
      openRe.lastIndex = pos;
      closeRe.lastIndex = pos;
      const o = openRe.exec(s);
      const c = closeRe.exec(s);
      if (!c) break;
      if (o && o.index < c.index) {
        depth += 1;
        pos = openRe.lastIndex;
      } else {
        depth -= 1;
        pos = closeRe.lastIndex;
        if (depth === 0) end = closeRe.lastIndex;
      }
    }
    if (end < 0) continue; // unbalanced: leave it rather than over-strip
    out += s.slice(last, m.index) + ' ';
    last = end;
    tagRe.lastIndex = end;
  }
  return out + s.slice(last);
}

// Prefer the body of the article that lives in a real text container (<p> rich
// region), reject error/not-found pages. Modern publishers (e.g. TechCrunch)
// no longer use a single entry-content div and split the body across many short
// <p> tags inside <main>, so we also build a body from the substantial <p> tags
// directly when the container heuristic comes up short.
function stripHtmlToText(html) {
  const cleaned = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  // Strip comment / related-story / promo / recirculation regions so their prose
  // cannot pollute the article body (Codex review rounds 3 + 4). Match on a class
  // TOKEN (word-boundary), and NEVER strip a block that also ExampleCos an article /
  // content / body / story / prose role -- a real container like
  // "commentary article-body" must survive (Codex review round 4).
  const strippedRecirc = stripRecircRegions(cleaned);
  // Collect every article-like container and take the LONGEST among them. A
  // single greedy first-match grabbed a 26-char teaser div on some sites (e.g.
  // mortgagenewsdaily) and dropped the real article. We keep the matched
  // container HTML so the <p>-reconstruction can be SCOPED to it (article-local
  // ExampleCoraphs), not the whole document.
  let bestContainerHtml = '';
  let best = '';
  for (const re of [
    /<article[\s\S]*?<\/article>/gi,
    /<main[\s\S]*?<\/main>/gi,
    /<div[^>]*class="[^"]*(?:article|post|content|entry|story|prose)[^"]*"[\s\S]*?<\/div>/gi,
  ]) {
    let m;
    while ((m = re.exec(strippedRecirc))) {
      const t = htmlFragmentToText(m[0]);
      if (t.length > best.length) {
        best = t;
        bestContainerHtml = m[0];
      }
    }
  }
  // Reconstruct the body from substantial <p> tags (modern publishers split the
  // body across many short ExampleCoraphs no single non-greedy container captures
  // whole). SCOPE the reconstruction to the best content container when we found
  // one; only fall back to (recirc-stripped) document-wide ExampleCoraphs when no
  // container exists, so comments / related-story prose can never replace it.
  const paraScope = bestContainerHtml || strippedRecirc;
  const paraText = substantialExampleCoraphText(paraScope);
  if (paraText.length > best.length) best = paraText;

  const full = htmlFragmentToText(strippedRecirc);
  const candidate = best.length >= MIN_CONTAINER_CHARS ? best : full;
  // An error / not-found / consent-wall page is not a body, even when it ExampleCos
  // 1000+ chars of nav chrome. Reject it when the error signature LEADS the
  // extracted text or the full page lead, OR a SHORT standalone heading is the
  // error self-announcement (pageHasErrorHeading) -- chrome before the <h1>, or
  // a <p>-reconstruction that dropped the <h1>, is still caught. A real article
  // that merely mentions the phrase mid-body, or whose long headline starts with
  // it, is preserved (Codex review rounds 2-4). Headings are read from the
  // original `cleaned` HTML so a stripped recirc block cannot hide one.
  if (looksLikeErrorPage(candidate, full) || pageHasErrorHeading(cleaned)) return '';
  // Strip publisher chrome (NPR show credits, bylines, "Read full article",
  // newsletter prompts, "Related:"/"More from", photo credits, social-share)
  // the <p>-reconstruction drags in alongside the real body, so the body fed to
  // the LLM (and the excerpt fallback) is clean article prose only (2026-06-23).
  return stripPublisherChrome(candidate);
}

// Reconstruct an article body from the substantial <p> tags WITHIN the given
// HTML scope (the selected content container, or the whole page only when no
// container was found). A real article ExampleCoraph is a <p> with enough text to be
// prose (>= 60 chars); nav / byline / share-widget <p>s are short and get
// filtered out. Returns '' when there are not enough real ExampleCoraphs to be a body.
function substantialExampleCoraphText(scopeHtml) {
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  const parts = [];
  let m;
  while ((m = re.exec(scopeHtml))) {
    const t = htmlFragmentToText(m[1]);
    if (t.length >= 60) parts.push(t);
  }
  if (parts.length < 2) return '';
  return parts.join(' ').trim();
}

// Strict positive prompt: 3 FULL, richly detailed factual ExampleCoraphs grounded in
// the source. ExampleCo 2026-06-22: the summaries got too thin and short articles
// degraded to a headline-only stub because the model produced terse ExampleCoraphs
// that fell under the 18-word / 110-char substantial floor. The prompt now
// demands at least three FULL sentences per ExampleCoraph and explicit richness so
// real articles reliably clear that floor and render as a full 3-ExampleCoraph
// summary.
function buildSummaryPrompt(item, sourceText) {
  const title = String((item && item.title) || '').slice(0, 300);
  const source = String((item && item.source) || '').slice(0, 80);
  const body = String(sourceText || '').slice(0, 6000);
  return [
    'Summarize this news article for an executive daily briefing.',
    'Write EXACTLY three full ExampleCoraphs separated by a single blank line.',
    'Each ExampleCoraph MUST be at least three full sentences and at least 40 words',
    'of detailed, specific prose with article facts, not general commentary.',
    'Use only facts grounded in the provided article text.',
    'Return the article summary ExampleCoraphs only, with no headline, labels, bullets, or markdown.',
    'ExampleCoraph 1: what happened, with the concrete who/what/when.',
    'ExampleCoraph 2: the key details, numbers, quotes, and context from the article.',
    'ExampleCoraph 3: why it is notable and what it signals, grounded in the article.',
    'State the facts directly. NEVER frame the summary as a description of an',
    'article: do not write "this article", "the article says/reports/notes",',
    '"in this piece", or "the provided/supplied text". Lead with the substance,',
    'not with what the article does.',
    `Source: ${source}`,
    `Title: ${title}`,
    '',
    'Article text:',
    body,
  ].join('\n');
}

// Live MORTGAGE INDUSTRY NEWS defect (2026-06-30): two rows "summarized the
// article as an article" instead of stating the substance -- e.g. "..., but the
// article says that did not happen" and "..., but the article says builders
// already face regulatory costs ...". The model framed the summary as a
// DESCRIPTION of an article rather than reporting the facts directly. The prompt
// now forbids this; this post-filter is the mechanical backstop so a stray
// article-meta phrase never reaches the dashboard.
//
// Category encoded (not the two literal strings): a phrase that ATTRIBUTES the
// prose to "the article / piece / report / story / author / reporter / column /
// op-ed / analysis" (or the named publisher, "HousingWire reports X") is
// stripped so the surviving clause leads with substance.
//
// THE AUTHORITATIVE definition of "summarizes the article as an article" is the
// NEWS-ARTICLE-META detector in scripts/verify-dashboard-cards-live.js
// (NEWS_ARTICLE_META_PROSE_RE):
//
//   /\b(?:the|this|housingwires?)\s+(?:article|story|report|author|reporter|
//      piece|column|op-?ed|analysis)\s+
//      (?:centers?|centres?|focus(?:es|ed)?|reports?|says|said|argues?|notes?|
//       points?)\b/i
//
// So the stripper's noun list (ARTICLE_META_NOUN) and verb list
// (ARTICLE_META_VERB) below are kept as a strict SUPERSET of that detector's
// vocabularies -- every (subject)(noun)(verb) the detector flags is stripped
// here, so the stripper and the detector can never disagree and a surviving
// summary can never trip NEWS-ARTICLE-META. (We also strip equally-meta lead-ins
// the detector happens not to enumerate -- "according to the report,", "as the
// article notes,", "in this piece," -- for clean prose.)
//
// Over-strip is bounded (the cardinal sin):
//   - the INLINE-conjunction form fires only after a comma + a conjunction
//     (but/and/while/...), keeping the conjunction and the full following clause
//     ("..., but the article says that did not happen" -> "..., but that did not
//     happen"). A real "..., but activity remained subdued" is untouched.
//   - the INLINE-CONNECTOR form (live MORTGAGE-NEWS miss 2026-06-30, the row this
//     fix targets) generalizes the inline form to a mid-sentence connector with
//     NO required leading comma: the detector matches "the article says" wherever
//     it sits, but the old inline form only fired after a comma ("..., but the
//     article says ..."). A no-comma coordinate ("...rebound but the article says
//     ...", "...risk yet the report points to ...") or a subordinator ("...costs
//     while the report notes that ...", "...dropped because the story reports
//     ...") slipped through. This form keeps the connector + the full following
//     clause and drops only the meta subject+verb (and an optional trailing
//     particle to/on/out/that/how so "points to X"/"focuses on X" leave clean
//     residual, not a dangling "yet to X"). Over-strip is bounded by REQUIRING
//     the meta subject+verb right after the connector: a real "...costs while
//     approvals slowed ..." (connector + ordinary prose) and "..., but the report
//     is notable ..." (connector + copula, no reporting verb) are untouched.
//   - the RELATIVE-pronoun form ("..., which the analysis argues will raise costs,
//     ...") keeps the comma + which/who/that and the following clause, dropping
//     only the meta subject+verb. A real "..., which regulators argue will ..." is
//     untouched (no meta subject).
//   - the AS-ASIDE form strips a mid-sentence comma-bracketed "as <subject>
//     <verb>," aside ("..., as the article notes, even ..." -> "..., even ..."),
//     which the clause-anchored AS form below does not reach.
//   - the INTERJECTION form fires only on a comma-bracketed aside
//     (", the report notes,") and removes the whole aside, leaving the host
//     sentence intact.
//   - the LEADING / "as" / "according to" forms fire only at a clause start.
//   - the verb list is the detector's reporting verbs (say/report/note/state/
//     argue/claim/add/write/describe/discuss/explain/highlight/mention/caution/
//     warn/center on/centre on/focus on/point out), which deliberately EXCLUDES
//     the copula (is/are/was/were/seems/remains), so "The report is notable
//     because ..." (ExampleCoraph-3 framing) and "The article of incorporation was
//     filed" (no reporting verb) both survive.
// "U.S."/"Inc." capitalization is never mangled: we capitalize ONLY the single
// surviving letter at each removal site, never a global recap.
const ARTICLE_META_NOUN = 'article|piece|report|story|author|reporter|column|op-?ed|analysis';
// Reporting verbs as a single fragment. "centers?|centres?" and "focus(?:es|ed)?"
// take an "on", "points?" takes an "out"; we make those particles optional so a
// "centers? on" still matches even if the model drops the particle. The detector
// uses the bare verb, so matching the bare verb is sufficient and safe.
const ARTICLE_META_VERB =
  '(?:says?|said|reports?|reported|notes?|noted|states?|stated|describes?|discusses?|explains?|explained|argues?|argued|claims?|claimed|adds?|added|writes?|wrote|highlights?|highlighted|mentions?|mentioned|cautions?|cautioned|warns?|warned|centers?(?:\\s+on)?|centres?(?:\\s+on)?|focus(?:es|ed)?(?:\\s+on)?|points?(?:\\s+out)?)';
// Subject: "the/this <noun>" OR the named mortgage publisher "HousingWire(s)".
const ARTICLE_META_SUBJECT = `(?:(?:the|this)\\s+(?:${ARTICLE_META_NOUN})|housingwires?)`;

const ARTICLE_META_INLINE = new RegExp(
  `,\\s+(but|and|while|though|although|yet|however)\\s+${ARTICLE_META_SUBJECT}\\s+${ARTICLE_META_VERB}\\s+`,
  'gi',
);
// Mid-sentence connector that introduces a meta clause, with NO required leading
// comma (live MORTGAGE-NEWS miss 2026-06-30). A coordinating/subordinating
// connector immediately followed by the meta subject+verb is article-meta framing
// wherever it sits ("...rebound but the article says ...", "...costs while the
// report notes that ...", "...dropped because the story reports ..."). Keep the
// connector group ($1) and the following clause; drop only the subject+verb and an
// optional trailing particle (to/on/out for the "points to"/"focuses on" idioms,
// that/how for the complementizer) so the residual reads as substance, not a
// dangling preposition. The mandatory meta subject+verb right after the connector
// bounds over-strip: "...while approvals slowed ..." (no meta subject) and "...but
// the report is notable ..." (copula, not a reporting verb) are left untouched.
const ARTICLE_META_CONNECTORS =
  '(?:but|and|while|whilst|though|although|yet|however|because|since|so|as|where|when)';
const ARTICLE_META_INLINE_CONNECTOR = new RegExp(
  `(,?\\s+${ARTICLE_META_CONNECTORS}\\s+)${ARTICLE_META_SUBJECT}\\s+${ARTICLE_META_VERB}\\s+(?:to\\s+|on\\s+|out\\s+|that\\s+|how\\s+)?`,
  'gi',
);
// Relative-pronoun aside: "..., which the analysis argues will raise costs, ..."
// -> "..., which will raise costs, ...". Keep the comma + which/who/that ($1) and
// the following clause; drop only the meta subject+verb. The leading comma keeps a
// real "..., which regulators argue ..." (no meta subject) untouched.
const ARTICLE_META_RELATIVE = new RegExp(
  `(,\\s+(?:which|who|that)\\s+)${ARTICLE_META_SUBJECT}\\s+${ARTICLE_META_VERB}\\s+`,
  'gi',
);
// Mid-sentence comma-bracketed "as <subject> <verb>," aside ("..., as the article
// notes, even ..." -> "..., even ..."). The clause-anchored ARTICLE_META_AS below
// only fires at a clause start, so this catches the embedded aside form.
const ARTICLE_META_AS_ASIDE = new RegExp(
  `,\\s+as\\s+${ARTICLE_META_SUBJECT}\\s+${ARTICLE_META_VERB}\\s*,`,
  'gi',
);
// Comma-bracketed aside: "..., the report notes, ..." -> "..., ...". Requires the
// trailing comma so a real "..., the report says lenders ..." (clause, not aside)
// falls to the INLINE/LEAD forms instead, not this one.
const ARTICLE_META_INTERJECT = new RegExp(
  `,\\s+${ARTICLE_META_SUBJECT}\\s+${ARTICLE_META_VERB}\\s*,`,
  'gi',
);
const ARTICLE_META_LEAD = new RegExp(
  `(^|[.!?]\\s)${ARTICLE_META_SUBJECT}\\s+${ARTICLE_META_VERB}\\s+(?:that\\s+|how\\s+)?([a-z])`,
  'gi',
);
// "As the article notes, <clause>" / "As HousingWire reports, <clause>".
const ARTICLE_META_AS = new RegExp(
  `(^|[.!?]\\s)as\\s+${ARTICLE_META_SUBJECT}\\s+${ARTICLE_META_VERB}\\s*,?\\s+([a-z])`,
  'gi',
);
// "According to the report, <clause>" / "Per the article, <clause>". The detector
// does not flag this shape (no reporting verb after the noun), but it is the same
// article-meta framing, so we strip it for clean prose.
const ARTICLE_META_ACCORDING = new RegExp(
  `(^|[.!?]\\s)(?:according to|per)\\s+${ARTICLE_META_SUBJECT}\\s*,?\\s+([a-z])`,
  'gi',
);
const ARTICLE_META_IN_PIECE = /(^|[.!?]\s)In this piece,?\s+([a-z])/g;

function stripArticleMetaFraming(text) {
  let out = String(text || '');
  // Comma-bracketed asides FIRST (they require trailing commas the later, looser
  // forms would otherwise consume): the "as <subject> <verb>," aside, then the
  // bare ", <subject> <verb>," aside.
  out = out.replace(ARTICLE_META_AS_ASIDE, ',');
  // Comma-bracketed aside ("..., the report notes, ...") -> drop the aside.
  out = out.replace(ARTICLE_META_INTERJECT, ',');
  // Relative-pronoun aside ("..., which the analysis argues will ...") -> keep the
  // comma + relative pronoun and the following clause.
  out = out.replace(ARTICLE_META_RELATIVE, '$1');
  // Inline attribution after a comma + conjunction: keep the conjunction and the
  // full following clause, drop only "the article says".
  out = out.replace(ARTICLE_META_INLINE, ', $1 ');
  // Mid-sentence connector (no required comma) introducing a meta clause: keep the
  // connector group and the following clause, drop the subject+verb+particle.
  out = out.replace(ARTICLE_META_INLINE_CONNECTOR, '$1');
  // Clause-start openers: keep the sentence boundary and capitalize ONLY the
  // first surviving letter at the removal site (a global recap would corrupt real
  // abbreviations like "U.S. economy" / "Inc. and Co.").
  out = out.replace(ARTICLE_META_LEAD, (_m, b, c) => b + c.toUpperCase());
  out = out.replace(ARTICLE_META_AS, (_m, b, c) => b + c.toUpperCase());
  out = out.replace(ARTICLE_META_ACCORDING, (_m, b, c) => b + c.toUpperCase());
  out = out.replace(ARTICLE_META_IN_PIECE, (_m, b, c) => b + c.toUpperCase());
  return out.replace(/\s+/g, ' ').trim();
}

// A valid summary is exactly three substantial ExampleCoraphs that read as a summary
// of the supplied article metadata. This is the positive QC gate: it returns the
// normalized 3-ExampleCoraph string only when the output has the required article
// summary shape and grounding.
function normalizeSummary(text, item = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const paras = raw
    .split(/\n{2,}/)
    .map((p) => stripArticleMetaFraming(p.replace(/\s+/g, ' ').trim()))
    .filter((p) => p.length >= 40);
  const firstThree = paras.slice(0, 3);
  if (!isThreeExampleCoraphArticleSummary(firstThree, item)) return null;
  return firstThree.join('\n\n');
}

function articleSentences(text) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return [];
  const out = [];
  const re = /([.!?])["']?(?=\s|$)/g;
  let start = 0;
  let m;
  while ((m = re.exec(s))) {
    const end = m.index + m[0].length;
    if (!isRealSentenceEnd(s, end, m[1])) continue;
    const sentence = s.slice(start, end).trim();
    if (sentence.length >= 45) out.push(sentence);
    start = end;
  }
  return out;
}

function buildExtractiveSummary(item, sourceText) {
  const sentences = articleSentences(sourceText).slice(0, 12);
  if (sentences.length < 3) return null;
  for (let size = 1; size <= 4; size++) {
    if (sentences.length < size * 3) break;
    const paras = [
      sentences.slice(0, size).join(' '),
      sentences.slice(size, size * 2).join(' '),
      sentences.slice(size * 2, size * 3).join(' '),
    ].map((p) => trimToSentenceBoundary(p, ExampleCoRAPH_RICH_MAX_CHARS));
    const summary = normalizeSummary(paras.join('\n\n'), item);
    if (summary) return summary;
  }
  return null;
}

// Summarize a single substantial body with retry-with-backoff. The body has
// already cleared the thin-body gate, so a null/unusable model response here is
// a TRANSIENT failure (rung starved, crashed, or rate-limited) -- we retry up to
// `retries` total attempts with exponential backoff, falling through the askAI
// ladder on each attempt. If every model attempt is unusable, return a bounded
// extractive summary built only from the fetched article text; headline-only is
// reserved for bodies too thin to support even that.
async function summarizeBodyWithRetry(
  item,
  sourceText,
  {
    askAI,
    retries = NEWS_SUMMARIZE_RETRIES,
    retryBaseMs = NEWS_SUMMARIZE_RETRY_BASE_MS,
    rungTimeoutMs = NEWS_SUMMARIZE_RUNG_TIMEOUT_MS,
    sleep = defaultSleep,
  },
) {
  const attempts = Math.max(1, Number(retries) || 1);
  const prompt = buildSummaryPrompt(item, sourceText);
  for (let attempt = 0; attempt < attempts; attempt++) {
    let out = null;
    try {
      out = await askAI(prompt, {
        surface: 'news-summarize',
        silent: true,
        rungTimeoutMs,
      });
    } catch {
      out = null; // a throw is just another transient failure -> retry
    }
    const summary = normalizeSummary(out && out.text, item);
    if (summary) return summary;
    // Transient miss: back off (exponential) before the next attempt. No sleep
    // after the final attempt (we are about to return the stub).
    if (attempt < attempts - 1) {
      await sleep(retryBaseMs * 2 ** attempt);
    }
  }
  return buildExtractiveSummary(item, sourceText);
}

/**
 * Summarize one news item. Returns { summary } (3-ExampleCoraph string) or
 * { summary: null } when there is no real source text to ground a summary.
 *
 * A transient LLM failure on a REAL body is retried with backoff (see
 * summarizeBodyWithRetry); the headline-only stub is reserved for a genuinely
 * thin / unfetchable body, never an LLM hiccup.
 */
// Resolve (if Google-News) + fetch one article body ONCE. Returns the body text
// ('' on resolve/fetch failure). Pure aside from the injected resolveUrl/fetchText.
async function acquireSourceOnce(item, { fetchText, resolveUrl }) {
  if (!item || !item.url) return '';
  let fetchUrl = item.url;
  if (isGoogleNewsArticleUrl(item.url)) {
    try {
      fetchUrl = await resolveUrl(item.url);
    } catch {
      fetchUrl = null;
    }
  }
  if (!fetchUrl) return '';
  try {
    return await fetchText(fetchUrl, {});
  } catch {
    return '';
  }
}

// Acquire the article body with retry-with-backoff. The Google-News resolve +
// publisher fetch is the part that flakes under build load (concurrent requests
// + rate limits): reproduced on EC2 2026-06-22, immigration articles that
// resolve + fetch fine in isolation returned an empty body mid-build and stubbed
// with NO retry. We retry the whole resolve+fetch a bounded number of times so a
// transient empty body self-heals, while a genuinely-blocked article (empty on
// every attempt) still falls through to the stub after the bounded attempts.
async function acquireSourceTextWithRetry(
  item,
  { fetchText, resolveUrl, retries, retryBaseMs, sleep },
) {
  const attempts = Math.max(1, Number(retries) || 1);
  let best = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    const body = await acquireSourceOnce(item, { fetchText, resolveUrl });
    // A full body wins immediately; otherwise keep the longest partial seen so a
    // sub-MIN_BODY-but-nonempty body can still feed the RSS-excerpt fallback.
    if (body && body.length >= MIN_BODY_CHARS) return body;
    if (body && body.length > best.length) best = body;
    if (attempt < attempts - 1) await sleep(retryBaseMs * 2 ** attempt);
  }
  return best;
}

async function summarizeNewsItem(
  item,
  {
    askAI,
    fetchText = fetchArticleText,
    resolveUrl = resolveGoogleNewsUrl,
    retries = NEWS_SUMMARIZE_RETRIES,
    retryBaseMs = NEWS_SUMMARIZE_RETRY_BASE_MS,
    rungTimeoutMs = NEWS_SUMMARIZE_RUNG_TIMEOUT_MS,
    sleep = defaultSleep,
  } = {},
) {
  if (!item) return { summary: null };
  // Resolve + fetch the article body with retry, so a transient empty body
  // (Google-News resolve / publisher fetch flaking under build load) self-heals
  // instead of stubbing. A genuinely-blocked article stays empty and falls back.
  let sourceText = item.url
    ? await acquireSourceTextWithRetry(item, {
        fetchText,
        resolveUrl,
        retries,
        retryBaseMs,
        sleep,
      })
    : '';
  // Some card-specific healers already fetched and stored a real article body
  // (for example the COVID source healer). If a later publisher refetch flakes,
  // use that stored body as the grounding instead of falling through to an
  // extractive/headline fallback.
  if (
    (!sourceText || sourceText.length < MIN_BODY_CHARS) &&
    item.sourceText &&
    item.sourceText !== item.title
  ) {
    const stored = stripPublisherChrome(String(item.sourceText));
    if (stored.length >= MIN_EXCERPT_CHARS) sourceText = stored;
  }
  // Fall back to a substantial RSS excerpt if the body did not fetch.
  if (
    (!sourceText || sourceText.length < MIN_BODY_CHARS) &&
    item.excerpt &&
    item.excerpt !== item.title
  ) {
    const ex = stripPublisherChrome(String(item.excerpt));
    if (ex.length >= MIN_EXCERPT_CHARS) sourceText = ex;
  }
  // Genuinely thin / unfetchable body: stub immediately, never call the LLM (and
  // never burn retries on something we cannot ground a summary in).
  if (!sourceText || sourceText.length < MIN_EXCERPT_CHARS) {
    return { summary: null, failureKind: 'source_unavailable' };
  }
  // Real body present: a null/unusable model response is transient -> retry.
  const summary = await summarizeBodyWithRetry(item, sourceText, {
    askAI,
    retries,
    retryBaseMs,
    rungTimeoutMs,
    sleep,
  });
  return { summary, failureKind: summary ? null : 'summary_unavailable' };
}

/**
 * Summarize a list of items with a url-keyed cache. Mutates a returned copy with
 * item.summary set when available. cache is { get(url), set(url, summary) }.
 * Retry / backoff / timeout options are threaded through to summarizeNewsItem so
 * a transient LLM failure on a real body self-heals instead of stubbing.
 */
async function summarizeNewsItems(
  items,
  {
    askAI,
    fetchText,
    resolveUrl,
    cache,
    limit = 12,
    retries = NEWS_SUMMARIZE_RETRIES,
    retryBaseMs = NEWS_SUMMARIZE_RETRY_BASE_MS,
    rungTimeoutMs = NEWS_SUMMARIZE_RUNG_TIMEOUT_MS,
    sleep = defaultSleep,
  } = {},
) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  for (const item of list.slice(0, limit)) {
    const url = item && item.url;
    let summary = url && cache && cache.get ? normalizeSummary(cache.get(url, item), item) : null;
    if (!summary) {
      const r = await summarizeNewsItem(item, {
        askAI,
        fetchText,
        resolveUrl,
        retries,
        retryBaseMs,
        rungTimeoutMs,
        sleep,
      });
      summary = r.summary;
      if (summary && url && cache && cache.set) cache.set(url, summary);
      if (!summary && url && cache && cache.setFailure) {
        cache.setFailure(url, r.failureKind || 'summary_unavailable');
      }
    }
    out.push(summary ? { ...item, summary } : item);
  }
  // pass through any beyond the limit unchanged
  for (const item of list.slice(limit)) out.push(item);
  return out;
}

module.exports = {
  fetchArticleText,
  stripHtmlToText,
  stripPublisherChrome,
  NEWS_PUBLISHER_CHROME_LABELS,
  NEWS_PUBLISHER_CHROME_PATTERNS,
  newsPublisherChromeSource,
  buildSummaryPrompt,
  normalizeSummary,
  stripArticleMetaFraming,
  buildExtractiveSummary,
  summarizeNewsItem,
  summarizeNewsItems,
  isGoogleNewsArticleUrl,
  resolveGoogleNewsUrl,
  buildGarturlBody,
  parseGarturlResponse,
  isSubstantialNewsExampleCoraph,
  endsAsProse,
  articleSummaryTerms,
  isThreeExampleCoraphArticleSummary,
  trimToSentenceBoundary,
  ExampleCoraphWordCount,
  HEADLINE_ONLY_NOTE,
  HEADLINE_ONLY_NOTE_RE,
  isHeadlineOnlyNote,
  isHeadlineOnlyExampleCoraphs,
  SUBSTANTIAL_ExampleCoRAPH_MIN_CHARS,
  SUBSTANTIAL_ExampleCoRAPH_MIN_WORDS,
  ExampleCoRAPH_RICH_MAX_CHARS,
  MIN_BODY_CHARS,
  MIN_EXCERPT_CHARS,
  NEWS_SUMMARIZE_RETRIES,
  NEWS_SUMMARIZE_RETRY_BASE_MS,
  NEWS_SUMMARIZE_RUNG_TIMEOUT_MS,
};
