/**
 * Tests for the SessionStart ingest-mode stub hook.
 *
 * Verifies:
 *   1. The stub hook emits a ~200-400 token payload, NOT the ~10K Tier 1 load
 *   2. The stub contains the four rules ingest sessions must honor
 *   3. The main hook routes correctly when SECONDBRAIN_SESSION_MODE=ingest is set
 *   4. The main hook routes correctly when the env var is NOT set (legacy path)
 *
 * These tests shell out to bash to run the actual hook scripts, the same way
 * Claude Code runs them via settings.json hook registration. A purely-unit
 * test of the file contents would miss shell-quoting bugs, node -e failures,
 * and routing logic.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const INGEST_HOOK = path.join(REPO_ROOT, 'scripts', 'claude-hooks', 'session-start-inject-ingest.sh');
const MAIN_HOOK = path.join(REPO_ROOT, 'scripts', 'claude-hooks', 'session-start-inject.sh');

/** Rough token estimator: 4 chars per token. Good enough for stub sizing assertions. */
function approxTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

/** Run a bash script with a given environment and return { stdout, bytes, tokens }. */
function runHook(scriptPath: string, env: Record<string, string> = {}): {
  stdout: string;
  bytes: number;
  tokens: number;
} {
  const stdout = execFileSync('bash', [scriptPath], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  const bytes = Buffer.byteLength(stdout, 'utf8');
  return { stdout, bytes, tokens: approxTokens(bytes) };
}

describe('session-start-inject-ingest.sh', () => {
  it('exists on disk at the expected path', () => {
    expect(fs.existsSync(INGEST_HOOK)).toBe(true);
  });

  it('emits valid JSON with a systemMessage field', () => {
    const { stdout } = runHook(INGEST_HOOK);
    const parsed = JSON.parse(stdout) as { systemMessage?: string };
    expect(typeof parsed.systemMessage).toBe('string');
    expect(parsed.systemMessage!.length).toBeGreaterThan(100);
  });

  it('emits a payload smaller than 3000 bytes (~750 tokens max)', () => {
    const { bytes, tokens } = runHook(INGEST_HOOK);
    expect(bytes).toBeLessThan(3000);
    expect(tokens).toBeLessThan(750);
  });

  it('contains all four rules ingest sessions must honor', () => {
    const { stdout } = runHook(INGEST_HOOK);
    const parsed = JSON.parse(stdout) as { systemMessage: string };
    const msg = parsed.systemMessage;

    expect(msg).toContain('Raw archival');
    expect(msg).toContain('Fail loud');
    expect(msg).toContain('Graphiti');
    expect(msg).toContain('Escalate');
  });

  it('explicitly tells the session NOT to load Tier 1 context', () => {
    const { stdout } = runHook(INGEST_HOOK);
    const parsed = JSON.parse(stdout) as { systemMessage: string };
    expect(parsed.systemMessage).toMatch(/Do NOT load MEMORY\.md/);
  });

  it('documents the queue layout the drain worker must follow', () => {
    const { stdout } = runHook(INGEST_HOOK);
    const parsed = JSON.parse(stdout) as { systemMessage: string };
    const msg = parsed.systemMessage;
    expect(msg).toContain('pending/');
    expect(msg).toContain('done/');
    expect(msg).toContain('failed/');
    expect(msg).toContain('escalated/');
    expect(msg).toContain('in-progress/');
  });
});

describe('session-start-inject.sh routing', () => {
  it('routes to the ingest stub when SECONDBRAIN_SESSION_MODE=ingest is set', () => {
    const { bytes, stdout } = runHook(MAIN_HOOK, { SECONDBRAIN_SESSION_MODE: 'ingest' });
    // The stub output is ~1600 bytes; the full Tier 1 load would be ~42000.
    expect(bytes).toBeLessThan(5000);
    const parsed = JSON.parse(stdout) as { systemMessage: string };
    expect(parsed.systemMessage).toContain('AMY INGEST SESSION');
  });

  it('routes to the full Tier 1 load when SECONDBRAIN_SESSION_MODE is not set AND SECONDBRAIN_ROOT resolves to the repo', () => {
    const { bytes, stdout } = runHook(MAIN_HOOK, { SECONDBRAIN_ROOT: REPO_ROOT });
    // The full load is ~40K bytes (~10K tokens). We assert the lower bound,
    // not an exact size, because MEMORY.md + state-locations grow over time.
    expect(bytes).toBeGreaterThan(20000);
    const parsed = JSON.parse(stdout) as { systemMessage: string };
    expect(parsed.systemMessage).toContain('AMY SESSION START');
    // Sanity: the full load includes at least one heading from MEMORY.md
    expect(parsed.systemMessage).toContain('MEMORY.md');
  });

  it('the ingest route produces a payload at least 10x smaller than the full Tier 1 route', () => {
    const stubBytes = runHook(MAIN_HOOK, { SECONDBRAIN_SESSION_MODE: 'ingest' }).bytes;
    const fullBytes = runHook(MAIN_HOOK, { SECONDBRAIN_ROOT: REPO_ROOT }).bytes;
    const ratio = fullBytes / stubBytes;
    expect(ratio).toBeGreaterThan(10);
  });
});
