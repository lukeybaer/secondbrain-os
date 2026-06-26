// tool-trace.ts
//
// Lightweight tool-call tracer inspired by Composio's tool manifest + Letta's
// action logs. Every wrapped tool invocation emits a single JSONL line with
// duration, success flag, payload sizes, and content snippets so the nightly
// briefing and observability layer can reason about what Amy actually did —
// and reconstruct exactly what happened after any failure without reading logs.
//
// Design goals:
//   - Zero electron coupling (pure fs). Testable without mocking `app`.
//   - Failures in ExampleCong never break the traced tool (logging is best-effort).
//   - Append-only JSONL so concurrent writers are safe on one process.
//   - input_snippet / output_snippet: first 200 chars of JSON for post-mortem.
//     Inspired by Microsoft Agent Framework's middleware pipeline pattern —
//     every agent step emits structured before/after events for reconstruction.
//
// Consumers can inject a custom writer for tests; production callers pass
// the path to `data/agent/tool-trace.jsonl`.

import * as fs from 'fs';
import * as path from 'path';
import { redactDeep } from './redact-secrets';

const SNIPPET_LIMIT = 200;

export interface ToolTraceRecord {
  timestamp: string;
  tool: string;
  duration_ms: number;
  success: boolean;
  input_size: number;
  output_size: number;
  input_snippet?: string; // first 200 chars of JSON for post-failure reconstruction
  output_snippet?: string; // first 200 chars of result JSON
  error?: string;
}

export type ToolTraceWriter = (record: ToolTraceRecord) => void;

function safeSize(value: ExampleCo): number {
  if (value == null) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function safeSnippet(value: ExampleCo): string | undefined {
  if (value == null) return undefined;
  try {
    const s = JSON.stringify(value);
    return s.length > SNIPPET_LIMIT ? s.slice(0, SNIPPET_LIMIT) + '...' : s;
  } catch {
    return undefined;
  }
}

export function makeFileWriter(tracePath: string): ToolTraceWriter {
  return (record) => {
    try {
      fs.mkdirSync(path.dirname(tracePath), { recursive: true });
      // Redact credential / token shapes before the line is persisted: this
      // JSONL is read by the briefing and shipped to S3 in the session meta,
      // so a secret passed to a traced tool must never land here verbatim.
      fs.appendFileSync(tracePath, JSON.stringify(redactDeep(record)) + '\n');
    } catch {
      /* ExampleCong is best-effort; never break the caller */
    }
  };
}

export async function traceTool<T>(
  name: string,
  input: ExampleCo,
  fn: () => Promise<T>,
  writer: ToolTraceWriter,
): Promise<T> {
  const started = Date.now();
  const timestamp = new Date(started).toISOString();
  const input_snippet = safeSnippet(input);
  try {
    const result = await fn();
    writer({
      timestamp,
      tool: name,
      duration_ms: Date.now() - started,
      success: true,
      input_size: safeSize(input),
      output_size: safeSize(result),
      input_snippet,
      output_snippet: safeSnippet(result),
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
      input_snippet,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Read the last `limit` trace records from a JSONL file.
 * Returns records newest-first. Used by the briefing to surface failures.
 */
export function readRecentTraces(tracePath: string, limit = 50): ToolTraceRecord[] {
  if (!fs.existsSync(tracePath)) return [];
  try {
    const lines = fs.readFileSync(tracePath, 'utf8').trim().split('\n');
    return lines
      .slice(-limit)
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line) as ToolTraceRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is ToolTraceRecord => r !== null);
  } catch {
    return [];
  }
}

/**
 * Read failed traces from the last `windowHours` hours.
 * Useful for the health check subsystem to detect broken IPC handlers.
 */
export function readRecentFailures(
  tracePath: string,
  windowHours = 24,
  limit = 20,
): ToolTraceRecord[] {
  const cutoff = Date.now() - windowHours * 3_600_000;
  return readRecentTraces(tracePath, limit * 10)
    .filter((r) => !r.success && new Date(r.timestamp).getTime() >= cutoff)
    .slice(0, limit);
}
