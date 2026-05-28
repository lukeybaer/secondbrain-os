import { describe, it, expect } from 'vitest';
import {
  fuseMemorySignals,
  fuseMemorySignalIds,
} from '../memory-multi-signal-fuse';

describe('memory-multi-signal-fuse', () => {
  it('fuses two rankers and prefers ids that appear in both', () => {
    const fused = fuseMemorySignals([
      {
        name: 'bm25',
        results: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      },
      {
        name: 'entity',
        results: [{ id: 'B' }, { id: 'D' }, { id: 'A' }],
      },
    ]);

    // B is rank 2 in bm25 AND rank 1 in entity, gets the highest RRF.
    expect(fused[0].id).toBe('B');
    expect(fused[0].rankers_matched).toBe(2);
    expect(fused[0].per_ranker_ranks.bm25).toBe(2);
    expect(fused[0].per_ranker_ranks.entity).toBe(1);
  });

  it('returns rankers_matched=1 for ids in only one ranker', () => {
    const fused = fuseMemorySignals([
      { name: 'bm25', results: [{ id: 'X' }] },
      { name: 'entity', results: [{ id: 'Y' }] },
    ]);
    expect(fused).toHaveLength(2);
    for (const r of fused) {
      expect(r.rankers_matched).toBe(1);
    }
  });

  it('honors weight: heavier ranker dominates a single-source id', () => {
    // Same rank in both, but entity has 5x weight. Single-source from
    // entity should out-fuse single-source from bm25.
    const fused = fuseMemorySignals([
      { name: 'bm25', weight: 1.0, results: [{ id: 'bm-only' }] },
      { name: 'entity', weight: 5.0, results: [{ id: 'ent-only' }] },
    ]);
    expect(fused[0].id).toBe('ent-only');
  });

  it('silently ignores empty ranker lists', () => {
    const fused = fuseMemorySignals([
      { name: 'graphiti', results: [] }, // tunnel down
      { name: 'bm25', results: [{ id: 'A' }] },
    ]);
    expect(fused).toHaveLength(1);
    expect(fused[0].id).toBe('A');
    // Empty rankers do not even get a slot in per_ranker_ranks.
    expect(Object.keys(fused[0].per_ranker_ranks)).toEqual(['bm25']);
  });

  it('respects topK cap', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
    const fused = fuseMemorySignals(
      [{ name: 'bm25', results: ids }],
      { topK: 3 },
    );
    expect(fused).toHaveLength(3);
  });

  it('k smoothing flattens the gap between ranks', () => {
    const results = [{ id: 'top' }, { id: 'second' }];
    // Smaller k → larger gap between top and second.
    const lowK = fuseMemorySignals(
      [{ name: 'r', results }],
      { k: 1 },
    );
    const highK = fuseMemorySignals(
      [{ name: 'r', results }],
      { k: 1000 },
    );
    const lowGap = lowK[0].fused_score - lowK[1].fused_score;
    const highGap = highK[0].fused_score - highK[1].fused_score;
    expect(lowGap).toBeGreaterThan(highGap);
  });

  it('deduplicates within a single ranker (does not double-count)', () => {
    const fused = fuseMemorySignals([
      {
        name: 'bm25',
        results: [{ id: 'dup' }, { id: 'dup' }, { id: 'other' }],
      },
    ]);
    const dup = fused.find((r) => r.id === 'dup')!;
    // Only the first occurrence counted, so rank stays at 1.
    expect(dup.per_ranker_ranks.bm25).toBe(1);
  });

  it('id-only convenience returns ids in fused order', () => {
    const ids = fuseMemorySignalIds([
      { name: 'bm25', results: [{ id: 'A' }, { id: 'B' }] },
      { name: 'entity', results: [{ id: 'B' }, { id: 'C' }] },
    ]);
    expect(ids[0]).toBe('B');
    expect(ids).toContain('A');
    expect(ids).toContain('C');
  });

  it('is deterministic on ties (id sort tie-breaker)', () => {
    // Two ids appearing identically in one ranker would have the same
    // fused score and same rankers_matched. We expect a stable id sort.
    const fused = fuseMemorySignals([
      { name: 'r', results: [{ id: 'z' }, { id: 'a' }, { id: 'm' }] },
    ]);
    // Rank within the single ranker decides primary ordering.
    expect(fused.map((r) => r.id)).toEqual(['z', 'a', 'm']);
  });

  it('handles three-way fusion with consensus item winning', () => {
    const fused = fuseMemorySignals([
      { name: 'bm25', results: [{ id: 'X' }, { id: 'Y' }] },
      { name: 'entity', results: [{ id: 'X' }, { id: 'Z' }] },
      { name: 'graphiti', results: [{ id: 'X' }, { id: 'W' }] },
    ]);
    expect(fused[0].id).toBe('X');
    expect(fused[0].rankers_matched).toBe(3);
  });
});
