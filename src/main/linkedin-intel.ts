// linkedin-intel.ts
// Nightly contact intelligence crawl — reads the LinkedIn + Gmail daily intel
// markdown files produced by Chrome automation, structures them into ranked events,
// stores them in %APPDATA%\secondbrain\data\agent\linkedin-intel.json.
//
// Runs at midnight CT via scheduler.ts.
// Morning briefing reads results and formats Contact Intelligence section.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';

const CONTACTS_DIR =
  'C:\\Users\\luked\\.claude\\projects\\C--Users-luked-secondbrain\\memory\\contacts';

// Priority: lower number = more important in briefing
const EVENT_PRIORITY: Record<string, number> = {
  job_change: 1,
  company_news: 2,
  published_content: 3,
  engagement: 4,
  unread_email: 5,
  news_mention: 6,
};

export interface ContactEvent {
  id: string; // SHA-256 prefix for dedup
  contactName: string;
  eventType: string;
  headline: string;
  detail: string;
  source: string; // 'linkedin_daily_intel' | 'gmail_daily_intel'
  detectedAt: string; // ISO timestamp
  reportedAt: string | null;
}

export interface LinkedInIntelStore {
  lastCrawlAt: string;
  totalContactsQueried: number;
  totalContacts: number;
  memoryUpdated: boolean;
  events: ContactEvent[];
}

// ── Paths ──────────────────────────────────────────────────────────────────────

function getIntelPath(): string {
  return path.join(app.getPath('userData'), 'data', 'agent', 'linkedin-intel.json');
}

function getHistoryPath(): string {
  return path.join(app.getPath('userData'), 'data', 'agent', 'briefing-history.jsonl');
}

function ensureAgentDir(): void {
  const dir = path.join(app.getPath('userData'), 'data', 'agent');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Event identity ─────────────────────────────────────────────────────────────

function eventId(contactName: string, eventType: string, headline: string): string {
  return crypto
    .createHash('sha256')
    .update(`${contactName}|${eventType}|${headline.slice(0, 120)}`)
    .digest('hex')
    .slice(0, 16);
}

// ── Briefing history (already-reported events) ─────────────────────────────────

function loadReportedIds(): Set<string> {
  const histPath = getHistoryPath();
  if (!fs.existsSync(histPath)) return new Set();
  try {
    const reported = new Set<string>();
    const lines = fs.readFileSync(histPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { reportedIds?: string[] };
        if (Array.isArray(entry.reportedIds)) {
          for (const id of entry.reportedIds) reported.add(id);
        }
      } catch {
        /* skip malformed lines */
      }
    }
    return reported;
  } catch {
    return new Set();
  }
}

export function markContactEventsReported(ids: string[]): void {
  if (ids.length === 0) return;
  ensureAgentDir();
  const entry = {
    briefingDate: new Date().toISOString().slice(0, 10),
    reportedAt: new Date().toISOString(),
    reportedIds: ids,
  };
  fs.appendFileSync(getHistoryPath(), JSON.stringify(entry) + '\n', 'utf-8');
}

// ── Contact list from contacts dir ────────────────────────────────────────────

function loadContactList(): Array<{ name: string; linkedinUrl?: string }> {
  if (!fs.existsSync(CONTACTS_DIR)) return [];
  const contacts: Array<{ name: string; linkedinUrl?: string }> = [];
  try {
    const files = fs
      .readdirSync(CONTACTS_DIR)
      .filter(
        (f) =>
          f.endsWith('.md') &&
          !f.startsWith('_') &&
          f !== 'INDEX.md' &&
          f !== 'PHASE2_OVERLAP_ANALYSIS.md',
      );
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(CONTACTS_DIR, file), 'utf-8');
        const nameMatch = content.match(/^name:\s*(.+)/m);
        const linkedinMatch = content.match(/linkedin:\s*(https?:\/\/[^\s\n]+)/i);
        if (nameMatch) {
          contacts.push({
            name: nameMatch[1].trim(),
            linkedinUrl: linkedinMatch ? linkedinMatch[1].trim() : undefined,
          });
        }
      } catch {
        /* skip unreadable */
      }
    }
  } catch {
    /* skip if dir unreadable */
  }
  return contacts;
}

// ── Parse LinkedIn daily intel markdown ───────────────────────────────────────

