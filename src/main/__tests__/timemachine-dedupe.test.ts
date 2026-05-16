import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TimeMachineDedupe } from '../timemachine-dedupe';

let dir: string;

function writeFile(name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dedupe-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Time Machine dedupe', () => {
  it('returns duplicate for identical sampled fingerprints', () => {
    const dedupe = new TimeMachineDedupe({
      enabled: true,
      sizeDriftThreshold: 0.05,
      chunkBytes: 4,
      recentWindowSize: 5,
    });
    const a = writeFile('a.jpg', 'abcdefghijklmnop');
    const b = writeFile('b.jpg', 'abcdefghijklmnop');
    expect(dedupe.check(a, fs.statSync(a).size)).toBe(false);
    expect(dedupe.check(b, fs.statSync(b).size)).toBe(true);
  });

  it('returns not duplicate for size drift beyond threshold', () => {
    const dedupe = new TimeMachineDedupe({
      enabled: true,
      sizeDriftThreshold: 0.05,
      chunkBytes: 4,
      recentWindowSize: 5,
    });
    const a = writeFile('a.jpg', 'abcdefghijklmnop');
    const b = writeFile('b.jpg', 'abcdefghijklmnopqrstuvwxyz');
    expect(dedupe.check(a, fs.statSync(a).size)).toBe(false);
    expect(dedupe.check(b, fs.statSync(b).size)).toBe(false);
  });

  it('checks the recent fingerprint window, not only the last frame', () => {
    const dedupe = new TimeMachineDedupe({
      enabled: true,
      sizeDriftThreshold: 0.05,
      chunkBytes: 4,
      recentWindowSize: 3,
    });
    const a = writeFile('a.jpg', 'abcdefghijklmnop');
    const b = writeFile('b.jpg', 'zzzzzzzzzzzzzzzz');
    const c = writeFile('c.jpg', 'abcdefghijklmnop');
    expect(dedupe.check(a, fs.statSync(a).size)).toBe(false);
    expect(dedupe.check(b, fs.statSync(b).size)).toBe(false);
    expect(dedupe.check(c, fs.statSync(c).size)).toBe(true);
  });
});

