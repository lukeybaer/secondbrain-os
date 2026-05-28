import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolvePathWithinBase } from '../path-guard';

describe('resolvePathWithinBase', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'path-guard-'));
  const nested = path.join(base, 'data', 'nested');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'file.txt'), 'ok');

  it('allows a normal subpath', () => {
    const resolved = resolvePathWithinBase(base, path.join('data', 'nested', 'file.txt'));
    expect(resolved).toBe(path.resolve(base, 'data', 'nested', 'file.txt'));
    expect(fs.readFileSync(resolved, 'utf-8')).toBe('ok');
  });

  it('rejects ../../../etc/passwd style escape', () => {
    expect(() => resolvePathWithinBase(base, '../../../etc/passwd')).toThrow(
      /escapes base directory/,
    );
  });

  it('rejects an absolute path outside the base', () => {
    const outside = path.resolve(base, '..', 'outside-path-guard');
    expect(() => resolvePathWithinBase(base, outside)).toThrow(/escapes base directory/);
  });

  it('allows .. segments that stay inside the base', () => {
    const resolved = resolvePathWithinBase(
      path.join(base, 'data', 'nested'),
      path.join('..', 'nested', 'file.txt'),
    );
    expect(resolved).toBe(path.join(base, 'data', 'nested', 'file.txt'));
  });

  it('treats empty string as the base directory', () => {
    expect(resolvePathWithinBase(base, '')).toBe(path.resolve(base));
  });

  it('allows an absolute path inside the base', () => {
    const absoluteInside = path.join(nested, 'file.txt');
    expect(resolvePathWithinBase(base, absoluteInside)).toBe(path.resolve(absoluteInside));
  });
});
