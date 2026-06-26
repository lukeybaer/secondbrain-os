// amy-versions.ts
// Versioned Amy configurations with skill catalogs, tool definitions, and prompt builders.
// Each version is immutable once created. The active version is stored in config.
// Versions can be overridden per-call for A/B testing.

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { getConfig, getVapiWebhookServer, getVapiWebhookUrl } from './config';
import { getAgentMemory } from './agent-memory';
import { listPersonas } from './personas';
import { listProjects } from './projects';
import { listTodos } from './todos';
import { listCallRecords } from './calls';
import { identifyCaller, loadContactsStore, buildOutboundCalleeContext } from './caller-id';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AmySkill {
  name: string;
  description: string; // What Amy tells the caller she can do
  triggerPhrases: string[]; // Example phrases that activate this skill
  toolName?: string; // Corresponding Vapi tool name
  requiresBackend: boolean; // Needs EC2 to execute
  availability: 'ready' | 'coming_soon';
}

export interface AmyLlmConfig {
  provider: 'openai' | 'custom-llm';
  model: string;
  customEndpoint?: string; // For custom-llm: OpenAI-compatible endpoint URL
}

export interface AmyVoiceConfig {
  provider: string;
  voiceId: string;
}

export interface AmyProactiveConfig {
  enabled: boolean;
  channels: ('telegram' | 'call' | 'sms')[];
  onlyWhenExplicitlyAsked: boolean; // If true, only proactive when caller says "call me back"
}

export interface AmyVersion {
  version: number;
  name: string;
  createdAt: string;
  description: string;
  llm: AmyLlmConfig;
  voice: AmyVoiceConfig;
  identity: string; // Base identity/persona prompt
  skills: AmySkill[];
  rules: string[];
  proactive: AmyProactiveConfig;
}

// ── Skill Catalog ────────────────────────────────────────────────────────────

const SKILL_CATALOG: AmySkill[] = [
  {
    name: 'Answer Questions',
    description:
      'Answer general knowledge questions using AI intelligence — anything from quantum physics to cooking tips',
    triggerPhrases: ['how does', 'what is', 'explain', 'tell me about', 'why does'],
    requiresBackend: false,
    availability: 'ready',
  },
  {
    name: 'Check Project Status',
    description: 'Query active projects, tasks, and their statuses in real time',
    triggerPhrases: [
      "what's the status",
      "how's the project",
      'what projects',
      'any updates on',
      'task status',
    ],
    toolName: 'check_project_status',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Check Todos',
    description: "Query the owner's personal todo list — items, priorities, assignees, due dates",
    triggerPhrases: ["what's on my todo", 'what do I need to do', 'any todos', 'my tasks'],
    toolName: 'check_todos',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Search Knowledge',
    description:
      'Search conversation history, meeting notes, and stored knowledge to find past discussions and decisions',
    triggerPhrases: [
      'did I talk about',
      'what did I decide',
      'who did I speak with',
      'find in my notes',
    ],
    toolName: 'query_knowledge',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Read Otter Transcripts',
    description:
      'Look up Otter recordings and transcripts by date, transcript id, or keyword without inventing content',
    triggerPhrases: ['otter', 'transcript', 'recording', 'meeting notes', 'what did I say'],
    toolName: 'read_otter_transcripts',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Queue Coding Task',
    description:
      'Send a coding task to Claude Code for execution — bug fixes, features, refactors, deployments',
    triggerPhrases: ['fix the bug', 'add a feature', 'write code', 'deploy', 'update the app'],
    toolName: 'run_claude_code',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Manage Tasks',
    description: 'Queue creation, update, or completion of project tasks and todos during the conversation',
    triggerPhrases: ['add a task', 'mark it done', 'create a todo', 'update the task'],
    toolName: 'manage_task',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Request Approval',
    description:
      'Ask the owner for permission before sharing sensitive info or taking consequential actions',
    triggerPhrases: [], // Triggered by rules, not user phrases
    toolName: 'request_approval',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Bridge Call to Owner',
    description: 'Connect a caller directly to the owner via live call transfer',
    triggerPhrases: ['talk to the owner', 'connect me', 'transfer me', 'patch me through', 'speak with'],
    toolName: 'bridge_in_owner',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Flag Reputation Risk',
    description: 'Flag statements that could be embarrassing, defamatory, or legally risky',
    triggerPhrases: [], // Triggered by detection, not user phrases
    toolName: 'flag_reputation_risk',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Send Message',
    description: "Send a message to someone via Telegram, WhatsApp, or SMS on the owner's behalf",
    triggerPhrases: ['send a message', 'text them', 'message them', 'let them know'],
    toolName: 'send_message',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Check Email',
    description: "Search the owner's email for recent messages, threads, or specific topics",
    triggerPhrases: ['check my email', 'any emails from', 'did I get an email', 'inbox'],
    toolName: 'check_email',
    requiresBackend: true,
    availability: 'coming_soon',
  },
  {
    name: 'Check Calendar',
    description: "Look up the owner's schedule, upcoming meetings, and availability",
    triggerPhrases: ["what's on my calendar", 'am I free', 'any meetings', 'schedule'],
    toolName: 'check_calendar',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Create Calendar Event',
    description:
      "Create a personal Google Calendar event when the owner explicitly asks for an appointment, meeting, or calendar block",
    triggerPhrases: ['create calendar event', 'make an appointment', 'schedule this', 'put it on my calendar'],
    toolName: 'create_calendar_event',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Web Research',
    description: 'Search the web for information — businesses, contact info, prices, reviews, news',
    triggerPhrases: ['look up', 'search for', 'find me', 'research', 'google'],
    toolName: 'web_search',
    requiresBackend: true,
    availability: 'ready',
  },
];

