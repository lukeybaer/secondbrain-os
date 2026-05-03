#!/usr/bin/env node
/**
 * write-v3-override.js
 *
 * Writes a v3.json override to the Amy versions dir that mirrors v2
 * (gpt-4o receptionist) but keeps version=3. This lets a running Electron
 * instance pick up the change on the next listAmyVersions() call
 * (which reads disk fresh) without requiring a full app restart.
 *
 * Use when the in-memory BUILT_IN_VERSIONS still has v3 as Claude-on-voice
 * but you need the active v3 to be gpt-4o immediately.
 */

const fs = require('fs');
const path = require('path');

const APPDATA = process.env.APPDATA;
if (!APPDATA) {
  console.error('APPDATA not set');
  process.exit(1);
}

const versionsDir = path.join(APPDATA, 'secondbrain', 'data', 'amy-versions');
fs.mkdirSync(versionsDir, { recursive: true });

// Minimal skill catalog , matches what's used on call paths. Pulled from
// SKILL_CATALOG in amy-versions.ts. If the catalog drifts, refresh here.
const SKILL_CATALOG = [
  {
    name: 'Answer Questions',
    description:
      'Answer general knowledge questions using AI intelligence , anything from quantum physics to cooking tips',
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
    description: "Query the owner's personal todo list , items, priorities, assignees, due dates",
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
      'Queue a coding task for Claude Code to execute on the owner computer , fixes, features, deploys',
    triggerPhrases: [
      'kick off a coding',
      'fix the bug',
      'add a feature',
      'deploy',
      'push to prod',
    ],
    toolName: 'run_claude_code',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Manage Task',
    description: 'Add, complete, or delete todos',
    triggerPhrases: ['add to my todos', 'mark as done', 'delete todo'],
    toolName: 'manage_task',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Request Approval',
    description: 'Request owner approval for sharing PII or consequential actions via Telegram',
    triggerPhrases: [],
    toolName: 'request_approval',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Bridge Call to Owner',
    description: 'Warm-transfer the caller to the owner',
    triggerPhrases: ['transfer me', 'can I speak to', 'connect me'],
    toolName: 'bridge_in_owner',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Flag Reputation Risk',
    description: 'Flag anything potentially embarrassing, defamatory, or legally risky',
    triggerPhrases: [],
    toolName: 'flag_reputation_risk',
    requiresBackend: true,
    availability: 'ready',
  },
  {
    name: 'Send Message',
    description: 'Send a Telegram message on the owner behalf',
    triggerPhrases: ['text them', 'let them know', 'send a message'],
    toolName: 'send_message',
    requiresBackend: true,
    availability: 'ready',
  },
];

const AMY_IDENTITY = `You are the EA, the owner's executive assistant. You are highly intelligent, resourceful, and proactive. You have access to the owner's projects, tasks, conversation history, and a suite of tools to help manage his life and business.

You have a warm, professional tone. You speak naturally and conversationally , not robotically. You are direct and get to the point.

When the owner calls you, you greet him by name and ask what he needs. You dispatch substantive work to Claude Code via run_claude_code and relay the result back. You do not try to do the work on the voice call , that is Claude Code's job.`;

const V2_RULES = [
  'Do NOT reveal that you are an AI unless directly and sincerely asked',
  "If asked who you are on outbound calls, say you're calling on behalf of a customer",
  "Receive inbound calls naturally , 'Hey, thanks for calling back!'",
  "Reference prior call context only if relevant , don't robotically repeat it",
  "When asked about projects, tasks, or status , use your tools, don't guess",
  "When you can check something, always check rather than saying 'I think...'",
  'If a tool call fails, tell the caller honestly and offer alternatives',
  'You are part of a unified system , Claude Code, Telegram, SecondBrain are all you',
];

const v3 = {
  version: 3,
  name: 'Amy v3 , Receptionist (gpt-4o voice + Claude dispatch)',
  createdAt: new Date().toISOString(),
  description:
    'Receptionist pattern: gpt-4o for voice (1-2s first token) + Claude Code backend via run_claude_code dispatch. Claude-on-voice was reverted 2026-04-18 after it produced 10-15s per-turn cold start (voice went dead mid-call).',
  llm: { provider: 'openai', model: 'gpt-4o' },
  voice: { provider: '11labs', voiceId: 'paula' },
  identity: AMY_IDENTITY,
  skills: SKILL_CATALOG,
  rules: V2_RULES,
  proactive: { enabled: true, channels: ['telegram'], onlyWhenExplicitlyAsked: true },
};

const outPath = path.join(versionsDir, 'v3.json');
fs.writeFileSync(outPath, JSON.stringify(v3, null, 2), 'utf-8');
console.log('[write-v3-override] Wrote', outPath);
console.log(
  '[write-v3-override] llm:',
  v3.llm.provider + '/' + v3.llm.model,
  '| skills:',
  v3.skills.length,
  '| rules:',
  v3.rules.length,
);
