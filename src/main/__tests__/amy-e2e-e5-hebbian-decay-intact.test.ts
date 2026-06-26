/**
 * E5-R5 (Amy E2E overhaul manifest): Hebbian nightly decay is intact after
 * the E5 retry-queue change.
 *
 * Category under test: runNightlyDecay must still archive Tier 2 entries
 * whose weight has decayed below the 0.05 threshold into the Tier 3 archive
 * (memory/archive/YYYY-MM-DD.md), remove them from the index, and leave
 * fresh entries alone. Mirrors the decay setup in memory-fixes.test.ts but
 * additionally asserts the Tier 3 archive file actually received the content.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let testRoot: string;

vi.mock('electron', () => ({
  app: {
    getPath: () => testRoot,
  },
}));

vi.mock('../graphiti-client', () => ({
  addEpisode: vi.fn().mockResolvedValue(true),
  isGraphitiAvailable: vi.fn().mockResolvedValue(true),
}));

import { upsertMemory, runNightlyDecay, loadIndex, initMemoryIndex } from '../memory-index';

const memoryDir = () => path.join(testRoot, 'data', 'agent', 'memory');
const indexPath = () => path.join(memoryDir(), 'index.json');

function backdate(entryId: string, days: number): void {
  const index = loadIndex();
  const e = index.entries.find((i) => i.id === entryId)!;
  const past = new Date();
  past.setDate(past.getDate() - days);
  e.last_accessed = past.toISOString().slice(0, 10);
  fs.writeFileSync(indexPath(), JSON.stringify(index, null, 2));
}

beforeEach(async () => {
  testRoot = path.join(
    os.tmpdir(),
    `sb-decay-e5-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fsp.mkdir(path.join(memoryDir(), 'archive'), { recursive: true });
});

describe('E5-R5 hebbian decay intact', () => {
  it('archives entries below the 0.05 weight threshold to Tier 3 and prunes the index', () => {
    initMemoryIndex();
    const content = `ephemeral decay content ${Date.now()}-${Math.random()}`;
    const entry = upsertMemory('e5-ephemeral-topic', content);

    // 60 idle days: 0.2 * 0.9^60 is far below the 0.05 archive threshold.
    backdate(entry.id, 60);

    const result = runNightlyDecay();
    expect(result.archived).toBeGreaterThanOrEqual(1);
    expect(result.pruned).toBeGreaterThanOrEqual(1);

    // Gone from the index and from Tier 2 ...
    const idx = loadIndex();
    expect(idx.entries.find((e) => e.id === entry.id)).toBeUndefined();
    expect(idx.hashes).not.toContain(entry.id);
    expect(fs.existsSync(path.join(memoryDir(), entry.file))).toBe(false);

    // ... and present in today's Tier 3 archive file with its content.
    const today = new Date().toISOString().slice(0, 10);
    const archiveFile = path.join(memoryDir(), 'archive', `${today}.md`);
    expect(fs.existsSync(archiveFile)).toBe(true);
    const archived = fs.readFileSync(archiveFile, 'utf-8');
    expect(archived).toContain('e5-ephemeral-topic');
    expect(archived).toContain(content);
  });

  it('leaves recently accessed entries above the threshold untouched', () => {
    initMemoryIndex();
    const entry = upsertMemory(
      'e5-fresh-topic',
      `fresh decay content ${Date.now()}-${Math.random()}`,
    );

    // Two idle days only: 0.2 * 0.9^2 = 0.162, comfortably above 0.05.
    backdate(entry.id, 2);

    runNightlyDecay();
    const idx = loadIndex();
    const kept = idx.entries.find((e) => e.id === entry.id);
    expect(kept).toBeDefined();
    expect(kept!.weight).toBeGreaterThan(0.05);
    expect(fs.existsSync(path.join(memoryDir(), entry.file))).toBe(true);
  });
});
