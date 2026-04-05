/**
 * Tests for memory-sync.ts — unified memory system (Phases 2-5).
 * Covers: markdown parsing, file discovery, canonical reader, search, Graphiti ingestion.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ── Mock Electron ────────────────────────────────────────────────────────────

let testRoot: string;
let testHomeDir: string;

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return testRoot;
      if (name === 'home') return testHomeDir;
      return testRoot;
    },
    isPackaged: false,
    getAppPath: () => testRoot,
  },
}));

// Mock config
vi.mock('../config', () => ({
  getConfig: () => ({ ec2BaseUrl: 'http://98.80.164.16:3001' }),
  loadConfig: () => ({ ec2BaseUrl: 'http://98.80.164.16:3001' }),
}));

// Mock Graphiti (track calls without hitting real server)
const mockAddEpisode = vi.fn().mockResolvedValue(true);
vi.mock('../graphiti-client', () => ({
  addEpisode: (...args: unknown[]) => mockAddEpisode(...args),
  buildKnowledgeContext: vi.fn().mockResolvedValue(''),
  ingestCallTranscript: vi.fn().mockResolvedValue(true),
  isGraphitiAvailable: vi.fn().mockResolvedValue(false),
}));

import {
  fullGraphitiSeed,
  incrementalGraphitiSync,
  readCanonicalMemory,
  readContactMemory,
  searchMemoryFiles,
} from '../memory-sync';

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  testRoot = path.join(
    os.tmpdir(),
    `sb-memsync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  testHomeDir = path.join(
    os.tmpdir(),
    `sb-home-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  // Create Claude Code memory dir structure
  const memDir = path.join(
    testHomeDir,
    '.claude',
    'projects',
    'C--Users-luked-secondbrain',
    'memory',
  );
  const contactDir = path.join(memDir, 'contacts');
  await fsp.mkdir(contactDir, { recursive: true });
  await fsp.mkdir(path.join(testRoot, 'data'), { recursive: true });

  // Create sample memory files
  await fsp.writeFile(
    path.join(memDir, 'user_profile.md'),
    `---
name: Luke Baer — Core Profile
description: Identity, career, faith, personality
type: user
---

## Identity
- Full name: Luke Baer
- Location: McKinney, TX
`,
  );

  await fsp.writeFile(
    path.join(memDir, 'feedback_testing.md'),
    `---
name: Always write tests
description: Every feature/fix ships with tests
type: feedback
---

Every feature or bug fix ships with tests. No exceptions.
`,
  );

  await fsp.writeFile(
    path.join(memDir, 'project_pixseat.md'),
    `---
name: PixSeat App Build
description: Stadium audience sync app with Bryant
type: project
---

## Status
iOS submission in progress.
`,
  );

  await fsp.writeFile(
    path.join(contactDir, 'bryant_haines.md'),
    `---
name: Bryant Haines
description: PixSeat co-founder, inner circle
type: user
category: inner-circle
---

## Professional
- Co-founder of PixSeat
- Active collaborator on app build
`,
  );

  await fsp.writeFile(
    path.join(contactDir, 'ed_evans.md'),
    `---
name: Ed Evans
description: ITM partner, close friend
type: user
category: inner-circle
---

## Professional
- BAI/ITM partner (70/30 split)
`,
  );

  // MEMORY.md (should be skipped by discovery)
  await fsp.writeFile(
    path.join(memDir, 'MEMORY.md'),
    '# Memory Index\n- [Profile](user_profile.md)',
  );

  mockAddEpisode.mockClear();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('readCanonicalMemory', () => {
  it('reads all memory files and returns structured content', () => {
    const result = readCanonicalMemory();
    expect(result).toContain('Luke Baer');
    expect(result).toContain('Always write tests');
    expect(result).toContain('PixSeat');
  });

  it('filters by type', () => {
    const usersOnly = readCanonicalMemory({ types: ['user'] });
    expect(usersOnly).toContain('Luke Baer');
    expect(usersOnly).toContain('Bryant Haines'); // contacts are type: user
    expect(usersOnly).not.toContain('Always write tests'); // feedback excluded
  });

  it('respects maxChars limit', () => {
    const short = readCanonicalMemory({ maxChars: 100 });
    expect(short.length).toBeLessThanOrEqual(200); // some overhead from headers
  });

  it('excludes MEMORY.md index file', () => {
    const result = readCanonicalMemory();
    expect(result).not.toContain('# Memory Index');
  });
});

describe('readContactMemory', () => {
  it('reads a specific contact by slug', () => {
    const contact = readContactMemory('bryant_haines');
    expect(contact).not.toBeNull();
    expect(contact!.name).toBe('Bryant Haines');
    expect(contact!.body).toContain('PixSeat');
  });

  it('returns null for non-existent contact', () => {
    expect(readContactMemory('nonexistent_person')).toBeNull();
  });
});

describe('searchMemoryFiles', () => {
  it('finds files by content keyword', () => {
    const results = searchMemoryFiles('PixSeat');
    expect(results.length).toBeGreaterThanOrEqual(2); // project + bryant contact
  });

  it('finds files by name', () => {
    const results = searchMemoryFiles('Bryant');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toContain('Bryant');
  });

  it('respects maxResults', () => {
    const results = searchMemoryFiles('a', 2); // broad query
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('returns empty for no matches', () => {
    expect(searchMemoryFiles('xyznonexistent123')).toHaveLength(0);
  });
});

describe('fullGraphitiSeed', () => {
  it('ingests all discovered files as Graphiti episodes', async () => {
    const result = await fullGraphitiSeed();
    // 5 files: user_profile, feedback_testing, project_pixseat, bryant, ed
    expect(result.total).toBe(5);
    expect(result.ingested).toBe(5);
    expect(result.failed).toBe(0);
    expect(mockAddEpisode).toHaveBeenCalledTimes(5);
  });

  it('passes correct episode structure to Graphiti', async () => {
    await fullGraphitiSeed();

    // Find the call for user_profile
    const profileCall = mockAddEpisode.mock.calls.find(
      (call: unknown[]) => (call[0] as { name: string }).name === 'Luke Baer — Core Profile',
    );
    expect(profileCall).toBeDefined();
    const episode = profileCall![0];
    expect(episode.source_description).toContain('memory-file:');
    expect(episode.group_id).toBe('luke-ea');
    expect(episode.episode_body).toContain('Identity, career, faith');
  });

  it('handles Graphiti failures gracefully', async () => {
    mockAddEpisode.mockResolvedValueOnce(false); // First file fails
    const result = await fullGraphitiSeed();
    expect(result.failed).toBe(1);
    expect(result.ingested).toBe(4);
  });
});

describe('incrementalGraphitiSync', () => {
  it('ingests only files changed since last sync', async () => {
    // First sync — should ingest everything (no state file)
    const first = await incrementalGraphitiSync();
    expect(first.ingested).toBe(5);

    mockAddEpisode.mockClear();

    // Second sync — nothing changed, should ingest 0
    const second = await incrementalGraphitiSync();
    expect(second.ingested).toBe(0);
  });

  it('picks up newly modified files on subsequent sync', async () => {
    // First sync
    await incrementalGraphitiSync();
    mockAddEpisode.mockClear();

    // Wait a tick and modify one file
    await new Promise((r) => setTimeout(r, 50));
    const memDir = path.join(
      testHomeDir,
      '.claude',
      'projects',
      'C--Users-luked-secondbrain',
      'memory',
    );
    const now = new Date(Date.now() + 1000); // future to ensure it's "newer"
    fs.utimesSync(path.join(memDir, 'user_profile.md'), now, now);

    // Second sync — should pick up the modified file
    const second = await incrementalGraphitiSync();
    expect(second.ingested).toBe(1);
  });
});
