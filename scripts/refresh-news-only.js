#!/usr/bin/env node
// Targeted news-section refresh for an existing briefing markdown.
//
// 2026-05-08 ExampleCo dispatch (PM): the full manual-briefing-v3.js run takes
// 30-45 minutes due to ~80 Claude CLI subprocess calls. When only the AI
// Tech and World news sections are wrong (3 articles instead of 10), this
// script:
//
//   1. Loads today's briefing markdown from data/briefings/briefing-<date>.md
//   2. Fetches the wider AI/Tech + World feed pool
//   3. Calls summarizeArticle for each via Claude CLI
//   4. Replaces the existing AI & TECH NEWS (N): and WORLD NEWS (N): blocks
//      with newly summarized 10-article blocks
//   5. Writes the patched markdown back in place
//   6. SCPs to /opt/secondbrain on EC2 (when --deploy is passed)
//
// Reuses the helpers from manual-briefing-v3.js by spawning it as a child
// would be heavy; instead we duplicate the small subset we need.

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { spawnSync, spawn } = require('child_process');
const { isThreeExampleCoraphArticleSummary } = require('./lib/news-summarize.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const BRIEFING_DIR = path.join(REPO_ROOT, 'data', 'briefings');
const USERPROFILE_DIR = process.env.USERPROFILE || os.homedir();
const CLAUDE_CLI_JS = path.join(
  USERPROFILE_DIR,
  'AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js',
);

function todayCT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function argValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : null;
}

function runDate() {
  return argValue('--date') || todayCT();
}

function fetchUrl(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('http:') ? http : https;
    const req = lib.get(
      url,
      {
        headers: {
          'user-agent': 'secondbrain-news-refresh/1.0',
          'accept-encoding': 'identity',
          ...headers,
        },
        timeout: 15000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects >= 5) return resolve({ statusCode: res.statusCode, body: '' });
          const nextUrl = new URL(res.headers.location, url).toString();
          res.resume();
          return fetchUrl(nextUrl, headers, redirects + 1).then(resolve, reject);
        }
        const chunks = [];
        res.on('data', (c) => {
          chunks.push(Buffer.from(c));
        });
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          try {
            if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
            else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
            else if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
          } catch {
            return resolve({ statusCode: res.statusCode, body: '' });
          }
          resolve({ statusCode: res.statusCode, body: buf.toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

async function fetchFeed(url, source) {
  try {
    const r = await fetchUrl(url);
    if (r.statusCode !== 200) return [];
    const items = (r.body.match(/<item>[\s\S]*?<\/item>/g) || []).slice(0, 25);
    const out = [];
    for (const item of items) {
      const titleM = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
      const linkM = item.match(/<link>([\s\S]*?)<\/link>/);
      const descM = item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);
      const pubM = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      const authM = item.match(/<dc:creator>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/dc:creator>/);
      if (!titleM || !linkM) continue;
      out.push({
        title: cleanNewsText(titleM[1]),
        link: linkM[1].trim(),
        desc: cleanNewsText(descM ? descM[1] : '').slice(0, 600),
        pubDate: pubM ? pubM[1] : '',
        author: authM ? cleanNewsText(authM[1]) : '',
        source,
        sourceUrl: url,
        date: pubM ? pubM[1].slice(0, 16) : '',
      });
    }
    return out;
  } catch (e) {
    console.warn(`[news-refresh] feed ${source} failed: ${e.message}`);
    return [];
  }
}

// FREE source-discovery: GDELT DOC 2.0 API (no key, no cost). Returns recent
// articles for a topic query in the same item shape as fetchFeed, so a thin
// section can climb the free discovery ladder and "go find more sources"
// instead of declaring a thin-day defect. 2026-06-09 ExampleCo: news must be
// free-only and must discover more sources, never give up at a short count.
async function fetchGdelt(query, name = 'GDELT', max = 40) {
  try {
    const url =
      'https://api.gdeltproject.org/api/v2/doc/doc?query=' +
      encodeURIComponent(query) +
      `&mode=ArtList&maxrecords=${max}&format=json&sort=DateDesc&timespan=3d`;
    const r = await fetchUrl(url);
    if (r.statusCode !== 200) return [];
    let data;
    try {
      data = JSON.parse(r.body);
    } catch {
      return [];
    }
    const arts = Array.isArray(data && data.articles) ? data.articles : [];
    return arts
      .filter((a) => a && a.url && a.title)
      .map((a) => ({
        title: cleanNewsText(a.title),
        link: String(a.url).trim(),
        desc: '',
        pubDate: a.seendate || '',
        author: '',
        source: a.domain ? `${a.domain} (GDELT)` : `${name} (GDELT)`,
        sourceUrl: url,
        date: a.seendate ? String(a.seendate).slice(0, 16) : '',
      }));
  } catch (e) {
    console.warn(`[news-refresh] GDELT ${name} failed: ${e.message}`);
    return [];
  }
}

function extractArticleExampleCoraphs(html) {
  const paras = [];
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const p = cleanNewsText(m[1]);
    if (isSubstantiveSourceText(p)) paras.push(p);
  }
  const unique = uniqueSentences(paras);
  return unique.length >= 3 ? unique.join('\n\n') : '';
}

async function fetchArticleBody(url) {
  try {
    const r = await fetchUrl(url);
    if (r.statusCode !== 200) return '';
    let text = r.body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<figure[\s\S]*?<\/figure>/gi, ' ')
      .replace(/<figcaption[\s\S]*?<\/figcaption>/gi, ' ')
      .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<header[\s\S]*?<\/header>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');
    const artM = text.match(/<article[\s\S]*?<\/article>/i) || text.match(/<main[\s\S]*?<\/main>/i);
    if (artM) text = artM[0];
    const articleExampleCoraphs = extractArticleExampleCoraphs(text);
    if (articleExampleCoraphs && !isBadArticleBody(articleExampleCoraphs)) {
      return articleExampleCoraphs.slice(0, 9000);
    }
    text = text
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#8217;/g, "'")
      .replace(/&#8220;/g, '"')
      .replace(/&#8221;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#[0-9]+;/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (isBadArticleBody(text)) return '';
    return text.slice(0, 6000);
  } catch {
    return '';
  }
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&middot;/g, ' ')
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '-')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const n = parseInt(hex, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : ' ';
    })
    .replace(/&#([0-9]+);/g, (_, dec) => {
      const n = parseInt(dec, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : ' ';
    });
}

function normalizePlainText(text) {
  return String(text || '')
    .replace(/\u00e2\u20ac\u2122/g, "'")
    .replace(/\u00e2\u20ac\u02dc/g, "'")
    .replace(/\u00e2\u20ac\u0153/g, '"')
    .replace(/\u00e2\u20ac\u009d/g, '"')
    .replace(/\u00e2\u20ac\u009c/g, '-')
    .replace(/\u00e2\u20ac\u009d/g, '-')
    .replace(/\u00e2\u20ac\u00a6/g, '...')
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, ' ');
}

