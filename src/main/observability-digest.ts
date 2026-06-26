// observability-digest.ts
//
// Single tiered observability surface for the daily briefing. Combines the
// per-tool reliability scorecard (tool-health-summary.ts) and the failure
// issue-clusters (error-cluster.ts) into one object shaped to ExampleCo's CEO
// three-tier brevity rule (feedback_ceo_tier_one_brevity.md):
//
//   tier-1: one sentence, lets ExampleCo decide "fine / not fine" in 3 seconds.
//   tier-2: plain-English expansion, the few things that actually need eyes.
//   tier-3: full structured detail for drilldown.
//
// 2026 agent-observability stacks (Latitude survey) treat tool-use ExampleCong
// and issue clustering as separate dashboards. For a single-principal EA the
// useful unit is one digest: "are my tools fine, and if not, why" answered
// once. Pure data transform over a tool-trace JSONL path, no electron coupling.

import { readToolHealth, unhealthyTools, ToolHealth } from './tool-health-summary';
import { clusterRecentFailures, ErrorCluster } from './error-cluster';
import { summarizeScores, ScoreSummary } from './run-score-store';

// Score dimensions surfaced in the digest when a scores path is supplied. These
// are the run-quality lenses an LLM-judge / heuristic / human attaches post-hoc
// (run-score-store.ts); kept here so the digest names match the producers.
const SCORE_DIMENSIONS = ['briefing_quality', 'heal_effectiveness', 'call_outcome'];
// Below this mean a dimension is worth a tier-2 line (degraded run quality).
const SCORE_ATTENTION_THRESHOLD = 0.7;

export interface ObservabilityDigest {
  /** ISO timestamp the digest was generated. */
  generated_at: string;
  /** Hours of trace history the digest covers. */
  window_hours: number;
  /** Single sentence for the briefing health card. */
  tier1: string;
  /** Plain-English lines: only the tools and clusters that need attention. */
  tier2: string[];
  /** Full structured detail for drilldown. */
  tier3: {
    tool_health: ToolHealth[];
    unhealthy: ToolHealth[];
    error_clusters: ErrorCluster[];
    total_calls: number;
    total_failures: number;
    /** Post-hoc run-quality scores by dimension; empty when no scores path given. */
    run_scores: ScoreSummary[];
  };
  /** True when nothing needs ExampleCo's attention (all tools healthy, no clusters). */
  all_clear: boolean;
}

function clusterLabel(c: ErrorCluster): string {
  const sig = c.signature.length > 70 ? c.signature.slice(0, 67) + '...' : c.signature;
  return `"${sig}" x${c.count}`;
}

/**
 * Build a tiered observability digest from a tool-trace JSONL file.
 * `windowHours` bounds the failure-clustering lookback; tool-health rollup
 * uses the most recent `traceLimit` records.
 */
export function buildObservabilityDigest(
  tracePath: string,
  windowHours = 24,
  traceLimit = 2000,
  scoresPath?: string,
): ObservabilityDigest {
  const toolHealth = readToolHealth(tracePath, traceLimit);
  const unhealthy = unhealthyTools(toolHealth);
  const clusters = clusterRecentFailures(tracePath, windowHours, traceLimit);

  // Decoupled run-quality scores (run-score-store.ts). Only computed when a
  // scores path is supplied, so existing callers and the trace-only path are
  // unaffected. A dimension with no scores in-window is omitted.
  const runScores: ScoreSummary[] = scoresPath
    ? SCORE_DIMENSIONS.map((name) => summarizeScores(scoresPath, name, windowHours)).filter(
        (s) => s.count > 0,
      )
    : [];
  const lowScores = runScores.filter((s) => s.mean < SCORE_ATTENTION_THRESHOLD);

  const totalCalls = toolHealth.reduce((sum, t) => sum + t.calls, 0);
  const totalFailures = toolHealth.reduce((sum, t) => sum + t.failures, 0);
  const failing = unhealthy.filter((t) => t.status === 'failing');
  const degraded = unhealthy.filter((t) => t.status === 'degraded');
  const allClear = unhealthy.length === 0 && clusters.length === 0 && lowScores.length === 0;

  // tier-1: one sentence.
  let tier1: string;
  if (totalCalls === 0) {
    tier1 = 'Observability: no tool activity in the last window.';
  } else if (allClear) {
    tier1 = `Observability: all ${toolHealth.length} tools healthy across ${totalCalls} calls.`;
  } else {
    const bits: string[] = [];
    if (failing.length) bits.push(`${failing.length} failing`);
    if (degraded.length) bits.push(`${degraded.length} degraded`);
    if (clusters.length) {
      bits.push(`top error ${clusterLabel(clusters[0])}`);
    }
    tier1 = `Observability: ${bits.join(', ')} of ${toolHealth.length} tools, ${totalFailures}/${totalCalls} calls failed.`;
  }

  // tier-2: only what needs eyes.
  const tier2: string[] = [];
  for (const t of unhealthy) {
    tier2.push(
      `${t.tool}: ${t.status}, ${Math.round(t.success_rate * 100)}% success over ${t.calls} calls, p95 ${t.p95_ms}ms.`,
    );
  }
  for (const c of clusters.slice(0, 5)) {
    const toolList = c.tools.length ? ` (${c.tools.join(', ')})` : '';
    tier2.push(`Error cluster ${clusterLabel(c)}${toolList}.`);
  }
  for (const s of lowScores) {
    tier2.push(
      `Run quality ${s.name}: mean ${s.mean.toFixed(2)} over ${s.count} scored runs (below ${SCORE_ATTENTION_THRESHOLD}).`,
    );
  }
  if (tier2.length === 0) tier2.push('Nothing needs attention.');

  return {
    generated_at: new Date().toISOString(),
    window_hours: windowHours,
    tier1,
    tier2,
    tier3: {
      tool_health: toolHealth,
      unhealthy,
      error_clusters: clusters,
      total_calls: totalCalls,
      total_failures: totalFailures,
      run_scores: runScores,
    },
    all_clear: allClear,
  };
}
