// agent-step-loop-ExampleCong.ts
//
// Run 96 enhancement 3: OTel-style trace writer for agent-step-loop tool
// calls. Wires Agno v2.6.6 trace context preservation + Microsoft Agent
// Framework middleware patterns. The central loop was the only callsite
// in the codebase NOT writing to tool-trace.jsonl; this module closes
// that gap without coupling the loop to fs.
//
// Record shape extends tool-trace.ts ToolTraceRecord with three fields
// that close the run-scoped observability story:
//   - run_id: ties every tool call in a logical run together
//   - parent_step: which loop step produced this call
//   - span_id: unique per call so multiple tool calls in the same step
//     are distinguishable in a waterfall view
//   - side_effects: 'read' | 'write' | 'destructive' so the briefing
//     observability card can group by class
//   - idempotent_short_circuit: true when the call was satisfied by the
//     idempotency adapter without running the tool. Lets observability
//     count saved side effects per run.
//
// The output file is the same data/agent/tool-trace.jsonl that
// tool-trace.ts writes into, so existing readers continue to work; they
// just see extra fields on records emitted by the loop.

import * as fs from 'fs';
import * as path from 'path';
import { redactDeep } from './redact-secrets';
import type { LoopTraceRecord, LoopTraceWriter } from './agent-step-loop';

export type { LoopTraceRecord, LoopTraceWriter } from './agent-step-loop';

/** Append-only JSONL writer for loop trace records. */
export function makeFileTraceWriter(filePath: string): LoopTraceWriter {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return (record: LoopTraceRecord) => {
    try {
      // Same tool-trace.jsonl sink as tool-trace.ts: scrub credential shapes
      // from the loop record's string fields (input/output snippets, error)
      // before persisting, since this file is read by the briefing and shipped
      // to S3 in the session meta.
      fs.appendFileSync(filePath, JSON.stringify(redactDeep(record)) + '\n');
    } catch {
      /* ExampleCong is best-effort */
    }
  };
}

/**
 * In-memory writer for tests. Collects records in insertion order.
 */
export class MemoryTraceWriter {
  records: LoopTraceRecord[] = [];
  write: LoopTraceWriter = (record) => {
    this.records.push(record);
  };
}

/**
 * Aggregate trace records by run_id. The briefing's "Amy autonomy" card
 * uses this to surface per-run summaries:
 *   - total tool calls
 *   - distinct tools used
 *   - failures
 *   - total duration_ms (sum of tool durations)
 *   - side-effect breakdown
 *   - count of short-circuits saved by idempotency
 */
export interface RunSummary {
  run_id: string;
  total_calls: number;
  distinct_tools: number;
  failures: number;
  duration_ms_total: number;
  by_side_effect: Record<'read' | 'write' | 'destructive', number>;
  idempotent_short_circuits: number;
}

const VALID_SIDE_EFFECTS: ReadonlyArray<'read' | 'write' | 'destructive'> = [
  'read',
  'write',
  'destructive',
];

/**
 * True only for records that carry a real run_id. The trace JSONL is a SHARED
 * sink: tool-trace.ts writes base ToolTraceRecords (no run_id / side_effects)
 * into the same file the loop writes LoopTraceRecords into. Summarizing by run
 * must ignore the base records, otherwise every run-less line collapses into a
 * single phantom run keyed `undefined` and pollutes a `by_side_effect[undefined]`
 * bucket. This guard is why summarizeByRun is now safe to point at the live file.
 */
function isRunScoped(rec: LoopTraceRecord): boolean {
  return typeof rec.run_id === 'string' && rec.run_id.length > 0;
}

export function summarizeByRun(records: ReadonlyArray<LoopTraceRecord>): RunSummary[] {
  const byRun = new Map<string, RunSummary>();
  const distinctByRun = new Map<string, Set<string>>();
  for (const rec of records) {
    if (!isRunScoped(rec)) continue; // skip base ToolTraceRecords sharing the sink
    const summary =
      byRun.get(rec.run_id) ??
      ({
        run_id: rec.run_id,
        total_calls: 0,
        distinct_tools: 0,
        failures: 0,
        duration_ms_total: 0,
        by_side_effect: { read: 0, write: 0, destructive: 0 },
        idempotent_short_circuits: 0,
      } as RunSummary);
    summary.total_calls += 1;
    if (!rec.success) summary.failures += 1;
    if (typeof rec.duration_ms === 'number' && Number.isFinite(rec.duration_ms)) {
      summary.duration_ms_total += rec.duration_ms;
    }
    // Only count a known side-effect class; a malformed/absent value must not
    // create a junk bucket (NaN under the old code's blind index increment).
    if (VALID_SIDE_EFFECTS.includes(rec.side_effects)) {
      summary.by_side_effect[rec.side_effects] += 1;
    }
    if (rec.idempotent_short_circuit) summary.idempotent_short_circuits += 1;
    byRun.set(rec.run_id, summary);

    const set = distinctByRun.get(rec.run_id) ?? new Set<string>();
    if (typeof rec.tool === 'string' && rec.tool) set.add(rec.tool);
    distinctByRun.set(rec.run_id, set);
  }
  for (const [run_id, set] of distinctByRun) {
    const s = byRun.get(run_id);
    if (s) s.distinct_tools = set.size;
  }
  return Array.from(byRun.values());
}

/**
 * Convenience reader: load a trace JSONL and roll it into per-run summaries in
 * one call. Safe to point at the live data/agent/tool-trace.jsonl because
 * summarizeByRun skips the base (run-less) records that share the file.
 */
export function readRunSummaries(filePath: string): RunSummary[] {
  return summarizeByRun(readTraceFile(filePath));
}

/**
 * Read a JSONL trace file produced by makeFileTraceWriter and return all
 * records. Skips malformed lines so partial corruption never blocks the
 * briefing.
 */
export function readTraceFile(filePath: string): LoopTraceRecord[] {
  if (!fs.existsSync(filePath)) return [];
  const out: LoopTraceRecord[] = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LoopTraceRecord);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}
