/**
 * Tests for the post-call reflection provider ladder in agent-memory.ts.
 *
 * THE live outage this fixes: runPostCallReflection required an Anthropic API
 * key and threw 'No ANTHROPIC_API_KEY configured' on every call, so every
 * reflection fell to the manual-review stub even with two healthy
 * subscriptions available. Reflection is simple bullet-generation, fully
 * portable, so it now follows the universal ladder:
 *   codex (read-only) -> claude CLI -> charged API floors only with approval
 *
 * Categories encoded:
 *  - each rung is only consulted when every rung above it failed
 *  - a sentinel (auth/quota error text) from a rung is a failure, not a result
 *  - total ladder failure NEVER throws: the caller logs and falls back to the
 *    manual-review stub, and the post-call pipeline keeps going
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-ladder-'));

vi.mock('electron', () => ({
  app: { getPath: () => testRoot, getAppPath: () => testRoot },
}));

vi.mock('../memory-index', () => ({
  buildMemoryContext: async () => '',
  upsertMemory: vi.fn(),
  appendToArchive: vi.fn(),
  appendWorkingMemory: vi.fn(),
  initMemoryIndex: vi.fn(),
  readWorkingMemory: () => '',
}));
vi.mock('../graphiti-client', () => ({
  buildKnowledgeContext: async () => '',
  ingestCallTranscript: async () => undefined,
}));
vi.mock('../session-archive', () => ({ buildSessionArchiveContext: async () => '' }));
vi.mock('../memory-sync', () => ({ readCanonicalMemory: async () => '' }));

const mockConfig = { anthropicApiKey: '', openaiApiKey: '', openaiLightModel: 'gpt-4o-mini' };
vi.mock('../config', () => ({ getConfig: () => mockConfig }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: async () => {
        throw new Error('anthropic SDK must not be reached in this test');
      },
    };
  },
}));

const mockRunCodex = vi.fn();
const mockRunOpenAiFloor = vi.fn();
vi.mock('../codex-runner', async () => {
  const { createRequire } = await import('module');
  const req = createRequire(import.meta.url);
  const guard = req('../../../scripts/lib/cli-output-guard.js');
  return {
    runCodex: (...args: ExampleCo[]) => mockRunCodex(...args),
    runOpenAiFloor: (...args: ExampleCo[]) => mockRunOpenAiFloor(...args),
    isCliFailureOutput: guard.isCliFailureOutput,
  };
});

const mockRunClaudeCode = vi.fn();
vi.mock('../claude-runner', () => ({
  runClaudeCode: (...args: ExampleCo[]) => mockRunClaudeCode(...args),
}));

import { generateReflectionViaLadder, getAgentMemory } from '../agent-memory';

beforeEach(() => {
  mockRunCodex.mockReset();
  mockRunCodex.mockResolvedValue({ text: null, exitCode: -1, failureReason: 'nonzero-exit' });
  mockRunClaudeCode.mockReset();
  mockRunClaudeCode.mockResolvedValue({ output: '', success: false, exitCode: 1 });
  mockRunOpenAiFloor.mockReset();
  mockRunOpenAiFloor.mockResolvedValue(null);
  mockConfig.anthropicApiKey = '';
  mockConfig.openaiApiKey = '';
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', '');
});

// -- ladder ordering with injected rungs --------------------------------------------

describe('generateReflectionViaLadder (injected rungs)', () => {
  it('uses codex first and never consults lower rungs', async () => {
    const claudeFn = vi.fn();
    const r = await generateReflectionViaLadder('reflect', {
      codexFn: async () => 'bullets from codex',
      claudeFn,
    });
    expect(r).toEqual({ text: 'bullets from codex', rung: 'codex-readonly' });
    expect(claudeFn).not.toHaveBeenCalled();
  });

  it('descends codex -> claude -> anthropic in order', async () => {
    const r1 = await generateReflectionViaLadder('reflect', {
      codexFn: async () => null,
      claudeFn: async () => 'bullets from claude',
    });
    expect(r1).toEqual({ text: 'bullets from claude', rung: 'claude-cli' });

    const r2 = await generateReflectionViaLadder('reflect', {
      codexFn: async () => null,
      claudeFn: async () => null,
      anthropicFn: async () => 'bullets from anthropic',
    });
    expect(r2).toEqual({ text: 'bullets from anthropic', rung: 'anthropic-api' });
  });

  it('lands on the OpenAI API floor when every subscription rung fails', async () => {
    const r = await generateReflectionViaLadder('reflect', {
      codexFn: async () => null,
      claudeFn: async () => {
        throw new Error('claude CLI missing');
      },
      anthropicFn: async () => null,
      openaiFn: async () => 'bullets from the paid floor',
    });
    expect(r).toEqual({ text: 'bullets from the paid floor', rung: 'openai-api-floor' });
  });

  it('returns text:null (never throws) on total ladder failure', async () => {
    const r = await generateReflectionViaLadder('reflect', {
      codexFn: async () => null,
      claudeFn: async () => null,
      anthropicFn: async () => {
        throw new Error('No ANTHROPIC_API_KEY configured');
      },
      openaiFn: async () => null,
    });
    expect(r).toEqual({ text: null, rung: null });
  });
});

// -- default rungs through the mocked modules ----------------------------------------

describe('generateReflectionViaLadder (default rungs)', () => {
  it('answers from the read-only codex rung', async () => {
    mockRunCodex.mockResolvedValue({ text: 'codex reflection', exitCode: 0 });
    const r = await generateReflectionViaLadder('reflect');
    expect(r).toEqual({ text: 'codex reflection', rung: 'codex-readonly' });
  });

  it('rejects an exit-0 auth sentinel from the claude CLI rung', async () => {
    // codex fails; claude "succeeds" with a login sentinel; no API keys set.
    mockRunClaudeCode.mockResolvedValue({
      output: 'Not logged in. Please run /login',
      success: true,
      exitCode: 0,
    });
    const r = await generateReflectionViaLadder('reflect');
    expect(r.text).toBeNull();
  });

  it('does not wake charged default rungs from API keys alone', async () => {
    mockConfig.anthropicApiKey = 'anthropic-key-present';
    mockConfig.openaiApiKey = 'sk-test-openai-key-present';
    const r = await generateReflectionViaLadder('reflect');
    expect(r).toEqual({ text: null, rung: null });
    expect(mockRunOpenAiFloor).toHaveBeenCalledWith(
      'reflect',
      expect.objectContaining({ codexDown: true, allowChargedLlmApi: false }),
    );
  });
});

// -- runPostCallReflection integration -------------------------------------------------

describe('runPostCallReflection', () => {
  const input = {
    callId: 'call-1',
    phoneNumber: '+15555550100',
    instructions: 'book a cleaning',
    outcome: 'no-answer',
  };

  it('uses the ladder result as the reflection', async () => {
    mockRunCodex.mockResolvedValue({ text: 'went well; speak slower next time', exitCode: 0 });
    const reflection = await getAgentMemory('ea').runPostCallReflection(input);
    expect(reflection).toBe('went well; speak slower next time');
  });

  it('never throws on total ladder failure and falls back to the manual-review stub', async () => {
    // Every rung fails (defaults from beforeEach). Must not throw.
    const reflection = await getAgentMemory('ea').runPostCallReflection(input);
    expect(reflection).toContain('manual review needed');
    expect(reflection).toContain('call-1');
  });
});
