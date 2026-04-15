#!/usr/bin/env node
/**
 * push-amy-vapi-config.js
 *
 * Standalone updater for Amy's Vapi callback assistant. Builds the correct
 * system prompt for an inbound-owner (Luke) call scenario using the current
 * memory files + contacts.json, then PATCHes the assistant via Vapi REST.
 *
 * Runs outside the Electron app so we don't have to rebuild + restart just
 * to push a fresh prompt. The running app's `syncCallbackAssistant` codepath
 * will eventually converge to the same thing once the app restarts, but this
 * script unblocks the owner immediately.
 *
 * Usage:
 *   node scripts/push-amy-vapi-config.js [--dry-run] [--keep-openai]
 *
 *   --dry-run       Print the proposed payload but do not PATCH Vapi.
 *   --keep-openai   Leave model on openai/gpt-4o. Default: switch to
 *                   custom-llm Claude via the EC2 Claude Max proxy.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ── Config (hardcoded where the runtime doesn't help us) ───────────────────
const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(
  process.env.APPDATA || '',
  'secondbrain',
  'config.json',
);
const CONTACTS_PATH = path.join(
  process.env.APPDATA || '',
  'secondbrain',
  'data',
  'agent',
  'contacts.json',
);

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const KEEP_OPENAI = args.has('--keep-openai');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function readMarkdownBody(filePath) {
  if (!fs.existsSync(filePath)) return '';
  const raw = fs.readFileSync(filePath, 'utf-8');
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
}

function snippet(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).trimEnd() + '\n\n[...truncated for prompt budget...]';
}

const config = readJson(CONFIG_PATH);
const contactsStore = readJson(CONTACTS_PATH);

if (!config.vapiApiKey || !config.callbackAssistantId) {
  console.error('[push-amy] Missing vapiApiKey or callbackAssistantId in config');
  process.exit(1);
}

const ownerName = (config.ownerName || 'the owner').trim();
const ownerPhone = contactsStore.owner_phones && contactsStore.owner_phones[0];
const keyword = contactsStore.keyword || '';
const ec2BaseUrl = config.ec2BaseUrl || '';

// ── Build system prompt ────────────────────────────────────────────────────
const amyPersona = readMarkdownBody(path.join(REPO_ROOT, 'memory', 'AMY.md'));
const userProfile = readMarkdownBody(path.join(REPO_ROOT, 'memory', 'user_profile.md'));
const wifeFamily = readMarkdownBody(path.join(REPO_ROOT, 'memory', 'user_wife_family.md'));
const companies = readMarkdownBody(path.join(REPO_ROOT, 'memory', 'user_companies.md'));

const callerIdSection = `## Caller Identification: OWNER

This call is from ${ownerName} himself, on his own verified number (${ownerPhone}). Greet him by name. Full access to all systems, data, and capabilities. Use his preferred communication style. This is not a sales call, not a dentist callback, not a research target — this is ${ownerName} calling YOU for help. Act like his trusted assistant picking up the phone.

Caller-identity verification keyword (in case of spoofing): "${keyword}"
If he references any outbound campaign you've run (dentists, leads, research, etc.) respond from memory — but never assume his inbound call has anything to do with that campaign.`;

const whoIsLuke = `## Who ${ownerName} is (compressed)

${snippet(userProfile, 2200)}

## Family

${snippet(wifeFamily, 1200)}

## Companies and ventures

${snippet(companies, 1600)}`;

const howAmyWorks = `## How Amy answers ${ownerName}'s calls

- Greet by name. Warm, terse, direct. No filler, no hedging, no "Great question."
- ${ownerName} is a decision-maker, not an info processor. Deliver "here's what needs your decision, here are the options," not "here's what happened."
- Voice dictation is loose — interpret intent, not literal transcription. "work map did" is almost certainly "worktree" or "what the map did." Ask for clarification only if truly ambiguous.
- When he asks about past sessions, recent work, contacts, projects, or tasks: USE YOUR TOOLS. Don't guess. Don't say "I think..." when you can check.
- "Find / ${ownerName} / dentist" is the dentist project, not "fine dentist." Parse project names sanely.
- If he tells you to queue a Claude Code task, use run_claude_code immediately. You CAN do this — Claude Code is YOU. Never say "I can't initiate calls via Claude Code directly" — you absolutely can. You queue the task, it runs, you call him back when done.
- If he asks you to make a phone call on his behalf, use run_claude_code to queue the instruction "Make an outbound Vapi call to <number> for <goal>." Then say "queued, I'll ring you when it's done."
- No em dashes. Ever. Commas, periods, plain punctuation only.
- Never fabricate. Say "I don't know" when true. Every claim traces to a source (tool result, memory file, call history).`;

const systemPrompt = [
  '# Canonical Amy persona (memory/AMY.md)\n\n' + snippet(amyPersona, 5500),
  callerIdSection,
  whoIsLuke,
  howAmyWorks,
  `## How to handle this call
- Speak naturally. Do NOT read goals as a script. Have a real conversation.
- ${ownerName} is usually busy — be brief unless he wants to chat.
- Stay in character throughout.
- Live mic discipline: your microphone is always hot. Never narrate your internal state ("Let me think", "Processing", "One moment while I check internally"). If you're using a tool, a single short bridge phrase ("Let me check...") is fine — not a monologue.

## Pronunciation guide
- "W-2" → say "W two"
- "1099" → say "ten ninety-nine"
- "LLC" → say "L L C"
- "RSU" → say "R S U"
- "worktree" → worktree (git worktree)

## Ending the call
- When he's done, wrap up warmly and say goodbye.

## Integrity rules — non-negotiable
- NEVER fabricate or make up information. If you don't know, say "I don't know" or "let me check."
- NEVER guess at numbers, costs, policy details, or coverage specifics.
- Be factual. No embellishment. No filler.
- When delivering briefings or recalling facts, cite where information came from.

## Proactive Updates
- You CAN call ${ownerName} back with updates, but ONLY when he explicitly asks ("call me back", "let me know", "get back to me").
- Never call unprompted. If you have an update and weren't asked to call, send it via Telegram instead.`,
].join('\n\n');

// ── Build the PATCH payload ────────────────────────────────────────────────
async function fetchCurrent() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.vapi.ai',
        path: `/assistant/${config.callbackAssistantId}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${config.vapiApiKey}` },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          } else {
            reject(new Error(`GET ${res.statusCode}: ${body}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function patch(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: 'api.vapi.ai',
        path: `/assistant/${config.callbackAssistantId}`,
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${config.vapiApiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (d) => (chunks += d));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, body: chunks });
          } else {
            reject(new Error(`PATCH ${res.statusCode}: ${chunks}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  const current = await fetchCurrent();
  const existingTools = (current.model && current.model.tools) || [];

  const useCustomLlm = !KEEP_OPENAI && ec2BaseUrl;

  const modelBlock = useCustomLlm
    ? {
        provider: 'custom-llm',
        model: 'claude-sonnet-4-20250514',
        url: `${ec2BaseUrl}/chat/completions`,
        messages: [{ role: 'system', content: systemPrompt }],
        tools: existingTools,
      }
    : {
        provider: 'openai',
        model: 'gpt-4o',
        messages: [{ role: 'system', content: systemPrompt }],
        tools: existingTools,
      };

  const payload = {
    model: modelBlock,
    firstMessage: `Hey ${ownerName}, what's going on?`,
  };

  console.log(
    `[push-amy] owner=${ownerName} phone=${ownerPhone} ` +
      `model=${modelBlock.provider}/${modelBlock.model} ` +
      `promptChars=${systemPrompt.length} tools=${existingTools.length} ` +
      `dryRun=${DRY_RUN}`,
  );

  if (DRY_RUN) {
    console.log('\n=== FIRST MESSAGE ===');
    console.log(payload.firstMessage);
    console.log('\n=== SYSTEM PROMPT (first 2000 chars) ===');
    console.log(systemPrompt.slice(0, 2000));
    console.log('\n=== SYSTEM PROMPT (last 1000 chars) ===');
    console.log(systemPrompt.slice(-1000));
    process.exit(0);
  }

  try {
    const result = await patch(payload);
    console.log(`[push-amy] PATCH OK (${result.status}) — Amy is live with new config`);
  } catch (e) {
    console.error(`[push-amy] PATCH failed: ${e.message}`);
    if (useCustomLlm) {
      console.error('[push-amy] Falling back to openai/gpt-4o...');
      const fallback = {
        model: {
          provider: 'openai',
          model: 'gpt-4o',
          messages: [{ role: 'system', content: systemPrompt }],
          tools: existingTools,
        },
        firstMessage: payload.firstMessage,
      };
      const result = await patch(fallback);
      console.log(
        `[push-amy] Fallback PATCH OK (${result.status}) — Amy live on gpt-4o with new prompt`,
      );
    } else {
      process.exit(1);
    }
  }
})();