function cleanNewsText(text) {
  return normalizePlainText(decodeEntities(text))
    .replace(/<!\[CDATA\[|\]\]>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\batdigit\b/gi, ' ')
    .replace(
      /\bStory text Size\s+Small\s+Standard\s+Large\s+Width\s+\*?\s*Standard\s+Wide\s+Links\s+Standard\s+Orange\s+\*?\s*Subscribers only\s+Learn more\b/gi,
      ' ',
    )
    .replace(
      /\b(?:Small|Standard|Large)\s+(?:Standard|Large)\s+Width\s+\*?\s*Standard\s+Wide\s+Links\s+Standard\s+Orange\s+\*?\s*Subscribers only\s+Learn more\b/gi,
      ' ',
    )
    .replace(
      /\b[A-Z][A-Za-z .'-]{1,80}\s+[–-]\s+[A-Z][a-z]{2,8}\s+\d{1,2},\s+2026\s+\d{1,2}:\d{2}\s+(?:am|pm)\s+\|\s+\d+\b/gi,
      ' ',
    )
    .replace(
      /\bShare\s+Save\s+Add as preferred on Google\b[\s\S]{0,260}?(?=\s+[A-Z][a-z]+|\s+\d+\s+(?:hour|minute|day)s?\s+ago|$)/gi,
      ' ',
    )
    .replace(/\bToggle more options\s+Download\s+Embed\s+Embed\s+"?>?/gi, ' ')
    .replace(/\bWatch:\s*[^.]{0,180}/gi, ' ')
    .replace(/\bBack transcript\b[^.]{0,180}/gi, ' ')
    .replace(/Credit:\s*[^.]{0,180}\s+Credit:/gi, ' ')
    .replace(/\bCredit:\s*[^.]{0,220}(?=\s+[A-Z])/gi, ' ')
    .replace(/\b(?:AP|Reuters|Getty Images|AFP)\s+(?:AP|Reuters|Getty Images|AFP)\b/gi, ' ')
    .replace(
      /\b(?:News|Analysis|Politics|Elections|Media|Obituaries|Europe)\s+[A-Z][^.!?]{0,180}\s+May\s+\d{1,2},\s+2026\s+\d{1,2}:\d{2}\s+(?:AM|PM)\s+ET\s+By\s+[A-Z][^.!?]{0,120}/gi,
      ' ',
    )
    .replace(
      /\b(?:Updated\s+)?May\s+\d{1,2},\s+2026\s+\d{1,2}:\d{2}\s+(?:AM|PM)\s+ET\s+(?:Originally published\s+May\s+\d{1,2},\s+2026\s+\d{1,2}:\d{2}\s+(?:AM|PM)\s+ET\s+)?By\s+[A-Z][^.!?]{0,120}/gi,
      ' ',
    )
    .replace(/\bHeard on [A-Z][^.!?]{0,120}/gi, ' ')
    .replace(/\bListen\s*(?:\d+:\d+)?\s*(?:\d+:\d+)?\s*Transcript\b/gi, ' ')
    .replace(/Text settings Story text Size[\s\S]{0,350}?Minimize to nav/gi, ' ')
    .replace(/Advertisement\s+SKIP ADVERTISEMENT/gi, ' ')
    .replace(/\bhide caption toggle caption\b/gi, ' ')
    .replace(/iPhone and Android app\.\s*Download the NEW APP"?/gi, ' ')
    .replace(/Toggle navigation[\s\S]{0,600}?Close Menu/gi, ' ')
    .replace(
      /Mortgage Rates and MBS[\s\S]{0,800}?This website requires Javascrip(?:t)? to run properly\.?/gi,
      ' ',
    )
    .replace(/^(?:[A-Z][A-Z .,'-]{2,60}|[A-Z][a-z]+,\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+-\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSentences(text) {
  return cleanNewsText(text)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 24)
    .filter((s) => !/^read the full article\b/i.test(s))
    .filter((s) => !/RSS-derived summary/i.test(s))
    .filter((s) => !isPublisherChrome(s));
}

function newsArtifactRe() {
  return /&[a-z0-9#]+;|<!\[CDATA\[|Text settings|Story text Size|Subscribers only|Standard\s+Wide\s+Links|SKIP ADVERTISEMENT|hide caption|toggle caption|Minimize to nav|Download the NEW APP|Toggle navigation|Current Mortgage Rates|Mortgage Rates and MBS|Rate Volatility Index|This website requires Javascrip|\batdigit\b|Today's Videos|Sponsor Message|Share Save|Add as preferred|Toggle more options|Download Embed|Heard on|Listen\s+\d|Transcript\b|Back transcript|Video\s+Back|This is a locator map|Credit:\s*[^.]{0,160}\s+Credit:|\b(?:AP|Reuters|Getty Images|AFP)\s+(?:AP|Reuters|Getty Images|AFP)\b|\b(?:News|Analysis|Politics|Elections|Media|Obituaries|Europe)\s+[A-Z][^.!?]{0,180}\s+May\s+\d{1,2},\s+2026\s+\d{1,2}:\d{2}\s+(?:AM|PM)\s+ET\s+By\b|\bBy The Associated Press\b/i;
}

function isPublisherChrome(text) {
  return (
    newsArtifactRe().test(String(text || '')) ||
    /Advertisement|Sign up|Subscribe|Audio will be available|MBS Live Commentary|Compare Rates from Local Lenders|More in [A-Z][a-z]+|Related contacts|Related insights|Related offices|Share Twitter Facebook LinkedIn|Explore more at Fragomen|Media mentions|Country \/ Territory|Email \[emailprotected\]|T:\s*\+?\d|Previous Next|Don't Miss an Update|Attorney Insights|friendly legal teams|Video Portugal Extends|Reach out today|support your company.?s immigration needs|Set Yourself Apart from your Competition|Become the market expert|^\d+\s+(?:minutes?|hours?|days?)\s+ago\b|\b(?:Correspondent|Reporter|Editor),\s+[A-Z][A-Za-z ,.-]+/i.test(
      String(text || ''),
    )
  );
}

function isBadArticleBody(text) {
  const s = String(text || '');
  const chromeHits = [
    /Toggle navigation/i,
    /Current Mortgage Rates/i,
    /Mortgage Rates and MBS/i,
    /This website requires Javascrip/i,
    /News Headlines Home Page/i,
    /Compare Rates from Local Lenders/i,
    /Rate Volatility Index/i,
    /Related contacts/i,
    /Related insights/i,
    /Share Twitter Facebook LinkedIn/i,
    /Reach out today/i,
    /Set Yourself Apart from your Competition/i,
  ].filter((re) => re.test(s)).length;
  return chromeHits >= 2;
}

function isSubstantiveSourceText(text) {
  const s = cleanNewsText(text);
  if (s.length < 70) return false;
  if (isPublisherChrome(s)) return false;
  if (!/[.!?]["']?$/.test(s)) return false;
  const words = s.split(/\s+/).filter(Boolean).length;
  return words >= 12;
}

function sourceLine(a) {
  const bits = [
    a.source,
    a.author ? `by ${a.author}` : '',
    a.date ? `on ${a.date.slice(0, 16)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return bits ? `The item was reported by ${bits}.` : '';
}

function uniqueSentences(sentences) {
  const seen = new Set();
  const out = [];
  for (const s of sentences) {
    const key = s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .slice(0, 90);
    if (!key || seen.has(key)) continue;
    const words = key.split(/\s+/).filter((w) => w.length > 3);
    const tooSimilar = out.some((prior) => {
      const pWords = prior
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 3);
      if (!words.length || !pWords.length) return false;
      const pSet = new Set(pWords);
      const overlap = words.filter((w) => pSet.has(w)).length;
      return overlap >= Math.min(8, Math.floor(Math.min(words.length, pWords.length) * 0.72));
    });
    if (tooSimilar) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function groupVerifiedExampleCoraphs(sentences) {
  const usable = uniqueSentences(sentences)
    .filter((s) => s.length >= 55)
    .filter((s) => !/^read the full article\b/i.test(s))
    .filter((s) => !/RSS-derived summary/i.test(s))
    .filter((s) => !/^(advertisement|sign up|subscribe|listen to|watch:)/i.test(s))
    .filter((s) => !/^\d+\s+(?:minutes?|hours?|days?)\s+ago\b/i.test(s))
    .filter((s) => !/\b(?:Correspondent|Reporter|Editor),\s+[A-Z][A-Za-z ,.-]+/.test(s))
    .filter((s) => !isPublisherChrome(s))
    .slice(0, 9);
  if (usable.length < 5) return null;
  const joinPara = (...parts) => parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const firstSize = 2;
  const secondSize = 2;
  const ExampleCoraphs = [
    joinPara(...usable.slice(0, firstSize)),
    joinPara(...usable.slice(firstSize, firstSize + secondSize)),
    joinPara(
      ...usable.slice(firstSize + secondSize, Math.min(usable.length, firstSize + secondSize + 3)),
    ),
  ];
  if (!isCleanThreeExampleCoraphSummary(ExampleCoraphs)) return null;
  return ExampleCoraphs.join('\n\n');
}

function sourceExcerpt(a, body) {
  const sentences = uniqueSentences([
    ...splitSentences(body || ''),
    ...splitSentences(a.desc || ''),
  ])
    .filter((s) => s.length >= 55)
    .filter((s) => !newsArtifactRe().test(s))
    .filter((s) => !isPublisherChrome(s))
    .slice(0, 28);
  if (sentences.length < 5) return '';
  return sentences.join(' ');
}

function isCleanThreeExampleCoraphSummary(ExampleCoraphs) {
  if (!Array.isArray(ExampleCoraphs) || ExampleCoraphs.length !== 3) return false;
  return ExampleCoraphs.every((p) => {
    const s = String(p || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (s.length < 110 || s.length > 900) return false;
    if (s.split(/\s+/).filter(Boolean).length < 18) return false;
    if (!/[.!?]["']?$/.test(s)) return false;
    if (/^(What happened|Why it matters|What to watch):/i.test(s)) return false;
    if (newsArtifactRe().test(s) || isPublisherChrome(s)) return false;
    return true;
  });
}

function normalizeSummaryExampleCoraphs(raw) {
  let s = normalizePlainText(decodeEntities(raw))
    .replace(/```(?:\w+)?/g, '')
    .replace(/```/g, '')
    .replace(/\r/g, '')
    .trim();
  if (!s) return null;

  let ExampleCoraphs = s
    .split(/\n\s*\n+/)
    .map((p) =>
      cleanNewsText(p)
        .replace(/^\s*(?:\d+\.|[-*])\s*/, '')
        .trim(),
    )
    .filter(Boolean);

  if (ExampleCoraphs.length !== 3) {
    const lines = s
      .split(/\n+/)
      .map((p) =>
        cleanNewsText(p)
          .replace(/^\s*(?:\d+\.|[-*])\s*/, '')
          .trim(),
      )
      .filter(Boolean);
    if (lines.length === 3) ExampleCoraphs = lines;
  }

  if (!isCleanThreeExampleCoraphSummary(ExampleCoraphs)) return null;
  return ExampleCoraphs.join('\n\n');
}

function verifiedThreeNewsExampleCoraphs(a, body) {
  const bodySentences = splitSentences(body || '');
  const descSentences = splitSentences(a.desc || '');
  const normalize = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const titleNorm = normalize(a.title);
  const filtered = [...descSentences, ...bodySentences].filter((s) => {
    const n = normalize(s);
    if (!n) return false;
    if (
      titleNorm &&
      (n.startsWith(titleNorm) ||
        (n.includes(titleNorm) && s.length < String(a.title || '').length + 140))
    )
      return false;
    if (
      /Share Save|Add as preferred|Toggle more options|Download Embed|Today's Videos|Back transcript|transcript Back/i.test(
        s,
      )
    )
      return false;
    return true;
  });
  const ExampleCoraphs = groupVerifiedExampleCoraphs(filtered);
  if (!ExampleCoraphs) return null;
  return ExampleCoraphs;
}

// Final compliance gate for a section row. A candidate is only allowed to COUNT
// toward the section target (and stay in the rendered set) when its summary is a
// real 3-ExampleCoraph article brief. A thin, headline-only, or publisher-chrome
// summary that slipped past the upstream paths (e.g. the verified-ExampleCoraph last
// resort) must be treated as a skip so the next queue/discovery candidate fills
// the slot instead of leaving a non-compliant row. ExampleCo 2026-06-28.
function isUsableSectionSummary(summary, item = {}) {
  if (!summary || typeof summary !== 'string') return false;
  const paras = summary
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return isThreeExampleCoraphArticleSummary(paras, item);
}

function claudeSummarize(prompt) {
  // Bypass the Claude Code nested-session guard: when CLAUDECODE is set in
  // the parent env, the CLI refuses to start. Strip it from the spawn env.
  // Spawn cli.js directly via node to avoid the .cmd shim quirks on Windows.
  const env = { ...process.env };
  delete env.CLAUDECODE;
  const safePrompt = String(prompt).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  try {
    const out = spawnSync(
      process.execPath,
      [CLAUDE_CLI_JS, '--model', 'claude-haiku-4-5-20251001', '-p', safePrompt],
      {
        env,
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (out.status !== 0 || !out.stdout) {
      const err = (out.error && out.error.message) || (out.stderr || '').slice(0, 200);
      console.warn('[claude] exit', out.status, 'err:', err);
      return '';
    }
    return (out.stdout || '').trim();
  } catch (e) {
    console.warn('[claude] spawn failed:', e.message);
    return '';
  }
}

// Async parallel-friendly variant: each call spawns Claude CLI as a non-blocking
// process so gatherSection can run N candidates concurrently. The per-call timeout
// is 120s but with concurrency the section completes in roughly
// (slowest call in each batch), not (sum of all calls). 2026-05-11 origin: the
// serial loop blew past manual-briefing-v3.js's 7-minute outer timeout before
// any non-tech section could be regenerated, leaving 0/10 in 4 of 5 sections.
// 2026-05-30: the kill timer was a hardcoded 90000 (90s) while this comment and
// the design intent said 120s. Under the briefing's BATCH=6 concurrent burst plus
// sibling Claude Code sessions contending on the same OAuth/Max plan, in-budget
// calls that took 90-119s were killed prematurely, leaving sections under target
// (immigration 3/10, mortgage 4/10). The kill timer now derives from the
// documented per-call budget so code and contract can never drift apart again.
const CLAUDE_SUMMARIZE_TIMEOUT_MS = 120000;
function claudeSummarizeAsync(prompt) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const safePrompt = String(prompt).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    const proc = spawn(
      process.execPath,
      [CLAUDE_CLI_JS, '--model', 'claude-haiku-4-5-20251001', '-p', safePrompt],
      { env, windowsHide: true },
    );
    const chunks = [];
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        proc.kill('SIGTERM');
      } catch {}
      try {
        setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {}
        }, 2000).unref();
      } catch {}
    }, CLAUDE_SUMMARIZE_TIMEOUT_MS);
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', () => {});
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed || code !== 0) {
        if (killed) console.warn(`[claude] timed out after ${CLAUDE_SUMMARIZE_TIMEOUT_MS / 1000}s`);
        else if (code !== 0) console.warn('[claude] async exit', code);
        return resolve('');
      }
      resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      console.warn('[claude] async spawn failed:', e.message);
      resolve('');
    });
  });
}

// Codex (GPT-5.x) summarizer fallback for when Claude Max is saturated/slow.
// Uses the one-shot codex-run.js runner; strips its wrapper lines so only the
// model's prose returns. This is the claude->codex fallback so news still
// generates real 3-ExampleCoraph summaries when the Claude CLI times out.
const CODEX_RUN_JS = require('path').join(__dirname, 'codex-run.js');
function codexSummarizeAsync(prompt) {
  return new Promise((resolve) => {
    const safePrompt = String(prompt).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    let proc;
    try {
      proc = spawn(
        process.execPath,
        [CODEX_RUN_JS, '--read-only', '--timeout-min', '4', safePrompt],
        { windowsHide: true },
      );
    } catch (e) {
      return resolve('');
    }
    const chunks = [];
    let killed = false;
    const timer = setTimeout(
      () => {
        killed = true;
        try {
          proc.kill('SIGKILL');
        } catch {}
      },
      5 * 60 * 1000,
    );
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      clearTimeout(timer);
      if (killed) {
        console.warn('[codex] summarize timed out');
        return resolve('');
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const cleaned = raw
        .split(/\r?\n/)
        .filter(
          (l) =>
            !/^codex-run:|^Codex session ID:|^Resume in Codex:|DeprecationWarning|trace-deprecation|^\(node:/.test(
              l,
            ),
        )
        .join('\n')
        .trim();
      resolve(cleaned);
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
  });
}

// ── AWS Bedrock (Claude Sonnet) summarizer ───────────────────────────────────
// Primary summarization rung. ExampleCo-admin creds, no interactive login. Async
// (spawn) so gatherSection's concurrent candidates do not serialize on the event
// loop. The aws CLI is aws.cmd on Windows -> shell:true (cmd.exe -> aws.exe
// grandchild); stdout is unused (the model answer is written to outFile) and
// stderr -> file, so a lingering grandchild can never hold an inherited pipe open
// past the timeout (the same grandchild-pipe-leak class fixed in
// manual-briefing-v3.js and locked by bedrock-spawn-no-grandchild-pipe.test.js).
const BEDROCK_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';
const BEDROCK_REGION = 'us-east-1';
const BEDROCK_TIMEOUT_MS = 60000;
let bedrockUsableCache = null;

function chargedLlmApiApprovedForDirectSurface() {
  const codexDown = /^(1|true|yes)$/i.test(process.env.AMY_CODEX_DOWN_PROVEN || '');
  if (!codexDown) return false;
  const approvedUntil = Date.parse(process.env.AMY_CHARGED_LLM_API_APPROVED_UNTIL || '');
  return Number.isFinite(approvedUntil) && approvedUntil > Date.now();
}

// Pure parser for the bedrock-runtime invoke-model output body
// ({ content: [{ type, text }] }). Returns trimmed text or '' for any malformed
// shape. Exported so the response-shape contract has a no-network unit test.
function parseBedrockOut(rawJson) {
  let parsed;
  try {
    parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  } catch {
    return '';
  }
  const text = parsed && parsed.content && parsed.content[0] && parsed.content[0].text;
  return typeof text === 'string' ? text.trim() : '';
}
function bedrockSummarizeAsync(prompt) {
  return new Promise((resolve) => {
    if (bedrockUsableCache === false) return resolve('');
    if (!chargedLlmApiApprovedForDirectSurface()) return resolve('');
    const safePrompt = String(prompt || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    if (!safePrompt) return resolve('');
    const stamp = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const reqFile = path.join(os.tmpdir(), `sb_news_bedrock_req_${stamp}.json`);
    const outFile = path.join(os.tmpdir(), `sb_news_bedrock_out_${stamp}.json`);
    const errFile = path.join(os.tmpdir(), `sb_news_bedrock_err_${stamp}.txt`);
    try {
      fs.writeFileSync(
        reqFile,
        JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 1024,
          messages: [{ role: 'user', content: safePrompt }],
        }),
      );
    } catch {
      return resolve('');
    }
    let errFd;
    try {
      errFd = fs.openSync(errFile, 'w');
    } catch {
      errFd = 'ignore';
    }
    let proc;
    try {
      proc = spawn(
        'aws',
        [
          'bedrock-runtime',
          'invoke-model',
          '--model-id',
          BEDROCK_MODEL_ID,
          '--region',
          BEDROCK_REGION,
          '--cli-binary-format',
          'raw-in-base64-out',
          '--body',
          `fileb://${reqFile}`,
          outFile,
        ],
        { shell: true, windowsHide: true, stdio: ['ignore', 'ignore', errFd] },
      );
    } catch {
      try {
        if (errFd !== 'ignore') fs.closeSync(errFd);
      } catch {}
      for (const f of [reqFile, outFile, errFile]) {
        try {
          fs.unlinkSync(f);
        } catch {}
      }
      if (bedrockUsableCache == null) bedrockUsableCache = false;
      return resolve('');
    }
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (errFd !== 'ignore') fs.closeSync(errFd);
      } catch {}
      let text = '';
      try {
        text = parseBedrockOut(fs.readFileSync(outFile, 'utf8'));
      } catch {
        text = '';
      }
      for (const f of [reqFile, outFile, errFile]) {
        try {
          fs.unlinkSync(f);
        } catch {}
      }
      resolve(val != null ? val : text || '');
    };
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch {}
      // First timeout marks Bedrock unusable so the rest of the run does not each
      // pay the full budget -- they fall straight to the claude/codex rungs.
      if (bedrockUsableCache == null) bedrockUsableCache = false;
      finish('');
    }, BEDROCK_TIMEOUT_MS);
    proc.on('close', (code) => {
      if (code === 0) bedrockUsableCache = true;
      else if (bedrockUsableCache == null) bedrockUsableCache = false;
      finish();
    });
    proc.on('error', () => {
      if (bedrockUsableCache == null) bedrockUsableCache = false;
      finish('');
    });
  });
}

