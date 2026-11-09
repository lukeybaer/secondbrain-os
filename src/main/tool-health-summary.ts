// tool-health-summary.ts
//
// Per-tool reliability scorecard built from tool-trace.jsonl. Closes the
// "tool use observability" gap named in the 2026 Latitude agent-observability
// survey: most LLM-observability stacks track completions, not per-tool
// success rates and latency distributions, so a slowly-degrading tool stays
// invisible until it fails outright.
//
// This module rolls raw ToolTraceRecord entries into one row per tool with
// call volume, success rate, and p50 / p95 latency, then classifies each tool
// healthy / degraded / failing. The briefing health card and the tool-router
// can both read this to deprioritize a flaky tool before it breaks a workflow.
//
// Pure data transforms + fs read, same discipline as tool-trace.ts: never
// throws on malformed input, JSONL input is read and never written.

import { ToolTraceRecord, readRecentTraces } from './tool-trace';

export type ToolHealthStatus = 'healthy' | 'degraded' | 'failing';

export interface ToolHealth {
  tool: string;
  calls: number;
  failures: number;
  /** Fraction in [0,1]; 1 means every call in the window succeeded. */
  success_rate: number;
  /** Median duration in ms across all calls (success and failure). */
  p50_ms: number;
  /** 95th-percentile duration in ms. */
  p95_ms: number;
  status: ToolHealthStatus;
}

// A tool needs at least this many calls before a low success rate is treated
// as "failing" rather than noise from a tiny sample.
const MIN_CALLS_FOR_VERDICT = 3;
const DEGRADED_BELOW = 0.9;
const FAILING_BELOW = 0.5;

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
}

function classify(successRate: number, calls: number): ToolHealthStatus {
  if (calls < MIN_CALLS_FOR_VERDICT) {
    // Too little data to condemn a tool, but a clean run still reads healthy.
    return successRate >= DEGRADED_BELOW ? 'healthy' : 'degraded';
  }
  if (successRate < FAILING_BELOW) return 'failing';
  if (successRate < DEGRADED_BELOW) return 'degraded';
  return 'healthy';
}

/**
 * Roll trace records into one ToolHealth row per tool, sorted worst-first
 * (failing before degraded before healthy, then by call volume) so the
 * briefing surfaces the riskiest tool at the top.
 */
export function summarizeToolHealth(records: ToolTraceRecord[]): ToolHealth[] {
  const byTool = new Map<string, { ok: number; fail: number; durations: number[] }>();

  for (const r of records) {
    if (!r || typeof r.tool !== 'string' || !r.tool) continue;
    const bucket = byTool.get(r.tool) ?? { ok: 0, fail: 0, durations: [] };
    if (r.success) bucket.ok += 1;
    else bucket.fail += 1;
    if (typeof r.duration_ms === 'number' && r.duration_ms >= 0) {
      bucket.durations.push(r.duration_ms);
    }
    byTool.set(r.tool, bucket);
  }

  const rank: Record<ToolHealthStatus, number> = { failing: 0, degraded: 1, healthy: 2 };

  return [...byTool.entries()]
    .map(([tool, b]) => {
      const calls = b.ok + b.fail;
      const successRate = calls === 0 ? 1 : b.ok / calls;
      const sorted = [...b.durations].sort((x, y) => x - y);
      return {
        tool,
        calls,
        failures: b.fail,
        success_rate: Number(successRate.toFixed(4)),
        p50_ms: Math.round(percentile(sorted, 50)),
        p95_ms: Math.round(percentile(sorted, 95)),
        status: classify(successRate, calls),
      };
    })
    .sort(
      (a, b) => rank[a.status] - rank[b.status] || b.calls - a.calls || a.tool.localeCompare(b.tool),
    );
}

/**
 * Read recent traces from a JSONL file and summarize tool health.
 * `limit` caps how many raw records are pulled before rollup.
 */
export function readToolHealth(tracePath: string, limit = 2000): ToolHealth[] {
  return summarizeToolHealth(readRecentTraces(tracePath, limit));
}

/** Tools that are not healthy, worst-first. Convenience filter for the briefing. */
export function unhealthyTools(summary: ToolHealth[]): ToolHealth[] {
  return summary.filter((t) => t.status !== 'healthy');
}

/** One-line tier-1 summary for the briefing health card. */
export function summarizeToolHealthLine(summary: ToolHealth[]): string {
  if (summary.length === 0) return 'No tool activity in window.';
  const failing = summary.filter((t) => t.status === 'failing');
  const degraded = summary.filter((t) => t.status === 'degraded');
  if (failing.length === 0 && degraded.length === 0) {
    return `All ${summary.length} active tool${summary.length === 1 ? '' : 's'} healthy.`;
  }
  const parts: string[] = [];
  if (failing.length) parts.push(`${failing.length} failing (${failing[0].tool})`);
  if (degraded.length) parts.push(`${degraded.length} degraded (${degraded[0].tool})`);
  return `Tool health: ${parts.join(', ')}.`;
}
