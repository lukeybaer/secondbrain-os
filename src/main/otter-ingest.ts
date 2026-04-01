/**
 * otter-ingest.ts
 *
 * Watches for new Otter.ai transcripts and ingests them into the SecondBrain
 * three-tier memory system. Runs on a polling schedule (every 15 min by default).
 *
 * Key feature: Luke often says who a call is with/about immediately before or
 * after a call. This module looks for those context statements in the surrounding
 * Telegram messages or call records, then attaches them as metadata so that
 * queries like "when did I talk to Leslie about NVF?" resolve correctly.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { streamAllSpeeches, getSpeech, OtterSpeech, login } from './otter';
import { getConfig } from './config';

// ── Storage paths ─────────────────────────────────────────────────────────────

function memoryDir(): string {
  return path.join(app.getPath('userData'), 'memory');
}

function archiveDir(): string {
  return path.join(memoryDir(), 'archive');
}

function ingestStateFile(): string {
  return path.join(memoryDir(), 'otter-ingest-state.json');
}

// ── Ingest state (MD5-based dedup — Khoj pattern) ────────────────────────────

interface IngestState {
  processed: Record<string, { hash: string; ingestedAt: string; title: string }>;
}

function loadState(): IngestState {
  try {
    return JSON.parse(fs.readFileSync(ingestStateFile(), 'utf8'));
  } catch {
    return { processed: {} };
  }
}

function saveState(state: IngestState): void {
  fs.mkdirSync(memoryDir(), { recursive: true });
  fs.writeFileSync(ingestStateFile(), JSON.stringify(state, null, 2), 'utf8');
}

function contentHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

// ── Context extraction ────────────────────────────────────────────────────────

/**
 * The owner frequently announces who a call is with before or after it starts.
 * Examples:
 *   "About to hop on a call with John about the project"
 *   "Just got off with Jane - intro call"
 *   "Interview with candidate just finished"
 *
 * This function attempts to extract the contact name and topic from the title
 * and first few lines of the transcript, since Otter often captures ambient
 * audio before the call proper begins.
 */
function extractCallContext(speech: OtterSpeech): {
  contact: string | null;
  topic: string | null;
  callType: 'meeting' | 'interview' | 'intro' | 'sync' | 'call' | 'unknown';
} {
  const haystack = [speech.title, speech.transcript?.slice(0, 500) || '']
    .join(' ')
    .toLowerCase();

  // Known contacts — customize with your own contact mappings.
  // Maps lowercase transcript mentions to display names.
  // Example: { 'john': 'John Smith', 'jane': 'Jane Doe' }
  const knownContacts: Record<string, string> = {};

  let contact: string | null = null;
  for (const [key, displayName] of Object.entries(knownContacts)) {
    if (haystack.includes(key)) {
      contact = displayName;
      break;
    }
  }

  // Topic detection
  const topicPatterns: Array<[RegExp, string]> = [
    // Customize with your own topic detection patterns.
    // Example: [/sales|pipeline|crm/i, 'sales pipeline'],
    [/interview|hiring|candidate/i, 'hiring interview'],
    [/onboard|intro.*call|first.*meet/i, 'intro call'],
  ];

  let topic: string | null = null;
  for (const [pattern, label] of topicPatterns) {
    if (pattern.test(haystack)) {
      topic = label;
      break;
    }
  }

  // Call type
  let callType: 'meeting' | 'interview' | 'intro' | 'sync' | 'call' | 'unknown' = 'unknown';
  if (/interview/i.test(haystack)) callType = 'interview';
  else if (/intro|introduction|first.*meet/i.test(haystack)) callType = 'intro';
  else if (/sync|standup|stand.up/i.test(haystack)) callType = 'sync';
  else if (/meeting|review|session/i.test(haystack)) callType = 'meeting';
  else if (/call/i.test(haystack)) callType = 'call';

  return { contact, topic, callType };
}

// ── Markdown formatter ────────────────────────────────────────────────────────

