import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readBlock,
  writeBlock,
  appendBlock,
  listBlocks,
  DEFAULT_BLOCK_LIMIT,
} from '../core-memory-blocks';

describe('core-memory-blocks', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-blocks-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes and reads a block with frontmatter', () => {
    const written = writeBlock(dir, 'persona', 'Amy, EA to Luke.');
    expect(written.name).toBe('persona');
    expect(written.limit).toBe(DEFAULT_BLOCK_LIMIT);

    const read = readBlock(dir, 'persona');
    expect(read?.content).toBe('Amy, EA to Luke.');
    expect(read?.limit).toBe(DEFAULT_BLOCK_LIMIT);
    expect(read?.updated_at).toBe(written.updated_at);
  });

  it('returns null for missing blocks', () => {
    expect(readBlock(dir, 'ghost')).toBeNull();
  });

  it('rejects oversized content', () => {
    expect(() => writeBlock(dir, 'tiny', 'abcdef', 3)).toThrow(/exceeds limit/);
  });

  it('rejects unsafe names', () => {
    expect(() => writeBlock(dir, '../evil', 'x')).toThrow(/invalid/);
  });

  it('appends a line preserving limit', () => {
    writeBlock(dir, 'scratch', 'first line', 500);
    appendBlock(dir, 'scratch', 'second line');
    const read = readBlock(dir, 'scratch');
    expect(read?.content).toBe('first line\nsecond line');
    expect(read?.limit).toBe(500);
  });

  it('lists blocks alphabetically', () => {
    writeBlock(dir, 'zulu', 'z');
    writeBlock(dir, 'alpha', 'a');
    writeBlock(dir, 'mike', 'm');
    expect(listBlocks(dir)).toEqual(['alpha', 'mike', 'zulu']);
  });
});
