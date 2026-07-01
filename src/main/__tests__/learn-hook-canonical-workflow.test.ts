// Lock the #learn hook output to the canonical workflow.
//
// Why: 2026-04-29 #gap. ExampleCo's #learn hook fired (or was supposed to) but the
// hook script (scripts/claude-hooks/learn-and-usage.js) had drifted from the
// current memory architecture: it told Claude to save to ~/.claude/memory/,
// which memory-path-enforce.sh then blocks. It also omitted the Graphiti
// addEpisode step and the commit/push step that claude-config/CLAUDE.global.md
// specifies. Two contradictory hooks plus a stale workflow plus no regression
// test left the system in a state where #learn produced a free-form save
// instead of the structured workflow.
//
// This test runs the hook script and asserts the JSON systemMessage contains
// every load-bearing step. If a future edit removes a step or reverts the
// path, this test fails before the change ships.

import { beforeAll, describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HOOK = path.join(REPO_ROOT, 'scripts', 'claude-hooks', 'learn-and-usage.js');

function runRawHook(prompt: string): string {
  return execSync(`node "${HOOK}"`, {
    encoding: 'utf8',
    input: JSON.stringify({ prompt }),
    timeout: 10_000,
  });
}

function runHook(prompt = '#learn remember this'): { systemMessage: string } {
  const stdout = runRawHook(prompt);
  return JSON.parse(stdout);
}

describe('#learn hook (scripts/claude-hooks/learn-and-usage.js)', () => {
  let msg: string;

  it('produces valid JSON with a systemMessage field', () => {
    const out = runHook();
    expect(out).toHaveProperty('systemMessage');
    expect(typeof out.systemMessage).toBe('string');
    expect(out.systemMessage.length).toBeGreaterThan(200);
    msg = out.systemMessage;
  });

  it('stays silent for ordinary prompts when Claude matcher leaks', () => {
    expect(runRawHook('Reply with exactly: OK')).toBe('');
  });

  describe('canonical workflow content (locked)', () => {
    beforeAll(() => {
      msg = runHook().systemMessage;
    });

    it('opens with a loud "HOOK FIRED" marker so it is hard to miss', () => {
      expect(msg).toMatch(/#LEARN HOOK FIRED/i);
    });

    it('directs writes to project-relative secondbrain/memory/, not ~/.claude/memory/', () => {
      expect(msg).toContain('secondbrain/memory/');
      expect(msg).toMatch(/Do NOT default to ~\/\.claude\/memory\/|blocked/);
    });

    it('requires a CHECK step that reads MEMORY.md and RULES_INDEX.md before writing', () => {
      expect(msg).toMatch(/MEMORY\.md/);
      expect(msg).toMatch(/RULES_INDEX\.md/);
      expect(msg).toMatch(/CHECK|check existing|before writing/i);
    });

    it('requires Graphiti addEpisode / upsertMemory ingest step', () => {
      expect(msg).toMatch(/addEpisode|upsertMemory/);
    });

    it('requires regression test step for code-behavior learnings', () => {
      expect(msg).toMatch(/REGRESSION TEST|regression test|vitest/);
    });

    it('requires commit and push step', () => {
      expect(msg).toMatch(/COMMIT AND PUSH|commit and push/);
    });

    it('requires structured exec summary with bullet list, not free-form', () => {
      expect(msg).toMatch(/EXEC SUMMARY/);
      expect(msg).toMatch(/Bullet list|bullet list|bullet-list/);
    });

    it('contains no em dashes (CLAUDE.md global rule)', () => {
      expect(msg).not.toContain('—'); // em dash
    });
  });
});
