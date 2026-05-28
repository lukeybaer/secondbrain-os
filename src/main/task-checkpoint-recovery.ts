// task-checkpoint-recovery.ts
//
// Auto-recovery executor for stuck task plans.
//
// task-checkpoint.ts detects stuck patterns (OpenHands StuckDetector
// implementation) and emits a typed StuckDetection record. Until now those
// detections were observational only: no executor consumed them. This module
// closes the loop by turning a StuckDetection into a mutated TaskPlan that
// the runtime can keep executing instead of paging Luke.
//
// Patterns synthesized from:
//   - OpenHands StuckDetector (All-Hands-AI/OpenHands 2026 source): three
//     recovery modes mapped to detection patterns. Soft preserves prior work
//     and skips the stuck step; hard wipes state and retries from step 0;
//     skip fails fast and lets a higher layer decide.
//   - LangGraph supervisor pattern (langchain-ai/langgraph 1.0): a
//     supervisor checks the worker's state at each checkpoint and either
//     loops, replans, or hands off. Our recovery executor plays the
//     "replan" role: it returns a new plan-shaped record so the same
//     runtime loop keeps consuming.
//   - Letta v1 agent loop "self-heal" pattern (letta.com/blog/letta-v1-agent):
//     a stuck agent flushes its working memory and retries with a fresh
//     context; analogous to hard mode here.
//
// Recovery semantics:
//   - soft  -> mark stuck step 'skipped', reset retry counters on subsequent
//              steps, advance status to 'running', clear stuck_detection.
//              Use when the step is non-load-bearing or has a downstream
//              fallback. Preserves completed steps.
//   - hard  -> reset every non-completed step to 'pending', clear retries,
//              clear stuck_detection, status -> 'running'. Preserves
//              completed steps. Use when the failure is environmental
//              (network blip, race) and the work is idempotent.
//   - skip  -> mark stuck step + all subsequent pending steps as 'skipped',
//              status -> 'failed' with explicit reason. Use when the step
//              is load-bearing and a retry has no chance of succeeding.
//
// Pure module: no fs, no electron, no network. The caller persists the
// returned plan via appendCheckpoint() from task-checkpoint.ts.

import {
  TaskPlan,
  TaskStep,
  StepStatus,
  PlanStatus,
  StuckDetection,
  RecoveryMode,
} from './task-checkpoint';

// ── Types ────────────────────────────────────────────────────────────────────

/** Result of a recovery attempt. Carries the new plan plus telemetry. */
export interface RecoveryResult {
  plan: TaskPlan;
  recovery_mode: RecoveryMode;
  steps_affected: string[];   // labels of steps mutated by recovery
  reason: string;             // human-readable rationale, logged in briefing
  ran_at: string;
  attempt: number;             // 1-indexed; carried on plan.recovery_attempts
}

// Extension marker. recovery_attempts lives on the JSON record without
// requiring a TaskPlan type change, because TaskPlan is structural.
type PlanWithRecovery = TaskPlan & { recovery_attempts?: number };

// ── Helpers ──────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function isTerminalStep(status: StepStatus): boolean {
  return status === 'completed' || status === 'skipped';
}

function pausedStepLabel(plan: TaskPlan): string | null {
  const idx = plan.paused_step_index;
  if (idx === undefined || idx < 0 || idx >= plan.steps.length) return null;
  return plan.steps[idx].label;
}

// ── Recovery executors ──────────────────────────────────────────────────────

function applySoft(plan: TaskPlan, detection: StuckDetection, now: string): RecoveryResult {
  const stuckIdx = plan.paused_step_index ?? -1;
  const affected: string[] = [];
  const steps: TaskStep[] = plan.steps.map((s, i) => {
    if (i === stuckIdx) {
      affected.push(s.label);
      return {
        ...s,
        status: 'skipped' as StepStatus,
        error: `soft recovery: pattern=${detection.pattern}`,
        completed_at: now,
      };
    }
    if (i > stuckIdx && !isTerminalStep(s.status)) {
      // reset retries on downstream pending/failed steps so they get a clean shot
      if ((s.retries ?? 0) > 0 || s.status === 'failed') {
        affected.push(s.label);
        return {
          ...s,
          status: 'pending' as StepStatus,
          retries: 0,
          error: undefined,
          resumed_at: now,
        };
      }
    }
    return s;
  });

  const prior = (plan as PlanWithRecovery).recovery_attempts ?? 0;
  const newPlan: PlanWithRecovery = {
    ...plan,
    steps,
    status: 'running' as PlanStatus,
    paused_step_index: undefined,
    stuck_detection: undefined,
    updated_at: now,
    recovery_attempts: prior + 1,
  };

  return {
    plan: newPlan,
    recovery_mode: 'soft',
    steps_affected: affected,
    reason: `soft recovery: skip stuck step "${pausedStepLabel(plan) ?? '?'}" (pattern=${detection.pattern}), reset downstream pending steps`,
    ran_at: now,
    attempt: prior + 1,
  };
}

