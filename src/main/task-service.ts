// task-service.ts
//
// The single entry point for dispatching work onto the Task Spine from any
// in-process surface (the command queue, the briefing, the app, the act
// worker). Out-of-process surfaces (vapi-end-of-call.js, EC2) do not call this
// directly; they write an intake record that task-intake.ts drains.
//
// runTask creates a NEW durable Task and runs it. runQueuedTask runs an
// EXISTING queued Task (used by the act worker to pick up intake-created
// tasks). Both return immediately with the Task and a completion promise;
// callers that need the final result (the command queue posts it to EC2)
// await `completion`, fire-and-forget callers ignore it.
//
// Codex review: a task of kind 'coding' never auto-completes. On a successful
// claude run it transitions to 'awaiting-review' rather than 'done', because a
// coding change must be reviewed (by Codex and by ExampleCo) before it is accepted.
// action and ingest tasks transition straight to 'done'.

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { runClaudeCodeBackground, summarizeTaskOutput, getSecondBrainRoot } from './claude-runner';
import { runCodex, isCliFailureOutput } from './codex-runner';
import { runFallbackChain, makeFileWriter } from './tool-fallback-chain';
import {
  createTask,
  transition,
  updateTask,
  getTask,
  type Task,
  type TaskKind,
  type TaskOrigin,
  type TaskSource,
} from './task-store';

// 15 minutes, matching the old claude-runner blocking default. A run that
// exceeds this is killed and the task is marked failed rather than spinning
// forever. 0 disables the watchdog.
const DEFAULT_TASK_TIMEOUT_MS =
  parseInt(process.env.SECONDBRAIN_TASK_TIMEOUT_MS || '', 10) || 900_000;

export interface TaskResult {
  taskId: string;
  success: boolean;
  exitCode: number;
  output: string;
  summary: string;
}

export interface RunTaskInput {
  kind: TaskKind;
  origin: TaskOrigin;
  prompt: string;
  title?: string;
  source?: TaskSource;
  parentId?: string;
  /** Working directory for the claude subprocess. Defaults to the app path. */
  cwd?: string;
  /** Watchdog timeout in ms. Defaults to 15 min. Pass 0 to disable. */
  timeoutMs?: number;
}

export interface RunTaskHandle {
  task: Task;
  completion: Promise<TaskResult>;
}

interface ExecuteOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Block the raw shell (Bash) for autonomously-dispatched runs. */
  restrictTools?: boolean;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 44) || 'task'
  );
}

function git(args: string[], cwd: string, timeoutMs = 90_000): { ok: boolean; out: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    out: [result.stdout, result.stderr].filter(Boolean).join('\n'),
  };
}

function linkNodeModules(repoRoot: string, worktree: string): void {
  const target = path.join(repoRoot, 'node_modules');
  const link = path.join(worktree, 'node_modules');
  if (fs.existsSync(link) || !fs.existsSync(target)) return;
  try {
    fs.symlinkSync(target, link, 'junction');
  } catch {
    // Best effort. The task can still run; tests or the agent will fail loudly
    // if dependencies are actually required and unavailable.
  }
}

function ensureCodingWorktree(task: Task): Task {
  if (task.execution?.worktree && fs.existsSync(task.execution.worktree)) return task;

  const repoRoot = getSecondBrainRoot();
  const gitReady = git(['rev-parse', '--is-inside-work-tree'], repoRoot, 10_000);
  if (!gitReady.ok) return task;
  const sessionsRoot =
    process.env.SECONDBRAIN_SESSION_ROOT || path.join(os.homedir(), 'sb-sessions');
  const slug = slugify(task.title || task.prompt || task.id);
  const shortId = task.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  const branch = `codex/task-${slug}-${shortId}`.slice(0, 120);
  const worktree = path.join(sessionsRoot, `task-${slug}-${shortId}`);

  fs.mkdirSync(sessionsRoot, { recursive: true });
  git(['fetch', 'origin', 'master'], repoRoot);

  if (!fs.existsSync(worktree)) {
    const add = git(['worktree', 'add', '-b', branch, worktree, 'origin/master'], repoRoot);
    if (!add.ok) {
      const attach = git(['worktree', 'add', worktree, branch], repoRoot);
      if (!attach.ok) {
        throw new Error(`Could not create isolated coding worktree: ${add.out || attach.out}`);
      }
    }
  }

  linkNodeModules(repoRoot, worktree);
  const updated = updateTask(task.id, {
    execution: { repo: repoRoot, worktree, branch, base: 'origin/master', cwd: worktree },
  });
  return updated;
}

