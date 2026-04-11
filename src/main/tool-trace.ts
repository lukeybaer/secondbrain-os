// tool-trace.ts
//
// Lightweight tool-call tracer inspired by Composio's tool manifest + Letta's
// action logs. Every wrapped tool invocation emits a single JSONL line with
// duration, success flag, and payload sizes so the nightly briefing and
// observability layer can reason about what Amy actually did.
//
// Design goals:
//   - Zero electron coupling (pure fs). Testable without mocking `app`.
//   - Failures in tracing never break the traced tool (logging is best-effort).
//   - Append-only JSONL so concurrent writers are safe on one process.
//
// Consumers can inject a custom writer for tests; production callers pass
// the path to `data/agent/tool-trace.jsonl`.

import * as fs from 'fs';
import * as path from 'path';

export interface ToolTraceRecord {
  timestamp: string;
  tool: string;
  duration_ms: number;
  success: boolean;
  input_size: number;
  output_size: number;
  error?: string;
}

export type ToolTraceWriter = (record: ToolTraceRecord) => void;

function safeSize(value: unknown): number {
  if (value == null) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

export function makeFileWriter(tracePath: string): ToolTraceWriter {
  return (record) => {
    try {
      fs.mkdirSync(path.dirname(tracePath), { recursive: true });
      fs.appendFileSync(tracePath, JSON.stringify(record) + '\n');
    } catch {
      /* tracing is best-effort; never break the caller */
    }
  };
}

export async function traceTool<T>(
  name: string,
  input: unknown,
  fn: () => Promise<T>,
  writer: ToolTraceWriter,
): Promise<T> {
  const started = Date.now();
  const timestamp = new Date(started).toISOString();
  try {
    const result = await fn();
    writer({
      timestamp,
      tool: name,
      duration_ms: Date.now() - started,
      success: true,
      input_size: safeSize(input),
      output_size: safeSize(result),
    });
    return result;
  } catch (err) {
    writer({
      timestamp,
      tool: name,
      duration_ms: Date.now() - started,
      success: false,
      input_size: safeSize(input),
      output_size: 0,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
