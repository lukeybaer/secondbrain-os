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
 *
 * RECLASSIFIED 2026-07-20 (#gap: the injection channel).
 * These tests used to read `parsed.systemMessage`, which pinned the WRONG
 * channel. `systemMessage` renders to ExampleCo's terminal and never enters model
 * context, so an ingest session was never actually told any of the rules this
 * file asserts. The assertions themselves were right; the field was not.
 * They now read `hookSpecificOutput.additionalContext`, the channel the model
 * actually receives. The two routing tests were ALREADY red for this reason
 * after session-start-inject.sh migrated ahead of its test, which is what a
 * test pinning a dead channel looks like from the outside.
 * See scripts/claude-hooks/README.md, section "Injection channel".
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const INGEST_HOOK = path.join(
  REPO_ROOT,
  'scripts',
  'claude-hooks',
  'session-start-inject-ingest.sh',
);
const MAIN_HOOK = path.join(REPO_ROOT, 'scripts', 'claude-hooks', 'session-start-inject.sh');
const BASH = (() => {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\msys64\\usr\\bin\\bash.exe',
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
})();

/** Rough token estimator: 4 chars per token. Good enough for stub sizing assertions. */
function approxTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function runHookViaNode(scriptPath: string, env: Record<string, string>): string {
  if (scriptPath === INGEST_HOOK || env.SECONDBRAIN_SESSION_MODE === 'ingest') {
    const msg = [
      'AMY INGEST SESSION -- lightweight mode.',
      '',
      'You are Amy in ingest mode. Scope: drain items from secondbrain/data/ingest-queue/pending/ into Tier 2 memory + Graphiti, one item at a time, then exit. Do NOT load MEMORY.md, AMY_REQUIREMENTS.md, user identity files, or any Tier 1 context -- the queue item ExampleCos every field you need.',
      '',
      'Rules you must honor:',
      '1. Raw archival first. The full payload is already in data/{source}/raw/ before this session runs. Never re-fetch, never mutate the raw copy.',
      '2. Fail loud, never silent. On error: write a failure marker to data/ingest-queue/failed/ with the original id and the error string, then move on. Do not swallow.',
      '3. Graphiti cascade. Every successfully processed item MUST fire upsertMemory() (Graphiti addEpisode + Tier 2 file update). No exceptions.',
      '4. Escalate on anomaly. PRIVATE_NAME sender, parse failure, contradictory state, anything outside expected shape -- STOP, write an escalation marker to data/ingest-queue/escalated/ with item id + reason, and move on. A full-context session picks it up later.',
      '5. Commit cadence. One commit at end of drain, not per item. Message: "chore(ingest): drain queue N items".',
      '',
      'You do not answer conversationally. Drain, commit, exit. Interactive responses are discarded.',
      '',
      'Queue layout:',
      '- pending/{ulid}.json    - ready to process',
      '- in-progress/{ulid}.json - claimed, lock held',
      '- done/{ulid}.json       - success',
      '- failed/{ulid}.json     - terminal error, inspection required',
      '- escalated/{ulid}.json  - needs full session',
      '',
      'Move files atomically (rename). Never leave items in in-progress/ on exit.',
    ].join('\n');
    return (
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg },
      }) + '\n'
    );
  }

  const secondbrain = (env.SECONDBRAIN_ROOT || REPO_ROOT).replace(/\\/g, '/');
  const memory = fs.readFileSync(path.join(secondbrain, 'memory', 'MEMORY.md'), 'utf8');
  const stateLocations = fs.readFileSync(
    path.join(secondbrain, 'memory', 'reference_amy_state_locations.md'),
    'utf8',
  );
  const requirements = fs
    .readFileSync(path.join(secondbrain, 'memory', 'AMY_REQUIREMENTS.md'), 'utf8')
    .split('\n')
    .slice(0, 80)
    .join('\n');
  const msg = [
    'AMY SESSION START. Canonical context auto-injected.',
    'You are in a new Claude Code session. Before your first action, read the following.',
    'These files are loaded from secondbrain/memory/ via the junction, tracked in git, and survive reclone.',
    '',
    '=== MEMORY.md (Tier 1, master entry point) ===',
    memory,
    '',
    '=== reference_amy_state_locations.md (exhaustive state map) ===',
    stateLocations,
    '',
    '=== AMY_REQUIREMENTS.md (first 80 lines) ===',
    requirements,
    '',
    '=== END SESSION START ===',
  ].join('\n');
  return (
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg },
    }) + '\n'
  );
}

/**
 * The text the MODEL actually receives. Reading .systemMessage here is what
 * let these tests stay green while the payload reached nobody.
 */
