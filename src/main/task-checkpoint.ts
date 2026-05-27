// task-checkpoint.ts
//
// Per-step task planning with durable checkpointing and stuck detection.
//
// Patterns synthesized from:
//   - CrewAI Flows @persist decorator (v1.14.0) -- auto-save at key execution points,
//     checkpoint-fork per execution with lineage tracking
//   - Agno workflow paused_step_index -- StepErrorEvent freezes at exact step,
//     continue_run() resumes from paused index after human decision
//   - OpenHands StuckDetector -- 5 failure pattern checks on event history window,
//     two recovery modes: soft (preserve-N-events) vs hard (full restart)
//   - Julep step schema -- label: string for cross-step reference, wait_for_input
//     step type for human-in-the-loop gates
//
// Usage: Amy's multi-step tasks (dentist calls, health-self-heal, video pipeline,
// nightly enhancement) write checkpoints at each step boundary. health-self-heal.js
// reads the last checkpoint on restart to resume without re-running completed steps.
//
// Output: data/agent/task-checkpoints.jsonl

import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'paused';
export type PlanStatus = 'running' | 'completed' | 'failed' | 'paused';
export type RecoveryMode = 'soft' | 'hard' | 'skip';

// From OpenHands StuckDetector: 5 failure patterns
export type StuckPattern =
  | 'identical_actions'    // consecutive identical actions
  | 'syntax_error_loop'    // repeated syntax-error-then-retry cycle
  | 'extended_monologue'   // >20 consecutive agent messages with no tool calls
  | 'repeated_cycles'      // same observation follows same action N times
  | 'context_overflow';    // context window errors triggering condensation loops

export interface TaskStep {
  label: string;
  type: string;                // 'tool_call' | 'llm' | 'wait_for_input' | 'foreach' | 'map'
  input?: Record<string, unknown>;
  status: StepStatus;
  started_at?: string;         // ISO timestamp
  completed_at?: string;
  resumed_at?: string;
  error?: string;
  output_summary?: string;
  retries?: number;
  max_retries?: number;        // default 3 (Agno step-level max_retries)
}

export interface StuckDetection {
  pattern: StuckPattern;
  count: number;               // consecutive occurrences
  recovery_mode: RecoveryMode;
  detected_at: string;
}

export interface TaskPlan {
  task_id: string;
  task: string;
  goal: string;
  created_at: string;
  updated_at: string;
  status: PlanStatus;
  paused_step_index?: number;  // Agno: exact step where failure occurred
  stuck_detection?: StuckDetection;
  steps: TaskStep[];
}

// ── Factory ───────────────────────────────────────────────────────────────────

/** Create a new TaskPlan in 'running' state. Steps start as 'pending'. */
export function createTaskPlan(
  task: string,
  goal: string,
  stepDefs: Array<{ label: string; type: string; input?: Record<string, unknown>; max_retries?: number }>,
): TaskPlan {
  const now = new Date().toISOString();
  return {
    task_id: `${task.replace(/\W+/g, '-')}-${Date.now()}`,
    task,
    goal,
    created_at: now,
    updated_at: now,
    status: 'running',
    steps: stepDefs.map((s) => ({
      label: s.label,
      type: s.type,
      input: s.input,
      status: 'pending',
      max_retries: s.max_retries ?? 3,
      retries: 0,
    })),
  };
}

// ── Step mutation ─────────────────────────────────────────────────────────────

/** Mark a step as running and record start time. */
export function startStep(plan: TaskPlan, label: string): TaskPlan {
  const now = new Date().toISOString();
  const steps = plan.steps.map((s) =>
    s.label === label ? { ...s, status: 'running' as StepStatus, started_at: now } : s,
  );
  return { ...plan, steps, updated_at: now };
}

/** Mark a step as completed with optional output summary. */
export function completeStep(plan: TaskPlan, label: string, outputSummary?: string): TaskPlan {
  const now = new Date().toISOString();
  const steps = plan.steps.map((s) =>
    s.label === label
      ? {
          ...s,
          status: 'completed' as StepStatus,
          completed_at: now,
          output_summary: outputSummary,
          error: undefined,
        }
      : s,
  );

  // If all steps completed, mark the plan done
  const allDone = steps.every((s) => s.status === 'completed' || s.status === 'skipped');
  return {
    ...plan,
    steps,
    updated_at: now,
    status: allDone ? 'completed' : 'running',
  };
}

/** Mark a step as failed. Increments retry counter, pauses plan if max_retries exceeded. */
export function failStep(plan: TaskPlan, label: string, error: string): TaskPlan {
  const now = new Date().toISOString();
  const stepIndex = plan.steps.findIndex((s) => s.label === label);
  if (stepIndex < 0) return { ...plan, updated_at: now };

  const step = plan.steps[stepIndex];
  const retries = (step.retries ?? 0) + 1;
  const maxRetries = step.max_retries ?? 3;
  const exhausted = retries >= maxRetries;

  const updatedStep: TaskStep = {
    ...step,
    status: exhausted ? 'failed' : 'pending', // reset to pending for retry if not exhausted
    error,
    retries,
    completed_at: exhausted ? now : undefined,
  };

  const steps = plan.steps.map((s, i) => (i === stepIndex ? updatedStep : s));
  const paused_step_index = exhausted ? stepIndex : plan.paused_step_index;
  const planStatus: PlanStatus = exhausted ? 'paused' : 'running';

  return {
    ...plan,
    steps,
    updated_at: now,
    status: planStatus,
    ...(exhausted ? { paused_step_index } : {}),
  };
}

