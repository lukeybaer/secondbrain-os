/**
 * Tests for scripts/skill-lessons.js, the self-refining LESSONS.md loop.
 *
 * Validates: append, read-recent, lessons-as-context, file scaffolding.
 * Frugal regression tests, tiny inputs, isolated tmp dir, no real skills touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ORIGINAL_ROOT = process.env.SECONDBRAIN_ROOT;
let tmpRoot: string;

function loadModuleFresh() {
  const modPath = require.resolve('../../../scripts/skill-lessons.js');
  delete require.cache[modPath];
  return require('../../../scripts/skill-lessons.js');
}

describe('skill-lessons', () => {
  let mod: any;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-lessons-'));
    fs.mkdirSync(path.join(tmpRoot, 'scheduled-tasks', 'demo-skill'), { recursive: true });
    process.env.SECONDBRAIN_ROOT = tmpRoot;
    mod = loadModuleFresh();
  });

  afterEach(() => {
    if (ORIGINAL_ROOT === undefined) delete process.env.SECONDBRAIN_ROOT;
    else process.env.SECONDBRAIN_ROOT = ORIGINAL_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates LESSONS.md on first append with header', () => {
    mod.appendLesson('demo-skill', { input: 'short prompt', outcome: 'shipped 4 videos' });
    const file = path.join(tmpRoot, 'scheduled-tasks', 'demo-skill', 'LESSONS.md');
    expect(fs.existsSync(file)).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('# demo-skill LESSONS');
    expect(text).toContain('- input: short prompt');
    expect(text).toContain('- outcome: shipped 4 videos');
  });

  it('appendLesson rejects missing input or outcome', () => {
    expect(() => mod.appendLesson('demo-skill', { input: '', outcome: 'x' })).toThrow();
    expect(() => mod.appendLesson('demo-skill', { input: 'x', outcome: '' })).toThrow();
  });

  it('readRecentLessons returns the last N entries in chronological order', () => {
    for (let i = 1; i <= 12; i++) {
      mod.appendLesson('demo-skill', { input: `in-${i}`, outcome: `out-${i}` });
    }
    const last10 = mod.readRecentLessons('demo-skill', 10);
    expect(last10).toHaveLength(10);
    expect(last10[0].input).toBe('in-3');
    expect(last10[9].input).toBe('in-12');
  });

  it('readRecentLessons returns empty array when LESSONS.md does not exist', () => {
    expect(mod.readRecentLessons('demo-skill')).toEqual([]);
  });

  it('lessonsAsContext returns formatted prompt fragment', () => {
    mod.appendLesson('demo-skill', { input: 'short script', outcome: 'rejected, too dry' });
    mod.appendLesson('demo-skill', { input: 'punchy hook script', outcome: 'approved' });
    const ctx = mod.lessonsAsContext('demo-skill', 10);
    expect(ctx).toContain('Lessons from the last 2 runs of demo-skill');
    expect(ctx).toContain('short script -> rejected, too dry');
    expect(ctx).toContain('punchy hook script -> approved');
    expect(ctx).toContain('Apply these lessons.');
  });

  it('lessonsAsContext returns empty string when no LESSONS.md', () => {
    expect(mod.lessonsAsContext('demo-skill')).toBe('');
  });

  it('strips newlines from input and outcome so entries stay 2-line', () => {
    mod.appendLesson('demo-skill', { input: 'line1\nline2', outcome: 'a\r\nb' });
    const text = fs.readFileSync(path.join(tmpRoot, 'scheduled-tasks', 'demo-skill', 'LESSONS.md'), 'utf8');
    expect(text).toContain('- input: line1 line2');
    expect(text).toContain('- outcome: a b');
  });

  it('throws if skill directory is missing', () => {
    expect(() => mod.appendLesson('does-not-exist', { input: 'x', outcome: 'y' })).toThrow();
  });
});
