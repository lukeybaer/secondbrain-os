import { describe, it, expect } from 'vitest';
import {
  rerankByRecency,
  recencyFactor,
} from '../memory-temporal-rerank';

const NOW = new Date('2026-05-26T00:00:00Z');

function daysAgo(d: number): string {
  return new Date(NOW.getTime() - d * 86_400_000).toISOString();
}

describe('memory-temporal-rerank', () => {
  it('does not reorder when lambda=0 (pure relevance)', () => {
    const items = [
      { id: 'old-strong', score: 1.0, timestamp: daysAgo(1000) },
      { id: 'recent-weak', score: 0.1, timestamp: daysAgo(1) },
    ];
    const r = rerankByRecency(items, { lambda: 0, now: NOW });
    expect(r[0].id).toBe('old-strong');
  });

  it('flips order when lambda=1 (pure recency)', () => {
    const items = [
      { id: 'old-strong', score: 1.0, timestamp: daysAgo(1000) },
      { id: 'recent-weak', score: 0.1, timestamp: daysAgo(1) },
    ];
    const r = rerankByRecency(items, { lambda: 1, now: NOW });
    expect(r[0].id).toBe('recent-weak');
  });

  it('blends gently at lambda=0.3 default (close call goes to recency)', () => {
    const items = [
      { id: 'old', score: 1.0, timestamp: daysAgo(1000) },
      { id: 'recent', score: 0.95, timestamp: daysAgo(1) },
    ];
    const r = rerankByRecency(items, { now: NOW });
    expect(r[0].id).toBe('recent');
  });

  it('lets a strongly-relevant old memory beat a marginally-relevant recent one', () => {
    const items = [
      { id: 'old-strong', score: 1.0, timestamp: daysAgo(400) },
      { id: 'recent-irrelevant', score: 0.05, timestamp: daysAgo(0) },
    ];
    const r = rerankByRecency(items, { now: NOW });
    expect(r[0].id).toBe('old-strong');
  });

  it('returns recency=1.0 for today and ~0.5 at one half-life', () => {
    const todayFactor = recencyFactor(daysAgo(0), { now: NOW, halflifeDays: 180 });
    const halflifeFactor = recencyFactor(daysAgo(180), {
      now: NOW,
      halflifeDays: 180,
    });
    expect(todayFactor).toBeCloseTo(1.0, 5);
    expect(halflifeFactor).toBeCloseTo(0.5, 2);
  });

  it('treats future-dated timestamps as fresh, not penalized', () => {
    const future = new Date(NOW.getTime() + 7 * 86_400_000).toISOString();
    const factor = recencyFactor(future, { now: NOW });
    expect(factor).toBeCloseTo(1.0, 5);
  });

  it('treats unparseable timestamps as ancient (recency=0)', () => {
    const items = [
      { id: 'good', score: 0.5, timestamp: daysAgo(10) },
      { id: 'bad', score: 0.5, timestamp: 'not-a-date' },
    ];
    const r = rerankByRecency(items, { lambda: 0.5, now: NOW });
    expect(r[0].id).toBe('good');
    const badEntry = r.find((x) => x.id === 'bad')!;
    expect(badEntry.recency_factor).toBe(0);
    // Bad timestamp items survive in the result set.
    expect(r).toHaveLength(2);
  });

  it('shorter half-life punishes old memories harder', () => {
    const t = daysAgo(30);
    const longHalfLife = recencyFactor(t, { now: NOW, halflifeDays: 180 });
    const shortHalfLife = recencyFactor(t, { now: NOW, halflifeDays: 7 });
    expect(longHalfLife).toBeGreaterThan(shortHalfLife);
  });

  it('preserves age_days as days between timestamp and now', () => {
    const items = [{ id: 'a', score: 1.0, timestamp: daysAgo(45) }];
    const r = rerankByRecency(items, { now: NOW });
    expect(r[0].age_days).toBeCloseTo(45, 5);
  });

  it('is deterministic on ties via id sort', () => {
    const ts = daysAgo(10);
    const items = [
      { id: 'z', score: 0.5, timestamp: ts },
      { id: 'a', score: 0.5, timestamp: ts },
      { id: 'm', score: 0.5, timestamp: ts },
    ];
    const r = rerankByRecency(items, { now: NOW });
    expect(r.map((x) => x.id)).toEqual(['a', 'm', 'z']);
  });

  it('handles empty list', () => {
    expect(rerankByRecency([], { now: NOW })).toEqual([]);
  });

  it('scales recency into the same magnitude band as relevance', () => {
    // Tiny RRF-like scores. Without scoreScale, recency * lambda would
    // dwarf relevance entirely and lambda=0.3 would behave like lambda=1.
    const items = [
      { id: 'old-strong', score: 0.02, timestamp: daysAgo(500) },
      { id: 'recent-mid', score: 0.018, timestamp: daysAgo(5) },
    ];
    const r = rerankByRecency(items, { lambda: 0.3, now: NOW });
    // Recent-mid wins because lambda=0.3 with proper scaling tips the
    // close-call to recency, but the call really is close.
    expect(r[0].id).toBe('recent-mid');
    // And the gap between them is small, not enormous.
    const gap = r[0].adjusted_score - r[1].adjusted_score;
    expect(gap).toBeLessThan(0.5);
  });
});
