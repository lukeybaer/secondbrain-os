import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readBlock,
  writeBlock,
  appendBlock,
  listBlocks,
  renderBlocksForSystemPrompt,
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
    const written = writeBlock(dir, 'persona', 'Amy, EA to the owner.');
    expect(written.name).toBe('persona');
    expect(written.limit).toBe(DEFAULT_BLOCK_LIMIT);

    const read = readBlock(dir, 'persona');
    expect(read?.content).toBe('Amy, EA to the owner.');
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

  describe('renderBlocksForSystemPrompt', () => {
    it('renders requested blocks in order with labeled headers', () => {
      writeBlock(dir, 'persona', 'Amy, EA.');
      writeBlock(dir, 'human', 'Luke, owner.');
      const rendered = renderBlocksForSystemPrompt(dir, {
        blocks: ['persona', 'human'],
      });
      expect(rendered.text).toContain('# Core memory');
      expect(rendered.text).toContain('## persona\nAmy, EA.');
      expect(rendered.text).toContain('## human\nLuke, owner.');
      // persona must appear before human (order preserved)
      expect(rendered.text.indexOf('## persona')).toBeLessThan(
        rendered.text.indexOf('## human'),
      );
      expect(rendered.included).toEqual(['persona', 'human']);
      expect(rendered.skipped).toEqual([]);
      expect(rendered.truncated).toBe(false);
    });

    it('records skipped blocks instead of erroring on missing names', () => {
      writeBlock(dir, 'persona', 'Amy.');
      const rendered = renderBlocksForSystemPrompt(dir, {
        blocks: ['persona', 'ghost', 'phantom'],
      });
      expect(rendered.included).toEqual(['persona']);
      expect(rendered.skipped).toEqual(['ghost', 'phantom']);
      expect(rendered.text).not.toContain('ghost');
    });

    it('skips empty blocks silently', () => {
      writeBlock(dir, 'persona', 'Amy.');
      writeBlock(dir, 'scratch', '   ');
      const rendered = renderBlocksForSystemPrompt(dir, {
        blocks: ['persona', 'scratch'],
      });
      expect(rendered.included).toEqual(['persona']);
      expect(rendered.skipped).toContain('scratch');
    });

    it('returns an empty string when all blocks are missing', () => {
      const rendered = renderBlocksForSystemPrompt(dir, {
        blocks: ['nope'],
      });
      expect(rendered.text).toBe('');
      expect(rendered.included).toEqual([]);
      expect(rendered.total_bytes).toBe(0);
    });

    it('truncates when blocks exceed maxChars', () => {
      writeBlock(dir, 'first', 'x'.repeat(500));
      writeBlock(dir, 'second', 'y'.repeat(500));
      const rendered = renderBlocksForSystemPrompt(dir, {
        blocks: ['first', 'second'],
        maxChars: 200,
      });
      expect(rendered.truncated).toBe(true);
      // second block must NOT be fully present
      expect(rendered.text).not.toContain('y'.repeat(500));
    });

    it('allows omitting the section header', () => {
      writeBlock(dir, 'persona', 'Amy.');
      const rendered = renderBlocksForSystemPrompt(dir, {
        blocks: ['persona'],
        header: '',
      });
      expect(rendered.text.startsWith('## persona')).toBe(true);
      expect(rendered.text).not.toContain('# Core memory');
    });
  });
});