// ── Amy Identity ─────────────────────────────────────────────────────────────

const AMY_IDENTITY = `You are Amy, the owner's executive assistant. You are highly intelligent, resourceful, and proactive. You have access to the owner's projects, tasks, conversation history, and a suite of tools to help manage his life and business.

You are not just a call handler — you ARE the assistant. Everything the owner's machines and tools can do, you can do. Claude Code, the SecondBrain app, Telegram, email, calendars — these are all extensions of you. When someone asks you to do something, you either do it directly or use your tools to make it happen.

You speak naturally and warmly. You're sharp but not robotic. You know the owner well — his preferences, his projects, his style. You don't over-explain or hedge when you know the answer.`;

// ── Tool Builders ────────────────────────────────────────────────────────────

function buildBaseTools(): any[] {
  return [
    { type: 'dtmf' },
    {
      type: 'function',
      function: {
        name: 'run_claude_code',
        description:
          "Dispatch substantive work to Claude Code in a detached background session. Use for coding, debugging, research, drafting, investigation, and any task too deep for a live voice answer.",
        parameters: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description:
                'Clear description of the coding task — include file names, what to change, expected behavior.',
            },
            priority: {
              type: 'string',
              enum: ['normal', 'urgent'],
              description: 'Urgent = immediate callback when done.',
            },
            continue_session: {
              type: 'boolean',
              description:
                'True when this should continue the most recent Claude Code session instead of starting a new task.',
            },
          },
          required: ['task'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'query_knowledge',
        description:
          "Search the owner's conversation history, meeting notes, and stored knowledge. Use for 'did I talk about X?', 'what did I decide about Y?', etc. Say 'give me just a moment' before calling.",
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question to search for.' },
          },
          required: ['question'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'request_approval',
        description:
          "Request the owner's approval before sharing personal info or taking consequential actions. ALWAYS call before sharing address, phone, email, or financial details.",
        parameters: {
          type: 'object',
          properties: {
            request_type: {
              type: 'string',
              enum: ['share_pii', 'transfer_call', 'commit_to_action', 'reputation_risk'],
            },
            description: {
              type: 'string',
              description: "What you're about to do, in plain English.",
            },
            data_category: {
              type: 'string',
              description:
                'Type of data: home_address, phone_number, email, employer, financial, etc.',
            },
          },
          required: ['request_type', 'description'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'flag_reputation_risk',
        description:
          'Flag embarrassing, defamatory, legally risky, or misrepresentational statements. Flag immediately, continue the call.',
        parameters: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: [
                'false_statement',
                'legal_threat',
                'defamation',
                'misrepresentation',
                'illegal_activity',
                'other',
              ],
            },
            description: { type: 'string', description: "What was said and why it's a risk." },
            severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            excerpt: { type: 'string', description: 'Exact quote that triggered the flag.' },
          },
          required: ['category', 'description', 'severity'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'bridge_in_owner',
        description:
          "Connect caller directly to the owner. Ask name first if ExampleCo. Say 'Let me get them for you' then call immediately.",
        parameters: {
          type: 'object',
          properties: {
            caller_name: { type: 'string', description: "Caller's name — ask if ExampleCo." },
            topic: { type: 'string', description: 'One-sentence reason they want the owner.' },
          },
          required: ['caller_name', 'topic'],
        },
      },
    },
  ];
}

