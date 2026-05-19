// task-worker.ts
//
// The act worker: the spine's autonomous execution layer (handoff item 13).
//
// The intake watcher (task-intake.ts) records directives from calls, emails,
// and Otter notes as `queued` Tasks but never runs them. This worker is what
// runs them: it polls for queued Tasks and executes each via
// task-service.runQueuedTask, respecting a concurrency cap.
//
// SAFETY: autonomous execution is real autonomous action, so it is layered.
// The worker runs ONLY tasks that are both `queued` AND `approved`. Approval
// comes from smart extraction (task-extract.ts): a directive is auto-approved
// only when the LLM is confident it understood a clear, specific, non-
// destructive request. Garbled or ambiguous directives are recorded but left
// unapproved for a human in the Tasks tab. The worker is ON by default and can
// be hard-disabled with SECONDBRAIN_TASK_WORKER=off.

import { listTasks, type Task } from './task-store';
import { runQueuedTask } from './task-service';
import { auditAndAuthorize } from './security/approval-policy';

// Conservative cap: at most this many act-worker runs in flight at once.
const CONCURRENCY_CAP = 2;
const DEFAULT_INTERVAL_MS = 20_000;

/**
 * Pure selection step: given the current queued tasks, the cap, and how many
 * runs are already active, return the ids that should be started now. Kept
 * pure so it is fully testable without spawning anything.
 *
 * SAFETY GATE: only tasks with `approved === true` are eligible. A directive
 * scraped from a call, email, or Otter note becomes an UNAPPROVED queued
 * task; a human must approve it from the Tasks tab before the worker will
 * ever run it. This is the gate Codex required: there is no path from raw
 * external text to autonomous execution without a human in the loop.
 */
export function selectQueuedToRun(tasks: Task[], cap: number, active: number): string[] {
  const slots = Math.max(0, cap - active);
  if (slots === 0) return [];
  return tasks
    .filter((t) => t.status === 'queued' && t.approved === true)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)) // oldest first
    .slice(0, slots)
    .map((t) => t.id);
}

/** The worker runs by default. SECONDBRAIN_TASK_WORKER=off hard-disables it. */
export function isWorkerEnabled(): boolean {
  return (process.env.SECONDBRAIN_TASK_WORKER || 'on').toLowerCase() !== 'off';
}

let active = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  let ids: string[];
  let queued: Task[];
  try {
    queued = listTasks({ status: 'queued' });
    ids = selectQueuedToRun(queued, CONCURRENCY_CAP, active);
  } catch (err) {
    console.error('[task-worker] tick error:', err);
    return;
  }
  for (const id of ids) {
    const task = queued.find((t) => t.id === id);
    const auth = auditAndAuthorize({
      actor: 'tool',
      source: 'task-worker',
      action: 'run_task',
      summary: `Run approved queued task ${id}`,
      targetType: 'task',
      targetId: id,
      approved: task?.approved === true,
      metadata: {
        origin: task?.origin,
        kind: task?.kind,
        title: task?.title,
      },
    });
    if (!auth.allowed) {
      console.warn(`[task-worker] blocked task ${id}: ${auth.error ?? 'approval required'}`);
      continue;
    }

    active++;
    try {
      const { completion } = runQueuedTask(id);
      completion.finally(() => {
        active = Math.max(0, active - 1);
      });
    } catch (err) {
      active = Math.max(0, active - 1);
      console.error('[task-worker] failed to start task', id, err);
    }
  }
}

/**
 * Start the act worker. Runs by default; no-op (with a log line) when
 * SECONDBRAIN_TASK_WORKER=off. Safe to call unconditionally from main init.
 */
export function startTaskWorker(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (timer) return;
  if (!isWorkerEnabled()) {
    console.log('[task-worker] hard-disabled via SECONDBRAIN_TASK_WORKER=off');
    return;
  }
  console.log('[task-worker] enabled, polling for approved queued tasks');
  timer = setInterval(tick, intervalMs);
}

export function stopTaskWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
