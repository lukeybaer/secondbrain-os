import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('../config', () => ({
  getConfig: () => ({ anthropicApiKey: undefined }),
}));

import {
  readReflectionLog,
  writeState,
  readState,
  formatContextForInjection,
  getCompressedContext,
  runCompressionPass,
  type CompressedContext,
  type RoundEntry,
  KEEP_RECENT,
  COMPRESS_THRESHOLD,
} from '../conversation-compressor';

let tmpDir: string;
let statePath: string;
let logPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  statePath = path.join(tmpDir, 'state.json');
  logPath = path.join(tmpDir, 'reflection.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeReflection(entry: Partial<RoundEntry> & { timestamp: string; task: string }): void {
  fs.appendFileSync(
    logPath,
    JSON.stringify({ outcome: 'success', goal: '', learnings: [], ...entry }) + '\n',
    'utf8',
  );
}

describe('readReflectionLog', () => {
  it('returns empty array for missing file', () => {
    expect(readReflectionLog('/nonexistent/path.jsonl')).toEqual([]);
  });

  it('parses valid reflection entries', () => {
    writeReflection({ timestamp: '2026-04-01T00:00:00Z', task: 'nightly-task', goal: 'test', outcome: 'success', learnings: ['a'] });
    writeReflection({ timestamp: '2026-04-02T00:00:00Z', task: 'video-task', goal: 'video', outcome: 'partial', learnings: [] });
    const entries = readReflectionLog(logPath);
    expect(entries).toHaveLength(2);
    expect(entries[0].task).toBe('nightly-task');
    expect(entries[1].outcome).toBe('partial');
  });

  it('skips malformed lines', () => {
    fs.writeFileSync(logPath, 'not json\n{"timestamp":"2026-04-01T00:00:00Z","task":"good"}\n', 'utf8');
    const entries = readReflectionLog(logPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].task).toBe('good');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      writeReflection({ timestamp: `2026-04-0${i + 1}T00:00:00Z`.replace('0-00', '-00'), task: `task-${i}` });
    }
    const entries = readReflectionLog(logPath, 3);
    expect(entries.length).toBeLessThanOrEqual(3);
  });
});

describe('readState / writeState', () => {
  it('returns null for missing file', () => {
    expect(readState('/nonexistent/state.json')).toBeNull();
  });

  it('round-trips a CompressedContext', () => {
    const ctx: CompressedContext = {
      previous_summary: 'Amy did things',
      recent_rounds: [{ timestamp: '2026-04-01T00:00:00Z', task: 'test', goal: '', outcome: 'success', learnings: [] }],
      rounds_compressed: 5,
      rounds_kept: 1,
      last_compressed_at: '2026-04-01T00:00:00Z',
      version: 3,
    };
    writeState(statePath, ctx);
    const loaded = readState(statePath);
    expect(loaded).toEqual(ctx);
  });
});

describe('formatContextForInjection', () => {
  it('returns empty string for empty context', () => {
    const ctx: CompressedContext = {
      previous_summary: '',
      recent_rounds: [],
      rounds_compressed: 0,
      rounds_kept: 0,
      last_compressed_at: '2026-04-01T00:00:00Z',
      version: 0,
    };
    expect(formatContextForInjection(ctx)).toBe('');
  });

  it('includes summary section when previous_summary exists', () => {
    const ctx: CompressedContext = {
      previous_summary: 'Amy fixed the video pipeline',
      recent_rounds: [],
      rounds_compressed: 3,
      rounds_kept: 0,
      last_compressed_at: '2026-04-01T00:00:00Z',
      version: 1,
    };
    const out = formatContextForInjection(ctx);
    expect(out).toContain('[AMY HISTORY SUMMARY]');
    expect(out).toContain('Amy fixed the video pipeline');
    expect(out).toContain('[END HISTORY]');
  });

  it('includes recent activity section with round details', () => {
    const ctx: CompressedContext = {
      previous_summary: '',
      recent_rounds: [
        { timestamp: '2026-04-01T00:00:00Z', task: 'dentist-calls', goal: 'find dentist', outcome: 'partial', learnings: ['ask about x-rays upfront'] },
      ],
      rounds_compressed: 0,
      rounds_kept: 1,
      last_compressed_at: '2026-04-01T00:00:00Z',
      version: 1,
    };
    const out = formatContextForInjection(ctx);
    expect(out).toContain('[RECENT ACTIVITY]');
    expect(out).toContain('dentist-calls');
    expect(out).toContain('ask about x-rays upfront');
  });
});

