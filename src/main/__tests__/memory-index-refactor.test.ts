/**
 * Comprehensive coverage for the refactored three-tier memory store.
 *
 *   - Decay logic (multiplicative formula, archive threshold, invalidation)
 *   - Promotion semantics (the fix that gates rate/weight changes to the
 *     exact mentions transition and preserves caller-supplied values)
 *   - Index cache (mtime-keyed reload, path-keyed eviction, explicit
 *     invalidateIndexCache export)
 *   - Corrupt-file fallback (backup-then-fresh, never silent overwrite)
 *   - Edge cases for upsert/invalidate/loadRelevant/working-memory/archive
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ── Electron mock — rotates per test so each run gets a clean userData ────────

let testRoot: string;

vi.mock('electron', () => ({
  app: {
    getPath: (_name: string) => testRoot,
  },
}));

// Imports must come after the mock so `app.getPath` resolves to testRoot.
import {
  appendToArchive,
  appendWorkingMemory,
  buildMemoryContext,
  initMemoryIndex,
  invalidateIndexCache,
  invalidateMemory,
  loadArchiveDate,
  loadIndex,
  loadRelevantMemories,
  readWorkingMemory,
  runNightlyDecay,
  upsertMemory,
  writeWorkingMemory,
  type MemoryIndex,
} from '../memory-index';

// ── Helpers ───────────────────────────────────────────────────────────────────

const memoryDir = (): string => path.join(testRoot, 'data', 'agent', 'memory');
const indexFile = (): string => path.join(memoryDir(), 'index.json');

const todayISO = (): string => new Date().toISOString().slice(0, 10);

const daysAgoISO = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

/** Read the index off disk and apply a mutator, then write it back.
 *  Used to simulate aging, manual edits, or out-of-band writes. */
function patchIndex(mutator: (idx: MemoryIndex) => void): void {
  const idx = JSON.parse(fs.readFileSync(indexFile(), 'utf-8')) as MemoryIndex;
  mutator(idx);
  fs.writeFileSync(indexFile(), JSON.stringify(idx, null, 2), 'utf-8');
}

