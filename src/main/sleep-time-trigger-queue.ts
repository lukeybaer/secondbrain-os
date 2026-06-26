// sleep-time-trigger-queue.ts
//
// Foreground to background trigger queue. The Letta "sleeptime agents" pattern:
// while the primary agent is doing foreground work (handling a Vapi call,
// answering a Telegram message, updating a contact), background memory work
// gets enqueued for the next scheduled consolidation pass, never blocking the
// primary path.
//
// sleep-time-consolidation.ts already runs core-block compression on schedule,
// but today there is no way for foreground code to *request* consolidation
// scoped to a specific contact, project, or memory key. This module is that
// queue.
//
// Storage: append-only JSONL of enqueue events + a derived pending snapshot.
// Drain is idempotent: handler errors leave the trigger pending for the next
// drain attempt (each pending trigger has an attempts counter so callers can
// give up after a max retry threshold).
//
// Pure, dependency-free, regression-tested. Caller wires the queue dir into
// the existing nightly scheduler (between memory-temperature.rebuildHotList()
// and sleep-time-consolidation.runSleepTimeConsolidation()).

import * as fs from 'fs';
import * as path from 'path';

// Types

export type SleepTriggerType =
  | 'contact-consolidate'     // a Vapi call ended or Gmail thread closed for X
  | 'memory-block-recompress' // explicit foreground request to re-run block compression
  | 'graphiti-reindex'        // a contact file changed and needs graph re-embedding
  | 'archive-recommendation'  // recompute archival candidates from access log
  | 'belief-revision-scan'    // run pairwise dissonance sweep on belief records
  | 'custom';

export interface SleepTrigger {
  id: string;
  enqueuedAt: string;
  type: SleepTriggerType;
  key: string;               // a scoping key, e.g. "contact:john-smith" or "*"
  source: string;            // what created this trigger (caller-defined)
  payload?: Record<string, ExampleCo>;
  attempts: number;
  status: 'pending' | 'done' | 'failed';
  lastAttemptAt?: string;
  lastError?: string;
  doneAt?: string;
}

export interface EnqueueTriggerOptions {
  type: SleepTriggerType;
  key: string;
  source: string;
  payload?: Record<string, ExampleCo>;
  dedupeWindowMinutes?: number;
  now?: Date;
  idGenerator?: () => string;
}

export interface DrainOptions {
  maxAttempts?: number;
  maxToProcess?: number;
  now?: Date;
}

export interface DrainResult {
  attempted: number;
  succeeded: number;
  failed: number;
  giveUpCount: number;
  errors: { id: string; error: string }[];
}

export type SleepTriggerHandler = (trigger: SleepTrigger) => Promise<void>;

// Path helpers

function logPath(dir: string): string {
  return path.join(dir, 'sleep-trigger-log.jsonl');
}

function snapshotPath(dir: string): string {
  return path.join(dir, 'sleep-trigger-pending.json');
}

function defaultIdGenerator(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `slp_${t}_${r}`;
}

// Append-only event write

function appendEvent(dir: string, trigger: SleepTrigger): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(logPath(dir), JSON.stringify(trigger) + '\n');
}

// Fold events into latest-per-id state

function loadState(dir: string): Map<string, SleepTrigger> {
  const p = logPath(dir);
  if (!fs.existsSync(p)) return new Map();

  const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  const byId = new Map<string, SleepTrigger>();
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as SleepTrigger;
      if (!ev || typeof ev.id !== 'string') continue;
      byId.set(ev.id, ev);
    } catch {
      /* skip malformed */
    }
  }
  return byId;
}

function writeSnapshot(dir: string, state: Map<string, SleepTrigger>): void {
  const pending = Array.from(state.values()).filter((t) => t.status === 'pending');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      snapshotPath(dir),
      JSON.stringify({ updatedAt: new Date().toISOString(), items: pending }, null, 2),
    );
  } catch {
    /* best-effort */
  }
}

// Dedupe: a (type, key) pair enqueued inside the dedupe window collapses into
// the existing pending trigger. Prevents the same contact from spawning N
// consolidation triggers when N updates land in rapid succession.

