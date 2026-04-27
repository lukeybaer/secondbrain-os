// intent-extractor.ts
//
// Smolagents-inspired action extraction from ingest streams. Every Gmail,
// Otter, and WhatsApp payload passes through the ingest pipeline but the
// commitments inside them — "I'll call you Thursday", "remind me about the
// tractor serial", "let's do a demo next week" — get archived as raw text and
// never surface as tasks.
//
// This module uses Claude Haiku to extract actionable intents from ingest
// payloads and writes them to data/agent/intent-queue.jsonl. The nightly
// briefing reads open intents and surfaces them as a follow-up section.
//
// Reference: HuggingFace smolagents "think in code" pattern — rather than
// mapping tool outputs to a fixed schema, the model reasons about what action
// the content implies and generates a typed intent object. We apply this idea
// to ingest payloads rather than tool chains.
//
// Intent types:
//   follow_up     — someone/something the owner said he'd follow up on
//   reminder      — explicit "remind me" or time-anchored commitment
//   task          — actionable item with a clear owner/due date
//   research      — "find out about X" or "look into Y"
//   delegate      — the owner explicitly asked Amy to handle something
//
// Dedup: intents are hashed on (source, type, subject). Same subject from the
// same source within 24h is suppressed.

import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getConfig } from './config';

// ── Types ─────────────────────────────────────────────────────────────────────

export type IntentType = 'follow_up' | 'reminder' | 'task' | 'research' | 'delegate';
export type IntentStatus = 'open' | 'done' | 'dismissed';

export interface ExtractedIntent {
  intent_id: string;         // sha1 of (source + type + subject)
  timestamp: string;
  source: string;            // 'gmail' | 'otter' | 'whatsapp' | 'briefing-feedback' | 'vapi'
  source_ref: string;        // thread id, file name, call id, etc.
  type: IntentType;
  subject: string;           // 1-sentence description of the commitment
  contact?: string;          // person involved (if any)
  due_hint?: string;         // natural-language due date ("Thursday", "next week", "ASAP")
  verbatim: string;          // the sentence(s) from the payload that triggered this
  confidence: number;        // 0.0-1.0 — how certain the model is this is actionable
  status: IntentStatus;
  resolved_at?: string;
}

export interface ExtractionResult {
  intents: ExtractedIntent[];
  newCount: number;         // intents that weren't already in the queue
  dupCount: number;
  skippedLow: number;       // intents below confidence threshold (< 0.6)
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLD = 0.6;
const QUEUE_FILENAME = 'intent-queue.jsonl';

const EXTRACTION_PROMPT = `You are an executive assistant reading a message/transcript on behalf of the owner.
Extract every actionable commitment, follow-up, or reminder that needs to be tracked.

Return a JSON array (possibly empty). Each item must have:
- type: "follow_up" | "reminder" | "task" | "research" | "delegate"
- subject: one-sentence description of the commitment (max 100 chars)
- contact: person involved, if any (first name + last name if identifiable)
- due_hint: natural-language due date if mentioned ("Thursday", "next week", "ASAP", or omit)
- verbatim: the exact sentence(s) that triggered this intent (max 200 chars)
- confidence: float 0.0-1.0 (how certain you are this is an actionable commitment)

Rules:
- Only include items that require action. Skip pleasantries, info-sharing with no next step.
- "follow_up" = the owner said he'd reach back out or respond to someone
- "reminder" = explicit time-anchored reminder for the owner
- "task" = concrete thing to do (research, call, send, review)
- "research" = "find out about X", "look into Y", "check if Z"
- "delegate" = the owner explicitly asked Amy to do something specific
- Confidence < 0.6 = omit it entirely
- Return [] if nothing actionable is found

Return ONLY valid JSON array, no markdown fences.`;

// ── Main extraction function ──────────────────────────────────────────────────

export async function extractIntents(
  payload: string,
  source: string,
  sourceRef: string,
  dataDir: string,
): Promise<ExtractionResult> {
  const cfg = getConfig();
  const apiKey = cfg.anthropicApiKey;
  if (!apiKey) {
    return { intents: [], newCount: 0, dupCount: 0, skippedLow: 0 };
  }

  const client = new Anthropic({ apiKey });

  let rawJson: string;
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `${EXTRACTION_PROMPT}\n\nMessage/transcript to analyze:\n\n${payload.slice(0, 4000)}`,
        },
      ],
    });
    rawJson = (response.content[0] as { type: string; text: string }).text.trim();
  } catch {
    return { intents: [], newCount: 0, dupCount: 0, skippedLow: 0 };
  }

  let raw: Array<{
    type?: string;
    subject?: string;
    contact?: string;
    due_hint?: string;
    verbatim?: string;
    confidence?: number;
  }> = [];

  try {
    // Strip any accidental markdown fences
    const stripped = rawJson.replace(/^```json\n?|```$/gm, '').trim();
    raw = JSON.parse(stripped);
    if (!Array.isArray(raw)) raw = [];
  } catch {
    raw = [];
  }

  const queuePath = path.join(dataDir, QUEUE_FILENAME);
  const existingIds = loadExistingIds(queuePath);
  const now = new Date().toISOString();

  const intents: ExtractedIntent[] = [];
  let skippedLow = 0;

  for (const item of raw) {
    const confidence = item.confidence ?? 0;
    if (confidence < CONFIDENCE_THRESHOLD) {
      skippedLow++;
      continue;
    }
    const type = (item.type ?? 'task') as IntentType;
    const subject = (item.subject ?? '').slice(0, 100);
    if (!subject) continue;

    const intentId = intentHash(source, type, subject);
    const intent: ExtractedIntent = {
      intent_id: intentId,
      timestamp: now,
      source,
      source_ref: sourceRef,
      type,
      subject,
      contact: item.contact,
      due_hint: item.due_hint,
      verbatim: (item.verbatim ?? '').slice(0, 200),
      confidence,
      status: 'open',
    };
    intents.push(intent);
  }

  // Dedup and write
  let newCount = 0;
  let dupCount = 0;
  const toWrite: ExtractedIntent[] = [];

  for (const intent of intents) {
    if (existingIds.has(intent.intent_id)) {
      dupCount++;
    } else {
      toWrite.push(intent);
      newCount++;
    }
  }

  if (toWrite.length > 0) {
    fs.mkdirSync(dataDir, { recursive: true });
    const lines = toWrite.map((i) => JSON.stringify(i)).join('\n') + '\n';
    fs.appendFileSync(queuePath, lines);
  }

  return { intents: toWrite, newCount, dupCount, skippedLow };
}

