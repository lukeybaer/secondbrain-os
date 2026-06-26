import { randomUUID } from 'crypto';

export type CloudTaskStatus = 'queued' | 'running' | 'awaiting-review' | 'done' | 'failed' | 'cancelled' | 'removed_non_actionable';

export interface CloudLease {
  holder: string;
  token: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface CloudTaskLike {
  id: string;
  status: CloudTaskStatus;
  updatedAt?: string;
  startedAt?: string;
  completedAt?: string;
  resultSummary?: string;
  error?: string;
  history?: Array<{ status: CloudTaskStatus; ts: string; note?: string }>;
  lease?: CloudLease;
  meta?: Record<string, ExampleCo>;
}

export interface ClaimResult<T extends CloudTaskLike> {
  claimed: boolean;
  task: T;
  token?: string;
  reason?: string;
}

export interface SpineJournalEntry<T extends CloudTaskLike = CloudTaskLike> {
  seq: number;
  ts: string;
  taskId: string;
  op: 'upsert' | 'delete';
  task?: T;
}

function iso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

export function isLeaseActive(lease: CloudLease | undefined, nowMs = Date.now()): boolean {
  if (!lease?.expiresAt) return false;
  return Date.parse(lease.expiresAt) > nowMs;
}

export function tryClaimTask<T extends CloudTaskLike>(
  task: T,
  holder: string,
  ttlMs: number,
  nowMs = Date.now(),
  tokenFactory: () => string = randomUUID,
): ClaimResult<T> {
  if (!holder.trim()) return { claimed: false, task, reason: 'missing-holder' };
  if (task.status !== 'queued' && !(task.status === 'running' && !isLeaseActive(task.lease, nowMs))) {
    return { claimed: false, task, reason: 'not-claimable' };
  }
  if (isLeaseActive(task.lease, nowMs)) {
    return { claimed: false, task, reason: 'lease-active' };
  }

  const token = tokenFactory();
  const ts = iso(nowMs);
  const next = {
    ...task,
    status: 'running' as CloudTaskStatus,
    startedAt: task.startedAt || ts,
    updatedAt: ts,
    lease: { holder, token, acquiredAt: ts, expiresAt: iso(nowMs + ttlMs) },
    history: [
      ...(task.history || []),
      { status: 'running' as CloudTaskStatus, ts, note: `claimed by ${holder}` },
    ],
  };
  return { claimed: true, task: next as T, token };
}

export function applyFencedUpdate<T extends CloudTaskLike>(
  task: T,
  token: string,
  patch: Partial<Omit<T, 'id' | 'lease' | 'history'>>,
  nowMs = Date.now(),
): T {
  if (!task.lease || task.lease.token !== token) {
    throw new Error('stale fencing token');
  }
  const ts = iso(nowMs);
  const status = (patch.status || task.status) as CloudTaskStatus;
  return {
    ...task,
    ...patch,
    status,
    updatedAt: ts,
    completedAt:
      status === 'done' || status === 'failed' || status === 'cancelled'
        ? task.completedAt || ts
        : task.completedAt,
    history: [...(task.history || []), { status, ts, note: 'fenced update accepted' }],
  };
}

export function nextJournalSeq(entries: SpineJournalEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.seq || 0), 0) + 1;
}

export function replayJournal<T extends CloudTaskLike>(
  snapshotTasks: T[],
  entries: SpineJournalEntry<T>[],
): T[] {
  const byId = new Map(snapshotTasks.map((task) => [task.id, task]));
  for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
    if (entry.op === 'delete') byId.delete(entry.taskId);
    if (entry.op === 'upsert' && entry.task) byId.set(entry.taskId, entry.task);
  }
  return [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function buildSnapshot<T extends CloudTaskLike>(tasks: T[]): { schema: string; tasks: T[] } {
  return { schema: 'secondbrain.spine.snapshot.v1', tasks: tasks.map((task) => ({ ...task })) };
}
