/**
 * Provider-ladder tests for command-queue.ts handleCommand (2026-06-11 plan).
 *
 * Categories encoded:
 *  - new_task commands route through the Task Spine (runTask), where the
 *    claude -> codex read-only ladder lives (task-service executeTask).
 *  - The `claude --continue` route cannot be resumed by codex, so on a claude
 *    failure (nonzero exit OR an exit-0 auth/quota sentinel) it falls back to
 *    a FRESH codex read-only session carrying the stored task context, and the
 *    delivered result is provenance-tagged 'via codex'.
 *  - When the whole ladder is exhausted the command completes with
 *    success=false (fail loud, never fabricate).
 *
 * electron, config, claude-runner, task-service, database, and codex-runner
 * are mocked; fetch is stubbed so EC2 never gets hit. The real
 * cli-output-guard sentinel classifier is loaded so sentinel detection is
 * tested against the shared patterns.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'command-queue-ladder-'));

vi.mock('electron', () => ({
  app: { getAppPath: () => 'C:/app-path' },
}));

vi.mock('../config', () => ({
  getConfig: () => ({ ec2BaseUrl: 'http://ec2.test', commandToken: 'tok' }),
}));

// -- claude-runner mock ----------------------------------------------------------

interface MockBgRun {
  prompt: string;
  options: Record<string, ExampleCo>;
  resolve: (r: { output: string; success: boolean; exitCode: number }) => void;
}
const bgRuns: MockBgRun[] = [];

vi.mock('../claude-runner', () => ({
  runClaudeCodeBackground: (prompt: string, options: Record<string, ExampleCo>) => {
    let resolve!: (r: { output: string; success: boolean; exitCode: number }) => void;
    const completion = new Promise<{ output: string; success: boolean; exitCode: number }>((r) => {
      resolve = r;
    });
    bgRuns.push({ prompt, options, resolve });
    return { pid: 777, completion };
  },
  summarizeTaskOutput: async (output: string, success: boolean, exitCode: number) =>
    success ? `SUMMARY[${output}]` : `FAILSUMMARY[exit ${exitCode}]`,
  getSecondBrainRoot: () => testRoot,
}));

// -- task-service mock (the spine owns the new_task ladder) ------------------------

const mockRunTask = vi.fn();
vi.mock('../task-service', () => ({
  runTask: (...args: ExampleCo[]) => mockRunTask(...args),
}));

vi.mock('../database', () => ({
  searchConversations: () => [],
}));

// -- codex-runner mock -------------------------------------------------------------

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

import { handleCommand } from '../command-queue';

// -- fetch stub ---------------------------------------------------------------------

interface FetchCall {
  url: string;
  init?: { method?: string; body?: string };
}
const fetchCalls: FetchCall[] = [];

function completedBody(): { result: string; success: boolean } | null {
  const call = fetchCalls.find((c) => c.url.includes('/complete'));
  if (!call?.init?.body) return null;
  return JSON.parse(String(call.init.body)) as { result: string; success: boolean };
}

beforeEach(() => {
  bgRuns.length = 0;
  fetchCalls.length = 0;
  mockRunTask.mockReset();
  mockRunCodex.mockReset();
  // Default: the codex rung fails so ladder-exhaustion paths are the default.
  mockRunCodex.mockResolvedValue({ text: null, exitCode: -1, failureReason: 'nonzero-exit' });
  vi.stubGlobal('fetch', async (url: ExampleCo, init?: { method?: string; body?: string }) => {
    fetchCalls.push({ url: String(url), ...(init ? { init } : {}) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'sess-1' }),
    };
  });
});

// -- continue route -------------------------------------------------------------------

describe('handleCommand continue route ladder', () => {
  const continueCmd = (id: string, prompt: string, sessionTopic?: string) => ({
    id,
    type: 'claude' as const,
    prompt,
    routing: { type: 'continue' as const, ...(sessionTopic ? { sessionTopic } : {}) },
  });

  it('delivers the claude summary and never touches codex when claude succeeds', async () => {
    await handleCommand(continueCmd('c1', 'follow up', 'dentist research'));
    expect(bgRuns).toHaveLength(1);
    expect(bgRuns[0].options.continueSession).toBe(true);
    bgRuns[0].resolve({ output: 'continued fine', success: true, exitCode: 0 });
    await vi.waitFor(() => expect(completedBody()).not.toBeNull());
    expect(completedBody()).toEqual({ result: 'SUMMARY[continued fine]', success: true });
    expect(mockRunCodex).not.toHaveBeenCalled();
  });

  it('falls back to a FRESH codex read-only session with the stored task context on claude failure', async () => {
    mockRunCodex.mockResolvedValue({ text: 'codex ExampleCod it', exitCode: 0 });
    await handleCommand(continueCmd('c2', 'summarize the q3 numbers', 'q3 board deck'));
    bgRuns[0].resolve({ output: 'crash', success: false, exitCode: 1 });
    await vi.waitFor(() => expect(completedBody()).not.toBeNull());
    const body = completedBody()!;
    expect(body.success).toBe(true);
    expect(body.result).toContain('via codex');
    expect(body.result).toContain('codex ExampleCod it');
    // The fresh codex session ExampleCos the stored task context, not a bare prompt.
    const codexPrompt = String(mockRunCodex.mock.calls[0][0]);
    expect(codexPrompt).toContain('q3 board deck');
    expect(codexPrompt).toContain('summarize the q3 numbers');
  });

  it('treats an exit-0 auth sentinel from claude --continue as a failure and descends', async () => {
    mockRunCodex.mockResolvedValue({ text: 'recovered', exitCode: 0 });
    await handleCommand(continueCmd('c3', 'keep going'));
    bgRuns[0].resolve({ output: 'Not logged in. Please run /login', success: true, exitCode: 0 });
    await vi.waitFor(() => expect(completedBody()).not.toBeNull());
    const body = completedBody()!;
    expect(body.success).toBe(true);
    expect(body.result).toContain('via codex');
  });

  it('completes with success=false when claude and codex both fail', async () => {
    await handleCommand(continueCmd('c4', 'doomed'));
    bgRuns[0].resolve({ output: 'crash', success: false, exitCode: 2 });
    await vi.waitFor(() => expect(completedBody()).not.toBeNull());
    expect(completedBody()).toEqual({ result: 'FAILSUMMARY[exit 2]', success: false });
    expect(mockRunCodex).toHaveBeenCalled();
  });
});

// -- new_task route ----------------------------------------------------------------

describe('handleCommand new_task route', () => {
  it('routes through the Task Spine where the provider ladder lives', async () => {
    mockRunTask.mockReturnValue({
      task: { id: 'task-1' },
      completion: Promise.resolve({
        taskId: 'task-1',
        success: true,
        exitCode: 0,
        output: 'done',
        summary: 'via codex: done',
      }),
    });
    await handleCommand({
      id: 'c5',
      type: 'claude',
      prompt: 'new work',
      routing: { type: 'new_task' },
    });
    await vi.waitFor(() => expect(completedBody()).not.toBeNull());
    expect(mockRunTask).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'new work', origin: 'command-queue' }),
    );
    // The spine's ladder result (provenance included) is what gets delivered.
    expect(completedBody()).toEqual({ result: 'via codex: done', success: true });
  });

  it('routes coding-looking remote commands as coding tasks so task-service isolates them', async () => {
    mockRunTask.mockReturnValue({
      task: { id: 'task-code' },
      completion: Promise.resolve({
        taskId: 'task-code',
        success: true,
        exitCode: 0,
        output: 'done',
        summary: 'awaiting review',
      }),
    });
    await handleCommand({
      id: 'c6',
      type: 'claude',
      prompt: 'fix the dashboard CSS regression and add a test',
      routing: { type: 'new_task' },
    });
    await vi.waitFor(() => expect(completedBody()).not.toBeNull());
    expect(mockRunTask).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'coding',
        prompt: 'fix the dashboard CSS regression and add a test',
        origin: 'command-queue',
      }),
    );
  });
});
