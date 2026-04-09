// briefing.ts
// Daily morning briefing generator — news, pending videos, Amy call activity, channel stats.
// Delivers via Telegram. Called by the scheduler at 5:30 AM CT.
//
// Format:
//   1. Good morning + date + AI/TECH NEWS (10 articles)
//   2. WORLD NEWS (10 articles)
//   3. ONITY GROUP NEWS (up to 2 articles) + MORTGAGE INDUSTRY NEWS (up to 3 articles)
//   4. Contact Intelligence + Reputation + Videos + Amy calls + LinkedIn (Saturdays)
//
// Dedup: articles are keyed by URL + title prefix. Onity and Mortgage are deduped
//        against AI/World and against each other.
//
// Sent as multiple messages if total length exceeds 3800 chars.

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { app } from 'electron';
import { getConfig } from './config';
import { sendMessage } from './telegram';
import { generateSermonBriefingSection } from './sermons';
import { buildContactIntelSection, markContactEventsReported } from './linkedin-intel';
import { listCallRecords } from './calls';
import { runClaudeCode } from './claude-runner';

// ── Types ─────────────────────────────────────────────────────────────────────

interface NewsArticle {
  title: string;
  author?: string;
  publishedAt?: string; // YYYY-MM-DD
  url?: string;
  description?: string;
  source?: string;
}

interface VideoManifestEntry {
  title?: string;
  channel?: string;
  status?: string;
  video_file?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function flagPath(name: string): string {
  return path.join(app.getPath('userData'), `${name}-${todayStamp()}.flag`);
}

function flagExists(name: string): boolean {
  return fs.existsSync(flagPath(name));
}

function writeFlag(name: string): void {
  fs.writeFileSync(flagPath(name), todayStamp(), 'utf-8');
}

function friendlyDate(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Chicago',
  });
}

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'SecondBrain/1.0' } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      })
      .on('error', reject);
  });
}

/** Split a long message into ≤3800-char chunks at paragraph boundaries. */
function splitMessage(text: string, maxLen = 3800): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  const paragraphs = text.split('\n\n');
  let current = '';
  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxLen && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** Send one or more Telegram messages, splitting if over 3800 chars. */
async function sendTelegramSplit(chatId: string, text: string): Promise<void> {
  const parts = splitMessage(text);
  for (const part of parts) {
    await sendMessage(chatId, part);
  }
}

// ── RSS parser — extracts title, link, author, pubDate from items ─────────────

interface RssItem {
  title: string;
  link?: string;
  author?: string;
  pubDate?: string;
  description?: string;
}

function parseRssItems(xml: string, max = 10): RssItem[] {
  const items: RssItem[] = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let itemMatch: RegExpExecArray | null;

  while ((itemMatch = itemRegex.exec(xml)) !== null && items.length < max) {
    const block = itemMatch[1];

    const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/is)?.[1] ?? '')
      .trim()
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    if (!title || title.length < 10) continue;

    const link =
      block.match(/<link[^>]*>(.*?)<\/link>/is)?.[1]?.trim() ||
      block.match(/href="([^"]+)"/)?.[1]?.trim();

    const author =
      block
        .match(/<dc:creator[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/dc:creator>/is)?.[1]
        ?.trim() || block.match(/<author[^>]*>(.*?)<\/author>/is)?.[1]?.trim();

    const pubDate = block.match(/<pubDate[^>]*>(.*?)<\/pubDate>/is)?.[1]?.trim();

    const description = (
      block.match(/<description[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/is)?.[1] ?? ''
    )
      .replace(/<[^>]+>/g, '')
      .trim()
      .slice(0, 300);

    // Parse pubDate to YYYY-MM-DD
    let dateStr: string | undefined;
    if (pubDate) {
      try {
        dateStr = new Date(pubDate).toISOString().slice(0, 10);
      } catch {
        /* ignore */
      }
    }

    items.push({ title, link, author, pubDate: dateStr, description });
  }
  return items;
}

// ── News fetch — World ────────────────────────────────────────────────────────