let claudeCliUsableCache = null;

function claudeCliUsable() {
  // Operator override: when Claude Max is saturated, skip it entirely and route
  // news summaries straight to Codex (avoids 120s-per-article Claude timeouts).
  if (process.env.NEWS_FORCE_CODEX === '1') {
    claudeCliUsableCache = false;
    return false;
  }
  if (claudeCliUsableCache != null) return claudeCliUsableCache;
  const healthPath = path.join(REPO_ROOT, 'data', 'agent', 'news-summarizer-health.json');
  const writeHealth = (status, detail) => {
    try {
      fs.mkdirSync(path.dirname(healthPath), { recursive: true });
      fs.writeFileSync(
        healthPath,
        JSON.stringify(
          {
            checkedAt: new Date().toISOString(),
            status,
            detail: String(detail || '')
              .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]')
              .slice(0, 500),
          },
          null,
          2,
        ),
      );
    } catch {}
  };
  if (!fs.existsSync(CLAUDE_CLI_JS)) {
    claudeCliUsableCache = false;
    writeHealth('red', `Claude CLI not found at ${CLAUDE_CLI_JS}`);
    return claudeCliUsableCache;
  }
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  try {
    const out = spawnSync(process.execPath, [CLAUDE_CLI_JS, '-p', 'Return exactly: ok'], {
      env,
      encoding: 'utf8',
      timeout: 45000,
      maxBuffer: 1024 * 1024,
    });
    claudeCliUsableCache = out.status === 0 && /\bok\b/i.test(out.stdout || '');
    if (claudeCliUsableCache)
      writeHealth('green', 'Claude CLI produced a probe response for news summaries.');
    if (!claudeCliUsableCache) {
      const reason = (
        out.stderr ||
        out.stdout ||
        (out.error && out.error.message) ||
        'no output'
      ).slice(0, 220);
      writeHealth('red', reason);
      console.warn(`[news-refresh] Claude CLI unavailable for abstractive summaries: ${reason}`);
    }
    return claudeCliUsableCache;
  } catch (e) {
    console.warn(`[news-refresh] Claude CLI probe failed: ${e.message}`);
    writeHealth('red', e.message);
    claudeCliUsableCache = false;
    return claudeCliUsableCache;
  }
}