// ── Queue management ──────────────────────────────────────────────────────────

export function getOpenIntents(dataDir: string): ExtractedIntent[] {
  const queuePath = path.join(dataDir, QUEUE_FILENAME);
  if (!fs.existsSync(queuePath)) return [];

  const lines = fs.readFileSync(queuePath, 'utf8').split('\n').filter((l) => l.trim());
  const intents: ExtractedIntent[] = [];

  for (const line of lines) {
    try {
      const intent = JSON.parse(line) as ExtractedIntent;
      if (intent.status === 'open') intents.push(intent);
    } catch {
      // skip malformed lines
    }
  }

  return intents.sort((a, b) => b.confidence - a.confidence);
}

export function resolveIntent(
  dataDir: string,
  intentId: string,
  status: 'done' | 'dismissed',
): boolean {
  const queuePath = path.join(dataDir, QUEUE_FILENAME);
  if (!fs.existsSync(queuePath)) return false;

  const lines = fs.readFileSync(queuePath, 'utf8').split('\n');
  let found = false;
  const updated = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const intent = JSON.parse(line) as ExtractedIntent;
      if (intent.intent_id === intentId) {
        found = true;
        return JSON.stringify({ ...intent, status, resolved_at: new Date().toISOString() });
      }
    } catch {
      // skip
    }
    return line;
  });

  if (found) {
    fs.writeFileSync(queuePath, updated.join('\n'));
  }
  return found;
}

export function getIntentSummary(dataDir: string): string {
  const open = getOpenIntents(dataDir);
  if (open.length === 0) return '';

  const lines = [`Open intents (${open.length}):`];
  for (const intent of open.slice(0, 10)) {
    const due = intent.due_hint ? ` [due: ${intent.due_hint}]` : '';
    const contact = intent.contact ? ` (re: ${intent.contact})` : '';
    lines.push(`  [${intent.type}]${contact} ${intent.subject}${due}`);
  }
  if (open.length > 10) lines.push(`  ... and ${open.length - 10} more`);
  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function intentHash(source: string, type: string, subject: string): string {
  return crypto
    .createHash('sha1')
    .update(`${source}|${type}|${subject.toLowerCase()}`)
    .digest('hex')
    .slice(0, 12);
}

function loadExistingIds(queuePath: string): Set<string> {
  if (!fs.existsSync(queuePath)) return new Set();
  const lines = fs.readFileSync(queuePath, 'utf8').split('\n').filter((l) => l.trim());
  const ids = new Set<string>();
  for (const line of lines) {
    try {
      const intent = JSON.parse(line) as ExtractedIntent;
      ids.add(intent.intent_id);
    } catch {
      // skip
    }
  }
  return ids;
}
