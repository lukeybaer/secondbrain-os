// E1-K2: a finished dispatch must flip the Amy Projects card and format the
// completion summary for dashboard surfaces. Telegram no longer gets proactive
// dispatch-complete pushes.
import { describe, it, expect, vi } from 'vitest';
import { projectAmyTasks } from '../amy-projects';
import { formatBatch } from '../task-notify';
import { isNotifyCategoryAllowed } from '../notify-policy';

vi.mock('../telegram', () => ({ sendMessage: vi.fn() }));

describe('E1-K2 dispatch feedback loop', () => {
  it('renders the card done and formats the completion without allowing proactive Telegram', () => {
    const task = {
      id: 'dispatch-1',
      kind: 'action',
      origin: 'gmail',
      prompt: 'Summarize the invoice thread.',
      title: 'Summarize invoice thread',
      status: 'done',
      createdAt: '2026-06-12T12:00:00.000Z',
      updatedAt: '2026-06-12T12:03:00.000Z',
      resultSummary: 'TLDR: no payment is due until July 1.',
      history: [
        { status: 'queued', ts: '2026-06-12T12:00:00.000Z' },
        { status: 'running', ts: '2026-06-12T12:01:00.000Z' },
        { status: 'done', ts: '2026-06-12T12:03:00.000Z' },
      ],
    } as const;

    const [row] = projectAmyTasks([task as any]);
    expect(row.status).toBe('done');
    expect(row.visibleStatusLabel).toBe('Done');

    const message = formatBatch([task as any]);
    expect(message).toContain('1 dispatch finished.');
    expect(message).toContain('Done:');
    expect(message).toContain('Summarize invoice thread: TLDR: no payment is due until July 1.');

    expect(isNotifyCategoryAllowed('dispatch_complete')).toBe(false);
  });
});
