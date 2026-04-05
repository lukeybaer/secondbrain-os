// briefing.ts
// Daily morning briefing generator — news, pending videos, call queue, channel stats.
// Delivers via Telegram. Called by the scheduler at 5:30 AM CT.

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { app } from 'electron';
import { getConfig } from './config';
import { sendMessage } from './telegram';
import { generateSermonBriefingSection } from './sermons';

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

// ── Pending videos ────────────────────────────────────────────────────────────

interface VideoManifestEntry {
  title?: string;
  channel?: string;
  status?: string;
}

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

// ── Upcoming calls (queued call records) ─────────────────────────────────────

interface CallRecord {
  id: string;
  phoneNumber?: string;
  instructions?: string;
  status?: string;
  completed?: boolean;
}

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

// ── Approved video count (for evening update) ─────────────────────────────────

function loadApprovedToday(): { approvedCount: number; uploadQueueCount: number } {
  const manifestPath = path.join(
    app.getPath('userData'),
    'content-review',
    'pending',
    'manifest.json',
  );
  if (!fs.existsSync(manifestPath)) return { approvedCount: 0, uploadQueueCount: 0 };
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const entries: VideoManifestEntry[] = Array.isArray(raw) ? raw : Object.values(raw);
    const today = todayStamp();
    // "approved" entries with an approvedAt date of today
    const approvedCount = entries.filter(
      (e) =>
        e.status === 'approved' &&
        (e as Record<string, unknown>)['approvedAt']?.toString().startsWith(today),
    ).length;
    // entries approved but not yet uploaded
    const uploadQueueCount = entries.filter(
      (e) => e.status === 'approved' && !(e as Record<string, unknown>)['uploadedAt'],
    ).length;
    return { approvedCount, uploadQueueCount };
  } catch {
    return { approvedCount: 0, uploadQueueCount: 0 };
  }
}

// ── News fetch ────────────────────────────────────────────────────────────────

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

/** Parse top N headlines from an RSS/Atom XML feed (no external deps). */
function parseRssHeadlines(xml: string, max = 5): string[] {
  const titleRegex = /<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/gis;
  const headlines: string[] = [];
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = titleRegex.exec(xml)) !== null) {
    const title = match[1]
      .trim()
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#[0-9]+;/g, '');
    // Skip the feed title (first match) — they're usually short/generic
    if (count > 0 && title.length > 15 && headlines.length < max) {
      headlines.push(title);
    }
    count++;
  }
  return headlines;
}

async function fetchNewsHeadlines(): Promise<string[]> {
  const cfg = getConfig();

  // NewsAPI.org takes priority if key is configured
  if (cfg.newsApiKey) {
    try {
      const url = `https://newsapi.org/v2/top-headlines?country=us&pageSize=5&apiKey=${cfg.newsApiKey}`;
      const raw = await fetchUrl(url);
      const data = JSON.parse(raw);
      if (data.articles) {
        return (data.articles as { title: string }[])
          .map((a) => a.title)
          .filter(Boolean)
          .slice(0, 5);
      }
    } catch (err) {
      console.warn('[briefing] NewsAPI failed, falling back to RSS:', (err as Error).message);
    }
  }

  // Fall back to BBC News RSS
  try {
    const xml = await fetchUrl('https://feeds.bbci.co.uk/news/rss.xml');
    const headlines = parseRssHeadlines(xml, 5);
    if (headlines.length > 0) return headlines;
  } catch (err) {
    console.warn('[briefing] BBC RSS failed:', (err as Error).message);
  }

  // Last resort: AP News
  try {
    const xml = await fetchUrl('https://rsshub.app/apnews/topics/apf-topnews');
    return parseRssHeadlines(xml, 5);
  } catch {
    return [];
  }
}

