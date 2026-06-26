/**
 * Regression: the no-ex-wife-tracking privacy rule must hold at the durable
 * memory boundary, not only in the (orphaned) output-side critics.
 *
 * Category under test: content carrying a forbidden ex-spouse name (Andrea,
 * Julia, Marie-Louise) must never be persisted to Tier 2 memory, never enter
 * the Graphiti cascade, and never land in working memory. The guard is
 * word-boundary aware so legitimate near-collisions (Andreas, Juliana) pass.
 *
 * This pins the WIRING (upsertMemory / appendWorkingMemory refuse the write),
 * not a single literal trigger: every forbidden name plus a couple of
 * near-collisions are exercised.
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

// Import after the electron mock so memory-index resolves paths to testRoot.
import {
  upsertMemory,
  appendWorkingMemory,
  readWorkingMemory,
  loadIndex,
  ForbiddenContentError,
} from '../memory-index';

beforeEach(async () => {
  testRoot = path.join(
    os.tmpdir(),
    `sb-forbidden-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fsp.mkdir(path.join(testRoot, 'data', 'agent', 'memory', 'archive'), {
    recursive: true,
  });
});

const memoryDir = () => path.join(testRoot, 'data', 'agent', 'memory');

describe('upsertMemory forbidden-name backstop', () => {
  for (const name of ['Andrea', 'Julia', 'Marie-Louise']) {
    it(`refuses content mentioning "${name}" and writes nothing`, () => {
      expect(() => upsertMemory('contact-notes', `Dinner plans with ${name} next week.`)).toThrow(
        ForbiddenContentError,
      );

      // No tier-2 file and no index entry for the rejected topic.
      const files = fs.readdirSync(memoryDir());
      expect(files).not.toContain('contact-notes.md');
      const idx = loadIndex();
      expect(idx.entries.find((e) => e.topic === 'contact-notes')).toBeUndefined();
    });

    it(`refuses when "${name}" appears in the topic, not the body`, () => {
      expect(() => upsertMemory(`${name} schedule`, 'harmless body')).toThrow(
        ForbiddenContentError,
      );
    });
  }

  it('persists normally when no forbidden name is present', () => {
    const entry = upsertMemory('project-x', 'Kickoff is Monday with the new vendor.');
    expect(entry.topic).toBe('project-x');
    expect(fs.existsSync(path.join(memoryDir(), 'project-x.md'))).toBe(true);
  });

  for (const ok of ['Andreas', 'Juliana', 'Julian']) {
    it(`does not false-trip on the near-collision "${ok}"`, () => {
      expect(() => upsertMemory('team', `${ok} shipped the release on time.`)).not.toThrow();
    });
  }

  it('exposes the matched name(s) on the thrown error', () => {
    try {
      upsertMemory('notes', 'Call Andrea about the thing.');
      throw new Error('expected ForbiddenContentError');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenContentError);
      expect((err as ForbiddenContentError).matches).toContain('Andrea');
    }
  });
});

describe('appendWorkingMemory forbidden-name backstop', () => {
  it('refuses a forbidden line and leaves working memory unchanged', () => {
    appendWorkingMemory('Normal pointer line one.');
    const before = readWorkingMemory();
    expect(() => appendWorkingMemory('Met Marie-Louise for coffee.')).toThrow(
      ForbiddenContentError,
    );
    expect(readWorkingMemory()).toBe(before);
  });

  it('appends normally for clean lines', () => {
    appendWorkingMemory('Quarterly review pointer.');
    expect(readWorkingMemory()).toMatch(/Quarterly review pointer\./);
  });
});
