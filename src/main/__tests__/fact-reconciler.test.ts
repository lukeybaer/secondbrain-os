import { describe, it, expect } from 'vitest';
import { reconcile, reconcilePairs, type ReconcilePolicy } from '../fact-reconciler';
import type { MemoryFact, ContradictionPair } from '../memory-contradiction-detector';

function fact(partial: Partial<MemoryFact> & Pick<MemoryFact, 'object' | 'asOf'>): MemoryFact {
  return {
    id: partial.id ?? `f-${partial.object}-${partial.asOf}`,
    subject: partial.subject ?? 'employee',
    predicate: partial.predicate ?? 'title',
    object: partial.object,
    asOf: partial.asOf,
    confidence: partial.confidence,
    source: partial.source,
  };
}

describe('reconcile - recency policy (default)', () => {
  it('keeps the newer fact and supersedes the older with a closed validity window', () => {
    const older = fact({ id: 'a', object: 'VP', asOf: '2026-05-01T00:00:00Z' });
    const newer = fact({ id: 'b', object: 'SVP', asOf: '2026-06-01T00:00:00Z' });
    const r = reconcile(older, newer);
    expect(r.object).toBe('SVP');
    expect(r.winnerId).toBe('b');
    expect(r.validFrom).toBe('2026-06-01T00:00:00Z');
    expect(r.agreed).toBe(false);
    expect(r.superseded).not.toBeNull();
    expect(r.superseded!.id).toBe('a');
    expect(r.superseded!.object).toBe('VP');
    // The loser's validity window closes exactly when the winner takes effect.
    expect(r.superseded!.invalidatedAt).toBe('2026-06-01T00:00:00Z');
  });

  it('is order-independent: passing facts in either order yields the same winner', () => {
    const x = fact({ id: 'x', object: 'VP', asOf: '2026-05-01T00:00:00Z' });
    const y = fact({ id: 'y', object: 'SVP', asOf: '2026-06-01T00:00:00Z' });
    expect(reconcile(x, y).winnerId).toBe(reconcile(y, x).winnerId);
  });
});

describe('reconcile - agreement is a dedup, not a conflict', () => {
  it('drops the older duplicate when objects agree after normalization', () => {
    const a = fact({ id: 'a', object: 'VP', asOf: '2026-05-01T00:00:00Z' });
    const b = fact({ id: 'b', object: '  vp ', asOf: '2026-06-01T00:00:00Z' });
    const r = reconcile(a, b);
    expect(r.agreed).toBe(true);
    expect(r.superseded).toBeNull();
    expect(r.winnerId).toBe('b'); // newer assertion kept
  });
});

describe('reconcile - confidence policy', () => {
  it('higher confidence wins even when it is the older fact', () => {
    const policy: ReconcilePolicy = { policy: 'confidence' };
    const older = fact({ id: 'a', object: 'VP', asOf: '2026-05-01T00:00:00Z', confidence: 0.9 });
    const newer = fact({ id: 'b', object: 'SVP', asOf: '2026-06-01T00:00:00Z', confidence: 0.4 });
    const r = reconcile(older, newer, policy);
    expect(r.object).toBe('VP');
    expect(r.winnerId).toBe('a');
  });

  it('falls back to recency when confidence ties (missing confidence treated as 0.5)', () => {
    const policy: ReconcilePolicy = { policy: 'confidence' };
    const older = fact({ id: 'a', object: 'VP', asOf: '2026-05-01T00:00:00Z' });
    const newer = fact({ id: 'b', object: 'SVP', asOf: '2026-06-01T00:00:00Z' });
    const r = reconcile(older, newer, policy);
    expect(r.winnerId).toBe('b');
    expect(r.reason).toMatch(/recency/);
  });
});

describe('reconcile - source-priority policy', () => {
  it('prefers the higher-priority source regardless of recency', () => {
    const policy: ReconcilePolicy = { policy: 'source-priority', sourcePriority: ['manual', 'gmail', 'otter'] };
    const newer = fact({ id: 'b', object: 'SVP', asOf: '2026-06-01T00:00:00Z', source: 'otter' });
    const older = fact({ id: 'a', object: 'VP', asOf: '2026-05-01T00:00:00Z', source: 'manual' });
    const r = reconcile(newer, older, policy);
    expect(r.winnerId).toBe('a'); // manual outranks otter
  });

  it('ExampleCo source ranks below every listed source', () => {
    const policy: ReconcilePolicy = { policy: 'source-priority', sourcePriority: ['manual'] };
    const listed = fact({ id: 'a', object: 'VP', asOf: '2026-05-01T00:00:00Z', source: 'manual' });
    const ExampleCo = fact({ id: 'b', object: 'SVP', asOf: '2026-06-01T00:00:00Z', source: 'mystery' });
    expect(reconcile(listed, ExampleCo, policy).winnerId).toBe('a');
  });
});

describe('reconcile - misuse guard', () => {
  it('throws when the two facts are not about the same subject+predicate', () => {
    const a = fact({ id: 'a', subject: 'employee', predicate: 'title', object: 'VP', asOf: '2026-05-01T00:00:00Z' });
    const b = fact({ id: 'b', subject: 'contractor', predicate: 'title', object: 'Director', asOf: '2026-06-01T00:00:00Z' });
    expect(() => reconcile(a, b)).toThrow(/same/);
  });
});

describe('reconcilePairs', () => {
  it('reconciles a batch of contradiction pairs into one record each', () => {
    const newer = fact({ id: 'b', object: 'SVP', asOf: '2026-06-01T00:00:00Z' });
    const older = fact({ id: 'a', object: 'VP', asOf: '2026-05-01T00:00:00Z' });
    const pair: ContradictionPair = {
      subject: 'employee',
      predicate: 'title',
      newer,
      older,
      ageGapHours: 744,
      strength: 0.6,
    };
    const out = reconcilePairs([pair]);
    expect(out).toHaveLength(1);
    expect(out[0].object).toBe('SVP');
    expect(out[0].superseded!.id).toBe('a');
  });
});
