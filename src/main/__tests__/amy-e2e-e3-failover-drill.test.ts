import { describe, expect, it } from 'vitest';
import { tryClaimTask } from '../spine-cloud';

describe('E3-K2 failover drill', () => {
  it('lets the PC worker adopt the same task only after the cloud lease lapses', () => {
    const cloudClaim = tryClaimTask(
      { id: 'task-failover', status: 'queued' as const, history: [] },
      'ec2-worker',
      1_000,
      10_000,
      () => 'cloud-token',
    );
    expect(cloudClaim.claimed).toBe(true);

    const tooEarly = tryClaimTask(cloudClaim.task, 'pc-worker', 1_000, 10_500, () => 'pc-token');
    expect(tooEarly.claimed).toBe(false);

    const adopted = tryClaimTask(cloudClaim.task, 'pc-worker', 1_000, 11_001, () => 'pc-token');
    expect(adopted.claimed).toBe(true);
    expect(adopted.task.id).toBe('task-failover');
    expect(adopted.task.lease?.holder).toBe('pc-worker');
    expect(adopted.task.lease?.token).toBe('pc-token');
  });
});