describe('getCompressedContext', () => {
  it('returns empty string when no state file exists', () => {
    expect(getCompressedContext('/nonexistent/state.json')).toBe('');
  });

  it('returns formatted context from existing state', () => {
    const ctx: CompressedContext = {
      previous_summary: 'Historical summary',
      recent_rounds: [{ timestamp: '2026-04-01T00:00:00Z', task: 'task1', goal: 'goal1', outcome: 'success', learnings: [] }],
      rounds_compressed: 2,
      rounds_kept: 1,
      last_compressed_at: '2026-04-01T00:00:00Z',
      version: 1,
    };
    writeState(statePath, ctx);
    const out = getCompressedContext(statePath);
    expect(out).toContain('Historical summary');
    expect(out).toContain('[END HISTORY]');
  });
});

describe('runCompressionPass', () => {
  it('skips compression when under threshold', async () => {
    writeReflection({ timestamp: '2026-04-01T00:00:00Z', task: 't1', goal: 'g', outcome: 'success', learnings: [] });
    writeReflection({ timestamp: '2026-04-02T00:00:00Z', task: 't2', goal: 'g', outcome: 'success', learnings: [] });

    const ctx = await runCompressionPass({
      reflectionLogPath: logPath,
      statePath,
      apiKey: undefined,
      compressThreshold: 5,
    });

    expect(ctx.rounds_compressed).toBe(0);
    expect(ctx.recent_rounds.length).toBe(2);
    expect(ctx.previous_summary).toBe('');
  });

  it('compresses old rounds without API key (no-op compression)', async () => {
    // Write more than threshold entries
    for (let i = 1; i <= 12; i++) {
      writeReflection({ timestamp: `2026-04-${String(i).padStart(2,'0')}T00:00:00Z`, task: `task-${i}`, goal: 'g', outcome: 'success', learnings: [] });
    }

    const ctx = await runCompressionPass({
      reflectionLogPath: logPath,
      statePath,
      apiKey: undefined,       // no API key: compression skipped but rounds still split
      keepRecent: 3,
      compressThreshold: 5,
    });

    // Without API key, rounds_compressed increments and recent_rounds is capped
    expect(ctx.rounds_compressed).toBeGreaterThan(0);
    expect(ctx.recent_rounds.length).toBe(3);
    expect(ctx.version).toBe(1);
  });

  it('preserves recent rounds verbatim', async () => {
    const timestamps: string[] = [];
    for (let i = 1; i <= 8; i++) {
      const ts = `2026-04-${String(i).padStart(2,'0')}T00:00:00Z`;
      timestamps.push(ts);
      writeReflection({ timestamp: ts, task: `task-${i}`, goal: 'g', outcome: 'success', learnings: [`learned-${i}`] });
    }

    const ctx = await runCompressionPass({
      reflectionLogPath: logPath,
      statePath,
      apiKey: undefined,
      keepRecent: 3,
      compressThreshold: 5,
    });

    // The 3 most recent tasks should be in recent_rounds
    const recentTasks = ctx.recent_rounds.map((r) => r.task);
    expect(recentTasks).toContain('task-6');
    expect(recentTasks).toContain('task-7');
    expect(recentTasks).toContain('task-8');
  });

  it('reads existing state and does not re-compress already-compressed rounds', async () => {
    // Pre-populate state with 3 already-kept rounds
    const existingCtx: CompressedContext = {
      previous_summary: 'Prior summary',
      recent_rounds: [
        { timestamp: '2026-04-01T00:00:00Z', task: 'old-task', goal: 'g', outcome: 'success', learnings: [] },
      ],
      rounds_compressed: 5,
      rounds_kept: 1,
      last_compressed_at: '2026-04-01T00:00:00Z',
      version: 2,
    };
    writeState(statePath, existingCtx);

    // Add 2 new rounds to the log (not yet in state)
    writeReflection({ timestamp: '2026-04-02T00:00:00Z', task: 'new-task-1', goal: 'g', outcome: 'success', learnings: [] });
    writeReflection({ timestamp: '2026-04-03T00:00:00Z', task: 'new-task-2', goal: 'g', outcome: 'success', learnings: [] });

    const ctx = await runCompressionPass({
      reflectionLogPath: logPath,
      statePath,
      apiKey: undefined,
      keepRecent: 5,
      compressThreshold: 10,
    });

    // Should have all 3 (1 kept from before + 2 new)
    expect(ctx.recent_rounds.length).toBe(3);
    expect(ctx.rounds_compressed).toBe(5); // unchanged since under threshold
    expect(ctx.previous_summary).toBe('Prior summary'); // unchanged
  });
});
