// reasoning-step-budget.ts
//
// Anti analysis-paralysis guard for reasoning-tools.ts. Letta and Agno both
// cap reasoning steps per agent turn so the model cannot loop on think/analyze
// forever without acting. Without a budget, a model that fails to commit to
// an action will burn tokens and wall-clock against a 5:30 AM briefing window,
// which has actually happened in SecondBrain when the model gets stuck
// debating between two equally-supported plans.
//
// This module is pure data-in/data-out. It looks at recent ReasoningRecord
// rows for a given turn_id and answers two questions:
//   1. How many consecutive reasoning steps has this turn produced?
//   2. Should the next iteration force the model to act?
//
// Default budget: 5 reasoning calls per turn. After that, the caller injects
// a system message ("you have reasoned 5 times this turn, you must now act
// with a non-reasoning tool or respond to the user") and refuses to bind
// think/analyze on the next API call.

import type { ReasoningRecord } from './reasoning-tools';

export interface StepBudgetVerdict {
  // Reasoning calls observed for the turn so far.
  used: number;
  // Configured cap.
  cap: number;
  // True when used >= cap. Callers should stop binding reasoning tools
  // and nudge the model to act.
  exceeded: boolean;
  // True when used >= cap * warn_ratio. Callers can surface a soft hint.
  warn: boolean;
  // Human-readable summary for nudge messages.
  message: string;
}

export interface StepBudgetPolicy {
  // Maximum reasoning calls allowed per turn. Default 5.
  cap?: number;
  // Soft warn threshold as a fraction of cap. Default 0.6, so a cap of 5
  // warns at 3.
  warnRatio?: number;
}

const DEFAULT_CAP = 5;
const DEFAULT_WARN_RATIO = 0.6;

/**
 * Count reasoning records belonging to a turn. Counts BOTH think and analyze
 * because both consume the same model attention budget.
 */
export function countReasoningForTurn(
  records: readonly ReasoningRecord[],
  turn_id: string,
): number {
  if (!turn_id) return 0;
  let n = 0;
  for (const r of records) {
    if (r.turn_id === turn_id) n += 1;
  }
  return n;
}

/**
 * Evaluate the budget verdict for a turn. Pure function: pass in the records
 * (the caller can read from reasoning-tools.readReasoning or supply a slice)
 * and the turn id. Returns the verdict and a message safe to inject as a
 * system reminder to the next API call.
 */
export function evaluateStepBudget(
  records: readonly ReasoningRecord[],
  turn_id: string,
  policy: StepBudgetPolicy = {},
): StepBudgetVerdict {
  const cap = Math.max(1, policy.cap ?? DEFAULT_CAP);
  const warnRatio = clamp01(policy.warnRatio ?? DEFAULT_WARN_RATIO);
  const used = countReasoningForTurn(records, turn_id);
  const warnThreshold = Math.ceil(cap * warnRatio);
  const exceeded = used >= cap;
  const warn = !exceeded && used >= warnThreshold;

  let message: string;
  if (exceeded) {
    message =
      `Reasoning budget exhausted (${used}/${cap}). Stop using think/analyze. ` +
      `Take a concrete action with another tool, or respond to the user with what you already know.`;
  } else if (warn) {
    message =
      `Reasoning budget warning (${used}/${cap}). Prefer acting over additional think/analyze calls.`;
  } else {
    message = `Reasoning budget ok (${used}/${cap}).`;
  }

  return { used, cap, exceeded, warn, message };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_WARN_RATIO;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
