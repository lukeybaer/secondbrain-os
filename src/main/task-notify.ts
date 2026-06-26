// task-notify.ts
//
// Batched dispatch-completion formatter for the Task Spine.
//
// Dispatch-complete chatter is dashboard-only per the Telegram policy. This
// module still formats the batch and calls the Telegram facade for legacy
// wiring, but `dispatch_complete` is intentionally suppressed at the policy
// chokepoint.

import { taskEmitter, getTask, type Task } from './task-store';
import { sendMessage } from './telegram';

const FLUSH_DEBOUNCE_MS = 90_000;
const TERMINAL: ReadonlySet<Task['status']> = new Set([
  'done',
  'failed',
  'awaiting-review',
  'cancelled',
]);

/** Build the single batched summary message. Pure, so it is unit-testable. */
export function formatBatch(tasks: Task[]): string {
  if (tasks.length === 0) return '';
  const line = (t: Task): string => {
    // A Telegram question shows its answer; other tasks show a short result.
    const detail = t.resultSummary ? `: ${t.resultSummary}` : '';
    return `- ${t.title}${detail}`;
  };
  const done = tasks.filter((t) => t.status === 'done');
  const review = tasks.filter((t) => t.status === 'awaiting-review');
  const failed = tasks.filter((t) => t.status === 'failed');
  const cancelled = tasks.filter((t) => t.status === 'cancelled');

  const parts: string[] = [];
  const total = tasks.length;
  parts.push(`${total} dispatch${total === 1 ? '' : 'es'} finished.`);
  if (done.length) parts.push(`\nDone:\n${done.map(line).join('\n')}`);
  if (review.length) parts.push(`\nNeeds your review:\n${review.map(line).join('\n')}`);
  if (failed.length) parts.push(`\nFailed:\n${failed.map(line).join('\n')}`);
  if (cancelled.length) parts.push(`\nCancelled:\n${cancelled.map(line).join('\n')}`);
  return parts.join('\n');
}

// -- Batching ------------------------------------------------------------------

const pendingIds = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    void flush();
  }, FLUSH_DEBOUNCE_MS);
}

async function flush(): Promise<void> {
  flushTimer = null;
  if (pendingIds.size === 0) return;
  const ids = [...pendingIds];
  pendingIds.clear();
  // Re-read each task so the summary has the final resultSummary.
  const tasks = ids.map((id) => getTask(id)).filter((t): t is Task => t !== null);
  if (tasks.length === 0) return;
  const { getConfig } = await import('./config');
  const owner = getConfig().telegramChatId;
  if (!owner) return;
  await sendMessage(owner, formatBatch(tasks), 'dispatch_complete');
}

function onTask(task: Task): void {
  if (!TERMINAL.has(task.status)) return;
  // command-queue dispatches (Telegram, briefing-web) already get their
  // result delivered per-dispatch by EC2's deliverCommandResult. Batching
  // them here too would double-notify, the exact redundant consolidated
  // message ExampleCo flagged. The batcher only covers origins with no reply
  // channel of their own (otter, gmail, briefing-side ingest, schedule).
  if (task.origin === 'command-queue') return;
  pendingIds.add(task.id);
  scheduleFlush();
}

/** Start the batched notifier. Safe to call once from main-process init. */
export function startTaskNotifier(): void {
  if (started) return;
  started = true;
  taskEmitter.on('task', onTask);
}

export function stopTaskNotifier(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  taskEmitter.off('task', onTask);
  pendingIds.clear();
  started = false;
}
