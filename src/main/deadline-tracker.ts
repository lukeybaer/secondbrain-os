// deadline-tracker.ts
//
// Per-task deadline budget. A long-running workflow declares "I have N
// milliseconds to complete"; downstream steps consult `remaining()` to decide
// whether to attempt the next operation, request a degraded path, or abort
// gracefully. Pure module: no electron, no fs, no network.
//
// Patterns synthesized from:
//   - Go context.WithDeadline / context.WithTimeout (golang/go src/context/
//     context.go) -- canonical pattern: a parent deadline propagates to all
//     children, children may shorten but never extend, listeners poll Done().
//   - Temporal Workflow timeout policy (sdk-typescript v1.13
//     ChildWorkflowOptions.workflowExecutionTimeout) -- parent-set timeout
//     that cascades to descendants and triggers a deterministic abort path.
//   - Kubernetes ActiveDeadlineSeconds (kubernetes/pkg/apis/batch/types.go) --
//     wall-clock budget that enforces graceful exit before SIGKILL.
//   - Letta agent `step_timeout` (letta/agent/agent_loop.py 2026-03) -- per-
//     step budget that dovetails with multi-step workflows.
//
// Why SecondBrain needs this:
//   - The 5:30 AM briefing pipeline can drift past 30 min when one section
//     (LinkedIn intel, Otter ingest) hangs. There is no upper bound; the
//     scheduled-task harness times out at 60 min but by then we've burned
//     budget AND blocked the next slot.
//   - Nightly enhancement runs (this very task) have no self-imposed
//     deadline. A runaway research loop should hit a soft deadline at
//     45 min and gracefully ship whatever is ready, log a partial run,
//     and exit cleanly rather than be killed mid-commit.
//   - Vapi outbound calls have a wall-clock budget for the dial+talk; if
//     we are already 80% past it when we kick a tool call, the tool call
//     should know to skip and return a stub.
//
// Design:
//   - `Deadline` is immutable once created. Children inherit-or-shorten via
//     `withChildBudget()` returning a new Deadline.
//   - `remaining()` returns ms left (>=0). `expired()` returns true when
//     remaining is 0.
//   - `checkpoint(name)` records a timestamp + remaining at the moment of
//     the check; `getCheckpoints()` returns the audit log so a post-mortem
//     can ask "where did the budget actually go?"
//   - `enforce(name)` throws DeadlineExceeded with the checkpoint trail
//     when called past the deadline. Used at hard cutoff points.

// Types

export type DeadlineReason = 'wall_clock' | 'parent_inherited' | 'explicit_pause';

export interface DeadlineOptions {
  /** Total budget in milliseconds. e.g. 1_800_000 = 30 minutes. */
  budget_ms: number;
  /** Stable id for telemetry / nested deadlines. e.g. 'briefing-run' or 'nightly-enhancement'. */
  id: string;
  /** Optional clock injector for tests. Defaults to Date.now. */
  now?: () => number;
  /** Optional grace period after expiry where `enforce()` still allows
   *  cleanup operations (writing a partial-run log, releasing resources)
   *  before throwing. Default 0 (no grace). */
  grace_ms?: number;
}

export interface DeadlineCheckpoint {
  name: string;
  timestamp_ms: number;        // absolute wall-clock when checkpoint fired
  elapsed_ms: number;          // ms since deadline.start
  remaining_ms: number;        // ms left at the moment of the check
  metadata?: Record<string, ExampleCo>;
}

export class DeadlineExceeded extends Error {
  constructor(
    public readonly deadlineId: string,
    public readonly stage: string,
    public readonly elapsed_ms: number,
    public readonly budget_ms: number,
    public readonly checkpoints: ReadonlyArray<DeadlineCheckpoint>,
  ) {
    super(`Deadline '${deadlineId}' exceeded at stage '${stage}': ${elapsed_ms}ms used of ${budget_ms}ms budget`);
    this.name = 'DeadlineExceeded';
  }
}

// Deadline

export class Deadline {
  public readonly id: string;
  public readonly budget_ms: number;
  public readonly start_ms: number;
  public readonly end_ms: number;
  public readonly grace_ms: number;
  private readonly nowFn: () => number;
  private readonly checkpoints: DeadlineCheckpoint[] = [];

  constructor(opts: DeadlineOptions) {
    if (opts.budget_ms <= 0) {
      throw new Error(`Deadline.budget_ms must be > 0, got ${opts.budget_ms}`);
    }
    if (!opts.id || opts.id.length === 0) {
      throw new Error('Deadline.id must be a non-empty string');
    }
    this.id = opts.id;
    this.budget_ms = opts.budget_ms;
    this.nowFn = opts.now ?? (() => Date.now());
    this.start_ms = this.nowFn();
    this.end_ms = this.start_ms + opts.budget_ms;
    this.grace_ms = opts.grace_ms ?? 0;
  }

  /** ms elapsed since start. */
  elapsed(): number {
    return Math.max(0, this.nowFn() - this.start_ms);
  }

  /** ms remaining until end. Clamped to 0 when expired. */
  remaining(): number {
    return Math.max(0, this.end_ms - this.nowFn());
  }

