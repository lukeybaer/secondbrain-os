// agent-step-classifier.ts
//
// Deterministic-vs-reasoning step classifier, inspired by CrewAI Flows' split of
// deterministic orchestration (fetch, validate, filter) from autonomous
// reasoning. SecondBrain's step loop (agent-step-loop.ts) currently rounds a
// model turn into the decision for every step, including steps that are pure
// mechanical work: a read-only idempotent tool call whose arguments are already
// known. Those steps do not need the model to "decide" them; running them
// directly saves a model round-trip and a slice of the reasoning step budget.
//
// This module is pure data-in/data-out. It looks at a planned step and answers:
// is this a DETERMINISTIC node the loop can execute without a model turn, or a
// REASONING node that needs the model? It errs toward reasoning: when a step is
// at all ambiguous, ExampleCo, or has side effects, it is classified reasoning so
// the loop keeps the model in the loop. Skipping the model is only ever a
// latency/cost optimization on provably-safe steps, never a correctness risk.
//
// Side-effect and gate vocabulary mirrors tool-router.ts so a step's tool spec
// can be fed straight in.

import type { SideEffectClass } from './tool-router';

export type StepKind = 'deterministic' | 'reasoning';

// What the loop knows about a step before deciding whether to spend a model turn.
export interface PlannedStep {
  // The tool this step would invoke, if any. A step with no tool (a pure
  // think/plan/respond) is always reasoning.
  tool?: string;
  // Side-effect class of the tool, from the tool registry.
  sideEffects?: SideEffectClass;
  // Whether the tool is idempotent (safe to run / re-run with the same args).
  idempotent?: boolean;
  // Approval gate on the tool: 'none' is required for deterministic; any gate
  // forces reasoning because a human-judgment checkpoint is involved.
  approval?: 'none' | 'review' | 'block';
  // Whether this step's arguments are already fully resolved. If the model
  // still needs to fill arguments, it is reasoning regardless of the tool.
  argsResolved?: boolean;
  // An explicit override the planner can set. Honored as-is.
  forceKind?: StepKind;
}

export interface StepClassification {
  kind: StepKind;
  // True only when kind is deterministic. The loop may execute the tool without
  // a model round-trip when this is set.
  skipModelTurn: boolean;
  reason: string;
}

// Tool names that are reasoning by definition: they ARE the model thinking.
// Kept lowercase; matched case-insensitively against the tool name.
const REASONING_TOOLS = new Set(['think', 'analyze', 'plan', 'reflect', 'reason']);

/**
 * Classify a planned step. Pure function. Default verdict is reasoning; a step
 * is only deterministic when every safety condition holds:
 *   - it invokes a tool (not a bare think/respond),
 *   - the tool is not itself a reasoning tool,
 *   - side effects are read-only,
 *   - the tool is idempotent,
 *   - no approval gate is attached,
 *   - arguments are already resolved (not argsResolved === false).
 * forceKind, when present, wins so a planner can pin a step.
 */
export function classifyStep(step: PlannedStep): StepClassification {
  if (step.forceKind) {
    return {
      kind: step.forceKind,
      skipModelTurn: step.forceKind === 'deterministic',
      reason: `forced ${step.forceKind} by planner`,
    };
  }

  const tool = (step.tool ?? '').trim();
  if (!tool) {
    return reasoning('no tool, pure reasoning or response step');
  }

  if (REASONING_TOOLS.has(tool.toLowerCase())) {
    return reasoning(`reasoning tool '${tool}'`);
  }

  if (step.argsResolved === false) {
    return reasoning('arguments not yet resolved, needs the model');
  }

  if (step.sideEffects && step.sideEffects !== 'read') {
    return reasoning(`side effects '${step.sideEffects}', needs judgment`);
  }

  if (step.approval && step.approval !== 'none') {
    return reasoning(`approval gate '${step.approval}', needs judgment`);
  }

  // Read-only but explicitly non-idempotent (e.g. a read that advances a cursor)
  // stays reasoning to be safe.
  if (step.idempotent === false) {
    return reasoning('read tool not marked idempotent');
  }

  // Require positive read-only evidence. An ExampleCo side-effect class is not
  // assumed safe.
  if (step.sideEffects !== 'read') {
    return reasoning('side-effect class ExampleCo, defaulting to reasoning');
  }

  return {
    kind: 'deterministic',
    skipModelTurn: true,
    reason: `read-only idempotent tool '${tool}' with resolved args`,
  };
}

function reasoning(reason: string): StepClassification {
  return { kind: 'reasoning', skipModelTurn: false, reason };
}

/**
 * Convenience aggregate for the loop: given the planned steps for a turn, how
 * many model turns can be skipped. Useful for an observability digest line.
 */
export function countSkippableSteps(steps: readonly PlannedStep[]): number {
  let n = 0;
  for (const s of steps) {
    if (classifyStep(s).skipModelTurn) n += 1;
  }
  return n;
}
