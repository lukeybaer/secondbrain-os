#!/usr/bin/env node
/**
 * content-heal.js -- durable content-heal step for the daily briefing.
 *
 * Codex P1#4 + plan step 7 + ExampleCo 2026-06-03 ("content being bad means make it
 * good. Why no COVID news, why's it a blocker, why can't you iterate and get
 * it?"). When a content card is under its threshold (viral clips < 3, mortgage
 * news < 10, COVID < 5, US/world/aitech/immigration < 10), this step RE-RUNS
 * that card's generator with WIDENED sources and collects per-item EVIDENCE so a
 * sibling validator agent can mechanically reject padding or fabrication.
 *
 * The honest-shortfall contract:
 *   - Loop the generator with widened sources until count >= target OR the real
 *     in-window pool is genuinely exhausted OR a per-card/per-pass budget cap is
 *     hit.
 *   - When the pool is exhausted, set `wall` to a "sources-exhausted" reason
 *     naming what was queried. When the budget cap is hit, set `wall` to a
 *     "budget-exhausted" reason. A wall is the ONLY acceptable shortfall.
 *   - NEVER pad to hit the number. Every item must be a real source with a
 *     unique URL key, a parseable in-window timestamp, and non-empty real text
 *     (transcript line / article excerpt). Dedup by URL so the same article can
 *     never pad the count (Codex C#1).
 *
 * Codex required changes implemented here:
 *   - C#1 SOURCE-BOUND, NO FABRICATION: the collector REJECTS any item lacking a
 *     real URL, a parseable publishedAtIso, or a non-empty real excerpt. Dedup
 *     is by URL.
 *   - C#2 DEGRADED TIER MARKED: a headline-rescue item (body unfetchable,
 *     excerpt = real RSS headline/description) is tier:"headline" and marked
 *     degraded:true. A summary-grade item (real fetched/RSS body excerpt) is
 *     tier:"summary". Both still require real URL + real in-window date + real
 *     excerpt to count.
 *   - C#3 TOPIC-SENSITIVE FRESHNESS: COVID/health uses a 72h current window;
 *     explicitly-labeled background/context items may use up to 7d and are
 *     marked background:true. US/world/etc use 24h then a 48h cascade. Undated
 *     items count only at the headline tier and the wall reason names the
 *     undated-dropped count.
 *   - C#5 PER-PASS BUDGET CAP: hard per-card (default 90s) and per-pass (default
 *     8min) time caps, injectable. When the cap is hit, stop and record an
 *     explicit "budget-exhausted" wall (distinct from "sources-exhausted").
 *
 * Output: data/agent/content-heal-<date>.json with this exact shape:
 * {
 *   date,
 *   cards: {
 *     viral:    { count, target: 3,  items: [{ sourceId, url, approxTimestamp, transcriptOrExcerpt, uniqueKey }], wall: null | "<reason>" },
 *     mortgage: { count, target: 10, items: [{ sourceId, url, domain, publishedAtIso, excerpt, tier, degraded, uniqueKey }], wall: null | "<reason>" },
 *     covid:    { count, target: 5,  items: [ ...news evidence... ], wall: null | "<reason>" },
 *     us:       { count, target: 10, items: [ ... ], wall: null | "<reason>" },
 *     world:    { count, target: 10, items: [ ... ], wall: null | "<reason>" },
 *     aitech:   { count, target: 10, items: [ ... ], wall: null | "<reason>" },
 *     immigration:{ count, target: 5, items: [ ... ], wall: null | "<reason>" }
 *   }
 * }
 *
 * Dependency-injectable: pass generators + fetchers + clock in `deps` so the
 * module is unit-testable without any live network call. Callable as
 * runContentHeal(...) AND from the CLI.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const {
  stripPublisherChrome,
  isGoogleNewsArticleUrl,
  resolveGoogleNewsUrl,
  fetchArticleText,
} = require('./lib/news-summarize.js');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const DATA_DIR = process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data');
const OUT_DIR = path.join(DATA_DIR, 'agent');
const VIRAL_CACHE_DIR = path.join(OUT_DIR, 'viral-tech-clips');

const VIRAL_TARGET = 3;
const MORTGAGE_TARGET = 10;

// Per-card news targets. Immigration is a specialized PRIVATE_NAME/EB-1A section from
// ExampleCo's 2026-05-01 Vapi directive and the canonical spec says top 5.
const NEWS_TARGETS = {
  covid: 5,
  us: 10,
  world: 10,
  aitech: 10,
  immigration: 5,
};

// Codex C#5: hard time caps so healing 5+ cards per pass cannot blow the
// overnight budget. Injectable for tests.
const DEFAULT_PER_CARD_MS = 90 * 1000;
const DEFAULT_PER_PASS_MS = 8 * 60 * 1000;
const DEFAULT_DISCOVERY_MAX = 12;
const CONFIGURED_BODY_FETCH_MAX = Number(process.env.CONTENT_HEAL_BODY_FETCH_MAX);
const DEFAULT_BODY_FETCH_MAX =
  Number.isFinite(CONFIGURED_BODY_FETCH_MAX) && CONFIGURED_BODY_FETCH_MAX > 0
    ? Math.floor(CONFIGURED_BODY_FETCH_MAX)
    : null;
const SUMMARY_SOURCE_MIN_CHARS = 200;

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

function newsRescueCollectionTarget(target) {
  const t = Math.max(1, Number(target) || 1);
  return Math.max(t + 15, t * 5);
}

function bodyFetchLimitFor(maxCandidates, explicitLimit) {
  if (explicitLimit != null) return Math.max(0, Number(explicitLimit) || 0);
  if (DEFAULT_BODY_FETCH_MAX != null) return DEFAULT_BODY_FETCH_MAX;
  return Math.max(1, Number(maxCandidates) || 1);
}

function todayIso(now = new Date()) {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function argValue(name, args = process.argv) {
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  const pref = `${name}=`;
  const hit = args.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : null;
}

function safeError(err) {
  return String((err && err.message) || err || 'ExampleCo').slice(0, 500);
}

function domainOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function nonEmpty(text) {
  return typeof text === 'string' && text.replace(/\s+/g, '').length > 0;
}

function cleanText(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanNewsEvidenceText(text) {
  return stripPublisherChrome(cleanText(text));
}

function isTitleOnlyExcerpt(title, excerpt) {
  const t = cleanText(title).toLowerCase();
  const e = cleanText(excerpt).toLowerCase();
  return Boolean(t && e && t === e);
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function readCachedViralProposals(date, dir = VIRAL_CACHE_DIR) {
  if (!date) return [];
  const cached = readJsonFile(path.join(dir, `${date}.json`));
  return Array.isArray(cached && cached.proposals) ? cached.proposals : [];
}

// ── News feed sets (reputable, real source URLs) ─────────────────────────────
// Each entry is [feedUrl, sourceName]. These mirror manual-briefing-v3's
// section feed arrays plus a few site-scoped Google News queries that surface
// real bylined articles from publishers with no public RSS. Keep it real.

const COVID_FEEDS = [
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent(
        '"COVID-19 treatment" OR Paxlovid OR remdesivir OR "COVID antiviral" OR "COVID vaccine effectiveness"',
      ) +
      '&hl=en-US&gl=US&ceid=US:en',
    'Google News COVID Treatments',
  ],
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('"long COVID" OR "post-COVID" OR "SARS-CoV-2"') +
      '&hl=en-US&gl=US&ceid=US:en',
    'Google News Long COVID',
  ],
  ['https://www.cdc.gov/media/rss.xml', 'CDC Newsroom'],
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:cdc.gov (covid OR coronavirus)') +
      '&hl=en-US&gl=US&ceid=US:en',
    'CDC via Google',
  ],
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:who.int (covid OR coronavirus OR "SARS-CoV-2")') +
      '&hl=en-US&gl=US&ceid=US:en',
    'WHO via Google',
  ],
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:nih.gov (covid OR coronavirus OR "SARS-CoV-2" OR "long COVID")') +
      '&hl=en-US&gl=US&ceid=US:en',
    'NIH via Google',
  ],
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent(
        'site:cidrap.umn.edu (covid OR coronavirus OR "SARS-CoV-2" OR "long COVID")',
      ) +
      '&hl=en-US&gl=US&ceid=US:en',
    'CIDRAP via Google',
  ],
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent(
        'site:fda.gov (covid OR coronavirus OR Paxlovid OR remdesivir OR vaccine)',
      ) +
      '&hl=en-US&gl=US&ceid=US:en',
    'FDA via Google',
  ],
  ['https://www.statnews.com/feed/', 'STAT News'],
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:medpagetoday.com covid') +
      '&hl=en-US&gl=US&ceid=US:en',
    'MedPage Today via Google',
  ],
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:reuters.com (covid OR coronavirus OR pandemic)') +
      '&hl=en-US&gl=US&ceid=US:en',
    'Reuters Health via Google',
  ],
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:apnews.com (covid OR coronavirus OR pandemic)') +
      '&hl=en-US&gl=US&ceid=US:en',
    'AP Health via Google',
  ],
  ['https://www.nejm.org/action/showFeed?type=etoc&feed=rss&jc=nejm', 'NEJM'],
  ['https://www.nature.com/nm.rss', 'Nature Medicine'],
];

const US_FEEDS = [
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:apnews.com US news') +
      '&hl=en-US&gl=US&ceid=US:en',
    'AP via Google',
  ],
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:reuters.com US news') +
      '&hl=en-US&gl=US&ceid=US:en',
    'Reuters via Google',
  ],
  ['https://feeds.npr.org/1001/rss.xml', 'NPR News'],
  ['https://www.cbsnews.com/latest/rss/us', 'CBS US'],
  ['https://feeds.nbcnews.com/nbcnews/public/news', 'NBC News'],
  ['https://abcnews.go.com/abcnews/usheadlines', 'ABC News'],
  ['https://www.pbs.org/newshour/feeds/rss/headlines', 'PBS NewsHour'],
];

const WORLD_FEEDS = [
  ['https://feeds.bbci.co.uk/news/world/rss.xml', 'BBC World'],
  ['https://rss.nytimes.com/services/xml/rss/nyt/World.xml', 'NYT World'],
  ['https://www.theguardian.com/world/rss', 'Guardian World'],
  ['https://www.cbsnews.com/latest/rss/world', 'CBS World'],
  ['https://www.aljazeera.com/xml/rss/all.xml', 'Al Jazeera'],
  ['https://rss.dw.com/rdf/rss-en-world', 'DW World'],
  [
    'https://news.google.com/rss/search?q=site:reuters.com+world+news&hl=en-US&gl=US&ceid=US:en',
    'Reuters via Google',
  ],
  [
    'https://news.google.com/rss/search?q=site:apnews.com+world&hl=en-US&gl=US&ceid=US:en',
    'AP via Google',
  ],
];

const AITECH_FEEDS = [
  ['https://arstechnica.com/feed/', 'Ars Technica'],
  ['https://techcrunch.com/category/artificial-intelligence/feed/', 'TechCrunch AI'],
  ['https://www.wired.com/feed/category/business/artificial-intelligence/rss', 'Wired AI'],
  ['https://www.theverge.com/rss/tech/index.xml', 'The Verge'],
  ['https://venturebeat.com/category/ai/feed/', 'VentureBeat AI'],
  ['https://www.technologyreview.com/feed/', 'MIT Tech Review'],
  ['https://www.engadget.com/rss.xml', 'Engadget'],
  ['https://www.zdnet.com/topic/artificial-intelligence/rss.xml', 'ZDNet AI'],
];

const IMMIGRATION_FEEDS = [
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent(
        '"US immigration" OR "USCIS" OR "EB-1A" OR "EB1A" OR "green card" OR ' +
          '"I-485" OR "visa bulletin" OR "adjustment of status" OR ' +
          '"China visa" OR "immigration policy"',
      ) +
      '&hl=en-US&gl=US&ceid=US:en',
    'Google News Immigration',
  ],
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:uscis.gov news') +
      '&hl=en-US&gl=US&ceid=US:en',
    'USCIS via Google',
  ],
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:dhs.gov immigration OR USCIS OR "green card" OR visa') +
      '&hl=en-US&gl=US&ceid=US:en',
    'DHS Immigration via Google',
  ],
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent(
        'site:federalregister.gov immigration OR USCIS OR "visa bulletin" OR "green card"',
      ) +
      '&hl=en-US&gl=US&ceid=US:en',
    'Federal Register Immigration via Google',
  ],
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:justice.gov/eoir immigration OR asylum OR "immigration court"') +
      '&hl=en-US&gl=US&ceid=US:en',
    'DOJ EOIR via Google',
  ],
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:aila.org immigration OR USCIS OR "visa bulletin" OR "green card"') +
      '&hl=en-US&gl=US&ceid=US:en',
    'AILA Immigration via Google',
  ],
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:reuters.com US immigration') +
      '&hl=en-US&gl=US&ceid=US:en',
    'Reuters Immigration via Google',
  ],
  [
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:apnews.com US immigration') +
      '&hl=en-US&gl=US&ceid=US:en',
    'AP Immigration via Google',
  ],
];

const NEWS_FEEDS = {
  covid: COVID_FEEDS,
  us: US_FEEDS,
  world: WORLD_FEEDS,
  aitech: AITECH_FEEDS,
  immigration: IMMIGRATION_FEEDS,
};

// Topic-sensitive freshness (Codex C#3). Health uses a tight 72h current window
// with a 7d background allowance; general news uses 24h then a 48h cascade.
const NEWS_FRESHNESS = {
  covid: { currentHours: 72, backgroundHours: 7 * 24, cascadeHours: [72] },
  us: { currentHours: 24, cascadeHours: [24, 48] },
  world: { currentHours: 24, cascadeHours: [24, 48] },
  aitech: { currentHours: 24, cascadeHours: [24, 48] },
  immigration: { currentHours: 24, cascadeHours: [24, 48, 7 * 24] },
};

// The LIVE render QC (verify-dashboard-cards-live.js newsStubDefects + the
// validate-briefing-quality.js news-section check) does NOT cap the number of
// honest headline-rescue rows: the NEWS-STUB hook is deliberately non-blocking,
// and the section check accepts a labeled headline-only row as long as it ExampleCos
// a real source link and the content-heal card owns it (a wall or source-bound
// evidence). The only hard render rule is the canonical headline-only NOTE shape.
//
// So the default "at most one headline" floor below is a SELF-IMPOSED
// content-heal conservatism for the high-volume general cards (us/world/aitech)
// and mortgage, where summary-grade material is plentiful, NOT a render-QC limit.
// Immigration is a thin, Google-News-stub-heavy specialized beat: on a low body
// yield day a strict "target - 1 must be summary-grade" floor drops every honest
// headline row and the card collapses to 1/5. Because the live render QC permits
// those honest rows, immigration is allowed to fill its remaining slots with
// headline-tier rows (still real URL + real in-window date + real title text;
// never padded, never fabricated). minSummary 0 means "no summary-grade floor".
const NEWS_MAX_HEADLINE_FALLBACKS = 1;
// Mirrors the manifest's newsMinimum:1 for covid_news
// (scripts/lib/briefing-card-manifest.js) -- covid is CLEAN at 1+ articles even
// while its aspirational target stays 5 (ExampleCo 2026-06-28).
const COVID_CLEAN_MINIMUM = 1;
const NEWS_MIN_SUMMARY_GRADE = {
  // covid: no summary-grade floor, same relaxation as immigration below. COVID
  // is a thin, low-body-yield health beat: on most days every real, on-topic,
  // in-window article is headline-tier (a short RSS blurb, no fetchable body),
  // so a "target - 1 must be summary-grade" floor zeroed the WHOLE card even
  // when 20+ real headline rows were sitting in the pool (live 2026-07-06: 21
  // real covid items collected, 0 rendered). Because the live render QC accepts
  // an honest headline-only row when content-heal owns it, and covid's clean bar
  // is only 1 article (not 5 like the other cards), covid can fill with headline
  // rows the same way immigration does.
  covid: 0,
  us: NEWS_TARGETS.us - NEWS_MAX_HEADLINE_FALLBACKS,
  world: NEWS_TARGETS.world - NEWS_MAX_HEADLINE_FALLBACKS,
  aitech: NEWS_TARGETS.aitech - NEWS_MAX_HEADLINE_FALLBACKS,
  // immigration: no summary-grade floor; honest headline rows may fill to target
  // because the live render QC permits them and a real low-yield day otherwise
  // collapses an otherwise-real card to a single article.
  immigration: 0,
  mortgage: MORTGAGE_TARGET - NEWS_MAX_HEADLINE_FALLBACKS,
};

// Per-card cap on how many headline-rescue rows may fill toward target once the
// summary-grade floor (NEWS_MIN_SUMMARY_GRADE) is met. Immigration can fill all
// remaining slots with honest headline rows (live render QC allows it). Covid is
// bounded to its clean minimum (1), not the full aspirational target of 5 -- a
// thin health beat with no summary-grade material should surface as an honest
// 1-article clean-minimum card, not silently pad toward 5 headline stubs.
// Every other card keeps the conservative one-row fallback.
const NEWS_MAX_HEADLINE_FALLBACKS_BY_CARD = {
  covid: COVID_CLEAN_MINIMUM,
  immigration: Infinity,
};

const COVID_TOPIC_RE =
  /\b(covid(?:-?19)?|coronavirus|sars[- ]?cov[- ]?2|long covid|paxlovid|remdesivir|vaccine|booster|variant|wastewater|antiviral|hospitali[sz]ation)\b/i;

// ── Default production generators (overridable via deps for tests) ──────────

// Viral: re-run the viral-tech-clip generator. It is already widened (extra
// queries + channel-uploads pull) so calling generate() with force is the
// widened-source re-run. Returns the proposal list.
async function defaultRunViral({ date, now } = {}) {
  const viral = require('./viral-tech-clip-proposals.js');
  const cachedBeforeRun = readCachedViralProposals(date);
  const data = await viral.generate({ date, now, force: true, target: VIRAL_TARGET });
  const fresh = Array.isArray(data && data.proposals) ? data.proposals : [];
  // A live YouTube pull can fail transiently (offline runner, expired auth,
  // network ACL) after a valid same-day file already exists. Keep the real
  // cached proposals as evidence instead of turning a good card into 0/3.
  return fresh.length ? fresh : cachedBeforeRun;
}

// Mortgage: re-run the widened mortgage feed pull. Pulls every reputable
// mortgage feed, dedups by link, filters to a freshness window, and fetches a
// real excerpt from each article body. Returns enriched article objects.
const MORTGAGE_FEEDS = [
  [
    'https://news.google.com/rss/search?q=mortgage+rates+OR+housing+market+OR+refinance&hl=en-US&gl=US&ceid=US:en',
    'Google News',
  ],
  ['https://www.mortgagenewsdaily.com/rss/news', 'Mortgage News Daily'],
  ['https://www.housingwire.com/feed/', 'HousingWire'],
  ['https://www.inman.com/feed/', 'Inman'],
  [
    'https://news.google.com/rss/search?q=site:nationalmortgagenews.com&hl=en-US&gl=US&ceid=US:en',
    'National Mortgage News',
  ],
  ['https://www.mba.org/x36608.xml', 'MBA NewsLink'],
  ['https://www.mpamag.com/us/rss', 'Mortgage Professional America'],
  [
    'https://news.google.com/rss/search?q=site:scotsmanguide.com&hl=en-US&gl=US&ceid=US:en',
    'Scotsman Guide',
  ],
  ['https://www.inman.com/category/mortgage/feed/', 'Inman Mortgage'],
];

const GDELT_DISCOVERY = {
  covid: '"COVID-19 treatment" OR Paxlovid OR remdesivir OR "COVID antiviral" OR "long COVID"',
  us: '("United States" OR US) (policy OR court OR Congress OR "White House" OR state)',
  world: 'world news OR geopolitics OR diplomacy OR conflict OR election',
  aitech:
    'artificial intelligence OR AI OR chip OR semiconductor OR cybersecurity OR "data center"',
  immigration: '"US immigration" OR USCIS OR EB-1A OR EB1A OR "green card" OR "visa bulletin"',
  mortgage:
    'mortgage rates OR housing market OR refinance OR mortgage lender OR "mortgage industry"',
};

// Resolve fetchFeed / fetchArticleBody from deps (tests) or the real briefing
// module (production). Never imported at module load so requiring content-heal
// in a test never pulls in the heavy briefing module.
function resolveBriefingFetchers(deps = {}) {
  if (deps.fetchFeed || deps.fetchArticleBody) {
    return {
      fetchFeed: deps.fetchFeed || (async () => []),
      fetchArticleBody: deps.fetchArticleBody || (async () => ''),
    };
  }
  const briefing = require('./manual-briefing-v3.js');
  return { fetchFeed: briefing.fetchFeed, fetchArticleBody: briefing.fetchArticleBody };
}

function fetchJsonUrl(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const lib = String(url).startsWith('http:') ? http : https;
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    try {
      const req = lib.get(
        url,
        {
          headers: { 'user-agent': 'secondbrain-content-heal/1.0' },
          timeout: timeoutMs,
        },
        (res) => {
          if ((res.statusCode || 0) !== 200) {
            res.resume();
            return finish(null);
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
            if (body.length > 2_000_000) req.destroy();
          });
          res.on('end', () => {
            try {
              finish(JSON.parse(body));
            } catch {
              finish(null);
            }
          });
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

function parseGdeltSeenDate(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (m) {
    return new Date(
      Date.UTC(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6]),
      ),
    ).toISOString();
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

async function defaultFetchGdelt(query, name = 'GDELT', max = DEFAULT_DISCOVERY_MAX) {
  if (!query) return [];
  const cappedMax = Math.max(
    1,
    Math.min(DEFAULT_DISCOVERY_MAX, Number(max) || DEFAULT_DISCOVERY_MAX),
  );
  const url =
    'https://api.gdeltproject.org/api/v2/doc/doc?query=' +
    encodeURIComponent(query) +
    `&mode=ArtList&maxrecords=${cappedMax}&format=json&sort=DateDesc&timespan=3d`;
  const data = await fetchJsonUrl(url, 8000);
  const articles = Array.isArray(data && data.articles) ? data.articles : [];
  return articles
    .filter((article) => article && article.url && article.title)
    .map((article) => {
      const publishedAtIso = parseGdeltSeenDate(article.seendate);
      return {
        title: cleanText(article.title),
        link: String(article.url).trim(),
        url: String(article.url).trim(),
        desc: '',
        excerpt: '',
        pubDate: publishedAtIso,
        publishedAtIso,
        author: '',
        source: article.domain ? `${article.domain} (${name})` : name,
        sourceUrl: url,
        date: publishedAtIso ? publishedAtIso.slice(0, 16) : '',
      };
    });
}

async function fetchGdeltDiscovery(card, { deps = {}, max = DEFAULT_DISCOVERY_MAX } = {}) {
  const query = GDELT_DISCOVERY[card];
  const fetchGdelt = deps.fetchGdelt || defaultFetchGdelt;
  if (!query || typeof fetchGdelt !== 'function') return [];
  try {
    const cappedMax = Math.max(
      1,
      Math.min(DEFAULT_DISCOVERY_MAX, Number(max) || DEFAULT_DISCOVERY_MAX),
    );
    return (await fetchGdelt(query, `${card} GDELT`, cappedMax)) || [];
  } catch {
    return [];
  }
}

function feedCandidateLimit(maxCandidates) {
  const max = Math.max(1, Number(maxCandidates) || 1);
  return Math.max(1, Math.min(max, Math.max(Math.ceil(max * 0.6), max - DEFAULT_DISCOVERY_MAX)));
}

function hasInlineExcerpt(article) {
  return nonEmpty(cleanText((article && (article.desc || article.excerpt)) || ''));
}

function hasSubstantialInlineExcerpt(article) {
  return (
    cleanText((article && (article.desc || article.excerpt)) || '').length >=
    SUMMARY_SOURCE_MIN_CHARS
  );
}

function prioritizeDiscoveryCandidates(feedCandidates, discoveryCandidates) {
  const feedWithText = feedCandidates.filter(hasInlineExcerpt);
  const feedNeedsBody = feedCandidates.filter((article) => !hasInlineExcerpt(article));
  return [...feedWithText, ...discoveryCandidates, ...feedNeedsBody];
}

// Google-News RSS feeds (immigration is ~100% these) hand us
// news.google.com/rss/articles/<id> stub URLs, not the publisher article. The
// legacy fetchArticleBody cannot read those: the stub 302s to itself then 400s,
// so every immigration row stays headline-tier and the summary-grade gate drops
// the whole card. Resolve the stub to the real publisher URL FIRST (same path
// cloud-covid-news.js already uses), then fetch the publisher body. Non-stub
// URLs and resolver/text failures fall straight through to the legacy fetch, so
// this only ADDS reach -- it never drops a row that already worked.
// resolveUrl / fetchText are injectable via deps for network-free tests.
function makeNewsBodyFetcher(fetchArticleBody, deps = {}) {
  const baseFetch = typeof fetchArticleBody === 'function' ? fetchArticleBody : async () => '';
  const resolver = typeof deps.resolveUrl === 'function' ? deps.resolveUrl : resolveGoogleNewsUrl;
  const textFetch = typeof deps.fetchText === 'function' ? deps.fetchText : fetchArticleText;
  return async (url, sourceUrl) => {
    if (url && isGoogleNewsArticleUrl(url)) {
      try {
        const resolved = await resolver(url);
        if (resolved && /^https?:\/\//i.test(resolved) && !/news\.google\.com/i.test(resolved)) {
          const body = await textFetch(resolved, {});
          if (body && String(body).trim()) return body;
        }
      } catch {
        // Fall through to the legacy body fetch below.
      }
    }
    return baseFetch(url, sourceUrl || url);
  };
}

function startBodyFetches(candidates, fetchArticleBody, maxBodyFetches, argsForArticle) {
  const bodies = new Map();
  if (typeof fetchArticleBody !== 'function') return bodies;
  let bodyFetches = 0;
  for (const article of candidates) {
    if (hasSubstantialInlineExcerpt(article) || bodyFetches >= maxBodyFetches) continue;
    bodyFetches += 1;
    bodies.set(
      article,
      Promise.resolve()
        .then(() => fetchArticleBody(...argsForArticle(article)))
        .then((body) => cleanText(body).slice(0, 2200))
        .catch(() => ''),
    );
  }
  return bodies;
}

// Generic widened-feed news pull. Pulls every feed for `card`, dedups by link,
// keeps the freshest material, and enriches each item with a real excerpt
// (RSS description first, then fetchArticleBody as fallback) plus a tier flag.
// Returns raw article objects; the collector does the source-bound filtering.
async function runNewsCardPull(card, { now, deps = {}, feeds, limit, bodyFetchLimit } = {}) {
  const { fetchFeed, fetchArticleBody } = resolveBriefingFetchers(deps);
  const feedList = feeds || NEWS_FEEDS[card] || [];
  const maxCandidates = Math.max(
    1,
    Number(limit) || newsRescueCollectionTarget(NEWS_TARGETS[card] || 10),
  );
  const maxBodyFetches = bodyFetchLimitFor(maxCandidates, bodyFetchLimit);
  const feedCandidates = [];
  const discoveryCandidates = [];
  const seen = new Set();
  const feedResults = await Promise.all(
    feedList.map(async ([url, source]) => {
      try {
        // immigration feeds are ~100% Google-News stubs that rank evergreen
        // picks near the top, so a depth-10 parse starves the in-window pool the
        // same way covid did; parse 40 deep for both thin specialized beats.
        const parseDepth = card === 'covid' || card === 'immigration' ? 40 : 10;
        return (await fetchFeed(url, source, parseDepth)) || [];
      } catch {
        return [];
      }
    }),
  );
  for (const items of feedResults) {
    for (const it of items || []) {
      const link = it && (it.link || it.url);
      if (!link || seen.has(link)) continue; // dedup by URL (Codex C#1)
      seen.add(link);
      feedCandidates.push(it);
    }
  }
  for (const it of await fetchGdeltDiscovery(card, {
    deps,
    max: Math.min(DEFAULT_DISCOVERY_MAX, maxCandidates),
  })) {
    const link = it && (it.link || it.url);
    if (!link || seen.has(link)) continue;
    seen.add(link);
    discoveryCandidates.push(it);
    if (discoveryCandidates.length >= Math.min(DEFAULT_DISCOVERY_MAX, maxCandidates)) break;
  }
  const feedForCandidates =
    discoveryCandidates.length > 0
      ? feedCandidates.slice(0, feedCandidateLimit(maxCandidates))
      : feedCandidates;
  const candidates = prioritizeDiscoveryCandidates(feedForCandidates, discoveryCandidates);
  // Resolve Google-News stub URLs to the real publisher BEFORE the body fetch so
  // immigration (and any other stub-heavy feed) yields summary-grade bodies
  // instead of collapsing every row to headline tier.
  const newsBodyFetcher = makeNewsBodyFetcher(fetchArticleBody, deps);
  const bodyFetches = startBodyFetches(candidates, newsBodyFetcher, maxBodyFetches, (a) => [
    a.link || a.url,
    a.sourceUrl || a.link || a.url,
  ]);
  // Enrich each with real source text. Prefer the RSS description only when it
  // is substantial enough to support the later three-ExampleCoraph summarizer;
  // otherwise use the fetched article body. A thin feed blurb is not
  // summary-grade evidence, because it renders as headline-only if the publisher
  // fetch later flakes.
  const enriched = [];
  for (const a of candidates) {
    let excerpt = cleanText(a.desc || a.excerpt || '');
    let tier = 'summary';
    if (excerpt.length < SUMMARY_SOURCE_MIN_CHARS && bodyFetches.has(a)) {
      const body = await bodyFetches.get(a);
      if (body.length >= SUMMARY_SOURCE_MIN_CHARS) excerpt = body;
    }
    if (excerpt.length < SUMMARY_SOURCE_MIN_CHARS) {
      // Headline rescue: the real RSS title is the only retrieved source text.
      excerpt = cleanText(a.title || '');
      tier = 'headline';
    }
    enriched.push({
      ...a,
      excerpt: excerpt.slice(0, 400),
      sourceText: excerpt.slice(0, 2200),
      tier,
    });
  }
  return enriched;
}

async function defaultRunMortgage({ now, deps = {}, limit, bodyFetchLimit } = {}) {
  const { fetchFeed, fetchArticleBody } = resolveBriefingFetchers(deps);
  const nowMs = new Date(now || Date.now()).getTime();
  const maxCandidates = Math.max(1, Number(limit) || newsRescueCollectionTarget(MORTGAGE_TARGET));
  const maxBodyFetches = bodyFetchLimitFor(maxCandidates, bodyFetchLimit);
  const feedCandidates = [];
  const discoveryCandidates = [];
  const seen = new Set();
  const feedResults = await Promise.all(
    MORTGAGE_FEEDS.map(async ([url, source]) => {
      try {
        return (await fetchFeed(url, source, 20)) || [];
      } catch {
        return [];
      }
    }),
  );
  for (const items of feedResults) {
    for (const it of items || []) {
      if (feedCandidates.length >= maxCandidates) break;
      const link = it && it.link;
      if (!link || seen.has(link)) continue;
      seen.add(link);
      feedCandidates.push(it);
    }
    if (feedCandidates.length >= maxCandidates) break;
  }
  for (const it of await fetchGdeltDiscovery('mortgage', {
    deps,
    max: Math.min(DEFAULT_DISCOVERY_MAX, maxCandidates),
  })) {
    const link = it && (it.link || it.url);
    if (!link || seen.has(link)) continue;
    seen.add(link);
    discoveryCandidates.push(it);
    if (discoveryCandidates.length >= Math.min(DEFAULT_DISCOVERY_MAX, maxCandidates)) break;
  }
  const feedForCandidates =
    discoveryCandidates.length > 0
      ? feedCandidates.slice(0, feedCandidateLimit(maxCandidates))
      : feedCandidates;
  const candidates = prioritizeDiscoveryCandidates(feedForCandidates, discoveryCandidates).slice(
    0,
    maxCandidates,
  );
  const bodyFetches = startBodyFetches(candidates, fetchArticleBody, maxBodyFetches, (a) => [
    a.link,
    a.link,
  ]);
  // 7-day freshness window; keep undated items (sparse feeds) so the pool is
  // never silently emptied, but the wall reason names the window queried.
  const fresh = candidates.filter((a) => {
    if (!a.pubDate) return true;
    const t = Date.parse(a.pubDate);
    return Number.isNaN(t) ? true : nowMs - t < 7 * DAY_MS;
  });
  // Enrich each with real source text. Short RSS blurbs are not enough backup
  // material for the later summarizer, so use the fetched body when available.
  const enriched = [];
  for (const a of fresh.slice(0, maxCandidates)) {
    let excerpt = cleanText(a.desc || '');
    if (excerpt.length < SUMMARY_SOURCE_MIN_CHARS && bodyFetches.has(a)) {
      const body = await bodyFetches.get(a);
      if (body.length >= SUMMARY_SOURCE_MIN_CHARS) excerpt = body;
    }
    enriched.push({ ...a, excerpt: excerpt.slice(0, 400) });
  }
  return enriched;
}

// ── Evidence collection (pure, no network) ──────────────────────────────────

// Map raw viral proposals to evidence items. A proposal only counts when it is
// a real video (has a source url), ExampleCos a real in-bounds timestamp, and
// ExampleCos real anchor text (insight / transcript line / short description).
function collectViralEvidence(proposals) {
  const items = [];
  const usedKeys = new Set();
  for (const p of proposals || []) {
    if (!p) continue;
    const url = p.clip_url || p.source_url || p.source_page_url || '';
    const sourceId = p.youtube_video_id || p.id || '';
    const approxTimestamp = p.approx_timestamp || '';
    const transcriptOrExcerpt = String(p.insight || p.short_description || '').trim();
    if (!url || !sourceId || !approxTimestamp || !nonEmpty(transcriptOrExcerpt)) continue;
    const uniqueKey = `${sourceId}|${approxTimestamp}`;
    if (usedKeys.has(uniqueKey)) continue; // no duplicate padding
    usedKeys.add(uniqueKey);
    items.push({ sourceId, url, approxTimestamp, transcriptOrExcerpt, uniqueKey });
  }
  return items;
}

// Map raw mortgage articles to evidence items. An article only counts when it
// has a real url, a real published timestamp, and a non-empty real excerpt.
function collectMortgageEvidence(articles) {
  const items = [];
  const usedKeys = new Set();
  for (const a of articles || []) {
    if (!a) continue;
    const url = a.link || a.url || '';
    if (!url) continue;
    const domain = domainOf(url);
    const excerpt = cleanText(a.excerpt || a.desc || '');
    if (!nonEmpty(excerpt)) continue;
    const tier = isTitleOnlyExcerpt(a.title, excerpt) ? 'headline' : 'summary';
    const pubRaw = a.pubDate || a.publishedAt || a.publishedAtIso || '';
    const t = Date.parse(pubRaw);
    if (!Number.isFinite(t)) continue; // real article timestamp required (mortgage)
    const publishedAtIso = new Date(t).toISOString();
    const sourceId = url;
    const uniqueKey = url;
    if (usedKeys.has(uniqueKey)) continue; // no duplicate padding
    usedKeys.add(uniqueKey);
    items.push({
      sourceId,
      url,
      domain,
      publishedAtIso,
      excerpt: excerpt.slice(0, 400),
      sourceText: excerpt.slice(0, 2200),
      tier,
      degraded: tier === 'headline',
      uniqueKey,
    });
  }
  return items;
}

/**
 * collectNewsEvidence -- source-bound, topic-freshness-aware collector for a
 * news card. Returns { items, dropped } where dropped breaks down why items
 * were rejected so the wall reason can name the undated-dropped count.
 *
 * Codex C#1: every kept item ExampleCos a real URL, a parseable in-window
 * publishedAtIso, and a non-empty real excerpt. Dedup by URL.
 * Codex C#2: a headline-rescue item is tier:"headline" + degraded:true. A
 * body/RSS excerpt item is tier:"summary".
 * Codex C#3: health (`covid`) uses a 72h current window; explicitly-labeled
 * background/context items may use up to 7d and are marked background:true.
 * General news uses windowHours (the active cascade step). Undated items count
 * ONLY at the headline tier (never as current-clean summary articles).
 */
