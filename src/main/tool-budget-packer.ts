// tool-budget-packer.ts
//
// Pack the highest-VALUE set of tools that fits a context (token) and dollar
// budget, instead of rank-then-take-a-fixed-topK. This is the step AFTER
// tool-router.ts:
//
//   route()      -> ranks tools best-first by tf-idf-style score
//   packTools()  -> selects the subset that maximizes value within budget
//
// Pattern synthesized from:
//   - Composio Tool Router (Beta, 2026): narrow 10k+ tools to the task-
//     relevant few so the agent context is never flooded with every schema.
//     The central idea is "don't overload context", which is a budget fit,
//     not a fixed slice.
//   - 0/1-knapsack value-density heuristic: fill by score-per-token first,
//     keeping must-include tools regardless of fit.
//
// Why SecondBrain needs this:
//   tool-router slices a hard topK regardless of how large those tool schemas
//   are. As the skill registry grows, blindly binding K tools can blow the
//   Vapi / briefing context budget while a cheaper, still-relevant tool gets
//   cut. Value-per-token packing keeps the most useful tools in context
//   within a real budget and gives every drop an auditable reason.
//
// Pure module: no electron, no network, no fs. Input -> output only.

import type { RouteCandidate, ToolDescriptor } from './tool-router';

// ── Items + budget ────────────────────────────────────────────────────────

export interface PackItem {
  name: string;
  // Value of including this tool (use the route candidate score).
  score: number;
  // Estimated tokens this tool's schema adds to the prompt context.
  tokenCost: number;
  // Optional per-invocation dollar cost (from cost_class). Default 0.
  dollarCost?: number;
  // When true the tool is always kept, even if it overflows the budget.
  mustInclude?: boolean;
}

export interface PackBudget {
  // Hard cap on total tool-schema tokens injected into context.
  tokenBudget: number;
  // Optional cap on summed per-invocation dollar cost of the selected set.
  costBudget?: number;
}

export interface DroppedItem {
  item: PackItem;
  // 'token-budget' | 'cost-budget' | 'zero-or-negative-value'
  reason: string;
}

export interface PackResult {
  selected: PackItem[];
  dropped: DroppedItem[];
  tokensUsed: number;
  tokenBudget: number;
  dollarsUsed: number;
  // tokensUsed / tokenBudget, clamped to [0, 1+]. Can exceed 1 only when
  // must-include tools alone overflow (see overflowFromMustInclude).
  utilization: number;
  // True when the must-include set alone exceeds tokenBudget. The packer
  // still keeps them (correctness over budget) but flags the overflow so the
  // caller can shrink schemas or raise the budget instead of silently
  // shipping an over-budget prompt.
  overflowFromMustInclude: boolean;
}

// ── Cost estimation helpers ────────────────────────────────────────────────

// Rough chars-per-token. English prose averages ~4 chars/token; tool schemas
// are denser (punctuation, keys) so we keep the common 4 and add a fixed
// per-tool framing overhead (name wrapper, braces, role tokens).
const CHARS_PER_TOKEN = 4;
const TOOL_FRAMING_TOKENS = 12;

/**
 * Estimate the token cost of injecting a tool descriptor's schema. Uses the
 * fields that actually reach the model context: name, description, tags.
 */
export function estimateTokenCost(tool: ToolDescriptor): number {
  const text = [tool.name, tool.description, ...(tool.tags ?? [])].join(' ');
  return Math.ceil(text.length / CHARS_PER_TOKEN) + TOOL_FRAMING_TOKENS;
}

// Per-invocation dollar cost by cost_class. 'free' = local, 'cheap' = cached
// API, 'paid' = LLM/web/voice-minute. Order-of-magnitude estimates; the
// caller can override per item via PackItem.dollarCost.
const COST_BY_CLASS: Record<NonNullable<ToolDescriptor['cost_class']>, number> = {
  free: 0,
  cheap: 0.001,
  paid: 0.02,
};

export function estimateDollarCost(tool: ToolDescriptor): number {
  return COST_BY_CLASS[tool.cost_class ?? 'free'];
}

/**
 * Build PackItems from tool-router candidates. `mustInclude` names are kept
 * regardless of budget. Token/dollar costs are estimated from each
 * descriptor unless the descriptor is missing.
 */
export function itemsFromCandidates(
  candidates: ReadonlyArray<RouteCandidate>,
  opts: { mustInclude?: ReadonlyArray<string> } = {},
): PackItem[] {
  const must = new Set(opts.mustInclude ?? []);
  return candidates.map((c) => ({
    name: c.tool.name,
    score: c.score,
    tokenCost: estimateTokenCost(c.tool),
    dollarCost: estimateDollarCost(c.tool),
    mustInclude: must.has(c.tool.name),
  }));
}

// ── Packer ────────────────────────────────────────────────────────────────

function valueDensity(item: PackItem): number {
  // Guard against zero/negative token cost so density stays finite and a
  // free-but-relevant tool sorts to the front.
  const cost = item.tokenCost > 0 ? item.tokenCost : 1;
  return item.score / cost;
}

/**
 * Greedily pack the highest value-per-token tools that fit the budget.
 *
 * Order of operations:
 *   1. Must-include tools are taken first, unconditionally. If they alone
 *      exceed tokenBudget, overflowFromMustInclude is set true.
 *   2. Remaining tools are sorted by value density (score / tokenCost) desc
 *      and added while they fit BOTH the token and (optional) dollar budget.
 *   3. Items with score <= 0 are dropped as 'zero-or-negative-value' (a tool
 *      that matched nothing is noise in context).
 *   4. An item that does not fit is dropped with the binding-budget reason;
 *      the scan continues so a smaller later item can still slot in.
 */
export function packTools(items: ReadonlyArray<PackItem>, budget: PackBudget): PackResult {
  const dollarBudget = budget.costBudget ?? Infinity;
  const selected: PackItem[] = [];
  const dropped: DroppedItem[] = [];
  let tokensUsed = 0;
  let dollarsUsed = 0;

  // 1. Must-include first, unconditionally.
  const mustItems = items.filter((i) => i.mustInclude);
  for (const item of mustItems) {
    selected.push(item);
    tokensUsed += item.tokenCost;
    dollarsUsed += item.dollarCost ?? 0;
  }
  const overflowFromMustInclude = tokensUsed > budget.tokenBudget;

  // 2. Everything else, by value density desc. Stable on ties via index.
  const rest = items
    .map((item, idx) => ({ item, idx }))
    .filter((e) => !e.item.mustInclude)
    .sort((a, b) => valueDensity(b.item) - valueDensity(a.item) || a.idx - b.idx)
    .map((e) => e.item);

  for (const item of rest) {
    if (item.score <= 0) {
      dropped.push({ item, reason: 'zero-or-negative-value' });
      continue;
    }
    const dollar = item.dollarCost ?? 0;
    if (tokensUsed + item.tokenCost > budget.tokenBudget) {
      dropped.push({ item, reason: 'token-budget' });
      continue;
    }
    if (dollarsUsed + dollar > dollarBudget) {
      dropped.push({ item, reason: 'cost-budget' });
      continue;
    }
    selected.push(item);
    tokensUsed += item.tokenCost;
    dollarsUsed += dollar;
  }

  return {
    selected,
    dropped,
    tokensUsed,
    tokenBudget: budget.tokenBudget,
    dollarsUsed,
    utilization: budget.tokenBudget > 0 ? tokensUsed / budget.tokenBudget : 0,
    overflowFromMustInclude,
  };
}
