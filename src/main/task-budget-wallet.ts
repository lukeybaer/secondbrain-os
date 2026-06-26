// task-budget-wallet.ts
//
// Per-task budget wallet for tokens, USD cost, wall-clock latency, and
// retries. The wallet is the propagating unit: a task is opened with a
// budget, every downstream tool call deducts from it, and the wallet
// raises BudgetExhaustedError before the agent loop spends past the cap.
// This is intentionally orthogonal to the existing global guardrails:
//
//   - tool-cost-ledger.ts records each LLM call's cost as JSONL telemetry
//     after the fact. No flow control.
//   - token-budget-governor.ts evaluates a ROLLING WINDOW over the ledger
//     and returns ok / warn / exceeded / compaction_due for the current
//     minute bucket. Global, not per-task. Does not propagate into a
//     specific agent invocation.
//
// What was missing: a per-invocation wallet that a task ExampleCos with it
// through its tool chain, so the briefing pipeline can say "this section
// is allowed 20k tokens + $0.50 + 60s + 3 retries; if the producer blows
// past any one of those, fail this section gracefully, do not consume
// the next section's budget."
//
// Pattern sources (2026 OSS + production playbooks):
//   - LangGraph 0.3+ RunnableConfig.recursion_limit + per-graph budgets
//     (langchain-ai/langgraph 2026-03) -- per-invocation caps with hard
//     stop on overflow.
//   - Claude Agent SDK ContextManagement.budget_tokens + per-task
//     cost_limit (Anthropic Skills SDK 2026-03) -- the same shape Amy
//     should adopt for tool chains.
//   - OpenAI Agents SDK RunConfig.budget (openai/agents-python 2026-04) --
//     tokens + tool_calls + wall_seconds with onExhausted hook.
//   - Pregel-style fan-out budgets (LangGraph Send + StateGraph 2026-04)
//     -- when a task spawns sub-tasks, each sub-task gets a slice of the
//     parent wallet (parent.spawn(sub_share)).
//   - Composio task cost pre-check (composio/sdk/cost.py 2026-02) -- if
//     the estimated cost of the next tool call would exceed the wallet,
//     refuse before issuing the call. We expose this via canSpend(estimate).
//
// Why SecondBrain needs this on top of token-budget-governor:
//   - The governor is correct for "is Amy globally over budget right now?"
//     A SINGLE runaway tool chain inside one briefing section can spike
//     usage faster than the rolling window reacts. Wallet caps stop the
//     spike at the task boundary.
//   - The briefing has ~12 cards; each card has its own producer; a fair
//     allocation per card is impossible without a per-task wallet.
//   - Sub-task spawning (briefing -> news producer -> claim verifier ->
//     output critic) needs to share a budget with structured deductions,
//     not a global counter.
//
// Design:
//   - Pure module. No fs. No network. Wall-clock is injected so tests are
//     deterministic.
//   - Wallet is mutable on its counters (atomic-ish via a single
//     synchronous deduct() path) so callers do not have to thread the
//     return value back. Mirrors how LangGraph runtime state is mutable
//     inside a single graph invocation.
//   - On exhaustion, deduct() throws BudgetExhaustedError. The agent loop
//     catches it once at the top, records the exhaustion in the ledger,
//     and routes to the on_exhausted handler (degrade gracefully, send
//     partial result, escalate).
//   - spawn(child_share) returns a child wallet with its own caps slice;
//     deductions in the child also charge the parent. Closes the
//     fairness gap when one card has a fan-out.

// ── Types ─────────────────────────────────────────────────────────────────────

export type ResourceKind = 'tokens' | 'cost_usd' | 'wall_ms' | 'retries';

export interface BudgetCaps {
  tokens?: number;
  cost_usd?: number;
  wall_ms?: number;
  retries?: number;
}

export interface BudgetUsage {
  tokens: number;
  cost_usd: number;
  wall_ms: number;
  retries: number;
}

export interface SpendEvent {
  at_ms: number;          // injected clock value at spend
  reason: string;         // e.g. 'tool:gmail-search', 'llm:claude-haiku'
  delta: Partial<BudgetUsage>;
  caller?: string;        // optional originating subsystem id
}

export interface WalletSnapshot {
  task_id: string;
  caps: BudgetCaps;
  usage: BudgetUsage;
  remaining: BudgetUsage;     // cap - usage per resource (Infinity if no cap)
  pct_used: Record<ResourceKind, number>; // 0..1, NaN if no cap
  warn_at: number;            // soft-warn threshold (0..1)
  exhausted: boolean;
  exhausted_by?: ResourceKind;
  history: SpendEvent[];
}

