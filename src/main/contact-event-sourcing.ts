// contact-event-sourcing.ts
//
// Append-only event stream for contact interactions.
//
// Problem: Contact files (memory/contacts/*.md) have a "## History" section
// with free-text date entries, but there's no machine-readable log of *when*
// Amy last interacted with each contact. The warmth-audit script estimates
// staleness by reading the history text, but that's parsing prose — fragile
// and slow. There's no way to ask "give me all contacts Amy emailed in the
// last 7 days" without reading every contact file.
//
// Solution: An append-only JSONL event log at data/agent/contact-events.jsonl.
// Every interaction (email, call, task, profile update, enrichment) appends
// a typed event. State queries (daysSinceContact, getContactsGoingCold) run
// against this log rather than scraping markdown files.
//
// Pattern: CQRS/event sourcing applied to contact management. The contact
// .md files remain as the human-readable view (the "read model"). The JSONL
// log is the write model — immutable facts ordered by time. If the log is
// lost it can be reconstructed from the History sections in contact files
// (which function as a snapshot). New interactions flow through this module
// first, then get reflected into the contact .md as a History entry by the
// caller.
//
// Usage:
//   import { appendContactEvent, daysSinceContact, getContactsGoingCold } from './contact-event-sourcing';
//   appendContactEvent({ eventsPath, slug: 'jane_doe', contactName: 'Jane Doe',
//     eventType: 'email_sent', summary: 'Sent quote request', source: 'gmail' });
//   const days = daysSinceContact(eventsPath, 'jane_doe'); // e.g. 3
//   const cold = getContactsGoingCold(eventsPath, 30); // contacts silent for 30+ days

import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ContactEventType =
  | 'email_sent'        // Amy/Luke sent an email to the contact
  | 'email_received'    // email received from the contact
  | 'call_placed'       // outbound call placed to the contact
  | 'call_received'     // inbound call from the contact
  | 'task_completed'    // a task involving this contact was completed
  | 'profile_updated'   // contact .md file was updated
  | 'enrichment_added'  // new context extracted from Gmail/Otter/LinkedIn
  | 'meeting_scheduled' // meeting created or rescheduled
  | 'note_added';       // manual note added by Luke or Amy

export interface ContactEvent {
  event_id: string;           // YYYYMMDDTHHMMSS_slug_type (human-sortable, no crypto dep)
  timestamp: string;          // ISO 8601
  slug: string;               // contact file slug (e.g. "jane_doe")
  contact_name: string;       // display name
  event_type: ContactEventType;
  summary: string;            // 1-2 sentence description of the event
  source: string;             // e.g. "gmail", "vapi", "otter", "manual", "linkedin"
  metadata?: Record<string, string | number | boolean>;
}

export interface ContactTimeline {
  slug: string;
  contact_name: string;
  events: ContactEvent[];
  daysSinceLastContact: number | null;  // null if no events
  lastEventType: ContactEventType | null;
  lastEventAt: string | null;           // ISO 8601
}

export interface ColdContact {
  slug: string;
  contact_name: string;
  daysSince: number;
  lastEventType: ContactEventType | null;
  lastEventAt: string | null;
}

// ── Append ────────────────────────────────────────────────────────────────────

export interface AppendContactEventInput {
  eventsPath: string;
  slug: string;
  contactName: string;
  eventType: ContactEventType;
  summary: string;
  source: string;
  metadata?: Record<string, string | number | boolean>;
  timestamp?: string;  // defaults to now
}

export function appendContactEvent(input: AppendContactEventInput): ContactEvent {
  const ts = input.timestamp ?? new Date().toISOString();
  const tsCompact = ts.replace(/[-:]/g, '').slice(0, 15); // YYYYMMDDTHHMMSS
  const event_id = `${tsCompact}_${input.slug}_${input.eventType}`;

  const event: ContactEvent = {
    event_id,
    timestamp: ts,
    slug: input.slug,
    contact_name: input.contactName,
    event_type: input.eventType,
    summary: input.summary,
    source: input.source,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };

  fs.mkdirSync(path.dirname(input.eventsPath), { recursive: true });
  fs.appendFileSync(input.eventsPath, JSON.stringify(event) + '\n', 'utf8');
  return event;
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function loadAllEvents(eventsPath: string): ContactEvent[] {
  if (!fs.existsSync(eventsPath)) return [];
  const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter((l) => l.trim());
  const events: ContactEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as ContactEvent);
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

export function getContactTimeline(
  eventsPath: string,
  slug: string,
  limit: number = 50,
): ContactTimeline {
  const all = loadAllEvents(eventsPath);
  const events = all
    .filter((e) => e.slug === slug)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-limit);

  const last = events.length > 0 ? events[events.length - 1] : null;
  const daysSinceLastContact = last
    ? Math.floor((Date.now() - new Date(last.timestamp).getTime()) / 86400000)
    : null;

  return {
    slug,
    contact_name: last?.contact_name ?? slug,
    events,
    daysSinceLastContact,
    lastEventType: last?.event_type ?? null,
    lastEventAt: last?.timestamp ?? null,
  };
}

export function daysSinceContact(eventsPath: string, slug: string): number | null {
  return getContactTimeline(eventsPath, slug).daysSinceLastContact;
}

// ── Cold contact detection ────────────────────────────────────────────────────

