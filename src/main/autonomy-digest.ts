// autonomy-digest.ts
//
// The "Amy autonomy" tier of the daily observability surface. Where
// observability-digest.ts answers "are my TOOLS fine," this answers "what did
// Amy actually DO autonomously" rolled to ExampleCo's CEO three-tier brevity rule:
//
//   tier-1: one sentence  -- how many autonomous runs, calls, failures.
//   tier-2: only the runs that need eyes (any run with a failed tool call).
//   tier-3: full per-run detail for drilldown.
//
// The per-run rollup (summarizeByRun in agent-step-loop-ExampleCong.ts) was built
// and unit-tested but never reached any runtime surface -- its own comment
// claimed "the briefing's Amy autonomy card uses this," yet nothing imported
// it. This module is the missing presentation layer; self-health-digest folds
// it in so the data finally lands in front of ExampleCo.
//
// Pure data transform over RunSummary[]: no fs, no electron, no clock except
// the generated_at stamp. Same discipline as observability-digest.ts.

import type { RunSummary } from './agent-step-loop-ExampleCong';

export interface AutonomyDigest {
  /** ISO timestamp the digest was generated. */
  generated_at: string;
  /** Single sentence for the briefing autonomy card. */
  tier1: string;
  /** Plain-English lines: only the runs that had a failed tool call. */
  tier2: string[];
  /** Full structured detail for drilldown. */
  tier3: {
    runs: RunSummary[];
    total_runs: number;
    total_calls: number;
    total_failures: number;
    /** Side-effecting calls a resumed/duplicate run avoided via idempotency. */
    total_idempotent_short_circuits: number;
    by_side_effect: { read: number; write: number; destructive: number };
  };
  /** True when no autonomous run had a failed tool call. */
  all_clear: boolean;
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 100);
}

/**
 * Build a tiered autonomy digest from per-run summaries (the output of
 * summarizeByRun / readRunSummaries). Runs with zero failures are healthy and
 * only contribute to the aggregate counts; runs with any failure surface in
 * tier-2 so ExampleCo sees exactly which autonomous run went wrong.
 */
export function buildAutonomyDigest(runs: ReadonlyArray<RunSummary>): AutonomyDigest {
  const totalRuns = runs.length;
  const totalCalls = runs.reduce((sum, r) => sum + r.total_calls, 0);
  const totalFailures = runs.reduce((sum, r) => sum + r.failures, 0);
  const totalShortCircuits = runs.reduce((sum, r) => sum + r.idempotent_short_circuits, 0);
  const bySide = runs.reduce(
    (acc, r) => {
      acc.read += r.by_side_effect.read;
      acc.write += r.by_side_effect.write;
      acc.destructive += r.by_side_effect.destructive;
      return acc;
    },
    { read: 0, write: 0, destructive: 0 },
  );

  const failedRuns = runs.filter((r) => r.failures > 0);
  const allClear = failedRuns.length === 0;

  // tier-1: one sentence.
  let tier1: string;
  if (totalRuns === 0) {
    tier1 = 'Autonomy: no autonomous runs in window.';
  } else {
    const savedBit = totalShortCircuits > 0 ? `, ${totalShortCircuits} saved by idempotency` : '';
    if (allClear) {
      tier1 = `Autonomy: ${totalRuns} run(s), ${totalCalls} tool call(s), all clean${savedBit}.`;
    } else {
      tier1 =
        `Autonomy: ${totalRuns} run(s), ${totalCalls} tool call(s), ` +
        `${totalFailures} failed across ${failedRuns.length} run(s)${savedBit}.`;
    }
  }

  // tier-2: only runs that need eyes.
  const tier2: string[] = failedRuns
    .slice()
    .sort((a, b) => b.failures - a.failures)
    .map(
      (r) =>
        `${r.run_id}: ${r.failures}/${r.total_calls} call(s) failed across ` +
        `${r.distinct_tools} tool(s) (${pct(r.failures, r.total_calls)}% fail).`,
    );
  if (tier2.length === 0) {
    tier2.push(totalRuns === 0 ? 'No autonomous activity.' : 'Every autonomous run was clean.');
  }

  return {
    generated_at: new Date().toISOString(),
    tier1,
    tier2,
    tier3: {
      runs: runs.slice(),
      total_runs: totalRuns,
      total_calls: totalCalls,
      total_failures: totalFailures,
      total_idempotent_short_circuits: totalShortCircuits,
      by_side_effect: bySide,
    },
    all_clear: allClear,
  };
}
