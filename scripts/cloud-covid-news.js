#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  fetchArticleText,
  isGoogleNewsArticleUrl,
  resolveGoogleNewsUrl,
} = require('./lib/news-summarize.js');

const DEFAULT_DATA_DIR =
  process.env.SECONDBRAIN_DATA_DIR ||
  (process.platform === 'linux'
    ? '/opt/secondbrain/data'
    : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'secondbrain', 'data'));

const COVID_FEEDS = [
  [
    'Google News COVID',
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('COVID OR "COVID-19" OR coronavirus OR "long COVID" when:3d') +
      '&hl=en-US&gl=US&ceid=US:en',
  ],
  [
    'Google News COVID Treatments',
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('"COVID treatment" OR Paxlovid OR remdesivir OR "COVID clinical trial" when:3d') +
      '&hl=en-US&gl=US&ceid=US:en',
  ],
  [
    'Google News COVID Antivirals',
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('"COVID-19" Paxlovid OR remdesivir OR molnupiravir when:7d') +
      '&hl=en-US&gl=US&ceid=US:en',
  ],
  [
    'Google News Long COVID',
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('"long COVID" OR PASC OR "post-COVID" OR "post-acute COVID" when:3d') +
      '&hl=en-US&gl=US&ceid=US:en',
  ],
  [
    'The Sick Times Long COVID',
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:thesicktimes.org "long COVID" when:7d') +
      '&hl=en-US&gl=US&ceid=US:en',
  ],
  [
    'Google News COVID 72h',
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('COVID OR "COVID-19" OR coronavirus when:3d') +
      '&hl=en-US&gl=US&ceid=US:en',
  ],
  [
    'CDC COVID',
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:cdc.gov (covid OR coronavirus OR respiratory virus) when:3d') +
      '&hl=en-US&gl=US&ceid=US:en',
  ],
  [
    'STAT COVID',
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:statnews.com (covid OR coronavirus OR pandemic) when:3d') +
      '&hl=en-US&gl=US&ceid=US:en',
  ],
  [
    'WHO COVID',
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:who.int (covid OR coronavirus OR "SARS-CoV-2") when:3d') +
      '&hl=en-US&gl=US&ceid=US:en',
  ],
  [
    'AP Health COVID',
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:apnews.com (covid OR coronavirus OR pandemic) when:3d') +
      '&hl=en-US&gl=US&ceid=US:en',
  ],
  [
    'Reuters COVID',
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('site:reuters.com (covid OR coronavirus OR pandemic) when:3d') +
      '&hl=en-US&gl=US&ceid=US:en',
  ],
];

function argValue(name, args = process.argv) {
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  const pref = `${name}=`;
  const hit = args.find((arg) => arg.startsWith(pref));
  return hit ? hit.slice(pref.length) : null;
}

