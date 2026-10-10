// tool-rules-solver.ts
//
// Declarative tool-sequencing constraint solver for Amy's agent step loop.
//
// Pattern source: letta-ai/letta ToolRulesSolver (docs.letta.com/guides/
// agents/tool-rules, 2026-06). Letta lets an agent author declare rules
// that constrain which tool may be called NEXT given what has been called
// so far, then filters the tool list offered to the model at each step
// into a constraint graph. This is the mechanical-enforcement layer
// SecondBrain keeps reaching for via hooks and CLAUDE.md prose:
//
//   - "raw archive BEFORE processing"  -> InitToolRule on the archive tool
//   - "dispatch must end in a receipt"  -> ChildToolRule (send -> receipt)
//   - "never redial"                    -> MaxCountToolRule (dial, max 1)
//   - "send requires approval"          -> RequiresApprovalToolRule
//   - "a receipt write ends the unit"   -> TerminalToolRule
//
// Letta's full taxonomy needs a structured-output model to enforce the
// branching rules. We do the model-agnostic thing: given the call history
// and the candidate tool set for the next step, return the ALLOWED subset
// plus a blocked list with the rule that rejected each candidate. The
// caller (agent-step-loop.ts, the Vapi prompt assembler, the tool-router)
// offers only the allowed subset to the model. Enforcement by omission,
// the same shape as the test > hook > npm-script enforcement hierarchy in
// MEMORY.md.
//
// Pure module: no fs, no electron, no network, no clock. Deterministic so
// the nightly run and tests need no infra. Mirrors the writer-free purity
// of memory-multi-signal-fuse.ts and tool-router.ts scoring.

// ── Rule taxonomy ─────────────────────────────────────────────────────────

/**
 * A declarative constraint on the tool sequence. Each variant maps to one
 * Letta rule type, trimmed to the kinds SecondBrain's locked rules need.
 */
export type ToolRule =
  // The named tool must be the FIRST tool called. Until one of the declared
  // init tools has run, only init tools are allowed. ("raw archive first")
  | { type: 'init'; tool: string }
  // Once the named tool has been called, no further tools may run; the unit
  // of work is terminal. ("a receipt write ends the dispatch")
  | { type: 'terminal'; tool: string }
  // Immediately after `parent` runs, the next tool must be one of
  // `children`. Multiple child rules for the same parent union their
  // children. ("a send must be followed by a receipt")
  | { type: 'child'; parent: string; children: ReadonlyArray<string> }
  // The named tool may be called at most `max` times across the run.
  // ("never redial" = max 1 on the dial tool)
  | { type: 'max_count'; tool: string; max: number }
  // The named tool may not run until it appears in the caller's approvals
  // list. ("send requires ExampleCo's sign-off")
  | { type: 'requires_approval'; tool: string };

export type ToolRuleType = ToolRule['type'];

// ── Solve I/O ───────────────────────────────────────────────────────────

export interface SolveInput {
  /** The active rule set. */
  rules: ReadonlyArray<ToolRule>;
  /** Executed tool calls in order, oldest first. Only the `tool` name matters. */
  history: ReadonlyArray<{ tool: string }>;
  /** Candidate tool names the model could call at the next step. */
  available: ReadonlyArray<string>;
  /**
   * Tools that have been approved for this run. A requires_approval rule
   * passes once its tool is listed here. Defaults to none.
   */
  approvals?: ReadonlyArray<string>;
}

export interface BlockedTool {
  tool: string;
  /** Which rule type rejected the candidate. */
  rule: ToolRuleType;
  /** Human-readable reason, suitable for a trace line or a denial message. */
  reason: string;
}

export interface SolveResult {
  /** Tool names the model is allowed to call next, preserving input order. */
  allowed: string[];
  /** Candidates removed from `available`, each with the rule that rejected it. */
  blocked: BlockedTool[];
  /**
   * Subset of `available` gated by a requires_approval rule whose tool is
   * not yet approved. These also appear in `blocked`; surfaced separately so
   * a caller can route them to the approval inbox instead of dropping them.
   */
  requires_approval: string[];
  /**
   * True when a terminal tool already ran. When terminal, `allowed` is empty
   * and every candidate is blocked.
   */
  terminated: boolean;
}

// ── Solver ───────────────────────────────────────────────────────────────

