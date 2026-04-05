/**
 * whatsapp-ingest.ts
 *
 * Bulk ingestion of WhatsApp message history into SecondBrain's full memory
 * pipeline — AI tagging, Graphiti knowledge graph, 3-tier Hebbian memory,
 * conversations database, and contact enrichment.
 *
 * Follows the same pattern as otter-ingest.ts:
 *   1. Fetch all chats + message history
 *   2. Group messages into per-chat conversation transcripts
 *   3. AI-tag each conversation (topics, people, decisions, sentiment, personal details)
 *   4. Save to data/conversations/ + SQLite index
 *   5. Feed Graphiti + working memory via ingest-hooks
 *
 * Idempotent: MD5 dedup prevents re-processing unchanged conversations.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';
import { getAllChats, getChatHistory, getStatus, WAChat, WAMessage } from './whatsapp-web';
import { tagWhatsAppConversation } from './tagger';
import { saveConversation } from './storage';
import { upsertConversation } from './database';
import { onDataIngested, whatsappEvent } from './ingest-hooks';
import { upsertMemory, appendToArchive } from './memory-index';

// ── State tracking ──────────────────────────────────────────────────────────

interface IngestState {
  processed: Record<
    string,
    { hash: string; ingestedAt: string; chatName: string; messageCount: number }
  >;
  lastFullRun?: string;
}

function stateDir(): string {
  return path.join(app.getPath('userData'), 'data', 'whatsapp-ingest');
}

function stateFile(): string {
  return path.join(stateDir(), 'state.json');
}

function loadState(): IngestState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return { processed: {} };
  }
}

function saveState(state: IngestState): void {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8');
}

function md5(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

// ── Message formatting ──────────────────────────────────────────────────────

function formatMessagesAsTranscript(chatName: string, messages: WAMessage[]): string {
  if (messages.length === 0) return '';

  const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  const firstDate = new Date(sorted[0].timestamp).toISOString().split('T')[0];
  const lastDate = new Date(sorted[sorted.length - 1].timestamp).toISOString().split('T')[0];
  const dateRange = firstDate === lastDate ? firstDate : `${firstDate} to ${lastDate}`;

  const lines: string[] = [
    `# WhatsApp: ${chatName}`,
    ``,
    `**Date range:** ${dateRange}`,
    `**Messages:** ${messages.length}`,
    ``,
    `## Conversation`,
    ``,
  ];

  let currentDate = '';
  for (const msg of sorted) {
    const msgDate = new Date(msg.timestamp).toISOString().split('T')[0];
    if (msgDate !== currentDate) {
      currentDate = msgDate;
      lines.push(`### ${msgDate}`);
      lines.push('');
    }

    const time = new Date(msg.timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    const sender = msg.fromMe ? 'Luke' : msg.fromName || chatName;
    const body = msg.body?.trim();
    if (body) {
      lines.push(`**${sender}** (${time}): ${body}`);
    }
  }

  return lines.join('\n');
}

// ── Main ingestion ──────────────────────────────────────────────────────────

let isIngesting = false;

export interface IngestProgress {
  phase: string;
  current: number;
  total: number;
  chatName?: string;
  error?: string;
}

type ProgressCallback = (progress: IngestProgress) => void;

export async function ingestAllWhatsAppHistory(onProgress?: ProgressCallback): Promise<{
  processed: number;
  skipped: number;
  errors: string[];
  chats: string[];
}> {
  if (isIngesting) {
    return { processed: 0, skipped: 0, errors: ['Ingestion already in progress'], chats: [] };
  }
  if (getStatus() !== 'ready') {
    return { processed: 0, skipped: 0, errors: ['WhatsApp not connected'], chats: [] };
  }

  isIngesting = true;
  const state = loadState();
  let processed = 0;
  let skipped = 0;
  const errors: string[] = [];
  const processedChats: string[] = [];

  try {
    // Step 1: Get all chats
    onProgress?.({ phase: 'fetching-chats', current: 0, total: 0 });
    console.log('[wa-ingest] Fetching chat list...');
    const chats = await getAllChats();
    console.log(`[wa-ingest] Found ${chats.length} chats`);

    // Step 2: Process each chat
    for (let i = 0; i < chats.length; i++) {
      const chat = chats[i];
      onProgress?.({
        phase: 'processing',
        current: i + 1,
        total: chats.length,
        chatName: chat.name,
      });

      try {
        const result = await processChat(chat, state);
        if (result === 'processed') {
          processed++;
          processedChats.push(chat.name);
        } else {
          skipped++;
        }
      } catch (e: any) {
        const errMsg = `Chat "${chat.name}": ${e.message}`;
        console.error(`[wa-ingest] Error:`, errMsg);
        errors.push(errMsg);
      }

      // Rate limit: 500ms between chats to avoid overwhelming APIs
      await sleep(500);
    }

    state.lastFullRun = new Date().toISOString();
    saveState(state);

    console.log(
      `[wa-ingest] Complete: ${processed} processed, ${skipped} skipped, ${errors.length} errors`,
    );
    onProgress?.({ phase: 'complete', current: chats.length, total: chats.length });
  } finally {
    isIngesting = false;
  }

  return { processed, skipped, errors, chats: processedChats };
}

async function processChat(chat: WAChat, state: IngestState): Promise<'processed' | 'skipped'> {
  console.log(`[wa-ingest] Processing: ${chat.name} (${chat.id})`);

  // Fetch deep history (up to 1000 messages)
  const messages = await getChatHistory(chat.id, 1000);
  if (messages.length === 0) {
    console.log(`[wa-ingest] Skipping "${chat.name}" — no messages`);
    return 'skipped';
  }

  // Filter to text messages only
  const textMessages = messages.filter(
    (m) => m.body && m.body.trim().length > 0 && m.type === 'chat',
  );
  if (textMessages.length === 0) {
    console.log(`[wa-ingest] Skipping "${chat.name}" — no text messages`);
    return 'skipped';
  }

  // Format as transcript
  const transcript = formatMessagesAsTranscript(chat.name, textMessages);
  const hash = md5(transcript);

  // Dedup check
  const existing = state.processed[chat.id];
  if (existing && existing.hash === hash) {
    console.log(`[wa-ingest] Skipping "${chat.name}" — unchanged`);
    return 'skipped';
  }

  // ── AI Tagging ──────────────────────────────────────────────────────────
  console.log(`[wa-ingest] AI-tagging "${chat.name}" (${textMessages.length} messages)...`);

  const convId = `wa_${sanitizeId(chat.id)}`;
  const firstMsgDate = new Date(Math.min(...textMessages.map((m) => m.timestamp)))
    .toISOString()
    .split('T')[0];

  let meta;
  try {
    meta = await tagWhatsAppConversation(
      convId,
      chat.name,
      firstMsgDate,
      textMessages.length,
      transcript,
      chat.isGroup,
    );
  } catch (e: any) {
    console.error(`[wa-ingest] Tag failed for "${chat.name}": ${e.message}`);
    // Still save raw data even if tagging fails
    meta = fallbackMeta(convId, chat, textMessages, firstMsgDate);
  }

  // ── Save to conversations database ────────────────────────────────────
  saveConversation(meta, transcript);
  upsertConversation(meta);
  console.log(`[wa-ingest] Saved conversation: ${convId}`);

  // ── Graphiti + Working Memory (via ingest-hooks) ─────────────────────
  // Send full transcript as a single episode for entity extraction
  onDataIngested(
    whatsappEvent({
      id: convId,
      from: chat.id,
      body: transcript.slice(0, 3000), // Graphiti's practical limit
      contactName: chat.name,
      source: chat.isGroup ? 'inbound' : 'inbound', // treat all as inbound for archival
      timestamp: new Date(Math.max(...textMessages.map((m) => m.timestamp))).toISOString(),
    }),
  );

  // ── Tier 2: Indexed Memory for significant contacts ──────────────────
  if (textMessages.length >= 5 && meta.summary) {
    const memoryContent = [
      `WhatsApp conversation with ${chat.name}`,
      `Date range: ${firstMsgDate} — ${new Date(Math.max(...textMessages.map((m) => m.timestamp))).toISOString().split('T')[0]}`,
      `Messages: ${textMessages.length}`,
      `Summary: ${meta.summary}`,
      meta.topics?.length ? `Topics: ${meta.topics.join(', ')}` : '',
      meta.peopleMentioned?.length ? `People: ${meta.peopleMentioned.join(', ')}` : '',
      meta.decisions?.length ? `Decisions: ${meta.decisions.join('; ')}` : '',
      (meta as any).personalDetails?.length
        ? `Personal details: ${(meta as any).personalDetails.join('; ')}`
        : '',
      (meta as any).goalsPlans?.length ? `Goals/plans: ${(meta as any).goalsPlans.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    upsertMemory(`whatsapp: ${chat.name}`, memoryContent, { decayRate: 0.05 });
  }

  // ── Tier 3: Archive raw transcript ───────────────────────────────────
  appendToArchive(
    `[WhatsApp: ${chat.name}] ${textMessages.length} messages. ${meta.summary || 'No summary.'}`,
  );

  // Update state
  state.processed[chat.id] = {
    hash,
    ingestedAt: new Date().toISOString(),
    chatName: chat.name,
    messageCount: textMessages.length,
  };
  saveState(state);

  return 'processed';
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fallbackMeta(convId: string, chat: WAChat, messages: WAMessage[], date: string) {
  return {
    id: convId,
    otterId: convId,
    title: `WhatsApp: ${chat.name}`,
    date,
    durationMinutes: messages.length, // proxy: 1 msg ≈ 1 min
    speakers: [chat.name, 'Luke'],
    myRole: 'participant',
    meetingType: chat.isGroup ? 'group_chat' : 'direct_message',
    summary: `WhatsApp conversation with ${chat.name} (${messages.length} messages)`,
    topics: [],
    keywords: [],
    peopleMentioned: [chat.name],
    companiesMentioned: [],
    decisions: [],
    sentiment: 'routine',
    transcriptFile: 'transcript.txt',
    taggedAt: new Date().toISOString(),
  };
}
