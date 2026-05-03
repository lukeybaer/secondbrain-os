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
 *   1. Voice layer is gpt-4o (or a future fast alternative) , openai is OK
 *   2. run_claude_code dispatch tool is present , without it EA cannot
 *      reach Claude and degrades to role-playing from stale memory
 *   3. query_knowledge tool is present , for fast historical recall
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
  const res = await fetch(`https://api.vapi.ai/assistant/${id}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`vapi GET ${res.status}`);
  return res.json();
}

function listToolNames(a: any): string[] {
  const tools = a?.model?.tools || [];
  return tools
    .filter((t: any) => t && t.type === 'function' && t.function && t.function.name)
    .map((t: any) => t.function.name);
}

describe('Vapi callback assistant , receptionist dispatches to Claude', () => {
  const config = loadConfig();
  const hasCreds = config.vapiApiKey && config.callbackAssistantId;
  const itOrSkip = hasCreds ? it : it.skip;

  itOrSkip('live Vapi model provider is openai OR custom-llm (no paid anthropic)', async () => {
    const a = await fetchVapiAssistant(config.callbackAssistantId, config.vapiApiKey);
    const provider = a?.model?.provider;
    expect(
      provider,
      `Vapi provider is "${provider}". Allowed: openai (fast voice) or custom-llm ` +
        `(future Claude-on-voice). Forbidden: anthropic (paid API), groq (paid), any ` +
        `other paid provider.`,
    ).toMatch(/^(openai|custom-llm)$/);
  });

  itOrSkip('live Vapi assistant has run_claude_code dispatch tool', async () => {
    const a = await fetchVapiAssistant(config.callbackAssistantId, config.vapiApiKey);
    const names = listToolNames(a);
    expect(
      names,
      `Vapi tools: ${JSON.stringify(names)}. Missing run_claude_code means Amy ` +
        `has no path to reach Claude for substantive work. She will role-play answers ` +
        `from stale memory instead of dispatching. One Amy requires the dispatch link.`,
    ).toContain('run_claude_code');
  });

  itOrSkip('live Vapi assistant has query_knowledge recall tool', async () => {
    const a = await fetchVapiAssistant(config.callbackAssistantId, config.vapiApiKey);
    const names = listToolNames(a);
    expect(names).toContain('query_knowledge');
  });

  itOrSkip('firstMessage greets the owner by name, not generic desk pickup', async () => {
    const a = await fetchVapiAssistant(config.callbackAssistantId, config.vapiApiKey);
    const fm = (a?.firstMessage || '').toLowerCase();
    const owner = (config.ownerName || 'Owner').toLowerCase();
    expect(
      fm,
      `firstMessage "${a?.firstMessage}" must address ${config.ownerName || 'Owner'} by name. ` +
        `Generic "Hi there, how can I help you?" means the assistant has drifted from the ` +
        `owner-inbound config.`,
    ).toContain(owner);
  });

  itOrSkip('system prompt tells Amy to dispatch substantive questions to Claude', async () => {
    const a = await fetchVapiAssistant(config.callbackAssistantId, config.vapiApiKey);
    const sp = (a?.model?.messages?.[0]?.content || '').toLowerCase();
    expect(
      sp,
      `System prompt must instruct Amy to use run_claude_code for substantive work. ` +
        `Without explicit dispatch instructions, gpt-4o tries to answer from its own ` +
        `knowledge and makes things up about sessions, briefings, and the owner's projects.`,
    ).toContain('run_claude_code');
  });
});
