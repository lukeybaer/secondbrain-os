// token-budget-governor.ts
//
// Rolling-window token+cost budget governor for SecondBrain. Reads the
// tool-cost-ledger and decides whether the next LLM call should proceed,
// be paused, or trigger compaction. Pure module: no electron, no network,
// fs is read-only against the ledger path.
//
// Patterns synthesized from:
//   - Letta context_window_pressure (letta/agent/agent_state.py 2026-03) --
//     a per-agent moving threshold over recent token consumption that triggers
//     archival memory eviction BEFORE the model rejects an oversize prompt.
//   - LangSmith run-budget guardrails (langsmith/_internal/budget.py 2026-04) --
//     project-level USD cap that auto-aborts traces; we adapt the cap idea
//     but call back instead of aborting silently.
//   - LiteLLM router proxy budget tracker (proxy/utils.py
//     `track_cost_callback` 2026-04-30) -- minute-bucket token accounting
//     that pairs naturally with tool-cost-ledger.ts:minuteBucket().
//   - Composio task-cost-pre-check (composio/sdk/cost.py 2026-02) -- estimate
//     a planned tool sequence's cost BEFORE running it, refuse if it would
//     exceed the cap. We expose this as `wouldExceedBudget(estimate)`.
//
// Why SecondBrain needs this:
//   - The 5:30 AM briefing pipeline runs ~80-200 LLM calls per day across
//     the briefing/parser/diff/dispatch/output-critic surfaces. There is no
//     mechanical guardrail that fires when one bug causes a feedback loop --
//     e.g. a section that retries forever on a parse error. tool-cost-ledger
//     records every call but no one reads it until the next morning.
//   - conversation-compressor.ts is opt-in. A governor that reads the rolling
//     window and proactively triggers compaction when token pressure hits a
//     threshold closes the loop without making every callsite remember.
//   - When the daily cap is exhausted, the briefing should degrade gracefully
//     (skip optional sections, send a short "budget reached" summary) rather
//     than burn through Claude Max quota and cause a real outage at the
//     wrong time of day.
//
// Design:
//   - `BudgetWindow` holds aggregate counters; `recordObservation()` advances
//     them in O(1) per ledger row.
//   - `evaluate(now, ledgerRecords, policy)` walks the rolling window and
//     emits a `BudgetVerdict` -- `ok | warn | exceeded | compaction_due` --
//     the caller acts on. The governor never side-effects beyond the verdict;
//     callers (chat.ts, briefing.ts, conversation-compressor.ts) decide what
//     "compaction_due" means in their context.

import * as fs from 'fs';
import * as path from 'path';

// Re-use the ledger record shape without importing the module to keep this
// pure (no implicit dependency on tool-cost-ledger initialization order).
// Tests pass synthetic records; production callers pass `readLedger(path)`.
export interface LedgerRecord {
  timestamp: string;             // ISO
  surface: string;
  provider: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  est_cost_usd: number;
  wall_ms: number;
  minute_bucket: string;
}

// Policy

export interface BudgetPolicy {
  /** Window over which counters are aggregated. e.g. 60_000 = 1 minute,
   *  3_600_000 = 1 hour, 86_400_000 = 1 day. */
  window_ms: number;
  /** Soft cap. When token usage in the window crosses this, verdict is 'warn'. */
  warn_tokens?: number;
  /** Hard cap. When token usage crosses this, verdict is 'exceeded'. */
  max_tokens?: number;
  /** Soft cap on USD. */
  warn_usd?: number;
  /** Hard cap on USD. */
  max_usd?: number;
  /** Compaction trigger fraction of warn_tokens. e.g. 0.8 = compact when at
   *  80% of warn_tokens. Lets compaction fire BEFORE the warn fires so the
   *  next call comes in under a freshly-trimmed context. Default: 0.8. */
  compaction_threshold_fraction?: number;
  /** Optional surface filter. If set, only records whose `surface` matches
   *  this allowlist contribute. Used to scope a budget to a specific pipeline
   *  (e.g. only count briefing surface, not chat surface). */
  surface_allowlist?: ReadonlyArray<string>;
  /** Optional provider filter. If set, only the named providers count. */
  provider_allowlist?: ReadonlyArray<string>;
}

// Verdict

export type Verdict = 'ok' | 'warn' | 'exceeded' | 'compaction_due';