function collectNewsEvidence(card, articles, { now, windowHours } = {}) {
  const nowMs = new Date(now || Date.now()).getTime();
  const fresh = NEWS_FRESHNESS[card] || { currentHours: 24, cascadeHours: [24, 48] };
  const currentHours = windowHours != null ? windowHours : fresh.currentHours;
  const backgroundHours = fresh.backgroundHours || currentHours;
  const items = [];
  const usedKeys = new Set();
  const dropped = {
    noUrl: 0,
    noExcerpt: 0,
    offTopic: 0,
    undatedDropped: 0,
    stale: 0,
    duplicate: 0,
  };

  for (const a of articles || []) {
    if (!a) continue;
    // Strip RSS CDATA wrappers (<![CDATA[ ... ]]>) some feeds put around the
    // link, then require a real http(s) URL. Without this the URL stays
    // "<![CDATA[https://...]]>" which the validator correctly rejects as
    // untraceable, dropping otherwise-real articles (ExampleCo 2026-06-04).
    let url = String(a.link || a.url || '').trim();
    url = url
      .replace(/^<!\[CDATA\[/i, '')
      .replace(/\]\]>$/, '')
      .trim();
    if (!/^https?:\/\//i.test(url)) {
      dropped.noUrl += 1;
      continue;
    }
    const bodyExcerpt = cleanNewsEvidenceText(a.sourceText || a.excerpt || a.desc || '');
    const excerpt = bodyExcerpt || cleanText(a.title || '');
    if (!nonEmpty(excerpt)) {
      dropped.noExcerpt += 1;
      continue;
    }
    if (!isOnTopicNewsEvidence(card, a, url, excerpt)) {
      dropped.offTopic += 1;
      continue;
    }

    // tier: a real body/RSS excerpt is summary-grade; a headline rescue (excerpt
    // collapsed to the title) is the degraded headline tier.
    const titleOnly = cleanText(a.title || '');
    const declaredTier =
      a.tier === 'headline'
        ? 'headline'
        : !bodyExcerpt ||
            bodyExcerpt.length < SUMMARY_SOURCE_MIN_CHARS ||
            (titleOnly && bodyExcerpt === titleOnly)
          ? 'headline'
          : 'summary';

    const pubRaw = a.pubDate || a.publishedAt || a.publishedAtIso || '';
    const t = Date.parse(pubRaw);
    const hasDate = Number.isFinite(t);
    const ageMs = hasDate ? nowMs - t : Infinity;

    let tier = declaredTier;
    let background = false;

    if (!hasDate) {
      // Undated items count ONLY at the headline tier, never as a current-clean
      // summary article (Codex C#3). If the source could not give us a date we
      // demote to a clearly-degraded headline rescue.
      tier = 'headline';
    } else if (ageMs <= currentHours * HOUR_MS) {
      // Fresh enough for the current window. Tier stays as declared.
    } else if (card === 'covid' && ageMs <= backgroundHours * HOUR_MS) {
      // Health background/context item: allowed up to the background window but
      // MUST be visibly dated + flagged so it never passes as current.
      background = true;
    } else {
      dropped.stale += 1;
      continue;
    }

    const uniqueKey = url; // dedup by URL so padding the same article is impossible
    if (usedKeys.has(uniqueKey)) {
      dropped.duplicate += 1;
      continue;
    }
    usedKeys.add(uniqueKey);

    const item = {
      sourceId: url,
      url,
      domain: domainOf(url),
      publishedAtIso: hasDate ? new Date(t).toISOString() : null,
      excerpt: excerpt.slice(0, 400),
      sourceText: bodyExcerpt.slice(0, 2200),
      tier,
      degraded: tier === 'headline',
      uniqueKey,
    };
    if (background) item.background = true;
    if (tier === 'headline' && !hasDate) dropped.undatedDropped += 1; // counted but flagged undated
    items.push(item);
  }
  return { items, dropped };
}

