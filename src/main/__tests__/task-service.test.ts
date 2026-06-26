/**
 * Tests for task-service.ts, the single dispatch entry point onto the Task
 * Spine. claude-runner and codex-runner are mocked so no real subprocess is
 * spawned; task-store is real, pointed at a temp directory.
 *
 * Covers: runTask creates a running task with a pid, the happy path drives an
 * action task to done, a coding task stops at awaiting-review (never
 * auto-done), a failed run drives the task to failed with the error captured,
 * the completion promise resolves with the result, and the watchdog timeout
 * fails a hung run.
 *
 * Provider ladder (2026-06-11): on a claude failure (nonzero exit OR an
 * exit-0 auth/quota sentinel) the task descends to a READ-ONLY codex run.
 * Text/research tasks may complete with 'via codex' provenance; coding tasks
 * record a 'codex-diagnosis (read-only)' summary and stop at awaiting-review,
 * never auto-complete. When the whole ladder is exhausted the task fails.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// -- claude-runner mock --------------------------------------------------------

interface MockRun {
  prompt: string;
  options: { cwd?: string };
  resolve: (r: { output: string; success: boolean; exitCode: number }) => void;
}

const runs: MockRun[] = [];
let mockPid: number | undefined = 4242;

vi.mock('../claude-runner', () => ({
  runClaudeCodeBackground: (prompt: string, options: { cwd?: string }) => {
    let resolve!: (r: { output: string; success: boolean; exitCode: number }) => void;
    const completion = new Promise<{ output: string; success: boolean; exitCode: number }>((r) => {
      resolve = r;
    });
    runs.push({ prompt, options, resolve });
    return { pid: mockPid, completion };
  },
  summarizeTaskOutput: async (output: string, success: boolean, exitCode: number) =>
    success ? `SUMMARY[${output}]` : `FAILSUMMARY[exit ${exitCode}]`,
  getSecondBrainRoot: () => testRoot,
}));

// -- codex-runner mock (the read-only fallback rung) -----------------------------
// The real sentinel classifier is loaded so the sentinel-detection category is
// tested against the shared cli-output-guard patterns, not a hand-rolled regex.

const mockRunCodex = vi.fn();

vi.mock('../codex-runner', async () => {
  const { createRequire } = await import('module');
  const req = createRequire(import.meta.url);
  const guard = req('../../../scripts/lib/cli-output-guard.js');
  return {
    runCodex: (...args: ExampleCo[]) => mockRunCodex(...args),
    isCliFailureOutput: guard.isCliFailureOutput,
  };
});

import { setTasksDir, getTask, createTask } from '../task-store';
import { runTask, runQueuedTask } from '../task-service';

let testRoot: string;

beforeEach(() => {
  runs.length = 0;
  mockPid = 4242;
  mockRunCodex.mockReset();
  // Default: the codex rung fails too, so pre-ladder tests keep their exact
  // old semantics (claude failure means task failure).
  mockRunCodex.mockResolvedValue({ text: null, exitCode: -1, failureReason: 'nonzero-exit' });
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-'));
  setTasksDir(path.join(testRoot, 'tasks'));
});

afterAll(() => {
  try {
    if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// -- create + spawn ------------------------------------------------------------

describe('runTask', () => {
  it('creates a running task with the pid recorded and spawns claude once', () => {
    const { task } = runTask({ kind: 'action', origin: 'telegram', prompt: 'do the thing' });
    expect(task.status).toBe('running');
    expect(task.pid).toBe(4242);
    expect(runs).toHaveLength(1);
    expect(runs[0].prompt).toBe('do the thing');
  });

  it('passes cwd, origin, kind, and source onto the task and spawn', () => {
    const { task } = runTask({
      kind: 'ingest',
      origin: 'gmail',
      prompt: 'triage',
      cwd: '/tmp/repo',
      source: { type: 'gmail', ref: 'msg-9' },
    });
    expect(task.origin).toBe('gmail');
    expect(task.kind).toBe('ingest');
    expect(task.source).toEqual({ type: 'gmail', ref: 'msg-9' });
    expect(runs[0].options.cwd).toBe('/tmp/repo');
  });
});

// -- happy path ----------------------------------------------------------------

describe('runTask completion', () => {
  it('drives an action task to done and resolves completion with the summary', async () => {
    const { task, completion } = runTask({ kind: 'action', origin: 'app', prompt: 'x' });
    runs[0].resolve({ output: 'all good', success: true, exitCode: 0 });
    const result = await completion;
    expect(result.success).toBe(true);
    expect(result.summary).toBe('SUMMARY[all good]');
    const final = getTask(task.id);
    expect(final?.status).toBe('done');
    expect(final?.resultSummary).toBe('SUMMARY[all good]');
  });

  it('stops a coding task at awaiting-review, never auto-done', async () => {
    const { task, completion } = runTask({
      kind: 'coding',
      origin: 'command-queue',
      prompt: 'ship',
    });
    runs[0].resolve({ output: 'patch applied', success: true, exitCode: 0 });
    await completion;
    expect(getTask(task.id)?.status).toBe('awaiting-review');
  });

  it('drives a failed run to failed and captures the error', async () => {
    const { task, completion } = runTask({ kind: 'action', origin: 'app', prompt: 'x' });
    runs[0].resolve({ output: 'boom', success: false, exitCode: 2 });
    const result = await completion;
    expect(result.success).toBe(false);
    const final = getTask(task.id);
    expect(final?.status).toBe('failed');
    expect(final?.error).toContain('boom');
  });
});

// -- watchdog ------------------------------------------------------------------

describe('runQueuedTask', () => {
  it('runs an existing queued task to done', async () => {
    const queued = createTask({ kind: 'action', origin: 'otter', prompt: 'from intake' });
    expect(queued.status).toBe('queued');
    const { task, completion } = runQueuedTask(queued.id);
    expect(task.status).toBe('running');
    expect(runs).toHaveLength(1);
    runs[0].resolve({ output: 'ok', success: true, exitCode: 0 });
    await completion;
    expect(getTask(queued.id)?.status).toBe('done');
  });

  it('throws when the task is missing or not queued', () => {
    expect(() => runQueuedTask('missing')).toThrow(/not found/i);
    const running = createTask({ kind: 'action', origin: 'app', prompt: 'x' });
    runQueuedTask(running.id); // moves it to running
    expect(() => runQueuedTask(running.id)).toThrow(/only queued/i);
  });

  it('prepares an isolated worktree before queued coding tasks run', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'task-service.ts'), 'utf8');
    expect(src).toContain("task.kind === 'coding'");
    expect(src).toContain("input.kind");
    expect(src).toContain('samePath(input.cwd, getSecondBrainRoot())');
    expect(src).toMatch(/worktree', 'add'/);
    expect(src).toContain('codex/task-');
    expect(src).toContain('updateTask(task.id');
  });
});

describe('runTask watchdog', () => {
  it('fails a hung run when the timeout elapses', async () => {
    mockPid = undefined; // avoid signalling a real process id
    const { task, completion } = runTask({
      kind: 'action',
      origin: 'app',
      prompt: 'hang',
      timeoutMs: 30,
    });
    // never resolve runs[0]; the watchdog must fire
    const result = await completion;
    expect(result.success).toBe(false);
    expect(result.summary).toContain('FAILSUMMARY');
    expect(getTask(task.id)?.status).toBe('failed');
  });
});

// -- provider ladder (claude -> codex read-only) ---------------------------------

describe('runTask provider ladder (codex read-only fallback)', () => {
  it('completes an action task via codex with provenance when claude exits nonzero', async () => {
    mockRunCodex.mockResolvedValue({ text: 'codex ExampleCod the task', exitCode: 0 });
    const { task, completion } = runTask({
      kind: 'action',
      origin: 'telegram',
      prompt: 'research X',
    });
    runs[0].resolve({ output: 'claude crashed', success: false, exitCode: 1 });
    const result = await completion;
    expect(result.success).toBe(true);
    expect(result.summary).toContain('via codex');
    expect(result.summary).toContain('codex ExampleCod the task');
    const final = getTask(task.id);
    expect(final?.status).toBe('done');
    expect(final?.resultSummary).toContain('via codex');
    // The fallback rung re-runs the task prompt, read-only.
    expect(String(mockRunCodex.mock.calls[0][0])).toBe('research X');
  });

  it('treats an exit-0 auth sentinel as a claude failure and descends the ladder', async () => {
    mockRunCodex.mockResolvedValue({ text: 'recovered by codex', exitCode: 0 });
    const { task, completion } = runTask({ kind: 'action', origin: 'app', prompt: 'y' });
    // The Claude CLI prints auth errors to stdout and exits 0; that must never
    // count as success (the run-scheduled-skill "fleet lies" failure category).
    runs[0].resolve({ output: 'Not logged in. Please run /login', success: true, exitCode: 0 });
    const result = await completion;
    expect(result.success).toBe(true);
    expect(result.summary).toContain('via codex');
    expect(getTask(task.id)?.status).toBe('done');
  });

  it('records a read-only codex DIAGNOSIS on a coding task and stops at awaiting-review', async () => {
    mockRunCodex.mockResolvedValue({
      text: 'root cause: stale lock; suggested patch: ...',
      exitCode: 0,
    });
    const { task, completion } = runTask({
      kind: 'coding',
      origin: 'command-queue',
      prompt: 'fix the bug',
    });
    runs[0].resolve({ output: 'claude died', success: false, exitCode: 1 });
    const result = await completion;
    const final = getTask(task.id);
    // Binding safety ruling: read-only codex never completes a coding task.
    expect(final?.status).toBe('awaiting-review');
    expect(final?.resultSummary?.startsWith('codex-diagnosis (read-only)')).toBe(true);
    expect(result.summary).toContain('codex-diagnosis (read-only)');
  });

  it('fails the task when the whole ladder is exhausted', async () => {
    // codex default mock already fails; claude fails with an exit-0 sentinel.
    const { task, completion } = runTask({ kind: 'action', origin: 'app', prompt: 'z' });
    runs[0].resolve({ output: 'Invalid API key', success: true, exitCode: 0 });
    const result = await completion;
    expect(result.success).toBe(false);
    expect(getTask(task.id)?.status).toBe('failed');
  });
});