function buildV2Tools(): any[] {
  const base = buildBaseTools();
  return [
    ...base,
    {
      type: 'function',
      function: {
        name: 'read_otter_transcripts',
        description:
          'Otter recordings and transcripts indexed by date. Supports list, get, and search actions with date, date_from, date_to, days, transcript_id, and query parameters. Use for live transcript recall and never invent transcript content.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'get', 'search'],
              description: 'list transcript inventory, get one transcript chunk, or search transcript text.',
            },
            date: {
              type: 'string',
              description: 'Date for list action, YYYY-MM-DD, today, or yesterday.',
            },
            date_from: { type: 'string', description: 'Start date for search, YYYY-MM-DD.' },
            date_to: { type: 'string', description: 'End date for search, YYYY-MM-DD.' },
            days: { type: 'integer', description: 'Rolling search window when dates are omitted.' },
            transcript_id: {
              type: 'string',
              description: 'Transcript id returned by action=list.',
            },
            query: { type: 'string', description: 'Keyword query for action=search.' },
          },
          required: ['action'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'check_calendar',
        description:
          "Read the owner's connected calendars. This is a read-only lookup and creates no side-effect receipt. Default to the personal Google Calendar; use Outlook work calendars only when that account is authorized. Use for schedule, availability, meetings, and calendar checks. If authorization is missing or blocked by policy, say that plainly instead of apologizing as if the capability does not exist.",
        parameters: {
          type: 'object',
          properties: {
            account_label: {
              type: 'string',
              description:
                "Calendar account label to check. Defaults to personal for the owner's personal Google Calendar. Use work only if he asks for the work calendar.",
            },
            days: {
              type: 'integer',
              description: 'How many days of upcoming calendar events to inspect. Defaults to 7.',
            },
            include_subjects: {
              type: 'boolean',
              description:
                'True only when the owner asks what the meetings are; otherwise return counts and availability without reading subjects aloud.',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_calendar_event',
        description:
          "Create an event on the owner's personal Google Calendar after the owner explicitly asks for a calendar event, meeting, appointment, or calendar block. This returns a side-effect receipt with effect_kind=calendar_event and status=succeeded/failed. Only say the event was created when that receipt status is succeeded; otherwise say the tool's failure message plainly.",
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Calendar event title.' },
            date: {
              type: 'string',
              description: 'Event date: YYYY-MM-DD, today, or tomorrow. Defaults to today for same-day times.',
            },
            start_time: {
              type: 'string',
              description: 'Start time such as 8 PM, 20:00, or YYYY-MM-DDTHH:mm:ss.',
            },
            end_time: { type: 'string', description: 'Optional end time.' },
            duration_minutes: {
              type: 'integer',
              description: 'Event duration in minutes. Defaults to 30.',
            },
            timezone: { type: 'string', description: 'IANA timezone. Defaults to America/Chicago.' },
            description: { type: 'string', description: 'Optional event description.' },
            account_label: {
              type: 'string',
              description:
                "Calendar account label. Defaults to personal. Writes currently support the owner's personal Google Calendar.",
            },
          },
          required: ['title', 'start_time'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          'Queue current web research through Claude Code and return the result out of band, usually Telegram. Use for current news, businesses, prices, reviews, facts outside local memory, and anything the owner asks Amy to look up on the internet.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The web research question or lookup request.' },
            reason: {
              type: 'string',
              description: 'Optional context explaining why the owner needs the research.',
            },
            priority: {
              type: 'string',
              enum: ['normal', 'urgent'],
              description: 'Urgency of the research request.',
            },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'check_project_status',
        description:
          'Query active projects and their task statuses. Use when the owner asks about project progress, task counts, or what needs attention.',
        parameters: {
          type: 'object',
          properties: {
            project_name: {
              type: 'string',
              description: 'Optional — filter to a specific project by name (partial match).',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'check_todos',
        description: "Query the owner's personal todo list. Can filter by assignee or priority.",
        parameters: {
          type: 'object',
          properties: {
            assignee: {
              type: 'string',
              enum: ['the owner', 'Amy', 'Claude Code'],
              description: "Filter by who's responsible.",
            },
            priority: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'Filter by priority level.',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'manage_task',
        description:
          "Queue creation or update of a project task or todo item. Use when the owner says 'add a task', 'mark that done', or 'create a todo'. This returns a side-effect receipt with effect_kind=task and status=queued/succeeded/failed. Only describe the task effect that the receipt confirms.",
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['create_todo', 'complete_todo', 'create_project_task', 'update_task_status'],
              description: 'What to do.',
            },
            title: { type: 'string', description: 'Task title (for create actions).' },
            project_name: { type: 'string', description: 'Project name (for project tasks).' },
            task_id: { type: 'string', description: 'Task ID (for updates).' },
            status: { type: 'string', description: 'New status (for updates).' },
            priority: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'Priority level.',
            },
            assignee: {
              type: 'string',
              enum: ['the owner', 'Amy', 'Claude Code'],
              description: "Who's responsible.",
            },
            notes: { type: 'string', description: 'Additional notes.' },
          },
          required: ['action'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'send_message',
        description:
          "Send a message via Telegram on the owner's behalf. Use when the owner says 'message them', 'let them know', 'send a text'.",
        parameters: {
          type: 'object',
          properties: {
            channel: { type: 'string', enum: ['telegram'], description: 'Message channel.' },
            message: { type: 'string', description: 'The message to send.' },
          },
          required: ['channel', 'message'],
        },
      },
    },
  ];
}

// ── Prompt Builders ──────────────────────────────────────────────────────────

function buildSkillCatalogSection(skills: AmySkill[]): string {
  const readySkills = skills.filter((s) => s.availability === 'ready');
  const comingSkills = skills.filter((s) => s.availability === 'coming_soon');

  let section = `\n## Your Capabilities\nYou can:\n`;
  for (const s of readySkills) {
    section += `- **${s.name}**: ${s.description}\n`;
  }
  if (comingSkills.length) {
    section += `\nComing soon (tell the caller you can't do these yet but will be able to soon):\n`;
    for (const s of comingSkills) {
      section += `- ${s.name}: ${s.description}\n`;
    }
  }
  section += `\nIf someone asks you to do something not in this list, say clearly that it's outside your current capabilities but you'll flag it for the owner.\n`;
  return section;
}

function buildRulesSection(rules: string[]): string {
  if (!rules.length) return '';
  return `\n## Rules\n${rules.map((r) => `- ${r}`).join('\n')}\n`;
}

function buildIntegritySection(): string {
  return `
## Integrity rules — non-negotiable
- NEVER fabricate or make up information. If you don't know, say "I don't know" or "let me check."
- NEVER guess at numbers, costs, policy details, or coverage specifics.
- If unsure about your authority, say "I'd want to verify that before we proceed."
- Know your boundaries. If something is outside scope, say so clearly.
- Be factual. No embellishment. No filler.
- When delivering briefings, cite where information came from.`;
}

function buildToolUsageSection(version: AmyVersion): string {
  const sections: string[] = [];

  sections.push(`
## How to Use Your Tools
When the caller asks something you can look up — USE YOUR TOOLS. Don't guess. Don't say "I think..." when you can check.`);

  if (version.skills.some((s) => s.toolName === 'check_project_status')) {
    sections.push(`
### Project & Task Queries
When the owner asks about projects, tasks, or status:
- Use check_project_status immediately
- Say "Let me check on that..." while it runs
- Read the results naturally — don't dump raw data`);
  }

  if (version.skills.some((s) => s.toolName === 'check_todos')) {
    sections.push(`
### Todo List
When the owner asks about his todos or what needs doing:
- Use check_todos immediately
- Summarize by priority — high items first`);
  }

  if (version.skills.some((s) => s.toolName === 'manage_task')) {
    sections.push(`
### Task Management
When the owner says to add a task, mark something done, or create a todo:
- Use manage_task immediately
- Report the side-effect receipt honestly. If status is queued, say it was queued, not completed.`);
  }

  if (version.skills.some((s) => s.toolName === 'read_otter_transcripts')) {
    sections.push(`
### Otter Transcripts
When the owner asks about recordings, transcripts, meetings, or what was said:
- Use read_otter_transcripts immediately
- Return only what the transcript tool actually provides
- If no transcript is found, say that plainly`);
  }

  if (version.skills.some((s) => s.toolName === 'web_search')) {
    sections.push(`
### Web Research
When the owner asks to look up, research, search, Google, or verify current outside information:
- Use web_search immediately
- Say "I'll research that and send you what I find on Telegram."
- Do not say web research is unavailable`);
  }

  if (version.skills.some((s) => s.toolName === 'check_calendar')) {
    sections.push(`
### Calendar
When the owner asks about his schedule, availability, meetings, or calendar:
- Use check_calendar immediately
- check_calendar is read-only
- For completed actions, report only what a matching side-effect receipt confirms: effect_kind and status matter
- If the owner asks to create a calendar event, use create_calendar_event and only say it was created when status=succeeded
- If the calendar account is not authorized or the tenant blocks access, say that plainly
- Do not say calendar checks are unavailable`);
  }

  sections.push(`
### Claude Code Dispatch
When the owner asks to write code, fix a bug, make a technical change, draft, investigate, or do substantive work:
- Use run_claude_code immediately
- Say "I've queued that for Claude Code. I'll call you back when it's done — usually within a few minutes."
- End the call gracefully

### Knowledge Queries
When the owner asks about past conversations, decisions, or contacts:
- Use query_knowledge IMMEDIATELY — don't try to answer from memory
- Say "Give me just a moment, checking your notes..."
- Read the result naturally

### Connecting Callers to the Owner
When a caller asks to speak with the owner:
- Ask their name: "Who should I say is calling?"
- Say "Let me get them for you — one moment."
- Call bridge_in_owner IMMEDIATELY`);

  return sections.join('\n');
}

/**
 * Load the canonical Amy persona file (memory/AMY.md) and return its body
 * without the YAML frontmatter. This is THE source of truth for Amy's
 * identity, behavior, and rules on every surface. It's injected at the top
 * of every Vapi system prompt so the voice persona matches Tier 1 memory.
 *
 * Cached in memory and re-read on a 60-second TTL so edits to AMY.md take
 * effect for the next call without restarting the app. If the file is
 * missing (e.g. during tests), returns an empty string and the prompt
 * builder falls back to version.identity.
 */
let amyPersonaCache: { content: string; loadedAt: number } | null = null;
const AMY_PERSONA_TTL_MS = 60_000;

function loadAmyPersonaFile(overrideRepoRoot?: string): string {
  const now = Date.now();
  if (amyPersonaCache && now - amyPersonaCache.loadedAt < AMY_PERSONA_TTL_MS) {
    return amyPersonaCache.content;
  }

  let repoRoot: string;
  if (overrideRepoRoot) {
    repoRoot = overrideRepoRoot;
  } else {
    try {
      repoRoot = app.getAppPath();
    } catch {
      // Running outside Electron (e.g. vitest). Fall back to the tests' CWD.
      repoRoot = process.cwd();
    }
  }

  const candidates = [
    path.join(repoRoot, 'memory', 'AMY.md'),
    path.join(repoRoot, '..', 'memory', 'AMY.md'),
  ];

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf-8');
      // Strip YAML frontmatter: --- ... --- (tolerate CRLF line endings)
      const body = raw
        .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
        .trim();
      amyPersonaCache = { content: body, loadedAt: now };
      return body;
    } catch {
      continue;
    }
  }

  // File not found — cache empty to avoid repeated fs probes
  amyPersonaCache = { content: '', loadedAt: now };
  return '';
}

/**
 * Test-only: reset the cache so a test can verify the reader probes the
 * filesystem after a TTL expiry.
 */
export function __resetAmyPersonaCache(): void {
  amyPersonaCache = null;
}

export async function buildVersionedSystemPrompt(
  version: AmyVersion,
  context: {
    instructions?: string;
    personalContext?: string;
    personaInstructions?: string;
    callDirection: 'outbound' | 'inbound';
    callerPhone?: string;
    callHistory?: string;
  },
): Promise<string> {
  const parts: string[] = [];

  // Canonical Amy persona file at memory/AMY.md anchors every surface.
  // Loaded before any version-specific or call-specific sections so
  // identity stays consistent across Vapi calls, briefings, Telegram,
  // and Claude Code. Phase 10 of plans/dazzling-rolling-moler.md.
  const amyPersona = loadAmyPersonaFile();
  if (amyPersona) {
    parts.push('# Canonical Amy persona (memory/AMY.md)\n\n' + amyPersona);
  }

  // Caller identification (inbound calls only)
  if (context.callDirection === 'inbound' && context.callerPhone) {
    try {
      const callerCtx = identifyCaller(context.callerPhone);
      const store = loadContactsStore();
      parts.push(callerCtx.systemPromptSection);
      parts.push(
        `\n> CALLER IDENTIFICATION SYSTEM ACTIVE. Keyword for ExampleCo callers claiming to be the owner: "${store.keyword}"`,
      );
    } catch {
      // non-critical
    }
  }

  // Identity (version-specific, supplements AMY.md)
  if (context.personaInstructions?.trim()) {
    parts.push(context.personaInstructions.trim());
  } else {
    parts.push(version.identity);
  }

  // Call direction — always inject an explicit annotation so Amy never
  // confuses outbound (calling them with a goal) with inbound (they called
  // me, "how can I help"). Without this, persona templates that say
  // "introduce yourself naturally" plus the LLM's default conversational
  // reflex produce receptionist openings on outbound calls — see
  // memory/feedback_amy_outbound_must_drive_call.md.
  //
  // Outbound also gets a callee-compartmentalization guard. Inbound has
  // caller-id tiers; outbound previously had none, so a callee asking
  // personal questions about the owner would get answers volunteered from
  // the EA memory dump appended at the end of this prompt. The guard
  // mirrors the ExampleCo-caller compartmentalization rules. See
  // memory/feedback_outbound_callee_compartmentalization.md.
  if (context.callDirection === 'outbound') {
    parts.push(buildOutboundCalleeContext().systemPromptSection);
    parts.push(
      `\n> IMPORTANT: You are MAKING this call (outbound). You are calling them — they did not call you. Open by introducing yourself AND stating the reason for your call (the goal below). NEVER greet with "How can I help you?" or "Can I help you today?" — those are inbound greetings only.`,
    );
  } else {
    parts.push(
      `\n> IMPORTANT: You are RECEIVING this call (inbound). They called you. Answer naturally.`,
    );
  }

  // Call goal
  if (context.instructions?.trim()) {
    parts.push(`\n## Your goal for this call\n${context.instructions.trim()}`);
  }

  // Personal context
  if (context.personalContext?.trim()) {
    parts.push(`\n## Personal context you may use\n${context.personalContext.trim()}`);
  }

  // Call history (for inbound)
  if (context.callHistory?.trim()) {
    parts.push(`\n## Call history with this person\n${context.callHistory.trim()}`);
  }

  // Skill catalog
  parts.push(buildSkillCatalogSection(version.skills));

  // Tool usage instructions
  parts.push(buildToolUsageSection(version));

  // Rules
  parts.push(buildRulesSection(version.rules));

  // Conversation style
  parts.push(`
## LIVE MIC DISCIPLINE — read this first
Your microphone is ALWAYS hot on this call. Everything you emit is heard by the other party in real time. Do NOT narrate your internal state, actions, waits, or thoughts. Specifically:
- NEVER say "Pressing 3", "Selecting option 2", "I'll press", "Pressing parts" — just use the DTMF tool silently.
- NEVER say "Waiting silently for a human", "Let me wait", "Standing by" — just stay silent.
- NEVER say "Processing", "Let me think", "One moment while I check internally" — that's internal state, do not voice it.
- If you are going to do something, DO IT. Do not describe it. Acceptable bridging phrases exist only when you are actually looking something up on tools ("Let me check on that…" while a tool runs) — never as a substitute for silence.
## How to handle this call
- Speak naturally — do NOT read goals as a script. Have a real conversation.
- If they seem busy, be brief. If they want to chat, engage warmly.
- Stay in character throughout.
- NEVER say "This will just take a second", "Bear with me", "Hang tight", "Just give me a moment" - hold-music phrases. Do it or stay silent.
## Phone tree / IVR navigation
- If you reach an automated menu, use the DTMF tool to press keys. NEVER voice the action — silent DTMF only.
- Wait for the FULL menu to finish (at least 2 seconds of silence) before pressing any key.
- After pressing a key, stay silent for at least 8 seconds to let the transfer complete. Only speak once a human greets you.
## Pronunciation guide
- "W-2" → say "W two"
- "1099" → say "ten ninety-nine"
- "LLC" → say "L L C"
- "RSU" → say "R S U"
## Ending the call
- When the goal is accomplished (or clearly can't be), wrap up warmly and say goodbye.`);

  // Integrity
  parts.push(buildIntegritySection());

  // Proactive update rules
  if (version.proactive.onlyWhenExplicitlyAsked) {
    parts.push(`
## Proactive Updates
- You CAN call the owner back with updates, but ONLY when he explicitly asks you to ("call me back", "let me know", "get back to me").
- Never call unprompted. If you have an update and weren't asked to call, write it to the dashboard/briefing surface instead of Telegram.`);
  }

  let prompt = parts.join('\n');

  // Inject EA agent memory
  try {
    const ea = getAgentMemory('ea');
    prompt = await ea.buildSystemPrompt(prompt, { maxMemoryChars: 2500 });
  } catch {
    // non-critical
  }

  return prompt;
}

// ── Built-in Versions ────────────────────────────────────────────────────────

const V1_RULES = [
  'Do NOT reveal that you are an AI unless directly and sincerely asked',
  "If asked who you are on outbound calls, say you're calling on behalf of a customer",
  "Receive inbound calls naturally — 'Hey, thanks for calling back!'",
  "Reference prior call context only if relevant — don't robotically repeat it",
];

const V2_RULES = [
  ...V1_RULES,
  "When asked about projects, tasks, or status — use your tools, don't guess",
  "When you can check something, always check rather than saying 'I think...'",
  'If a tool call fails, tell the caller honestly and offer alternatives',
  'You are part of a unified system — Claude Code, Telegram, SecondBrain are all you',
];

const BUILT_IN_VERSIONS: AmyVersion[] = [
  {
    version: 1,
    name: 'Amy v1 — Classic',
    createdAt: '2025-04-01T00:00:00Z',
    description:
      'Original Amy: gpt-4o, basic tools (code tasks, knowledge queries, approvals, bridge-in). No skill awareness.',
    llm: { provider: 'openai', model: 'gpt-4o' },
    voice: { provider: '11labs', voiceId: 'paula' },
    identity: 'You are a helpful AI assistant representing the user.',
    skills: SKILL_CATALOG.filter((s) =>
      [
        'Search Knowledge',
        'Queue Coding Task',
        'Request Approval',
        'Bridge Call to Owner',
        'Flag Reputation Risk',
      ].includes(s.name),
    ),
    rules: V1_RULES,
    proactive: { enabled: false, channels: [], onlyWhenExplicitlyAsked: true },
  },
  {
    version: 2,
    name: 'Amy v2 — Skill-Aware',
    createdAt: new Date().toISOString(),
    description:
      'Full skill catalog, project/todo queries, task management, direct tool execution. Still gpt-4o.',
    llm: { provider: 'openai', model: 'gpt-4o' },
    voice: { provider: '11labs', voiceId: 'paula' },
    identity: AMY_IDENTITY,
    skills: SKILL_CATALOG,
    rules: V2_RULES,
    proactive: { enabled: true, channels: ['telegram'], onlyWhenExplicitlyAsked: true },
  },
  {
    version: 3,
    name: 'Amy v3 — Receptionist (gpt-4o voice + Claude dispatch)',
    createdAt: new Date().toISOString(),
    description:
      'Receptionist pattern: gpt-4o for voice (1-2s first token, no cold start) + Claude Code backend for actual work via run_claude_code dispatch. Claude-on-voice (custom-llm) was reverted 2026-04-18 after it produced 10-15s per-turn cold start on live calls (voice went dead). Restore Claude-on-voice only after session pinning (claude --resume) is proven to keep cold start under 2s.',
    llm: { provider: 'openai', model: 'gpt-4o' },
    voice: { provider: '11labs', voiceId: 'paula' },
    identity: AMY_IDENTITY,
    skills: SKILL_CATALOG,
    rules: V2_RULES,
    proactive: { enabled: true, channels: ['telegram'], onlyWhenExplicitlyAsked: true },
  },
];

// ── Storage ──────────────────────────────────────────────────────────────────

function getVersionsDir(): string {
  return path.join(app.getPath('userData'), 'data', 'amy-versions');
}

function ensureVersionsDir(): void {
  const dir = getVersionsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function listAmyVersions(): AmyVersion[] {
  ensureVersionsDir();
  const dir = getVersionsDir();
  const custom: AmyVersion[] = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as AmyVersion;
      } catch {
        return null;
      }
    })
    .filter((v): v is AmyVersion => v !== null);

  // Merge built-in versions with any custom overrides
  const merged = new Map<number, AmyVersion>();
  for (const v of BUILT_IN_VERSIONS) merged.set(v.version, v);
  for (const v of custom) merged.set(v.version, v);

  return Array.from(merged.values()).sort((a, b) => a.version - b.version);
}

