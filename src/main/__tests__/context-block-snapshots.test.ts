import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  snapshotBlock,
  listSnapshots,
  readSnapshotContent,
  revertBlock,
  diffSnapshots,
  diffStrings,
  writeBlockWithSnapshot,
} from '../context-block-snapshots';

function tempBlockDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'block-snap-'));
}

describe('snapshotBlock', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempBlockDir();
  });

  it('writes content-addressed snapshot and appends manifest line', () => {
    const entry = snapshotBlock(dir, 'persona', 'hello world\n', { by: 'amy' });
    expect(entry.hash).toHaveLength(64);
    expect(entry.parent_hash).toBeNull();
    expect(entry.byte_len).toBe(12);
    const manifest = listSnapshots(dir, 'persona');
    expect(manifest).toHaveLength(1);
    expect(manifest[0].hash).toBe(entry.hash);
    const content = readSnapshotContent(dir, 'persona', entry.hash);
    expect(content).toBe('hello world\n');
  });

  it('is idempotent for identical content (no duplicate manifest line)', () => {
    const e1 = snapshotBlock(dir, 'persona', 'same', { by: 'amy' });
    const e2 = snapshotBlock(dir, 'persona', 'same', { by: 'amy' });
    expect(e1.hash).toBe(e2.hash);
    expect(listSnapshots(dir, 'persona')).toHaveLength(1);
  });

  it('links subsequent snapshots via parent_hash', () => {
    const e1 = snapshotBlock(dir, 'persona', 'v1', { by: 'amy' });
    const e2 = snapshotBlock(dir, 'persona', 'v2', { by: 'amy' });
    const e3 = snapshotBlock(dir, 'persona', 'v3', { by: 'amy' });
    expect(e2.parent_hash).toBe(e1.hash);
    expect(e3.parent_hash).toBe(e2.hash);
  });

  it('rejects unsafe block names', () => {
    expect(() =>
      snapshotBlock(dir, '../etc', 'x', { by: 'amy' }),
    ).toThrow(/invalid block name/);
    expect(() =>
      snapshotBlock(dir, 'has space', 'x', { by: 'amy' }),
    ).toThrow(/invalid block name/);
  });

  it('records note + by + timestamp in the entry', () => {
    const now = new Date('2026-05-11T12:00:00Z');
    const entry = snapshotBlock(dir, 'persona', 'content', {
      by: 'claude-code',
      note: 'initial draft',
      now,
    });
    expect(entry.ts).toBe('2026-05-11T12:00:00.000Z');
    expect(entry.by).toBe('claude-code');
    expect(entry.note).toBe('initial draft');
  });

  it('prunes oldest snapshots beyond retain limit', () => {
    for (let i = 0; i < 6; i++) {
      snapshotBlock(dir, 'persona', `v${i}`, { by: 'amy', retain: 3 });
    }
    const snaps = listSnapshots(dir, 'persona');
    expect(snaps).toHaveLength(3);
    // Pruned files should be gone from disk
    const dirEntries = fs.readdirSync(path.join(dir, '.snapshots', 'persona'));
    const mdFiles = dirEntries.filter((f) => f.endsWith('.md'));
    expect(mdFiles).toHaveLength(3);
  });

  it('retain=0 disables pruning', () => {
    for (let i = 0; i < 5; i++) {
      snapshotBlock(dir, 'persona', `v${i}`, { by: 'amy', retain: 0 });
    }
    expect(listSnapshots(dir, 'persona')).toHaveLength(5);
  });
});

describe('listSnapshots', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempBlockDir();
  });

  it('returns empty when block has no history', () => {
    expect(listSnapshots(dir, 'absent')).toEqual([]);
  });

  it('skips malformed manifest lines', () => {
    snapshotBlock(dir, 'persona', 'ok', { by: 'amy' });
    const mp = path.join(dir, '.snapshots', 'persona', 'manifest.jsonl');
    fs.appendFileSync(mp, '{broken\nnot json\n');
    snapshotBlock(dir, 'persona', 'two', { by: 'amy' });
    const snaps = listSnapshots(dir, 'persona');
    expect(snaps).toHaveLength(2);
  });

  it('drops entries missing required fields', () => {
    snapshotBlock(dir, 'persona', 'ok', { by: 'amy' });
    const mp = path.join(dir, '.snapshots', 'persona', 'manifest.jsonl');
    fs.appendFileSync(
      mp,
      JSON.stringify({ hash: 'abc', ts: '2026-05-11T01:00:00Z' }) + '\n',
    );
    expect(listSnapshots(dir, 'persona')).toHaveLength(1);
  });
});

