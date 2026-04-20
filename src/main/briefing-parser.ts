import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export interface BriefingSection {
  id: string;
  title: string;
  body: string;
  startLine: number;
}

export interface ParsedBriefing {
  date: string;
  filename: string;
  generatedAt: string | null;
  llm: string | null;
  greeting: string;
  sections: BriefingSection[];
  raw: string;
}

export interface BriefingSummary {
  date: string;
  filename: string;
  filePath: string;
  sizeBytes: number;
  mtimeMs: number;
}

const BRIEFINGS_DIR = (): string =>
  path.join(process.env.SECONDBRAIN_ROOT || app.getAppPath(), 'data', 'briefings');

const FILENAME_REGEX = /^briefing-(\d{4}-\d{2}-\d{2})\.md$/;

// Detects section headers: lines that START with 2+ consecutive uppercase letters
// and END with a colon. Anything in the middle is allowed (descriptions, parentheticals,
// dates, etc) up to a reasonable max length so we don't catch multi-line sentences.
// Examples matched:
//   ACTION ITEMS -- unanswered asks (verified by reading each thread):
//   FEATURE BACKLOG (10 items, updated 2026-04-20 00:00Z):
//   SYSTEM HEALTH:
//   LINKEDIN -- TOP STRATEGIC REACH-OUTS (last 30h):
//   AI & TECH NEWS (10):
// Not matched:
//   "1. Thing:"         (starts with a digit)
//   "- Note: something" (starts with a bullet)
//   "I thought: ..."    (only one uppercase letter at start)
const HEADER_REGEX = /^([A-Z]{2,}[^\n]{0,200}):\s*$/;

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function listBriefingFiles(dir: string = BRIEFINGS_DIR()): BriefingSummary[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const summaries: BriefingSummary[] = [];
  for (const name of entries) {
    const match = FILENAME_REGEX.exec(name);
    if (!match) continue;
    const filePath = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    summaries.push({
      date: match[1],
      filename: name,
      filePath,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
  summaries.sort((a, b) => b.date.localeCompare(a.date));
  return summaries;
}

export function parseBriefing(raw: string, date: string, filename: string): ParsedBriefing {
  const lines = raw.split(/\r?\n/);

  // Pull metadata from the first ~8 lines
  let generatedAt: string | null = null;
  let llm: string | null = null;
  const greetingLines: string[] = [];

  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const line = lines[i];
    if (line.startsWith('Generated:')) {
      generatedAt = line.slice('Generated:'.length).trim();
      continue;
    }
    if (line.startsWith('LLM:')) {
      llm = line.slice('LLM:'.length).trim();
      continue;
    }
    if (line.trim() === '---') break;
    greetingLines.push(line);
  }
  const greeting = greetingLines.join('\n').trim();

  // Walk the body and identify section headers
  const sections: BriefingSection[] = [];
  let current: BriefingSection | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip the metadata block until we hit the first ---
    if (current === null && sections.length === 0) {
      const hasReachedBody =
        trimmed === '---' || HEADER_REGEX.test(line) || /^[A-Z][A-Z\s]{6,}:$/.test(trimmed);
      if (!hasReachedBody && i < 8) continue;
    }

    const headerMatch = HEADER_REGEX.exec(line);

    if (headerMatch) {
      const title = headerMatch[1].trim();
      if (title.length < 4) continue;

      // Close previous section
      if (current) sections.push(current);

      current = {
        id: slugify(title) + '-' + i,
        title,
        body: line + '\n',
        startLine: i,
      };
      continue;
    }

    if (current) {
      current.body += line + '\n';
    }
  }
  if (current) sections.push(current);

  // Trim trailing whitespace on each section body
  for (const s of sections) {
    s.body = s.body.replace(/\s+$/, '');
  }

  return {
    date,
    filename,
    generatedAt,
    llm,
    greeting,
    sections,
    raw,
  };
}

export function pruneOldBriefings(keepDays: number = 3, now: Date = new Date()): {
  kept: string[];
  deleted: string[];
  error?: string;
} {
  const files = listBriefingFiles();
  if (files.length === 0) return { kept: [], deleted: [] };

  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (keepDays - 1));

  const kept: string[] = [];
  const deleted: string[] = [];
  let error: string | undefined;

  for (const f of files) {
    const fileDate = new Date(f.date + 'T00:00:00');
    if (fileDate >= cutoff) {
      kept.push(f.filename);
    } else {
      try {
        fs.unlinkSync(f.filePath);
        deleted.push(f.filename);
      } catch (e) {
        error = (error ? error + '; ' : '') + `${f.filename}: ${(e as Error).message}`;
      }
    }
  }
  return { kept, deleted, error };
}

export function loadBriefingByDate(date: string): ParsedBriefing | null {
  const dir = BRIEFINGS_DIR();
  const filename = `briefing-${date}.md`;
  const filePath = path.join(dir, filename);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return parseBriefing(raw, date, filename);
  } catch {
    return null;
  }
}
