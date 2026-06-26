/**
 * Tests for task-notify.ts, the batched dispatch-completion notifier.
 *
 * formatBatch is the pure summary builder: one message covering a whole bundle
 * of completed dispatches, grouped by outcome, never one message per item.
 * telegram is mocked so the native-module import chain does not load.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../telegram', () => ({ sendMessage: vi.fn() }));

import { formatBatch } from '../task-notify';
import type { Task } from '../task-store';

function task(over: Partial<Task>): Task {
  return {
    id: over.id ?? 't',
    kind: 'action',
    origin: 'otter',
    prompt: 'p',
    title: over.title ?? 'a task',
    status: over.status ?? 'done',
    createdAt: '2026-05-18T00:00:00Z',
    updatedAt: '2026-05-18T00:00:00Z',
    history: [],
    ...over,
  };
}

describe('formatBatch', () => {
  it('returns empty string for no tasks', () => {
    expect(formatBatch([])).toBe('');
  });

  it('summarizes a single completed dispatch with its result', () => {
    const text = formatBatch([
      task({ title: 'Reply to the invoice email', status: 'done', resultSummary: 'Sent.' }),
    ]);
    expect(text).toContain('1 dispatch finished.');
    expect(text).toContain('Reply to the invoice email: Sent.');
  });

  it('batches many dispatches into one message grouped by outcome', () => {
    const text = formatBatch([
      task({ id: '1', title: 'task one', status: 'done' }),
      task({ id: '2', title: 'task two', status: 'done' }),
      task({ id: '3', title: 'risky change', status: 'awaiting-review' }),
      task({ id: '4', title: 'broken thing', status: 'failed' }),
    ]);
    expect(text).toContain('4 dispatches finished.');
    expect(text).toContain('Done:');
    expect(text).toContain('Needs your review:');
    expect(text).toContain('Failed:');
    expect(text).toContain('task one');
    expect(text).toContain('risky change');
    expect(text).toContain('broken thing');
  });

  it('shows the answer for a Telegram question dispatch', () => {
    const text = formatBatch([
      task({
        origin: 'telegram',
        title: 'What is my AWS bill?',
        status: 'done',
        resultSummary: 'The ExampleCo account is past due on a failed card.',
      }),
    ]);
    expect(text).toContain('What is my AWS bill?: The ExampleCo account is past due');
  });
});
