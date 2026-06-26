import { describe, expect, it } from 'vitest';
import { buildSnapshot, replayJournal, type SpineJournalEntry } from '../spine-cloud';

describe('E3-K5 journal snapshot restore', () => {
  it('rebuilds the same current-state projection from snapshot plus journal replay', () => {
    const initial = [
      { id: 'a', status: 'queued' as const, history: [] },
      { id: 'b', status: 'queued' as const, history: [] },
    ];
    const snapshot = buildSnapshot(initial);
    const journal: SpineJournalEntry[] = [
      { seq: 2, ts: '2026-06-12T00:02:00.000Z', taskId: 'c', op: 'upsert', task: { id: 'c', status: 'done', history: [] } },
      { seq: 1, ts: '2026-06-12T00:01:00.000Z', taskId: 'a', op: 'upsert', task: { id: 'a', status: 'done', history: [] } },
      { seq: 3, ts: '2026-06-12T00:03:00.000Z', taskId: 'b', op: 'delete' },
    ];

    const restored = replayJournal(snapshot.tasks, journal);

    expect(restored.map((task) => `${task.id}:${task.status}`)).toEqual(['a:done', 'c:done']);
  });
});
