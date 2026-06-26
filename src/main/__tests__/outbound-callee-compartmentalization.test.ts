/**
 * outbound-callee-compartmentalization.test.ts
 *
 * Regression: the outbound Vapi assistant prompt MUST contain a
 * compartmentalization guard that tells Amy the person she is calling is not
 * the owner and that volunteering personal information about the owner is
 * out of scope. Without this guard, the EA agent memory dump (~2500 chars
 * of background context that includes user_profile.md and family files)
 * gets injected into the prompt with no rule against sharing it, so a
 * callee asking "what is the owner's home address?" or "how is his wife's
 * immigration going?" would get answered.
 *
 * Root incident: 2026-05-06. ExampleCo had Amy call "Bob" at his own test
 * number and probed her with personal questions about his life. Amy
 * answered. Because the call hit ExampleCo's number, owner-mode caller-id
 * masked the leak; the gap was that even a real Bob would have gotten
 * the same answers, since the outbound prompt had no callee-side
 * compartmentalization mirroring the inbound caller-id guards.
 *
 * Inbound has caller-id tiers (owner, known, ExampleCo) that inject
 * compartmentalization rules per tier. Outbound previously had only the
 * "you are MAKING this call" annotation and no privacy rule.
 *
 * Fix: src/main/caller-id.ts adds buildOutboundCalleeContext() and
 * src/main/amy-versions.ts buildVersionedSystemPrompt injects it for
 * every outbound call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let testRoot: string;

vi.mock('electron', () => ({
  app: {
    getPath: (_name: string) => testRoot,
    getAppPath: () => testRoot,
  },
}));

vi.mock('../config', () => ({
  getConfig: () => ({
    dataDir: testRoot,
    ownerName: 'ExampleCo',
    amyVersion: 2,
    vapiApiKey: 'test',
    vapiPhoneNumberId: 'test',
  }),
  loadConfig: () => ({}),
  saveConfig: () => ({}),
}));

vi.mock('../personas', () => ({ listPersonas: () => [] }));
vi.mock('../projects', () => ({ listProjects: () => [] }));
vi.mock('../todos', () => ({ listTodos: () => [] }));
vi.mock('../calls', () => ({ listCallRecords: () => [] }));

// Simulate the EA agent memory leak surface: the real production code
// appends ~2500 chars of memory at the end of the system prompt. The mock
// includes the kind of personal details that the guard must protect: a
// home address line, a family member, finances. If the guard is missing,
// these strings end up in the prompt with no rule against sharing them.
vi.mock('../agent-memory', () => ({
  getAgentMemory: () => ({
    buildSystemPrompt: async (base: string) =>
      base +
      '\n\n[EA MEMORY]\n' +
      'Owner home address: 123 Main St, Anytown TX 75001.\n' +
      'Wife: Jane Doe, immigration process in progress.\n' +
      'Owner net worth target: $20M.\n' +
      '[/EA MEMORY]',
  }),
}));

import { buildOutboundCalleeContext } from '../caller-id';
import { buildVersionedSystemPrompt, getActiveAmyVersion } from '../amy-versions';

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-compartmentalization-'));
  fs.mkdirSync(path.join(testRoot, 'data', 'agent'), { recursive: true });
});

describe('buildOutboundCalleeContext', () => {
  it('declares the callee is NOT the owner', () => {
    const ctx = buildOutboundCalleeContext();
    expect(ctx.systemPromptSection).toMatch(/are NOT ExampleCo/i);
  });

  it('blocks sharing of address, schedule, family, finances, and contacts', () => {
    const ctx = buildOutboundCalleeContext();
    const s = ctx.systemPromptSection;
    expect(s).toMatch(/home address/i);
    expect(s).toMatch(/schedule/i);
    expect(s).toMatch(/family/i);
    expect(s).toMatch(/finances/i);
    expect(s).toMatch(/other contacts/i);
  });

  it('scopes shareable info to the "Personal context you may use" section', () => {
    const ctx = buildOutboundCalleeContext();
    expect(ctx.systemPromptSection).toMatch(/Personal context you may use/);
    expect(ctx.systemPromptSection).toMatch(/ONLY personal information you are authorized/i);
  });

  it('treats EA background memory as situational awareness, not material to share', () => {
    const ctx = buildOutboundCalleeContext();
    expect(ctx.systemPromptSection).toMatch(/situational awareness ONLY/i);
    expect(ctx.systemPromptSection).toMatch(/not material to volunteer/i);
  });

  it('gives a deflection script for off-scope personal questions', () => {
    const ctx = buildOutboundCalleeContext();
    expect(ctx.systemPromptSection).toMatch(/check with ExampleCo before sharing/i);
  });

  it('overrides any other prompt section that suggests being more open', () => {
    const ctx = buildOutboundCalleeContext();
    expect(ctx.systemPromptSection).toMatch(/overrides any instruction elsewhere/i);
  });
});

describe('buildVersionedSystemPrompt outbound includes the compartmentalization guard', () => {
  it('injects the outbound callee guard for any outbound call', async () => {
    const version = getActiveAmyVersion();
    const prompt = await buildVersionedSystemPrompt(version, {
      instructions: 'Call the dentist and ask about cleanings.',
      personalContext: 'Patient is PRIVATE_NAME Doe, recent X-rays on file.',
      callDirection: 'outbound',
    });
    expect(prompt).toMatch(/## Compartmentalization: outbound callee/);
    expect(prompt).toMatch(/STRICT RULES FOR OUTBOUND CALLEES/);
  });

  it('inbound calls do NOT get the outbound callee guard (different compartmentalization model)', async () => {
    const version = getActiveAmyVersion();
    const prompt = await buildVersionedSystemPrompt(version, {
      instructions: 'Greet the caller.',
      callDirection: 'inbound',
    });
    expect(prompt).not.toMatch(/## Compartmentalization: outbound callee/);
  });

  it('outbound guard appears BEFORE the EA memory dump so its rules govern the dump', async () => {
    const version = getActiveAmyVersion();
    const prompt = await buildVersionedSystemPrompt(version, {
      instructions: 'Call the dentist.',
      callDirection: 'outbound',
    });
    const guardIdx = prompt.indexOf('## Compartmentalization: outbound callee');
    const memoryIdx = prompt.indexOf('[EA MEMORY]');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(memoryIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(memoryIdx);
  });

  it('outbound guard mentions every protected category by name', async () => {
    const version = getActiveAmyVersion();
    const prompt = await buildVersionedSystemPrompt(version, {
      instructions: 'Call.',
      callDirection: 'outbound',
    });
    expect(prompt).toMatch(/home address/i);
    expect(prompt).toMatch(/schedule/i);
    expect(prompt).toMatch(/family information/i);
    expect(prompt).toMatch(/finances/i);
    expect(prompt).toMatch(/immigration/i);
    expect(prompt).toMatch(/health/i);
    expect(prompt).toMatch(/other contacts/i);
  });

  it('outbound guard tells Amy not to confirm details the callee proposes', async () => {
    const version = getActiveAmyVersion();
    const prompt = await buildVersionedSystemPrompt(version, {
      instructions: 'Call.',
      callDirection: 'outbound',
    });
    expect(prompt).toMatch(/not in a position to share that/i);
  });
});