beforeEach(async () => {
  testRoot = path.join(
    os.tmpdir(),
    `sb-memidx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fsp.mkdir(path.join(testRoot, 'data', 'agent', 'memory', 'archive'), {
    recursive: true,
  });
  invalidateIndexCache();
});

// ── Decay logic ───────────────────────────────────────────────────────────────

describe('decay logic', () => {
  it('a new entry has documented defaults', () => {
    const e = upsertMemory('topic', 'fresh content');
    expect(e.weight).toBe(0.2);
    expect(e.mentions).toBe(1);
    expect(e.decay_rate).toBe(0.1);
    expect(e.tier).toBe(2);
    expect(e.invalid_at).toBeUndefined();
  });

  it('applies multiplicative decay across N days', () => {
    const e = upsertMemory('topic', 'aged');
    patchIndex((idx) => {
      idx.entries.find((x) => x.id === e.id)!.last_accessed = daysAgoISO(5);
    });
    invalidateIndexCache();

    const stats = runNightlyDecay();
    expect(stats.decayed).toBe(1);
    expect(stats.archived).toBe(0);

    invalidateIndexCache();
    const after = loadIndex().entries.find((x) => x.id === e.id)!;
    expect(after.weight).toBeCloseTo(0.2 * Math.pow(0.9, 5), 6);
  });

  it('archives and prunes entries that decay below 0.05', () => {
    const e = upsertMemory('doomed', 'short-lived');
    patchIndex((idx) => {
      idx.entries.find((x) => x.id === e.id)!.last_accessed = daysAgoISO(60);
    });
    invalidateIndexCache();

    const stats = runNightlyDecay();
    expect(stats.archived).toBe(1);
    expect(stats.pruned).toBe(1);

    invalidateIndexCache();
    const idx = loadIndex();
    expect(idx.entries.find((x) => x.id === e.id)).toBeUndefined();
    expect(idx.hashes.includes(e.id)).toBe(false);
    expect(fs.existsSync(path.join(memoryDir(), e.file))).toBe(false);

    const archive = loadArchiveDate(todayISO());
    expect(archive).toContain('short-lived');
    expect(archive).toContain('doomed');
  });

  it('skips entries whose last_accessed is today (no decay)', () => {
    upsertMemory('topic', 'today');
    const before = loadIndex().entries[0].weight;
    const stats = runNightlyDecay();
    expect(stats.decayed).toBe(0);
    expect(loadIndex().entries[0].weight).toBe(before);
  });

  it('does not decay or archive invalidated entries', () => {
    const e = upsertMemory('topic', 'soon-invalid');
    invalidateMemory(e.id);
    invalidateIndexCache();
    patchIndex((idx) => {
      idx.entries.find((x) => x.id === e.id)!.last_accessed = daysAgoISO(30);
    });
    invalidateIndexCache();

    const stats = runNightlyDecay();
    expect(stats).toEqual({ decayed: 0, archived: 0, pruned: 0 });

    invalidateIndexCache();
    const row = loadIndex().entries.find((x) => x.id === e.id)!;
    expect(row.invalid_at).toBeDefined();
    expect(row.weight).toBe(0);
  });

  it('promoted entries (rate 0.02) decay measurably slower than fresh', () => {
    const fresh = upsertMemory('fresh', 'a');
    upsertMemory('promoted', 'b');
    upsertMemory('promoted', 'b');
    const promoted = upsertMemory('promoted', 'b'); // weight 0.8, rate 0.02

    patchIndex((idx) => {
      idx.entries.find((x) => x.id === fresh.id)!.last_accessed = daysAgoISO(10);
      idx.entries.find((x) => x.id === promoted.id)!.last_accessed = daysAgoISO(10);
    });
    invalidateIndexCache();
    runNightlyDecay();

    invalidateIndexCache();
    const after = loadIndex();
    const freshAfter = after.entries.find((e) => e.id === fresh.id)!;
    const promotedAfter = after.entries.find((e) => e.id === promoted.id)!;

    expect(freshAfter.weight).toBeCloseTo(0.2 * Math.pow(0.9, 10), 6);
    expect(promotedAfter.weight).toBeCloseTo(0.8 * Math.pow(0.98, 10), 6);
    expect(promotedAfter.weight).toBeGreaterThan(freshAfter.weight);
  });
});

// ── Promotion semantics (the quirk fix) ──────────────────────────────────────

describe('promotion semantics', () => {
  it('promotes a default entry at exactly 3 mentions', () => {
    upsertMemory('topic', 'used a lot');
    upsertMemory('topic', 'used a lot');
    const e = upsertMemory('topic', 'used a lot');
    expect(e.mentions).toBe(3);
    expect(e.weight).toBe(0.8);
    expect(e.decay_rate).toBe(0.02);
  });

  it('preserves a caller-supplied decay_rate across every re-access', () => {
    upsertMemory('topic', 'custom', { decayRate: 0.05 });
    let e = upsertMemory('topic', 'custom');
    expect(e.decay_rate).toBe(0.05);
    e = upsertMemory('topic', 'custom'); // promotion transition
    expect(e.decay_rate).toBe(0.05);
    e = upsertMemory('topic', 'custom'); // post-promotion access
    expect(e.decay_rate).toBe(0.05);
    expect(e.weight).toBe(0.8); // weight was still default, so it was promoted
  });

  it('preserves a manually-bumped weight (>=0.5) across promotion', () => {
    const e1 = upsertMemory('topic', 'pre-bumped');
    patchIndex((idx) => {
      idx.entries.find((x) => x.id === e1.id)!.weight = 0.95;
    });
    invalidateIndexCache();

    upsertMemory('topic', 'pre-bumped'); // mentions = 2
    const e3 = upsertMemory('topic', 'pre-bumped'); // promotion transition
    expect(e3.weight).toBe(0.95);
    expect(e3.decay_rate).toBe(0.02); // decay rate WAS default, so still switches
  });

  it('does not re-promote a manually-bumped weight on mention 4+', () => {
    upsertMemory('topic', 'x');
    upsertMemory('topic', 'x');
    upsertMemory('topic', 'x'); // promotion event → weight 0.8
    patchIndex((idx) => {
      idx.entries[0].weight = 0.99;
    });
    invalidateIndexCache();

    const e = upsertMemory('topic', 'x'); // mention 4
    expect(e.weight).toBe(0.99);
  });

  it('clamps weight to <= 1.0', () => {
    const e = upsertMemory('topic', 'x');
    patchIndex((idx) => {
      idx.entries.find((x) => x.id === e.id)!.weight = 1.5;
    });
    invalidateIndexCache();
    const after = upsertMemory('topic', 'x');
    expect(after.weight).toBeLessThanOrEqual(1.0);
  });
});

// ── Cache reload conditions ──────────────────────────────────────────────────

describe('index cache', () => {
  it('returns the cached object on consecutive reads with no disk change', () => {
    initMemoryIndex();
    const a = loadIndex();
    const b = loadIndex();
    expect(b).toBe(a); // reference equality — same cached MemoryIndex object
  });

  it('reloads when the index file mtime advances externally', () => {
    upsertMemory('topic', 'first');
    const first = loadIndex();
    expect(first.entries).toHaveLength(1);

    // Simulate an external writer rewriting the file with different content
    // AND advancing mtime explicitly (utimes avoids filesystem granularity
    // issues — APFS/ext4 are sub-second but HFS+ rounds to whole seconds).
    const replacement: MemoryIndex = {
      version: 1,
      last_updated: todayISO(),
      entries: [],
      hashes: [],
    };
    fs.writeFileSync(indexFile(), JSON.stringify(replacement, null, 2));
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(indexFile(), future, future);

    const second = loadIndex();
    expect(second).not.toBe(first);
    expect(second.entries).toHaveLength(0);
  });

  it('invalidateIndexCache forces a fresh disk read', () => {
    upsertMemory('topic', 'first');
    const a = loadIndex();

    const replacement: MemoryIndex = {
      version: 1,
      last_updated: todayISO(),
      entries: [],
      hashes: [],
    };
    fs.writeFileSync(indexFile(), JSON.stringify(replacement, null, 2));
    invalidateIndexCache();

    const b = loadIndex();
    expect(b).not.toBe(a);
    expect(b.entries).toHaveLength(0);
  });

  it('keys the cache by path; changing userData evicts cleanly', async () => {
    upsertMemory('topic', 'first');
    const inOldRoot = loadIndex();
    expect(inOldRoot.entries).toHaveLength(1);

    // Rotate userData (simulates a parallel test, a second app instance, or
    // a runtime that re-roots the data directory).
    testRoot = path.join(
      os.tmpdir(),
      `sb-memidx-rotated-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fsp.mkdir(path.join(testRoot, 'data', 'agent', 'memory', 'archive'), {
      recursive: true,
    });

    const inNewRoot = loadIndex();
    expect(inNewRoot.entries).toHaveLength(0);
  });

  it('keeps cache coherent across saveIndex calls (upsert -> upsert -> load)', () => {
    upsertMemory('a', 'first');
    expect(loadIndex().entries).toHaveLength(1);
    upsertMemory('b', 'second');
    expect(loadIndex().entries).toHaveLength(2);
    upsertMemory('c', 'third');
    const idx = loadIndex();
    expect(idx.entries.map((e) => e.topic).sort()).toEqual(['a', 'b', 'c']);
  });
});