function todayIso() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function clean(value, max = 180) {
  return String(value || '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&#39;|&apos;|&#x27;/gi, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&#39;|&apos;|&#x27;/gi, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/\s+[.,;:!?]*$/g, '')
    .trim();
}

function cleanUrl(value) {
  return clean(value, 2048);
}

const COVID_EXPLICIT_RE =
  /\b(?:covid(?:-19)?|coronavirus|sars[-\s]?cov[-\s]?2|long covid|pasc|paxlovid|remdesivir|molnupiravir)\b/i;
const COVID_HEALTH_NEWS_RE =
  /\b(?:vaccine|vaccination|booster|immuniz|paxlovid|remdesivir|molnupiravir|antiviral|treatment|therapy|clinical trial|trial|study|research|cdc|fda|hospitalization|hospitalisation|long covid|pasc|sars[-\s]?cov[-\s]?2|variant|infection|public health|symptom|pregnancy|infant|dose|high-risk)\b/i;
const COVID_NON_HEALTH_CONTEXT_RE =
  /\b(?:spending|state audit|audit of|irs penalties|tax penalties|insanity defense|kill(?:ed|s)?|stab(?:bed|s|bing)?|murder|crime and courts|patent fight|stock titan|investor|treasury says|governor'?s covid spending)\b/i;
const COVID_PAGE_CHROME_RE =
  /\b(?:Today on Medscape|Homepage(?:\s+As\b)?|Cardiology Diabetes & Endocrinology|Family Medicine Hematology|Homepage Workers|Health Conditions All Breast Cancer|Featured Health News All Medicare|U\.S\. & World U\.S\. strikes Iran|Guest Opinion Parents were asked|Transforming Health through research|Kaiser Permanente Division of Research|News PRIVATE_NAME Johnson|FEMA official|Cartoon Devil|Subscribe|Sign up|Advertisement|reader experiencing an access issue|contact support@|contentlicensing@|whatismyip\.com|post[-\s]?covid decline in the labor share|labor share|vector-borne|malaria|investorideas|AI stocks|crypto|mining stocks|biotech stocks|Ebola deaths top|regional readiness)\b/i;

function isCovidArticleLike(item) {
  const lead = clean(`${item && item.title} ${item && item.desc} ${item && item.summary}`, 1000);
  const text = clean(`${lead} ${item && item.sourceText}`, 2000);
  return Boolean(
    lead &&
      COVID_EXPLICIT_RE.test(lead) &&
      COVID_HEALTH_NEWS_RE.test(lead) &&
      !COVID_NON_HEALTH_CONTEXT_RE.test(lead) &&
      !COVID_PAGE_CHROME_RE.test(text),
  );
}

function dedupeArticles(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = clean(row.title, 160).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function fetchCovidArticleBody(article, { fetchArticleBody, fetchText, resolveUrl } = {}) {
  if (!article.url) return '';
  const bodyFetch = typeof fetchArticleBody === 'function' ? fetchArticleBody : async () => '';
  const textFetch = typeof fetchText === 'function' ? fetchText : fetchArticleText;
  const resolver = typeof resolveUrl === 'function' ? resolveUrl : resolveGoogleNewsUrl;
  if (isGoogleNewsArticleUrl(article.url)) {
    try {
      const resolved = await resolver(article.url);
      if (resolved && /^https?:\/\//i.test(resolved)) {
        return textFetch(resolved, {});
      }
    } catch {
      // Fall through to the legacy body fetch below.
    }
  }
  return bodyFetch(article.url, article.sourceUrl || article.url);
}

async function attachSourceText(item, deps = {}) {
  const article = {
    title: clean(item.title, 160),
    source: clean(item.source, 80),
    url: cleanUrl(item.link || item.url),
    sourceUrl: cleanUrl(item.sourceUrl || ''),
    summary: clean(item.desc || 'Fresh COVID headline from the 72-hour source window.', 220),
    pubDate: item.pubDate || item.isoDate || '',
  };
  if (!article.url) return article;
  try {
    const body = clean(await fetchCovidArticleBody(article, deps), 5000);
    if (body.length >= 500) article.sourceText = body;
  } catch {
    // Body fetch is best effort; the renderer will only use source text that
    // cleared the substantial summary gate.
  }
  return article;
}

async function generateCovidNews({ dataDir = DEFAULT_DATA_DIR, date = todayIso(), deps = {} } = {}) {
  const manual = require('./manual-briefing-v3.js');
  const fetchFeed = deps.fetchFeed || manual.fetchFeed;
  const fetchArticleBody = deps.fetchArticleBody || manual.fetchArticleBody;
  const fetchText = deps.fetchText || fetchArticleText;
  const resolveUrl = deps.resolveUrl || resolveGoogleNewsUrl;
  const keywordRe = COVID_EXPLICIT_RE;
  const treatmentRe = /Paxlovid|remdesivir|antiviral|treatment|therapy|clinical trial|vaccine/i;
  const fetched = [];
  for (const [source, url] of COVID_FEEDS) {
    try {
      const rows = await fetchFeed(url, source, 40);
      fetched.push(...rows);
    } catch {
      // A single feed can fail without losing the whole card.
    }
  }
  const freshPool = dedupeArticles(fetched)
    .filter((item) => keywordRe.test(`${item.title || ''} ${item.desc || ''}`))
    .filter((item) => manual.isFreshWithinHours(item, 72))
    .sort((a, b) => {
      const at = treatmentRe.test(`${a.title || ''} ${a.desc || ''}`) ? 0 : 1;
      const bt = treatmentRe.test(`${b.title || ''} ${b.desc || ''}`) ? 0 : 1;
      return at - bt;
    })
    .slice(0, 60);
  const hydrated = [];
  for (const item of freshPool) {
    const article = await attachSourceText(item, { fetchArticleBody, fetchText, resolveUrl });
    if (isCovidArticleLike(article)) hydrated.push(article);
    if (hydrated.length >= 15) break;
  }
  const fresh = hydrated
    .sort((a, b) => {
      const ab = a.sourceText ? 0 : 1;
      const bb = b.sourceText ? 0 : 1;
      return ab - bb;
    })
    .slice(0, 5);

  const out = {
    date,
    generatedAt: new Date().toISOString(),
    articles: fresh,
    scanned: fetched.length,
    minimum: 5,
    wall:
      fresh.length >= 5
        ? null
        : `Only ${fresh.length}/5 current COVID items cleared the 72-hour source window.`,
  };
  const outDir = path.join(dataDir, 'agent', 'covid-news');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${date}.json`), JSON.stringify(out, null, 2) + '\n');
  return out;
}

async function main() {
  const date = argValue('--date') || todayIso();
  const dataDir = argValue('--data-dir') || DEFAULT_DATA_DIR;
  const out = await generateCovidNews({ dataDir, date });
  console.log(`[cloud-covid-news] ready date=${date} articles=${out.articles.length}`);
  if (out.articles.length < 5) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[cloud-covid-news] failed:', err.message);
    process.exit(1);
  });
}

module.exports = {
  generateCovidNews,
};