async function summarizeArticle(a) {
  // Extraction is only the source material. The rendered briefing must be a
  // three-ExampleCoraph executive article brief, not copied publisher snippets.
  if (isNonArticleCandidate(a)) return null;
  const body = a.body || (await fetchArticleBody(a.link));
  const ctx = sourceExcerpt(a, body || a.desc || '');
  if (!ctx || ctx.length < 500) return null;

  {
    const prompt = [
      "Write ExampleCo's morning briefing summary for the news article below.",
      '',
      'Hard requirements:',
      '- Output exactly 3 ExampleCoraphs and nothing else.',
      '- No labels, bullets, headings, markdown, source names, transcript language, or read-more language.',
      '- Summarize only facts present in the source excerpt. Do not invent, forecast, or editorialize.',
      '- Make it read like a concise article replacement for an executive: what happened, why it matters, and what to watch, woven into narrative ExampleCoraphs.',
      '- Each ExampleCoraph should be 2-3 sentences, dense but readable.',
      '- Use plain ASCII punctuation only.',
      '',
      `Title: ${a.title}`,
      `Source: ${a.source}${a.author ? ` by ${a.author}` : ''}${a.date ? ` on ${a.date}` : ''}`,
      `URL: ${a.link}`,
      '',
      'Source excerpt:',
      ctx.slice(0, 7500),
    ].join('\n');
    // Rung 1: AWS Bedrock (Claude Sonnet, ExampleCo-admin creds) -- the PRIMARY
    // summarization path, mirroring manual-briefing-v3.js. Confirmed ~3-8s/call
    // from this box, no login, no TLDR-collapse, and (unlike the local claude CLI
    // here) no 120s timeout pathology. 2026-06-13: this backfill path was the
    // orphan that still LED with the unreliable local CLI; when the CLI timed out
    // on every candidate it left US IMMIGRATION 0/10 and US NEWS 7/10 in the
    // rendered briefing even though the widened pools held 19 and 119 articles.
    const bedrockSummary = normalizeSummaryExampleCoraphs(await bedrockSummarizeAsync(prompt));
    if (bedrockSummary) return bedrockSummary;
    // Rung 2: local Claude CLI (Claude Max), only when the one-time probe says it
    // is usable. Secondary now that Bedrock leads.
    if (claudeCliUsable()) {
      const summary = normalizeSummaryExampleCoraphs(await claudeSummarizeAsync(prompt));
      if (summary) return summary;
    }
    // Rung 3: Codex (GPT-5.x) for a real 3-ExampleCoraph summary before resorting to
    // direct extraction.
    const codexSummary = normalizeSummaryExampleCoraphs(await codexSummarizeAsync(prompt));
    if (codexSummary) return codexSummary;
  }

  // Last resort: ship only verified source ExampleCoraphs (direct article text that
  // passed the same chrome/noise gate).
  return verifiedThreeNewsExampleCoraphs(a, ctx);
}