function findDedupeTarget(
  state: Map<string, SleepTrigger>,
  type: SleepTriggerType,
  key: string,
  windowMs: number,
  nowMs: number,
): SleepTrigger | null {
  if (windowMs <= 0) return null;
  for (const t of state.values()) {
    if (t.status !== 'pending') continue;
    if (t.type !== type || t.key !== key) continue;
    const enqMs = new Date(t.enqueuedAt).getTime();
    if (nowMs - enqMs <= windowMs) return t;
  }
  return null;
}

// Public API

export function enqueueSleepTrigger(
  dir: string,
  opts: EnqueueTriggerOptions,
): SleepTrigger {
  const now = opts.now ?? new Date();
  const state = loadState(dir);
  const windowMs = (opts.dedupeWindowMinutes ?? 15) * 60_000;

  const existing = findDedupeTarget(state, opts.type, opts.key, windowMs, now.getTime());
  if (existing) return existing;

  const idGen = opts.idGenerator ?? defaultIdGenerator;
  const trigger: SleepTrigger = {
    id: idGen(),
    enqueuedAt: now.toISOString(),
    type: opts.type,
    key: opts.key,
    source: opts.source,
    ...(opts.payload ? { payload: opts.payload } : {}),
    attempts: 0,
    status: 'pending',
  };

  appendEvent(dir, trigger);
  state.set(trigger.id, trigger);
  writeSnapshot(dir, state);

  return trigger;
}

export function listPendingTriggers(dir: string): SleepTrigger[] {
  const state = loadState(dir);
  const pending = Array.from(state.values()).filter((t) => t.status === 'pending');
  pending.sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));
  return pending;
}

export function getTrigger(dir: string, id: string): SleepTrigger | null {
  return loadState(dir).get(id) ?? null;
}

export async function drainSleepTriggers(
  dir: string,
  handler: SleepTriggerHandler,
  opts: DrainOptions = {},
): Promise<DrainResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const maxToProcess = opts.maxToProcess ?? Infinity;
  const now = opts.now ?? new Date();

  const state = loadState(dir);
  const pending = Array.from(state.values())
    .filter((t) => t.status === 'pending')
    .sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt))
    .slice(0, Number.isFinite(maxToProcess) ? maxToProcess : undefined);

  const result: DrainResult = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    giveUpCount: 0,
    errors: [],
  };

  for (const trigger of pending) {
    result.attempted++;
    const nextAttempt = trigger.attempts + 1;

    try {
      await handler(trigger);
      const done: SleepTrigger = {
        ...trigger,
        status: 'done',
        attempts: nextAttempt,
        lastAttemptAt: now.toISOString(),
        doneAt: now.toISOString(),
      };
      appendEvent(dir, done);
      state.set(done.id, done);
      result.succeeded++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const giveUp = nextAttempt >= maxAttempts;
      const updated: SleepTrigger = {
        ...trigger,
        attempts: nextAttempt,
        lastAttemptAt: now.toISOString(),
        lastError: message,
        status: giveUp ? 'failed' : 'pending',
      };
      appendEvent(dir, updated);
      state.set(updated.id, updated);
      result.failed++;
      result.errors.push({ id: trigger.id, error: message });
      if (giveUp) result.giveUpCount++;
    }
  }

  writeSnapshot(dir, state);
  return result;
}

// Briefing line.

export function formatPendingTriggersForBriefing(dir: string): string {
  const pending = listPendingTriggers(dir);
  if (pending.length === 0) return 'Sleep-time queue: idle.';

  const byType = new Map<SleepTriggerType, number>();
  for (const t of pending) byType.set(t.type, (byType.get(t.type) ?? 0) + 1);

  const parts: string[] = [];
  for (const [type, count] of byType) parts.push(`${count} ${type}`);
  return `Sleep-time queue: ${pending.length} pending (${parts.join(', ')}).`;
}

// Stats for tier-2 expansion.

export interface SleepQueueStats {
  pending: number;
  done: number;
  failed: number;
  total: number;
  oldestPendingAt: string | null;
}

export function getQueueStats(dir: string): SleepQueueStats {
  const state = loadState(dir);
  const stats: SleepQueueStats = {
    pending: 0,
    done: 0,
    failed: 0,
    total: 0,
    oldestPendingAt: null,
  };

  for (const t of state.values()) {
    stats.total++;
    stats[t.status]++;
    if (t.status === 'pending') {
      if (!stats.oldestPendingAt || t.enqueuedAt < stats.oldestPendingAt) {
        stats.oldestPendingAt = t.enqueuedAt;
      }
    }
  }

  return stats;
}