function rankNewsEvidence(items) {
  return (items || []).slice().sort((a, b) => {
    const as = a && a.tier === 'summary' ? 0 : 1;
    const bs = b && b.tier === 'summary' ? 0 : 1;
    return as - bs;
  });
}

function isOnTopicNewsEvidence(card, article, url, excerpt) {
  if (card !== 'covid') return true;
  const text = [article && article.title, article && article.source, excerpt, url]
    .filter(Boolean)
    .join(' ');
  return COVID_TOPIC_RE.test(text);
}

function enforceNewsSummaryGrade(card, items, target) {
  const ranked = rankNewsEvidence(items);
  const minSummary = NEWS_MIN_SUMMARY_GRADE[card] || 0;
  const maxHeadlines =
    card in NEWS_MAX_HEADLINE_FALLBACKS_BY_CARD
      ? NEWS_MAX_HEADLINE_FALLBACKS_BY_CARD[card]
      : NEWS_MAX_HEADLINE_FALLBACKS;
  const summaries = ranked.filter((item) => item.tier === 'summary');
  const headlines = ranked.filter((item) => item.tier !== 'summary');
  // Headlines may fill toward target only once the summary-grade floor is met.
  // A card with no floor (immigration) admits honest headline rows immediately
  // because the live render QC permits them; the per-card cap bounds how many.
  const floorMet = summaries.length >= minSummary;
  const slotsToTarget = Math.max(0, target - summaries.length);
  const headlineAllowance = floorMet ? Math.min(slotsToTarget, maxHeadlines) : 0;
  return summaries.concat(headlines.slice(0, headlineAllowance));
}