export function getAmyVersion(versionNumber: number): AmyVersion | null {
  return listAmyVersions().find((v) => v.version === versionNumber) ?? null;
}

export function getActiveAmyVersion(): AmyVersion {
  const config = getConfig();
  const activeNum = (config as any).amyVersion ?? 2; // Default to v2
  return getAmyVersion(activeNum) ?? BUILT_IN_VERSIONS[1]; // Fallback to v2
}

export function saveAmyVersion(version: AmyVersion): void {
  ensureVersionsDir();
  fs.writeFileSync(
    path.join(getVersionsDir(), `v${version.version}.json`),
    JSON.stringify(version, null, 2),
    'utf-8',
  );
}

// ── Vapi Config Builders ─────────────────────────────────────────────────────

export function getToolsForVersion(version: AmyVersion): any[] {
  if (version.version >= 2) return buildV2Tools();
  return buildBaseTools();
}

export function getLlmConfigForVersion(version: AmyVersion): any {
  if (version.llm.provider === 'custom-llm') {
    // Prefer explicit customEndpoint on the version. Fall back to the
    // ec2BaseUrl + /chat/completions so v3 works out-of-the-box as soon
    // as the Claude Max proxy + SSH reverse tunnel come online — without
    // needing a manual saved version override. Rule: Claude Max only for
    // production call paths (memory/feedback_no_fabrication_in_briefings.md,
    // src/main/__tests__/llm-routing-guard.test.ts).
    const fallback = getConfig().ec2BaseUrl
      ? `${getConfig().ec2BaseUrl}/chat/completions`
      : undefined;
    const url = version.llm.customEndpoint || fallback;
    if (url) {
      return {
        provider: 'custom-llm',
        model: version.llm.model,
        url,
      };
    }
    // No endpoint anywhere — last-resort fall back to openai so Amy stays
    // on the air. Telegram alert + llm-routing-guard test will notice.
    console.warn(
      '[amy-versions] v' +
        version.version +
        ' is custom-llm but no endpoint is configured. Falling back to openai gpt-4o.',
    );
    return { provider: 'openai', model: 'gpt-4o' };
  }
  return {
    provider: version.llm.provider,
    model: version.llm.model,
  };
}

