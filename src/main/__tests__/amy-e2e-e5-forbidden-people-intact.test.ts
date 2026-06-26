/**
 * E5-R2 (Amy E2E overhaul manifest): the forbidden-people privacy backstop
 * survived the E5 retry-queue change.
 *
 * Category under test: durable memory writes (upsertMemory and
 * appendWorkingMemory) must still throw ForbiddenContentError for every name
 * on the zero-tolerance list. The names come from the SAME source the code
 * enforces with (FORBIDDEN_PEOPLE in output-critic-rules), so a list change
 * is covered automatically instead of drifting from a hardcoded copy here.
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

const mockAddEpisode = vi.fn().mockResolvedValue(true);
vi.mock('../graphiti-client', () => ({
  addEpisode: (...args: ExampleCo[]) => mockAddEpisode(...args),
  isGraphitiAvailable: vi.fn().mockResolvedValue(true),
}));

import { FORBIDDEN_PEOPLE } from '../output-critic-rules';
import {
  upsertMemory,
  appendWorkingMemory,
  readWorkingMemory,
  ForbiddenContentError,
} from '../memory-index';

const memoryDir = () => path.join(testRoot, 'data', 'agent', 'memory');

beforeEach(async () => {
  testRoot = path.join(
    os.tmpdir(),
    `sb-forbidden-e5-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fsp.mkdir(path.join(memoryDir(), 'archive'), { recursive: true });
  // Cascade enabled so the test also proves the guard fires BEFORE the
  // Graphiti cascade (and before the spool) can see forbidden content.
  process.env.SECONDBRAIN_GRAPHITI_CASCADE_UNDER_TEST = '1';
  mockAddEpisode.mockClear();
});

describe('E5-R2 forbidden-people backstop intact', () => {
  it('the rule source still ExampleCos a non-empty forbidden list', () => {
    expect(FORBIDDEN_PEOPLE.length).toBeGreaterThan(0);
  });

  for (const name of FORBIDDEN_PEOPLE) {
    it(`upsertMemory refuses content mentioning "${name}" with no side effects`, async () => {
      expect(() => upsertMemory('e5-privacy-topic', `Lunch with ${name} on Friday.`)).toThrow(
        ForbiddenContentError,
      );
      expect(fs.readdirSync(memoryDir())).not.toContain('e5-privacy-topic.md');
      await new Promise((r) => setTimeout(r, 10));
      expect(mockAddEpisode).not.toHaveBeenCalled();
    });

    it(`appendWorkingMemory refuses a line mentioning "${name}"`, () => {
      const before = readWorkingMemory();
      expect(() => appendWorkingMemory(`Note about ${name}.`)).toThrow(ForbiddenContentError);
      expect(readWorkingMemory()).toBe(before);
    });
  }

  it('clean content still persists normally', () => {
    const entry = upsertMemory('e5-clean-topic', `clean content ${Date.now()}-${Math.random()}`);
    expect(fs.existsSync(path.join(memoryDir(), entry.file))).toBe(true);
  });
});