/** Summarize headlines with Groq (openai-compatible) if key available. */
async function summarizeNewsWithGroq(headlines: string[]): Promise<string> {
  const cfg = getConfig();
  if (!cfg.groqApiKey || headlines.length === 0) {
    return headlines.map((h) => `• ${h}`).join('\n');
  }

  try {
    const body = JSON.stringify({
      model: 'llama-3.1-8b-instant',
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content:
            `Briefly summarize these top news headlines in 2-3 sentences, mentioning the most important story first. Be concise and factual.\n\n` +
            headlines.map((h, i) => `${i + 1}. ${h}`).join('\n'),
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
    console.warn('[briefing] Groq summarization failed:', (err as Error).message);
  }

  // Fall back to bullet list
  return headlines.map((h) => `• ${h}`).join('\n');
}

// ── Reputation monitoring ─────────────────────────────────────────────────────

/** Quick search for recent mentions of the owner via RSS/web searches. */
async function fetchReputationMentions(): Promise<string[]> {
  try {
    // Build search query from config — users set their own reputation keywords
    const config = getConfig();
    const keywords = (config as any).reputationKeywords as string | undefined;
    if (!keywords) return []; // No keywords configured — skip reputation monitoring

    const query = encodeURIComponent(keywords);
    const xml = await fetchUrl(
      `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`,
    );
    const mentions = parseRssHeadlines(xml, 3);
    return mentions.slice(0, 3);
  } catch {
    return [];
  }
}

// ── Contact Intelligence ─────────────────────────────────────────────────────

function loadContactIntelSection(): string {
  const contactsDir =
    'C:\\Users\\luked\\.claude\\projects\\C--Users-luked-secondbrain\\memory\\contacts';
  const sections: string[] = [];

  // Birthdays/anniversaries
  try {
    const datesFile = path.join(contactsDir, '_upcoming-dates.md');
    if (fs.existsSync(datesFile)) {
      const content = fs.readFileSync(datesFile, 'utf-8');
      const todayMatch = content.match(/## TODAY[\s\S]*?(?=## |$)/i);
      if (todayMatch && !todayMatch[0].includes('None')) {
        sections.push('BIRTHDAYS/DATES:');
        const lines = todayMatch[0]
          .split('\n')
          .filter((l) => l.startsWith('- '))
          .slice(0, 5);
        for (const l of lines) sections.push(`  ${l}`);
      }
      const weekMatch = content.match(/## THIS WEEK[\s\S]*?(?=## |$)/i);
      if (weekMatch && !weekMatch[0].includes('None')) {
        const weekLines = weekMatch[0]
          .split('\n')
          .filter((l) => l.startsWith('- '))
          .slice(0, 3);
        if (weekLines.length > 0) {
          sections.push('Coming up this week:');
          for (const l of weekLines) sections.push(`  ${l}`);
        }
      }
    }
  } catch {
    /* skip if file missing */
  }

  // LinkedIn intel
  try {
    const linkedinFile = path.join(contactsDir, '_linkedin-daily-intel.md');
    if (fs.existsSync(linkedinFile)) {
      const content = fs.readFileSync(linkedinFile, 'utf-8');
      const engMatch = content.match(/## ENGAGEMENT OPPORTUNITIES[\s\S]*?(?=## |$)/i);
      if (engMatch) {
        const engLines = engMatch[0]
          .split('\n')
          .filter((l) => l.startsWith('- '))
          .slice(0, 3);
        if (engLines.length > 0) {
          sections.push('LINKEDIN ENGAGEMENT:');
          for (const l of engLines) sections.push(`  ${l}`);
        }
      }
      const jobMatch = content.match(/## JOB CHANGES[\s\S]*?(?=## |$)/i);
      if (jobMatch && !jobMatch[0].includes('None')) {
        const jobLines = jobMatch[0]
          .split('\n')
          .filter((l) => l.startsWith('- '))
          .slice(0, 3);
        if (jobLines.length > 0) {
          sections.push('NETWORK MOVES:');
          for (const l of jobLines) sections.push(`  ${l}`);
        }
      }
    }
  } catch {
    /* skip if file missing */
  }

  // Warmth warnings (Mondays only)
  try {
    if (new Date().getDay() === 1) {
      const warmthFile = path.join(contactsDir, '_warmth-report.md');
      if (fs.existsSync(warmthFile)) {
        const content = fs.readFileSync(warmthFile, 'utf-8');
        const coolingMatch = content.match(/## COOLING[\s\S]*?(?=## |$)/i);
        const coldMatch = content.match(/## COLD[\s\S]*?(?=## |$)/i);
        const coldContacts: string[] = [];
        if (coolingMatch) {
          coldContacts.push(
            ...coolingMatch[0]
              .split('\n')
              .filter((l) => l.startsWith('- '))
              .slice(0, 3),
          );
        }
        if (coldMatch) {
          coldContacts.push(
            ...coldMatch[0]
              .split('\n')
              .filter((l) => l.startsWith('- '))
              .slice(0, 3),
          );
        }
        if (coldContacts.length > 0) {
          sections.push('RELATIONSHIPS COOLING:');
          for (const l of coldContacts) sections.push(`  ${l}`);
        }
      }
    }
  } catch {
    /* skip if file missing */
  }

  return sections.length > 0 ? sections.join('\n') : '';
}

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

  const [pendingVideos, queuedCalls, headlines, mentions] = await Promise.all([
    Promise.resolve(loadPendingVideos()),
    Promise.resolve(loadQueuedCalls()),
    fetchNewsHeadlines(),
    fetchReputationMentions(),
  ]);

  const newsSummary = await summarizeNewsWithGroq(headlines);

  const lines: string[] = [];

  lines.push(`Good morning Luke — ${friendlyDate()}`);
  lines.push('');

  // News
  if (newsSummary) {
    lines.push('NEWS:');
    lines.push(newsSummary);
    lines.push('');
  }

  // Contact intelligence (birthdays, LinkedIn, warmth)
  const contactIntel = loadContactIntelSection();
  if (contactIntel) {
    lines.push(contactIntel);
    lines.push('');
  }

  // Reputation monitoring
  if (mentions.length > 0) {
    lines.push('REPUTATION MENTIONS:');
    for (const m of mentions) {
      lines.push(`  • ${m}`);
    }
    lines.push('');
  }

  // Pending videos
  if (pendingVideos.length === 0) {
    lines.push('Videos: no pending approvals');
  } else {
    lines.push(`Videos (${pendingVideos.length} pending approval):`);
    for (const v of pendingVideos) {
      const title = v.title ?? '(untitled)';
      const channel = v.channel ?? 'unknown channel';
      lines.push(`  • ${title} [${channel}]`);
    }
  }

  lines.push('');

  // Upcoming calls
  if (queuedCalls.length === 0) {
    lines.push('Calls: no queued calls');
  } else {
    lines.push(`Calls (${queuedCalls.length} queued):`);
    for (const c of queuedCalls) {
      const goal = c.instructions
        ? c.instructions.slice(0, 60) + (c.instructions.length > 60 ? '…' : '')
        : 'no instructions';
      lines.push(`  • ${c.phoneNumber} — ${goal}`);
    }
  }

  lines.push('');

  // Focus
  lines.push("Today's focus: [no focus set]");

  const text = lines.join('\n');

  try {
    await sendMessage(cfg.telegramChatId, text);
    writeFlag(FLAG);
    console.log('[briefing] daily briefing sent successfully');

    // Post-send: feed Graphiti + working memory
    try {
      const { onDataIngested, briefingEvent } = await import('./ingest-hooks');
      onDataIngested(briefingEvent('daily', text));
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

export async function sendEveningUpdate(): Promise<void> {
  const FLAG = 'evening-sent';

  if (flagExists(FLAG)) {
    console.log('[briefing] evening update already sent today — skipping');
    return;
  }

  const cfg = getConfig();
  if (!cfg.telegramBotToken || !cfg.telegramChatId) {
    console.warn('[briefing] Telegram not configured — skipping evening update');
    return;
  }

  const date = friendlyDate();
  const { approvedCount, uploadQueueCount } = loadApprovedToday();

  const text = [
    `Evening update — ${date}.`,
    `Approved videos today: ${approvedCount}.`,
    `Upload queue: ${uploadQueueCount} approved pending upload.`,
  ].join('\n');

  try {
    await sendMessage(cfg.telegramChatId, text);
    writeFlag(FLAG);
    console.log('[briefing] evening update sent successfully');
  } catch (err) {
    console.error(
      '[briefing] failed to send evening update:',
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
