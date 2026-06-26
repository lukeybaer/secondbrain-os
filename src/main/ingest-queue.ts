/**
 * ingest-queue.ts
 *
 * File-based work queue for lightweight ingest items (Otter transcripts,
 * Gmail threads, LinkedIn events, anything that wants to hand off a small
 * payload for Tier 2 / Graphiti enrichment).
 *
 * Why this exists: before this module, every enrichment pass spawned its
 * own `claude -p` subprocess via claude-runner, and each one paid the full
 * Tier 1 SessionStart context load (~10K tokens). That made ingest sessions
 * dominate the token bill even though each payload is tiny.
 *
 * The fix is two-part:
 *   1) A queue (this file) that enrichment producers write items into
 *      instead of spawning per-item sessions.
 *   2) A single batched drain worker (scripts/ingest-queue-drain.ts) that
 *      processes all pending items in one session with SECONDBRAIN_SESSION_MODE=ingest
 *      set, which routes SessionStart to the ~400-token stub hook instead
 *      of the ~10K Tier 1 load.
 *
 * Layout under secondbrain/data/ingest-queue/:
 *   pending/{ulid}.json     - ready to process
 *   in-progress/{ulid}.json - claimed by a drain worker
 *   done/{ulid}.json        - successfully processed
 *   failed/{ulid}.json      - terminal error, inspection required
 *   escalated/{ulid}.json   - anomaly, needs full-context session
 *
 * Atomicity: every state transition is an fs.renameSync, which on NTFS and
 * POSIX is atomic within a single filesystem. Producers and consumers never
 * hold exclusive locks — the rename IS the lock.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type IngestSource =
  | 'otter'
  | 'gmail'
  | 'whatsapp'
  | 'sms'
  | 'linkedin'
  | 'call'
  | 'briefing'
  | 'other';

/** Shape of a queued ingest item. Small by design — the raw payload lives in
 *  data/{source}/raw/ and is referenced by `rawRef`, not embedded here. */
export interface IngestItem {
  /** Monotonic time-sorted id (ULID-ish). Set by enqueue(). */
  id: string;
  /** Data source category, used for routing in the drain handler. */
  source: IngestSource;
  /** External id from the source system (otter speech id, gmail message id, etc). */
  externalId: string;
  /** Path or reference to the raw archival file under data/{source}/raw/. */
  rawRef: string;
  /** Short hint the drain worker uses to pick a handler (e.g. "gmail:thread:enrich"). */
  kind: string;
  /** Free-form metadata the handler needs. Keep small. */
  meta?: Record<string, ExampleCo>;
  /** ISO timestamp of when the item was enqueued. */
  receivedAt: string;
  /** Number of times a drain has picked up this item and failed. Auto-incremented. */
  attempts: number;
}

export type QueueState = 'pending' | 'in-progress' | 'done' | 'failed' | 'escalated';

/** Result produced by a handler for a single drained item. */
export type DrainResult =
  | { outcome: 'done'; note?: string }
  | { outcome: 'failed'; error: string }
  | { outcome: 'escalated'; reason: string };

export interface DrainReport {
  processed: number;
  done: number;
  failed: number;
  escalated: number;
  durationMs: number;
  items: Array<{ id: string; source: IngestSource; outcome: DrainResult['outcome']; note?: string }>;
}

/** Config for a drain pass. */
export interface DrainOptions {
  /** Maximum items to process in one pass. Default 50 — keeps any single drain bounded. */
  maxItems?: number;
  /** Retry budget before an item is auto-failed. Default 3. */
  maxAttempts?: number;
  /** Override the queue root — tests use this to isolate filesystem state. */
  queueRoot?: string;
}

// ── Path resolution ───────────────────────────────────────────────────────────

/** Resolve the default queue root. Honors QUEUE_ROOT_OVERRIDE for tests. */
export function defaultQueueRoot(): string {
  if (process.env.INGEST_QUEUE_ROOT) return process.env.INGEST_QUEUE_ROOT;
  const repoRoot = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..');
  return path.join(repoRoot, 'data', 'ingest-queue');
}

function stateDir(root: string, state: QueueState): string {
  return path.join(root, state);
}

