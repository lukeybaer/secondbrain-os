/**
 * Tests for task-extract.ts, smart #amy dispatch extraction.
 *
 * config and claude-runner are mocked (no electron, no subprocess). All LLM
 * traffic routes through the owner's Claude Max subscription via runClaudeCode
 * (claude-runner.ts) -- never a paid host. Covers the safe-fallback paths
 * (empty input, runner failure, garbage response) and the confident path.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockConfig: { openaiApiKey: string; openaiLightModel: string } = {
  openaiApiKey: '',
  openaiLightModel: 'gpt-4o-mini',
};

vi.mock('../config', () => ({
  getConfig: () => mockConfig,
}));

// runClaudeCode is the canonical Claude Max routing. The mock lets each test
// drive the RunResult the extractor sees, with no subprocess.
const mockRunClaudeCode = vi.fn();
vi.mock('../claude-runner', () => ({
  runClaudeCode: (...args: unknown[]) => mockRunClaudeCode(...args),
}));

import { extractDispatch } from '../task-extract';

beforeEach(() => {
  mockRunClaudeCode.mockReset();
});

/** Build a successful RunResult whose output carries a JSON object. */
function claudeJson(obj: unknown, wrap = false): void {
  const json = JSON.stringify(obj);
  mockRunClaudeCode.mockResolvedValue({
    output: wrap ? `Here is the result:\n\`\`\`json\n${json}\n\`\`\`` : json,
    success: true,
    exitCode: 0,
  });
}

describe('extractDispatch fallbacks (never auto-run on uncertainty)', () => {
  it('empty input is not confident', async () => {
    const r = await extractDispatch('   ');
    expect(r.confident).toBe(false);
    expect(r.prompt).toBe('');
  });

  it('when the Claude runner fails, returns the raw text NOT confident', async () => {
    mockRunClaudeCode.mockResolvedValue({ output: '', success: false, exitCode: 1 });
    const r = await extractDispatch('do the thing');
    expect(r.confident).toBe(false);
    expect(r.prompt).toBe('do the thing');
  });

  it('a runner exception falls back to NOT confident', async () => {
    mockRunClaudeCode.mockRejectedValue(new Error('spawn failed'));
    const r = await extractDispatch('do the thing');
    expect(r.confident).toBe(false);
  });

  it('a garbage response body falls back to NOT confident', async () => {
    mockRunClaudeCode.mockResolvedValue({ output: 'not json at all', success: true, exitCode: 0 });
    const r = await extractDispatch('do the thing');
    expect(r.confident).toBe(false);
  });
});

describe('extractDispatch confident path', () => {
  it('returns the cleaned instruction and confident=true', async () => {
    claudeJson({
      instruction: 'Email Bryant the Q3 deck.',
      confident: true,
      reason: 'clear actionable request',
    });
    const r = await extractDispatch('hashtag amy uh send bryant the the deck');
    expect(r.prompt).toBe('Email Bryant the Q3 deck.');
    expect(r.confident).toBe(true);
  });

  it('parses the JSON object even when Claude wraps it in prose / fences', async () => {
    claudeJson(
      { instruction: 'Email Bryant the Q3 deck.', confident: true, reason: 'clear' },
      true,
    );
    const r = await extractDispatch('hashtag amy send bryant the deck');
    expect(r.prompt).toBe('Email Bryant the Q3 deck.');
    expect(r.confident).toBe(true);
  });

  it('honors confident=false from the model even when an instruction is returned', async () => {
    claudeJson({
      instruction: 'Possibly approve something.',
      confident: false,
      reason: 'too garbled to be sure',
    });
    const r = await extractDispatch('you Hashtag Amy and I approve the second one I I');
    expect(r.confident).toBe(false);
    expect(r.prompt).toBe('Possibly approve something.');
  });
});
