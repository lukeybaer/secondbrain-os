// ingest-hooks.ts
// Centralized post-ingest hooks for ALL data sources in SecondBrain.
// Every ingest path (Otter, WhatsApp, SMS, calls, Telegram, briefings, chat)
// calls these hooks after saving raw data. This ensures:
//   1. Graphiti gets every piece of data (temporal knowledge graph)
//   2. Canonical memory files get updated (contact enrichment)
//   3. Working memory gets a recency entry (Tier 1 Hebbian)
//
// Wired in as of 2026-04-04 to close the gap where Graphiti and memory
// were only fed from Claude Code sessions and the 4 AM nightly sync.

import { addEpisode } from './graphiti-client';
import { appendWorkingMemory } from './memory-index';

// ── Types ────────────────────────────────────────────────────────────────────

export interface IngestEvent {
  /** Human-readable name for the episode (e.g., "WhatsApp from Sandeep") */
  name: string;
  /** The actual content , transcript, message body, briefing text, etc. */
  body: string;
  /** Source tag for provenance tracking */
  source: IngestSource;
  /** Optional source ID for dedup (e.g., otter ID, message ID, call ID) */
  sourceId?: string;
  /** Contact phone number if applicable */
  phone?: string;
  /** Contact name if known */
  contactName?: string;
  /** When this data was created (defaults to now) */
  timestamp?: string;
}

export type IngestSource =
  | 'otter-transcript'
  | 'whatsapp-inbound'
  | 'whatsapp-outbound'
  | 'sms-inbound'
  | 'sms-outbound'
  | 'call-transcript'
  | 'call-outcome'
  | 'telegram-message'
  | 'briefing-daily'
  | 'briefing-evening'
  | 'chat-session'
  | 'gmail-inbound'
  | 'gmail-outbound'
  | 'linkedin-message'
  | 'linkedin-profile';

// ── Main hook ────────────────────────────────────────────────────────────────

/**
 * Post-ingest hook , call this after EVERY data save in SecondBrain.
 * Fire-and-forget: errors are logged but never block the caller.
 */
export function onDataIngested(event: IngestEvent): void {
  // All hooks are non-blocking , don't await, don't throw
  ingestToGraphiti(event).catch((err) =>
    console.warn(`[ingest-hook] Graphiti ingest failed for ${event.source}: ${err.message}`),
  );

  ingestToWorkingMemory(event);
}

// ── Graphiti hook ────────────────────────────────────────────────────────────

async function ingestToGraphiti(event: IngestEvent): Promise<void> {
  // Truncate body to 3000 chars (Graphiti's practical limit for entity extraction)
  const body = event.body.slice(0, 3000);
  if (body.length < 10) return; // skip trivially short content

  await addEpisode({
    name: event.name,
    episode_body: body,
    source_description: `${event.source}:${event.sourceId ?? 'unknown'}`,
    reference_time: event.timestamp ?? new Date().toISOString(),
    group_id: 'owner-ea',
  });
}

// ── Working memory hook (Tier 1 recency buffer) ─────────────────────────────

function ingestToWorkingMemory(event: IngestEvent): void {
  try {
    // One-liner for the 50-line recency buffer
    const contact = event.contactName || event.phone || 'unknown';
    const summary = event.body.slice(0, 80).replace(/\n/g, ' ');
    appendWorkingMemory(`[${event.source}] ${contact}: ${summary}`);
  } catch {
    // Non-critical , don't crash the ingest path
  }
}

// ── Convenience builders ─────────────────────────────────────────────────────

/** Build an IngestEvent from an Otter transcript. */
export function otterEvent(opts: {
  id: string;
  title: string;
  transcript: string;
  speakers?: string[];
  date?: string;
}): IngestEvent {
  return {
    name: `Otter: ${opts.title}`,
    body: opts.transcript,
    source: 'otter-transcript',
    sourceId: opts.id,
    timestamp: opts.date,
  };
}

/** Build an IngestEvent from a WhatsApp message. */
export function whatsappEvent(msg: {
  id: string;
  from: string;
  body: string;
  contactName?: string;
  source: 'inbound' | 'outbound';
  timestamp: string;
}): IngestEvent {
  const direction = msg.source === 'inbound' ? 'inbound' : 'outbound';
  return {
    name: `WhatsApp ${direction}: ${msg.contactName || msg.from}`,
    body: msg.body,
    source: direction === 'inbound' ? 'whatsapp-inbound' : 'whatsapp-outbound',
    sourceId: msg.id,
    phone: msg.from,
    contactName: msg.contactName,
    timestamp: msg.timestamp,
  };
}