function viralWallReason(count) {
  return (
    `sources-exhausted: only ${count} real gate-passing viral tech clips exist today after querying the widened ` +
    `YouTube keyword set and channel uploads (Lex Fridman, Two Minute Papers, Y Combinator, a16z, OpenAI); ` +
    `no clip was padded to hit ${VIRAL_TARGET}`
  );
}

function mortgageWallReason(count) {
  const feedNames = MORTGAGE_FEEDS.map(([, name]) => name).join(', ');
  return (
    `sources-exhausted: only ${count} real in-window reputable mortgage sources exist today after querying ${feedNames}; ` +
    `no article was padded to hit ${MORTGAGE_TARGET}`
  );
}

function newsSourcesExhaustedWall(card, count, target, dropped = {}) {
  const feedNames = (NEWS_FEEDS[card] || []).map(([, name]) => name).join(', ');
  const undated = dropped.undatedDropped || 0;
  const stale = dropped.stale || 0;
  const offTopic = dropped.offTopic || 0;
  return (
    `sources-exhausted: only ${count}/${target} real in-window source-bound ${card} articles exist today after querying ${feedNames}; ` +
    `${stale} stale, ${undated} undated, and ${offTopic} off-topic item(s) were dropped; no article was padded to hit ${target}`
  );
}