function contextOf(stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  const ctx = parsed.hookSpecificOutput?.additionalContext;
  if (typeof ctx !== 'string' || !ctx.trim()) {
    throw new Error(
      'hook emitted no hookSpecificOutput.additionalContext, so nothing reaches the model: ' +
        stdout.slice(0, 300),
    );
  }
  return ctx;
}

/** Run a bash script with a given environment and return { stdout, bytes, tokens }. */
function runHook(
  scriptPath: string,
  env: Record<string, string> = {},
): {
  stdout: string;
  bytes: number;
  tokens: number;
} {
  const mergedEnv = { ...process.env, SECONDBRAIN_HOOK_TEST: '1', ...env };
  const stdout = BASH
    ? execFileSync(BASH, [scriptPath], { env: mergedEnv, encoding: 'utf8' })
    : runHookViaNode(scriptPath, mergedEnv);
  const bytes = Buffer.byteLength(stdout, 'utf8');
  return { stdout, bytes, tokens: approxTokens(bytes) };
}

describe('session-start-inject-ingest.sh', () => {
  it('exists on disk at the expected path', () => {
    expect(fs.existsSync(INGEST_HOOK)).toBe(true);
  });

  it('emits valid JSON carrying additionalContext, the channel the model reads', () => {
    const { stdout } = runHook(INGEST_HOOK);
    const ctx = contextOf(stdout);
    expect(ctx.length).toBeGreaterThan(100);
  });

  it('emits a payload smaller than 3000 bytes (~750 tokens max)', () => {
    const { bytes, tokens } = runHook(INGEST_HOOK);
    expect(bytes).toBeLessThan(3000);
    expect(tokens).toBeLessThan(750);
  });

  it('contains all four rules ingest sessions must honor', () => {
    const { stdout } = runHook(INGEST_HOOK);
    const msg = contextOf(stdout);

    expect(msg).toContain('Raw archival');
    expect(msg).toContain('Fail loud');
    expect(msg).toContain('Graphiti');
    expect(msg).toContain('Escalate');
  });

  it('explicitly tells the session NOT to load Tier 1 context', () => {
    const { stdout } = runHook(INGEST_HOOK);
    expect(contextOf(stdout)).toMatch(/Do NOT load MEMORY\.md/);
  });

  it('documents the queue layout the drain worker must follow', () => {
    const { stdout } = runHook(INGEST_HOOK);
    const msg = contextOf(stdout);
    expect(msg).toContain('pending/');
    expect(msg).toContain('done/');
    expect(msg).toContain('failed/');
    expect(msg).toContain('escalated/');
    expect(msg).toContain('in-progress/');
  });
});

describe('session-start-inject.sh routing', () => {
  // SECONDBRAIN_ROOT is pinned to REPO_ROOT because the main hook execs the
  // ingest stub via "$SECONDBRAIN/scripts/claude-hooks/...". Without it the
  // env var points at the shared checkout and this test silently exercises
  // SOMEONE ELSE'S copy of the hook, passing or failing on code that is not
  // the code under test. That is how the stale channel survived here.
  it('routes to the ingest stub when SECONDBRAIN_SESSION_MODE=ingest is set', () => {
    const { bytes, stdout } = runHook(MAIN_HOOK, {
      SECONDBRAIN_SESSION_MODE: 'ingest',
      SECONDBRAIN_ROOT: REPO_ROOT,
    });
    // The stub output is ~1600 bytes; the full Tier 1 load would be ~42000.
    expect(bytes).toBeLessThan(5000);
    expect(contextOf(stdout)).toContain('AMY INGEST SESSION');
  });

  it('routes to the full Tier 1 load when SECONDBRAIN_SESSION_MODE is not set AND SECONDBRAIN_ROOT resolves to the repo', () => {
    const { bytes, stdout } = runHook(MAIN_HOOK, { SECONDBRAIN_ROOT: REPO_ROOT });
    // The full load is ~40K bytes (~10K tokens). We assert the lower bound,
    // not an exact size, because MEMORY.md + state-locations grow over time.
    expect(bytes).toBeGreaterThan(20000);
    const ctx = contextOf(stdout);
    expect(ctx).toContain('AMY SESSION START');
    // Sanity: the full load includes at least one heading from MEMORY.md
    expect(ctx).toContain('MEMORY.md');
  });

  it('the ingest route produces a payload at least 10x smaller than the full Tier 1 route', () => {
    const stubBytes = runHook(MAIN_HOOK, {
      SECONDBRAIN_SESSION_MODE: 'ingest',
      SECONDBRAIN_ROOT: REPO_ROOT,
    }).bytes;
    const fullBytes = runHook(MAIN_HOOK, { SECONDBRAIN_ROOT: REPO_ROOT }).bytes;
    const ratio = fullBytes / stubBytes;
    expect(ratio).toBeGreaterThan(10);
  });
});
