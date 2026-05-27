import { describe, it, expect } from 'vitest';
import {
  createTaskPlan,
  failStep,
  completeStep,
  StuckDetection,
  TaskPlan,
} from '../task-checkpoint';
import {
  executeStuckRecovery,
  recoveryBudgetExhausted,
  getRecoveryAttempts,
  MAX_AUTO_RECOVERY_ATTEMPTS,
} from '../task-checkpoint-recovery';

function buildPausedPlan(): TaskPlan {
  // 4 steps: complete the first, fail the second three times to push it to paused
  let plan = createTaskPlan('test-task', 'verify recovery', [
    { label: 'a', type: 'tool_call', max_retries: 1 },
    { label: 'b', type: 'tool_call', max_retries: 3 },
    { label: 'c', type: 'tool_call' },
    { label: 'd', type: 'tool_call' },
  ]);
  plan = completeStep(plan, 'a', 'a output');
  // fail b enough times to exhaust retries (max_retries=3, so 3 failures pauses)
  plan = failStep(plan, 'b', 'boom');
  plan = failStep(plan, 'b', 'boom');
  plan = failStep(plan, 'b', 'boom');
  expect(plan.status).toBe('paused');
  expect(plan.paused_step_index).toBe(1);
  return plan;
}

const SOFT_DETECTION: StuckDetection = {
  pattern: 'repeated_cycles',
  count: 3,
  recovery_mode: 'soft',
  detected_at: '2026-05-12T00:00:00Z',
};

const HARD_DETECTION: StuckDetection = {
  pattern: 'identical_actions',
  count: 3,
  recovery_mode: 'hard',
  detected_at: '2026-05-12T00:00:00Z',
};

const SKIP_DETECTION: StuckDetection = {
  pattern: 'context_overflow',
  count: 5,
  recovery_mode: 'skip',
  detected_at: '2026-05-12T00:00:00Z',
};

describe('executeStuckRecovery soft mode', () => {
  it('marks stuck step as skipped and resumes plan', () => {
    const plan = buildPausedPlan();
    const result = executeStuckRecovery(plan, SOFT_DETECTION);
    expect(result.recovery_mode).toBe('soft');
    expect(result.plan.status).toBe('running');
    expect(result.plan.paused_step_index).toBeUndefined();
    expect(result.plan.steps[1].status).toBe('skipped');
    expect(result.plan.steps[1].error).toContain('soft recovery');
  });

  it('preserves completed steps', () => {
    const plan = buildPausedPlan();
    const result = executeStuckRecovery(plan, SOFT_DETECTION);
    expect(result.plan.steps[0].status).toBe('completed');
    expect(result.plan.steps[0].output_summary).toBe('a output');
  });

  it('resets downstream pending steps with stale retries', () => {
    let plan = buildPausedPlan();
    // simulate that step c had a prior retry
    plan = { ...plan, steps: plan.steps.map((s, i) => (i === 2 ? { ...s, retries: 2 } : s)) };
    const result = executeStuckRecovery(plan, SOFT_DETECTION);
    expect(result.plan.steps[2].retries).toBe(0);
  });

  it('increments recovery_attempts', () => {
    const plan = buildPausedPlan();
    expect(getRecoveryAttempts(plan)).toBe(0);
    const result = executeStuckRecovery(plan, SOFT_DETECTION);
    expect(getRecoveryAttempts(result.plan)).toBe(1);
    expect(result.attempt).toBe(1);
  });

  it('clears stuck_detection on the recovered plan', () => {
    const plan = { ...buildPausedPlan(), stuck_detection: SOFT_DETECTION };
    const result = executeStuckRecovery(plan, SOFT_DETECTION);
    expect(result.plan.stuck_detection).toBeUndefined();
  });

  it('lists steps_affected for telemetry', () => {
    const plan = buildPausedPlan();
    const result = executeStuckRecovery(plan, SOFT_DETECTION);
    expect(result.steps_affected).toContain('b');
  });
});

