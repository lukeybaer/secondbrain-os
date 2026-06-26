import { describe, expect, it } from 'vitest';
import { applyFencedUpdate, tryClaimTask } from '../spine-cloud';

describe('E3-K1 lease exclusivity', () => {
  it('allows exactly one active worker claim and rejects stale fencing-token writes', () => {
    const base = {
      id: 'task-1',
      status: 'queued' as const,
      history: [{ status: 'queued' as const, ts: '2026-06-12T00:00:00.000Z' }],
    };

    const first = tryClaimTask(base, 'ec2-worker', 60_000, 1000, () => 'token-1');
    expect(first.claimed).toBe(true);
    expect(first.task.lease?.holder).toBe('ec2-worker');

    const second = tryClaimTask(first.task, 'pc-worker', 60_000, 2000, () => 'token-2');
    expect(second.claimed).toBe(false);
    expect(second.reason).toBe('not-claimable');

    expect(() =>
      applyFencedUpdate(first.task, 'stale-token', { status: 'done', resultSummary: 'bad' }, 3000),
    ).toThrow(/stale fencing token/);

    const done = applyFencedUpdate(
      first.task,
      'token-1',
      { status: 'done', resultSummary: 'completed by owner' },
      3000,
    );
    expect(done.status).toBe('done');
    expect(done.resultSummary).toContain('completed');
  });
});