function newsBudgetExhaustedWall(card, count, target, capMs) {
  return (
    `budget-exhausted: hit the ${Math.round((capMs || 0) / 1000)}s time cap for the ${card} card with ${count}/${target} real ` +
    `source-bound articles collected; stopping this pass so the overnight budget holds, the next pass continues`
  );
}

// ── Orchestration ───────────────────────────────────────────────────────────

/**
 * Heal one card. Loops the generator with widened sources until evidence count
 * >= target OR the pool stops growing (genuinely exhausted) OR the per-card
 * time budget is hit. Stops ONLY on valid-content-reached, sources-exhausted,
 * or budget-exhausted -- never silently (Codex C#5).
 *
 * @returns { count, target, items, wall, wallKind }
 *   wallKind is one of null | 'sources-exhausted' | 'budget-exhausted'.
 */
async function healCard({
  runGenerator,
  collect,
  target,
  collectionTarget,
  sourcesWallReason,
  budgetWallReason,
  maxRounds = 3,
  perCardMs = DEFAULT_PER_CARD_MS,
  deadlineMs = Infinity,
  continueOnNoGrowth = false,
  clock = () => Date.now(),
} = {}) {
  let bestItems = [];
  let prevCount = -1;
  let budgetHit = false;
  let okRounds = 0; // rounds where the generator actually ran without throwing
  const cardStart = clock();
  const cardDeadline = cardStart + perCardMs;
  const stopCount = Math.max(target, Number(collectionTarget) || target);

  for (let round = 0; round < maxRounds; round += 1) {
    // Budget check BEFORE each round so we never start a round we cannot finish
    // inside the per-card or per-pass cap.
    if (clock() >= cardDeadline || clock() >= deadlineMs) {
      budgetHit = true;
      break;
    }
    let raw = [];
    try {
      raw = await runGenerator({ round });
      okRounds += 1;
    } catch (err) {
      raw = [];
      console.warn('[content-heal] generator round failed:', safeError(err));
    }
    const items = collect(raw, { round });
    if (items.length > bestItems.length) bestItems = items;
    if (bestItems.length >= stopCount) break;
    // Budget check AFTER the round too (the round itself may have consumed the
    // cap), so a slow pool walls budget-exhausted instead of looping forever.
    if (clock() >= cardDeadline || clock() >= deadlineMs) {
      budgetHit = true;
      break;
    }
    // Pool stopped growing across a full round -> genuinely exhausted.
    if (items.length <= prevCount && !continueOnNoGrowth) break;
    prevCount = items.length;
  }

  const count = bestItems.length;
  let wall = null;
  let wallKind = null;
  if (count < target) {
    if (budgetHit) {
      wall = budgetWallReason(count);
      wallKind = 'budget-exhausted';
    } else if (okRounds === 0) {
      // Every generation round THREW -- we never actually observed the source
      // pool, so this is a heal ERROR, not genuine exhaustion. Use an
      // unrecognized wall kind so the validator's recognized-wall gate rejects it
      // and the briefing does NOT silently ship a thin card on a broken generator
      // (Codex B, 2026-06-08). The card stays a real failure until the heal runs.
      wall = `heal-error: the generator errored on all ${maxRounds} round(s); the source pool was never observed, so this is not a genuine exhaustion (${count}/${target})`;
      wallKind = 'heal-error';
    } else {
      wall = sourcesWallReason(count);
      wallKind = 'sources-exhausted';
    }
  }
  return { count, target, items: bestItems, wall, wallKind };
}

