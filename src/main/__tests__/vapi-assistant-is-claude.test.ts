/**
 * vapi-assistant-is-claude.test.ts
 *
 * Regression guard: the live Vapi callback assistant MUST run Claude via
 * custom-llm pointing at the EC2 Claude Max proxy. Not openai/gpt-4o, not
 * Anthropic API directly, not any paid endpoint. Non-negotiable need #1
 * from MEMORY.md: "One Amy, not five." If this test fails, someone (me)
 * flipped Amy to a different brain and she is no longer the same Claude
 * instance that runs in terminal, briefings, and overnight jobs.
 *
 * Root incident: 2026-04-16 — four separate flips from custom-llm Claude
 * back to openai/gpt-4o in one debugging session, each rationalized as
 * "pragmatic fallback while Claude routing is flaky." Each flip violated
 * non-negotiable need #1. See memory/feedback_amy_must_be_claude_not_gpt.md
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

describe('Vapi callback assistant — Amy must BE Claude, not gpt-4o', () => {
  const config = loadConfig();
  const hasCreds = config.vapiApiKey && config.callbackAssistantId;
  const itOrSkip = hasCreds ? it : it.skip;

  itOrSkip('live Vapi assistant uses custom-llm provider', async () => {
    const a = await fetchVapiAssistant(config.callbackAssistantId, config.vapiApiKey);
    const provider = a?.model?.provider;
    expect(
      provider,
      `Vapi provider is "${provider}" but must be "custom-llm" (routes through Claude Max proxy). ` +
        `gpt-4o/openai/anthropic-direct are all forbidden. Non-negotiable need #1: One Amy.`,
    ).toBe('custom-llm');
  });

  itOrSkip('live Vapi model is Claude', async () => {
    const a = await fetchVapiAssistant(config.callbackAssistantId, config.vapiApiKey);
    const model = a?.model?.model || '';
    expect(
      model.toLowerCase(),
      `Vapi model is "${model}" but must start with "claude-". Amy must be the same ` +
        `Claude brain as claude -p and briefings.`,
    ).toMatch(/^claude-/);
  });

  itOrSkip('live Vapi custom-llm url routes to our EC2 proxy, not a paid provider', async () => {
    const a = await fetchVapiAssistant(config.callbackAssistantId, config.vapiApiKey);
    const url = a?.model?.url || '';
    expect(
      url,
      `Vapi model.url is "${url}" but must point at the EC2 Claude Max proxy ` +
        `(ec2BaseUrl + /chat/completions). Never api.anthropic.com or api.openai.com.`,
    ).not.toMatch(/api\.(openai|anthropic|groq)\.com/i);
    expect(url).toMatch(/\/chat\/completions$/);
  });

  itOrSkip('firstMessage greets the owner by name, not generic desk pickup', async () => {
    const a = await fetchVapiAssistant(config.callbackAssistantId, config.vapiApiKey);
    const fm = (a?.firstMessage || '').toLowerCase();
    const owner = (config.ownerName || 'Luke').toLowerCase();
    expect(
      fm,
      `firstMessage "${a?.firstMessage}" must address ${config.ownerName || 'Luke'} by name. ` +
        `Generic "Hi there, how can I help you?" means the assistant has drifted from the ` +
        `owner-inbound config and is being treated as a sales callback.`,
    ).toContain(owner);
  });
});
