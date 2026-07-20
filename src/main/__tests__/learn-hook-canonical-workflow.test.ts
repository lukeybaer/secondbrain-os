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

// 2026-07-20: this helper used to return { systemMessage }. That field renders
// to ExampleCo's terminal and NEVER enters model context, so every content
// assertion below was green while the workflow it locked reached nobody. A
// test that pins the CONTENT of a dead channel is worse than no test: it
// manufactures confidence. It now reads the delivered channel, so a
// regression to systemMessage fails here instead of passing silently.
function deliveredContext(prompt = '#learn remember this'): string {
  const stdout = runRawHook(prompt);
  const parsed = JSON.parse(stdout);
  return parsed?.hookSpecificOutput?.additionalContext ?? '';
}

describe('#learn hook (scripts/claude-hooks/learn-and-usage.js)', () => {
  let msg: string;

  it('delivers the workflow into MODEL context, not the terminal-only channel', () => {
    const stdout = runRawHook('#learn remember this');
    const parsed = JSON.parse(stdout);
    expect(
      parsed?.hookSpecificOutput?.additionalContext,
      'the #learn workflow must arrive as additionalContext; systemMessage never reaches Amy',
    ).toBeTruthy();
    expect(parsed).not.toHaveProperty('systemMessage');
    msg = parsed.hookSpecificOutput.additionalContext;
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(200);
  });

  it('stays silent for ordinary prompts when Claude matcher leaks', () => {
    expect(runRawHook('Reply with exactly: OK')).toBe('');
  });

  describe('canonical workflow content (locked)', () => {
    beforeAll(() => {
      msg = deliveredContext();
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
