// tool-result-cache.test.ts
//
// Tests TTL + LRU + persistence + cacheable predicate + wrap() helper. Uses
// an injected clock so TTL expiry is deterministic without busy-waiting.

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ToolResultCache,
  cacheNonEmpty,
  getSharedToolResultCache,
  resetSharedToolResultCache,
} from '../tool-result-cache';

describe('ToolResultCache: get / set / TTL', () => {
  let now = 1_000_000_000;
  const clock = () => now;
  let cache: ToolResultCache;

  beforeEach(() => {
    now = 1_000_000_000;
    cache = new ToolResultCache({ now: clock, defaultTtlMs: 1000 });
  });

  it('miss returns undefined', () => {
    expect(cache.get('gmail.search', { q: 'foo' })).toBeUndefined();
    expect(cache.stats().misses).toBe(1);
  });

  it('hit returns the stored value', () => {
    cache.set('gmail.search', { q: 'foo' }, [{ id: 1 }]);
    const hit = cache.get<Array<{ id: number }>>('gmail.search', { q: 'foo' });
    expect(hit).toEqual([{ id: 1 }]);
    expect(cache.stats().hits).toBe(1);
  });

  it('args order does not matter', () => {
    cache.set('t', { a: 1, b: 2 }, 'x');
    expect(cache.get('t', { b: 2, a: 1 })).toBe('x');
  });

  it('different args miss', () => {
    cache.set('t', { a: 1 }, 'x');
    expect(cache.get('t', { a: 2 })).toBeUndefined();
  });

  it('different tool names miss', () => {
    cache.set('t1', { a: 1 }, 'x');
    expect(cache.get('t2', { a: 1 })).toBeUndefined();
  });

  it('TTL expires the entry', () => {
    cache.set('t', { a: 1 }, 'x', 500);
    now += 499;
    expect(cache.get('t', { a: 1 })).toBe('x');
    now += 2; // total elapsed = 501
    expect(cache.get('t', { a: 1 })).toBeUndefined();
    expect(cache.stats().expirations).toBe(1);
  });

  it('uses default TTL when none specified', () => {
    cache.set('t', { a: 1 }, 'x');
    now += 999;
    expect(cache.get('t', { a: 1 })).toBe('x');
    now += 2;
    expect(cache.get('t', { a: 1 })).toBeUndefined();
  });
});

describe('ToolResultCache: LRU eviction', () => {
  it('evicts the least recently used entry when full', () => {
    const cache = new ToolResultCache({ maxEntries: 2 });
    cache.set('t', { a: 1 }, 'one');
    cache.set('t', { a: 2 }, 'two');
    cache.set('t', { a: 3 }, 'three'); // evicts {a:1}

    expect(cache.get('t', { a: 1 })).toBeUndefined();
    expect(cache.get('t', { a: 2 })).toBe('two');
    expect(cache.get('t', { a: 3 })).toBe('three');
    expect(cache.stats().evictions).toBe(1);
  });

  it('hit on an entry refreshes its LRU position', () => {
    const cache = new ToolResultCache({ maxEntries: 2 });
    cache.set('t', { a: 1 }, 'one');
    cache.set('t', { a: 2 }, 'two');
    expect(cache.get('t', { a: 1 })).toBe('one'); // bumps {a:1}
    cache.set('t', { a: 3 }, 'three'); // should evict {a:2}, not {a:1}

    expect(cache.get('t', { a: 1 })).toBe('one');
    expect(cache.get('t', { a: 2 })).toBeUndefined();
    expect(cache.get('t', { a: 3 })).toBe('three');
  });
});

describe('ToolResultCache: cacheable predicate', () => {
  it('blocks storage when predicate returns false', () => {
    const cache = new ToolResultCache({
      cacheable: (_args, result) => result !== null,
    });
    expect(cache.set('t', { a: 1 }, null)).toBe(false);
    expect(cache.get('t', { a: 1 })).toBeUndefined();
  });

  it('cacheNonEmpty rejects empty arrays / strings / objects', () => {
    expect(cacheNonEmpty({}, [])).toBe(false);
    expect(cacheNonEmpty({}, '')).toBe(false);
    expect(cacheNonEmpty({}, {})).toBe(false);
    expect(cacheNonEmpty({}, null)).toBe(false);
    expect(cacheNonEmpty({}, undefined)).toBe(false);
  });

  it('cacheNonEmpty allows real results', () => {
    expect(cacheNonEmpty({}, [1])).toBe(true);
    expect(cacheNonEmpty({}, 'data')).toBe(true);
    expect(cacheNonEmpty({}, { a: 1 })).toBe(true);
    expect(cacheNonEmpty({}, 0)).toBe(true);
  });
});