/**
 * Filter `available` to the tools allowed at the next step under `rules`,
 * given the calls already made in `history`.
 *
 * Evaluation order per candidate (first failing rule wins the block reason):
 *   1. terminal   (global short-circuit: a terminal tool ran -> nothing allowed)
 *   2. init       (history empty and init rules exist -> only init tools)
 *   3. child      (last call has child rules -> only its children)
 *   4. max_count  (candidate already at its cap)
 *   5. requires_approval (candidate not yet approved)
 *
 * A candidate is allowed only if it survives every applicable rule.
 */
export function solveToolRules(input: SolveInput): SolveResult {
  const { rules, history, available } = input;
  const approvals = new Set(input.approvals ?? []);

  const blocked: BlockedTool[] = [];
  const requiresApproval: string[] = [];

  // 1. Terminal short-circuit. If any executed tool is a terminal tool, the
  // unit of work is done and nothing else may run.
  const terminalTools = new Set(
    rules.filter((r) => r.type === 'terminal').map((r) => (r as { tool: string }).tool),
  );
  const firedTerminal = history.find((h) => terminalTools.has(h.tool));
  if (firedTerminal) {
    for (const tool of available) {
      blocked.push({
        tool,
        rule: 'terminal',
        reason: `terminal: '${firedTerminal.tool}' already ran; the unit of work is complete`,
      });
    }
    return { allowed: [], blocked, requires_approval: [], terminated: true };
  }

  // Pre-compute rule lookups.
  const initTools = new Set(
    rules.filter((r) => r.type === 'init').map((r) => (r as { tool: string }).tool),
  );

  // Child rules keyed by parent -> union of allowed children.
  const childrenByParent = new Map<string, Set<string>>();
  for (const r of rules) {
    if (r.type !== 'child') continue;
    const set = childrenByParent.get(r.parent) ?? new Set<string>();
    for (const c of r.children) set.add(c);
    childrenByParent.set(r.parent, set);
  }

  // Max-count caps keyed by tool (tightest cap wins if duplicated).
  const maxByTool = new Map<string, number>();
  for (const r of rules) {
    if (r.type !== 'max_count') continue;
    const prev = maxByTool.get(r.tool);
    maxByTool.set(r.tool, prev === undefined ? r.max : Math.min(prev, r.max));
  }

  // History call counts for max_count enforcement.
  const callCounts = new Map<string, number>();
  for (const h of history) {
    callCounts.set(h.tool, (callCounts.get(h.tool) ?? 0) + 1);
  }

  const approvalTools = new Set(
    rules.filter((r) => r.type === 'requires_approval').map((r) => (r as { tool: string }).tool),
  );

  // Active child constraint: only when the most recent call is a parent.
  const lastTool = history.length > 0 ? history[history.length - 1].tool : undefined;
  const activeChildren = lastTool !== undefined ? childrenByParent.get(lastTool) : undefined;

  const initPhase = history.length === 0 && initTools.size > 0;

  const allowed: string[] = [];

  for (const tool of available) {
    // 2. Init phase: before the first call, only init tools may run.
    if (initPhase && !initTools.has(tool)) {
      const required = Array.from(initTools).sort().join(', ');
      blocked.push({
        tool,
        rule: 'init',
        reason: `init: must call an init tool first (${required})`,
      });
      continue;
    }

    // 3. Child constraint from the last call.
    if (activeChildren && !activeChildren.has(tool)) {
      const allowedKids = Array.from(activeChildren).sort().join(', ');
      blocked.push({
        tool,
        rule: 'child',
        reason: `child: after '${lastTool}', next tool must be one of [${allowedKids}]`,
      });
      continue;
    }

    // 4. Max-count cap.
    const cap = maxByTool.get(tool);
    if (cap !== undefined && (callCounts.get(tool) ?? 0) >= cap) {
      blocked.push({
        tool,
        rule: 'max_count',
        reason: `max_count: '${tool}' already called ${callCounts.get(tool)} time(s), cap ${cap}`,
      });
      continue;
    }

    // 5. Requires approval.
    if (approvalTools.has(tool) && !approvals.has(tool)) {
      requiresApproval.push(tool);
      blocked.push({
        tool,
        rule: 'requires_approval',
        reason: `requires_approval: '${tool}' needs sign-off before it can run`,
      });
      continue;
    }

    allowed.push(tool);
  }

  return { allowed, blocked, requires_approval: requiresApproval, terminated: false };
}

/**
 * Convenience: just the allowed tool names for the next step.
 */
export function nextAllowedTools(input: SolveInput): string[] {
  return solveToolRules(input).allowed;
}
