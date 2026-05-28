import { describe, it, expect } from 'vitest';
import {
  recommendArchives,
  formatArchivalForBriefing,
  getArchivalStats,
} from '../memory-archival-recommender';
import type { MemoryTemperature } from '../memory-temperature';

const NOW = new Date('2026-05-22T00:00:00Z');

function row(
  key: string,
  temperature: number,
  tier: MemoryTemperature['tier'],
  accessCount: number,
  daysAgo: number,
): MemoryTemperature {
  const lastMs = NOW.getTime() - daysAgo * 86_400_000;
  return {
    memoryKey: key,
    temperature,
    accessCount,
    lastAccessedAt: new Date(lastMs).toISOString(),
    tier,
  };
}

describe('memory-archival-recommender', () => {
  it('flags persistently-cold memories past the cold-days threshold', () => {
    const recs = recommendArchives(
      [row('contact:old-vendor', 0.3, 'cold', 3, 90)],
      { now: NOW, coldDaysThreshold: 60 },
    );
    expect(recs).toHaveLength(1);
    expect(recs[0].reason).toBe('cold-tier-persistent');
    expect(recs[0].daysSinceLastAccess).toBeCloseTo(90, 0);
    expect(recs[0].confidence).toBeGreaterThan(0.6);
  });

  it('flags single-access stale memories sooner than cold-tier ones', () => {
    const recs = recommendArchives(
      [row('contact:one-off-lookup', 0.1, 'cold', 1, 45)],
      { now: NOW, singleAccessDaysThreshold: 30 },
    );
    expect(recs).toHaveLength(1);
    expect(recs[0].reason).toBe('single-access-stale');
  });

  it('flags never-accessed seeded keys as never-accessed-and-old', () => {
    const recs = recommendArchives(
      [row('contact:seeded-but-unused', 0.0, 'cold', 0, 45)],
      { now: NOW, singleAccessDaysThreshold: 30 },
    );
    expect(recs).toHaveLength(1);
    expect(recs[0].reason).toBe('never-accessed-and-old');
    expect(recs[0].confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('protects high-access keys from archive recommendation', () => {
    const recs = recommendArchives(
      [row('user_profile', 5, 'cold', 12, 90)],
      { now: NOW, minAccessCountToProtect: 8 },
    );
    expect(recs).toHaveLength(0);
  });

  it('skips keys in the protectedKeys whitelist', () => {
    const recs = recommendArchives(
      [
        row('user_profile', 0.1, 'cold', 1, 120),
        row('contact:vendor-x', 0.1, 'cold', 1, 120),
      ],
      { now: NOW, protectedKeys: ['user_profile'] },
    );
    expect(recs.map((r) => r.memoryKey)).toEqual(['contact:vendor-x']);
  });

  it('does not flag hot or warm tier memories', () => {
    const recs = recommendArchives(
      [
        row('contact:active', 25, 'hot', 30, 1),
        row('contact:occasional', 8, 'warm', 12, 14),
      ],
      { now: NOW },
    );
    expect(recs).toHaveLength(0);
  });

  it('does not flag cold memories within the cold-days threshold', () => {
    const recs = recommendArchives(
      [row('contact:recently-cooled', 0.5, 'cold', 4, 30)],
      { now: NOW, coldDaysThreshold: 60 },
    );
    expect(recs).toHaveLength(0);
  });

  it('sorts highest-confidence first, ties broken by oldest-touched', () => {
    const recs = recommendArchives(
      [
        row('a', 0.2, 'cold', 2, 65),
        row('b', 0.1, 'cold', 1, 90),  // single-access-stale, very confident
        row('c', 0.0, 'cold', 0, 120), // never-accessed-and-old, very confident, oldest
      ],
      { now: NOW },
    );
    expect(recs[0].memoryKey).toBe('c');
    expect(recs[recs.length - 1].memoryKey).toBe('a');
  });

  it('confidence scales with overshoot past threshold', () => {
    const close = recommendArchives(
      [row('barely-stale', 0.5, 'cold', 3, 61)],
      { now: NOW, coldDaysThreshold: 60 },
    );
    const far = recommendArchives(
      [row('long-stale', 0.5, 'cold', 3, 180)],
      { now: NOW, coldDaysThreshold: 60 },
    );
    expect(far[0].confidence).toBeGreaterThan(close[0].confidence);
  });

  it('formatArchivalForBriefing yields a tier-1 line with top-N keys', () => {
    expect(formatArchivalForBriefing([])).toBe('Memory archive: 0 recommendations.');

    const recs = recommendArchives(
      [
        row('a', 0.0, 'cold', 0, 200),
        row('b', 0.0, 'cold', 0, 150),
        row('c', 0.0, 'cold', 0, 120),
        row('d', 0.0, 'cold', 0, 100),
      ],
      { now: NOW },
    );
    const line = formatArchivalForBriefing(recs);
    expect(line).toMatch(/^Memory archive: 4 candidates/);
    expect(line).toContain('+1 more');
  });

  it('getArchivalStats aggregates totals and reasons', () => {
    const recs = recommendArchives(
      [
        row('a', 0.0, 'cold', 0, 90),
        row('b', 0.0, 'cold', 1, 60),
        row('c', 0.1, 'cold', 3, 80),
      ],
      { now: NOW, coldDaysThreshold: 60, singleAccessDaysThreshold: 30 },
    );
    const stats = getArchivalStats(recs);
    expect(stats.total).toBe(3);
    expect(stats.byReason['never-accessed-and-old']).toBe(1);
    expect(stats.byReason['single-access-stale']).toBe(1);
    expect(stats.byReason['cold-tier-persistent']).toBe(1);
    expect(stats.meanConfidence).toBeGreaterThan(0);
    expect(stats.oldestDays).toBeGreaterThanOrEqual(80);
  });

  it('rejects rows with invalid lastAccessedAt timestamps without crashing', () => {
    const recs = recommendArchives(
      [{ memoryKey: 'x', temperature: 0, accessCount: 1, lastAccessedAt: 'garbage', tier: 'cold' }],
      { now: NOW },
    );
    expect(recs).toHaveLength(0);
  });

  it('rejects rows whose lastAccessedAt is in the future', () => {
    const future = row('future-key', 0, 'cold', 1, -10);
    const recs = recommendArchives([future], { now: NOW });
    expect(recs).toHaveLength(0);
  });
});
