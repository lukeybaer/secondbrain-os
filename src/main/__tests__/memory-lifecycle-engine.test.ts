// memory-lifecycle-engine.test.ts
//
// Run 97 enhancement 2: regression tests for the lifecycle orchestrator.
// Encodes the precedence rule (SKIP > CONTRADICT > UPDATE > ADD, then
// retention ARCHIVE after) and that the verdict list is deterministic.
// Per feedback_frugal_regression_tests.md.

import { describe, it, expect } from 'vitest';
import {
  tick,
  retentionTick,
  scoreFact,
  LifecycleVerdict,
} from '../memory-lifecycle-engine';
import type { MemoryFact } from '../memory-contradiction-detector';

function fact(over: Partial<MemoryFact> & { id: string }): MemoryFact {
  return {
    subject: 'ExampleCo',
    predicate: 'lives_in',
    object: 'ExampleCo',
    asOf: '2026-05-29T00:00:00Z',
    confidence: 0.9,
    source: 'manual',
    ...over,
  };
}

describe('memory-lifecycle-engine tick', () => {
  it('emits ADD when there is no matching existing fact', () => {
    const r = tick({
      candidates: [fact({ id: 'c1' })],
      existing: [],
    });
    expect(r.verdicts).toHaveLength(1);
    expect(r.verdicts[0].action).toBe('add');
    expect(r.summary).toMatchObject({ add: 1, update: 0, skip: 0, contradict: 0, archive: 0 });
  });

  it('emits SKIP when the candidate duplicates an existing same-value fact', () => {
    const existing = fact({ id: 'e1' });
    const r = tick({
      candidates: [fact({ id: 'c1' })],
      existing: [existing],
    });
    expect(r.verdicts).toHaveLength(1);
    expect(r.verdicts[0].action).toBe('skip');
    expect(r.verdicts[0].existingFactId).toBe('e1');
  });

  it('emits UPDATE when the candidate has the same object but newer asOf', () => {
    const existing = fact({
      id: 'e1',
      asOf: '2025-01-01T00:00:00Z',
    });
    const r = tick({
      candidates: [fact({ id: 'c1', asOf: '2026-05-29T00:00:00Z' })],
      existing: [existing],
    });
    expect(r.verdicts).toHaveLength(1);
    expect(r.verdicts[0].action).toBe('update');
    expect(r.verdicts[0].existingFactId).toBe('e1');
  });

  it('emits ADD + CONTRADICT when the candidate replaces a different older value', () => {
    const oldFact = fact({
      id: 'e1',
      object: 'plano',
      asOf: '2025-01-01T00:00:00Z',
    });
    const r = tick({
      candidates: [
        fact({
          id: 'c1',
          object: 'ExampleCo',
          asOf: '2026-05-29T00:00:00Z',
        }),
      ],
      existing: [oldFact],
    });
    const actions = r.verdicts.map((v) => v.action);
    expect(actions).toEqual(['add', 'contradict']);
    const contradict = r.verdicts.find((v) => v.action === 'contradict')!;
    expect(contradict.existingFactId).toBe('e1');
    expect(contradict.invalidates?.older.id).toBe('e1');
    expect(r.summary).toMatchObject({ add: 1, contradict: 1 });
  });

  it('skips the older contradicted fact during the retention pass', () => {
    const oldFact = fact({
      id: 'e1',
      object: 'plano',
      asOf: '2025-01-01T00:00:00Z',
      confidence: 0.1,
    });
    const r = tick(
      {
        candidates: [
          fact({
            id: 'c1',
            object: 'ExampleCo',
            asOf: '2026-05-29T00:00:00Z',
          }),
        ],
        existing: [oldFact],
        accessByFactId: { e1: { readCount: 0, lastReadAt: null } },
      },
      { archiveBelow: 0.5 },
    );
    // e1 would archive on retention but it already produced a CONTRADICT;
    // duplicating an ARCHIVE for it would be incoherent.
    const archives = r.verdicts.filter((v) => v.action === 'archive');
    expect(archives).toHaveLength(0);
  });

  it('emits ARCHIVE for low-retention existing facts after candidate phase', () => {
    const cold = fact({
      id: 'cold',
      subject: 'random',
      predicate: 'note',
      object: 'old observation',
      asOf: '2020-01-01T00:00:00Z',
      confidence: 0.1,
    });
    const hot = fact({
      id: 'hot',
      subject: 'ExampleCo',
      predicate: 'wife_name',
      object: 'sarah',
      asOf: '2026-05-29T00:00:00Z',
      confidence: 1.0,
    });
    const r = tick(
      {
        candidates: [],
        existing: [cold, hot],
        accessByFactId: {
          cold: { readCount: 0, lastReadAt: null },
          hot: { readCount: 30, lastReadAt: '2026-05-29T00:00:00Z' },
        },
      },
      { archiveBelow: 0.4 },
    );
    const archives = r.verdicts.filter((v) => v.action === 'archive');
    expect(archives.length).toBeGreaterThan(0);
    expect(archives.find((v) => v.existingFactId === 'cold')).toBeTruthy();
    expect(archives.find((v) => v.existingFactId === 'hot')).toBeFalsy();
  });

  it('produces deterministic verdicts for the same inputs', () => {
    const inputs = {
      candidates: [
        fact({ id: 'c1', subject: 'a', object: 'x' }),
        fact({ id: 'c2', subject: 'b', object: 'y' }),
      ],
      existing: [],
    };
    const a = tick(inputs);
    const b = tick(inputs);
    expect(a.verdicts.map((v) => v.action)).toEqual(b.verdicts.map((v) => v.action));
    expect(a.verdicts.map((v) => v.candidate?.id)).toEqual(
      b.verdicts.map((v) => v.candidate?.id),
    );
  });

  it('honors archiveBelow=0 to disable retention', () => {
    const cold = fact({
      id: 'cold',
      asOf: '2020-01-01T00:00:00Z',
      confidence: 0,
    });
    const r = tick(
      {
        candidates: [],
        existing: [cold],
        accessByFactId: { cold: { readCount: 0, lastReadAt: null } },
      },
      { archiveBelow: 0 },
    );
    expect(r.verdicts.filter((v) => v.action === 'archive')).toHaveLength(0);
  });

  it('summary counts match the verdict list', () => {
    const r = tick({
      candidates: [
        fact({ id: 'c1', subject: 'new', object: 'fresh' }),
        fact({ id: 'c2', subject: 'ExampleCo', object: 'ExampleCo' }),
        fact({ id: 'c3', subject: 'ExampleCo', object: 'plano' }),
      ],
      existing: [
        fact({ id: 'e1', subject: 'ExampleCo', object: 'ExampleCo' }),
        fact({
          id: 'e2',
          subject: 'ExampleCo',
          object: 'ExampleCo',
          asOf: '2020-01-01T00:00:00Z',
          predicate: 'lives_in',
        }),
      ],
    });
    const total =
      r.summary.add + r.summary.update + r.summary.skip + r.summary.contradict + r.summary.archive;
    expect(total).toBe(r.verdicts.length);
  });
});

