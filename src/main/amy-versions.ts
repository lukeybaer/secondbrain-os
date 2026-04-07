// amy-versions.ts
// Versioned Amy configurations with skill catalogs, tool definitions, and prompt builders.
// Each version is immutable once created. The active version is stored in config.
// Versions can be overridden per-call for A/B testing.

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { getConfig } from './config';
import { getAgentMemory } from './agent-memory';
import { listPersonas } from './personas';
import { listProjects } from './projects';
import { listTodos } from './todos';
import { listCallRecords } from './calls';

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
    description: "Query Luke's personal todo list — items, priorities, assignees, due dates",
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
    description: 'Create, update, or complete project tasks and todos during the conversation',
    triggerPhrases: ['add a task', 'mark it done', 'create a todo', 'update the task'],
    toolName: 'manage_task',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Request Approval',
    description:
      'Ask Luke for permission before sharing sensitive info or taking consequential actions',
    triggerPhrases: [], // Triggered by rules, not user phrases
    toolName: 'request_approval',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Bridge Call to Luke',
    description: 'Connect a caller directly to Luke via live call transfer',
    triggerPhrases: ['talk to Luke', 'connect me', 'transfer me', 'patch me through', 'speak with'],
    toolName: 'bridge_in_luke',
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
    description: "Send a message to someone via Telegram, WhatsApp, or SMS on Luke's behalf",
    triggerPhrases: ['send a message', 'text them', 'message them', 'let them know'],
    toolName: 'send_message',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Check Email',
    description: "Search Luke's email for recent messages, threads, or specific topics",
    triggerPhrases: ['check my email', 'any emails from', 'did I get an email', 'inbox'],
    toolName: 'check_email',
    requiresBackend: true,
    availability: 'coming_soon',
  },
  {
    name: 'Check Calendar',
    description: "Look up Luke's schedule, upcoming meetings, and availability",
    triggerPhrases: ["what's on my calendar", 'am I free', 'any meetings', 'schedule'],
    toolName: 'check_calendar',
    requiresBackend: true,
    availability: 'coming_soon',
  },
  {
    name: 'Web Research',
    description: 'Search the web for information — businesses, contact info, prices, reviews, news',
    triggerPhrases: ['look up', 'search for', 'find me', 'research', 'google'],
    toolName: 'web_search',
    requiresBackend: true,
    availability: 'coming_soon',
  },
];

// ── Amy Identity ─────────────────────────────────────────────────────────────

const AMY_IDENTITY = `You are Amy, Luke Baer's executive assistant. You are highly intelligent, resourceful, and proactive. You have access to Luke's projects, tasks, conversation history, and a suite of tools to help manage his life and business.

You are not just a call handler — you ARE the assistant. Everything Luke's machines and tools can do, you can do. Claude Code, the SecondBrain app, Telegram, email, calendars — these are all extensions of you. When someone asks you to do something, you either do it directly or use your tools to make it happen.

You speak naturally and warmly. You're sharp but not robotic. You know Luke well — his preferences, his projects, his style. You don't over-explain or hedge when you know the answer.`;

// ── Tool Builders ────────────────────────────────────────────────────────────

