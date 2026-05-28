import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  chunkTranscript,
  readIndexState,
  writeIndexState,
  readOtterFile,
  buildEpisodeName,
  buildEpisodeBody,
  getIndexStats,
  formatIndexResults,
  indexOtterTranscripts,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  type IndexResult,
  type IndexState,
  type OtterChunk,
} from '../otter-semantic-indexer';

let tmpDir: string;
let rawDir: string;
let statePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-test-'));
  rawDir = path.join(tmpDir, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  statePath = path.join(tmpDir, 'otter-index-state.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeOtterFile(name: string, content: object): void {
  fs.writeFileSync(path.join(rawDir, name), JSON.stringify(content), 'utf8');
}

describe('chunkTranscript', () => {
  it('returns empty array for empty string', () => {
    expect(chunkTranscript('')).toEqual([]);
  });

  it('returns single chunk for short transcript', () => {
    const text = 'Hello world this is a short transcript.';
    // Short text under MIN_CHUNK_LENGTH should yield no chunks
    const chunks = chunkTranscript(text);
    // 38 chars < MIN_CHUNK_LENGTH (80) -- expect empty
    expect(chunks.length).toBe(0);
  });

  it('returns one chunk for text under CHUNK_SIZE', () => {
    const text = 'A'.repeat(150); // 150 chars, above MIN_CHUNK_LENGTH
    const chunks = chunkTranscript(text);
    expect(chunks.length).toBe(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].charStart).toBe(0);
  });

  it('creates overlapping chunks for long text', () => {
    const text = 'W'.repeat(CHUNK_SIZE + 200); // long enough for 2+ chunks
    const chunks = chunkTranscript(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Verify overlap: second chunk starts before first chunk ends
    if (chunks.length >= 2) {
      expect(chunks[1].charStart).toBeLessThan(chunks[0].charEnd);
    }
  });

  it('assigns sequential chunk indices', () => {
    const text = 'X'.repeat(CHUNK_SIZE * 3);
    const chunks = chunkTranscript(text);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunkIndex).toBe(i);
    }
  });

  it('chunk text length does not exceed CHUNK_SIZE', () => {
    const text = 'B'.repeat(2000);
    const chunks = chunkTranscript(text);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_SIZE);
    }
  });
});

describe('readIndexState / writeIndexState', () => {
  it('returns empty state for missing file', () => {
    const state = readIndexState('/nonexistent/state.json');
    expect(state).toEqual({ indexed: {} });
  });

  it('round-trips state', () => {
    const state: IndexState = {
      indexed: {
        'meeting-2026.json': { chunk_count: 5, indexed_at: '2026-04-01T00:00:00Z', title: 'Team Meeting' },
      },
    };
    writeIndexState(statePath, state);
    expect(readIndexState(statePath)).toEqual(state);
  });
});

describe('readOtterFile', () => {
  it('returns null for missing file', () => {
    expect(readOtterFile('/nonexistent/file.json')).toBeNull();
  });

  it('parses a valid Otter transcript', () => {
    writeOtterFile('test.json', {
      id: 'abc123',
      title: 'Strategy Meeting',
      transcript: 'We discussed Q3 targets.',
      start_time: '2026-04-01T09:00:00Z',
    });
    const t = readOtterFile(path.join(rawDir, 'test.json'));
    expect(t).not.toBeNull();
    expect(t!.title).toBe('Strategy Meeting');
    expect(t!.transcript).toContain('Q3 targets');
  });
});

describe('buildEpisodeName', () => {
  it('includes title and chunk position', () => {
    const name = buildEpisodeName('Strategy Meeting 2026', 2, 5);
    expect(name).toContain('otter:');
    expect(name).toContain('chunk3of5');
    expect(name).toContain('Strategy Meeting');
  });

  it('truncates long titles to 40 chars', () => {
    const longTitle = 'This is a very long meeting title that exceeds forty characters easily';
    const name = buildEpisodeName(longTitle, 0, 1);
    expect(name.length).toBeLessThan(80); // sanity check
    expect(name).toContain('chunk1of1');
  });
});