export class BudgetExhaustedError extends Error {
  resource: ResourceKind;
  snapshot: WalletSnapshot;
  constructor(resource: ResourceKind, snapshot: WalletSnapshot) {
    super(
      `task budget exhausted on ${resource}: ` +
        `used ${snapshot.usage[resource]} of cap ${snapshot.caps[resource]}`
    );
    this.name = 'BudgetExhaustedError';
    this.resource = resource;
    this.snapshot = snapshot;
  }
}

export interface WalletOptions {
  /** Soft warning threshold, default 0.8 (warn at 80% of any cap). */
  warn_at?: number;
  /**
   * Optional callback fired when a resource crosses warn_at. Called at most
   * once per resource per wallet lifetime. Useful for the agent loop to
   * pre-emptively compact the conversation before the cap actually trips.
   */
  on_warn?: (resource: ResourceKind, snap: WalletSnapshot) => void;
  /**
   * Optional clock injection. Defaults to () => Date.now(). Tests pass a
   * controllable fn so wall_ms accounting is deterministic.
   */
  now?: () => number;
}

// ── Wallet ───────────────────────────────────────────────────────────────────

export class TaskBudgetWallet {
  readonly task_id: string;
  readonly caps: BudgetCaps;
  readonly opened_at_ms: number;
  private readonly _opts: Required<Pick<WalletOptions, 'warn_at' | 'now'>> &
    Pick<WalletOptions, 'on_warn'>;
  private readonly _usage: BudgetUsage = {
    tokens: 0,
    cost_usd: 0,
    wall_ms: 0,
    retries: 0,
  };
  private readonly _history: SpendEvent[] = [];
  private readonly _warned: Set<ResourceKind> = new Set();
  private _exhausted: boolean = false;
  private _exhaustedBy?: ResourceKind;
  private _parent?: TaskBudgetWallet;