describe('executeStuckRecovery hard mode', () => {
  it('resets all non-terminal steps to pending', () => {
    const plan = buildPausedPlan();
    const result = executeStuckRecovery(plan, HARD_DETECTION);
    expect(result.recovery_mode).toBe('hard');
    expect(result.plan.status).toBe('running');
    expect(result.plan.steps[0].status).toBe('completed'); // preserved
    expect(result.plan.steps[1].status).toBe('pending');
    expect(result.plan.steps[2].status).toBe('pending');
    expect(result.plan.steps[3].status).toBe('pending');
  });

  it('clears retries on all reset steps', () => {
    const plan = buildPausedPlan();
    const result = executeStuckRecovery(plan, HARD_DETECTION);
    expect(result.plan.steps[1].retries).toBe(0);
    expect(result.plan.steps[1].error).toBeUndefined();
  });

  it('lists every reset step as affected', () => {
    const plan = buildPausedPlan();
    const result = executeStuckRecovery(plan, HARD_DETECTION);
    expect(result.steps_affected).toEqual(['b', 'c', 'd']);
  });
});

describe('executeStuckRecovery skip mode', () => {
  it('marks stuck step and downstream as skipped, sets plan failed', () => {
    const plan = buildPausedPlan();
    const result = executeStuckRecovery(plan, SKIP_DETECTION);
    expect(result.recovery_mode).toBe('skip');
    expect(result.plan.status).toBe('failed');
    expect(result.plan.steps[0].status).toBe('completed');
    expect(result.plan.steps[1].status).toBe('skipped');
    expect(result.plan.steps[2].status).toBe('skipped');
    expect(result.plan.steps[3].status).toBe('skipped');
  });

  it('every skipped step records the skip reason', () => {
    const plan = buildPausedPlan();
    const result = executeStuckRecovery(plan, SKIP_DETECTION);
    for (let i = 1; i < result.plan.steps.length; i++) {
      expect(result.plan.steps[i].error).toContain('skip recovery');
    }
  });
});

describe('executeStuckRecovery override mode', () => {
  it('respects an explicit override over detection.recovery_mode', () => {
    const plan = buildPausedPlan();
    // detection says soft, override to hard
    const result = executeStuckRecovery(plan, SOFT_DETECTION, 'hard');
    expect(result.recovery_mode).toBe('hard');
    expect(result.plan.steps[1].status).toBe('pending');
  });

  it('throws on unknown mode', () => {
    const plan = buildPausedPlan();
    expect(() =>
      executeStuckRecovery(plan, SOFT_DETECTION, 'nonsense' as 'soft'),
    ).toThrow();
  });
});

describe('executeStuckRecovery preconditions', () => {
  it('throws when plan is not paused', () => {
    const plan = createTaskPlan('t', 'g', [{ label: 'a', type: 'tool_call' }]);
    expect(() => executeStuckRecovery(plan, SOFT_DETECTION)).toThrow(/paused/);
  });
});

describe('recovery budget', () => {
  it('reports exhausted when attempts >= MAX', () => {
    const plan = buildPausedPlan();
    expect(recoveryBudgetExhausted(plan)).toBe(false);

    let next = plan;
    for (let i = 0; i < MAX_AUTO_RECOVERY_ATTEMPTS; i++) {
      next = executeStuckRecovery(
        { ...next, status: 'paused', paused_step_index: 1 },
        HARD_DETECTION,
      ).plan;
    }
    expect(recoveryBudgetExhausted(next)).toBe(true);
  });

  it('respects a custom limit', () => {
    const plan = buildPausedPlan();
    const recovered = executeStuckRecovery(plan, SOFT_DETECTION).plan;
    expect(recoveryBudgetExhausted(recovered, 1)).toBe(true);
    expect(recoveryBudgetExhausted(recovered, 5)).toBe(false);
  });

  it('getRecoveryAttempts returns 0 on a fresh plan', () => {
    const plan = createTaskPlan('t', 'g', [{ label: 'a', type: 'tool_call' }]);
    expect(getRecoveryAttempts(plan)).toBe(0);
  });
});

describe('idempotence and shape', () => {
  it('returns a new plan object (does not mutate input)', () => {
    const plan = buildPausedPlan();
    const before = JSON.stringify(plan);
    executeStuckRecovery(plan, SOFT_DETECTION);
    expect(JSON.stringify(plan)).toBe(before);
  });

  it('result.plan is JSON-serializable', () => {
    const plan = buildPausedPlan();
    const result = executeStuckRecovery(plan, SOFT_DETECTION);
    expect(() => JSON.parse(JSON.stringify(result.plan))).not.toThrow();
  });
});