/**
 * runContentHeal -- heal the requested under-threshold cards, write the
 * content-heal-<date>.json evidence file, and return the in-memory result.
 *
 * @param {object} opts
 * @param {string} opts.date            CT date (YYYY-MM-DD). Defaults to today.
 * @param {string[]} opts.cards         which cards to heal. Defaults to all.
 * @param {Date}   opts.now             clock injection for freshness.
 * @param {string} opts.outDir          output directory. Defaults to data/agent.
 * @param {object} opts.deps            { runViral, runMortgage, runNews, fetchFeed, fetchArticleBody, clock } injection for tests.
 * @param {number} opts.perCardMs       per-card time cap (default 90s).
 * @param {number} opts.perPassMs       per-pass time cap (default 8min).
 * @param {boolean} opts.write          write the file (default true).
 */
async function runContentHeal(opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const date = opts.date || todayIso(now);
  const outDir = opts.outDir || OUT_DIR;
  const allCards = ['viral', 'mortgage', 'covid', 'us', 'world', 'aitech', 'immigration'];
  const which = Array.isArray(opts.cards) && opts.cards.length > 0 ? opts.cards : allCards;
  const deps = opts.deps || {};
  const clock = deps.clock || (() => Date.now());
  const perCardMs = opts.perCardMs == null ? DEFAULT_PER_CARD_MS : opts.perCardMs;
  const perPassMs = opts.perPassMs == null ? DEFAULT_PER_PASS_MS : opts.perPassMs;
  const bodyFetchLimit = opts.bodyFetchLimit;
  const passDeadline = clock() + perPassMs;

  const runViral = deps.runViral || ((args) => defaultRunViral({ date, now, ...args }));
  const runMortgage = deps.runMortgage || ((args) => defaultRunMortgage({ now, deps, ...args }));
  const runNews = deps.runNews || ((card, args) => runNewsCardPull(card, { now, deps, ...args }));
  const cachedViralProposals = which.includes('viral')
    ? typeof deps.cachedViralProposals === 'function'
      ? deps.cachedViralProposals({ date, now })
      : readCachedViralProposals(date)
    : [];

  const cards = {};

  if (which.includes('viral')) {
    cards.viral = await healCard({
      runGenerator: async (args) => {
        const fresh = await runViral(args);
        return Array.isArray(fresh) && fresh.length ? fresh : cachedViralProposals;
      },
      collect: collectViralEvidence,
      target: VIRAL_TARGET,
      sourcesWallReason: viralWallReason,
      budgetWallReason: (c) =>
        `budget-exhausted: hit the ${Math.round(perCardMs / 1000)}s viral cap with ${c}/${VIRAL_TARGET} clips; next pass continues`,
      perCardMs,
      deadlineMs: passDeadline,
      clock,
    });
  }

  if (which.includes('mortgage')) {
    const collectionTarget = newsRescueCollectionTarget(MORTGAGE_TARGET);
    // The mortgage source pull is round-invariant; only healCard's budget/source
    // wall decision changes across rounds, so do not repeat the same network tactic.
    let mortgageRawCache = null;
    cards.mortgage = await healCard({
      runGenerator: async (args) => {
        if (!mortgageRawCache)
          mortgageRawCache = await runMortgage({
            ...args,
            limit: collectionTarget,
            bodyFetchLimit,
          });
        return mortgageRawCache;
      },
      collect: (raw) =>
        enforceNewsSummaryGrade('mortgage', collectMortgageEvidence(raw), MORTGAGE_TARGET),
      target: MORTGAGE_TARGET,
      collectionTarget,
      sourcesWallReason: mortgageWallReason,
      budgetWallReason: (c) =>
        `budget-exhausted: hit the ${Math.round(perCardMs / 1000)}s mortgage cap with ${c}/${MORTGAGE_TARGET} articles; next pass continues`,
      perCardMs,
      deadlineMs: passDeadline,
      clock,
    });
  }

  for (const card of ['covid', 'us', 'world', 'aitech', 'immigration']) {
    if (!which.includes(card)) continue;
    const target = NEWS_TARGETS[card];
    const fresh = NEWS_FRESHNESS[card] || { cascadeHours: [24, 48] };
    const cascade = fresh.cascadeHours || [fresh.currentHours || 24];
    const collectionTarget = newsRescueCollectionTarget(target);
    let lastDropped = {};
    // The raw source pull is round-invariant. Each round only widens the QC
    // freshness window inside collect(), so refetching here is a duplicate tactic.
    let newsRawCache = null;
    cards[card] = await healCard({
      // Each "round" widens the freshness window through the cascade (24h ->
      // 48h for general news; covid stays 72h current with a 7d background
      // allowance handled inside the collector).
      runGenerator: async ({ round }) => {
        if (!newsRawCache)
          newsRawCache = await runNews(card, { round, limit: collectionTarget, bodyFetchLimit });
        return newsRawCache;
      },
      collect: (raw, { round } = {}) => {
        const windowHours = cascade[Math.min(round || 0, cascade.length - 1)];
        const { items, dropped } = collectNewsEvidence(card, raw, { now, windowHours });
        lastDropped = dropped;
        return enforceNewsSummaryGrade(card, items, target);
      },
      target,
      collectionTarget,
      sourcesWallReason: (c) => newsSourcesExhaustedWall(card, c, target, lastDropped),
      budgetWallReason: (c) => newsBudgetExhaustedWall(card, c, target, perCardMs),
      maxRounds: Math.max(cascade.length, 1),
      continueOnNoGrowth: cascade.length > 1,
      perCardMs,
      deadlineMs: passDeadline,
      clock,
    });
  }

  const result = { date, cards };

  if (opts.write !== false) {
    try {
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, `content-heal-${date}.json`);
      let toWrite = result;
      if (which.length < allCards.length) {
        const existing = readJsonFile(file);
        if (existing && existing.cards && typeof existing.cards === 'object') {
          toWrite = { ...existing, date, cards: { ...existing.cards, ...cards } };
          result.cards = toWrite.cards;
        }
      }
      fs.writeFileSync(file, JSON.stringify(toWrite, null, 2));
      result.outputPath = file;
    } catch (err) {
      console.error('[content-heal] write failed:', safeError(err));
      result.writeError = safeError(err);
    }
  }

  return result;
}