function isNonArticleCandidate(a) {
  const link = String((a && a.link) || '').toLowerCase();
  const title = String((a && a.title) || '');
  if (/\/video(?:\/|$)|\/videos(?:\/|$)|\/watch(?:\/|$)|\/podcast(?:\/|$)/i.test(link)) return true;
  if (/\[(?:video|audio)\]/i.test(title)) return true;
  if (/\btranscript\b/i.test(title)) return true;
  if (/^\s*(watch|listen)\b/i.test(title)) return true;
  return false;
}

function formatArticle(a, i, summary) {
  const meta = [a.source, a.author, a.date].filter(Boolean).join(' - ');
  return [
    `${i + 1}. ${a.title}`,
    meta ? `   ${meta}` : null,
    a.link ? `   ${a.link}` : null,
    '',
    summary,
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

function dedup(items, max) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = (it.title || '').toLowerCase().slice(0, 40);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
    if (out.length >= max) break;
  }
  return out;
}

// 2026-05-25 ExampleCo flagged: today's AI & TECH NEWS card was 10/10 from one
// publisher (Ars Technica). Cap any single source so no feed can monopolize
// a section. Default 3 per source, applied after dedup and before the
// expensive Claude summarization pass so we don't burn tokens on dropped
// candidates.
function capPerSource(items, maxPerSource = 3) {
  const counts = new Map();
  const out = [];
  for (const it of items) {
    const src = it.source || '(ExampleCo)';
    const n = counts.get(src) || 0;
    if (n >= maxPerSource) continue;
    counts.set(src, n + 1);
    out.push(it);
  }
  return out;
}

// 2026-05-25 ExampleCo flagged: today's AI & TECH NEWS card was 10/10 Ars
// Technica general-feed stories (beluga whales, Starship, Ebola, FCC vs
// The View, etc) with zero AI items. Two causes: (1) the broad
// arstechnica.com/feed/, theverge.com/rss/tech/, engadget.com/rss.xml,
// technologyreview.com/feed/ pull every story regardless of topic; (2) no
// per-source cap so the most prolific publisher monopolized the card.
// Wired's AI feed returned HTTP 400 silently, removed.
// Engadget removed (consumer gadget reviews, not AI/EA-bot intel ExampleCo wants).
// Diversity enforced by MAX_PER_SOURCE in gatherSection.
const TECH_FEEDS = [
  ['https://arstechnica.com/ai/feed/', 'Ars Technica AI'],
  ['https://techcrunch.com/category/artificial-intelligence/feed/', 'TechCrunch AI'],
  ['https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', 'The Verge AI'],
  ['https://venturebeat.com/category/ai/feed/', 'VentureBeat AI'],
  ['https://www.technologyreview.com/topic/artificial-intelligence/feed', 'MIT Tech Review AI'],
  ['https://www.zdnet.com/topic/artificial-intelligence/rss.xml', 'ZDNet AI'],
];

const US_FEEDS = [
  ['https://rss.nytimes.com/services/xml/rss/nyt/US.xml', 'NYT US'],
  ['https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml', 'NYT Politics'],
  ['https://feeds.npr.org/1014/rss.xml', 'NPR US'],
  ['https://feeds.npr.org/1003/rss.xml', 'NPR Politics'],
  ['https://www.cbsnews.com/latest/rss/us', 'CBS US'],
  ['https://news.google.com/rss?gl=US&ceid=US:en&hl=en-US&topic=NATION', 'Google News NATION'],
];

const WORLD_FEEDS = [
  ['https://feeds.bbci.co.uk/news/world/rss.xml', 'BBC World'],
  ['https://rss.nytimes.com/services/xml/rss/nyt/World.xml', 'NYT World'],
  ['https://www.theguardian.com/world/rss', 'Guardian World'],
  ['https://www.cbsnews.com/latest/rss/world', 'CBS World'],
  ['https://news.google.com/rss?gl=US&ceid=US:en&hl=en-US&topic=WORLD', 'Google News World'],
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
  [
    'https://news.google.com/rss/search?q=site:france24.com+world&hl=en-US&gl=US&ceid=US:en',
    'France24 via Google',
  ],
  [
    'https://news.google.com/rss/search?q=site:euronews.com+world&hl=en-US&gl=US&ceid=US:en',
    'Euronews via Google',
  ],
];

const MORTGAGE_FEEDS = [
  ['https://www.mortgagenewsdaily.com/rss/news', 'Mortgage News Daily'],
  ['https://www.mortgagenewsdaily.com/rss/rates', 'Mortgage News Daily Rates'],
  ['https://www.housingwire.com/feed/', 'HousingWire'],
  ['https://www.inman.com/feed/', 'Inman'],
  ['https://nationalmortgageprofessional.com/rss.xml', 'National Mortgage Professional'],
  [
    'https://news.google.com/rss/search?q=mortgage+rates+OR+housing+market+OR+housing+inventory+OR+homebuyer+OR+refinance&hl=en-US&gl=US&ceid=US:en',
    'Google News Mortgage',
  ],
  [
    'https://news.google.com/rss/search?q=site:housingwire.com+mortgage+OR+housing&hl=en-US&gl=US&ceid=US:en',
    'HousingWire via Google',
  ],
  [
    'https://news.google.com/rss/search?q=site:nationalmortgageprofessional.com+mortgage&hl=en-US&gl=US&ceid=US:en',
    'NMP via Google',
  ],
];

const IMMIGRATION_FEEDS = [
  [
    'https://news.google.com/rss/search?q=%22USCIS%22+OR+%22green+card%22+OR+%22visa+bulletin%22+OR+%22I-485%22+OR+%22adjustment+of+status%22+OR+%22EB-1A%22+OR+%22immigration+policy%22&hl=en-US&gl=US&ceid=US:en',
    'Google News Immigration',
  ],
  [
    'https://news.google.com/rss/search?q=%22USCIS%22+%22visa+bulletin%22&hl=en-US&gl=US&ceid=US:en',
    'Google News USCIS',
  ],
  [
    'https://news.google.com/rss/search?q=%22green+card%22+%22United+States%22+immigration&hl=en-US&gl=US&ceid=US:en',
    'Google News Green Card',
  ],
  [
    'https://news.google.com/rss/search?q=%22I-485%22+OR+%22adjustment+of+status%22+immigration&hl=en-US&gl=US&ceid=US:en',
    'Google News AOS',
  ],
  [
    'https://news.google.com/rss/search?q=%22EB-1A%22+OR+%22EB1A%22+immigration&hl=en-US&gl=US&ceid=US:en',
    'Google News EB-1A',
  ],
];

