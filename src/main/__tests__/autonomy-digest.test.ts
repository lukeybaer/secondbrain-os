// autonomy-digest.test.ts
//
// Regression test for the autonomy presentation layer. Encodes the category
// (aggregate counts across runs; only failed runs surface in tier-2; all_clear
// reflects failures, not call volume; empty input is handled), not one literal
// trigger. Per feedback_frugal_regression_tests.md.

import { describe, it, expect } from 'vitest';
import { buildAutonomyDigest } from '../autonomy-digest';
import type { RunSummary } from '../agent-step-loop-ExampleCong';

function run(partial: Partial<RunSummary> & { run_id: string }): RunSummary {
  return {
    run_id: partial.run_id,
    total_calls: partial.total_calls ?? 0,
    distinct_tools: partial.distinct_tools ?? 0,
    failures: partial.failures ?? 0,
    duration_ms_total: partial.duration_ms_total ?? 0,
    by_side_effect: partial.by_side_effect ?? { read: 0, write: 0, destructive: 0 },
    idempotent_short_circuits: partial.idempotent_short_circuits ?? 0,
  };
}

describe('buildAutonomyDigest', () => {
  it('reports no activity for an empty run set', () => {
    const d = buildAutonomyDigest([]);
    expect(d.all_clear).toBe(true);
    expect(d.tier1).toMatch(/no autonomous runs/i);
    expect(d.tier3.total_runs).toBe(0);
    expect(d.tier3.total_calls).toBe(0);
  });

  it('aggregates calls, failures, side effects, and idempotency savings across runs', () => {
    const runs = [
      run({
        run_id: 'run_a',
        total_calls: 4,
        distinct_tools: 2,
        failures: 0,
        by_side_effect: { read: 3, write: 1, destructive: 0 },
        idempotent_short_circuits: 1,
      }),
      run({
        run_id: 'run_b',
        total_calls: 2,
        distinct_tools: 1,
        failures: 0,
        by_side_effect: { read: 0, write: 2, destructive: 0 },
        idempotent_short_circuits: 2,
      }),
    ];
    const d = buildAutonomyDigest(runs);
    expect(d.all_clear).toBe(true);
    expect(d.tier3.total_runs).toBe(2);
    expect(d.tier3.total_calls).toBe(6);
    expect(d.tier3.total_failures).toBe(0);
    expect(d.tier3.total_idempotent_short_circuits).toBe(3);
    expect(d.tier3.by_side_effect).toEqual({ read: 3, write: 3, destructive: 0 });
    // A clean window still reports the idempotency savings in tier-1.
    expect(d.tier1).toMatch(/saved by idempotency/i);
    expect(d.tier2).toEqual(['Every autonomous run was clean.']);
  });

  it('surfaces only failed runs in tier-2, worst-first, and flips all_clear', () => {
    const runs = [
      run({ run_id: 'clean', total_calls: 5, distinct_tools: 2, failures: 0 }),
      run({ run_id: 'one_bad', total_calls: 3, distinct_tools: 2, failures: 1 }),
      run({ run_id: 'worst', total_calls: 4, distinct_tools: 3, failures: 3 }),
    ];
    const d = buildAutonomyDigest(runs);
    expect(d.all_clear).toBe(false);
    // Only the two failing runs appear, worst (3 failures) before one_bad.
    expect(d.tier2).toHaveLength(2);
    expect(d.tier2[0]).toContain('worst');
    expect(d.tier2[1]).toContain('one_bad');
    expect(d.tier2.some((l) => l.includes('clean'))).toBe(false);
    expect(d.tier1).toMatch(/4 failed across 2 run/);
  });
});
