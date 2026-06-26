// saga-compensation.test.ts
//
// Regression tests for reverse-order saga compensation. Encodes the CATEGORY
// (clean path commits all; a mid-failure rolls back committed steps in REVERSE
// order; irreversible steps are surfaced not silently dropped; a compensator
// that itself throws is recorded and does not abort the rollback), not one
// literal trigger. Per feedback_frugal_regression_tests.md.

import { describe, it, expect } from 'vitest';
import { runSaga, SagaStep, SagaLogEvent } from '../saga-compensation';

describe('saga-compensation runSaga', () => {
  it('commits every step on the clean path and never compensates', async () => {
    const compensated: string[] = [];
    const steps: SagaStep[] = [
      { id: 'a', forward: () => 1, compensate: () => void compensated.push('a') },
      { id: 'b', forward: () => 2, compensate: () => void compensated.push('b') },
    ];
    const res = await runSaga(steps);
    expect(res).toEqual({ ok: true, committed: ['a', 'b'] });
    expect(compensated).toEqual([]);
  });

  it('compensates committed steps in REVERSE order on a mid-failure', async () => {
    const order: string[] = [];
    const steps: SagaStep[] = [
      { id: 'a', forward: () => 'ra', compensate: () => void order.push('a') },
      { id: 'b', forward: () => 'rb', compensate: () => void order.push('b') },
      {
        id: 'c',
        forward: () => {
          throw new Error('boom');
        },
      },
    ];
    const res = await runSaga(steps);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failedAt).toBe('c');
    expect(res.error).toBe('boom');
    expect(res.compensated).toEqual(['b', 'a']); // reverse of commit order
    expect(order).toEqual(['b', 'a']);
  });

  it('passes the forward result into the compensator', async () => {
    let seen: ExampleCo;
    const steps: SagaStep[] = [
      { id: 'send', forward: () => ({ messageId: 'm-42' }), compensate: (r) => void (seen = r) },
      {
        id: 'fail',
        forward: () => {
          throw new Error('x');
        },
      },
    ];
    await runSaga(steps);
    expect(seen).toEqual({ messageId: 'm-42' });
  });

  it('surfaces irreversible committed steps as uncompensable, not silently dropped', async () => {
    const steps: SagaStep[] = [
      { id: 'send-email', forward: () => 'sent' }, // no compensator: irreversible
      { id: 'book-call', forward: () => 'booked', compensate: () => {} },
      {
        id: 'write-file',
        forward: () => {
          throw new Error('disk full');
        },
      },
    ];
    const res = await runSaga(steps);
    if (res.ok) throw new Error('expected failure');
    expect(res.uncompensable).toEqual(['send-email']);
    expect(res.compensated).toEqual(['book-call']);
  });

  it('records a compensator that itself throws and keeps rolling back', async () => {
    const rolled: string[] = [];
    const steps: SagaStep[] = [
      { id: 'a', forward: () => 1, compensate: () => void rolled.push('a') },
      {
        id: 'b',
        forward: () => 2,
        compensate: () => {
          throw new Error('undo failed');
        },
      },
      {
        id: 'c',
        forward: () => {
          throw new Error('stop');
        },
      },
    ];
    const res = await runSaga(steps);
    if (res.ok) throw new Error('expected failure');
    expect(res.compensationErrors).toEqual([{ id: 'b', error: 'undo failed' }]);
    expect(res.compensated).toEqual(['a']); // a still rolled back despite b's failure
    expect(rolled).toEqual(['a']);
  });

  it('writes a forward + compensation event trail to the injected log writer', async () => {
    const events: SagaLogEvent[] = [];
    const steps: SagaStep[] = [
      { id: 'a', forward: () => 1, compensate: () => {} },
      {
        id: 'b',
        forward: () => {
          throw new Error('e');
        },
      },
    ];
    await runSaga(steps, { writer: (ev) => events.push(ev) });
    expect(events).toEqual([
      { type: 'forward', id: 'a', ok: true },
      { type: 'forward', id: 'b', ok: false, error: 'e' },
      { type: 'compensate', id: 'a', ok: true },
    ]);
  });

  it('supports async forwards and compensators', async () => {
    const steps: SagaStep[] = [
      {
        id: 'a',
        forward: async () => {
          await Promise.resolve();
          return 'ok';
        },
        compensate: async () => {
          await Promise.resolve();
        },
      },
      {
        id: 'b',
        forward: async () => {
          throw new Error('async boom');
        },
      },
    ];
    const res = await runSaga(steps);
    expect(res.ok).toBe(false);
  });
});