async function fetchWorldNewsArticles(): Promise<NewsArticle[]> {
  const cfg = getConfig();

  if (cfg.newsApiKey) {
    try {
      const url = `https://newsapi.org/v2/top-headlines?country=us&pageSize=10&apiKey=${cfg.newsApiKey}`;
      const raw = await fetchUrl(url);
      const data = JSON.parse(raw) as {
        articles: Array<{
          title: string;
          author?: string;
          publishedAt?: string;
          url?: string;
          description?: string;
          source?: { name?: string };
        }>;
      };
      if (data.articles?.length) {
        return data.articles.slice(0, 10).map((a) => ({
          title: a.title,
          author: a.author || a.source?.name,
          publishedAt: a.publishedAt?.slice(0, 10),
          url: a.url,
          description: a.description ?? undefined,
          source: a.source?.name,
        }));
      }
    } catch (err) {
      console.warn('[briefing] NewsAPI world failed, falling back to RSS:', (err as Error).message);
    }
  }

  // RSS fallback — BBC
  try {
    const xml = await fetchUrl('https://feeds.bbci.co.uk/news/rss.xml');
    const items = parseRssItems(xml, 10);
    if (items.length > 0)
      return items.map((i) => ({
        title: i.title,
        author: i.author,
        publishedAt: i.pubDate,
        url: i.link,
        description: i.description,
        source: 'BBC News',
      }));
  } catch {
    /* continue */
  }

  // Last resort — AP News
  try {
    const xml = await fetchUrl('https://rsshub.app/apnews/topics/apf-topnews');
    const items = parseRssItems(xml, 10);
    return items.map((i) => ({
      title: i.title,
      author: i.author,
      publishedAt: i.pubDate,
      url: i.link,
      description: i.description,
      source: 'AP News',
    }));
  } catch {
    return [];
  }
}

// ── News fetch — AI / Tech ────────────────────────────────────────────────────