export interface BudgetSnapshot {
  window_ms: number;
  window_start: string;          // ISO inclusive lower bound
  window_end: string;            // ISO inclusive upper bound (= now)
  records_in_window: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  by_surface: Record<string, { tokens: number; cost_usd: number; calls: number }>;
  by_provider: Record<string, { tokens: number; cost_usd: number; calls: number }>;
}

export interface BudgetVerdict {
  verdict: Verdict;
  snapshot: BudgetSnapshot;
  policy: BudgetPolicy;
  /** Human-readable reason. Empty when verdict is 'ok'. */
  reason: string;
  /** When verdict triggered, which limit fired. */
  trigger?: 'tokens_warn' | 'tokens_max' | 'usd_warn' | 'usd_max' | 'compaction';
}

// Aggregation

function inAllowlist(value: string | undefined, list: ReadonlyArray<string> | undefined): boolean {
  if (!list || list.length === 0) return true;
  if (!value) return false;
  return list.includes(value);
}

export function aggregateWindow(
  records: ReadonlyArray<LedgerRecord>,
  policy: BudgetPolicy,
  now: Date = new Date(),
): BudgetSnapshot {
  const upper = now.getTime();
  const lower = upper - policy.window_ms;
  const lowerIso = new Date(lower).toISOString();
  const upperIso = new Date(upper).toISOString();
  const filtered = records.filter((r) => {
    const t = Date.parse(r.timestamp);
    if (Number.isNaN(t)) return false;
    if (t < lower || t > upper) return false;
    if (!inAllowlist(r.surface, policy.surface_allowlist)) return false;
    if (!inAllowlist(r.provider, policy.provider_allowlist)) return false;
    return true;
  });
  const by_surface: Record<string, { tokens: number; cost_usd: number; calls: number }> = {};
  const by_provider: Record<string, { tokens: number; cost_usd: number; calls: number }> = {};
  let total_input = 0;
  let total_output = 0;
  let total_cost = 0;
  for (const r of filtered) {
    const inT = r.input_tokens ?? 0;
    const outT = r.output_tokens ?? 0;
    total_input += inT;
    total_output += outT;
    total_cost += r.est_cost_usd;
    const sSlot = (by_surface[r.surface] ||= { tokens: 0, cost_usd: 0, calls: 0 });
    sSlot.tokens += inT + outT;
    sSlot.cost_usd += r.est_cost_usd;
    sSlot.calls += 1;
    const pSlot = (by_provider[r.provider] ||= { tokens: 0, cost_usd: 0, calls: 0 });
    pSlot.tokens += inT + outT;
    pSlot.cost_usd += r.est_cost_usd;
    pSlot.calls += 1;
  }
  return {
    window_ms: policy.window_ms,
    window_start: lowerIso,
    window_end: upperIso,
    records_in_window: filtered.length,
    total_input_tokens: total_input,
    total_output_tokens: total_output,
    total_tokens: total_input + total_output,
    total_cost_usd: total_cost,
    by_surface,
    by_provider,
  };
}

// Verdict logic

export function evaluateBudget(
  records: ReadonlyArray<LedgerRecord>,
  policy: BudgetPolicy,
  now: Date = new Date(),
): BudgetVerdict {
  const snapshot = aggregateWindow(records, policy, now);
  const fraction = policy.compaction_threshold_fraction ?? 0.8;

  // hard caps first
  if (policy.max_tokens != null && snapshot.total_tokens >= policy.max_tokens) {
    return {
      verdict: 'exceeded',
      snapshot,
      policy,
      reason: `tokens ${snapshot.total_tokens} >= max_tokens ${policy.max_tokens} in last ${policy.window_ms}ms`,
      trigger: 'tokens_max',
    };
  }
  if (policy.max_usd != null && snapshot.total_cost_usd >= policy.max_usd) {
    return {
      verdict: 'exceeded',
      snapshot,
      policy,
      reason: `cost $${snapshot.total_cost_usd.toFixed(4)} >= max_usd $${policy.max_usd.toFixed(4)} in last ${policy.window_ms}ms`,
      trigger: 'usd_max',
    };
  }

  // warn caps
  if (policy.warn_tokens != null && snapshot.total_tokens >= policy.warn_tokens) {
    return {
      verdict: 'warn',
      snapshot,
      policy,
      reason: `tokens ${snapshot.total_tokens} >= warn_tokens ${policy.warn_tokens}`,
      trigger: 'tokens_warn',
    };
  }
  if (policy.warn_usd != null && snapshot.total_cost_usd >= policy.warn_usd) {
    return {
      verdict: 'warn',
      snapshot,
      policy,
      reason: `cost $${snapshot.total_cost_usd.toFixed(4)} >= warn_usd $${policy.warn_usd.toFixed(4)}`,
      trigger: 'usd_warn',
    };
  }

  // compaction trigger -- fires below warn so compaction has time to run
  // before the next call would push us over the warn line.
  if (policy.warn_tokens != null) {
    const compactionFloor = Math.floor(policy.warn_tokens * fraction);
    if (snapshot.total_tokens >= compactionFloor) {
      return {
        verdict: 'compaction_due',
        snapshot,
        policy,
        reason: `tokens ${snapshot.total_tokens} >= compaction floor ${compactionFloor} (${Math.round(fraction * 100)}% of warn_tokens ${policy.warn_tokens})`,
        trigger: 'compaction',
      };
    }
  }

  return { verdict: 'ok', snapshot, policy, reason: '' };
}

