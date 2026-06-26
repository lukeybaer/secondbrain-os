// memory-bm25-adaptive.test.ts
//
// Run-128 wiring: searchMemoryAdaptive consults the recall-depth planner to
// pick topK and returns the plan alongside results. Category guard: a short
// query pulls a small topK, a vague query pulls the deep topK, and results
// never exceed the planned topK.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { searchMemoryAdaptive, refreshIndex } from '../memory-bm25';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm25-adaptive-'));
  // Enough distinct files that a deep topK could return more than a shallow one.
  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(
      path.join(dir, `note-${i}.md`),
      `# Note ${i}\nThis note is about the acme deal history and widget analytics topic ${i}.\n`,
    );
  }
  refreshIndex(dir);
});

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('searchMemoryAdaptive', () => {
  it('uses a shallow plan and small topK for a short exact lookup', () => {
    const { plan, results } = searchMemoryAdaptive(dir, 'widget');
    expect(plan.depth).toBe('shallow');
    expect(plan.topK).toBe(3);
    expect(results.length).toBeLessThanOrEqual(plan.topK);
  });

  it('uses a deep plan and large topK for a vague query', () => {
    const { plan, results } = searchMemoryAdaptive(dir, 'history of the acme deal');
    expect(plan.depth).toBe('deep');
    expect(plan.topK).toBe(12);
    expect(results.length).toBeLessThanOrEqual(plan.topK);
  });

  it('never returns more results than the plan topK', () => {
    for (const q of ['widget', 'compare acme vs widget analytics deal history overview now']) {
      const { plan, results } = searchMemoryAdaptive(dir, q);
      expect(results.length).toBeLessThanOrEqual(plan.topK);
    }
  });
});