describe('readSnapshotContent', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempBlockDir();
  });

  it('returns null for missing hash', () => {
    snapshotBlock(dir, 'persona', 'ok', { by: 'amy' });
    expect(readSnapshotContent(dir, 'persona', 'a'.repeat(64))).toBeNull();
  });

  it('rejects non-hex hash without touching fs', () => {
    expect(readSnapshotContent(dir, 'persona', 'not-a-hash')).toBeNull();
    expect(readSnapshotContent(dir, 'persona', '../etc/passwd')).toBeNull();
  });
});

describe('revertBlock', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempBlockDir();
  });

  it('restores content from a prior snapshot and audits the revert', () => {
    const e1 = snapshotBlock(dir, 'persona', 'good version', { by: 'amy' });
    snapshotBlock(dir, 'persona', 'BAD overwrite', { by: 'rogue' });
    const { content, entry } = revertBlock(dir, 'persona', e1.hash, { by: 'amy' });
    expect(content).toBe('good version');
    // The revert creates a NEW manifest entry whose hash equals e1.hash
    expect(entry.hash).toBe(e1.hash);
    expect(entry.note).toMatch(/^revert to /);
    const snaps = listSnapshots(dir, 'persona');
    expect(snaps).toHaveLength(3);
    expect(snaps[snaps.length - 1].hash).toBe(e1.hash);
  });

  it('throws when hash is unknown', () => {
    expect(() =>
      revertBlock(dir, 'persona', 'b'.repeat(64), { by: 'amy' }),
    ).toThrow(/snapshot not found/);
  });

  it('respects caller-supplied note over default', () => {
    const e1 = snapshotBlock(dir, 'persona', 'v1', { by: 'amy' });
    snapshotBlock(dir, 'persona', 'v2', { by: 'amy' });
    const { entry } = revertBlock(dir, 'persona', e1.hash, {
      by: 'amy',
      note: 'undo rogue write',
    });
    expect(entry.note).toBe('undo rogue write');
  });
});

describe('diffSnapshots / diffStrings', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempBlockDir();
  });

  it('reports added and removed lines', () => {
    const e1 = snapshotBlock(dir, 'persona', 'a\nb\nc\n', { by: 'amy' });
    const e2 = snapshotBlock(dir, 'persona', 'a\nb\nd\n', { by: 'amy' });
    const d = diffSnapshots(dir, 'persona', e1.hash, e2.hash);
    expect(d.added).toContain('d');
    expect(d.removed).toContain('c');
    expect(d.unchanged_lines).toBeGreaterThanOrEqual(2);
  });

  it('zero diff for identical content', () => {
    const d = diffStrings('a\nb\nc\n', 'a\nb\nc\n');
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.unchanged_lines).toBeGreaterThanOrEqual(3);
  });

  it('full-replace surfaces all lines as added/removed', () => {
    const d = diffStrings('old1\nold2\n', 'new1\nnew2\n');
    expect(d.added.sort()).toEqual(['new1', 'new2']);
    expect(d.removed.sort()).toEqual(['old1', 'old2']);
  });

  it('throws when either hash is unknown', () => {
    const e1 = snapshotBlock(dir, 'persona', 'a\n', { by: 'amy' });
    expect(() =>
      diffSnapshots(dir, 'persona', e1.hash, 'c'.repeat(64)),
    ).toThrow(/snapshot not found/);
    expect(() =>
      diffSnapshots(dir, 'persona', 'c'.repeat(64), e1.hash),
    ).toThrow(/snapshot not found/);
  });

  it('handles CRLF and LF line endings symmetrically', () => {
    const d = diffStrings('a\r\nb\r\n', 'a\nb\nc\n');
    // Same a, b on both sides (one trailing empty line on left, c+empty on right)
    expect(d.added).toContain('c');
    expect(d.removed).toEqual([]);
  });
});

describe('writeBlockWithSnapshot', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempBlockDir();
  });

  it('writes live block file AND records snapshot in one call', () => {
    const entry = writeBlockWithSnapshot(dir, 'persona', 'live content\n', {
      by: 'amy',
    });
    const liveFile = path.join(dir, 'persona.md');
    expect(fs.existsSync(liveFile)).toBe(true);
    expect(fs.readFileSync(liveFile, 'utf8')).toBe('live content\n');
    expect(listSnapshots(dir, 'persona')).toHaveLength(1);
    expect(entry.byte_len).toBe(13);
  });

  it('creates the block dir if absent', () => {
    const fresh = path.join(dir, 'nested');
    writeBlockWithSnapshot(fresh, 'persona', 'x', { by: 'amy' });
    expect(fs.existsSync(path.join(fresh, 'persona.md'))).toBe(true);
  });

  it('rejects unsafe names without writing anything', () => {
    expect(() =>
      writeBlockWithSnapshot(dir, '../etc', 'x', { by: 'amy' }),
    ).toThrow(/invalid block name/);
    // No partial state left behind
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.md'))).toHaveLength(0);
  });
});
