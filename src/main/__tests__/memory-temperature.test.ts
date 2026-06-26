/**
 * Tests for memory-temperature.ts (nightly run 143).
 *
 * memory-temperature is a LIVE module: self-health-digest's archival fold reads
 * its access log via computeTemperatures (wired into startup-checks at boot,
 * run 119), yet it shipped with zero test coverage. These tests lock the
 * decay-weighted tiering, the hot-list rebuild/read roundtrip, log trimming, and
 * the graceful-empty paths so a regression in the temperature math or the JSONL
 * format surfaces in CI instead of silently mis-ranking working memory.
 *
 * The tests encode the CATEGORY (recency + frequency raise temperature; old
 * accesses decay; tiers partition by threshold), not one literal fixture, so
 * they keep value if the constants are retuned within reason.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  recordAccess,
  computeTemperatures,
  rebuildHotList,
  readHotList,
  buildHotMemoryBlock,
  trimAccessLog,
  getTemperatureStats,
  type MemoryAccessEvent,
} from '../memory-temperature';

let dataDir: string;

const DAY_MS = 86_400_000;

/** Write access events straight to the log so timestamps are controllable. */
function writeAccessLog(events: MemoryAccessEvent[]): void {
  fs.writeFileSync(
    path.join(dataDir, 'memory-access-log.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

/** N events for one key, all `daysAgo` old, at the given weight. */
function eventsFor(key: string, count: number, daysAgo = 0, weight = 1.0): MemoryAccessEvent[] {
  const ts = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
  return Array.from({ length: count }, () => ({
    timestamp: ts,
    memoryKey: key,
    context: 'test',
    weight,
  }));
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-temp-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('computeTemperatures', () => {
  it('returns an empty list when no access log exists', () => {
    expect(computeTemperatures(dataDir)).toEqual([]);
  });

  it('partitions keys into hot / warm / cold by access volume', () => {
    writeAccessLog([
      ...eventsFor('hot-key', 20), // ~20 -> hot (>= 15)
      ...eventsFor('warm-key', 6), //  ~6 -> warm (2..15)
      ...eventsFor('cold-key', 1), //  ~1 -> cold (< 2)
    ]);

    const temps = computeTemperatures(dataDir);
    const byKey = Object.fromEntries(temps.map((t) => [t.memoryKey, t]));

    expect(byKey['hot-key'].tier).toBe('hot');
    expect(byKey['warm-key'].tier).toBe('warm');
    expect(byKey['cold-key'].tier).toBe('cold');
    expect(byKey['hot-key'].accessCount).toBe(20);
  });

  it('sorts hottest first', () => {
    writeAccessLog([...eventsFor('cool', 3), ...eventsFor('blazing', 25)]);
    const temps = computeTemperatures(dataDir);
    expect(temps[0].memoryKey).toBe('blazing');
    expect(temps[0].temperature).toBeGreaterThan(temps[1].temperature);
  });

  it('decays old accesses below equally-frequent recent ones', () => {
    // Same access count, different recency: recent must outrank stale.
    writeAccessLog([...eventsFor('recent', 8, 0), ...eventsFor('stale', 8, 60)]);
    const byKey = Object.fromEntries(computeTemperatures(dataDir).map((t) => [t.memoryKey, t]));
    expect(byKey['recent'].temperature).toBeGreaterThan(byKey['stale'].temperature);
    // A 60-day-old burst has decayed essentially to cold.
    expect(byKey['stale'].tier).toBe('cold');
  });

  it('weights higher-weight accesses hotter than the same count of reads', () => {
    writeAccessLog([...eventsFor('light', 4, 0, 1.0), ...eventsFor('heavy', 4, 0, 2.0)]);
    const byKey = Object.fromEntries(computeTemperatures(dataDir).map((t) => [t.memoryKey, t]));
    expect(byKey['heavy'].temperature).toBeGreaterThan(byKey['light'].temperature);
  });

  it('skips malformed log lines without throwing', () => {
    fs.writeFileSync(
      path.join(dataDir, 'memory-access-log.jsonl'),
      'not json\n' + JSON.stringify(eventsFor('ok', 1)[0]) + '\n',
    );
    const temps = computeTemperatures(dataDir);
    expect(temps.map((t) => t.memoryKey)).toEqual(['ok']);
  });
});

describe('recordAccess', () => {
  it('appends an event that computeTemperatures can read back', () => {
    recordAccess(dataDir, 'user_profile', 'briefing-build', 2.0);
    const temps = computeTemperatures(dataDir);
    expect(temps).toHaveLength(1);
    expect(temps[0].memoryKey).toBe('user_profile');
    expect(temps[0].accessCount).toBe(1);
  });
});

describe('rebuildHotList / readHotList / buildHotMemoryBlock', () => {
  it('persists only hot-tier keys and reads them back', () => {
    writeAccessLog([...eventsFor('hot-key', 20), ...eventsFor('warm-key', 6)]);
    const hot = rebuildHotList(dataDir);
    expect(hot.every((h) => h.tier === 'hot')).toBe(true);
    expect(hot.map((h) => h.memoryKey)).toContain('hot-key');
    expect(hot.map((h) => h.memoryKey)).not.toContain('warm-key');

    const reread = readHotList(dataDir);
    expect(reread.map((h) => h.memoryKey)).toEqual(hot.map((h) => h.memoryKey));
  });

  it('caps the hot list at the context budget', () => {
    // 15 distinct hot keys, but the budget keeps at most 12.
    const events: MemoryAccessEvent[] = [];
    for (let i = 0; i < 15; i++) events.push(...eventsFor(`hot-${i}`, 20));
    writeAccessLog(events);
    expect(rebuildHotList(dataDir).length).toBeLessThanOrEqual(12);
  });

  it('readHotList and buildHotMemoryBlock are empty before any rebuild', () => {
    expect(readHotList(dataDir)).toEqual([]);
    expect(buildHotMemoryBlock(dataDir)).toBe('');
  });

  it('buildHotMemoryBlock lists the hot keys for the prompt', () => {
    writeAccessLog(eventsFor('hot-key', 20));
    rebuildHotList(dataDir);
    const block = buildHotMemoryBlock(dataDir);
    expect(block).toContain('hot-key');
    expect(block).toContain('hot tier');
  });
});

describe('trimAccessLog', () => {
  it('drops events older than the keep window and retains recent ones', () => {
    writeAccessLog([...eventsFor('recent', 2, 1), ...eventsFor('ancient', 2, 90)]);
    trimAccessLog(dataDir, 30);
    const keys = computeTemperatures(dataDir).map((t) => t.memoryKey);
    expect(keys).toContain('recent');
    expect(keys).not.toContain('ancient');
  });

  it('is a no-op when there is no log', () => {
    expect(() => trimAccessLog(dataDir, 30)).not.toThrow();
  });
});

describe('getTemperatureStats', () => {
  it('summarizes tier counts and the top memory', () => {
    writeAccessLog([
      ...eventsFor('hot-key', 25),
      ...eventsFor('warm-key', 6),
      ...eventsFor('cold-key', 1),
    ]);
    const stats = getTemperatureStats(dataDir);
    expect(stats.totalKeys).toBe(3);
    expect(stats.hotCount).toBe(1);
    expect(stats.warmCount).toBe(1);
    expect(stats.coldCount).toBe(1);
    expect(stats.topMemory).toBe('hot-key');
    expect(stats.topTemperature).toBeGreaterThan(0);
  });

  it('returns a zeroed summary for an empty data dir', () => {
    const stats = getTemperatureStats(dataDir);
    expect(stats.totalKeys).toBe(0);
    expect(stats.topMemory).toBeNull();
    expect(stats.topTemperature).toBe(0);
  });
});
