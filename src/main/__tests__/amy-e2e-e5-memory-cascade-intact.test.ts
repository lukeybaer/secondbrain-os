/**
 * E5-R1 (Amy E2E overhaul manifest): the memory write cascade is intact.
 *
 * Regression guard for the E5 retry-queue change: upsertMemory must still
 * (1) write the Tier 2 file, (2) add the index entry, and (3) fire the
 * Graphiti addEpisode cascade on success. The retry queue replaced the old
 * silent failure handling; the happy path must not have changed shape.
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

const mockAddEpisode = vi.fn();
vi.mock('../graphiti-client', () => ({
  addEpisode: (...args: ExampleCo[]) => mockAddEpisode(...args),
  isGraphitiAvailable: vi.fn().mockResolvedValue(true),
}));

import { upsertMemory, loadIndex } from '../memory-index';

const memoryDir = () => path.join(testRoot, 'data', 'agent', 'memory');

beforeEach(async () => {
  testRoot = path.join(
    os.tmpdir(),
    `sb-cascade-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fsp.mkdir(path.join(memoryDir(), 'archive'), { recursive: true });
  process.env.SECONDBRAIN_GRAPHITI_CASCADE_UNDER_TEST = '1';
  mockAddEpisode.mockReset();
  mockAddEpisode.mockResolvedValue(true);
});

describe('E5-R1 memory cascade intact', () => {
  it('upsertMemory writes the Tier 2 file, the index entry, and fires addEpisode', async () => {
    const content = `cascade-intact content ${Date.now()}-${Math.random()}`;
    const entry = upsertMemory('cascade-intact-topic', content);

    // 1. Tier 2 file on disk with the content.
    const filePath = path.join(memoryDir(), entry.file);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toContain(content);

    // 2. Index entry present and tiered correctly.
    const idx = loadIndex();
    const indexed = idx.entries.find((e) => e.id === entry.id);
    expect(indexed).toBeDefined();
    expect(indexed!.topic).toBe('cascade-intact-topic');
    expect(indexed!.tier).toBe(2);
    expect(idx.hashes).toContain(entry.id);

    // 3. Graphiti cascade fired with the canonical episode shape.
    await vi.waitFor(() => expect(mockAddEpisode).toHaveBeenCalled());
    const episode = mockAddEpisode.mock.calls[0][0] as Record<string, ExampleCo>;
    expect(episode.name).toBe('tier2:cascade-intact-topic');
    expect(episode.episode_body).toBe(content);
    expect(episode.source_description).toBe('memory_upsert:tier2:cascade-intact-topic');
    expect(episode.group_id).toBe('owner-ea');
  });

  it('a deduped upsert (same content) bumps mentions without re-firing the cascade', async () => {
    const content = `dedup content ${Date.now()}-${Math.random()}`;
    upsertMemory('dedup-topic', content);
    await vi.waitFor(() => expect(mockAddEpisode).toHaveBeenCalledTimes(1));

    const again = upsertMemory('dedup-topic', content);
    expect(again.mentions).toBe(2);
    // Give any stray async work a beat, then confirm no second episode.
    await new Promise((r) => setTimeout(r, 25));
    expect(mockAddEpisode).toHaveBeenCalledTimes(1);
  });
});