  /** ms remaining including grace window. */
  remainingWithGrace(): number {
    return Math.max(0, this.end_ms + this.grace_ms - this.nowFn());
  }

  /** True when remaining() === 0 (grace not consulted). */
  expired(): boolean {
    return this.remaining() === 0;
  }

  /** True when even the grace window is exhausted. */
  expiredHard(): boolean {
    return this.remainingWithGrace() === 0;
  }

  /** Fraction of budget used. 0.0 at start, 1.0 at end, may exceed 1.0 if
   *  past deadline (for telemetry; the value is informational, not gated). */
  usedFraction(): number {
    return this.elapsed() / this.budget_ms;
  }

  /** Record a milestone in the deadline log. Returns the checkpoint. */
  checkpoint(name: string, metadata?: Record<string, ExampleCo>): DeadlineCheckpoint {
    const timestamp_ms = this.nowFn();
    const cp: DeadlineCheckpoint = {
      name,
      timestamp_ms,
      elapsed_ms: timestamp_ms - this.start_ms,
      remaining_ms: Math.max(0, this.end_ms - timestamp_ms),
      metadata,
    };
    this.checkpoints.push(cp);
    return cp;
  }

  /** Read-only view of recorded checkpoints. */
  getCheckpoints(): ReadonlyArray<DeadlineCheckpoint> {
    return this.checkpoints.slice();
  }

  /**
   * Throw DeadlineExceeded when expired. Records a checkpoint named `stage`
   * before throwing so the audit trail captures the exact point of failure.
   * When `allowGrace` is true (default), the grace window is honored.
   */
  enforce(stage: string, allowGrace: boolean = true): void {
    const expired = allowGrace ? this.expiredHard() : this.expired();
    if (!expired) {
      this.checkpoint(`${stage}:check`, { passed: true });
      return;
    }
    this.checkpoint(`${stage}:expired`, { passed: false });
    throw new DeadlineExceeded(this.id, stage, this.elapsed(), this.budget_ms, this.getCheckpoints());
  }

  /**
   * Return true when at least `min_ms` of budget remains. Used as a soft
   * gate: "do I have at least 5s left? if not skip this optional step".
   */
  hasBudget(min_ms: number): boolean {
    return this.remaining() >= min_ms;
  }

  /**
   * Spawn a child deadline that inherits this deadline's remaining time
   * shortened to `child_budget_ms` (whichever is shorter). Children can
   * never extend their parent. Returns a fresh Deadline with the same now()
   * function so tests still control time.
   */
  withChildBudget(child_id: string, child_budget_ms: number): Deadline {
    const inherited = Math.min(child_budget_ms, this.remaining());
    if (inherited <= 0) {
      throw new DeadlineExceeded(this.id, `child:${child_id}`, this.elapsed(), this.budget_ms, this.getCheckpoints());
    }
    return new Deadline({
      id: child_id,
      budget_ms: inherited,
      now: this.nowFn,
    });
  }

  /**
   * Run `fn` and return its result, but reject if the deadline expires
   * before `fn` resolves. Pattern: race fn against a setTimeout(remaining).
   * Native Promise.race semantics; the fn keeps running after the race
   * finishes (caller is responsible for cleanup if that matters).
   */
  async race<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const remaining = this.remainingWithGrace();
    if (remaining === 0) {
      this.checkpoint(`${stage}:expired_before_race`, { passed: false });
      throw new DeadlineExceeded(this.id, stage, this.elapsed(), this.budget_ms, this.getCheckpoints());
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.checkpoint(`${stage}:race_timeout`, { passed: false });
        reject(new DeadlineExceeded(this.id, stage, this.elapsed(), this.budget_ms, this.getCheckpoints()));
      }, remaining);
    });
    try {
      return await Promise.race([fn(), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Snapshot for logging. */
  toJSON(): { id: string; budget_ms: number; elapsed_ms: number; remaining_ms: number; expired: boolean; checkpoints: ReadonlyArray<DeadlineCheckpoint> } {
    return {
      id: this.id,
      budget_ms: this.budget_ms,
      elapsed_ms: this.elapsed(),
      remaining_ms: this.remaining(),
      expired: this.expired(),
      checkpoints: this.getCheckpoints(),
    };
  }
}

// Factory helpers

export function withDeadline(id: string, budget_ms: number, opts: { grace_ms?: number; now?: () => number } = {}): Deadline {
  return new Deadline({ id, budget_ms, grace_ms: opts.grace_ms, now: opts.now });
}

/**
 * Convenience: run `fn` with a deadline. Returns either the value or rejects
 * with DeadlineExceeded. Mirrors Go's `context.WithTimeout(ctx, d)` ergonomic.
 */
export async function withDeadlineAsync<T>(
  id: string,
  budget_ms: number,
  fn: (deadline: Deadline) => Promise<T>,
  opts: { grace_ms?: number; now?: () => number } = {},
): Promise<T> {
  const deadline = new Deadline({ id, budget_ms, grace_ms: opts.grace_ms, now: opts.now });
  return deadline.race('top', () => fn(deadline));
}
