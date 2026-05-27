/**
 * Tests for scripts/skill-runner-hooks.js, Phase 5 of harness-evolution-loop.
 * Pure unit tests for the pre-run prompt builder and post-run outcome recorder.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ORIGINAL_ROOT = process.env.SECONDBRAIN_ROOT;
let tmpRoot: string;

function loadFresh() {
  const hooksPath = require.resolve('../../../scripts/skill-runner-hooks.js');
  const lessonsPath = require.resolve('../../../scripts/skill-lessons.js');
  delete require.cache[hooksPath];
  delete require.cache[lessonsPath];
  return require('../../../scripts/skill-runner-hooks.js');
}

describe('skill-runner-hooks', () => {
  let mod: any;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-runner-hooks-'));
    fs.mkdirSync(path.join(tmpRoot, 'scheduled-tasks', 'demo-skill'), { recursive: true });
    process.env.SECONDBRAIN_ROOT = tmpRoot;
    mod = loadFresh();
  });

  afterEach(() => {
    if (ORIGINAL_ROOT === undefined) delete process.env.SECONDBRAIN_ROOT;
    else process.env.SECONDBRAIN_ROOT = ORIGINAL_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('buildPromptWithLessons returns base prompt unchanged when no lessons exist', () => {
    const out = mod.buildPromptWithLessons('demo-skill', 'do the work');
    expect(out).toBe('do the work');
  });

  it('buildPromptWithLessons appends lessons block when entries exist', () => {
    const lessons = require('../../../scripts/skill-lessons.js');
    lessons.appendLesson('demo-skill', { input: 'in-1', outcome: 'OK: shipped' });
    const out = mod.buildPromptWithLessons('demo-skill', 'do the work');
    expect(out).toContain('do the work');
    expect(out).toContain('Prior lessons from this skill (auto-injected)');
    expect(out).toContain('in-1 -> OK: shipped');
    expect(out).toContain('End prior lessons');
  });

  it('deriveOutcome reports OK with tail on exit 0', () => {
    expect(mod.deriveOutcome({ exitCode: 0, output: 'line1\nline2\nline3\n' })).toMatch(
      /^OK: .*line[1-3]/
    );
    expect(mod.deriveOutcome({ exitCode: 0, output: '' })).toBe('OK');
  });

  it('deriveOutcome reports FAILED with exit code on nonzero', () => {
    expect(mod.deriveOutcome({ exitCode: 1, output: 'boom' })).toMatch(/^FAILED \(exit 1\)/);
    expect(mod.deriveOutcome({ exitCode: 137, output: '' })).toBe('FAILED (exit 137)');
  });

  it('recordSkillOutcome appends a lesson with derived outcome', () => {
    mod.recordSkillOutcome('demo-skill', {
      input: 'scheduled run at 03:00',
      exitCode: 0,
      output: 'shipped 4 videos\nall green\n',
    });
    const file = path.join(tmpRoot, 'scheduled-tasks', 'demo-skill', 'LESSONS.md');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('- input: scheduled run at 03:00');
    expect(text).toMatch(/- outcome: OK: .*shipped 4 videos/);
  });

  it('recordSkillOutcome truncates very long outputs to maxOutputChars', () => {
    const longLine = 'x'.repeat(2000);
    mod.recordSkillOutcome('demo-skill', {
      input: 'long',
      exitCode: 0,
      output: longLine,
      maxOutputChars: 50,
    });
    const file = path.join(tmpRoot, 'scheduled-tasks', 'demo-skill', 'LESSONS.md');
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(/- outcome: OK: (x+)/);
    expect(match).toBeTruthy();
    expect(match![1].length).toBeLessThanOrEqual(50);
  });
});
