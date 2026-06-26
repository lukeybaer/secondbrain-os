/**
 * vapi-assistant-is-claude.test.ts
 *
 * Regression guard: Amy on Vapi is a FAST voice receptionist that dispatches
 * real work to Claude Code via run_claude_code. The voice layer is gpt-4o
 * (1-2s first token) because custom-llm Claude has 10-15s cold starts per
 * turn that make voice pipelines hang. "One Amy" is preserved through
 * shared memory + identity + the run_claude_code dispatch path (which
 * routes to the Claude Max proxy).
 *
 * Requirements this test enforces:
 *   1. Voice layer is gpt-4o (or a future fast alternative) — openai is OK
 *   2. run_claude_code dispatch tool is present — without it Amy cannot
 *      reach Claude and degrades to role-playing from stale memory
 *   3. query_knowledge tool is present — for fast historical recall
 *   4. firstMessage greets the owner by name (not "Hi there, how can I help")
 *
 * Root incident 2026-04-16: toggled between pure Claude-on-voice (too slow)
 * and gpt-4o-without-tools (stupid). Final resolution: gpt-4o dispatcher
 * with full tool set, Claude does the work via run_claude_code. Owner
 * validated this pattern against the 30-second round-trip that worked
 * the previous night.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const CONFIG_PATH = path.join(
  process.env.APPDATA || '',
  'secondbrain',
  'config.json',
);

function loadConfig(): any {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

async function fetchVapiAssistant(id: string, key: string): Promise<any> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(`https://api.vapi.ai/assistant/${id}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) return res.json();
    lastStatus = res.status;
    if (res.status !== 429) break;
    await new Promise((resolve) => setTimeout(resolve, [1000, 5000, 10000, 20000, 40000][attempt]));
  }
  throw new Error(`vapi GET ${lastStatus}`);
}

function listToolNames(a: any): string[] {
  const tools = a?.model?.tools || [];
  return tools
    .filter((t: any) => t && t.type === 'function' && t.function && t.function.name)
    .map((t: any) => t.function.name);
}

describe('Vapi callback assistant — receptionist dispatches to Claude', () => {
  const config = loadConfig();
  const hasCreds = config.vapiApiKey && config.callbackAssistantId;
  const itOrSkip = hasCreds ? it : it.skip;
  let assistantPromise: Promise<any> | null = null;
  const getAssistant = () => {
    assistantPromise ||= fetchVapiAssistant(config.callbackAssistantId, config.vapiApiKey);
    return assistantPromise;
  };

  itOrSkip('live Vapi model provider is openai OR custom-llm (no paid anthropic)', async () => {
    const a = await getAssistant();
    const provider = a?.model?.provider;
    expect(
      provider,
      `Vapi provider is "${provider}". Allowed: openai (fast voice) or custom-llm ` +
        `(future Claude-on-voice). Forbidden: anthropic (paid API), groq (paid), any ` +
        `other paid provider.`,
    ).toMatch(/^(openai|custom-llm)$/);
  }, 30000);

  itOrSkip('live Vapi assistant has run_claude_code dispatch tool', async () => {
    const a = await getAssistant();
    const names = listToolNames(a);
    expect(
      names,
      `Vapi tools: ${JSON.stringify(names)}. Missing run_claude_code means Amy ` +
        `has no path to reach Claude for substantive work. She will role-play answers ` +
        `from stale memory instead of dispatching. One Amy requires the dispatch link.`,
    ).toContain('run_claude_code');
  }, 30000);

  itOrSkip('live Vapi assistant has query_knowledge recall tool', async () => {
    const a = await getAssistant();
    const names = listToolNames(a);
    expect(names).toContain('query_knowledge');
  }, 30000);

  itOrSkip('firstMessage is neutral, never owner-flavored (non-owner callers must not be greeted as the owner)', async () => {
    // Inverted from the previous "must contain owner name" assertion on
    // 2026-05-10. Reason: the same Vapi assistant answers ALL inbound calls
    // (BAI candidates calling back, anyone dialing the number), and a
    // ExampleCo-flavored static firstMessage embarrassed ExampleCo when strangers
    // got greeted as him. The owner-branch warmth lives in calls.ts at
    // ~line 583 (callerIsOwner ternary inside buildCallbackAssistantConfig)
    // and is applied by the running app's syncCallbackAssistant ONLY when
    // the previous caller was the owner. The static push-amy-vapi-config.js
    // baseline must be neutral so non-owner inbound never hits a ExampleCo
    // greeting. See memory/AMY.md "Inbound call rules" section. If this
    // test fails because firstMessage now contains the owner name, do NOT
    // edit it back, fix the source that is reverting it, the previous
    // failure mode caused Codex to silently overwrite the script and
    // re-push owner-flavored greetings to live Vapi without coordination.
    const a = await getAssistant();
    const fm = (a?.firstMessage || '').toLowerCase();
    const owner = (config.ownerName || 'ExampleCo').toLowerCase();
    expect(
      fm.length,
      `firstMessage must be non-empty so the call doesn't open in dead air.`,
    ).toBeGreaterThan(0);
    expect(
      fm,
      `firstMessage "${a?.firstMessage}" must NOT address ${config.ownerName || 'ExampleCo'} by name. ` +
        `Static firstMessage is greeted to ALL inbound callers including strangers; ` +
        `owner-warmth is applied dynamically by syncCallbackAssistant in calls.ts. ` +
        `See memory/AMY.md "Inbound call rules" for the full rule.`,
    ).not.toContain(owner);
  }, 30000);

  itOrSkip('system prompt tells Amy to dispatch substantive questions to Claude', async () => {
    const a = await getAssistant();
    const sp = (a?.model?.messages?.[0]?.content || '').toLowerCase();
    expect(
      sp,
      `System prompt must instruct Amy to use run_claude_code for substantive work. ` +
        `Without explicit dispatch instructions, gpt-4o tries to answer from its own ` +
        `knowledge and makes things up about sessions, briefings, and ExampleCo's projects.`,
    ).toContain('run_claude_code');
  }, 30000);
});
