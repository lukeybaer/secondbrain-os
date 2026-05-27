/**
 * Tests for scripts/skill-runner-wrap.js, the universal wrapper that injects
 * LESSONS.md context pre-run and appends a lesson post-run.
 *
 * Frugal: isolated tmp dir, no real skill state touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ORIGINAL_ROOT = process.env.SECONDBRAIN_ROOT;
let tmpRoot: string;

function loadModuleFresh() {
  const wrapPath = require.resolve('../../../scripts/skill-runner-wrap.js');
  const lessonsPath = require.resolve('../../../scripts/skill-lessons.js');
  delete require.cache[wrapPath];
  delete require.cache[lessonsPath];
  return require('../../../scripts/skill-runner-wrap.js');
}

describe('skill-runner-wrap', () => {
  let wrap: any;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-runner-wrap-'));
    fs.mkdirSync(path.join(tmpRoot, 'scheduled-tasks', 'demo-skill'), { recursive: true });
    process.env.SECONDBRAIN_ROOT = tmpRoot;
    wrap = loadModuleFresh();
  });

  afterEach(() => {
    if (ORIGINAL_ROOT === undefined) delete process.env.SECONDBRAIN_ROOT;
    else process.env.SECONDBRAIN_ROOT = ORIGINAL_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('runWithLessons passes lesson context to the run function and records outcome', async () => {
    let receivedContext: string | undefined;
    const result = await wrap.runWithLessons('demo-skill', {
      input: 'test input',
      run: async (ctx: any) => {
        receivedContext = ctx.lessonsContext;
        return { outcome: 'success: 1 thing', returnValue: 42 };
      },
    });
    expect(result.returnValue).toBe(42);
    expect(receivedContext).toBe('');
    const file = path.join(tmpRoot, 'scheduled-tasks', 'demo-skill', 'LESSONS.md');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('- input: test input');
    expect(text).toContain('- outcome: success: 1 thing');
  });

  it('runWithLessons injects prior lessons into context on subsequent runs', async () => {
    await wrap.runWithLessons('demo-skill', {
      input: 'first input',
      run: async () => ({ outcome: 'first outcome', returnValue: null }),
    });
    let captured = '';
    await wrap.runWithLessons('demo-skill', {
      input: 'second input',
      run: async (ctx: any) => {
        captured = ctx.lessonsContext;
        return { outcome: 'second outcome', returnValue: null };
      },
    });
    expect(captured).toContain('Lessons from the last 1 runs of demo-skill');
    expect(captured).toContain('first input -> first outcome');
  });

  it('runWithLessons records failure outcome when the run function throws', async () => {
    await expect(
      wrap.runWithLessons('demo-skill', {
        input: 'will throw',
        run: async () => {
          throw new Error('boom');
        },
      })
    ).rejects.toThrow('boom');
    const file = path.join(tmpRoot, 'scheduled-tasks', 'demo-skill', 'LESSONS.md');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('- input: will throw');
    expect(text).toMatch(/- outcome: FAILED:.*boom/);
  });

  it('runWithLessons accepts custom contextDepth', async () => {
    for (let i = 1; i <= 5; i++) {
      await wrap.runWithLessons('demo-skill', {
        input: `in-${i}`,
        run: async () => ({ outcome: `out-${i}`, returnValue: null }),
      });
    }
    let captured = '';
    await wrap.runWithLessons('demo-skill', {
      input: 'sixth',
      contextDepth: 2,
      run: async (ctx: any) => {
        captured = ctx.lessonsContext;
        return { outcome: 'sixth-out', returnValue: null };
      },
    });
    expect(captured).toContain('last 2 runs');
    expect(captured).toContain('in-4 -> out-4');
    expect(captured).toContain('in-5 -> out-5');
    expect(captured).not.toContain('in-3');
  });
});
