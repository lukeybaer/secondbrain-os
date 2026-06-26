// core-memory-blocks-access.test.ts
//
// Covers the Letta-grade additions to core memory blocks: read-only access
// control, block descriptions as agent guidance, and occupancy reporting that
// drives proactive sleep-time refinement.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readBlock,
  writeBlock,
  appendBlock,
  blockOccupancy,
  allBlockOccupancy,
  renderBlocksForSystemPrompt,
} from '../core-memory-blocks';

describe('core-memory-blocks access control + descriptions + occupancy', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-blocks-access-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists and reads back description + read_only frontmatter', () => {
    writeBlock(dir, 'persona', 'EA to the owner.', 2000, {
      description: 'Who the assistant is; edit only via owner path',
      read_only: true,
    });
    const read = readBlock(dir, 'persona');
    expect(read?.description).toBe('Who the assistant is; edit only via owner path');
    expect(read?.read_only).toBe(true);
    expect(read?.content).toBe('EA to the owner.');
  });

  it('blocks the autonomous path from overwriting a read_only block', () => {
    writeBlock(dir, 'persona', 'original', 2000, { read_only: true });
    // agent path: no override -> denied
    expect(() => writeBlock(dir, 'persona', 'clobbered', 2000)).toThrow(/read-only/);
    expect(readBlock(dir, 'persona')?.content).toBe('original');
  });

  it('allows the owner/dev path to mutate a read_only block', () => {
    writeBlock(dir, 'persona', 'original', 2000, { read_only: true });
    writeBlock(dir, 'persona', 'updated', 2000, { allowReadOnlyOverride: true });
    expect(readBlock(dir, 'persona')?.content).toBe('updated');
    // read_only flag is preserved across the override write
    expect(readBlock(dir, 'persona')?.read_only).toBe(true);
  });

  it('appendBlock respects the read_only guard', () => {
    writeBlock(dir, 'persona', 'line one', 2000, { read_only: true });
    expect(() => appendBlock(dir, 'persona', 'line two')).toThrow(/read-only/);
  });

  it('preserves description when a later write omits it', () => {
    writeBlock(dir, 'human', 'Owner profile v1.', 2000, { description: 'facts about owner' });
    writeBlock(dir, 'human', 'Owner profile v2.', 2000);
    expect(readBlock(dir, 'human')?.description).toBe('facts about owner');
  });

  it('renders the description as guidance in the system prompt', () => {
    writeBlock(dir, 'human', 'Owner profile.', 2000, { description: 'facts about owner' });
    const rendered = renderBlocksForSystemPrompt(dir, { blocks: ['human'] });
    expect(rendered.text).toContain('_facts about owner_');
    expect(rendered.text).toContain('Owner profile.');
  });

  it('reports occupancy ratio against the limit', () => {
    writeBlock(dir, 'scratchpad', 'x'.repeat(50), 100);
    const occ = blockOccupancy(dir, 'scratchpad');
    expect(occ?.used).toBe(50);
    expect(occ?.limit).toBe(100);
    expect(occ?.ratio).toBeCloseTo(0.5, 5);
  });

  it('allBlockOccupancy lists every block and flags read_only', () => {
    writeBlock(dir, 'a', 'aa', 100);
    writeBlock(dir, 'b', 'bbbb', 100, { read_only: true });
    const all = allBlockOccupancy(dir);
    expect(all.map((o) => o.name).sort()).toEqual(['a', 'b']);
    expect(all.find((o) => o.name === 'b')?.read_only).toBe(true);
    expect(all.find((o) => o.name === 'a')?.read_only).toBe(false);
  });

  it('returns null occupancy for a missing block', () => {
    expect(blockOccupancy(dir, 'nope')).toBeNull();
  });
});