// ── Corrupt-file fallback ────────────────────────────────────────────────────

describe('corrupt-file fallback', () => {
  function corruptFilesInMemoryDir(): string[] {
    return fs.readdirSync(memoryDir()).filter((f) => f.startsWith('index.json.corrupt.'));
  }

  it('backs up a syntactically invalid index and starts fresh', () => {
    initMemoryIndex();
    fs.writeFileSync(indexFile(), '{this is not json');
    invalidateIndexCache();

    const idx = loadIndex();
    expect(idx.entries).toEqual([]);
    expect(idx.version).toBe(1);

    const backups = corruptFilesInMemoryDir();
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(memoryDir(), backups[0]), 'utf-8')).toContain(
      'this is not json',
    );
  });

  it('backs up an index that parses but fails schema validation', () => {
    initMemoryIndex();
    fs.writeFileSync(indexFile(), JSON.stringify({ wrong: 'shape' }));
    invalidateIndexCache();

    const idx = loadIndex();
    expect(idx.entries).toEqual([]);
    expect(corruptFilesInMemoryDir()).toHaveLength(1);
  });

  it('rejects an entry with a wrong-typed numeric field', () => {
    initMemoryIndex();
    fs.writeFileSync(
      indexFile(),
      JSON.stringify({
        version: 1,
        last_updated: todayISO(),
        hashes: [],
        entries: [
          {
            id: 'abc',
            topic: 't',
            file: 't.md',
            weight: 'not a number',
            mentions: 1,
            last_accessed: todayISO(),
            decay_rate: 0.1,
            valid_at: todayISO(),
            tier: 2,
          },
        ],
      }),
    );
    invalidateIndexCache();

    const idx = loadIndex();
    expect(idx.entries).toEqual([]);
    expect(corruptFilesInMemoryDir()).toHaveLength(1);
  });

  it('rejects null/NaN/Infinity in numeric fields (JSON.stringify(NaN) is null)', () => {
    initMemoryIndex();
    fs.writeFileSync(
      indexFile(),
      JSON.stringify({
        version: 1,
        last_updated: todayISO(),
        hashes: [],
        entries: [
          {
            id: 'abc',
            topic: 't',
            file: 't.md',
            weight: null,
            mentions: 1,
            last_accessed: todayISO(),
            decay_rate: 0.1,
            valid_at: todayISO(),
            tier: 2,
          },
        ],
      }),
    );
    invalidateIndexCache();

    expect(loadIndex().entries).toEqual([]);
    expect(corruptFilesInMemoryDir()).toHaveLength(1);
  });

  it('rejects an invalid tier value', () => {
    initMemoryIndex();
    fs.writeFileSync(
      indexFile(),
      JSON.stringify({
        version: 1,
        last_updated: todayISO(),
        hashes: [],
        entries: [
          {
            id: 'abc',
            topic: 't',
            file: 't.md',
            weight: 0.2,
            mentions: 1,
            last_accessed: todayISO(),
            decay_rate: 0.1,
            valid_at: todayISO(),
            tier: 99, // not 1, 2, or 3
          },
        ],
      }),
    );
    invalidateIndexCache();

    expect(loadIndex().entries).toEqual([]);
    expect(corruptFilesInMemoryDir()).toHaveLength(1);
  });

  it('recovers cleanly — subsequent upserts work after a corrupt index', () => {
    initMemoryIndex();
    fs.writeFileSync(indexFile(), 'garbage');
    invalidateIndexCache();
    loadIndex(); // triggers recovery

    const e = upsertMemory('topic', 'after recovery');
    expect(e.weight).toBe(0.2);
    expect(loadIndex().entries).toHaveLength(1);
  });
});

