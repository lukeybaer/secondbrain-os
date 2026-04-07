// briefing.ts
// Daily morning briefing generator — news, pending videos, call queue, channel stats.
// Delivers via Telegram. Called by the scheduler at 5:30 AM CT.
//
// Format:
//   1. Good morning + date
//   2. AI/TECH NEWS: 10 articles, per-article 2-3 sentence summaries with citation
//   3. WORLD NEWS: 10 articles, same format
//   4. Birthdays / upcoming dates (from memory files)
//   5. LinkedIn engagement ops + network moves
//   6. Relationships cooling (Mondays only)
//   7. Reputation mentions (if configured)
//   8. Videos pending approval
//   9. Calls queued
//   10. Today's focus
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
}

interface CallRecord {
  id: string;
  phoneNumber?: string;
  instructions?: string;
  status?: string;
  completed?: boolean;
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

// ── Per-article summarization via Groq ───────────────────────────────────────
// Returns a formatted multi-line string for the entire section.

async function summarizeArticlesWithGroq(
  articles: NewsArticle[],
  sectionLabel: string,
): Promise<string> {
  const cfg = getConfig();

  if (!articles.length) return `${sectionLabel}: no articles available`;

  if (!cfg.groqApiKey) {
    // No Groq — return plain list with citation
    return articles
      .map((a) => {
        const citation = [a.source, a.publishedAt, a.author ? `By ${a.author}` : '']
          .filter(Boolean)
          .join(' | ');
        return `**${a.title}**\n${a.description || '(no description available)'}\n${citation}${a.url ? '\n' + a.url : ''}`;
      })
      .join('\n\n');
  }

  // Build prompt asking Groq to summarize each article
  const articleBlocks = articles
    .map((a, i) => {
      const lines = [
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
      return lines;
    })
    .join('\n\n');

  const systemPrompt = `You are a news briefing writer for an executive. Summarize each article in exactly 2-3 sentences. Be specific, factual, and mention key names and numbers. After the summary, always include a citation line in this exact format: Source: [Source] | [Date] | By [Author or "Staff"]${'\n'}Then the URL on its own line.${'\n\n'}Format each article as:${'\n'}**[Article Title]**${'\n'}[2-3 sentence summary]${'\n'}Source: [Source] | [Date] | By [Author]${'\n'}[URL]`;

  try {
    const body = JSON.stringify({
      model: 'llama-3.1-8b-instant',
      max_tokens: 2000,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Summarize these ${articles.length} articles:\n\n${articleBlocks}`,
        },
      ],
    });

    const result = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.groqApiKey}`,
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (d: Buffer) => chunks.push(d));
          res.on('end', () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              resolve(data.choices?.[0]?.message?.content?.trim() ?? '');
            } catch {
              resolve('');
            }
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    if (result) return result;
  } catch (err) {
    console.warn('[briefing] Groq per-article summarization failed:', (err as Error).message);
  }

  // Groq failed — plain fallback
  return articles
    .map((a) => {
      const citation = [a.source, a.publishedAt, a.author ? `By ${a.author}` : '']
        .filter(Boolean)
        .join(' | ');
      return `**${a.title}**\n${a.description || ''}\n${citation}${a.url ? '\n' + a.url : ''}`;
    })
    .join('\n\n');
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
  const manifestPath = path.join(
    app.getPath('userData'),
    'content-review',
    'pending',
    'manifest.json',
  );
  if (!fs.existsSync(manifestPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const entries: VideoManifestEntry[] = Array.isArray(raw) ? raw : Object.values(raw);
    return entries.filter((e) => e.status === 'pending_approval');
  } catch {
    return [];
  }
}

// ── Queued calls ─────────────────────────────────────────────────────────────

function loadQueuedCalls(): CallRecord[] {
  const callsDir = path.join(getConfig().dataDir, 'calls');
  if (!fs.existsSync(callsDir)) return [];
  try {
    return fs
      .readdirSync(callsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(callsDir, f), 'utf-8')) as CallRecord;
        } catch {
          return null;
        }
      })
      .filter(
        (c): c is CallRecord =>
          c !== null && !!c.phoneNumber && c.status === 'queued' && !c.completed,
      );
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

  const [aiArticles, worldArticles, pendingVideos, queuedCalls, mentions] = await Promise.all([
    fetchAITechArticles(),
    fetchWorldNewsArticles(),
    Promise.resolve(loadPendingVideos()),
    Promise.resolve(loadQueuedCalls()),
    fetchReputationMentions(),
  ]);

  const [aiSummary, worldSummary] = await Promise.all([
    summarizeArticlesWithGroq(aiArticles, 'AI/TECH NEWS'),
    summarizeArticlesWithGroq(worldArticles, 'WORLD NEWS'),
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

  // ── Message 3: Operational ─────────────────────────────────────────────────
  const msg3Lines: string[] = [];

  // Contact intelligence — ranked events from linkedin-intel.json
  const { text: contactIntel, reportedIds: contactReportedIds } = buildContactIntelSection();
  if (contactIntel) {
    msg3Lines.push(contactIntel);
    msg3Lines.push('');
  }

  if (mentions.length > 0) {
    msg3Lines.push('REPUTATION MENTIONS:');
    for (const m of mentions) msg3Lines.push(`  • ${m}`);
    msg3Lines.push('');
  }

  if (pendingVideos.length === 0) {
    msg3Lines.push('Videos: no pending approvals');
  } else {
    msg3Lines.push(`Videos (${pendingVideos.length} pending approval):`);
    for (const v of pendingVideos) {
      msg3Lines.push(`  • ${v.title ?? '(untitled)'} [${v.channel ?? 'unknown channel'}]`);
    }
  }
  msg3Lines.push('');

  if (queuedCalls.length === 0) {
    msg3Lines.push('Calls: no queued calls');
  } else {
    msg3Lines.push(`Calls (${queuedCalls.length} queued):`);
    for (const c of queuedCalls) {
      const goal = c.instructions
        ? c.instructions.slice(0, 60) + (c.instructions.length > 60 ? '…' : '')
        : 'no instructions';
      msg3Lines.push(`  • ${c.phoneNumber} — ${goal}`);
    }
  }
  msg3Lines.push('');
  msg3Lines.push("Today's focus: [no focus set]");

  try {
    // Saturday: add sermon section before the operational block
    if (new Date().getDay() === 6) {
      try {
        const sermonSection = generateSermonBriefingSection();
        if (sermonSection) {
          msg3Lines.unshift(sermonSection, '');
        }
      } catch {
        /* non-critical */
      }
    }

    await sendTelegramSplit(cfg.telegramChatId, msg1Lines.join('\n'));
    await sendTelegramSplit(cfg.telegramChatId, msg2Lines.join('\n'));
    if (msg3Lines.length > 0) {
      await sendTelegramSplit(cfg.telegramChatId, msg3Lines.join('\n'));
    }

    writeFlag(FLAG);
    console.log('[briefing] daily briefing sent successfully (3-message format)');

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
