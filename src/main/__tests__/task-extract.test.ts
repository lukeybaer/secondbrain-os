/**
 * Tests for task-extract.ts, smart #amy dispatch extraction.
 *
 * config, claude-runner, and codex-runner are mocked (no electron, no
 * subprocess). Strict-JSON extraction follows the provider LADDER:
 * codex (subscription, read-only) -> claude CLI (subscription) -> OpenAI API
 * floor only when the charged-LLM approval gate is active. Covers the
 * safe-fallback paths (empty input, every rung failing, garbage response), the
 * per-rung descent, and the confident path. The
 * not-confident terminal fallback is unchanged: when the whole ladder fails
 * the dispatch is recorded but held for a human, never auto-run.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockConfig: { openaiApiKey: string; openaiLightModel: string } = {
  openaiApiKey: '',
  openaiLightModel: 'gpt-4o-mini',
};

vi.mock('../config', () => ({
  getConfig: () => mockConfig,
}));

// The claude rung. The mock lets each test drive the RunResult the extractor
// sees, with no subprocess.
const mockRunClaudeCode = vi.fn();
vi.mock('../claude-runner', () => ({
  runClaudeCode: (...args: ExampleCo[]) => mockRunClaudeCode(...args),
}));

// The codex rung (first) and the OpenAI API floor (last). The real
// cli-output-guard classifier is loaded so sentinel handling matches prod.
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

import { extractDispatch } from '../task-extract';

beforeEach(() => {
  mockRunClaudeCode.mockReset();
  mockRunCodex.mockReset();
  mockRunOpenAiFloor.mockReset();
  // Defaults: codex and the charged floor fail, so the pre-ladder tests keep
  // their exact old semantics (claude is the deciding rung).
  mockRunCodex.mockResolvedValue({ text: null, exitCode: -1, failureReason: 'nonzero-exit' });
  mockRunOpenAiFloor.mockResolvedValue(null);
});

/** Build a successful RunResult whose output ExampleCos a JSON object. */
function claudeJson(obj: ExampleCo, wrap = false): void {
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
      instruction: 'Email PRIVATE_NAME the Q3 deck.',
      confident: true,
      reason: 'clear actionable request',
    });
    const r = await extractDispatch('hashtag amy uh send PRIVATE_NAME the the deck');
    expect(r.prompt).toBe('Email PRIVATE_NAME the Q3 deck.');
    expect(r.confident).toBe(true);
  });

  it('parses the JSON object even when Claude wraps it in prose / fences', async () => {
    claudeJson(
      { instruction: 'Email PRIVATE_NAME the Q3 deck.', confident: true, reason: 'clear' },
      true,
    );
    const r = await extractDispatch('hashtag amy send PRIVATE_NAME the deck');
    expect(r.prompt).toBe('Email PRIVATE_NAME the Q3 deck.');
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

describe('extractDispatch provider ladder (codex -> claude -> charged floor)', () => {
  it('answers from the read-only codex rung first and never consults claude', async () => {
    mockRunCodex.mockResolvedValue({
      text: JSON.stringify({
        instruction: 'Email PRIVATE_NAME the Q3 deck.',
        confident: true,
        reason: 'clear',
      }),
      exitCode: 0,
    });
    const r = await extractDispatch('hashtag amy send PRIVATE_NAME the deck');
    expect(r.prompt).toBe('Email PRIVATE_NAME the Q3 deck.');
    expect(r.confident).toBe(true);
    expect(mockRunClaudeCode).not.toHaveBeenCalled();
  });

  it('blocks the OpenAI API floor without ExampleCo approval even when codex and claude both fail', async () => {
    mockRunClaudeCode.mockResolvedValue({ output: '', success: false, exitCode: 1 });
    mockRunOpenAiFloor.mockImplementation(
      async (
        _prompt: ExampleCo,
        opts: { codexDown?: boolean; allowChargedLlmApi?: boolean },
      ) => {
        expect(opts.codexDown).toBe(true);
        expect(opts.allowChargedLlmApi).toBe(false);
        return null;
      },
    );
    const r = await extractDispatch('hashtag amy uh dentist friday');
    expect(r.prompt).toBe('hashtag amy uh dentist friday');
    expect(r.confident).toBe(false);
  });

  it('treats an exit-0 auth sentinel from claude as a rung failure, not JSON', async () => {
    mockRunClaudeCode.mockResolvedValue({
      output: 'Not logged in. Please run /login',
      success: true,
      exitCode: 0,
    });
    // floor also fails (default) -> not-confident terminal fallback
    const r = await extractDispatch('do the thing');
    expect(r.confident).toBe(false);
    expect(r.prompt).toBe('do the thing');
  });

  it('applies the destructive-action guard regardless of which rung answered', async () => {
    mockRunCodex.mockResolvedValue({
      text: JSON.stringify({
        instruction: 'Delete the production database backups.',
        confident: true,
        reason: 'clear',
      }),
      exitCode: 0,
    });
    const r = await extractDispatch('hashtag amy clean up the old backups');
    expect(r.confident).toBe(false);
    expect(r.reason).toContain('destructive-action guard');
  });
});