  constructor(task_id: string, caps: BudgetCaps, opts: WalletOptions = {}) {
    if (!task_id || typeof task_id !== 'string') {
      throw new Error('task_id is required');
    }
    validateCaps(caps);
    this.task_id = task_id;
    this.caps = { ...caps };
    this._opts = {
      warn_at: opts.warn_at ?? 0.8,
      now: opts.now ?? (() => Date.now()),
      on_warn: opts.on_warn,
    };
    this.opened_at_ms = this._opts.now();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Returns true if the planned spend would fit within the remaining caps
   * without throwing. Useful for "should I issue this tool call at all?"
   * checks before paying for an LLM round-trip.
   */
  canSpend(delta: Partial<BudgetUsage>): boolean {
    for (const key of RESOURCE_KEYS) {
      const cap = this.caps[key];
      if (cap == null) continue;
      const requested = (this._usage[key] ?? 0) + (delta[key] ?? 0);
      if (requested > cap) return false;
    }
    return true;
  }

  /**
   * Deduct a planned spend. Throws BudgetExhaustedError if any cap is
   * exceeded; the wallet is marked exhausted with the offending resource.
   * Successful deductions are recorded in history for observability.
   */
  deduct(delta: Partial<BudgetUsage>, reason: string, caller?: string): void {
    if (this._exhausted) {
      // Once exhausted, every subsequent deduct fails loudly so the agent
      // cannot silently drift past the cap.
      throw new BudgetExhaustedError(this._exhaustedBy as ResourceKind, this.snapshot());
    }
    // Test caps BEFORE applying so a single oversize spend trips cleanly.
    for (const key of RESOURCE_KEYS) {
      const cap = this.caps[key];
      if (cap == null) continue;
      const projected = (this._usage[key] ?? 0) + (delta[key] ?? 0);
      if (projected > cap) {
        this._exhausted = true;
        this._exhaustedBy = key;
        // Still record what we attempted so post-mortem shows the
        // offending call, but DO NOT actually mutate usage (we did not
        // spend; we refused).
        this._history.push({
          at_ms: this._opts.now(),
          reason: `refused:${reason}`,
          delta: { ...delta },
          caller,
        });
        throw new BudgetExhaustedError(key, this.snapshot());
      }
    }
    // Apply deduction.
    for (const key of RESOURCE_KEYS) {
      const d = delta[key];
      if (d != null) this._usage[key] += d;
    }
    const ev: SpendEvent = {
      at_ms: this._opts.now(),
      reason,
      delta: { ...delta },
      caller,
    };
    this._history.push(ev);
    // Also charge the parent so a fan-out child reflects in the parent
    // wallet automatically.
    if (this._parent && !this._parent.exhausted) {
      try {
        this._parent.deduct(delta, `child:${this.task_id}:${reason}`, caller);
      } catch (err) {
        // Parent exhaustion does not roll back the child's local accounting
        // (we already spent the resource), but the child is now exhausted
        // because no further parent-charging deduction can succeed.
        this._exhausted = true;
        this._exhaustedBy =
          err instanceof BudgetExhaustedError ? err.resource : undefined;
        throw err;
      }
    }
    // Soft-warn once per resource at warn_at.
    for (const key of RESOURCE_KEYS) {
      if (this._warned.has(key)) continue;
      const cap = this.caps[key];
      if (cap == null) continue;
      const pct = this._usage[key] / cap;
      if (pct >= this._opts.warn_at) {
        this._warned.add(key);
        try {
          this._opts.on_warn?.(key, this.snapshot());
        } catch {
          // Hook failures must never break the agent loop.
        }
      }
    }
  }

  /**
   * Spawn a child wallet that inherits part of the parent's remaining
   * caps. Deductions in the child are mirrored to the parent. Child caps
   * are clamped to the parent's REMAINING budget so a misconfigured share
   * cannot over-commit the parent.
   */
  spawn(child_id: string, share: BudgetCaps): TaskBudgetWallet {
    if (this._exhausted) {
      throw new BudgetExhaustedError(this._exhaustedBy as ResourceKind, this.snapshot());
    }
    const remaining = this.remaining();
    const childCaps: BudgetCaps = {};
    for (const key of RESOURCE_KEYS) {
      const requested = share[key];
      if (requested == null) continue;
      const rem = remaining[key];
      childCaps[key] = rem === Infinity ? requested : Math.min(requested, rem);
    }
    const child = new TaskBudgetWallet(child_id, childCaps, {
      warn_at: this._opts.warn_at,
      now: this._opts.now,
      on_warn: this._opts.on_warn,
    });
    child._parent = this;
    return child;
  }

  remaining(): BudgetUsage {
    const out: BudgetUsage = { tokens: 0, cost_usd: 0, wall_ms: 0, retries: 0 };
    for (const key of RESOURCE_KEYS) {
      const cap = this.caps[key];
      out[key] = cap == null ? Infinity : Math.max(0, cap - this._usage[key]);
    }
    return out;
  }

  /**
   * Advance the wall_ms counter using the injected clock. Idempotent: if
   * called twice in the same tick, the second call is a no-op. The agent
   * loop typically calls touchWallClock() at the start of every step so
   * a stalled await charges latency even when no tokens were spent.
   */
  touchWallClock(): void {
    const now = this._opts.now();
    const elapsed = Math.max(0, now - this.opened_at_ms - this._usage.wall_ms);
    if (elapsed <= 0) return;
    try {
      this.deduct({ wall_ms: elapsed }, 'wall_clock_tick');
    } catch (err) {
      if (!(err instanceof BudgetExhaustedError)) throw err;
      // Re-throw so the agent loop sees the exhaustion.
      throw err;
    }
  }

  get usage(): BudgetUsage {
    return { ...this._usage };
  }

  get exhausted(): boolean {
    return this._exhausted;
  }

  get exhausted_by(): ResourceKind | undefined {
    return this._exhaustedBy;
  }

  /**
   * Render a snapshot suitable for logging into tool-cost-ledger or for
   * surfacing in the briefing system-health card. Defensive copy.
   */
  snapshot(): WalletSnapshot {
    const remaining = this.remaining();
    const pct: Record<ResourceKind, number> = {
      tokens: capPct(this._usage.tokens, this.caps.tokens),
      cost_usd: capPct(this._usage.cost_usd, this.caps.cost_usd),
      wall_ms: capPct(this._usage.wall_ms, this.caps.wall_ms),
      retries: capPct(this._usage.retries, this.caps.retries),
    };
    return {
      task_id: this.task_id,
      caps: { ...this.caps },
      usage: { ...this._usage },
      remaining,
      pct_used: pct,
      warn_at: this._opts.warn_at,
      exhausted: this._exhausted,
      exhausted_by: this._exhaustedBy,
      history: this._history.slice(),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const RESOURCE_KEYS: ResourceKind[] = ['tokens', 'cost_usd', 'wall_ms', 'retries'];

function capPct(used: number, cap?: number): number {
  if (cap == null) return Number.NaN;
  if (cap <= 0) return Number.POSITIVE_INFINITY;
  return used / cap;
}

function validateCaps(caps: BudgetCaps): void {
  for (const key of RESOURCE_KEYS) {
    const v = caps[key];
    if (v == null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(`cap.${key} must be a non-negative finite number, got ${v}`);
    }
  }
}

// ── Convenience: wrap an async tool call ──────────────────────────────────────

/**
 * Returns a wrapped function that deducts the planned spend before running
 * the inner function. If the wallet refuses, the inner is never called and
 * the caller sees BudgetExhaustedError. Mirrors LangGraph's "guard then
 * invoke" pattern.
 */
export function withBudget<TArgs extends ExampleCo[], TResult>(
  wallet: TaskBudgetWallet,
  estimate: Partial<BudgetUsage>,
  reason: string,
  fn: (...args: TArgs) => Promise<TResult> | TResult
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs) => {
    wallet.deduct(estimate, reason);
    return await fn(...args);
  };
}