function buildBaseTools(): any[] {
  return [
    { type: 'dtmf' },
    {
      type: 'function',
      function: {
        name: 'run_claude_code',
        description:
          "Queue a coding task for Claude Code to execute on Luke's computer. Use when asked to fix bugs, add features, write code, or make any technical change.",
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
          "Search Luke's conversation history, meeting notes, and stored knowledge. Use for 'did I talk about X?', 'what did I decide about Y?', etc. Say 'give me just a moment' before calling.",
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
          "Request Luke's approval before sharing personal info or taking consequential actions. ALWAYS call before sharing address, phone, email, or financial details.",
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
        name: 'bridge_in_luke',
        description:
          "Connect caller directly to Luke. Ask name first if unknown. Say 'Let me get them for you' then call immediately.",
        parameters: {
          type: 'object',
          properties: {
            caller_name: { type: 'string', description: "Caller's name — ask if unknown." },
            topic: { type: 'string', description: 'One-sentence reason they want Luke.' },
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
        name: 'check_project_status',
        description:
          'Query active projects and their task statuses. Use when Luke asks about project progress, task counts, or what needs attention.',
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
        description: "Query Luke's personal todo list. Can filter by assignee or priority.",
        parameters: {
          type: 'object',
          properties: {
            assignee: {
              type: 'string',
              enum: ['Luke', 'Amy', 'Claude Code'],
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
          "Create or update a project task or todo item. Use when Luke says 'add a task', 'mark that done', or 'create a todo'.",
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
              enum: ['Luke', 'Amy', 'Claude Code'],
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
          "Send a message via Telegram on Luke's behalf. Use when Luke says 'message them', 'let them know', 'send a text'.",
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
  section += `\nIf someone asks you to do something not in this list, say clearly that it's outside your current capabilities but you'll flag it for Luke.\n`;
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
When Luke asks about projects, tasks, or status:
- Use check_project_status immediately
- Say "Let me check on that..." while it runs
- Read the results naturally — don't dump raw data`);
  }

  if (version.skills.some((s) => s.toolName === 'check_todos')) {
    sections.push(`
### Todo List
When Luke asks about his todos or what needs doing:
- Use check_todos immediately
- Summarize by priority — high items first`);
  }

  if (version.skills.some((s) => s.toolName === 'manage_task')) {
    sections.push(`
### Task Management
When Luke says to add a task, mark something done, or create a todo:
- Use manage_task immediately
- Confirm what you did: "Done — I've added that to your list."`);
  }

  sections.push(`
### Coding Tasks
When Luke asks to write code, fix a bug, or make a technical change:
- Use run_claude_code immediately
- Say "I've queued that for Claude Code. I'll call you back when it's done — usually within a few minutes."
- End the call gracefully

### Knowledge Queries
When Luke asks about past conversations, decisions, or contacts:
- Use query_knowledge IMMEDIATELY — don't try to answer from memory
- Say "Give me just a moment, checking your notes..."
- Read the result naturally

### Connecting Callers to Luke
When a caller asks to speak with Luke:
- Ask their name: "Who should I say is calling?"
- Say "Let me get them for you — one moment."
- Call bridge_in_luke IMMEDIATELY`);

  return sections.join('\n');
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

  // Identity
  if (context.personaInstructions?.trim()) {
    parts.push(context.personaInstructions.trim());
    if (context.callDirection === 'inbound') {
      parts.push(`> IMPORTANT: You are RECEIVING this call, not making it. Answer naturally.`);
    }
  } else {
    parts.push(version.identity);
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
## How to handle this call
- Speak naturally — do NOT read goals as a script. Have a real conversation.
- If they seem busy, be brief. If they want to chat, engage warmly.
- Stay in character throughout.
## Phone tree / IVR navigation
- If you reach an automated menu, use the DTMF tool to press keys. Do NOT say "Presses 1" out loud.
- Wait for the full menu before pressing.
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
- You CAN call Luke back with updates, but ONLY when he explicitly asks you to ("call me back", "let me know", "get back to me").
- Never call unprompted. If you have an update and weren't asked to call, send it via Telegram instead.`);
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
        'Bridge Call to Luke',
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
    name: 'Amy v3 — Claude-Powered',
    createdAt: new Date().toISOString(),
    description:
      'Claude as the LLM via custom endpoint. Same brain as Claude Code. Full skill catalog + unified agent core.',
    llm: { provider: 'custom-llm', model: 'claude-sonnet-4-20250514', customEndpoint: '' },
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
  if (version.llm.provider === 'custom-llm' && version.llm.customEndpoint) {
    return {
      provider: 'custom-llm',
      model: version.llm.model,
      url: version.llm.customEndpoint,
    };
  }
  return {
    provider: version.llm.provider === 'custom-llm' ? 'openai' : version.llm.provider,
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
      firstMessage: personaInstructions ? '' : 'Hello, is this a good time to talk?',
      endCallPhrases: ['goodbye', 'thank you, bye', 'have a great day', 'bye bye'],
      silenceTimeoutSeconds: 300,
      maxDurationSeconds: 1800,
      serverUrl: getConfig().ec2BaseUrl ? `${getConfig().ec2BaseUrl}/vapi/webhook` : undefined,
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
    serverUrl: getConfig().ec2BaseUrl ? `${getConfig().ec2BaseUrl}/vapi/webhook` : undefined,
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
}> {
  let projects: any[] = [];
  let todos: any[] = [];
  let recentCalls: any[] = [];
  let linkedinIntel: any = null;

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

  const config = getConfig();
  return {
    projects,
    todos,
    recentCalls,
    amyVersion: (config as any).amyVersion ?? 2,
    timestamp: new Date().toISOString(),
    linkedinIntel,
  };
}