const IMMIGRATION_DIRECT_ARTICLES = [
  {
    title: 'New Dashboard Reveals Insights Into USCIS Backlogs and Processing Trends',
    link: 'https://www.americanimmigrationcouncil.org/blog/uscis-backlogs-processing-trends-dashboard/',
    source: 'American Immigration Council',
    author: 'Karen Aho',
    date: '2026-04-29',
    desc: 'USCIS backlog data from FY2016 through FY2025 shows pending cases rising and denial rates remaining elevated across major form types.',
  },
  {
    title:
      'USCIS lifts processing freeze on foreign-trained physicians and other paused case types',
    link: 'https://www.visahq.com/news/2026-05-05/us/uscis-lifts-processing-freeze-on-foreign-trained-physicians-and-other-paused-case-types/',
    source: 'VisaHQ',
    author: 'American Visas & Immigration Team',
    date: '2026-05-05',
    desc: 'USCIS removed foreign medical doctors and several case categories from a national-security review freeze, allowing affected visa and green-card cases to move again.',
  },
  {
    title: 'USCIS Shifts to Final Action Dates for Employment-Based Filings',
    link: 'https://ogletree.com/insights-resources/blog-posts/uscis-shifts-to-final-action-dates-for-employment-based-filings/',
    source: 'Ogletree',
    author: 'Geeta M. Shah',
    date: '2026-04-20',
    desc: 'USCIS said May 2026 employment-based adjustment-of-status filings must use the Final Action Dates chart, not the more favorable Dates for Filing chart.',
    body: 'USCIS confirmed that May 2026 employment-based adjustment applicants must use Final Action Dates instead of Dates for Filing. That narrows filing eligibility for workers and employers who were relying on the broader April filing chart. The change affects whether an employee can file Form I-485, employment authorization, and advance parole in May. Employers should compare priority dates against Chart A before treating a case as file-ready. The business risk is missing a near-term filing window if the category remains constrained or retrogresses again later in the fiscal year.',
  },
  {
    title: 'May 2026 Visa Bulletin',
    link: 'https://www.fragomen.com/insights/may-2026-visa-bulletin-or-mobilityminute.html',
    source: 'Fragomen',
    author: 'PRIVATE_NAME Vasquez-Myers',
    date: '2026-04-24',
    desc: 'The May 2026 Visa Bulletin pauses forward movement for employment-based categories, keeps most family-based movement advancing, and warns of potential retrogression.',
    body: 'The May 2026 Visa Bulletin shows limited movement in employment-based categories after earlier advances. USCIS requires employment-based adjustment applicants to use the Final Action Dates chart for May filings. Family-sponsored categories show more movement than employment-based categories, especially F2A. The practical effect is a narrower filing window for many workers who could file under the April Dates for Filing chart. The bulletin also warns that demand can force retrogression if visa-number use rises late in the fiscal year.',
  },
  {
    title: 'Envoy: May 2026 Visa Bulletin confirms Final Action Dates for employment-based filings',
    link: 'https://www.envoyglobal.com/news-alert/may-2026-visa-bulletin/',
    source: 'Envoy Global',
    author: '',
    date: '2026-04-14',
    desc: 'USCIS confirmed employment-based applicants must use the Final Action Dates chart for May 2026, affecting I-485 filing eligibility by priority date.',
    body: 'The May 2026 Visa Bulletin confirms that employment-based applicants must use Final Action Dates to determine adjustment-of-status eligibility. That change matters because applicants who were eligible under the April filing chart may no longer be able to submit I-485 filings in May. Employers should review affected employees by priority date and category before the April window closes. The bulletin shows limited employment-based movement and leaves several categories constrained. The key operational risk is missed filing eligibility for workers whose priority dates are no longer current under Chart A.',
  },
  {
    title: 'US Department of State Releases May 2026 Visa Bulletin',
    link: 'https://www.morganlewis.com/pubs/2026/04/us-department-of-state-releases-may-2026-visa-bulletin',
    source: 'Morgan Lewis',
    author: '',
    date: '2026-04-30',
    desc: 'USCIS will use the Final Action Dates chart for employment-based adjustment filings in May 2026, narrowing eligibility for applicants who could file under April rules.',
    body: 'The State Department released the May 2026 Visa Bulletin with limited movement in employment-based categories. USCIS will require employment-based applicants to use Final Action Dates for adjustment filings in May. That is a material change from April for applicants who could file under the Dates for Filing chart. Employers should review every sponsored worker by category, country, and priority date before assuming a case can still move. The issue to watch is whether demand late in the fiscal year forces additional retrogression or fewer usable filing windows.',
  },
  {
    title: 'May 2026 Visa Bulletin Released: What Employers Need to Know',
    link: 'https://www.gibney.com/alerts/may-2026-visa-bulletin-released-what-employers-need-to-know/',
    source: 'Gibney',
    author: '',
    date: '2026-04-27',
    desc: 'The May 2026 Visa Bulletin keeps most employment-based categories constrained and requires employment-based adjustment applicants to use Final Action Dates.',
    body: 'The May 2026 Visa Bulletin leaves most employment-based green-card categories constrained. USCIS will not accept employment-based adjustment filings under Dates for Filing in May and will instead use Final Action Dates. That means some employees who were eligible to file in April may lose filing eligibility in May. Employers should prioritize any remaining April-ready filings and update expectations for workers waiting on adjustment, work authorization, or travel-document timing. The key watch item is whether the State Department signals further retrogression as visa-number demand builds.',
  },
  {
    title: 'USCIS Freeze on Millions of Cases as FBI NextGen Fingerprint Re-Vetting Begins',
    link: 'https://www.visahq.com/news/2026-05-07/us/uscis-freeze-on-millions-of-cases-as-fbi-nextgen-finger-print-re-vetting-begins/',
    source: 'VisaHQ',
    author: 'American Visas & Immigration Team',
    date: '2026-05-07',
    desc: 'USCIS case processing slowed after a new FBI Next Generation fingerprint re-vetting step began affecting many pending benefits.',
    body: 'USCIS cases appear to be paused while officers resubmit fingerprints for renewed FBI Next Generation background checks. The reported hold affects pending adjustment-of-status, naturalization, asylum, refugee, work-permit, and travel-document cases. Lawyers say the policy began around April 27 and can delay approvals until the new screening clears. Employers with sponsored workers need to identify employees whose work authorization, travel permission, or green-card stages could expire during the pause. Applicants should watch for Requests for Evidence, interview notices, or status updates before assuming the case is abandoned.',
  },
  {
    title: 'USCIS Vetting Hold Starts April 27, AILA Alert Says Fingerprints Must Be Resubmitted',
    link: 'https://www.visaverge.com/uscis/uscis-vetting-hold-starts-april-27-2026-aila-alert-says-fingerprints-must-be-resubmitted/',
    source: 'VisaVerge',
    author: '',
    date: '2026-05-04',
    desc: 'Immigration lawyers reported new USCIS vetting delays tied to resubmitted fingerprints and enhanced FBI security checks.',
    body: 'USCIS cases appear to be moving slower after a new vetting hold began on April 27, 2026. Lawyers report that pending applications are being paused while officers resubmit fingerprints for renewed FBI security checks. The hold intersects with broader screening changes, including tighter biometric policies and shorter validity periods for some employment authorization documents. Applicants may receive a Request for Evidence, an interview notice, or no movement until background checks clear. The most exposed cases are those where work authorization, travel permission, or adjustment timing depends on predictable processing.',
  },
  {
    title: 'May 2026 Visa Bulletin: EB-5 Final Action Dates Show Minimal Advancement',
    link: 'https://www.bal.com/immigration-news/may-2026-visa-bulletin-eb-5-visa-final-action-dates-show-minimal-advancement/',
    source: 'BAL',
    author: '',
    date: '2026-04-18',
    desc: 'The May 2026 Visa Bulletin shows little EB-5 movement and warns that India demand could cause further retrogression or unavailability.',
    body: 'USCIS said employment-based applicants must use the Final Action Dates chart in the May Visa Bulletin. In EB-5, China advanced by only 21 days while other unreserved categories showed little movement. The State Department warned that increased Indian EB-5 demand may require retrogression or even make the category unavailable to stay within annual limits. Employers and investors should treat May as a constrained filing month rather than a broad opening. The operational issue is whether priority dates remain usable before demand closes the window further.',
  },
  {
    title: 'Judge Orders USCIS to Resume Green Card Reviews and Limits National-Security Freezes',
    link: 'https://www.visaverge.com/news/judge-orders-uscis-to-resume-green-card-reviews-limits-national-security-freezes/',
    source: 'VisaVerge',
    author: '',
    date: '2026-05-03',
    desc: 'A federal judge ordered USCIS to resume reviews for green-card applicants affected by an indefinite security-review freeze.',
    body: 'A federal judge ordered USCIS to end an indefinite freeze on 83 green-card applications held under a country-based security review policy. The ruling matters beyond those applicants because it signals legal limits on prolonged pauses in immigration adjudications. Affected categories can include employment-based adjustment of status, family-based green cards, EAD renewals, advance parole, and naturalization cases delayed after interview. USCIS has said it strengthened screening and vetting for immigration benefits, especially for people from identified high-risk countries. Applicants outside normal processing times may need service requests, congressional inquiries, Ombudsman help, or litigation if an indefinite pause continues.',
  },
  {
    title:
      'May 2026 Visa Bulletin: USCIS Switches to Final Action Dates Causing EB Filing Retrogression',
    link: 'https://cilawgroup.com/news/2026/04/15/may-2026-visa-bulletin-uscis-shifts-to-final-action-dates-causing-eb-filing-retrogression/',
    source: 'Capitol Immigration Law Group',
    author: '',
    date: '2026-04-15',
    desc: 'USCIS use of Final Action Dates in May narrows employment-based green-card filing eligibility after April’s broader filing window.',
    body: 'The May 2026 Visa Bulletin shows little movement across employment-based categories while several family-sponsored categories advance. USCIS will use the Final Action Dates chart for employment-based adjustment filings in May. That creates filing retrogression for applicants who were eligible under April’s Dates for Filing chart but are not current under May’s Chart A. The immediate action item is to identify applicants who can still file before the April window closes. The broader risk is that late-fiscal-year demand may keep employment categories constrained or force additional retrogression.',
  },
];