// Pre-flight estimate

export interface EstimatedCall {
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_cost_usd: number;
}

/**
 * Decide whether a planned call would push the rolling window past `max_tokens`
 * or `max_usd`. Used by callers that know the prompt size up-front (e.g. the
 * briefing knows section X is ~12k input + 4k output) and want to refuse the
 * call rather than discover the cap mid-execution.
 */
export function wouldExceedBudget(
  records: ReadonlyArray<LedgerRecord>,
  policy: BudgetPolicy,
  estimate: EstimatedCall,
  now: Date = new Date(),
): boolean {
  const snapshot = aggregateWindow(records, policy, now);
  const projTokens = snapshot.total_tokens + estimate.estimated_input_tokens + estimate.estimated_output_tokens;
  const projCost = snapshot.total_cost_usd + estimate.estimated_cost_usd;
  if (policy.max_tokens != null && projTokens > policy.max_tokens) return true;
  if (policy.max_usd != null && projCost > policy.max_usd) return true;
  return false;
}

// File reader

export function readLedger(filePath: string): LedgerRecord[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as LedgerRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is LedgerRecord => r != null);
  } catch {
    return [];
  }
}

// Convenience: governor instance

export interface GovernorOpts {
  ledgerPath?: string;
  policy: BudgetPolicy;
  /** Optional emitter. Called once per evaluation when verdict is non-ok.
   *  Used to bridge to telegram alerts, briefing system-health badges, etc. */
  onVerdict?: (verdict: BudgetVerdict) => void;
}

export class TokenBudgetGovernor {
  private lastVerdict: Verdict | null = null;

  constructor(private readonly opts: GovernorOpts) {}

  /** Evaluate against current ledger state. */
  evaluateNow(now: Date = new Date(), recordsOverride?: ReadonlyArray<LedgerRecord>): BudgetVerdict {
    const records = recordsOverride ?? (this.opts.ledgerPath ? readLedger(this.opts.ledgerPath) : []);
    const verdict = evaluateBudget(records, this.opts.policy, now);
    if (verdict.verdict !== 'ok' && verdict.verdict !== this.lastVerdict) {
      // edge-trigger: only fire when the verdict transitions, not on every poll
      this.lastVerdict = verdict.verdict;
      this.opts.onVerdict?.(verdict);
    } else if (verdict.verdict === 'ok') {
      this.lastVerdict = 'ok';
    }
    return verdict;
  }

  /** Pre-flight check for a planned call. */
  wouldExceedNow(estimate: EstimatedCall, now: Date = new Date(), recordsOverride?: ReadonlyArray<LedgerRecord>): boolean {
    const records = recordsOverride ?? (this.opts.ledgerPath ? readLedger(this.opts.ledgerPath) : []);
    return wouldExceedBudget(records, this.opts.policy, estimate, now);
  }
}

// Pre-built file writer for verdict log

export type VerdictWriter = (record: VerdictRecord) => void;

export interface VerdictRecord {
  timestamp: string;
  verdict: Verdict;
  trigger?: BudgetVerdict['trigger'];
  reason: string;
  total_tokens: number;
  total_cost_usd: number;
  window_ms: number;
}

export function makeVerdictFileWriter(filePath: string): VerdictWriter {
  return (record: VerdictRecord) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
    } catch {
      // best-effort
    }
  };
}

export function verdictToRecord(v: BudgetVerdict): VerdictRecord {
  return {
    timestamp: new Date().toISOString(),
    verdict: v.verdict,
    trigger: v.trigger,
    reason: v.reason,
    total_tokens: v.snapshot.total_tokens,
    total_cost_usd: v.snapshot.total_cost_usd,
    window_ms: v.snapshot.window_ms,
  };
}
