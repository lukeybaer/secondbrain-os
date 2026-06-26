#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
    'Google News Long COVID',
    'https://news.google.com/rss/search?q=' +
      encodeURIComponent('"long COVID" OR PASC OR "post-COVID" OR "post-acute COVID" when:3d') +
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
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/\s+[.,;:!?]*$/g, '')
    .trim();
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

async function attachSourceText(item, fetchArticleBody) {
  const article = {
    title: clean(item.title, 160),
    source: clean(item.source, 80),
    url: clean(item.link || item.url, 240),
    summary: clean(item.desc || 'Fresh COVID headline from the 72-hour source window.', 220),
    pubDate: item.pubDate || item.isoDate || '',
  };
  if (!article.url || typeof fetchArticleBody !== 'function') return article;
  try {
    const body = clean(await fetchArticleBody(article.url, item.sourceUrl || item.link), 5000);
    if (body.length >= 500) article.sourceText = body;
  } catch {
    // Body fetch is best effort; the renderer will only use source text that
    // cleared the substantial summary gate.
  }
  return article;
}

async function generateCovidNews({ dataDir = DEFAULT_DATA_DIR, date = todayIso() } = {}) {
  const manual = require('./manual-briefing-v3.js');
  const keywordRe =
    /COVID|coronavirus|SARS-CoV-2|long COVID|post-COVID|PASC|Paxlovid|remdesivir|antiviral|vaccine|variant|hospitali[sz]ation|wastewater/i;
  const treatmentRe = /Paxlovid|remdesivir|antiviral|treatment|therapy|clinical trial|vaccine/i;
  const fetched = [];
  for (const [source, url] of COVID_FEEDS) {
    try {
      const rows = await manual.fetchFeed(url, source, 40);
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
    .slice(0, 15);
  const hydrated = [];
  for (const item of freshPool) {
    hydrated.push(await attachSourceText(item, manual.fetchArticleBody));
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