function samePath(a: string | undefined, b: string): boolean {
  if (!a) return false;
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// -- provider ladder (2026-06-11) ------------------------------------------------
//
// Policy: codex (OpenAI sub) -> claude (sub) -> OpenAI API soft floor; no
// surface dead when the Claude subscription is down. Here claude is the
// primary executor (it has the full Claude Code toolchain); when it fails
// (nonzero exit OR an exit-0 auth/quota sentinel) the task descends to a
// READ-ONLY codex run through tool-fallback-chain, which keeps the per-rung
// attempt ledger. Binding safety ruling: codex output on a coding task is a
// diagnosis recorded on the task, never an autonomous code write.

// Bounded so a fallback diagnosis cannot hold an act-worker slot for the full
// 15-minute task budget.
const CODEX_FALLBACK_TIMEOUT_MS =
  parseInt(process.env.SECONDBRAIN_CODEX_FALLBACK_TIMEOUT_MS || '', 10) || 180_000;

/** Shared Electron-side rung ledger, same shape as ask-ai-rungs.jsonl. */
function ladderWriter(): ReturnType<typeof makeFileWriter> {
  return makeFileWriter(
    path.join(getSecondBrainRoot(), 'data', 'agent', 'electron-ladder-attempts.jsonl'),
  );
}

/** Run the codex read-only rung for a failed task. Returns text or null. */
async function runCodexLadder(task: Task): Promise<string | null> {
  const result = await runFallbackChain<string>(
    [
      {
        name: 'codex-readonly',
        fn: async () => {
          const r = await runCodex(task.prompt, { timeoutMs: CODEX_FALLBACK_TIMEOUT_MS });
          if (!r.text) throw new Error(`codex rung failed: ${r.failureReason ?? 'no output'}`);
          return r.text;
        },
        // A rung failure always means "descend", never "abort the chain".
        isTransientError: () => true,
      },
    ],
    { chain: `task-execute:${task.kind}`, writer: ladderWriter() },
  );
  return result.ok ? result.value : null;
}

/**
 * Transition a task to running, spawn claude for it, and return a completion
 * promise that resolves (never rejects) when the run finishes. Shared by
 * runTask (new task) and runQueuedTask (existing queued task).
 */
function executeTask(task: Task, opts: ExecuteOptions): Promise<TaskResult> {
  transition(task.id, 'running');

  const handle = runClaudeCodeBackground(task.prompt, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    // Containment for autonomously-dispatched runs: the worker passes
    // restrictTools, which blocks the raw shell so an auto-run task cannot
    // rm / git push / curl its way into an irreversible action.
    ...(opts.restrictTools ? { disallowedTools: 'Bash' } : {}),
  });
  if (handle.pid) updateTask(task.id, { pid: handle.pid });

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

  return new Promise<TaskResult>((resolve) => {
    let settled = false;

    const finish = async (output: string, success: boolean, exitCode: number): Promise<void> => {
      if (settled) return;
      settled = true;
      // The completion promise MUST always settle, even if a transition or
      // summarization throws. An unsettled promise leaks an act-worker slot
      // forever (Codex HIGH finding). Every path below resolves.
      try {
        // The task may have been cancelled (and the process killed)
        // externally while running. A terminal task is not transitioned again.
        const current = getTask(task.id);
        if (
          current &&
          (current.status === 'cancelled' ||
            current.status === 'done' ||
            current.status === 'failed')
        ) {
          resolve({
            taskId: task.id,
            success,
            exitCode,
            output,
            summary: current.resultSummary ?? output,
          });
          return;
        }
        // A claude run that exits 0 but prints an auth/quota sentinel ("Not
        // logged in", "usage limit reached") is a failure for ladder purposes;
        // forwarding it as a result is the "fleet lies" bug class.
        const claudeFailed = !success || isCliFailureOutput(output);

        if (!claudeFailed) {
          const summary = await summarizeTaskOutput(output, success, exitCode);
          // A coding change must be reviewed before it is accepted; it never
          // auto-completes. action and ingest tasks are done on success.
          if (task.kind === 'coding') {
            transition(
              task.id,
              'awaiting-review',
              'claude run succeeded, Codex and ExampleCo review pending',
            );
          } else {
            transition(task.id, 'done');
          }
          updateTask(task.id, { resultSummary: summary });
          resolve({ taskId: task.id, success: true, exitCode, output, summary });
          return;
        }

        // Provider ladder: descend to a READ-ONLY codex run on claude failure.
        const codexText = await runCodexLadder(task);
        if (codexText) {
          if (task.kind === 'coding') {
            // Binding safety ruling: read-only codex on a coding task yields a
            // DIAGNOSIS / patch suggestion recorded on the task, never an
            // autonomous code write. The task needs review, it is NOT done.
            const summary = `codex-diagnosis (read-only): ${codexText.slice(0, 500)}`;
            transition(
              task.id,
              'awaiting-review',
              'claude failed; codex read-only diagnosis recorded, review required before any code lands',
            );
            updateTask(task.id, { resultSummary: summary });
            resolve({ taskId: task.id, success: true, exitCode: 0, output: codexText, summary });
            return;
          }
          // Text/research (action / ingest) tasks may complete, provenance-tagged.
          const summary = `via codex: ${codexText.slice(0, 500)}`;
          transition(task.id, 'done');
          updateTask(task.id, { resultSummary: summary });
          resolve({ taskId: task.id, success: true, exitCode: 0, output: codexText, summary });
          return;
        }

        // Ladder exhausted: the task fails loudly.
        const summary = await summarizeTaskOutput(output, false, exitCode);
        transition(task.id, 'failed', `exit ${exitCode}`);
        updateTask(task.id, { resultSummary: summary, error: output.slice(0, 500) });
        resolve({ taskId: task.id, success: false, exitCode, output, summary });
      } catch (err) {
        resolve({
          taskId: task.id,
          success: false,
          exitCode: exitCode || -1,
          output,
          summary: `Task bookkeeping error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          if (handle.pid) process.kill(handle.pid, 'SIGTERM');
        } catch {
          /* nothing to kill */
        }
        const minutes = timeoutMs / 60_000;
        void finish(`Timed out after ${minutes} minute${minutes !== 1 ? 's' : ''}`, false, -1);
      }, timeoutMs);
    }

    handle.completion
      .then((r) => {
        if (timer) clearTimeout(timer);
        void finish(r.output, r.success, r.exitCode);
      })
      .catch((err) => {
        // claude-runner is documented never to reject, but guard anyway:
        // an unsettled completion leaks an act-worker slot forever.
        if (timer) clearTimeout(timer);
        void finish(`Runner error: ${err instanceof Error ? err.message : String(err)}`, false, -1);
      });
  });
}

/**
 * Create a new Task and run it. The Task is already persisted and `running`
 * by the time this returns.
 */
export function runTask(input: RunTaskInput): RunTaskHandle {
  let task = createTask({
    kind: input.kind,
    origin: input.origin,
    prompt: input.prompt,
    ...(input.title ? { title: input.title } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.parentId ? { parentId: input.parentId } : {}),
  });
  let execOptions: ExecuteOptions = {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  };
  if (task.kind === 'coding' && (!input.cwd || samePath(input.cwd, getSecondBrainRoot()))) {
    task = ensureCodingWorktree(task);
    execOptions = { ...execOptions, cwd: task.execution?.worktree || task.execution?.cwd };
  }
  const completion = executeTask(task, execOptions);
  return { task: getTask(task.id) ?? task, completion };
}

/**
 * Run an existing queued Task (used by the act worker to execute tasks the
 * intake watcher created). Throws if the task is missing or not queued.
 */
export function runQueuedTask(taskId: string, opts: ExecuteOptions = {}): RunTaskHandle {
  let task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.status !== 'queued') {
    throw new Error(`Task ${taskId} is ${task.status}, only queued tasks can be run`);
  }
  if (task.kind === 'coding' && !opts.cwd) {
    task = ensureCodingWorktree(task);
    opts = { ...opts, cwd: task.execution?.worktree || task.execution?.cwd };
  }
  // runQueuedTask is the autonomous path (the act worker). It always runs
  // with the raw shell blocked, regardless of caller-supplied options.
  const completion = executeTask(task, { ...opts, restrictTools: true });
  return { task: getTask(taskId) ?? task, completion };
}
