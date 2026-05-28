/**
 * Regression test: heal-tests loop has actual exit conditions besides
 * "ran the max number of attempts." The original loop ran 8 vitest passes
 * 30 min apart no matter what, even when every attempt produced identical
 * failures, wasting ~4 hours of overnight wall time. The briefing then
 * (mis)reported "no self-heal attempt completed inside the overnight
 * window" when in fact 8 attempts DID complete; they just had no repair
 * capability beyond re-running vitest.
 *
 * 2026-05-23 root-cause fix added two early-exit conditions:
 *   (a) no-progress: if two consecutive attempts produce identical failing
 *       test signatures, exit immediately with earlyExit='no-progress'
 *   (b) deadline: HEAL_TESTS_DEADLINE_CT=HH:MM stops the loop if the next
 *       sleep would push past the briefing window
 *
 * This test asserts the source contains both branches plus the honest
 * blocker copy the briefing producer emits when the heal loop ran but
 * the failures repeated.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function read(p: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');
}

describe('heal-tests.js loop honest exits', () => {
  const src = read('scripts/heal-tests.js');

  it('declares the failingSignature helper for no-progress comparison', () => {
    expect(src).toMatch(/function failingSignature\b/);
    expect(src).toMatch(/r\.items[\s\S]*?\.sort\(\)/);
  });

  it('exits early when consecutive attempts produce identical failing-test signatures', () => {
    expect(src).toMatch(/no-progress early exit/i);
    expect(src).toMatch(/signature === prevSignature/);
  });

  it('respects a heal-window deadline via HEAL_TESTS_DEADLINE_CT', () => {
    expect(src).toMatch(/HEAL_TESTS_DEADLINE_CT/);
    expect(src).toMatch(/deadline early exit/i);
  });

  it('records earlyExit metadata in the runs log so the briefing can read it', () => {
    expect(src).toMatch(/earlyExit:\s*'no-progress'/);
    expect(src).toMatch(/earlyExit:\s*'deadline'/);
  });
});

describe('refresh-briefing-generated-sections honest tests blocker copy', () => {
  const src = read('scripts/refresh-briefing-generated-sections.js');

  it('reads heal-tests-runs.jsonl to enrich the tests heal map', () => {
    expect(src).toMatch(/data\/agent\/heal-tests-runs\.jsonl/);
    expect(src).toMatch(/map\['tests'\]\s*=/);
  });

  it('emits an honest "attempts ran but failures unchanged" message instead of "no self-heal attempt completed"', () => {
    expect(src).toMatch(/self-heal attempts ran in the overnight window/i);
    expect(src).toMatch(/no repair capability beyond re-running vitest/i);
  });

  it('distinguishes no-progress vs deadline early exits in the blocker copy', () => {
    expect(src).toMatch(/failing test set did not change between attempts/i);
    expect(src).toMatch(/exited cleanly at the deadline/i);
  });
});