/** Build an IngestEvent from an SMS message. */
export function smsEvent(msg: {
  id: string;
  from: string;
  to: string;
  body: string;
  source: 'inbound' | 'outbound';
  timestamp: string;
}): IngestEvent {
  const direction = msg.source === 'inbound' ? 'inbound' : 'outbound';
  return {
    name: `SMS ${direction}: ${msg.from}`,
    body: msg.body,
    source: direction === 'inbound' ? 'sms-inbound' : 'sms-outbound',
    sourceId: msg.id,
    phone: msg.source === 'inbound' ? msg.from : msg.to,
    timestamp: msg.timestamp,
  };
}

/** Build an IngestEvent from a completed phone call. */
export function callEvent(opts: {
  callId: string;
  phoneNumber: string;
  contactName?: string;
  transcript: string;
  outcome?: string;
  instructions?: string;
}): IngestEvent {
  const body = [
    opts.instructions ? `Goal: ${opts.instructions}` : '',
    opts.outcome ? `Outcome: ${opts.outcome}` : '',
    opts.transcript,
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    name: `Call: ${opts.contactName || opts.phoneNumber}`,
    body,
    source: 'call-transcript',
    sourceId: opts.callId,
    phone: opts.phoneNumber,
    contactName: opts.contactName,
  };
}

/** Build an IngestEvent from a briefing. */
export function briefingEvent(type: 'daily' | 'evening', text: string): IngestEvent {
  return {
    name: `${type === 'daily' ? 'Morning' : 'Evening'} Briefing`,
    body: text,
    source: type === 'daily' ? 'briefing-daily' : 'briefing-evening',
    sourceId: new Date().toISOString().slice(0, 10),
  };
}

/** Build an IngestEvent from a chat session. */
export function chatSessionEvent(opts: {
  sessionId: string;
  summary: string;
  transcript: string;
}): IngestEvent {
  return {
    name: `Chat session: ${opts.summary.slice(0, 60)}`,
    body: opts.transcript,
    source: 'chat-session',
    sourceId: opts.sessionId,
  };
}

// HTML to text helper. Used by gmailEvent so Graphiti's entity extractor sees
// plain prose, not anchor tags and CSS. Lightweight on purpose: there is no
// html-to-text dep in package.json and the email bodies we care about are
// rarely structured beyond paragraphs and links. If a future pass needs DOM
// fidelity, swap in a real parser, but keep the same signature.
export function stripHtmlToText(html: string): string {
  if (!html) return '';
  let s = html;
  // Drop scripts and styles entirely so embedded JS or CSS does not bleed in.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  // Replace block tags with newlines so paragraphs survive as line breaks.
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, '\n');
  s = s.replace(/<br\s*\/?>(?=)/gi, '\n');
  // Strip remaining tags.
  s = s.replace(/<[^>]+>/g, '');
  // Decode the most common HTML entities. The rest fall through as-is which
  // is fine for entity extraction.
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Collapse whitespace runs and trim.
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** Build an IngestEvent from a Gmail message. Body may be HTML. */
export function gmailEvent(opts: {
  messageId: string;
  threadId?: string;
  from: string;
  to?: string;
  subject: string;
  body: string;
  bodyIsHtml?: boolean;
  direction: 'inbound' | 'outbound';
  timestamp?: string;
  contactName?: string;
}): IngestEvent {
  const plain = opts.bodyIsHtml ? stripHtmlToText(opts.body) : opts.body;
  const headerLine = `From: ${opts.from}${opts.to ? ` | To: ${opts.to}` : ''} | Subject: ${opts.subject}`;
  const composed = `${headerLine}\n\n${plain}`;
  return {
    name: `Gmail ${opts.direction}: ${opts.subject.slice(0, 80) || '(no subject)'}`,
    body: composed,
    source: opts.direction === 'inbound' ? 'gmail-inbound' : 'gmail-outbound',
    sourceId: opts.messageId,
    contactName: opts.contactName,
    timestamp: opts.timestamp,
  };
}

/** Build an IngestEvent from a LinkedIn message or scraped profile snapshot. */
export function linkedinEvent(opts: {
  id: string;
  type: 'message' | 'profile';
  contactName: string;
  contactUrl?: string;
  body: string;
  timestamp?: string;
}): IngestEvent {
  const headerLine = opts.contactUrl
    ? `Contact: ${opts.contactName} (${opts.contactUrl})`
    : `Contact: ${opts.contactName}`;
  const composed = `${headerLine}\n\n${opts.body}`;
  return {
    name: `LinkedIn ${opts.type}: ${opts.contactName}`,
    body: composed,
    source: opts.type === 'message' ? 'linkedin-message' : 'linkedin-profile',
    sourceId: opts.id,
    contactName: opts.contactName,
    timestamp: opts.timestamp,
  };
}
