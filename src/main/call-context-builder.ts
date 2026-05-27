// call-context-builder.ts
//
// Letta recall-memory pattern applied to outbound Vapi calls. Before initiating
// a call, Amy pulls all relevant memory about the contact being called and
// injects it as enriched context into the Vapi assistant instructions.
//
// Current state: calls.ts passes raw task instructions to Vapi. The assistant
// knows the script but nothing about the person — their role, relationship to
// Luke, recent interactions, known preferences, or active context.
//
// This module closes that gap with a <120ms synchronous context build:
//   1. Look up the contact file by phone or name
//   2. Run entity graph search for the contact name across all memory
//   3. Pull the last 5 contact-event-sourcing entries for this contact
//   4. Return a formatted context block ready for Vapi instruction injection
//
// The enriched block goes into the [CALLER CONTEXT] section of the assistant
// system prompt — positioned before the call script so the model can use it
// to personalize the call without changing the script structure.
//
// Reference: Letta recall-memory pattern (letta-ai/letta, v0.17.0, April 2025):
// "Before each interaction, query recall memory for relevant past context
// to give the agent a coherent relationship history instead of a blank slate."

import * as fs from 'fs';
import * as path from 'path';
import { getEntityGraph } from './entity-memory-graph';
import { getContactTimeline, daysSinceContact } from './contact-event-sourcing';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ContactContext {
  contactName: string;
  relationshipSummary: string;    // 1-2 sentences from the contact file frontmatter/top
  recentInteractions: string[];   // last 5 events from contact-event-sourcing
  daysSinceLastContact: number | null;
  memoryMentions: string[];       // up to 5 excerpts from entity graph search
  talkingPoints: string[];        // extracted from contact file "## Notes" or "## Context"
  rawBlock: string;               // formatted block for Vapi injection
}

export interface CallContextOptions {
  memoryDir: string;              // path to secondbrain/memory/
  contactEventsPath: string;      // path to data/agent/contact-events.jsonl
  maxMemoryMentions?: number;     // default 5
  maxRecentEvents?: number;       // default 5
}

// ── Main function ─────────────────────────────────────────────────────────────