// Per-section FREE discovery ladder. When a section can't reach its target
// from the curated feeds, it climbs these free-only tiers (no paid news API):
// extra Google News search RSS, Hacker News / arXiv (tech), and the GDELT DOC
// API. The only genuinely terminal condition is the open internet being
// unreachable -- never a "thin day" defect when more free sources exist.
// 2026-06-09 ExampleCo: "there are thousands of news sources. It should go out and
// find more." All sources here are free.
const DISCOVERY = {
  'AI & TECH NEWS': {
    gdelt:
      '(artificial intelligence OR "AI model" OR OpenAI OR Anthropic OR semiconductor OR chip) sourcelang:english',
    feeds: [
      ['https://hnrss.org/frontpage?points=100', 'Hacker News'],
      ['https://export.arxiv.org/rss/cs.AI', 'arXiv cs.AI'],
      [
        'https://news.google.com/rss/search?q=artificial+intelligence+OR+AI+startup+OR+LLM+OR+chips&hl=en-US&gl=US&ceid=US:en',
        'Google News AI Search',
      ],
    ],
  },
  'US NEWS': {
    gdelt: 'sourcecountry:US (politics OR congress OR "white house" OR economy OR election)',
    feeds: [
      [
        'https://news.google.com/rss/search?q=US+politics+OR+congress+OR+economy&hl=en-US&gl=US&ceid=US:en',
        'Google News US Search',
      ],
      ['https://feeds.npr.org/1001/rss.xml', 'NPR News'],
    ],
  },
  'WORLD NEWS': {
    gdelt: '(world OR international OR global) sourcelang:english',
    feeds: [
      [
        'https://news.google.com/rss/search?q=world+news+OR+international&hl=en-US&gl=US&ceid=US:en',
        'Google News World Search',
      ],
      ['https://www.aljazeera.com/xml/rss/all.xml', 'Al Jazeera'],
    ],
  },
  'US IMMIGRATION NEWS': {
    gdelt: '(immigration OR USCIS OR "green card" OR visa OR "work permit") sourcecountry:US',
    feeds: [
      [
        'https://news.google.com/rss/search?q=immigration+policy+OR+USCIS+OR+visa+bulletin+OR+green+card&hl=en-US&gl=US&ceid=US:en',
        'Google News Immigration Search',
      ],
    ],
  },
  'MORTGAGE INDUSTRY NEWS': {
    gdelt:
      '(mortgage OR "housing market" OR "home prices" OR refinance OR homebuyer) sourcecountry:US',
    feeds: [
      [
        'https://news.google.com/rss/search?q=mortgage+industry+OR+housing+market+OR+mortgage+rates&hl=en-US&gl=US&ceid=US:en',
        'Google News Mortgage Search',
      ],
    ],
  },
};

async function gatherSection(feeds, target = 10, extraCandidates = [], discover = null, opts = {}) {
  const summarize = typeof opts.summarize === 'function' ? opts.summarize : summarizeArticle;
  const all = [...extraCandidates];
  for (const [url, name] of feeds) {
    const items = await fetchFeed(url, name);
    all.push(...items);
  }
  const candidates = capPerSource(dedup(all, 80), 3);
  console.log(
    `[news-refresh] ${candidates.length} candidates after dedupe + per-source cap (max 3)`,
  );
  const articles = [];
  const summaries = [];
  const seenLinks = new Set();
  const okCount = () => summaries.filter(Boolean).length;
  // Process candidates in parallel batches so a section completes in roughly
  // (slowest call in each batch), not (sum of all calls). See concurrency notes
  // re: NEWS_REFRESH_CONCURRENCY thrash at high fan-out.
  const BATCH = Math.max(1, parseInt(process.env.NEWS_REFRESH_CONCURRENCY || '6', 10) || 6);
  async function runPass(cands, passLabel = 'base') {
    const fresh = cands.filter((c) => c && c.link && !seenLinks.has(c.link));
    for (let i = 0; i < fresh.length; i += BATCH) {
      if (okCount() >= target) break;
      const batch = fresh.slice(i, i + BATCH);
      const results = await Promise.all(batch.map((c) => summarize(c)));
      for (let j = 0; j < batch.length; j += 1) {
        if (okCount() >= target) break;
        const cand = batch[j];
        // A summary only COUNTS toward the target (and stays in the rendered
        // set) when it is a real 3-ExampleCoraph article brief. A non-compliant
        // summary (thin/headline/publisher chrome) is dropped here so the next
        // queue/discovery candidate fills the slot instead of leaving a bad row.
        const s = isUsableSectionSummary(results[j], cand) ? results[j] : null;
        seenLinks.add(cand.link);
        articles.push(cand);
        summaries.push(s);
        console.log(
          `  [${passLabel} ${articles.length}] ${cand.title.slice(0, 60)} -> ${s ? 'OK' : 'skip'} (have ${okCount()}/${target})`,
        );
      }
    }
  }
  await runPass(candidates, 'base');
  // FREE discovery ladder: still short -> go find more free sources rather than
  // ship a thin section. Pull extra Google News search / HN / arXiv feeds and
  // the GDELT DOC API, dedup against what we already tried, summarize the new
  // ones until target. No paid API, ever.
  if (okCount() < target && discover) {
    console.log(
      `[news-refresh] section short (${okCount()}/${target}); climbing FREE discovery ladder`,
    );
    const more = [];
    for (const [url, name] of discover.feeds || []) more.push(...(await fetchFeed(url, name)));
    if (discover.gdelt) more.push(...(await fetchGdelt(discover.gdelt, 'GDELT')));
    const freshDiscovered = capPerSource(dedup(more, 80), 3);
    console.log(
      `[news-refresh] discovery surfaced ${freshDiscovered.length} additional free candidates`,
    );
    await runPass(freshDiscovered, 'discover');
  }
  const filtered = articles
    .map((a, i) => (summaries[i] ? { a, s: summaries[i] } : null))
    .filter(Boolean)
    .slice(0, target);
  return filtered.map((p, i) => formatArticle(p.a, i, p.s));
}