function parseLinkedInIntelFile(reportedIds: Set<string>): ContactEvent[] {
  const events: ContactEvent[] = [];
  const intelFile = path.join(CONTACTS_DIR, '_linkedin-daily-intel.md');
  if (!fs.existsSync(intelFile)) return events;

  try {
    const content = fs.readFileSync(intelFile, 'utf-8');
    // Only parse the most recent report (everything before "# Previous Report")
    const currentSection = content.split(/^# Previous Report/m)[0];

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const dateMatch = currentSection.match(/\*\*Date\*\*:\s*(\d{4}-\d{2}-\d{2})/);
    const reportDate = dateMatch ? new Date(dateMatch[1] + 'T12:00:00') : now;

    // ── ENGAGEMENT OPPORTUNITIES ─────────────────────────────────────────────
    const engSection = currentSection.match(/## ENGAGEMENT OPPORTUNITIES([\s\S]*?)(?=^##\s)/m);
    if (engSection) {
      const blocks = engSection[1].split(/^###\s+/m).filter((s) => s.trim());
      for (const block of blocks) {
        const lines = block.split('\n');
        const titleLine = lines[0].trim();
        if (!titleLine) continue;

        // Parse name — everything before ' — ' or '--'
        const dashIdx = titleLine.search(/\s+(?:—|-{2})\s+/);
        const namePart = dashIdx > 0 ? titleLine.slice(0, dashIdx).trim() : titleLine;
        const descPart =
          dashIdx > 0
            ? titleLine
                .slice(dashIdx)
                .replace(/^[\s—-]+/, '')
                .trim()
            : '';

        // Parse recency hint
        const ageMatch = block.match(/\((\d+)\s+hours?\s+ago\)/i);
        const dayMatch =
          block.match(/\((\d+)[\s–-]+\d*\s+days?\s+ago\)/i) ||
          block.match(/\((\d+)\s+days?\s+ago\)/i);
        let detectedAt = reportDate.toISOString();
        if (ageMatch) {
          detectedAt = new Date(
            reportDate.getTime() - parseInt(ageMatch[1]) * 3_600_000,
          ).toISOString();
        } else if (dayMatch) {
          detectedAt = new Date(
            reportDate.getTime() - parseInt(dayMatch[1]) * 86_400_000,
          ).toISOString();
        }

        if (new Date(detectedAt) < sevenDaysAgo) continue;

        const id = eventId(namePart, 'engagement', titleLine);
        if (reportedIds.has(id)) continue;

        // Extract "Why it matters" or first substantive line
        const whyMatch =
          block.match(/\*\*Why it matters\*\*:\s*([^\n]+)/i) ||
          block.match(/\*\*Why engage\*\*:\s*([^\n]+)/i);
        const detail = whyMatch
          ? whyMatch[1].trim()
          : (lines
              .find(
                (l) =>
                  l.trim() &&
                  !l.startsWith('#') &&
                  !l.startsWith('**Suggested') &&
                  !l.startsWith('###'),
              )
              ?.trim() ?? '');

        events.push({
          id,
          contactName: namePart,
          eventType: 'engagement',
          headline: descPart ? `${namePart} — ${descPart}` : `${namePart} — new LinkedIn activity`,
          detail: detail.slice(0, 200),
          source: 'linkedin_daily_intel',
          detectedAt,
          reportedAt: null,
        });
      }
    }

    // ── JOB CHANGES ──────────────────────────────────────────────────────────
    const jobSection = currentSection.match(/## JOB CHANGES([\s\S]*?)(?=^##\s)/m);
    if (jobSection && !/none detected/i.test(jobSection[1])) {
      const blocks = jobSection[1].split(/^###\s+/m).filter((s) => s.trim());
      for (const block of blocks) {
        const lines = block.split('\n');
        const titleLine = lines[0].trim();
        if (!titleLine) continue;

        const dashIdx = titleLine.search(/\s+(?:—|-{2})\s+/);
        const namePart = dashIdx > 0 ? titleLine.slice(0, dashIdx).trim() : titleLine;
        const descPart =
          dashIdx > 0
            ? titleLine
                .slice(dashIdx)
                .replace(/^[\s—-]+/, '')
                .trim()
            : 'role change';

        const id = eventId(namePart, 'job_change', titleLine);
        if (reportedIds.has(id)) continue;

        const detail = lines.find((l) => l.trim() && !l.startsWith('#'))?.trim() ?? '';

        events.push({
          id,
          contactName: namePart,
          eventType: 'job_change',
          headline: `${namePart} — ${descPart}`,
          detail: detail.slice(0, 200),
          source: 'linkedin_daily_intel',
          detectedAt: reportDate.toISOString(),
          reportedAt: null,
        });
      }
    }
  } catch (err) {
    console.warn('[linkedin-intel] Error parsing LinkedIn intel file:', (err as Error).message);
  }

  return events;
}

// ── Parse Gmail daily intel markdown ─────────────────────────────────────────

function parseGmailIntelFile(reportedIds: Set<string>): ContactEvent[] {
  const events: ContactEvent[] = [];
  const gmailFile = path.join(CONTACTS_DIR, '_gmail-daily-intel.md');
  if (!fs.existsSync(gmailFile)) return events;

  try {
    const content = fs.readFileSync(gmailFile, 'utf-8');
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const dateMatch = content.match(/\*\*Date\*\*:\s*(\d{4}-\d{2}-\d{2})/);
    const reportDate = dateMatch ? new Date(dateMatch[1] + 'T12:00:00') : now;
    if (reportDate < sevenDaysAgo) return events;

    // ── PERSONAL INTEL (contact job/company news from emails) ─────────────
    const intelSection = content.match(/## PERSONAL INTEL([\s\S]*?)(?=^##\s)/m);
    if (intelSection) {
      const blocks = intelSection[1].split(/^###\s+/m).filter((s) => s.trim());
      for (const block of blocks) {
        const lines = block.split('\n');
        const titleLine = lines[0].trim();
        if (!titleLine) continue;

        const dashIdx = titleLine.search(/\s+(?:—|-{2})\s+/);
        const namePart = dashIdx > 0 ? titleLine.slice(0, dashIdx).trim() : titleLine;
        const descPart =
          dashIdx > 0
            ? titleLine
                .slice(dashIdx)
                .replace(/^[\s—-]+/, '')
                .trim()
            : 'email intel';

        // Detect event type from content
        const lc = block.toLowerCase();
        let eventType = 'unread_email';
        if (/\b(left|joined|promoted|new role|new job|joining|started)\b/.test(lc)) {
          eventType = 'job_change';
        } else if (/\b(funding|acquisition|acquired|layoff|laid off|shut down|IPO)\b/.test(lc)) {
          eventType = 'company_news';
        }

        const id = eventId(namePart, eventType, titleLine);
        if (reportedIds.has(id)) continue;

        const detail =
          lines.find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('**'))?.trim() ?? '';

        events.push({
          id,
          contactName: namePart,
          eventType,
          headline: `${namePart} — ${descPart}`,
          detail: detail.slice(0, 200),
          source: 'gmail_daily_intel',
          detectedAt: reportDate.toISOString(),
          reportedAt: null,
        });
      }
    }

    // ── ACTION REQUIRED (unread emails from contacts) ──────────────────────
    const actionSection = content.match(/## ACTION REQUIRED([\s\S]*?)(?=^##\s)/m);
    if (actionSection) {
      const blocks = actionSection[1].split(/^###\s+/m).filter((s) => s.trim());
      for (const block of blocks) {
        const lines = block.split('\n');
        const titleLine = lines[0].trim();
        if (!titleLine || titleLine.startsWith('*') || titleLine.toUpperCase() === titleLine)
          continue;

        const dashIdx = titleLine.search(/\s+(?:—|-{2})\s+/);
        const namePart = dashIdx > 0 ? titleLine.slice(0, dashIdx).trim() : titleLine;
        if (!namePart || namePart.length < 2) continue;

        const id = eventId(namePart, 'unread_email', titleLine);
        if (reportedIds.has(id)) continue;

        const priorityMatch = block.match(/\((HIGH|MEDIUM|LOW)\s+PRIORITY\)/i);
        const priority = priorityMatch ? priorityMatch[1].toUpperCase() : 'MEDIUM';
        const detail =
          lines.find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('**'))?.trim() ?? '';

        events.push({
          id,
          contactName: namePart,
          eventType: 'unread_email',
          headline: `Unread email from ${namePart} (${priority} priority)`,
          detail: detail.slice(0, 200),
          source: 'gmail_daily_intel',
          detectedAt: reportDate.toISOString(),
          reportedAt: null,
        });
      }
    }
  } catch (err) {
    console.warn('[linkedin-intel] Error parsing Gmail intel file:', (err as Error).message);
  }

  return events;
}

// ── Ranking ────────────────────────────────────────────────────────────────────

function rankEvents(events: ContactEvent[]): ContactEvent[] {
  return [...events].sort((a, b) => {
    const pa = EVENT_PRIORITY[a.eventType] ?? 99;
    const pb = EVENT_PRIORITY[b.eventType] ?? 99;
    if (pa !== pb) return pa - pb;
    return new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime();
  });
}

// ── Public API: Nightly crawl ──────────────────────────────────────────────────

export async function runLinkedInNightlyCrawl(): Promise<void> {
  console.log('[linkedin-intel] Starting nightly contact intelligence crawl...');

  const reportedIds = loadReportedIds();
  const contacts = loadContactList();

  const linkedinEvents = parseLinkedInIntelFile(reportedIds);
  const gmailEvents = parseGmailIntelFile(reportedIds);

  const ranked = rankEvents([...linkedinEvents, ...gmailEvents]);

  // Deduplicate by id
  const seen = new Set<string>();
  const events = ranked.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  // Count contacts with LinkedIn profile in the most-recent daily scan
  const intelFile = path.join(CONTACTS_DIR, '_linkedin-daily-intel.md');
  let queriedCount = 8; // default inner-circle rotation
  if (fs.existsSync(intelFile)) {
    try {
      const firstLine = fs
        .readFileSync(intelFile, 'utf-8')
        .split('\n')
        .find((l) => l.toLowerCase().includes('contacts scanned'));
      if (firstLine) {
        const match = firstLine.match(/:\s*(.+)/);
        if (match) queriedCount = match[1].split(',').length;
      }
    } catch {
      /* ignore */
    }
  }

  const store: LinkedInIntelStore = {
    lastCrawlAt: new Date().toISOString(),
    totalContactsQueried: queriedCount,
    totalContacts: contacts.length,
    memoryUpdated: true,
    events,
  };

  ensureAgentDir();
  fs.writeFileSync(getIntelPath(), JSON.stringify(store, null, 2), 'utf-8');
  console.log(
    `[linkedin-intel] Crawl complete — ${events.length} events across ${contacts.length} contacts`,
  );
}

// ── Public API: Build briefing section ────────────────────────────────────────

export function buildContactIntelSection(): { text: string; reportedIds: string[] } {
  const intelPath = getIntelPath();
  if (!fs.existsSync(intelPath)) {
    return { text: '', reportedIds: [] };
  }

  let store: LinkedInIntelStore;
  try {
    store = JSON.parse(fs.readFileSync(intelPath, 'utf-8')) as LinkedInIntelStore;
  } catch {
    return { text: '', reportedIds: [] };
  }

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  const reportedIds = loadReportedIds();
  const fresh = store.events.filter((e) => !reportedIds.has(e.id));

  const pastWeek = fresh.filter((e) => new Date(e.detectedAt) >= sevenDaysAgo).slice(0, 3);

  const past48h = fresh.filter((e) => new Date(e.detectedAt) >= fortyEightHoursAgo).slice(0, 3);

  const lines: string[] = [];
  lines.push('CONTACT INTELLIGENCE:');

  // ── Past 7 days ──────────────────────────────────────────────────────────
  lines.push('Past 7 days:');
  if (pastWeek.length > 0) {
    for (const e of pastWeek) {
      lines.push(`  • ${e.headline}`);
      if (e.detail) {
        lines.push(`    ${e.detail.slice(0, 140)}`);
      }
    }
  } else {
    lines.push('  Nothing new to report.');
  }

  lines.push('');

  // ── Past 48 hours ────────────────────────────────────────────────────────
  lines.push('Past 48 hours:');
  if (past48h.length > 0) {
    for (const e of past48h) {
      lines.push(`  • ${e.headline}`);
      if (e.detail) {
        lines.push(`    ${e.detail.slice(0, 140)}`);
      }
    }
  } else {
    lines.push('  Nothing new to report.');
  }

  lines.push('');

  // ── LinkedIn query stats ─────────────────────────────────────────────────
  const crawlAgeH = store.lastCrawlAt
    ? Math.round((now.getTime() - new Date(store.lastCrawlAt).getTime()) / 3_600_000)
    : null;
  const ageStr = crawlAgeH !== null ? ` (${crawlAgeH}h ago)` : '';
  lines.push(
    `LinkedIn: Queried ${store.totalContactsQueried} of ${store.totalContacts} contacts${ageStr}. Memory updated for all.`,
  );

  // Collect all newly-surfaced event IDs so the caller can mark them reported
  const toMark = [
    ...pastWeek.map((e) => e.id),
    ...past48h.map((e) => e.id).filter((id) => !pastWeek.find((e) => e.id === id)),
  ];

  return { text: lines.join('\n'), reportedIds: toMark };
}

// ── Public API: EC2 sync snapshot ─────────────────────────────────────────────

export function getLinkedInIntelSnapshot(): LinkedInIntelStore | null {
  const intelPath = getIntelPath();
  if (!fs.existsSync(intelPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(intelPath, 'utf-8')) as LinkedInIntelStore;
  } catch {
    return null;
  }
}