describe('retentionTick', () => {
  it('returns ARCHIVE verdicts in weakest-first order', () => {
    const facts = [
      fact({ id: 'a', confidence: 0.1, asOf: '2020-01-01T00:00:00Z' }),
      fact({ id: 'b', confidence: 0.0, asOf: '2018-01-01T00:00:00Z' }),
      fact({ id: 'c', confidence: 0.05, asOf: '2019-01-01T00:00:00Z' }),
    ];
    const verdicts = retentionTick(
      facts,
      {
        a: { readCount: 0, lastReadAt: null },
        b: { readCount: 0, lastReadAt: null },
        c: { readCount: 0, lastReadAt: null },
      },
      { archiveBelow: 1 },
    );
    expect(verdicts.length).toBe(3);
    // Weakest first: 'b' has lowest confidence and oldest asOf so it must
    // come first; 'c' next; 'a' last (highest of the three).
    expect(verdicts.map((v) => v.existingFactId)).toEqual(['b', 'c', 'a']);
  });

  it('excludes specified fact ids from the archive pass', () => {
    const facts = [
      fact({ id: 'a', confidence: 0.0, asOf: '2018-01-01T00:00:00Z' }),
    ];
    const v = retentionTick(
      facts,
      { a: { readCount: 0, lastReadAt: null } },
      { archiveBelow: 1, excludeFromRetention: new Set(['a']) },
    );
    expect(v).toHaveLength(0);
  });
});

describe('scoreFact', () => {
  it('returns a retention score for a single fact', () => {
    const s = scoreFact(
      fact({ id: 'f1' }),
      { readCount: 5, lastReadAt: '2026-05-29T00:00:00Z' },
    );
    expect(s.factId).toBe('f1');
    expect(s.score).toBeGreaterThan(0);
    expect(s.score).toBeLessThanOrEqual(1);
  });
});
