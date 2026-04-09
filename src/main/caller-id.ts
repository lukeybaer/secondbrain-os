// caller-id.ts
// Caller identification and context system for inbound calls.
//
// How it works:
//   1. Luke's main number → full access, no verification
//   2. Unknown number + "Gunther" keyword in conversation → full access
//   3. Known contact (matched by phone) → contact-scoped access
//   4. Unknown caller → restricted mode (message-taking only)
//
// Contacts are stored in %APPDATA%\secondbrain\data\agent\contacts.json
// and synced to EC2 via /sync endpoint.

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { getConfig } from './config';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Contact {
  name: string;
  phones?: string[]; // normalized E.164 format (+1XXXXXXXXXX)
  emails?: string[];
  relationship: string; // e.g. "BAI co-founder, mentor"
  style: string; // e.g. "casual, warm, collaborative"
  active_goals: string[]; // e.g. ["ITM investor outreach", "BAI strategy"]
  ok_topics: string[]; // topics Amy can discuss with this contact
  restricted_topics: string[];
  notes?: string; // additional context for Amy
}

export interface ContactsStore {
  owner_phones: string[]; // Luke's verified numbers — full access
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
  return {
    owner_phones: ['+19038410578'],
    keyword: 'Gunther',
    contacts: getInitialContacts(),
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

  // Check if it's Luke's number
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
  const config = getConfig();
  const store = loadContactsStore();
  return {
    mode: 'owner',
    systemPromptSection: `## Caller Identification: OWNER
This is Luke calling. Give full access to all systems, data, and capabilities.
If asked to verify identity and the caller cannot confirm the keyword ("${store.keyword}"), maintain polite skepticism but continue helping — Luke may not remember the keyword.
Use Luke's preferred communication style: direct, no filler, get to the point.`,
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

  const systemPromptSection = `## Caller Identification: KNOWN CONTACT
The caller is **${contact.name}** (${contact.relationship}).
Communication style: ${contact.style}
Greet them by name warmly.

### Active goals with Luke:
${goalsList}

### Topics OK to discuss with this caller:
${okTopicsList}

### Compartmentalization rules:
- NEVER share information about Luke's other contacts, their personal details, or their projects
- NEVER share Luke's personal finances, home address, or other contacts' phone numbers
- Only discuss topics within the "ok_topics" list above
- If asked about anything outside scope: "I'd need to check with Luke on that. Can I have him get back to you?"
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
  return {
    mode: 'unknown',
    systemPromptSection: `## Caller Identification: UNKNOWN
This caller is not in Luke's contact list.

STRICT RULES FOR UNKNOWN CALLERS:
- Ask "Who's calling please?" if they haven't said
- Take a message: name, callback number, and what it's about
- Offer to slot them into Luke's calendar when he has availability
- Tell them you'll have Luke get back to them
- Do NOT share: Luke's address, schedule details, other contact names, project names, or any personal information
- Do NOT discuss any ongoing projects or business matters
- If they say they're Luke calling from a different number, ask them to confirm the access keyword ("${store.keyword}") before granting full access
- If they provide the correct keyword, treat as owner with full access`,
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

// ── Initial contact seed ──────────────────────────────────────────────────────

function getInitialContacts(): Contact[] {
  return [
    {
      name: 'Ed Evans',
      phones: ['+19492440350'],
      emails: ['ed@yellowbricktechnology.com', 'ed.evans@benefitsallin.com'],
      relationship: 'BAI/ITM co-founder, mentor, Harvard, Moab UT',
      style: 'warm, direct, faith-forward, collaborative',
      active_goals: [
        'ITM app launch and investor outreach',
        'BAI strategy and product development',
        'Modern Recruiter roadmap',
        'Red Headed Hostess LDS curriculum platform',
      ],
      ok_topics: [
        'BAI',
        'ITM',
        'Modern Recruiter',
        'tech strategy',
        'Harvard',
        'faith',
        'recovery',
      ],
      restricted_topics: [
        "other contacts' personal info",
        "Luke's personal finances",
        "Yanli's immigration status",
      ],
      notes:
        'Warm relationship — Ed is a co-founder and close friend. He holds 70% of BAI, Luke 30%. LDS faith, in long-term recovery, sponsors people in AA. Completing Harvard masters May 2026.',
    },
    {
      name: 'Bryant Haines',
      phones: ['+12563664479'],
      emails: ['bryant@si3.io', 'bryant@pixseat.com'],
      relationship: 'PixSeat co-founder, systems architect',
      style: 'casual, enthusiastic, Christian, tech-forward',
      active_goals: [
        'PixSeat iOS app submission and launch',
        'PixSeat investor/customer conversations',
      ],
      ok_topics: ['PixSeat', 'tech architecture', 'defense', 'venue display', 'business strategy'],
      restricted_topics: [
        "other contacts' personal info",
        'BAI/ITM details',
        "Luke's personal finances",
      ],
      notes:
        'Bryant is a top-secret cleared systems architect with 25+ years DoD experience. 11 kids. Lives in Nashville. Very warm relationship — says "I thank the Lord for you!" to Luke.',
    },
    {
      name: 'Abdullah Zubair',
      phones: [],
      emails: ['abdul.zeedo@gmail.com'],
      relationship: 'CTO of ITM, "most talented engineer Luke has ever met"',
      style: 'collaborative, deep technical, faith-aware (Muslim)',
      active_goals: [
        'ITM technical architecture and launch',
        'Modern Recruiter app development',
        'ITM investor deck and outreach',
      ],
      ok_topics: [
        'ITM',
        'Modern Recruiter',
        'AWS architecture',
        'tech strategy',
        'product roadmap',
      ],
      restricted_topics: [
        "other contacts' personal info",
        "Luke's personal finances",
        'PixSeat details',
        'BAI details beyond ITM',
      ],
      notes:
        'Works at Amazon as day job. Available evenings EST 6-9pm and weekend mornings. Identified as top 25 graduating students in Italy (Alfiere del Lavoro award). Has a 4yo daughter.',
    },
    {
      name: 'Peter Millar',
      phones: [],
      emails: [],
      relationship: "Luke's dad (step-father), truck driver",
      style: 'warm, spiritual, deep Christian faith, calls regularly',
      active_goals: [
        'Regular faith conversations and discipleship',
        'Book of Sermons project — recording and collecting teachings',
      ],
      ok_topics: ['faith', 'scripture', 'family', 'theology', 'trucking life', 'personal matters'],
      restricted_topics: ["Luke's business financials", "other contacts' personal info"],
      notes:
        "Truck driver at PGEM Trucking. Wife Erna travels with him. Deep Christian faith — explores Ethiopian Bible, Book of Enoch. Amy should be respectful of his faith and warm. Luke records Peter's teachings for a Book of Sermons project.",
    },
    {
      name: 'Yanli Baer',
      phones: [],
      emails: [],
      relationship: "Luke's wife",
      style: 'warm, direct, scientist background',
      active_goals: ['job search in data analytics/science', 'EB-1A green card application'],
      ok_topics: ['personal matters', 'family', 'schedule', 'job search', 'home'],
      restricted_topics: [
        "Luke's business financials",
        "other contacts' personal details",
        'immigration case specifics unless she brings them up',
      ],
      notes:
        "Yanli Lyu, PhD. Luke's wife. Immigrating on EB-1A track. She is Luke's #1 priority. Amy should be very warm and helpful with her. If she calls, treat it as a high-priority personal call.",
    },
    {
      name: 'John Wilkinson',
      phones: [],
      emails: [],
      relationship: 'Contact — scheduling context available',
      style: 'professional',
      active_goals: [],
      ok_topics: ['scheduling', 'business', 'general conversation'],
      restricted_topics: ["other contacts' personal info", "Luke's personal finances"],
      notes:
        'Scheduling constraint: evenings are challenging due to family (gymnastics Tuesdays and Thursdays). When scheduling with John, prefer daytime or lunch meetings. Avoid evenings, especially Tue/Thu.',
    },
  ];
}