function ensureLayout(root: string): void {
  const states: QueueState[] = ['pending', 'in-progress', 'done', 'failed', 'escalated'];
  for (const s of states) {
    const d = stateDir(root, s);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

// ── ID generation ─────────────────────────────────────────────────────────────

/** Monotonic-ish id: base-36 ms timestamp + 6 random chars. Collision-proof
 *  within a single producer, sort-friendly across producers. */
function newId(): string {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = crypto.randomBytes(4).toString('hex').slice(0, 6);
  return `${ts}-${rand}`;
}

// ── Atomic file operations ────────────────────────────────────────────────────

function writeAtomic(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, filePath);
}

function moveBetweenStates(root: string, id: string, from: QueueState, to: QueueState): void {
  const src = path.join(stateDir(root, from), `${id}.json`);
  const dst = path.join(stateDir(root, to), `${id}.json`);
  fs.renameSync(src, dst);
}

function readItemFile(filePath: string): IngestItem {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as IngestItem;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Enqueue a new item. Returns the generated id. Callers should have already
 *  written the raw payload under data/{source}/raw/ before calling this. */
export function enqueue(
  input: Omit<IngestItem, 'id' | 'receivedAt' | 'attempts'>,
  opts?: { queueRoot?: string },
): string {
  const root = opts?.queueRoot ?? defaultQueueRoot();
  ensureLayout(root);
  const id = newId();
  const item: IngestItem = {
    id,
    receivedAt: new Date().toISOString(),
    attempts: 0,
    ...input,
  };
  writeAtomic(path.join(stateDir(root, 'pending'), `${id}.json`), JSON.stringify(item, null, 2));
  return id;
}

/** Return counts by state. Useful for health checks and telemetry. */
export function queueCounts(queueRoot?: string): Record<QueueState, number> {
  const root = queueRoot ?? defaultQueueRoot();
  ensureLayout(root);
  const states: QueueState[] = ['pending', 'in-progress', 'done', 'failed', 'escalated'];
  const out = {} as Record<QueueState, number>;
  for (const s of states) {
    out[s] = fs.readdirSync(stateDir(root, s)).filter((f) => f.endsWith('.json')).length;
  }
  return out;
}

/** List pending items, sorted by id (chronological). Used by the drain worker. */
export function listPending(queueRoot?: string): IngestItem[] {
  const root = queueRoot ?? defaultQueueRoot();
  ensureLayout(root);
  const dir = stateDir(root, 'pending');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((f) => readItemFile(path.join(dir, f)));
}

/** Claim an item: move it from pending/ to in-progress/. Returns the item
 *  with attempts incremented, or null if the file is gone (race). */
export function claim(id: string, queueRoot?: string): IngestItem | null {
  const root = queueRoot ?? defaultQueueRoot();
  try {
    moveBetweenStates(root, id, 'pending', 'in-progress');
  } catch {
    return null;
  }
  const filePath = path.join(stateDir(root, 'in-progress'), `${id}.json`);
  const item = readItemFile(filePath);
  item.attempts += 1;
  writeAtomic(filePath, JSON.stringify(item, null, 2));
  return item;
}

/** Mark a claimed item as successfully processed. */
export function markDone(id: string, queueRoot?: string): void {
  const root = queueRoot ?? defaultQueueRoot();
  moveBetweenStates(root, id, 'in-progress', 'done');
}

/** Mark a claimed item as terminally failed. */
export function markFailed(id: string, error: string, queueRoot?: string): void {
  const root = queueRoot ?? defaultQueueRoot();
  const srcPath = path.join(stateDir(root, 'in-progress'), `${id}.json`);
  const item = readItemFile(srcPath);
  const annotated = { ...item, meta: { ...(item.meta ?? {}), lastError: error } };
  writeAtomic(srcPath, JSON.stringify(annotated, null, 2));
  moveBetweenStates(root, id, 'in-progress', 'failed');
}

/** Escape hatch: move a claimed item to escalated/ when the drain worker
 *  encounters an anomaly (ExampleCo sender, parse failure, contradictory state).
 *  A full-context session will pick it up later. */
export function escalate(id: string, reason: string, queueRoot?: string): void {
  const root = queueRoot ?? defaultQueueRoot();
  const srcPath = path.join(stateDir(root, 'in-progress'), `${id}.json`);
  const item = readItemFile(srcPath);
  const annotated = { ...item, meta: { ...(item.meta ?? {}), escalationReason: reason } };
  writeAtomic(srcPath, JSON.stringify(annotated, null, 2));
  moveBetweenStates(root, id, 'in-progress', 'escalated');
}

/** Release a claimed item back to pending/ (e.g. worker crash recovery).
 *  Use with care — repeated claim loops increment attempts until the item
 *  hits maxAttempts in drain() and gets auto-failed. */
export function release(id: string, queueRoot?: string): void {
  const root = queueRoot ?? defaultQueueRoot();
  moveBetweenStates(root, id, 'in-progress', 'pending');
}

// ── Drain loop ────────────────────────────────────────────────────────────────

export type DrainHandler = (item: IngestItem) => Promise<DrainResult>;

/** Process all pending items in a single pass using the given handler.
 *  This is what the batched ingest session calls — one claude -p invocation
 *  per drain() call, processing many items, paying Tier 1 cost once. */
export async function drain(handler: DrainHandler, opts?: DrainOptions): Promise<DrainReport> {
  const started = Date.now();
  const root = opts?.queueRoot ?? defaultQueueRoot();
  const maxItems = opts?.maxItems ?? 50;
  const maxAttempts = opts?.maxAttempts ?? 3;
  ensureLayout(root);

  const pending = listPending(root).slice(0, maxItems);

  const report: DrainReport = {
    processed: 0,
    done: 0,
    failed: 0,
    escalated: 0,
    durationMs: 0,
    items: [],
  };

  for (const item of pending) {
    const claimed = claim(item.id, root);
    if (!claimed) continue; // race: another worker grabbed it
    report.processed += 1;

    if (claimed.attempts > maxAttempts) {
      markFailed(
        claimed.id,
        `Exceeded max attempts (${maxAttempts}); attempts=${claimed.attempts}`,
        root,
      );
      report.failed += 1;
      report.items.push({
        id: claimed.id,
        source: claimed.source,
        outcome: 'failed',
        note: 'max attempts exceeded',
      });
      continue;
    }

    let result: DrainResult;
    try {
      result = await handler(claimed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { outcome: 'failed', error: `Handler threw: ${msg}` };
    }

    switch (result.outcome) {
      case 'done':
        markDone(claimed.id, root);
        report.done += 1;
        report.items.push({
          id: claimed.id,
          source: claimed.source,
          outcome: 'done',
          note: result.note,
        });
        break;
      case 'failed':
        markFailed(claimed.id, result.error, root);
        report.failed += 1;
        report.items.push({
          id: claimed.id,
          source: claimed.source,
          outcome: 'failed',
          note: result.error,
        });
        break;
      case 'escalated':
        escalate(claimed.id, result.reason, root);
        report.escalated += 1;
        report.items.push({
          id: claimed.id,
          source: claimed.source,
          outcome: 'escalated',
          note: result.reason,
        });
        break;
    }
  }

  report.durationMs = Date.now() - started;
  return report;
}