/**
 * Build a complete Vapi assistant config from an Amy version.
 * Used for both outbound calls and callback assistant updates.
 */
export async function buildVapiAssistantConfig(
  version: AmyVersion,
  context: {
    instructions?: string;
    personalContext?: string;
    personaId?: string;
    callDirection: 'outbound' | 'inbound';
    callerPhone?: string;
    callHistory?: string;
    leaveVoicemail?: boolean;
  },
): Promise<any> {
  const personaInstructions = context.personaId
    ? listPersonas().find((p) => p.id === context.personaId)?.instructions
    : undefined;

  const systemPrompt = await buildVersionedSystemPrompt(version, {
    instructions: context.instructions,
    personalContext: context.personalContext,
    personaInstructions,
    callDirection: context.callDirection,
    callerPhone: context.callerPhone,
    callHistory: context.callHistory,
  });
  const webhookUrl = getVapiWebhookUrl();
  const webhookServer = getVapiWebhookServer();

  // Add voicemail instructions for outbound
  if (context.callDirection === 'outbound') {
    const vmSection = context.leaveVoicemail
      ? '\n## Voicemail\nIf you reach voicemail, leave a brief, natural message under 20 seconds. Then hang up.'
      : '\n## Voicemail\nIf you reach voicemail, hang up politely without leaving a message.';
    // systemPrompt already built, append
    const fullPrompt = systemPrompt + vmSection;

    return {
      model: {
        ...getLlmConfigForVersion(version),
        messages: [{ role: 'system', content: fullPrompt }],
        tools: getToolsForVersion(version),
      },
      voice: version.voice,
      // Outbound: Amy ALWAYS speaks first. Empty firstMessage produced
      // listen-first behavior that, combined with persona templates saying
      // "introduce yourself naturally," caused Amy to wait for the callee,
      // then default to receptionist mode ("Can I help you today?") — see
      // memory/feedback_amy_outbound_must_drive_call.md (2026-04-27 PRIVATE_NAME
      // call). The "Hi." primer absorbs Vapi's TTS cold-start jitter so the
      // LLM-generated continuation lands clean and goal-aware.
      firstMessage: 'Hi.',
      endCallPhrases: ['goodbye', 'thank you, bye', 'have a great day', 'bye bye'],
      silenceTimeoutSeconds: 300,
      maxDurationSeconds: 1800,
      serverUrl: webhookUrl,
      ...(webhookServer ? { server: webhookServer } : {}),
    };
  }

  // Inbound
  return {
    model: {
      ...getLlmConfigForVersion(version),
      messages: [{ role: 'system', content: systemPrompt }],
      tools: getToolsForVersion(version),
    },
    voice: version.voice,
    firstMessage: 'Hey, thanks for calling back!',
    endCallPhrases: ['goodbye', 'thank you, bye', 'have a great day', 'bye bye'],
    serverUrl: webhookUrl,
    ...(webhookServer ? { server: webhookServer } : {}),
  };
}

