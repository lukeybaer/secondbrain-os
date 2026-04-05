#!/usr/bin/env npx tsx
/**
 * recurate-all.ts
 *
 * Standalone script to re-process all existing conversations through the
 * improved memory pipeline (Graphiti + Tier 2/3 Hebbian memory).
 *
 * This does NOT re-tag with OpenAI — it uses the existing meta.json data
 * and feeds it to Graphiti + memory systems that weren't wired up when
 * the conversations were originally ingested.
 *
 * Usage: npx tsx scripts/recurate-all.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Config ──────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
  'secondbrain',
);
const CONVS_DIR = path.join(DATA_DIR, 'data', 'conversations');
const MEMORY_DIR = path.join(DATA_DIR, 'data', 'agent', 'memory');
const GRAPHITI_URL = 'http://127.0.0.1:8000';
const RATE_LIMIT_MS = 300; // ms between Graphiti calls

// ── Graphiti MCP client (minimal) ───────────────────────────────────────────

let sessionId: string | null = null;
let requestId = 0;

function mcpHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) h['mcp-session-id'] = sessionId;
  return h;
}

async function parseSSE(res: Response): Promise<any> {
  const text = await res.text();
  const jsonLine = text.split('\n').find((l) => l.startsWith('data: '));
  if (!jsonLine) return null;
  return JSON.parse(jsonLine.replace('data: ', ''));
}

async function ensureGraphitiSession(): Promise<boolean> {
  if (sessionId) return true;
  try {
    const res = await fetch(`${GRAPHITI_URL}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++requestId,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'recurate', version: '1.0' },
        },
      }),
    });
    sessionId = res.headers.get('mcp-session-id');
    const data = await parseSSE(res);
    // Send initialized notification
    await fetch(`${GRAPHITI_URL}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    return !!data?.result;
  } catch {
    return false;
  }
}

async function addEpisode(
  name: string,
  body: string,
  source: string,
  referenceTime?: string,
): Promise<boolean> {
  if (!(await ensureGraphitiSession())) return false;
  try {
    const res = await fetch(`${GRAPHITI_URL}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++requestId,
        method: 'tools/call',
        params: {
          name: 'add_memory',
          arguments: {
            name,
            episode_body: body.slice(0, 3000),
            source_description: source,
            source: 'text',
            group_id: 'luke-ea',
          },
        },
      }),
    });
    const data = await parseSSE(res);
    return !!data?.result;
  } catch {
    return false;
  }
}

// ── Memory index (simplified — writes directly to files) ────────────────────

function writeMemoryEntry(topic: string, content: string): void {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60);
  const dir = path.join(MEMORY_DIR, 'tier2');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${slug}.md`);
  const header = `# ${topic}\n*recurated: ${new Date().toISOString().split('T')[0]}*\n\n`;
  fs.writeFileSync(filePath, header + content, 'utf-8');
}

function appendArchive(content: string): void {
  const date = new Date().toISOString().split('T')[0];
  const dir = path.join(MEMORY_DIR, 'archive');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${date}.md`);
  fs.appendFileSync(filePath, `\n${content}\n`, 'utf-8');
}

// ── Main ────────────────────────────────────────────────────────────────────

interface ConversationMeta {
  id: string;
  otterId: string;
  title: string;
  date: string;
  durationMinutes: number;
  speakers: string[];
  myRole: string;
  meetingType: string;
  summary: string;
  topics: string[];
  keywords: string[];
  peopleMentioned: string[];
  companiesMentioned: string[];
  decisions: string[];
  sentiment: string;
}

async function main(): Promise<void> {
  console.log('=== SecondBrain Full Re-Curation ===');
  console.log(`Conversations dir: ${CONVS_DIR}`);
  console.log(`Memory dir: ${MEMORY_DIR}`);

  // Check Graphiti
  const graphitiOk = await ensureGraphitiSession();
  console.log(`Graphiti: ${graphitiOk ? 'connected' : 'UNAVAILABLE (will skip)'}`);

  // List all conversation directories
  const dirs = fs.readdirSync(CONVS_DIR).filter((d) => {
    const metaPath = path.join(CONVS_DIR, d, 'meta.json');
    return fs.existsSync(metaPath);
  });
  console.log(`Found ${dirs.length} conversations to process\n`);

  let processed = 0;
  let graphitiSuccess = 0;
  let graphitiFail = 0;
  let memoryWritten = 0;
  const errors: string[] = [];

  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i];
    const metaPath = path.join(CONVS_DIR, dir, 'meta.json');
    const transcriptPath = path.join(CONVS_DIR, dir, 'transcript.txt');

    try {
      const meta: ConversationMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      const transcript = fs.existsSync(transcriptPath)
        ? fs.readFileSync(transcriptPath, 'utf-8')
        : '';

      // Progress
      if ((i + 1) % 50 === 0 || i === 0) {
        console.log(`[${i + 1}/${dirs.length}] Processing: ${meta.title}`);
      }

      // ── Feed to Graphiti ────────────────────────────────────────────
      if (graphitiOk && transcript.length > 10) {
        const episodeBody = [
          meta.summary ? `Summary: ${meta.summary}` : '',
          meta.topics?.length ? `Topics: ${meta.topics.join(', ')}` : '',
          meta.peopleMentioned?.length ? `People: ${meta.peopleMentioned.join(', ')}` : '',
          meta.companiesMentioned?.length ? `Companies: ${meta.companiesMentioned.join(', ')}` : '',
          meta.decisions?.length ? `Decisions: ${meta.decisions.join('; ')}` : '',
          '',
          'Transcript excerpt:',
          transcript.slice(0, 2000),
        ]
          .filter(Boolean)
          .join('\n');

        const ok = await addEpisode(
          meta.title,
          episodeBody,
          `otter-transcript:${meta.otterId}`,
          new Date(meta.date).toISOString(),
        );

        if (ok) graphitiSuccess++;
        else graphitiFail++;

        // Rate limit
        await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
      }

      // ── Tier 2 Memory: significant conversations ──────────────────
      if (meta.summary && (meta.peopleMentioned?.length > 0 || meta.topics?.length > 0)) {
        const memContent = [
          `**${meta.title}** (${meta.date})`,
          `Speakers: ${meta.speakers?.join(', ') || 'unknown'}`,
          `Type: ${meta.meetingType} | Sentiment: ${meta.sentiment}`,
          `Summary: ${meta.summary}`,
          meta.topics?.length ? `Topics: ${meta.topics.join(', ')}` : '',
          meta.peopleMentioned?.length
            ? `People mentioned: ${meta.peopleMentioned.join(', ')}`
            : '',
          meta.companiesMentioned?.length ? `Companies: ${meta.companiesMentioned.join(', ')}` : '',
          meta.decisions?.length ? `Decisions: ${meta.decisions.join('; ')}` : '',
        ]
          .filter(Boolean)
          .join('\n');

        writeMemoryEntry(`conv: ${meta.title.slice(0, 50)}`, memContent);
        memoryWritten++;
      }

      // ── Tier 3 Archive ────────────────────────────────────────────
      appendArchive(
        `[${meta.date}] ${meta.title} — ${meta.summary || 'no summary'} | People: ${meta.peopleMentioned?.join(', ') || 'none'}`,
      );

      processed++;
    } catch (e: any) {
      errors.push(`${dir}: ${e.message}`);
    }
  }

  // ── Results ─────────────────────────────────────────────────────────────
  console.log('\n=== Re-Curation Complete ===');
  console.log(`Processed: ${processed}/${dirs.length}`);
  console.log(`Graphiti episodes: ${graphitiSuccess} success, ${graphitiFail} failed`);
  console.log(`Memory entries written: ${memoryWritten}`);
  console.log(`Errors: ${errors.length}`);
  if (errors.length > 0) {
    console.log('Errors:');
    errors.slice(0, 10).forEach((e) => console.log(`  - ${e}`));
    if (errors.length > 10) console.log(`  ... and ${errors.length - 10} more`);
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
