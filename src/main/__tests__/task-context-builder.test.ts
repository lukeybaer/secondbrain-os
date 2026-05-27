import { describe, it, expect } from 'vitest';
import {
  buildTaskContext,
  buildTaskContextPrefix,
  type UpstreamTaskShape,
} from '../task-context-builder';

function makeStore(tasks: UpstreamTaskShape[]) {
  const map = new Map(tasks.map((t) => [t.id, t]));
  return (id: string) => map.get(id) ?? null;
}

describe('task-context-builder', () => {
  it('renders a single done task as a prefix', () => {
    const getTask = makeStore([
      {
        id: 'a',
        title: 'Research dentists',
        kind: 'action',
        status: 'done',
        resultSummary: 'Found 5 dentists open to no-xray cleaning.',
        completedAt: '2026-05-26T10:00:00Z',
      },
    ]);
    const r = buildTaskContext({ upstreamTaskIds: ['a'], getTask });
    expect(r.prefix).toContain('Prior context from 1 upstream task');
    expect(r.prefix).toContain('Research dentists');
    expect(r.prefix).toContain('Found 5 dentists');
    expect(r.blocks).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
  });

  it('skips tasks that are not found', () => {
    const getTask = makeStore([]);
    const r = buildTaskContext({ upstreamTaskIds: ['ghost'], getTask });
    expect(r.prefix).toBe('');
    expect(r.skipped).toEqual([{ id: 'ghost', reason: 'not_found' }]);
  });

  it('skips tasks not in a usable status by default', () => {
    const getTask = makeStore([
      { id: 'q', title: 'queued thing', status: 'queued' },
      { id: 'r', title: 'running thing', status: 'running' },
      { id: 'f', title: 'failed thing', status: 'failed', error: 'boom' },
    ]);
    const r = buildTaskContext({
      upstreamTaskIds: ['q', 'r', 'f'],
      getTask,
    });
    expect(r.prefix).toBe('');
    expect(r.skipped).toHaveLength(3);
    expect(r.skipped.every((s) => s.reason === 'wrong_status')).toBe(true);
  });

  it('includes failed tasks when includeFailed is set, using error text', () => {
    const getTask = makeStore([
      { id: 'f', title: 'regen attempt', status: 'failed', error: 'rejected: thumbnail dark' },
    ]);
    const r = buildTaskContext({
      upstreamTaskIds: ['f'],
      getTask,
      includeFailed: true,
    });
    expect(r.prefix).toContain('rejected: thumbnail dark');
    expect(r.prefix).toContain('(failed)');
  });

  it('reports no_output for tasks with empty resultSummary', () => {
    const getTask = makeStore([
      { id: 'x', title: 'empty', status: 'done', resultSummary: '' },
      { id: 'y', title: 'whitespace', status: 'done', resultSummary: '   \n  ' },
    ]);
    const r = buildTaskContext({ upstreamTaskIds: ['x', 'y'], getTask });
    expect(r.prefix).toBe('');
    expect(r.skipped.every((s) => s.reason === 'no_output')).toBe(true);
  });

  it('truncates an oversize task body to maxCharsPerTask', () => {
    const long = 'A'.repeat(2000);
    const getTask = makeStore([
      { id: 'big', title: 'big', status: 'done', resultSummary: long },
    ]);
    const r = buildTaskContext({
      upstreamTaskIds: ['big'],
      getTask,
      maxCharsPerTask: 200,
    });
    expect(r.blocks[0].body.length).toBeLessThanOrEqual(200);
    expect(r.blocks[0].body).toContain('[trimmed]');
  });

  it('drops trailing tasks past maxTotalChars but keeps at least one', () => {
    const body = 'X'.repeat(500);
    const getTask = makeStore([
      { id: 'a', title: 'a', status: 'done', resultSummary: body },
      { id: 'b', title: 'b', status: 'done', resultSummary: body },
      { id: 'c', title: 'c', status: 'done', resultSummary: body },
    ]);
    const r = buildTaskContext({
      upstreamTaskIds: ['a', 'b', 'c'],
      getTask,
      maxCharsPerTask: 1000,
      maxTotalChars: 600,
    });
    expect(r.blocks.length).toBeGreaterThanOrEqual(1);
    expect(r.blocks.length).toBeLessThan(3);
    expect(r.skipped.some((s) => s.reason === 'truncated_off_end')).toBe(true);
  });

  it('honors task ordering in the rendered prefix', () => {
    const getTask = makeStore([
      { id: 'first', title: 'First task', status: 'done', resultSummary: 'one' },
      { id: 'second', title: 'Second task', status: 'done', resultSummary: 'two' },
    ]);
    const r = buildTaskContext({
      upstreamTaskIds: ['first', 'second'],
      getTask,
    });
    const firstIdx = r.prefix.indexOf('First task');
    const secondIdx = r.prefix.indexOf('Second task');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it('treats awaiting-review as a usable status', () => {
    const getTask = makeStore([
      {
        id: 'r',
        title: 'coding ran',
        status: 'awaiting-review',
        resultSummary: 'patch ready for review',
      },
    ]);
    const r = buildTaskContext({ upstreamTaskIds: ['r'], getTask });
    expect(r.blocks).toHaveLength(1);
    expect(r.prefix).toContain('patch ready for review');
  });

  it('convenience prefix returns empty string when nothing usable', () => {
    const getTask = makeStore([]);
    const prefix = buildTaskContextPrefix({
      upstreamTaskIds: ['none'],
      getTask,
    });
    expect(prefix).toBe('');
  });

  it('renders a 2-task header when both usable', () => {
    const getTask = makeStore([
      { id: 'a', title: 'A', status: 'done', resultSummary: 'a-result' },
      { id: 'b', title: 'B', status: 'done', resultSummary: 'b-result' },
    ]);
    const r = buildTaskContext({ upstreamTaskIds: ['a', 'b'], getTask });
    expect(r.prefix.startsWith('Prior context from 2 upstream tasks')).toBe(true);
  });
});