// ── Data Snapshot for EC2 Sync ───────────────────────────────────────────────

/**
 * Build a snapshot of local data (projects, todos, call history) for syncing to EC2.
 * EC2 uses this cached data to answer tool calls during live calls.
 */
export async function buildDataSnapshot(): Promise<{
  projects: any[];
  todos: any[];
  recentCalls: any[];
  amyVersion: number;
  timestamp: string;
  linkedinIntel: any;
  contacts: any;
}> {
  let projects: any[] = [];
  let todos: any[] = [];
  let recentCalls: any[] = [];
  let linkedinIntel: any = null;
  let contacts: any = null;

  try {
    projects = await listProjects();
  } catch {
    /* ignore */
  }
  try {
    todos = listTodos();
  } catch {
    /* ignore */
  }
  try {
    recentCalls = listCallRecords()
      .slice(0, 20)
      .map((c) => ({
        id: c.id,
        phoneNumber: c.phoneNumber,
        instructions: c.instructions,
        status: c.status,
        completed: c.completed,
        isCallback: c.isCallback,
        createdAt: c.createdAt,
        summary: c.summary,
      }));
  } catch {
    /* ignore */
  }
  try {
    const { getLinkedInIntelSnapshot } = await import('./linkedin-intel');
    linkedinIntel = getLinkedInIntelSnapshot();
  } catch {
    /* ignore */
  }
  try {
    const { loadContactsStore } = await import('./caller-id');
    contacts = loadContactsStore();
  } catch {
    /* ignore */
  }

  const config = getConfig();
  return {
    projects,
    todos,
    recentCalls,
    amyVersion: (config as any).amyVersion ?? 2,
    timestamp: new Date().toISOString(),
    linkedinIntel,
    contacts,
  };
}
