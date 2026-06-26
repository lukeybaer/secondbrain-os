// tool-rules-trace.ts
//
// Observability for tool-rules-solver.ts. The solver enforces by omission:
// it removes disallowed tools from the set offered to the model. Omission
// is silent by nature, which violates the "fail loud, never silent" rule in
// MEMORY.md. This module turns each solve decision into a one-line summary
// and a structured record so a denied tool shows up in the trace ledger
// next to every other tool call, the same way tool-trace.ts and
// tool-cost-ledger.ts record routing.
//
// Without this, a rule that wrongly blocks a tool (e.g. a mis-derived
// requires_approval) would be invisible: the model just never sees the
// tool and no one knows why. With it, every block ExampleCos its rule and
// reason into the observability surface the briefing's health probes read.
//
// Pure formatting + writer injection. No fs, no network. The caller owns
// the writer (a file appender, a logger, the trace middleware), mirroring
// recordRoute() in tool-router.ts.

import type { SolveResult, BlockedTool, ToolRuleType } from './tool-rules-solver';

const RULE_TYPES: ToolRuleType[] = ['init', 'terminal', 'child', 'max_count', 'requires_approval'];

export interface RulesTraceRecord {
  /** Tools allowed through to the model. */
  allowed: string[];
  allowed_count: number;
  blocked_count: number;
  /** Count of blocks per rule type, for at-a-glance health triage. */
  blocked_by_rule: Record<ToolRuleType, number>;
  /** Full block details (tool + rule + reason). */
  blocked: BlockedTool[];
  /** Tools waiting on approval (a subset of blocked). */
  requires_approval: string[];
  /** True when the work unit already hit a terminal tool. */
  terminated: boolean;
  /** One-line human-readable summary. */
  summary: string;
}

/**
 * Tally how many candidates each rule type rejected.
 */
function tallyByRule(blocked: BlockedTool[]): Record<ToolRuleType, number> {
  const counts = {
    init: 0,
    terminal: 0,
    child: 0,
    max_count: 0,
    requires_approval: 0,
  } as Record<ToolRuleType, number>;
  for (const b of blocked) counts[b.rule] += 1;
  return counts;
}

/**
 * Render a one-line summary of a solve decision, e.g.
 *   "tool-rules: 3 allowed, 2 blocked (1 max_count, 1 requires_approval); 1 awaiting approval"
 * or, when the unit is done:
 *   "tool-rules: terminated, 0 of 4 candidates allowed"
 */
export function summarizeRulesDecision(result: SolveResult): string {
  const allowed = result.allowed.length;
  const blocked = result.blocked.length;

  if (result.terminated) {
    return `tool-rules: terminated, 0 of ${blocked} candidates allowed`;
  }

  const counts = tallyByRule(result.blocked);
  const parts = RULE_TYPES.filter((t) => counts[t] > 0).map((t) => `${counts[t]} ${t}`);
  const blockedDetail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  const approvalDetail =
    result.requires_approval.length > 0
      ? `; ${result.requires_approval.length} awaiting approval`
      : '';

  return `tool-rules: ${allowed} allowed, ${blocked} blocked${blockedDetail}${approvalDetail}`;
}

/**
 * Build the structured trace record for a solve decision.
 */
export function buildRulesTrace(result: SolveResult): RulesTraceRecord {
  return {
    allowed: [...result.allowed],
    allowed_count: result.allowed.length,
    blocked_count: result.blocked.length,
    blocked_by_rule: tallyByRule(result.blocked),
    blocked: [...result.blocked],
    requires_approval: [...result.requires_approval],
    terminated: result.terminated,
    summary: summarizeRulesDecision(result),
  };
}

export type RulesTraceWriter = (record: RulesTraceRecord) => void;

/**
 * Build the record and hand it to the injected writer. Returns the record so
 * the caller can also use it inline. Writer errors are swallowed: ExampleCong
 * must never break the decision it is observing.
 */
export function recordRulesDecision(
  result: SolveResult,
  writer: RulesTraceWriter,
): RulesTraceRecord {
  const record = buildRulesTrace(result);
  try {
    writer(record);
  } catch {
    // observability is best-effort; never let a writer failure break routing
  }
  return record;
}
