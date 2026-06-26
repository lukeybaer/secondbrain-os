/**
 * Tests for scripts/skill-run-wrapper.js -- the glue that chains
 * skill-lessons + skill-predictions + skill-harness-baseline into one
 * self-refining execution unit.
 *
 * Frugal regression tests: tmp scheduled-tasks dir, real SKILL.md file,
 * no scheduled-task runner invoked, no LLM calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ORIGINAL_ROOT = process.env.SECONDBRAIN_ROOT;
let tmpRoot: string;

function loadFreshWrapper() {
  for (const rel of [
    '../../../scripts/skill-run-wrapper.js',
    '../../../scripts/skill-lessons.js',
    '../../../scripts/skill-predictions.js',
    '../../../scripts/skill-harness-baseline.js',
  ]) {
    const p = require.resolve(rel);
    delete require.cache[p];
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../../../scripts/skill-run-wrapper.js');
}

function scaffold(skillName: string) {
  const dir = path.join(tmpRoot, 'scheduled-tasks', skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${skillName}\n\nA test skill.\n`);
  return dir;
}

describe('skill-run-wrapper', () => {
  let wrapper: any;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-run-wrapper-'));
    fs.mkdirSync(path.join(tmpRoot, 'data', 'agent'), { recursive: true });
    process.env.SECONDBRAIN_ROOT = tmpRoot;
    wrapper = loadFreshWrapper();
  });

  afterEach(() => {
    if (ORIGINAL_ROOT === undefined) delete process.env.SECONDBRAIN_ROOT;
    else process.env.SECONDBRAIN_ROOT = ORIGINAL_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('runs the supplied function and returns the actual outcome', async () => {
    scaffold('demo-skill');
    const result = await wrapper.wrapSkillRun({
      skillName: 'demo-skill',
      runId: 'run-001',
      expected: { count: 4 },
      input: 'test input',
      run: async () => ({ count: 4 }),
      summarize: (a: any) => `shipped ${a.count}`,
    });
    expect(result.ok).toBe(true);
    expect(result.actual).toEqual({ count: 4 });
    expect(result.allMatched).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.outcomeText).toBe('shipped 4');
  });

  it('writes the prediction file BEFORE the run executes', async () => {
    scaffold('demo-skill');
    const calls: string[] = [];
    await wrapper.wrapSkillRun({
      skillName: 'demo-skill',
      runId: 'run-002',
      expected: { count: 3 },
      input: 'pre-run check',
      run: async () => {
        const file = path.join(tmpRoot, 'data', 'agent', 'predictions', 'demo-skill');
        if (fs.existsSync(file)) calls.push('prediction-existed');
        return { count: 3 };
      },
    });
    expect(calls).toContain('prediction-existed');
  });

  it('records actual outcome against prediction with a diff', async () => {
    scaffold('demo-skill');
    const result = await wrapper.wrapSkillRun({
      skillName: 'demo-skill',
      runId: 'run-003',
      expected: { count: 5 },
      input: 'mismatch test',
      run: async () => ({ count: 4 }),
    });
    expect(result.allMatched).toBe(false);
    expect(result.diff.count.expected).toBe(5);
    expect(result.diff.count.actual).toBe(4);
    expect(result.diff.count.match).toBe(false);
  });

  it('appends a LESSONS.md entry with the input and outcome', async () => {
    const dir = scaffold('demo-skill');
    await wrapper.wrapSkillRun({
      skillName: 'demo-skill',
      runId: 'run-004',
      expected: { count: 1 },
      input: 'short input',
      run: async () => ({ count: 1 }),
      summarize: () => 'all good',
    });
    const lessons = fs.readFileSync(path.join(dir, 'LESSONS.md'), 'utf8');
    expect(lessons).toContain('- input: short input');
    expect(lessons).toContain('- outcome: all good');
  });

  it('passes prior lessons into the run() body so the work can self-refine', async () => {
    const dir = scaffold('demo-skill');
    // Seed a prior lesson manually
    const seeded = `# demo-skill LESSONS\n\n## 2026-05-14T00:00:00.000Z\n- input: yesterday\n- outcome: short scripts rejected\n\n`;
    fs.writeFileSync(path.join(dir, 'LESSONS.md'), seeded);
    let receivedContext = '';
    let receivedPriorCount = -1;
    await wrapper.wrapSkillRun({
      skillName: 'demo-skill',
      runId: 'run-005',
      expected: { count: 1 },
      input: 'follow-up',
      run: async ({ priorLessons, priorLessonsContext }: any) => {
        receivedContext = priorLessonsContext;
        receivedPriorCount = priorLessons.length;
        return { count: 1 };
      },
    });
    expect(receivedPriorCount).toBe(1);
    expect(receivedContext).toContain('short scripts rejected');
    expect(receivedContext).toContain('Apply these lessons');
  });

  it('on first run with no baseline, saves the actual as the new baseline', async () => {
    const dir = scaffold('demo-skill');
    await wrapper.wrapSkillRun({
      skillName: 'demo-skill',
      runId: 'run-006',
      expected: { quality: 90 },
      input: 'first run',
      run: async () => ({ quality: 90 }),
    });
    const baselineFile = path.join(dir, 'harness-baseline.json');
    expect(fs.existsSync(baselineFile)).toBe(true);
    const data = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    expect(data.metrics.quality).toBe(90);
  });

  it('flags degraded=true when current metrics drop below baseline tolerance', async () => {
    const dir = scaffold('demo-skill');
    fs.writeFileSync(path.join(dir, 'harness-baseline.json'), JSON.stringify({
      skillName: 'demo-skill',
      skillHash: 'pretend',
      metrics: { quality: 90 },
      savedAt: '2026-05-01T00:00:00.000Z',
    }));
    const result = await wrapper.wrapSkillRun({
      skillName: 'demo-skill',
      runId: 'run-007',
      expected: { quality: 90 },
      input: 'degradation test',
      run: async () => ({ quality: 70 }),
    });
    expect(result.degraded).toBe(true);
    expect(result.baselineComparison.degradations[0].metric).toBe('quality');
  });

  it('records a FAIL lesson and re-throws when run() throws', async () => {
    const dir = scaffold('demo-skill');
    await expect(wrapper.wrapSkillRun({
      skillName: 'demo-skill',
      runId: 'run-008',
      expected: { count: 1 },
      input: 'crash test',
      run: async () => { throw new Error('disk full'); },
    })).rejects.toThrow('disk full');
    const lessonsText = fs.readFileSync(path.join(dir, 'LESSONS.md'), 'utf8');
    expect(lessonsText).toContain('crash test');
    expect(lessonsText).toContain('FAIL: disk full');
  });

  it('summarize default when no callback supplied is sensible', async () => {
    scaffold('demo-skill');
    const result = await wrapper.wrapSkillRun({
      skillName: 'demo-skill',
      runId: 'run-009',
      expected: { count: 1 },
      input: 'default summarize',
      run: async () => ({ count: 1 }),
    });
    expect(result.outcomeText).toContain('completed');
  });

  it('throws on missing required args', async () => {
    await expect(wrapper.wrapSkillRun({} as any)).rejects.toThrow('skillName');
    await expect(wrapper.wrapSkillRun({ skillName: 'x' } as any)).rejects.toThrow('runId');
    await expect(wrapper.wrapSkillRun({ skillName: 'x', runId: 'r' } as any)).rejects.toThrow('run()');
  });
});
