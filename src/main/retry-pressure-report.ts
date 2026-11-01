// retry-pressure-report.ts
//
// Run 111 of the nightly enhancement cycle (2026-06-03).
//
// Observability consumer for model-retry-loop.ts. The retry loop emits one
// RetryAttemptRecord per tool call (how many correction retries it took, which
// validation rules fired, whether it ultimately succeeded or exhausted its
// cap). On its own each record is noise; aggregated they are a leading
// indicator that a tool's schema keeps confusing the model -- the single most
// actionable signal that a tool contract is drifting or a prompt is wrong.
//
// This module turns a stream of those records into a per-tool "retry pressure"
// report: how often each tool needs correcting, how often it gives up, and
// which validation rules drive the corrections. Worst offenders first, so the
// 5:30 AM briefing's system-health section can surface "tool X needed a
// correction on 40% of calls" instead of a wall of green.
//
// This is the consumer half of the run-111 pair (model-retry-loop produces,
// this reports), so neither module is orphaned -- it reads the loop's output
// directly. Pure aggregation; the only I/O is an optional JSONL reader.
//
// Patterns synthesized from:
//   - pydantic-ai / Logfire spans: retries are first-class telemetry, not
//     swallowed; you can chart retry rate per tool over time.
//   - LangSmith run trees: surface the loops, not just the leaves.
//   - SRE "error budget" framing: an exhaustion rate is a budget burn you
//     alert on, not a one-off you ignore.

import * as fs from 'fs';
import type { RetryAttemptRecord, AttemptTerminal } from './model-retry-loop';

export interface ToolPressure {
  toolName: string;
  calls: number;
  /** Sum of correction retries across all calls for this tool. */
  totalCorrections: number;
  /** totalCorrections / calls. 0 = always right first try. */
  avgCorrectionsPerCall: number;
  /** Calls that hit a cap and failed loud. */
  exhausted: number;
  /** exhausted / calls, 0..1. */
  exhaustionRate: number;
  /** Validation rules that drove corrections, most frequent first. */
  topRules: Array<{ rule: string; count: number }>;
}

export interface RetryPressureReport {
  generatedAt: string;
  totalCalls: number;
  totalCorrections: number;
  /** Tools sorted worst-first (see rankKey). */
  tools: ToolPressure[];
  /** Tools whose pressure crosses an attention threshold. */
  flagged: ToolPressure[];
}

export interface PressureThresholds {
  /** Flag a tool whose avg corrections/call is at or above this. Default 0.5. */
  avgCorrectionsPerCall: number;
  /** Flag a tool whose exhaustion rate is at or above this. Default 0.1. */
  exhaustionRate: number;
  /** Ignore tools with fewer than this many calls (too little signal). Default 3. */
  minCalls: number;
}

export const DEFAULT_THRESHOLDS: PressureThresholds = {
  avgCorrectionsPerCall: 0.5,
  exhaustionRate: 0.1,
  minCalls: 3,
};

const TERMINAL_IS_EXHAUSTED = (t: AttemptTerminal): boolean => t !== 'ok';

/**
 * Rank a tool's pressure for worst-first sorting: exhaustion dominates (a tool
 * that gives up is worse than one that self-corrects), then average
 * corrections, then raw correction volume as a tiebreak.
 */
function rankKey(p: ToolPressure): number {
  return p.exhaustionRate * 1000 + p.avgCorrectionsPerCall * 10 + p.totalCorrections * 0.001;
}

/**
 * Aggregate raw attempt records into a per-tool pressure report. Pure.
 */
export function buildRetryPressureReport(
  records: RetryAttemptRecord[],
  thresholds: PressureThresholds = DEFAULT_THRESHOLDS,
  generatedAt = '',
): RetryPressureReport {
  const byTool = new Map<
    string,
    { calls: number; corrections: number; exhausted: number; rules: Map<string, number> }
  >();

  for (const r of records) {
    let agg = byTool.get(r.toolName);
    if (!agg) {
      agg = { calls: 0, corrections: 0, exhausted: 0, rules: new Map() };
      byTool.set(r.toolName, agg);
    }
    agg.calls += 1;
    agg.corrections += r.corrections;
    if (TERMINAL_IS_EXHAUSTED(r.terminal)) agg.exhausted += 1;
    for (const rule of r.violationRules) {
      agg.rules.set(rule, (agg.rules.get(rule) ?? 0) + 1);
    }
  }

  const tools: ToolPressure[] = [];
  for (const [toolName, agg] of byTool) {
    const topRules = [...agg.rules.entries()]
      .map(([rule, count]) => ({ rule, count }))
      .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
    tools.push({
      toolName,
      calls: agg.calls,
      totalCorrections: agg.corrections,
      avgCorrectionsPerCall: agg.calls === 0 ? 0 : agg.corrections / agg.calls,
      exhausted: agg.exhausted,
      exhaustionRate: agg.calls === 0 ? 0 : agg.exhausted / agg.calls,
      topRules,
    });
  }

  tools.sort((a, b) => rankKey(b) - rankKey(a) || a.toolName.localeCompare(b.toolName));

  const flagged = tools.filter(
    (p) =>
      p.calls >= thresholds.minCalls &&
      (p.avgCorrectionsPerCall >= thresholds.avgCorrectionsPerCall ||
        p.exhaustionRate >= thresholds.exhaustionRate),
  );

  return {
    generatedAt,
    totalCalls: records.length,
    totalCorrections: tools.reduce((s, t) => s + t.totalCorrections, 0),
    tools,
    flagged,
  };
}

/**
 * Read RetryAttemptRecord JSONL (the file model-retry-loop's writer appends
 * to). Tolerates blank/corrupt lines. Missing file => [].
 */
export function readAttemptRecords(filePath: string): RetryAttemptRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out: RetryAttemptRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as RetryAttemptRecord;
      if (rec && typeof rec.toolName === 'string' && typeof rec.attempts === 'number') {
        out.push(rec);
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/**
 * One-line-per-tool summary for the briefing system-health card. Returns the
 * flagged tools (worst first); empty array means no tool is under pressure.
 */
export function summarizeRetryPressure(report: RetryPressureReport): string[] {
  return report.flagged.map((p) => {
    const pct = Math.round(p.exhaustionRate * 100);
    const ruleHint = p.topRules.length ? ` (top: ${p.topRules[0].rule})` : '';
    return (
      `${p.toolName}: ${p.avgCorrectionsPerCall.toFixed(2)} corrections/call over ${p.calls} calls, ` +
      `${pct}% gave up${ruleHint}`
    );
  });
}