module.exports = {
  runContentHeal,
  healCard,
  collectViralEvidence,
  collectMortgageEvidence,
  collectNewsEvidence,
  enforceNewsSummaryGrade,
  makeNewsBodyFetcher,
  readCachedViralProposals,
  runNewsCardPull,
  viralWallReason,
  mortgageWallReason,
  newsSourcesExhaustedWall,
  newsBudgetExhaustedWall,
  defaultFetchGdelt,
  fetchGdeltDiscovery,
  domainOf,
  DEFAULT_DISCOVERY_MAX,
  DEFAULT_BODY_FETCH_MAX,
  VIRAL_TARGET,
  MORTGAGE_TARGET,
  NEWS_TARGETS,
  NEWS_FEEDS,
  NEWS_FRESHNESS,
  NEWS_MIN_SUMMARY_GRADE,
  DEFAULT_PER_CARD_MS,
  DEFAULT_PER_PASS_MS,
};

if (require.main === module) {
  const date = argValue('--date') || todayIso();
  const cardArg = argValue('--cards');
  const cards = cardArg
    ? cardArg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const bodyFetchLimit = Number(argValue('--body-fetch-limit')) || undefined;
  runContentHeal({ date, cards, bodyFetchLimit })
    .then((res) => {
      for (const [name, c] of Object.entries(res.cards)) {
        console.log(
          `[content-heal] ${name} ${c.count}/${c.target}${c.wall ? ` WALL(${c.wallKind}): ${c.wall}` : ' ok'}`,
        );
      }
      console.log(`[content-heal] wrote ${res.outputPath || '(no file)'}`);
    })
    .catch((err) => {
      console.error('[content-heal] fatal:', safeError(err));
      process.exitCode = 1;
    });
}