function replaceSectionInBriefing(md, sectionLabel, newBody) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    new RegExp(`^${sectionLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(line),
  );
  if (start < 0) {
    console.warn(`[news-refresh] section not found: ${sectionLabel}`);
    return md;
  }
  const sectionNames = [
    'AI & TECH NEWS',
    'US NEWS',
    'WORLD NEWS',
    'US IMMIGRATION NEWS',
    'ON' + 'ITY GROUP NEWS',
    'MORTGAGE INDUSTRY NEWS',
    'MORTGAGE RATE INDEXES',
  ];
  const escapedNames = sectionNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const sectionHeaderRe = new RegExp(`^(${escapedNames.join('|')})\\b`);
  const sameSectionRe = new RegExp(`^${sectionLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (
      /^---\s*$/.test(lines[i]) &&
      lines.slice(i + 1).some((line) => sectionHeaderRe.test(line))
    ) {
      end = i;
      break;
    }
    if (sectionHeaderRe.test(lines[i]) && !sameSectionRe.test(lines[i])) {
      end = i;
      break;
    }
  }
  const count = newBody.split(/^\d+\.\s/m).length - 1;
  const replacement = `${sectionLabel} (${count}):\n\n${newBody}`.split(/\r?\n/);
  return [...lines.slice(0, start), ...replacement, '', ...lines.slice(end)].join('\n');
}

// Select which news sections to refresh. Empty/absent filter => all sections.
// A non-empty filter keeps only sections whose label contains it
// (case-insensitive substring), so the heal path can target one broken section
// (e.g. NEWS_REFRESH_ONLY="IMMIGRATION") without re-summarizing the good ones.
function selectNewsSections(specs, onlyFilter) {
  const f = String(onlyFilter || '')
    .trim()
    .toLowerCase();
  if (!f) return specs;
  return specs.filter((s) =>
    String(s.label || '')
      .toLowerCase()
      .includes(f),
  );
}

async function main() {
  const date = runDate();
  const briefingPath = path.join(BRIEFING_DIR, `briefing-${date}.md`);
  if (!fs.existsSync(briefingPath)) {
    console.error(`[news-refresh] briefing not found: ${briefingPath}`);
    process.exit(1);
  }
  let md = fs.readFileSync(briefingPath, 'utf8');

  // Run all 5 sections concurrently. Each section already parallelizes its
  // own Claude calls inside gatherSection (concurrency 6). With sections also
  // running in parallel, total wall time is approximately the slowest
  // section, not the sum. Without this, the serial path took ~23 min in a
  // 2026-05-11 test which blew past manual-briefing-v3.js's outer timeout.
  const sectionSpecs = [
    {
      label: 'AI & TECH NEWS',
      feeds: TECH_FEEDS,
      extra: undefined,
      discover: DISCOVERY['AI & TECH NEWS'],
    },
    { label: 'US NEWS', feeds: US_FEEDS, extra: undefined, discover: DISCOVERY['US NEWS'] },
    {
      label: 'WORLD NEWS',
      feeds: WORLD_FEEDS,
      extra: undefined,
      discover: DISCOVERY['WORLD NEWS'],
    },
    {
      label: 'US IMMIGRATION NEWS',
      feeds: IMMIGRATION_FEEDS,
      extra: IMMIGRATION_DIRECT_ARTICLES,
      discover: DISCOVERY['US IMMIGRATION NEWS'],
    },
    {
      label: 'MORTGAGE INDUSTRY NEWS',
      feeds: MORTGAGE_FEEDS,
      extra: undefined,
      discover: DISCOVERY['MORTGAGE INDUSTRY NEWS'],
    },
  ];
  // Default: all 5 sections in parallel (each gatherSection runs BATCH=6
  // internally => up to 30 concurrent Claude CLI spawns). That 30-wide burst
  // saturates the single Max-plan rate limit, so individual in-budget calls
  // queue past the 120s kill timer and die, leaving sections under target even
  // with zero sibling sessions (observed 2026-06-01: US NEWS 2/10, AI&TECH
  // 8/10). Serial mode caps peak concurrency at one section's batch (6) so each
  // call gets rate-limit headroom; it trades wall time for reliability and is
  // used by the off-cycle heal path that is not bounded by the briefing's outer
  // 7-minute timeout. Gate via NEWS_REFRESH_SERIAL=1.
  const serial = process.env.NEWS_REFRESH_SERIAL === '1';
  const perSectionConcurrency = Math.max(
    1,
    parseInt(process.env.NEWS_REFRESH_CONCURRENCY || '6', 10) || 6,
  );
  // NEWS_REFRESH_ONLY heals a single broken section without re-summarizing the
  // sections that already hold 10/10. Re-running every section risks a
  // currently-good one falling short on a Claude timeout and either throwing
  // (losing the work) or, with --write-partial, overwriting good content with
  // fewer articles (2026-06-04: US NEWS dropped 10->6 on a heal run while only
  // immigration was actually broken). Matches by case-insensitive label
  // substring (e.g. "IMMIGRATION").
  const onlyFilter = String(process.env.NEWS_REFRESH_ONLY || '').trim();
  const activeSpecs = selectNewsSections(sectionSpecs, onlyFilter);
  if (onlyFilter && activeSpecs.length === 0) {
    throw new Error(
      `NEWS_REFRESH_ONLY="${onlyFilter}" matched no section (labels: ${sectionSpecs.map((s) => s.label).join(', ')})`,
    );
  }
  console.log(
    `[news-refresh] regenerating ${activeSpecs.length} news section(s)${onlyFilter ? ` [only: ${activeSpecs.map((s) => s.label).join(', ')}]` : ''} ${serial ? `serially (peak ${perSectionConcurrency} concurrent)` : `in parallel (peak ~${perSectionConcurrency * activeSpecs.length} concurrent)`}`,
  );
  let results;
  if (serial) {
    results = [];
    for (const spec of activeSpecs) {
      const articles = await gatherSection(spec.feeds, 10, spec.extra || [], spec.discover || null);
      console.log(`[news-refresh] ${spec.label}: ${articles.length}/10 (serial)`);
      results.push({ label: spec.label, articles });
    }
  } else {
    results = await Promise.all(
      activeSpecs.map(async (spec) => {
        const articles = await gatherSection(
          spec.feeds,
          10,
          spec.extra || [],
          spec.discover || null,
        );
        return { label: spec.label, articles };
      }),
    );
  }
  const failures = results.filter((r) => r.articles.length !== 10);
  const writePartial = process.argv.includes('--write-partial');
  if (failures.length > 0 && !writePartial) {
    throw new Error(
      'sections under target: ' +
        failures.map((f) => `${f.label}=${f.articles.length}/10`).join(', '),
    );
  }
  if (failures.length > 0 && writePartial) {
    console.warn(
      '[news-refresh] WRITE-PARTIAL: sections under target, writing what we have: ' +
        failures.map((f) => `${f.label}=${f.articles.length}/10`).join(', '),
    );
  }
  for (const r of results) {
    if (r.articles.length === 0) {
      console.warn(`[news-refresh] ${r.label}: 0 articles, leaving section untouched`);
      continue;
    }
    md = replaceSectionInBriefing(md, r.label, r.articles.join('\n'));
    console.log(`[news-refresh] ${r.label}: ${r.articles.length} articles`);
  }

  fs.writeFileSync(briefingPath, md);
  console.log(`[news-refresh] wrote ${briefingPath}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[news-refresh] failed:', e);
    process.exit(1);
  });
}

module.exports = {
  capPerSource,
  dedup,
  TECH_FEEDS,
  CLAUDE_SUMMARIZE_TIMEOUT_MS,
  selectNewsSections,
  parseBedrockOut,
  BEDROCK_MODEL_ID,
  gatherSection,
  isUsableSectionSummary,
};
