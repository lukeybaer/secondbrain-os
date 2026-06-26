// Locks the spine-session-task hook so Claude Code (and Codex) sessions
// always appear in the Task spine.
//
// Why: 2026-05-28. ExampleCo flagged that "one Amy across surfaces" was untrue
// for PC sessions. Telegram, briefing, Vapi, Otter, Gmail all wrote Tasks
// to data/tasks/, but Claude Code sessions executed directly with no spine
// record. Dispatch never knew what an in-flight Claude Code session was
// working on. Fix: a SessionStart/UserPromptSubmit/Stop hook that creates
// and finalises a spine Task per session.
//
// Locked category, not literal trigger:
//   1. Running the hook with a fresh session id creates a Task file with
//      origin=claude-code, kind=action, status=running, and sessionId set.
//   2. Subsequent prompts update the same Task, not a new one (one Task
//      per session is the contract).
//   3. The Stop phase moves status -> done and records resultSummary.
//   4. Codex origin is honored when CLAUDE_AGENT_KIND=codex.
// Any future change that breaks any of these must fail this test before
// landing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HOOK = path.join(REPO_ROOT, 'scripts', 'claude-hooks', 'spine-session-task.mjs');

function runHook(
  phase: 'session-start' | 'prompt-submit' | 'stop',
  payload: Record<string, ExampleCo>,
  env: Record<string, string>,
): { stdout: string; stderr: string; code: number } {
  const json = JSON.stringify(payload);
  // Pipe payload to stdin. Use cmd /c to feed echo to node on Windows.
  try {
    const stdout = execSync(`node "${HOOK}" ${phase}`, {
      input: json,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: '', code: 0 };
  } catch (e: ExampleCo) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout || '', stderr: err.stderr || '', code: err.status ?? 1 };
  }
}

describe('spine-session-task hook (PC sessions land in Task spine)', () => {
  let tmpDir: string;
  let sessionId: string;
  let env: Record<string, string>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-session-task-'));
    sessionId = randomUUID();
    env = {
      SECONDBRAIN_TASKS_DIR: tmpDir,
      CLAUDE_SESSION_ID: sessionId,
      CLAUDE_PROJECT_DIR: REPO_ROOT,
    };
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  function taskFile(): string {
    return path.join(tmpDir, `spine-session-${sessionId}.json`);
  }

  function readTask(): Record<string, ExampleCo> {
    return JSON.parse(fs.readFileSync(taskFile(), 'utf8'));
  }

  it('session-start phase does NOT create a task by itself (no work yet)', () => {
    runHook('session-start', { session_id: sessionId }, env);
    expect(fs.existsSync(taskFile())).toBe(false);
  });

  it('first user prompt creates a Task with origin=claude-code and status=running', () => {
    runHook('prompt-submit', { prompt: 'audit the briefing card refresh logic' }, env);
    expect(fs.existsSync(taskFile())).toBe(true);
    const task = readTask();
    expect(task.id).toBe(`spine-session-${sessionId}`);
    expect(task.kind).toBe('action');
    expect(task.origin).toBe('claude-code');
    expect(task.status).toBe('running');
    expect(task.sessionId).toBe(sessionId);
    expect(task.prompt).toBe('audit the briefing card refresh logic');
    expect(task.title).toMatch(/audit the briefing/);
    expect(Array.isArray(task.history)).toBe(true);
  });

  it('subsequent prompts update the SAME task (one task per session)', () => {
    runHook('prompt-submit', { prompt: 'first prompt' }, env);
    runHook('prompt-submit', { prompt: 'second prompt followup' }, env);
    const task = readTask();
    expect(task.title).toMatch(/first prompt/);
    const meta = task.meta as { prompts?: string[] } | undefined;
    expect(meta?.prompts).toBeDefined();
    expect((meta?.prompts as string[]).length).toBe(2);
  });

  it('stop phase transitions to done and records resultSummary', () => {
    runHook('prompt-submit', { prompt: 'do the thing' }, env);
    runHook(
      'stop',
      { session_id: sessionId, summary: 'fixed the thing, committed abc1234' },
      env,
    );
    const task = readTask();
    expect(task.status).toBe('done');
    expect(task.completedAt).toBeDefined();
    expect((task.resultSummary as string) || '').toMatch(/fixed the thing/);
  });

  it('honors CLAUDE_AGENT_KIND=codex for Codex desktop sessions', () => {
    runHook('prompt-submit', { prompt: 'codex prompt' }, { ...env, CLAUDE_AGENT_KIND: 'codex' });
    const task = readTask();
    expect(task.origin).toBe('codex');
  });

  it('stop without a prior prompt-submit is a no-op (no empty task created)', () => {
    runHook('stop', { session_id: sessionId }, env);
    expect(fs.existsSync(taskFile())).toBe(false);
  });

  it('uses spine-session-{id} as the file id so the same session is idempotent', () => {
    runHook('prompt-submit', { prompt: 'p1' }, env);
    const createdAt1 = readTask().createdAt as string;
    runHook('prompt-submit', { prompt: 'p2' }, env);
    const createdAt2 = readTask().createdAt as string;
    expect(createdAt1).toBe(createdAt2);
  });

  it('is registered in .claude/settings.json for start, prompt, and stop phases', () => {
    const settingsPath = path.join(REPO_ROOT, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const commandsFor = (event: string) =>
      ((settings.hooks && settings.hooks[event]) || []).flatMap((group: { hooks?: Array<{ command?: string }> }) =>
        (group.hooks || []).map((hook) => hook.command || ''),
      );

    expect(
      commandsFor('SessionStart').some(
        (command: string) =>
          command.includes('spine-session-task.mjs') && command.includes('session-start'),
      ),
    ).toBe(true);
    expect(
      commandsFor('UserPromptSubmit').some(
        (command: string) =>
          command.includes('spine-session-task.mjs') && command.includes('prompt-submit'),
      ),
    ).toBe(true);
    expect(
      commandsFor('Stop').some(
        (command: string) => command.includes('spine-session-task.mjs') && command.includes('stop'),
      ),
    ).toBe(true);
    expect(
      commandsFor('Stop').some(
        (command: string) =>
          command.includes('git-janitor.js') &&
          command.includes('--apply') &&
          command.includes('--cap=5'),
      ),
    ).toBe(true);
  });
});
