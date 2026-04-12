// caller-id.ts
// Caller identification and context system for inbound calls.
//
// How it works:
//   1. Owner's verified number  →  full access, no verification
//   2. Unknown number + correct keyword in conversation → full access
//   3. Known contact (matched by phone) → contact-scoped access
//   4. Unknown caller → restricted mode (message-taking only)
//
// Owner phones, verification keyword, and contacts are loaded from
// %APPDATA%\secondbrain\data\agent\contacts.json at runtime. That file
// is private user state — it MUST NOT be committed to git or shipped
// in any source file. Historically this module had a hardcoded default
// registry with real phone numbers, relationships, and personal notes,
// which leaked to the public sync until 2026-04-11. Stripped entirely.
// See memory/feedback_no_pii_in_source.md for the rule.

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { getConfig } from './config';

// Owner display name read from config.ownerName (defaulted to "the owner")
// so no personal name is hardcoded in the system prompts this file builds.
function getOwnerName(): string {
  return getConfig().ownerName?.trim() || 'the owner';
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Contact {
  name: string;
  phones?: string[]; // normalized E.164 format (+1XXXXXXXXXX)
  emails?: string[];
  relationship: string; // e.g. "ProjectB co-founder, mentor"
  style: string; // e.g. "casual, warm, collaborative"
  active_goals: string[]; // e.g. ["ITM investor outreach", "ProjectB strategy"]
  ok_topics: string[]; // topics Amy can discuss with this contact
  restricted_topics: string[];
  notes?: string; // additional context for Amy
}

export interface ContactsStore {
  owner_phones: string[]; // Owner's verified numbers — full access
  keyword: string; // spoken keyword that grants full access from unknown number
  contacts: Contact[];
  last_updated: string;
}

export type CallerMode = 'owner' | 'known_contact' | 'unknown';

export interface CallerContext {
  mode: CallerMode;
  contact?: Contact;
  systemPromptSection: string;
}

// ── Storage ───────────────────────────────────────────────────────────────────

function getContactsPath(): string {
  return path.join(app.getPath('userData'), 'data', 'agent', 'contacts.json');
}

export function loadContactsStore(): ContactsStore {
  const filePath = getContactsPath();
  if (!fs.existsSync(filePath)) {
    return getDefaultContactsStore();
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ContactsStore;
  } catch {
    return getDefaultContactsStore();
  }
}

export function saveContactsStore(store: ContactsStore): void {
  const filePath = getContactsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
}

function getDefaultContactsStore(): ContactsStore {
  // Fresh-install default. On an active machine the runtime store at
  // %APPDATA%\secondbrain\data\agent\contacts.json takes precedence via
  // loadContactsStore(), so this only fires on a clean clone / first run.
  // Historically this returned a hardcoded seed with real names, phone
  // numbers, and personal details, which shipped to the public repo as
  // part of src/. Stripped 2026-04-11 — users populate contacts.json
  // themselves. See memory/feedback_no_pii_in_source.md for the rule.
  return {
    owner_phones: [],
    keyword: '',
    contacts: [],
    last_updated: new Date().toISOString(),
  };
}

// ── Phone normalization ───────────────────────────────────────────────────────

function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '');
  if (raw.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

function phonesMatch(a: string, b: string): boolean {
  return normalizePhone(a) === normalizePhone(b);
}

// ── Caller lookup ─────────────────────────────────────────────────────────────

export function identifyCaller(callerPhone: string): CallerContext {
  if (!callerPhone) {
    return buildUnknownContext();
  }

  const store = loadContactsStore();

  // Check if it's the owner's number
  for (const ownerPhone of store.owner_phones) {
    if (phonesMatch(callerPhone, ownerPhone)) {
      return buildOwnerContext();
    }
  }

  // Check known contacts
  const normalized = normalizePhone(callerPhone);
  for (const contact of store.contacts) {
    for (const phone of contact.phones ?? []) {
      if (phonesMatch(phone, normalized)) {
        return buildContactContext(contact);
      }
    }
  }

  return buildUnknownContext();
}

// ── Context builders ──────────────────────────────────────────────────────────

function buildOwnerContext(): CallerContext {
  const store = loadContactsStore();
  const owner = getOwnerName();
  const kw = store.keyword || '';
  return {
    mode: 'owner',
    systemPromptSection: `## Caller Identification: OWNER
This is ${owner} calling. Give full access to all systems, data, and capabilities.
${kw ? `If asked to verify identity and the caller cannot confirm the keyword ("${kw}"), maintain polite skepticism but continue helping.` : ''}
Use ${owner}'s preferred communication style.`,
  };
}

function buildContactContext(contact: Contact): CallerContext {
  const goalsList =
    contact.active_goals.length > 0
      ? contact.active_goals.map((g) => `  - ${g}`).join('\n')
      : '  - (no active goals on file)';
  const okTopicsList =
    contact.ok_topics.length > 0
      ? contact.ok_topics.map((t) => `  - ${t}`).join('\n')
      : '  - general conversation';

  const owner = getOwnerName();
  const systemPromptSection = `## Caller Identification: KNOWN CONTACT
The caller is **${contact.name}** (${contact.relationship}).
Communication style: ${contact.style}
Greet them by name warmly.

### Active goals with ${owner}:
${goalsList}

### Topics OK to discuss with this caller:
${okTopicsList}

### Compartmentalization rules:
- NEVER share information about ${owner}'s other contacts, their personal details, or their projects
- NEVER share ${owner}'s personal finances, home address, or other contacts' phone numbers
- Only discuss topics within the "ok_topics" list above
- If asked about anything outside scope: "I'd need to check with ${owner} on that. Can I have ${owner} get back to you?"
${contact.notes ? `\n### Additional context:\n${contact.notes}` : ''}

If there's an active goal involving this caller, engage fully on that goal. When the goal is resolved, revert to message-taking mode and offer to schedule a callback for anything else.`;

  return {
    mode: 'known_contact',
    contact,
    systemPromptSection,
  };
}

function buildUnknownContext(): CallerContext {
  const store = loadContactsStore();
  const owner = getOwnerName();
  const kw = store.keyword || '';
  return {
    mode: 'unknown',
    systemPromptSection: `## Caller Identification: UNKNOWN
This caller is not in ${owner}'s contact list.

STRICT RULES FOR UNKNOWN CALLERS:
- Ask "Who's calling please?" if they haven't said
- Take a message: name, callback number, and what it's about
- Offer to slot them into ${owner}'s calendar when there's availability
- Tell them you'll have ${owner} get back to them
- Do NOT share: ${owner}'s address, schedule details, other contact names, project names, or any personal information
- Do NOT discuss any ongoing projects or business matters
${kw ? `- If they say they're ${owner} calling from a different number, ask them to confirm the access keyword ("${kw}") before granting full access\n- If they provide the correct keyword, treat as owner with full access` : ''}`,
  };
}

// ── System prompt injection ───────────────────────────────────────────────────

/**
 * Inject caller identification context into a Vapi system prompt.
 * Place this section prominently near the top so the LLM sees it first.
 */
export function injectCallerContext(basePrompt: string, callerPhone: string): string {
  const ctx = identifyCaller(callerPhone);
  return `${ctx.systemPromptSection}\n\n---\n\n${basePrompt}`;
}

// Initial contact seed was here. It hardcoded real names, phones, emails,
// relationships, immigration status, family details, and employer info
// directly in source. That data shipped to the public OS repo sync until
// 2026-04-11. Removed entirely. The runtime store at
// %APPDATA%\secondbrain\data\agent\contacts.json is the canonical owner
// of this data and is never committed to git.