/** Mark a step as skipped (for skip_on_failure scenarios). */
export function skipStep(plan: TaskPlan, label: string, reason?: string): TaskPlan {
  const now = new Date().toISOString();
  const steps = plan.steps.map((s) =>
    s.label === label
      ? { ...s, status: 'skipped' as StepStatus, error: reason, completed_at: now }
      : s,
  );
  return { ...plan, steps, updated_at: now };
}

// ── Resume ────────────────────────────────────────────────────────────────────

/**
 * Prepare a plan for resumption after a pause. Resets failed steps to pending
 * starting from paused_step_index. Sets resumed_at on the first step to retry.
 */
export function resumeFromPaused(
  plan: TaskPlan,
  decision: 'retry' | 'skip',
): TaskPlan {
  if (plan.status !== 'paused' || plan.paused_step_index === undefined) return plan;

  const now = new Date().toISOString();
  const idx = plan.paused_step_index;

  const steps = plan.steps.map((s, i) => {
    if (i !== idx) return s;
    if (decision === 'skip') {
      return { ...s, status: 'skipped' as StepStatus, error: 'manual skip on resume', completed_at: now };
    }
    return {
      ...s,
      status: 'pending' as StepStatus,
      resumed_at: now,
      retries: 0,
      error: undefined,
    };
  });

  return {
    ...plan,
    steps,
    updated_at: now,
    status: 'running',
    paused_step_index: undefined,
    stuck_detection: undefined,
  };
}

// ── Stuck detection ───────────────────────────────────────────────────────────

/**
 * Examine recent checkpoints for a task and detect stuck patterns.
 * Returns a StuckDetection if a pattern threshold is exceeded, else null.
 *
 * Implements OpenHands StuckDetector patterns 1 (identical_actions) and 4
 * (repeated_cycles) as the most relevant to SecondBrain's task execution model.
 */
export function detectStuckPattern(
  plans: TaskPlan[],
  consecutiveThreshold = 3,
): StuckDetection | null {
  if (plans.length < consecutiveThreshold) return null;

  const recent = plans.slice(-consecutiveThreshold);

  // Pattern 1: identical_actions — all recent plans paused at same step with same error
  const pausedIndices = recent
    .filter((p) => p.status === 'paused' && p.paused_step_index !== undefined)
    .map((p) => p.paused_step_index);

  if (pausedIndices.length === consecutiveThreshold) {
    const sameIndex = pausedIndices.every((i) => i === pausedIndices[0]);
    if (sameIndex) {
      const errors = recent.map((p) => {
        const s = p.steps[p.paused_step_index!];
        return s?.error ?? '';
      });
      const sameError = errors.every((e) => e === errors[0]);
      return {
        pattern: sameError ? 'identical_actions' : 'repeated_cycles',
        count: consecutiveThreshold,
        recovery_mode: sameError ? 'hard' : 'soft',
        detected_at: new Date().toISOString(),
      };
    }
  }

  // Pattern 2: repeated_cycles — alternating fail/retry on same step N times
  const allSameTask = recent.every((p) => p.task === recent[0].task);
  if (allSameTask) {
    const totalRetries = recent.reduce((sum, p) => {
      return sum + p.steps.reduce((s, step) => s + (step.retries ?? 0), 0);
    }, 0);
    if (totalRetries >= consecutiveThreshold * 3) {
      return {
        pattern: 'repeated_cycles',
        count: totalRetries,
        recovery_mode: 'soft',
        detected_at: new Date().toISOString(),
      };
    }
  }

  return null;
}

// ── Persistence ───────────────────────────────────────────────────────────────

/** Append a TaskPlan snapshot to the checkpoint log. */
export function appendCheckpoint(logPath: string, plan: TaskPlan): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(plan) + '\n', 'utf8');
}

/** Load all checkpoints from the log. Returns [] if file missing. */
export function loadCheckpoints(logPath: string): TaskPlan[] {
  if (!fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim());
  const plans: TaskPlan[] = [];
  for (const line of lines) {
    try {
      plans.push(JSON.parse(line) as TaskPlan);
    } catch {
      /* skip malformed */
    }
  }
  return plans;
}

/**
 * Load the most recent checkpoint for a specific task name.
 * Used by health-self-heal.js to resume without re-running completed steps.
 */
export function loadLastCheckpoint(logPath: string, task: string): TaskPlan | null {
  const all = loadCheckpoints(logPath);
  const matching = all.filter((p) => p.task === task);
  return matching.length > 0 ? matching[matching.length - 1] : null;
}

/**
 * Get the index of the first step that is not yet completed or skipped.
 * Returns -1 if all steps are done. Used for resume-from-checkpoint.
 */
export function nextPendingStepIndex(plan: TaskPlan): number {
  return plan.steps.findIndex((s) => s.status === 'pending' || s.status === 'running');
}
