// E1-K3: internal queued records are fine; visible Amy Projects state must be
// actionable, and stale dispatches raise a dispatch-not-triggered alert.
import { describe, it, expect } from 'vitest';
import { buildDispatchNotTriggeredAlert, projectAmyTasks } from '../amy-projects';

describe('E1-K3 no visible queued dead-state', () => {
  it('labels queued cards as actionable user states, never raw Queued', () => {
    const rows = projectAmyTasks([
      {
        id: 'held',
        kind: 'action',
        origin: 'gmail',
        prompt: 'Send the contract.',
        title: 'Send the contract',
        status: 'queued',
        createdAt: '2026-06-12T12:00:00.000Z',
        updatedAt: '2026-06-12T12:00:00.000Z',
        history: [{ status: 'queued', ts: '2026-06-12T12:00:00.000Z' }],
      },
      {
        id: 'approved',
        kind: 'action',
        origin: 'otter',
        prompt: 'Summarize the meeting.',
        title: 'Summarize the meeting',
        status: 'queued',
        approved: true,
        createdAt: '2026-06-12T12:01:00.000Z',
        updatedAt: '2026-06-12T12:01:00.000Z',
        history: [{ status: 'queued', ts: '2026-06-12T12:01:00.000Z' }],
      },
    ] as any);

    expect(rows.map((row) => row.visibleStatusLabel).sort()).toEqual([
      'Needs approval',
      'Waiting to start',
    ]);
    expect(rows.map((row) => row.visibleStatusLabel)).not.toContain('Queued');
  });

  it('raises dispatch-not-triggered after two minutes and includes the self-heal action', () => {
    const alert = buildDispatchNotTriggeredAlert(
      [
        {
          id: 'stalled-approved',
          kind: 'action',
          origin: 'telegram',
          prompt: 'Check the inbox.',
          title: 'Check the inbox',
          status: 'queued',
          approved: true,
          createdAt: '2026-06-12T12:00:00.000Z',
          updatedAt: '2026-06-12T12:00:00.000Z',
          history: [{ status: 'queued', ts: '2026-06-12T12:00:00.000Z' }],
        },
      ] as any,
      Date.parse('2026-06-12T12:03:01.000Z'),
    );

    expect(alert).toMatchObject({
      code: 'dispatch-not-triggered',
      title: 'Dispatch did not start',
      taskIds: ['stalled-approved'],
      selfHeal: {
        action: 'refresh-intake-and-worker',
        approvedTaskIds: ['stalled-approved'],
      },
    });
    expect(alert?.tldr).toContain('waited more than 2 minutes');
  });
});