function applyHard(plan: TaskPlan, detection: StuckDetection, now: string): RecoveryResult {
  const affected: string[] = [];
  const steps: TaskStep[] = plan.steps.map((s) => {
    if (isTerminalStep(s.status)) return s;
    affected.push(s.label);
    return {
      ...s,
      status: 'pending' as StepStatus,
      retries: 0,
      error: undefined,
      resumed_at: now,
    };
  });

  const prior = (plan as PlanWithRecovery).recovery_attempts ?? 0;
  const newPlan: PlanWithRecovery = {
    ...plan,
    steps,
    status: 'running' as PlanStatus,
    paused_step_index: undefined,
    stuck_detection: undefined,
    updated_at: now,
    recovery_attempts: prior + 1,
  };

  return {
    plan: newPlan,
    recovery_mode: 'hard',
    steps_affected: affected,
    reason: `hard recovery: reset all non-terminal steps to pending (pattern=${detection.pattern}, prior_attempts=${prior})`,
    ran_at: now,
    attempt: prior + 1,
  };
}

function applySkip(plan: TaskPlan, detection: StuckDetection, now: string): RecoveryResult {
  const stuckIdx = plan.paused_step_index ?? -1;
  const affected: string[] = [];
  const steps: TaskStep[] = plan.steps.map((s, i) => {
    if (i >= stuckIdx && !isTerminalStep(s.status)) {
      affected.push(s.label);
      return {
        ...s,
        status: 'skipped' as StepStatus,
        error: `skip recovery: exhausted at step ${stuckIdx} (pattern=${detection.pattern})`,
        completed_at: now,
      };
    }
    return s;
  });

  const prior = (plan as PlanWithRecovery).recovery_attempts ?? 0;
  const newPlan: PlanWithRecovery = {
    ...plan,
    steps,
    status: 'failed' as PlanStatus,
    stuck_detection: undefined,
    updated_at: now,
    recovery_attempts: prior + 1,
  };

  return {
    plan: newPlan,
    recovery_mode: 'skip',
    steps_affected: affected,
    reason: `skip recovery: marked stuck step + downstream as skipped, plan failed (pattern=${detection.pattern})`,
    ran_at: now,
    attempt: prior + 1,
  };
}

/**
 * Execute a recovery on a stuck plan.
 *
 * @param plan plan in 'paused' status with paused_step_index set
 * @param detection the StuckDetection produced by detectStuckPattern()
 * @param overrideMode optional override; defaults to detection.recovery_mode
 * @returns a RecoveryResult with the mutated plan and telemetry
 */
export function executeStuckRecovery(
  plan: TaskPlan,
  detection: StuckDetection,
  overrideMode?: RecoveryMode,
): RecoveryResult {
  if (plan.status !== 'paused') {
    throw new Error(`executeStuckRecovery requires plan.status='paused', got '${plan.status}'`);
  }
  const mode: RecoveryMode = overrideMode ?? detection.recovery_mode;
  const now = nowIso();
  switch (mode) {
    case 'soft':
      return applySoft(plan, detection, now);
    case 'hard':
      return applyHard(plan, detection, now);
    case 'skip':
      return applySkip(plan, detection, now);
    default:
      throw new Error(`unknown recovery mode: ${mode}`);
  }
}

// ── Convenience ──────────────────────────────────────────────────────────────

/**
 * Cap on recovery attempts before escalation. After this many auto-recoveries
 * the runtime should hand off to a human (Telegram alert, briefing card)
 * instead of looping forever.
 */
export const MAX_AUTO_RECOVERY_ATTEMPTS = 3;

/**
 * Tell the caller whether the plan has exhausted its auto-recovery budget.
 * Returns true when no further executeStuckRecovery call should be made
 * without human approval.
 */
export function recoveryBudgetExhausted(plan: TaskPlan, limit = MAX_AUTO_RECOVERY_ATTEMPTS): boolean {
  const attempts = (plan as PlanWithRecovery).recovery_attempts ?? 0;
  return attempts >= limit;
}

/**
 * Get the recovery_attempts field off a plan record. Safe to call on a
 * plan that has never been recovered (returns 0).
 */
export function getRecoveryAttempts(plan: TaskPlan): number {
  return (plan as PlanWithRecovery).recovery_attempts ?? 0;
}
