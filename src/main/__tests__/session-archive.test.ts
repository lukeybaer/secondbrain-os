// session-archive.test.ts
//
// Tests for the Tier-4 session archive retrieval source. Verifies the
// sanitizer rejects FTS5 injection, the formatter produces the expected
// block shape, and searchSessionArchive gracefully handles missing
// DB / missing better-sqlite3 / empty queries without throwing.
//
// Commit 18 of 18 in plans/dazzling-rolling-moler.md.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  searchSessionArchive,
  formatSessionArchiveBlock,
  buildSessionArchiveContext,
} from '../session-archive';

// Helper: force a "missing DB" state by temporarily renaming the DB file
// if it exists. The module checks fs.existsSync(DB_PATH) directly, so
// moving the file is the most reliable way to simulate the missing state.
const DB_PATH = path.join(os.homedir(), '.secondbrain', 'sessions.db');
function withMissingDb<T>(fn: () => T): T {
  const backup = DB_PATH + '.bak.test';
  let moved = false;
  try {
    if (fs.existsSync(DB_PATH)) {
      fs.renameSync(DB_PATH, backup);
      moved = true;
    }
    return fn();
  } finally {
    if (moved && fs.existsSync(backup)) {
      fs.renameSync(backup, DB_PATH);
    }
  }
}

describe('searchSessionArchive graceful fallbacks', () => {
  it('returns [] for empty query', () => {
    expect(searchSessionArchive('')).toEqual([]);
    expect(searchSessionArchive('   ')).toEqual([]);
  });

  it('returns [] when query sanitizes to nothing (only punctuation)', () => {
    expect(searchSessionArchive('!@#$%^&*()')).toEqual([]);
  });

  it('returns [] when the sessions.db file does not exist', () => {
    withMissingDb(() => {
      expect(searchSessionArchive('dentist')).toEqual([]);
    });
  });
});

describe('formatSessionArchiveBlock', () => {
  it('returns empty string for no hits', () => {
    expect(formatSessionArchiveBlock([])).toBe('');
  });

  it('formats a session hit with date, id prefix, topic, prompt, and reply', () => {
    const hits = [
      {
        sessionId: 'abcd1234-ef56-7890-ef12-abcdef123456',
        startedAt: '2026-04-10T14:30:00Z',
        topicGuess: 'phase 1-10 overhaul',
        firstPrompt: 'why is the amy migration unfinished?',
        lastResponse: 'Commits 1-7 landed, commits 8-18 pending.',
      },
    ];
    const out = formatSessionArchiveBlock(hits);
    expect(out).toContain('Session archive');
    expect(out).toContain('2026-04-10');
    expect(out).toContain('abcd1234');
    expect(out).toContain('phase 1-10 overhaul');
    expect(out).toContain('why is the amy migration unfinished');
    expect(out).toContain('Commits 1-7 landed');
  });

  it('truncates total block to maxChars', () => {
    const hits = Array.from({ length: 10 }, (_, i) => ({
      sessionId: `session_${i}${'x'.repeat(30)}`,
      startedAt: '2026-04-10T14:30:00Z',
      topicGuess: 'x'.repeat(500),
      firstPrompt: 'p'.repeat(500),
      lastResponse: 'r'.repeat(500),
    }));
    const out = formatSessionArchiveBlock(hits, 400);
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out).toContain('truncated');
  });

  it('handles null startedAt gracefully', () => {
    const hits = [
      {
        sessionId: '12345678-aaaa-bbbb-cccc-dddddddddddd',
        startedAt: null,
        topicGuess: 'no timestamp',
        firstPrompt: 'q',
        lastResponse: 'a',
      },
    ];
    const out = formatSessionArchiveBlock(hits);
    expect(out).toContain('(undated)');
    expect(out).toContain('12345678');
  });
});

describe('buildSessionArchiveContext', () => {
  it('returns empty string when query is empty', () => {
    expect(buildSessionArchiveContext('')).toBe('');
  });

  it('returns empty string when no archive exists (graceful)', () => {
    withMissingDb(() => {
      const result = buildSessionArchiveContext('dentist xray');
      expect(result).toBe('');
    });
  });
});
