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
// coding change must be reviewed (by Codex and by Luke) before it is accepted.
// action and ingest tasks transition straight to 'done'.

import { runClaudeCodeBackground, summarizeTaskOutput } from './claude-runner';
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
        const summary = await summarizeTaskOutput(output, success, exitCode);
        if (success) {
          // A coding change must be reviewed before it is accepted; it never
          // auto-completes. action and ingest tasks are done on success.
          if (task.kind === 'coding') {
            transition(task.id, 'awaiting-review', 'claude run succeeded, Codex and Luke review pending');
          } else {
            transition(task.id, 'done');
          }
          updateTask(task.id, { resultSummary: summary });
        } else {
          transition(task.id, 'failed', `exit ${exitCode}`);
          updateTask(task.id, { resultSummary: summary, error: output.slice(0, 500) });
        }
        resolve({ taskId: task.id, success, exitCode, output, summary });
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
        void finish(
          `Runner error: ${err instanceof Error ? err.message : String(err)}`,
          false,
          -1,
        );
      });
  });
}

/**
 * Create a new Task and run it. The Task is already persisted and `running`
 * by the time this returns.
 */
export function runTask(input: RunTaskInput): RunTaskHandle {
  const task = createTask({
    kind: input.kind,
    origin: input.origin,
    prompt: input.prompt,
    ...(input.title ? { title: input.title } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.parentId ? { parentId: input.parentId } : {}),
  });
  const completion = executeTask(task, {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  return { task: getTask(task.id) ?? task, completion };
}

/**
 * Run an existing queued Task (used by the act worker to execute tasks the
 * intake watcher created). Throws if the task is missing or not queued.
 */
export function runQueuedTask(taskId: string, opts: ExecuteOptions = {}): RunTaskHandle {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.status !== 'queued') {
    throw new Error(`Task ${taskId} is ${task.status}, only queued tasks can be run`);
  }
  // runQueuedTask is the autonomous path (the act worker). It always runs
  // with the raw shell blocked, regardless of caller-supplied options.
  const completion = executeTask(task, { ...opts, restrictTools: true });
  return { task: getTask(taskId) ?? task, completion };
}
