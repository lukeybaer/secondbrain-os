import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createTaskPlan,
  startStep,
  completeStep,
  failStep,
  skipStep,
  resumeFromPaused,
  detectStuckPattern,
  appendCheckpoint,
  loadCheckpoints,
  loadLastCheckpoint,
  nextPendingStepIndex,
} from '../task-checkpoint';

function tempPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-'));
  return path.join(dir, 'checkpoints.jsonl');
}

describe('task-checkpoint', () => {
  it('creates a plan with all steps pending', () => {
    const plan = createTaskPlan('health-self-heal', 'run 10 probes', [
      { label: 'probe-backups', type: 'tool_call' },
      { label: 'probe-ec2', type: 'tool_call' },
    ]);
    expect(plan.task).toBe('health-self-heal');
    expect(plan.status).toBe('running');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps.every((s) => s.status === 'pending')).toBe(true);
    expect(plan.task_id).toMatch(/health-self-heal-\d+/);
  });

  it('marks a step running then completed', () => {
    let plan = createTaskPlan('t', 'g', [{ label: 'step1', type: 'llm' }]);
    plan = startStep(plan, 'step1');
    expect(plan.steps[0].status).toBe('running');
    expect(plan.steps[0].started_at).toBeTruthy();

    plan = completeStep(plan, 'step1', 'did the thing');
    expect(plan.steps[0].status).toBe('completed');
    expect(plan.steps[0].output_summary).toBe('did the thing');
    expect(plan.status).toBe('completed'); // all steps done
  });

  it('increments retries on failure and pauses after max_retries', () => {
    let plan = createTaskPlan('t', 'g', [
      { label: 's1', type: 'tool_call', max_retries: 2 },
    ]);
    plan = failStep(plan, 's1', 'network error');
    expect(plan.steps[0].retries).toBe(1);
    expect(plan.steps[0].status).toBe('pending'); // still retrying

    plan = failStep(plan, 's1', 'network error');
    expect(plan.steps[0].retries).toBe(2);
    expect(plan.steps[0].status).toBe('failed');
    expect(plan.status).toBe('paused');
    expect(plan.paused_step_index).toBe(0);
  });

  it('skips a step', () => {
    let plan = createTaskPlan('t', 'g', [
      { label: 's1', type: 'tool_call' },
      { label: 's2', type: 'tool_call' },
    ]);
    plan = skipStep(plan, 's1', 'irrelevant probe');
    expect(plan.steps[0].status).toBe('skipped');
    expect(plan.steps[0].error).toBe('irrelevant probe');
  });

  it('resumeFromPaused resets retry count for retry decision', () => {
    let plan = createTaskPlan('t', 'g', [{ label: 's1', type: 'tool_call', max_retries: 1 }]);
    plan = failStep(plan, 's1', 'err');
    plan = failStep(plan, 's1', 'err');
    expect(plan.status).toBe('paused');

    plan = resumeFromPaused(plan, 'retry');
    expect(plan.steps[0].status).toBe('pending');
    expect(plan.steps[0].retries).toBe(0);
    expect(plan.status).toBe('running');
    expect(plan.paused_step_index).toBeUndefined();
  });

  it('resumeFromPaused skips the step for skip decision', () => {
    let plan = createTaskPlan('t', 'g', [{ label: 's1', type: 'tool_call', max_retries: 1 }]);
    plan = failStep(plan, 's1', 'err');
    plan = failStep(plan, 's1', 'err');
    plan = resumeFromPaused(plan, 'skip');
    expect(plan.steps[0].status).toBe('skipped');
  });

  it('appends and loads checkpoints from JSONL', () => {
    const logPath = tempPath();
    const plan1 = createTaskPlan('task-a', 'goal1', [{ label: 's1', type: 'llm' }]);
    const plan2 = createTaskPlan('task-b', 'goal2', [{ label: 's2', type: 'llm' }]);
    appendCheckpoint(logPath, plan1);
    appendCheckpoint(logPath, plan2);

    const loaded = loadCheckpoints(logPath);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].task).toBe('task-a');
    expect(loaded[1].task).toBe('task-b');
  });

  it('loadLastCheckpoint returns most recent for task', () => {
    const logPath = tempPath();
    const p1 = createTaskPlan('my-task', 'g', [{ label: 's1', type: 'llm' }]);
    const p2 = createTaskPlan('my-task', 'g', [{ label: 's2', type: 'llm' }]);
    const p3 = createTaskPlan('other-task', 'g', [{ label: 's3', type: 'llm' }]);
    appendCheckpoint(logPath, p1);
    appendCheckpoint(logPath, p2);
    appendCheckpoint(logPath, p3);

    const last = loadLastCheckpoint(logPath, 'my-task');
    expect(last?.task_id).toBe(p2.task_id);
  });

  it('returns null for loadLastCheckpoint when no matching task', () => {
    const logPath = tempPath();
    expect(loadLastCheckpoint(logPath, 'nonexistent')).toBeNull();
  });

  it('nextPendingStepIndex finds first non-completed step', () => {
    let plan = createTaskPlan('t', 'g', [
      { label: 's1', type: 'tool_call' },
      { label: 's2', type: 'tool_call' },
    ]);
    plan = completeStep(plan, 's1');
    const idx = nextPendingStepIndex(plan);
    expect(idx).toBe(1);
  });

  it('detectStuckPattern returns null for small sample', () => {
    const plans = [
      createTaskPlan('t', 'g', [{ label: 's', type: 'tool_call' }]),
    ];
    expect(detectStuckPattern(plans)).toBeNull();
  });

  it('detectStuckPattern identifies identical_actions when same step fails 3x', () => {
    const makeFailedPlan = () => {
      let p = createTaskPlan('t', 'g', [{ label: 's', type: 'tool_call', max_retries: 1 }]);
      p = failStep(p, 's', 'same error');
      p = failStep(p, 's', 'same error');
      return p;
    };
    const plans = [makeFailedPlan(), makeFailedPlan(), makeFailedPlan()];
    const stuck = detectStuckPattern(plans);
    expect(stuck).not.toBeNull();
    expect(stuck?.pattern).toBe('identical_actions');
    expect(stuck?.recovery_mode).toBe('hard');
  });
});