// ── Edge cases: upsert ───────────────────────────────────────────────────────

describe('upsert edge cases', () => {
  it('dedupes by hashed content (whitespace-insensitive trim)', () => {
    const a = upsertMemory('topic', 'same content');
    const b = upsertMemory('topic', '  same content  ');
    expect(b.id).toBe(a.id);
    expect(b.mentions).toBe(2);
    expect(loadIndex().entries).toHaveLength(1);
  });

  it('writes a tier-2 file with a slugified topic as the filename', () => {
    const e = upsertMemory('Hello World!!! ☕', 'body');
    expect(e.file).toBe('hello-world.md');
    expect(fs.existsSync(path.join(memoryDir(), 'hello-world.md'))).toBe(true);
  });

  it('honors an explicit file override (including subdirectories)', () => {
    const e = upsertMemory('alice', 'body', { file: 'contacts/alice.md' });
    expect(e.file).toBe('contacts/alice.md');
    expect(fs.existsSync(path.join(memoryDir(), 'contacts', 'alice.md'))).toBe(true);
  });

  it('different content for the same topic creates two entries', () => {
    upsertMemory('topic', 'one');
    upsertMemory('topic', 'two');
    expect(loadIndex().entries).toHaveLength(2);
  });
});

// ── Edge cases: invalidateMemory ─────────────────────────────────────────────

