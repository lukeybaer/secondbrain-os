import type { Task, TaskStatus } from './task-store';

export type AmyProjectVisibleStatus =
  | 'running'
  | 'needs-reply'
  | 'needs-review'
  | 'needs-approval'
  | 'waiting-to-start'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'removed';

export interface AmyProjectRow extends Task {
  visibleStatus: AmyProjectVisibleStatus;
  visibleStatusLabel: string;
  duplicateTaskIds: string[];
}

export interface AmyProjectsView {
  rows: AmyProjectRow[];
  activeCount: number;
  blocker?: {
    code: 'source-data-without-cards';
    message: string;
    sourceRows: number;
  };
}

export interface DispatchNotTriggeredAlert {
  code: 'dispatch-not-triggered';
  title: string;
  tldr: string;
  taskIds: string[];
  selfHeal: {
    action: 'refresh-intake-and-worker';
    approvedTaskIds: string[];
  };
}

const TERMINAL = new Set<TaskStatus>(['done', 'cancelled', 'removed_non_actionable']);

const ROW_PRIORITY: Record<TaskStatus, number> = {
  running: 0,
  'requires-feedback': 1,
  'awaiting-review': 2,
  failed: 3,
  queued: 4,
  done: 5,
  cancelled: 6,
  removed_non_actionable: 7,
};

function normalizeText(value: ExampleCo): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(process|this|dispatch|open|secondbrain|spine|requirement)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function metaString(task: Task, key: string): string | null {
  const value = task.meta?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function amyProjectKey(task: Task): string {
  const explicit =
    metaString(task, 'requestFingerprint') ||
    metaString(task, 'amyRequestId') ||
    metaString(task, 'dispatchHash');
  if (explicit) return `request:${explicit}`;

  const sourceRequest = task.source?.ref && /^amy-request:/i.test(task.source.ref);
  if (sourceRequest) return task.source.ref.toLowerCase();

  const normalized = normalizeText(`${task.title}\n${task.prompt}`);
  return normalized ? `text:${normalized.slice(0, 240)}` : `task:${task.id}`;
}

export function visibleStatusForTask(task: Pick<Task, 'status' | 'approved'>): {
  status: AmyProjectVisibleStatus;
  label: string;
} {
  switch (task.status) {
    case 'queued':
      return task.approved
        ? { status: 'waiting-to-start', label: 'Waiting to start' }
        : { status: 'needs-approval', label: 'Needs approval' };
    case 'running':
      return { status: 'running', label: 'Running' };
    case 'requires-feedback':
      return { status: 'needs-reply', label: 'Needs your reply' };
    case 'awaiting-review':
      return { status: 'needs-review', label: 'Awaiting review' };
    case 'done':
      return { status: 'done', label: 'Done' };
    case 'failed':
      return { status: 'failed', label: 'Failed' };
    case 'cancelled':
      return { status: 'cancelled', label: 'Cancelled' };
    case 'removed_non_actionable':
      return { status: 'removed', label: 'Removed' };
  }
}

function chooseCanonical(tasks: Task[]): Task {
  return [...tasks].sort((a, b) => {
    const priority = ROW_PRIORITY[a.status] - ROW_PRIORITY[b.status];
    if (priority !== 0) return priority;
    return String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt));
  })[0];
}

export function projectAmyTasks(tasks: Task[]): AmyProjectRow[] {
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = amyProjectKey(task);
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }

  return [...groups.values()]
    .map((group) => {
      const canonical = chooseCanonical(group);
      const visible = visibleStatusForTask(canonical);
      return {
        ...canonical,
        visibleStatus: visible.status,
        visibleStatusLabel: visible.label,
        duplicateTaskIds: group
          .map((task) => task.id)
          .filter((id) => id !== canonical.id)
          .sort(),
      };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function buildAmyProjectsView(tasks: Task[], sourceRows = 0): AmyProjectsView {
  const rows = projectAmyTasks(tasks);
  const activeCount = rows.filter((row) => !TERMINAL.has(row.status)).length;
  const view: AmyProjectsView = { rows, activeCount };
  if (rows.length === 0 && sourceRows > 0) {
    view.blocker = {
      code: 'source-data-without-cards',
      sourceRows,
      message: `${sourceRows} intake row${sourceRows === 1 ? '' : 's'} exist but no Amy Projects card rendered.`,
    };
  }
  return view;
}

export function findStalledDispatches(
  tasks: Task[],
  nowMs = Date.now(),
  thresholdMs = 2 * 60_000,
): Task[] {
  return tasks.filter((task) => {
    if (task.status !== 'queued') return false;
    const ts = Date.parse(task.updatedAt || task.createdAt);
    return Number.isFinite(ts) && nowMs - ts > thresholdMs;
  });
}

export function buildDispatchNotTriggeredAlert(
  tasks: Task[],
  nowMs = Date.now(),
  thresholdMs = 2 * 60_000,
): DispatchNotTriggeredAlert | null {
  const stalled = findStalledDispatches(tasks, nowMs, thresholdMs);
  if (stalled.length === 0) return null;
  return {
    code: 'dispatch-not-triggered',
    title: 'Dispatch did not start',
    tldr: `${stalled.length} dispatch${stalled.length === 1 ? '' : 'es'} waited more than ${Math.round(
      thresholdMs / 60000,
    )} minutes without starting.`,
    taskIds: stalled.map((task) => task.id),
    selfHeal: {
      action: 'refresh-intake-and-worker',
      approvedTaskIds: stalled.filter((task) => task.approved).map((task) => task.id),
    },
  };
}

export function buildTaskDrilldown(task: Task): {
  oneLine: string;
  ExampleCoraphs: string[];
  fullHistory: string[];
} {
  const oneLine = task.resultSummary || task.title;
  const ExampleCoraphs = [
    `Status: ${visibleStatusForTask(task).label}.`,
    `Request: ${task.prompt.trim() || task.title}`,
    task.resultSummary ? `Result: ${task.resultSummary}` : 'Result: Amy has not recorded a final result yet.',
  ];
  const fullHistory = (task.history || []).map((entry) => {
    const note = entry.note ? ` - ${entry.note}` : '';
    return `${entry.ts}: ${entry.status}${note}`;
  });
  return { oneLine, ExampleCoraphs, fullHistory };
}
