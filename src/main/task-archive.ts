// Stale-task archive sweep for the Task Spine (Amy E2E overhaul, plan rank 12,
// approved by ExampleCo 2026-06-11: "anything that's not actively a running session,
// you can just call it archived"). Marks stale active-ish tasks archived; never
// deletes; journals every change so the sweep is fully reversible.
//
// Phase 1 of the overhaul formalizes 'archived' in the task-store state machine;
// this module owns the sweep decision + journaled mutation in the meantime.
import fs from 'node:fs';
import path from 'node:path';

export const ACTIVE_STATUSES = ['queued', 'running', 'awaiting-review'] as const;
export const DEFAULT_STALE_DAYS = 7;

export interface SweepableTask {
  id?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: ExampleCo;
}

export interface ArchiveDecision {
  archive: boolean;
  reason: string;
}

// Pure decision: archive only active-ish tasks whose latest activity is older
// than staleDays. Terminal tasks (done/failed/cancelled/removed) are history,
// not "active", and stay untouched. Recently touched tasks (live sessions
// heartbeat their updatedAt) stay untouched.
export function shouldArchiveTask(
  task: SweepableTask,
  nowMs: number,
  { staleDays = DEFAULT_STALE_DAYS }: { staleDays?: number } = {},
): ArchiveDecision {
  if (!task || typeof task !== 'object') return { archive: false, reason: 'not-a-task' };
  if (!ACTIVE_STATUSES.includes(task.status as (typeof ACTIVE_STATUSES)[number])) {
    return { archive: false, reason: `status-${task.status ?? 'missing'}-not-active` };
  }
  const lastTouch = Date.parse(task.updatedAt || task.createdAt || '');
  if (!Number.isFinite(lastTouch)) return { archive: false, reason: 'no-parseable-timestamp' };
  const ageDays = (nowMs - lastTouch) / 86400000;
  if (ageDays < staleDays) return { archive: false, reason: `fresh-${ageDays.toFixed(1)}d` };
  return { archive: true, reason: `stale-${Math.floor(ageDays)}d-${task.status}` };
}

export interface SweepSummary {
  scanned: number;
  archived: number;
  skipped: number;
  unparseable: number;
  journalPath: string;
  archivedIds: string[];
}

export function sweepArchive(
  tasksDir: string,
  nowMs: number,
  journalPath: string,
  { staleDays = DEFAULT_STALE_DAYS, dryRun = false }: { staleDays?: number; dryRun?: boolean } = {},
): SweepSummary {
  const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
  const summary: SweepSummary = {
    scanned: files.length,
    archived: 0,
    skipped: 0,
    unparseable: 0,
    journalPath,
    archivedIds: [],
  };
  const journalLines: string[] = [];
  for (const file of files) {
    const full = path.join(tasksDir, file);
    let task: SweepableTask;
    try {
      task = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      summary.unparseable += 1;
      continue;
    }
    const decision = shouldArchiveTask(task, nowMs, { staleDays });
    if (!decision.archive) {
      summary.skipped += 1;
      continue;
    }
    const entry = {
      ts: new Date(nowMs).toISOString(),
      id: task.id || file.replace(/\.json$/, ''),
      file,
      from: task.status,
      to: 'archived',
      reason: decision.reason,
      sweep: 'amy-e2e-rank12',
    };
    if (!dryRun) {
      const archivedTask = {
        ...task,
        status: 'archived',
        archivedAt: entry.ts,
        archivedFrom: task.status,
        archiveReason: entry.reason,
      };
      fs.writeFileSync(full, JSON.stringify(archivedTask, null, 2));
    }
    journalLines.push(JSON.stringify(entry));
    summary.archived += 1;
    summary.archivedIds.push(entry.id);
  }
  if (journalLines.length && !dryRun) {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.appendFileSync(journalPath, journalLines.join('\n') + '\n');
  }
  return summary;
}

// Rollback: restore archived statuses from a sweep journal (reverse of sweepArchive).
export function rollbackSweep(tasksDir: string, journalPath: string): number {
  const lines = fs
    .readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  let restored = 0;
  for (const entry of lines) {
    const full = path.join(tasksDir, entry.file);
    if (!fs.existsSync(full)) continue;
    const task = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (task.status !== 'archived') continue;
    task.status = entry.from;
    delete task.archivedAt;
    delete task.archivedFrom;
    delete task.archiveReason;
    fs.writeFileSync(full, JSON.stringify(task, null, 2));
    restored += 1;
  }
  return restored;
}