describe('invalidateMemory', () => {
  it('marks invalid_at and zeroes weight', () => {
    const e = upsertMemory('topic', 'old fact');
    invalidateMemory(e.id);
    const row = loadIndex().entries.find((x) => x.id === e.id)!;
    expect(row.invalid_at).toBeDefined();
    expect(row.weight).toBe(0);
  });

  it('adds a replacement entry when one is provided', () => {
    const e = upsertMemory('topic', 'old fact');
    invalidateMemory(e.id, 'new fact');
    const live = loadIndex().entries.filter((x) => !x.invalid_at);
    expect(live).toHaveLength(1);
    expect(live[0].id).not.toBe(e.id);
  });

  it('is a no-op for an unknown id', () => {
    upsertMemory('topic', 'a');
    invalidateMemory('does-not-exist');
    expect(loadIndex().entries.every((e) => !e.invalid_at)).toBe(true);
  });

  it('re-upserting the same content after invalidation creates a fresh live row', () => {
    const a = upsertMemory('topic', 'same content');
    invalidateMemory(a.id);
    invalidateIndexCache();
    const b = upsertMemory('topic', 'same content');

    const idx = loadIndex();
    const sameHash = idx.entries.filter((e) => e.id === a.id);
    expect(sameHash.length).toBeGreaterThanOrEqual(1);
    expect(sameHash.filter((e) => !e.invalid_at)).toHaveLength(1);
    expect(b.mentions).toBe(1);
  });
});

// ── Edge cases: loadRelevantMemories ─────────────────────────────────────────

describe('loadRelevantMemories', () => {
  it('filters by min weight', () => {
    upsertMemory('low', 'low-content');
    upsertMemory('high', 'x');
    upsertMemory('high', 'x');
    upsertMemory('high', 'x'); // weight 0.8

    const got = loadRelevantMemories(0.5);
    expect(got).toHaveLength(1);
    expect(got[0].topic).toBe('high');
  });

  it('returns [] when no entries meet the threshold', () => {
    upsertMemory('low', 'x');
    expect(loadRelevantMemories(0.9)).toEqual([]);
  });

  it('skips entries whose tier-2 file is missing on disk', () => {
    upsertMemory('ghost', 'x');
    upsertMemory('ghost', 'x');
    const e = upsertMemory('ghost', 'x');
    fs.unlinkSync(path.join(memoryDir(), e.file));
    invalidateIndexCache();
    expect(loadRelevantMemories(0.5)).toEqual([]);
  });

  it('skips invalidated entries', () => {
    upsertMemory('topic', 'x');
    upsertMemory('topic', 'x');
    const e = upsertMemory('topic', 'x');
    invalidateMemory(e.id);
    invalidateIndexCache();
    expect(loadRelevantMemories(0.5)).toEqual([]);
  });

  it('orders results by descending weight', () => {
    upsertMemory('mid', 'm');
    upsertMemory('mid', 'm');
    upsertMemory('mid', 'm');
    upsertMemory('hi', 'h');
    upsertMemory('hi', 'h');
    upsertMemory('hi', 'h');
    patchIndex((idx) => {
      idx.entries.find((e) => e.topic === 'hi')!.weight = 0.95;
      idx.entries.find((e) => e.topic === 'mid')!.weight = 0.6;
    });
    invalidateIndexCache();
    const got = loadRelevantMemories(0.3);
    expect(got.map((g) => g.topic)).toEqual(['hi', 'mid']);
  });

  it('respects maxEntries', () => {
    for (let i = 0; i < 10; i++) {
      upsertMemory(`topic-${i}`, `c${i}`);
      upsertMemory(`topic-${i}`, `c${i}`);
      upsertMemory(`topic-${i}`, `c${i}`);
    }
    expect(loadRelevantMemories(0.3, 3)).toHaveLength(3);
  });

  it('bumps mentions on each loaded entry (access = reinforcement)', () => {
    upsertMemory('topic', 'x');
    upsertMemory('topic', 'x');
    const before = upsertMemory('topic', 'x');
    expect(before.mentions).toBe(3);

    loadRelevantMemories(0.5);
    invalidateIndexCache();
    const after = loadIndex().entries.find((e) => e.id === before.id)!;
    expect(after.mentions).toBe(4);
  });
});