async function fetchAITechArticles(): Promise<NewsArticle[]> {
  const cfg = getConfig();

  // NewsAPI everything — AI/tech query
  if (cfg.newsApiKey) {
    try {
      const query = encodeURIComponent('artificial intelligence OR AI OR ChatGPT OR LLM OR OpenAI');
      const url = `https://newsapi.org/v2/everything?q=${query}&sortBy=publishedAt&pageSize=10&language=en&apiKey=${cfg.newsApiKey}`;
      const raw = await fetchUrl(url);
      const data = JSON.parse(raw) as {
        articles: Array<{
          title: string;
          author?: string;
          publishedAt?: string;
          url?: string;
          description?: string;
          source?: { name?: string };
        }>;
      };
      if (data.articles?.length) {
        return data.articles.slice(0, 10).map((a) => ({
          title: a.title,
          author: a.author || a.source?.name,
          publishedAt: a.publishedAt?.slice(0, 10),
          url: a.url,
          description: a.description ?? undefined,
          source: a.source?.name,
        }));
      }
    } catch (err) {
      console.warn(
        '[briefing] NewsAPI AI/tech failed, falling back to RSS:',
        (err as Error).message,
      );
    }
  }

  // RSS fallback — TechCrunch + Ars Technica
  const feeds = [
    { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', source: 'TechCrunch' },
    { url: 'https://arstechnica.com/feed/', source: 'Ars Technica' },
    { url: 'https://techcrunch.com/feed/', source: 'TechCrunch' },
  ];

  const seen = new Set<string>();
  const articles: NewsArticle[] = [];

  for (const feed of feeds) {
    if (articles.length >= 10) break;
    try {
      const xml = await fetchUrl(feed.url);
      for (const item of parseRssItems(xml, 10)) {
        const key = item.title.toLowerCase().slice(0, 40);
        if (!seen.has(key) && articles.length < 10) {
          seen.add(key);
          articles.push({
            title: item.title,
            author: item.author,
            publishedAt: item.pubDate,
            url: item.link,
            description: item.description,
            source: feed.source,
          });
        }
      }
    } catch {
      /* skip */
    }
  }
  return articles;
}

// ── Per-article summarization via Claude (Max plan, free) ────────────────────
// Uses claude-runner.ts (claude -p CLI) — zero marginal cost on Max plan.
// Falls back to plain list if claude is unavailable.

async function summarizeArticlesWithGroq(
  articles: NewsArticle[],
  sectionLabel: string,
): Promise<string> {
  if (!articles.length) return `${sectionLabel}: no articles available`;

  const articleBlocks = articles
    .map((a, i) => {
      return [
        `--- ARTICLE ${i + 1} ---`,
        `Title: ${a.title}`,
        a.source ? `Source: ${a.source}` : '',
        a.author ? `Author: ${a.author}` : '',
        a.publishedAt ? `Date: ${a.publishedAt}` : '',
        a.url ? `URL: ${a.url}` : '',
        a.description ? `Description: ${a.description}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  const prompt =
    `You are a news briefing writer for an executive. Summarize each article in exactly 2-3 sentences. ` +
    `Be specific, factual, and mention key names and numbers. ` +
    `Format each article as:\n**[Article Title]**\n[2-3 sentence summary]\nSource: [Source] | [Date] | By [Author]\n[URL]\n\n` +
    `Summarize these ${articles.length} articles:\n\n${articleBlocks}`;

  try {
    const { output, success } = await runClaudeCode(prompt, { timeoutMs: 60000 });
    if (success && output.trim()) return output.trim();
    console.warn('[briefing] claude-runner summarization failed — using plain list');
  } catch (err) {
    console.warn('[briefing] claude-runner error:', (err as Error).message);
  }

  // Claude unavailable — plain fallback
  return articles
    .map((a) => {
      const citation = [a.source, a.publishedAt, a.author ? `By ${a.author}` : '']
        .filter(Boolean)
        .join(' | ');
      return `**${a.title}**\n${a.description || ''}\n${citation}${a.url ? '\n' + a.url : ''}`;
    })
    .join('\n\n');
}

// ── Dedup helper — key = url || title-prefix ─────────────────────────────────

function articleKey(a: NewsArticle): string {
  return (a.url || a.title.toLowerCase().slice(0, 50)).trim();
}

function deduplicateAgainst(
  articles: NewsArticle[],
  seen: Set<string>,
  limit: number,
): NewsArticle[] {
  const result: NewsArticle[] = [];
  for (const a of articles) {
    if (result.length >= limit) break;
    const key = articleKey(a);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(a);
    }
  }
  return result;
}

// ── News fetch — Onity Group Inc. ─────────────────────────────────────────────

async function fetchOnityArticles(): Promise<NewsArticle[]> {
  const cfg = getConfig();

  if (cfg.newsApiKey) {
    try {
      const query = encodeURIComponent('"Onity Group" OR "Onity Group Inc"');
      const url = `https://newsapi.org/v2/everything?q=${query}&sortBy=publishedAt&pageSize=5&language=en&apiKey=${cfg.newsApiKey}`;
      const raw = await fetchUrl(url);
      const data = JSON.parse(raw) as {
        articles: Array<{
          title: string;
          author?: string;
          publishedAt?: string;
          url?: string;
          description?: string;
          source?: { name?: string };
        }>;
      };
      if (data.articles?.length) {
        return data.articles.slice(0, 5).map((a) => ({
          title: a.title,
          author: a.author || a.source?.name,
          publishedAt: a.publishedAt?.slice(0, 10),
          url: a.url,
          description: a.description ?? undefined,
          source: a.source?.name,
        }));
      }
    } catch (err) {
      console.warn(
        '[briefing] NewsAPI Onity failed, trying Google News RSS:',
        (err as Error).message,
      );
    }
  }

  // RSS fallback — Google News search for Onity Group
  try {
    const query = encodeURIComponent('Onity Group Inc');
    const xml = await fetchUrl(
      `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`,
    );
    const items = parseRssItems(xml, 5);
    return items.map((i) => ({
      title: i.title,
      author: i.author,
      publishedAt: i.pubDate,
      url: i.link,
      description: i.description,
      source: 'Google News',
    }));
  } catch {
    return [];
  }
}

// ── News fetch — Mortgage Industry ───────────────────────────────────────────

async function fetchMortgageArticles(): Promise<NewsArticle[]> {
  const cfg = getConfig();

  if (cfg.newsApiKey) {
    try {
      const query = encodeURIComponent(
        'mortgage rates OR "mortgage servicing" OR "mortgage origination" OR FHFA OR "Fannie Mae" OR "Freddie Mac" OR "MBA mortgage" OR "housing market" OR "mortgage industry"',
      );
      const url = `https://newsapi.org/v2/everything?q=${query}&sortBy=publishedAt&pageSize=10&language=en&apiKey=${cfg.newsApiKey}`;
      const raw = await fetchUrl(url);
      const data = JSON.parse(raw) as {
        articles: Array<{
          title: string;
          author?: string;
          publishedAt?: string;
          url?: string;
          description?: string;
          source?: { name?: string };
        }>;
      };
      if (data.articles?.length) {
        return data.articles.slice(0, 10).map((a) => ({
          title: a.title,
          author: a.author || a.source?.name,
          publishedAt: a.publishedAt?.slice(0, 10),
          url: a.url,
          description: a.description ?? undefined,
          source: a.source?.name,
        }));
      }
    } catch (err) {
      console.warn(
        '[briefing] NewsAPI mortgage failed, falling back to RSS:',
        (err as Error).message,
      );
    }
  }

  // RSS fallback — HousingWire + Mortgage News Daily + MBA
  const feeds = [
    { url: 'https://www.housingwire.com/feed/', source: 'HousingWire' },
    { url: 'https://www.mortgagenewsdaily.com/rss/news', source: 'Mortgage News Daily' },
    {
      url: 'https://news.google.com/rss/search?q=mortgage+rates+OR+mortgage+servicing+OR+FHFA&hl=en-US&gl=US&ceid=US:en',
      source: 'Google News',
    },
  ];

  const seen = new Set<string>();
  const articles: NewsArticle[] = [];

  for (const feed of feeds) {
    if (articles.length >= 10) break;
    try {
      const xml = await fetchUrl(feed.url);
      for (const item of parseRssItems(xml, 10)) {
        const key = item.title.toLowerCase().slice(0, 50);
        if (!seen.has(key) && articles.length < 10) {
          seen.add(key);
          articles.push({
            title: item.title,
            author: item.author,
            publishedAt: item.pubDate,
            url: item.link,
            description: item.description,
            source: feed.source,
          });
        }
      }
    } catch {
      /* skip */
    }
  }
  return articles;
}

// ── Reputation monitoring ─────────────────────────────────────────────────────

async function fetchReputationMentions(): Promise<string[]> {
  try {
    const config = getConfig();
    const keywords = (config as unknown as Record<string, string>).reputationKeywords;
    if (!keywords) return [];

    const query = encodeURIComponent(keywords);
    const xml = await fetchUrl(
      `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`,
    );
    const items = parseRssItems(xml, 3);
    return items.map((i) => i.title).slice(0, 3);
  } catch {
    return [];
  }
}

// ── Pending videos ────────────────────────────────────────────────────────────

function loadPendingVideos(): VideoManifestEntry[] {
  // Read from the repo's content-review/pending/manifest.json (actual rendered videos).
  // The userData pipeline manifest only contains scheduled templates without real video files.
  const repoManifestPath = path.join(
    app.getAppPath(),
    'content-review',
    'pending',
    'manifest.json',
  );
  const manifestPath = fs.existsSync(repoManifestPath)
    ? repoManifestPath
    : path.join(app.getPath('userData'), 'content-review', 'pending', 'manifest.json');

  if (!fs.existsSync(manifestPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    // Handle both flat array and { videos: [...] } formats
    const entries: VideoManifestEntry[] = Array.isArray(raw)
      ? raw
      : Array.isArray(raw.videos)
        ? raw.videos
        : [];
    const pendingDir = path.dirname(manifestPath);
    return entries.filter((e) => {
      if (e.status !== 'pending_approval') return false;
      if (!e.video_file) return false;
      return fs.existsSync(path.join(pendingDir, e.video_file));
    });
  } catch {
    return [];
  }
}

// ── Recent inbound calls to Amy ───────────────────────────────────────────────

interface AmyInboundCall {
  phoneNumber: string;
  createdAt: string;
  summary?: string;
  transcript?: string;
  completed?: boolean;
  durationSeconds?: number;
}

function loadRecentInboundCalls(limit = 5): AmyInboundCall[] {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return listCallRecords()
      .filter((r) => r.isCallback === true && r.createdAt >= since)
      .slice(0, limit)
      .map((r) => ({
        phoneNumber: r.phoneNumber,
        createdAt: r.createdAt,
        summary: r.summary,
        transcript: r.transcript?.slice(0, 200),
        completed: r.completed,
        durationSeconds: r.durationSeconds,
      }));
  } catch {
    return [];
  }
}

// ── Contact Intelligence — delegated to linkedin-intel.ts ────────────────────
// buildContactIntelSection() reads linkedin-intel.json (written by the nightly
// crawl at midnight) and returns ranked events for the past 7 days + 48 hours.

// ── Public API ────────────────────────────────────────────────────────────────

export async function sendDailyBriefing(): Promise<void> {
  const FLAG = 'briefing-sent';

  if (flagExists(FLAG)) {
    console.log('[briefing] daily briefing already sent today — skipping');
    return;
  }

  const cfg = getConfig();
  if (!cfg.telegramBotToken || !cfg.telegramChatId) {
    console.warn('[briefing] Telegram not configured — skipping daily briefing');
    return;
  }

  const [
    aiArticlesRaw,
    worldArticlesRaw,
    onityArticlesRaw,
    mortgageArticlesRaw,
    pendingVideos,
    inboundCalls,
    mentions,
  ] = await Promise.all([
    fetchAITechArticles(),
    fetchWorldNewsArticles(),
    fetchOnityArticles(),
    fetchMortgageArticles(),
    Promise.resolve(loadPendingVideos()),
    Promise.resolve(loadRecentInboundCalls()),
    fetchReputationMentions(),
  ]);

  // Build a dedup set from AI + World articles, then filter Onity and Mortgage
  const globalSeen = new Set<string>([
    ...aiArticlesRaw.map(articleKey),
    ...worldArticlesRaw.map(articleKey),
  ]);

  const onityArticles = deduplicateAgainst(onityArticlesRaw, globalSeen, 2);
  const mortgageArticles = deduplicateAgainst(mortgageArticlesRaw, globalSeen, 3);

  const [aiSummary, worldSummary, onitySummary, mortgageSummary] = await Promise.all([
    summarizeArticlesWithGroq(aiArticlesRaw, 'AI/TECH NEWS'),
    summarizeArticlesWithGroq(worldArticlesRaw, 'WORLD NEWS'),
    onityArticles.length > 0
      ? summarizeArticlesWithGroq(onityArticles, 'ONITY GROUP NEWS')
      : Promise.resolve(''),
    mortgageArticles.length > 0
      ? summarizeArticlesWithGroq(mortgageArticles, 'MORTGAGE INDUSTRY NEWS')
      : Promise.resolve(''),
  ]);

  // ── Message 1: Header + AI/Tech news ───────────────────────────────────────
  const msg1Lines: string[] = [];
  msg1Lines.push(`Good morning Luke — ${friendlyDate()}`);
  msg1Lines.push('');
  msg1Lines.push('AI/TECH NEWS:');
  msg1Lines.push(aiSummary);

  // ── Message 2: World news ──────────────────────────────────────────────────
  const msg2Lines: string[] = [];
  msg2Lines.push('WORLD NEWS:');
  msg2Lines.push(worldSummary);

  // ── Message 3: Onity + Mortgage industry ──────────────────────────────────
  const msg3Lines: string[] = [];
  if (onityArticles.length > 0) {
    msg3Lines.push(
      `ONITY GROUP NEWS (${onityArticles.length} article${onityArticles.length !== 1 ? 's' : ''}):`,
    );
    msg3Lines.push(onitySummary);
    msg3Lines.push('');
  } else {
    msg3Lines.push('ONITY GROUP NEWS: no articles found today');
    msg3Lines.push('');
  }

  if (mortgageArticles.length > 0) {
    msg3Lines.push(
      `MORTGAGE INDUSTRY NEWS (${mortgageArticles.length} article${mortgageArticles.length !== 1 ? 's' : ''}):`,
    );
    msg3Lines.push(mortgageSummary);
  } else {
    msg3Lines.push('MORTGAGE INDUSTRY NEWS: no articles found today');
  }

  // ── Message 4: Operational ─────────────────────────────────────────────────
  const msg4Lines: string[] = [];
  const isSaturday = new Date().getDay() === 6;

  // Contact intelligence — ranked events from linkedin-intel.json (daily)
  const { text: contactIntel, reportedIds: contactReportedIds } = buildContactIntelSection();
  if (contactIntel) {
    msg4Lines.push(contactIntel);
    msg4Lines.push('');
  }

  if (mentions.length > 0) {
    msg4Lines.push('REPUTATION MENTIONS:');
    for (const m of mentions) msg4Lines.push(`  • ${m}`);
    msg4Lines.push('');
  }

  if (pendingVideos.length === 0) {
    msg4Lines.push('Videos: no pending approvals');
  } else {
    msg4Lines.push(`Videos (${pendingVideos.length} pending approval):`);
    for (const v of pendingVideos) {
      msg4Lines.push(`  • ${v.title ?? '(untitled)'} [${v.channel ?? 'unknown channel'}]`);
    }
  }
  msg4Lines.push('');

  // Amy — inbound calls received in the last 24h
  if (inboundCalls.length === 0) {
    msg4Lines.push('Amy: no inbound calls in the last 24h');
  } else {
    msg4Lines.push(
      `Amy (${inboundCalls.length} inbound call${inboundCalls.length !== 1 ? 's' : ''} in last 24h):`,
    );
    for (const c of inboundCalls) {
      const time = new Date(c.createdAt).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/Chicago',
        hour12: true,
      });
      const dur = c.durationSeconds ? ` (${Math.round(c.durationSeconds / 60)}m)` : '';
      const status = c.completed ? '✓' : '—';
      const summary = c.summary ? ` — ${c.summary.slice(0, 80)}` : '';
      msg4Lines.push(`  ${status} ${c.phoneNumber} @ ${time}${dur}${summary}`);
    }
  }
  msg4Lines.push('');

  // LinkedIn engagement ops — Saturdays only
  if (isSaturday) {
    msg4Lines.push('LINKEDIN (weekly):');
    msg4Lines.push(
      '  Review warm network — any new job changes or published posts to engage with?',
    );
    msg4Lines.push('');
  }

  try {
    // Saturday: add sermon section before the operational block
    if (isSaturday) {
      try {
        const sermonSection = generateSermonBriefingSection();
        if (sermonSection) {
          msg4Lines.unshift(sermonSection, '');
        }
      } catch {
        /* non-critical */
      }
    }

    await sendTelegramSplit(cfg.telegramChatId, msg1Lines.join('\n'));
    await sendTelegramSplit(cfg.telegramChatId, msg2Lines.join('\n'));
    await sendTelegramSplit(cfg.telegramChatId, msg3Lines.join('\n'));
    if (msg4Lines.length > 0) {
      await sendTelegramSplit(cfg.telegramChatId, msg4Lines.join('\n'));
    }

    writeFlag(FLAG);
    console.log('[briefing] daily briefing sent successfully (4-message format)');

    // Mark contact events as reported so they won't repeat tomorrow
    if (contactReportedIds.length > 0) {
      markContactEventsReported(contactReportedIds);
    }

    // Post-send: feed Graphiti + working memory
    try {
      const { onDataIngested, briefingEvent } = await import('./ingest-hooks');
      onDataIngested(briefingEvent('daily', msg1Lines.join('\n')));
    } catch {
      /* non-critical */
    }
  } catch (err) {
    console.error(
      '[briefing] failed to send daily briefing:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ── Saturday weekly sermon briefing ──────────────────────────────────────────

export async function sendWeeklySermonBriefing(): Promise<void> {
  const FLAG = 'sermon-briefing-sent';

  if (flagExists(FLAG)) {
    console.log('[briefing] weekly sermon briefing already sent today — skipping');
    return;
  }

  const cfg = getConfig();
  if (!cfg.telegramBotToken || !cfg.telegramChatId) {
    console.warn('[briefing] Telegram not configured — skipping sermon briefing');
    return;
  }

  const sermonSection = generateSermonBriefingSection();

  const text = [
    `Weekly Sermon Briefing — ${friendlyDate()}`,
    '',
    sermonSection,
    'Book of Sermons project: actively collecting.',
  ].join('\n');

  try {
    await sendMessage(cfg.telegramChatId, text);
    writeFlag(FLAG);
    console.log('[briefing] weekly sermon briefing sent successfully');
  } catch (err) {
    console.error(
      '[briefing] failed to send sermon briefing:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
