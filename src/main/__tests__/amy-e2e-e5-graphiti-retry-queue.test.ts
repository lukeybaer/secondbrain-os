/**
 * E5-K2 (Amy E2E overhaul manifest): Graphiti write retry queue.
 *
 * Category under test: a Graphiti addEpisode() failure must never silently
 * lose the episode. Failures land in a JSONL spool; a later drain replays
 * them through addEpisode exactly once per drain pass (an accepted episode
 * is removed before the loop moves on, so it can never be double-sent).
 *
 * Also pins the memory-index wiring: upsertMemory with a failing Graphiti
 * add spools the episode (replacing the old silent .catch(() => {})), and a
 * successful add opportunistically drains the spool.
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

// Mock Graphiti like other suites do (ingest-hooks, memory-sync): the cascade
// in memory-index is opt-in under vitest via the env flag set below, so the
// mock is the only thing the cascade can reach.
const mockAddEpisode = vi.fn();
vi.mock('../graphiti-client', () => ({
  addEpisode: (...args: ExampleCo[]) => mockAddEpisode(...args),
  isGraphitiAvailable: vi.fn().mockResolvedValue(true),
}));

import {
  enqueueFailedEpisode,
  drainSpool,
  spoolCount,
  spoolFilePath,
  type SpooledEpisode,
} from '../graphiti-retry-queue';
import { upsertMemory } from '../memory-index';

function ep(n: string): SpooledEpisode {
  return { name: `ep-${n}`, episode_body: `body of ${n}`, source_description: `test:${n}` };
}

let spoolDir: string;

beforeEach(async () => {
  testRoot = path.join(
    os.tmpdir(),
    `sb-retryq-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  spoolDir = path.join(testRoot, 'spool');
  await fsp.mkdir(path.join(testRoot, 'data', 'agent', 'memory', 'archive'), { recursive: true });
  process.env.SECONDBRAIN_GRAPHITI_CASCADE_UNDER_TEST = '1';
  mockAddEpisode.mockReset();
});

describe('E5-K2 graphiti retry queue: spool primitives', () => {
  it('enqueueFailedEpisode appends one JSON line per failure', () => {
    enqueueFailedEpisode(ep('a'), spoolDir);
    enqueueFailedEpisode(ep('b'), spoolDir);

    const raw = fs.readFileSync(spoolFilePath(spoolDir), 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(ep('a'));
    expect(JSON.parse(lines[1])).toEqual(ep('b'));
    expect(spoolCount(spoolDir)).toBe(2);
  });

  it('drainSpool with a succeeding addEpisodeFn empties the spool and reports sent', async () => {
    enqueueFailedEpisode(ep('a'), spoolDir);
    enqueueFailedEpisode(ep('b'), spoolDir);
    enqueueFailedEpisode(ep('c'), spoolDir);

    const fn = vi.fn().mockResolvedValue(true);
    const result = await drainSpool(fn, spoolDir);

    expect(result).toEqual({ attempted: 3, sent: 3, remaining: 0 });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(spoolCount(spoolDir)).toBe(0);
  });

  it('drainSpool with a failing addEpisodeFn keeps every episode', async () => {
    enqueueFailedEpisode(ep('a'), spoolDir);
    enqueueFailedEpisode(ep('b'), spoolDir);

    const returnsFalse = vi.fn().mockResolvedValue(false);
    const r1 = await drainSpool(returnsFalse, spoolDir);
    expect(r1).toEqual({ attempted: 2, sent: 0, remaining: 2 });
    expect(spoolCount(spoolDir)).toBe(2);

    // A throwing fn counts as a failure too, never as a crash.
    const throws = vi.fn().mockRejectedValue(new Error('tunnel down'));
    const r2 = await drainSpool(throws, spoolDir);
    expect(r2).toEqual({ attempted: 2, sent: 0, remaining: 2 });
    expect(spoolCount(spoolDir)).toBe(2);
  });

  it('a drain never sends an already-accepted episode twice (call-count assertion)', async () => {
    enqueueFailedEpisode(ep('keeper'), spoolDir);
    enqueueFailedEpisode(ep('flaky'), spoolDir);

    // First drain: accepts "keeper", rejects "flaky".
    const partial = vi.fn(async (e: SpooledEpisode) => e.name === 'ep-keeper');
    const r1 = await drainSpool(partial, spoolDir);
    expect(r1).toEqual({ attempted: 2, sent: 1, remaining: 1 });

    // Second drain: everything succeeds. Only "flaky" may be re-attempted.
    const all = vi.fn().mockResolvedValue(true);
    const r2 = await drainSpool(all, spoolDir);
    expect(r2).toEqual({ attempted: 1, sent: 1, remaining: 0 });

    const namesSent = [...partial.mock.calls, ...all.mock.calls].map(
      (c) => (c[0] as SpooledEpisode).name,
    );
    expect(namesSent.filter((n) => n === 'ep-keeper')).toHaveLength(1);
    expect(namesSent.filter((n) => n === 'ep-flaky')).toHaveLength(2);
  });

  it('drops unparseable spool lines instead of retrying them forever', async () => {
    enqueueFailedEpisode(ep('good'), spoolDir);
    fs.appendFileSync(spoolFilePath(spoolDir), 'not json at all\n', 'utf-8');

    const fn = vi.fn().mockResolvedValue(true);
    const result = await drainSpool(fn, spoolDir);
    expect(result).toEqual({ attempted: 1, sent: 1, remaining: 0 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('E5-K2 graphiti retry queue: memory-index wiring', () => {
  it('upsertMemory with a failing graphiti add lands the episode in the spool', async () => {
    mockAddEpisode.mockResolvedValue(false);

    upsertMemory('spool-wiring-topic', `unique spool wiring content ${Date.now()}`);

    await vi.waitFor(() => expect(spoolCount()).toBe(1));
    const line = fs.readFileSync(spoolFilePath(), 'utf-8').trim();
    const episode = JSON.parse(line);
    expect(episode.name).toBe('tier2:spool-wiring-topic');
    expect(episode.source_description).toBe('memory_upsert:tier2:spool-wiring-topic');
    expect(episode.group_id).toBe('owner-ea');
  });

  it('a rejecting graphiti add spools too and never throws into the write path', async () => {
    mockAddEpisode.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:8000'));

    const entry = upsertMemory('reject-topic', `unique reject content ${Date.now()}`);
    expect(entry.topic).toBe('reject-topic'); // the Tier 2 write itself succeeded

    await vi.waitFor(() => expect(spoolCount()).toBe(1));
    expect(JSON.parse(fs.readFileSync(spoolFilePath(), 'utf-8').trim()).name).toBe(
      'tier2:reject-topic',
    );
  });

  it('a successful add drains previously spooled episodes (maybeDrainSpool wiring)', async () => {
    // Episode stranded from an earlier outage, in the default spool location.
    enqueueFailedEpisode(ep('stranded'));
    expect(spoolCount()).toBe(1);

    mockAddEpisode.mockResolvedValue(true);
    upsertMemory('healthy-topic', `unique healthy content ${Date.now()}`);

    await vi.waitFor(() => expect(spoolCount()).toBe(0));
    const names = mockAddEpisode.mock.calls.map((c) => (c[0] as SpooledEpisode).name);
    expect(names).toContain('tier2:healthy-topic');
    expect(names).toContain('ep-stranded');
  });
});