function formatTranscriptAsMarkdown(speech: OtterSpeech): string {
  const date = new Date(speech.createdAt * 1000).toISOString().split('T')[0];
  const { contact, topic, callType } = extractCallContext(speech);

  const header = [
    `# ${speech.title}`,
    ``,
    `**Date:** ${date}`,
    contact ? `**Contact:** ${contact}` : null,
    topic ? `**Topic:** ${topic}` : null,
    `**Type:** ${callType}`,
    speech.speakers?.length ? `**Speakers:** ${speech.speakers.join(', ')}` : null,
    `**Otter ID:** ${speech.id}`,
    ``,
    `## Summary`,
    speech.summary || '_No summary available._',
    ``,
    `## Transcript`,
    speech.transcript || '_No transcript available._',
  ].filter(line => line !== null).join('\n');

  return header;
}

// ── Archive writer ────────────────────────────────────────────────────────────

function writeToArchive(speech: OtterSpeech, content: string): string {
  const date = new Date(speech.createdAt * 1000).toISOString().split('T')[0];
  const dir = archiveDir();
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${date}-${speech.id.slice(0, 8)}.md`;
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, content, 'utf8');
  return filepath;
}

/**
 * Write a pointer into MEMORY.md (Tier 1) for highly relevant meetings.
 * Only promoted if: contact is known OR topic is known (not generic calls).
 */
function updateMemoryIndex(speech: OtterSpeech, archivePath: string): void {
  const { contact, topic } = extractCallContext(speech);
  if (!contact && !topic) return; // generic call — archive only, no Tier 1 pointer

  const memFile = path.join(memoryDir(), 'MEMORY.md');
  const date = new Date(speech.createdAt * 1000).toISOString().split('T')[0];
  const rel = path.relative(memoryDir(), archivePath).replace(/\\/g, '/');
  const label = [contact, topic].filter(Boolean).join(' — ');
  const entry = `- [${speech.title.slice(0, 60)} (${date})](${rel}) — ${label}\n`;

  try {
    const existing = fs.existsSync(memFile) ? fs.readFileSync(memFile, 'utf8') : '# Memory Index\n\n';
    // Avoid duplicate entries
    if (!existing.includes(speech.id.slice(0, 8))) {
      fs.appendFileSync(memFile, entry, 'utf8');
    }
  } catch {
    // best effort
  }
}

// ── Main ingest function ──────────────────────────────────────────────────────

let isIngesting = false;

export async function ingestNewTranscripts(): Promise<{
  ingested: number;
  skipped: number;
  titles: string[];
}> {
  if (isIngesting) return { ingested: 0, skipped: 0, titles: [] };
  isIngesting = true;

  const state = loadState();
  let ingested = 0;
  let skipped = 0;
  const titles: string[] = [];

  try {
    await login().catch(() => {}); // ensure session is fresh

    const collected: OtterSpeech[] = [];
    await streamAllSpeeches((batch) => { collected.push(...batch); });

    // Only process most recent 50 (avoid re-ingesting entire history each poll)
    const speeches = collected.slice(0, 50);

    for (const speech of speeches) {
      // Fetch full transcript if we only have a stub
      let full = speech;
      if (!speech.transcript && speech.id) {
        try {
          full = await getSpeech(speech.id);
        } catch {
          full = speech;
        }
      }

      const content = formatTranscriptAsMarkdown(full);
      const hash = contentHash(content);

      // Skip if content hasn't changed (Khoj MD5 dedup pattern)
      const existing = state.processed[full.id];
      if (existing && existing.hash === hash) {
        skipped++;
        continue;
      }

      // Write to archive and update index
      const archivePath = writeToArchive(full, content);
      updateMemoryIndex(full, archivePath);

      // Update state
      state.processed[full.id] = {
        hash,
        ingestedAt: new Date().toISOString(),
        title: full.title,
      };

      ingested++;
      titles.push(full.title);
    }

    saveState(state);
  } finally {
    isIngesting = false;
  }

  return { ingested, skipped, titles };
}

// ── Polling scheduler ─────────────────────────────────────────────────────────

let pollTimer: NodeJS.Timeout | null = null;

export function startOtterPolling(intervalMs = 15 * 60 * 1000): void {
  const run = async () => {
    try {
      const result = await ingestNewTranscripts();
      if (result.ingested > 0) {
        console.log(`[otter-ingest] Ingested ${result.ingested} new transcripts:`, result.titles);
      }
    } catch (e: any) {
      console.error('[otter-ingest] Error:', e.message);
    }
  };

  // Run immediately on start, then on interval
  run();
  pollTimer = setInterval(run, intervalMs);
}

export function stopOtterPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