describe('ToolResultCache: wrap', () => {
  it('action runs once on miss, returns cached value on hit', async () => {
    const cache = new ToolResultCache();
    let calls = 0;
    const action = async () => {
      calls += 1;
      return { count: calls };
    };

    const a = await cache.wrap('t', { id: 1 }, action);
    expect(a.cached).toBe(false);
    expect(a.result).toEqual({ count: 1 });

    const b = await cache.wrap('t', { id: 1 }, action);
    expect(b.cached).toBe(true);
    expect(b.result).toEqual({ count: 1 });
    expect(calls).toBe(1);
  });

  it('different args bypass the cache', async () => {
    const cache = new ToolResultCache();
    let calls = 0;
    const action = async () => {
      calls += 1;
      return calls;
    };
    await cache.wrap('t', { id: 1 }, action);
    await cache.wrap('t', { id: 2 }, action);
    expect(calls).toBe(2);
  });
});

describe('ToolResultCache: sweep + clear', () => {
  it('sweep drops expired entries and returns count', () => {
    let now = 0;
    const cache = new ToolResultCache({ now: () => now });
    cache.set('t', { a: 1 }, 'x', 100);
    cache.set('t', { a: 2 }, 'y', 1000);
    now = 200;
    expect(cache.sweep()).toBe(1);
    expect(cache.get('t', { a: 1 })).toBeUndefined();
    expect(cache.get('t', { a: 2 })).toBe('y');
  });

  it('clear empties the cache', () => {
    const cache = new ToolResultCache();
    cache.set('t', { a: 1 }, 'x');
    cache.clear();
    expect(cache.get('t', { a: 1 })).toBeUndefined();
    expect(cache.stats().size).toBe(0);
  });
});

describe('ToolResultCache: persistence', () => {
  let tmpDir: string;
  let persistPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trcache-'));
    persistPath = path.join(tmpDir, 'cache.json');
  });

  it('survives reload when within TTL', () => {
    const a = new ToolResultCache({ persistPath, defaultTtlMs: 60_000 });
    a.set('t', { id: 1 }, { result: 'cached' });

    const b = new ToolResultCache({ persistPath, defaultTtlMs: 60_000 });
    expect(b.get('t', { id: 1 })).toEqual({ result: 'cached' });
  });

  it('drops expired entries on reload', () => {
    let now = 0;
    const a = new ToolResultCache({ persistPath, now: () => now });
    a.set('t', { id: 1 }, 'x', 100);
    now = 1000;
    const b = new ToolResultCache({ persistPath, now: () => now });
    expect(b.get('t', { id: 1 })).toBeUndefined();
  });

  it('corrupt persist file is tolerated', () => {
    fs.writeFileSync(persistPath, '{ not valid json');
    const cache = new ToolResultCache({ persistPath });
    expect(cache.stats().size).toBe(0);
    cache.set('t', { a: 1 }, 'x');
    expect(cache.get('t', { a: 1 })).toBe('x');
  });
});

describe('hitRate + shared singleton', () => {
  it('hitRate is NaN with no lookups, 0.5 with 1 hit + 1 miss', () => {
    const cache = new ToolResultCache();
    expect(Number.isNaN(cache.hitRate())).toBe(true);
    cache.get('t', { a: 1 }); // miss
    cache.set('t', { a: 1 }, 'x');
    cache.get('t', { a: 1 }); // hit
    expect(cache.hitRate()).toBe(0.5);
  });

  it('shared singleton returns the same instance', () => {
    resetSharedToolResultCache();
    const a = getSharedToolResultCache();
    const b = getSharedToolResultCache();
    expect(a).toBe(b);
    resetSharedToolResultCache();
    const c = getSharedToolResultCache();
    expect(c).not.toBe(a);
  });
});
