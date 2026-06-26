// branch-fanout.ts
//
// Parallel fan-out runner with per-branch checkpointing. Inspired by
// langchain-ai/langgraph libs/langgraph/langgraph/types.py:654 Send and the
// Pregel executor (libs/langgraph/langgraph/pregel/main.py:427) which
// checkpoints each superstep so a branch failure resumes without replaying
// siblings.
//
// Why SecondBrain needs this:
//   - task-checkpoint.ts declares step types 'foreach' and 'map' but ships
//     no actual fan-out runner. The agent step loop is linear today.
//   - knowledge-worker dispatches research subagents one-by-one. Looking up
//     5 dentists in parallel is 5x faster as fan-out, but if the runner
//     dies mid-3rd-branch, today there is no way to resume the 3rd without
//     redoing 1 and 2.
//   - The video pipeline regenerates assets sequentially. Aurora video plus
//     thumbnail plus captions plus narration could fan out, then the
//     aggregator (auto-regen) consumes results.
//
// Contract:
//   - runBranches(runId, items, runBranch, opts) takes an array of items and
//     a per-branch async function. Each branch result is checkpointed to
//     {checkpointDir}/{runId}/{branchId}.json before runBranches returns.
//   - On a fresh run the cache is empty: every branch runs.
//   - On restart with the same runId: any branch with a present checkpoint
//     short-circuits to the cached result. Only missing branches are
//     re-executed. This honors ExampleCo's raw-archival principle: every branch
//     output is rebuildable ground truth on disk.
//   - branch IDs are derived from the item via opts.branchId(item), default
//     is `branch-{index}`. Stable IDs are required for cache hits.
//   - opts.maxConcurrency caps the in-flight count (default 4) so 50 parallel
//     branches do not flood the network or the LLM provider.
//   - Failures inside a branch are recorded to the checkpoint as
//     {ok: false, error}. Subsequent restarts can choose to retry failed
//     branches with opts.retryFailed=true (default false: do not silently
//     retry an error that the caller already saw).
//
// Pure fs, no electron coupling. Synchronous file IO is fine because branch
// counts are small (typically 2-20) and checkpoint payloads are tiny JSON.

import * as fs from 'fs';
import * as path from 'path';

// Types

export interface BranchCheckpoint<R> {
  branch_id: string;
  ok: boolean;
  result?: R;
  error?: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  attempt: number;
}

export interface FanoutOpts<I, R> {
  // Stable ID derivation. Required so re-runs with the same input set hit the
  // same cache slots even when ordering differs.
  branchId?: (item: I, index: number) => string;
  maxConcurrency?: number;
  // Retry checkpoints whose ok=false on restart. Default false.
  retryFailed?: boolean;
  // Override now() for deterministic tests.
  now?: () => number;
}

export interface FanoutResult<I, R> {
  run_id: string;
  branches: Array<{
    branch_id: string;
    item: I;
    checkpoint: BranchCheckpoint<R>;
    cached: boolean;
  }>;
  ran: number;
  cached: number;
  failed: number;
  total_duration_ms: number;
}

export type BranchFn<I, R> = (item: I, branchId: string) => Promise<R>;

// Utilities

function defaultBranchId<I>(_item: I, index: number): string {
  return `branch-${index}`;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function checkpointPath(rootDir: string, runId: string, branchId: string): string {
  return path.join(rootDir, runId, `${branchId}.json`);
}

export function readCheckpoint<R>(
  rootDir: string,
  runId: string,
  branchId: string,
): BranchCheckpoint<R> | null {
  const file = checkpointPath(rootDir, runId, branchId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as BranchCheckpoint<R>;
  } catch {
    return null;
  }
}

export function writeCheckpoint<R>(
  rootDir: string,
  runId: string,
  cp: BranchCheckpoint<R>,
): void {
  const file = checkpointPath(rootDir, runId, cp.branch_id);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(cp, null, 2), 'utf8');
}

// Concurrency-bounded executor. No external deps.
async function pool<T>(tasks: Array<() => Promise<T>>, max: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(max, tasks.length))).fill(0).map(async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= tasks.length) return;
      results[idx] = await tasks[idx]();
    }
  });
  await Promise.all(workers);
  return results;
}

// Public API

export async function runBranches<I, R>(
  runId: string,
  items: ReadonlyArray<I>,
  rootDir: string,
  runBranch: BranchFn<I, R>,
  opts: FanoutOpts<I, R> = {},
): Promise<FanoutResult<I, R>> {
  const branchId = opts.branchId ?? defaultBranchId;
  const maxConcurrency = Math.max(1, opts.maxConcurrency ?? 4);
  const retryFailed = opts.retryFailed ?? false;
  const now = opts.now ?? Date.now;

  ensureDir(path.join(rootDir, runId));

  const t0 = now();
  const tasks: Array<() => Promise<{
    branch_id: string;
    item: I;
    checkpoint: BranchCheckpoint<R>;
    cached: boolean;
  }>> = items.map((item, idx) => async () => {
    const id = branchId(item, idx);
    const existing = readCheckpoint<R>(rootDir, runId, id);
    if (existing) {
      const skip = existing.ok || !retryFailed;
      if (skip) {
        return { branch_id: id, item, checkpoint: existing, cached: true };
      }
    }
    const attempt = (existing?.attempt ?? 0) + 1;
    const startedAtMs = now();
    const startedAt = new Date(startedAtMs).toISOString();
    let cp: BranchCheckpoint<R>;
    try {
      const result = await runBranch(item, id);
      const finishedAtMs = now();
      cp = {
        branch_id: id,
        ok: true,
        result,
        started_at: startedAt,
        finished_at: new Date(finishedAtMs).toISOString(),
        duration_ms: finishedAtMs - startedAtMs,
        attempt,
      };
    } catch (err) {
      const finishedAtMs = now();
      cp = {
        branch_id: id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        started_at: startedAt,
        finished_at: new Date(finishedAtMs).toISOString(),
        duration_ms: finishedAtMs - startedAtMs,
        attempt,
      };
    }
    writeCheckpoint(rootDir, runId, cp);
    return { branch_id: id, item, checkpoint: cp, cached: false };
  });

  const results = await pool(tasks, maxConcurrency);
  const ran = results.filter((r) => !r.cached).length;
  const cached = results.filter((r) => r.cached).length;
  const failed = results.filter((r) => !r.checkpoint.ok).length;
  return {
    run_id: runId,
    branches: results,
    ran,
    cached,
    failed,
    total_duration_ms: now() - t0,
  };
}

// Aggregation helpers

export function unwrapSuccessful<I, R>(result: FanoutResult<I, R>): R[] {
  const out: R[] = [];
  for (const b of result.branches) {
    if (b.checkpoint.ok && b.checkpoint.result !== undefined) out.push(b.checkpoint.result);
  }
  return out;
}

export function failedBranches<I, R>(
  result: FanoutResult<I, R>,
): Array<{ branch_id: string; item: I; error: string }> {
  return result.branches
    .filter((b) => !b.checkpoint.ok)
    .map((b) => ({ branch_id: b.branch_id, item: b.item, error: b.checkpoint.error ?? 'ExampleCo' }));
}

export function clearRun(rootDir: string, runId: string): void {
  const dir = path.join(rootDir, runId);
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  fs.rmdirSync(dir);
}