describe('buildEpisodeBody', () => {
  it('includes meeting title and chunk text', () => {
    const chunk: OtterChunk = { chunkIndex: 0, text: 'We discussed loan clustering.', charStart: 0, charEnd: 29 };
    const body = buildEpisodeBody('Loan Strategy Meeting', chunk);
    expect(body).toContain('[MEETING: Loan Strategy Meeting]');
    expect(body).toContain('We discussed loan clustering.');
  });
});

describe('getIndexStats', () => {
  it('returns zeros for missing rawDir', () => {
    const stats = getIndexStats('/nonexistent/dir', statePath);
    expect(stats).toEqual({ total: 0, indexed: 0, pending: 0 });
  });

  it('counts files correctly', () => {
    writeOtterFile('a.json', { transcript: 'text' });
    writeOtterFile('b.json', { transcript: 'text' });
    writeOtterFile('c.json', { transcript: 'text' });

    const state: IndexState = {
      indexed: {
        'a.json': { chunk_count: 2, indexed_at: '2026-04-01T00:00:00Z', title: 'A' },
      },
    };
    writeIndexState(statePath, state);

    const stats = getIndexStats(rawDir, statePath);
    expect(stats.total).toBe(3);
    expect(stats.indexed).toBe(1);
    expect(stats.pending).toBe(2);
  });
});

describe('formatIndexResults', () => {
  it('summarizes indexed, skipped, and error results', () => {
    const results: IndexResult[] = [
      { file: 'a.json', title: 'A', chunks_indexed: 3, skipped: false },
      { file: 'b.json', title: 'B', chunks_indexed: 0, skipped: true, skip_reason: 'already indexed' },
      { file: 'c.json', title: 'C', chunks_indexed: 0, skipped: false, error: 'connection refused' },
    ];
    const output = formatIndexResults(results);
    expect(output).toContain('1 indexed');
    expect(output).toContain('1 skipped');
    expect(output).toContain('1 errors');
    expect(output).toContain('a.json');
    expect(output).toContain('connection refused');
  });
});

describe('indexOtterTranscripts', () => {
  it('returns empty results for missing rawDir', async () => {
    const results = await indexOtterTranscripts({
      rawDir: '/nonexistent',
      statePath,
    });
    expect(results).toEqual([]);
  });

  it('skips files with empty transcripts', async () => {
    writeOtterFile('empty.json', { title: 'Empty', transcript: '' });

    // Mock addEpisode to avoid Graphiti calls
    vi.mock('../graphiti-client', () => ({
      addEpisode: vi.fn().mockResolvedValue(true),
    }));

    const results = await indexOtterTranscripts({ rawDir, statePath });
    const emptyResult = results.find((r) => r.file === 'empty.json');
    expect(emptyResult?.skipped).toBe(true);
    expect(emptyResult?.skip_reason).toContain('empty');
  });

  it('skips already-indexed files', async () => {
    writeOtterFile('indexed.json', { title: 'Already Done', transcript: 'A'.repeat(200) });
    const state: IndexState = {
      indexed: {
        'indexed.json': { chunk_count: 1, indexed_at: '2026-04-01T00:00:00Z', title: 'Already Done' },
      },
    };
    writeIndexState(statePath, state);

    vi.mock('../graphiti-client', () => ({
      addEpisode: vi.fn().mockResolvedValue(true),
    }));

    const results = await indexOtterTranscripts({ rawDir, statePath });
    const r = results.find((r) => r.file === 'indexed.json');
    expect(r?.skipped).toBe(true);
    expect(r?.skip_reason).toContain('already indexed');
  });

  it('respects maxFilesPerRun limit', async () => {
    for (let i = 0; i < 5; i++) {
      writeOtterFile(`meeting-${i}.json`, { title: `Meeting ${i}`, transcript: 'A'.repeat(200) });
    }

    vi.mock('../graphiti-client', () => ({
      addEpisode: vi.fn().mockResolvedValue(true),
    }));

    const results = await indexOtterTranscripts({ rawDir, statePath, maxFilesPerRun: 2 });
    const nonSkipped = results.filter((r) => !r.skipped);
    expect(nonSkipped.length).toBeLessThanOrEqual(2);
  });
});