// ── Edge cases: working memory ───────────────────────────────────────────────

describe('working memory', () => {
  it('returns empty string when MEMORY.md does not exist', () => {
    expect(readWorkingMemory()).toBe('');
  });

  it('caps writes at 50 lines, keeping the most recent', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    writeWorkingMemory(lines);
    const got = readWorkingMemory().split('\n');
    expect(got).toHaveLength(50);
    expect(got).toContain('line 59');
    expect(got).not.toContain('line 9');
  });

  it("prefixes appended lines with today's date", () => {
    appendWorkingMemory('first thought');
    appendWorkingMemory('second thought');
    const text = readWorkingMemory();
    expect(text.split(`[${todayISO()}]`).length - 1).toBe(2);
    expect(text).toContain('first thought');
    expect(text).toContain('second thought');
  });
});

// ── Edge cases: archive ──────────────────────────────────────────────────────

describe('archive', () => {
  it('creates the archive directory on first append', () => {
    fs.rmSync(path.join(memoryDir(), 'archive'), { recursive: true, force: true });
    appendToArchive('note');
    expect(fs.existsSync(path.join(memoryDir(), 'archive'))).toBe(true);
  });

  it('appends multiple entries separated by ---', () => {
    appendToArchive('first');
    appendToArchive('second');
    const text = loadArchiveDate(todayISO());
    expect(text).toContain('first');
    expect(text).toContain('second');
    expect((text.match(/---/g) ?? []).length).toBe(2);
  });

  it('returns "" for a date with no archive file', () => {
    expect(loadArchiveDate('1999-01-01')).toBe('');
  });
});

// ── Edge cases: buildMemoryContext ───────────────────────────────────────────

describe('buildMemoryContext', () => {
  it('includes working memory + tier-2 promoted entries', () => {
    writeWorkingMemory('Owner: Test User');
    upsertMemory('alpha', 'priority');
    upsertMemory('alpha', 'priority');
    upsertMemory('alpha', 'priority');

    const ctx = buildMemoryContext();
    expect(ctx).toContain('Working Memory');
    expect(ctx).toContain('Owner: Test User');
    expect(ctx).toContain('alpha');
  });

  it('truncates over maxChars and appends the marker', () => {
    writeWorkingMemory('x'.repeat(5_000));
    const ctx = buildMemoryContext({ maxChars: 500 });
    expect(ctx.endsWith('*(memory truncated)*')).toBe(true);
  });

  it('omits the Working Memory section when MEMORY.md is empty', () => {
    upsertMemory('alpha', 'p');
    upsertMemory('alpha', 'p');
    upsertMemory('alpha', 'p');
    const ctx = buildMemoryContext();
    expect(ctx).not.toContain('Working Memory');
    expect(ctx).toContain('alpha');
  });

  it('returns "" when neither working memory nor promoted entries exist', () => {
    expect(buildMemoryContext()).toBe('');
  });
});