/** Returns contacts with no events in the last `thresholdDays` days, sorted by staleness. */
export function getContactsGoingCold(
  eventsPath: string,
  thresholdDays: number = 30,
): ColdContact[] {
  const all = loadAllEvents(eventsPath);
  if (all.length === 0) return [];

  const cutoff = Date.now() - thresholdDays * 86400000;

  // Build most-recent-event per slug
  const latestBySlug = new Map<string, ContactEvent>();
  for (const e of all) {
    const existing = latestBySlug.get(e.slug);
    if (!existing || e.timestamp > existing.timestamp) {
      latestBySlug.set(e.slug, e);
    }
  }

  const cold: ColdContact[] = [];
  for (const [slug, latest] of latestBySlug) {
    const lastTs = new Date(latest.timestamp).getTime();
    if (lastTs < cutoff) {
      const daysSince = Math.floor((Date.now() - lastTs) / 86400000);
      cold.push({
        slug,
        contact_name: latest.contact_name,
        daysSince,
        lastEventType: latest.event_type,
        lastEventAt: latest.timestamp,
      });
    }
  }

  return cold.sort((a, b) => b.daysSince - a.daysSince);
}

// ── History line parser ───────────────────────────────────────────────────────

// Parse a history line from a contact .md file into a ContactEvent.
// History lines look like:
//   "- 2026-04-23 02:52 (Gmail): Luke sent farm quote..."
//   "- 2026-04-13 (Gmail): Joe responded..."

const HISTORY_LINE_RE =
  /^-\s+(\d{4}-\d{2}-\d{2}(?:\s+[\d:]+)?)\s+(?:\(([^)]+)\):\s*)?(.+)$/;

export function parseHistoryLine(
  line: string,
  slug: string,
  contactName: string,
): Omit<ContactEvent, 'event_id'> | null {
  const match = line.match(HISTORY_LINE_RE);
  if (!match) return null;

  const dateStr = match[1].trim();
  const source = (match[2] ?? 'manual').toLowerCase();
  const summary = match[3].trim();

  // Parse the date; if no time, default to noon
  const ts = new Date(dateStr.includes(' ') ? dateStr : `${dateStr}T12:00:00`);
  if (isNaN(ts.getTime())) return null;

  // Infer event type from source and summary keywords
  const eventType = inferEventType(source, summary);

  return {
    timestamp: ts.toISOString(),
    slug,
    contact_name: contactName,
    event_type: eventType,
    summary,
    source,
  };
}

function inferEventType(source: string, summary: string): ContactEventType {
  const lower = summary.toLowerCase();
  if (source === 'vapi' || lower.includes('called') || lower.includes('call ')) {
    if (lower.includes('inbound') || lower.includes('answered') || lower.includes('received')) {
      return 'call_received';
    }
    return 'call_placed';
  }
  if (source === 'gmail' || source === 'email') {
    if (lower.includes('replied') || lower.includes('responded') || lower.includes('sent')) {
      return lower.includes('luke sent') || lower.includes('amy sent') ? 'email_sent' : 'email_received';
    }
    return lower.includes('luke') || lower.includes('amy') ? 'email_sent' : 'email_received';
  }
  if (source === 'linkedin') return 'enrichment_added';
  if (source === 'otter') return 'enrichment_added';
  return 'note_added';
}

// ── Bulk import from contact files ───────────────────────────────────────────

/**
 * Scan all contact .md files and import History lines into the events log.
 * Deduplicates by event_id so safe to run multiple times.
 * Returns the number of events imported.
 */
export function importContactHistories(
  contactsDir: string,
  eventsPath: string,
): { imported: number; skipped: number } {
  const existing = new Set(loadAllEvents(eventsPath).map((e) => e.event_id));

  let imported = 0;
  let skipped = 0;

  const files = fs.existsSync(contactsDir)
    ? fs.readdirSync(contactsDir).filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    : [];

  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const content = fs.readFileSync(path.join(contactsDir, file), 'utf8');
    const contactName = extractContactName(content) ?? slug;

    const historyIdx = content.indexOf('## History');
    if (historyIdx === -1) continue;

    const historySection = content.slice(historyIdx);
    const lines = historySection.split('\n').slice(1); // skip "## History" line

    for (const line of lines) {
      if (!line.trim().startsWith('-')) continue;
      const parsed = parseHistoryLine(line, slug, contactName);
      if (!parsed) continue;

      const tsCompact = parsed.timestamp.replace(/[-:]/g, '').slice(0, 15);
      const event_id = `${tsCompact}_${slug}_${parsed.event_type}`;
      if (existing.has(event_id)) { skipped++; continue; }

      const event: ContactEvent = { event_id, ...parsed };
      fs.appendFileSync(eventsPath, JSON.stringify(event) + '\n', 'utf8');
      existing.add(event_id);
      imported++;
    }
  }

  return { imported, skipped };
}

function extractContactName(content: string): string | null {
  // From frontmatter: "name: Jane Doe"
  const fm = content.match(/^---\n([\s\S]*?)\n---/m);
  if (fm) {
    const nameLine = fm[1].split('\n').find((l) => l.startsWith('name:'));
    if (nameLine) return nameLine.replace(/^name:\s*/, '').trim();
  }
  // From first heading: "# Jane Doe"
  const h1 = content.match(/^#\s+(.+)$/m);
  return h1 ? h1[1].trim() : null;
}
