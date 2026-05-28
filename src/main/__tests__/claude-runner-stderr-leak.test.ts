/**
 * Regression: claude-runner must never leak subprocess stderr into the
 * user-facing `output`.
 *
 * The bug: spawnClaudeCore built `output = stdout + "\n\nSTDERR:\n" + stderr`.
 * The command-queue worker posts `output` verbatim as Amy's Telegram reply,
 * so benign Claude Code plumbing ("SessionEnd hook ... failed: Hook cancelled")
 * got stapled onto every answer and sent to Luke. He had no idea what it was
 * and asked Amy "Failed hook canceled? What does that mean" -- and that reply
 * carried the same noise again.
 *
 * Fix: assembleRunResult returns stdout as the only user-facing channel and
 * keeps stderr in a separate diagnostic field, never concatenated.
 *
 * Frugal style per feedback_frugal_regression_tests.md: pure function, no
 * subprocess, no real timers.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppPath: () => '/tmp/secondbrain-test', getPath: () => '/tmp/secondbrain-test', isPackaged: false },
}));
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

import { assembleRunResult, getSecondBrainRoot } from '../claude-runner';

const HOOK_NOISE =
  'SessionEnd hook [node "${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs" SessionEnd] failed: Hook cancelled';

describe('assembleRunResult', () => {
  it('never concatenates stderr into the user-facing output', () => {
    const r = assembleRunResult('TLDR: the answer Luke asked for.', HOOK_NOISE, 0);
    expect(r.output).toBe('TLDR: the answer Luke asked for.');
    expect(r.output).not.toContain('STDERR:');
    expect(r.output).not.toContain('Hook cancelled');
    expect(r.output).not.toContain('session-lifecycle-hook');
  });

  it('keeps stderr in a separate diagnostic field', () => {
    const r = assembleRunResult('answer', HOOK_NOISE, 0);
    expect(r.stderr).toBe(HOOK_NOISE);
  });

  it('omits the stderr field entirely when stderr is empty', () => {
    const r = assembleRunResult('answer', '   \n  ', 0);
    expect(r.stderr).toBeUndefined();
  });

  it('exit code 0 is success, non-zero is failure', () => {
    expect(assembleRunResult('ok', '', 0).success).toBe(true);
    expect(assembleRunResult('', 'boom', 1).success).toBe(false);
    expect(assembleRunResult('', '', -1).success).toBe(false);
  });

  it('trims output but does not invent content on a stderr-only failure', () => {
    const r = assembleRunResult('  \n', HOOK_NOISE, 143);
    expect(r.output).toBe('');
    expect(r.success).toBe(false);
  });
});

describe('getSecondBrainRoot', () => {
  it('honors SECONDBRAIN_ROOT when set', () => {
    const prev = process.env.SECONDBRAIN_ROOT;
    process.env.SECONDBRAIN_ROOT = 'D:/custom/secondbrain';
    try {
      expect(getSecondBrainRoot()).toBe('D:/custom/secondbrain');
    } finally {
      if (prev === undefined) delete process.env.SECONDBRAIN_ROOT;
      else process.env.SECONDBRAIN_ROOT = prev;
    }
  });

  it('falls back to a derived path that points at the secondbrain repo', () => {
    const prev = process.env.SECONDBRAIN_ROOT;
    delete process.env.SECONDBRAIN_ROOT;
    try {
      const root = getSecondBrainRoot();
      expect(root).toContain('secondbrain');
      expect(root).not.toContain('app.asar');
    } finally {
      if (prev !== undefined) process.env.SECONDBRAIN_ROOT = prev;
    }
  });
});