export async function buildCallContext(
  contactNameOrPhone: string,
  opts: CallContextOptions,
): Promise<ContactContext | null> {
  const {
    memoryDir,
    contactEventsPath,
    maxMemoryMentions = 5,
    maxRecentEvents = 5,
  } = opts;

  // 1. Find the contact file
  const contactFile = findContactFile(contactNameOrPhone, memoryDir);
  const contactName = resolveContactName(contactNameOrPhone, contactFile);

  // 2. Load relationship summary from contact file
  const { summary, talkingPoints } = loadContactFile(contactFile);

  // 3. Entity graph mentions across all memory
  const graph = getEntityGraph(memoryDir);
  if (!graph.stats().builtAt) {
    await graph.build();
  }
  const searchResults = graph.search(contactName, maxMemoryMentions);
  const memoryMentions = searchResults.flatMap((r) =>
    r.entity.mentions.slice(0, 2).map((m) => `[${m.relPath}:${m.lineNumber}] ${m.excerpt.trim()}`)
  ).slice(0, maxMemoryMentions);

  // 4. Recent contact events (getContactTimeline uses slug, not display name)
  const contactSlug = nameToSlug(contactFile
    ? path.basename(contactFile, '.md')
    : contactName);
  const timeline = getContactTimeline(contactEventsPath, contactSlug);
  const recentInteractions = timeline.events
    .slice(-maxRecentEvents)
    .map((e) => {
      const date = new Date(e.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `${date} — ${e.event_type.replace(/_/g, ' ')}: ${e.summary}`;
    })
    .reverse(); // newest first

  const staleness = daysSinceContact(contactEventsPath, contactSlug);

  // 5. Format the block
  const rawBlock = formatContextBlock({
    contactName,
    relationshipSummary: summary,
    recentInteractions,
    daysSinceLastContact: staleness,
    memoryMentions,
    talkingPoints,
  });

  return {
    contactName,
    relationshipSummary: summary,
    recentInteractions,
    daysSinceLastContact: staleness,
    memoryMentions,
    talkingPoints,
    rawBlock,
  };
}

// ── Format for Vapi injection ─────────────────────────────────────────────────

function formatContextBlock(ctx: Omit<ContactContext, 'rawBlock'>): string {
  const lines: string[] = ['[CALLER CONTEXT — use this to personalize the conversation]'];

  lines.push(`Contact: ${ctx.contactName}`);

  if (ctx.daysSinceLastContact !== null) {
    const days = ctx.daysSinceLastContact;
    lines.push(
      days === 0
        ? 'Last contact: today'
        : days === 1
        ? 'Last contact: yesterday'
        : `Last contact: ${days} days ago`,
    );
  } else {
    lines.push('Last contact: unknown (no interaction history)');
  }

  if (ctx.relationshipSummary) {
    lines.push('');
    lines.push('Relationship summary:');
    lines.push(ctx.relationshipSummary);
  }

  if (ctx.talkingPoints.length > 0) {
    lines.push('');
    lines.push('Context / notes:');
    ctx.talkingPoints.forEach((p) => lines.push(`  - ${p}`));
  }

  if (ctx.recentInteractions.length > 0) {
    lines.push('');
    lines.push('Recent interactions:');
    ctx.recentInteractions.forEach((i) => lines.push(`  - ${i}`));
  }

  if (ctx.memoryMentions.length > 0) {
    lines.push('');
    lines.push('Memory references:');
    ctx.memoryMentions.forEach((m) => lines.push(`  ${m}`));
  }

  lines.push('');
  lines.push('[END CALLER CONTEXT]');
  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Contact file helpers ──────────────────────────────────────────────────────

function findContactFile(nameOrPhone: string, memoryDir: string): string | null {
  const contactsDir = path.join(memoryDir, 'contacts');
  if (!fs.existsSync(contactsDir)) return null;

  const slug = nameOrPhone
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Direct slug match
  const slugPath = path.join(contactsDir, `${slug}.md`);
  if (fs.existsSync(slugPath)) return slugPath;

  // Fuzzy: scan all contact files for a phone or name match
  const files = fs.readdirSync(contactsDir).filter((f) => f.endsWith('.md'));
  const phoneNorm = nameOrPhone.replace(/\D/g, '');

  for (const f of files) {
    const full = path.join(contactsDir, f);
    const content = fs.readFileSync(full, 'utf8');
    const nameLower = nameOrPhone.toLowerCase();

    // Check if the name appears in the first 20 lines
    const head = content.split('\n').slice(0, 20).join(' ').toLowerCase();
    if (head.includes(nameLower)) return full;

    // Phone match
    if (phoneNorm.length >= 7) {
      const contentPhones = content.replace(/\D/g, '');
      if (contentPhones.includes(phoneNorm.slice(-7))) return full;
    }
  }

  return null;
}

function resolveContactName(input: string, contactFile: string | null): string {
  if (!contactFile) return input;

  // Extract name from frontmatter or first H1
  const content = fs.readFileSync(contactFile, 'utf8');
  const nameMatch = content.match(/^name:\s*(.+)$/m) || content.match(/^#\s+(.+)$/m);
  if (nameMatch) return nameMatch[1].trim();

  // Fall back to file basename
  return path.basename(contactFile, '.md').replace(/-/g, ' ');
}

function loadContactFile(filePath: string | null): {
  summary: string;
  talkingPoints: string[];
} {
  if (!filePath || !fs.existsSync(filePath)) {
    return { summary: 'No contact file found.', talkingPoints: [] };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  // Extract frontmatter description or first paragraph as summary
  let summary = '';
  const descMatch = content.match(/^description:\s*(.+)$/m);
  if (descMatch) {
    summary = descMatch[1].trim();
  } else {
    // First non-empty, non-header, non-frontmatter paragraph
    let inFrontmatter = false;
    for (const line of lines) {
      if (line.trim() === '---') {
        inFrontmatter = !inFrontmatter;
        continue;
      }
      if (inFrontmatter) continue;
      if (line.startsWith('#')) continue;
      if (line.trim().length > 20) {
        summary = line.trim().slice(0, 300);
        break;
      }
    }
  }

  // Extract talking points from ## Notes, ## Context, ## Key Notes sections
  const talkingPoints: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+(Notes|Context|Key Notes|Background|Summary)/i.test(line)) {
      inSection = true;
      continue;
    }
    if (line.startsWith('##') && inSection) {
      inSection = false;
      continue;
    }
    if (inSection && line.trim().startsWith('-')) {
      const point = line.trim().replace(/^-\s+/, '').slice(0, 120);
      if (point.length > 5) talkingPoints.push(point);
    }
    if (talkingPoints.length >= 6) break;
  }

  return { summary, talkingPoints };
}
