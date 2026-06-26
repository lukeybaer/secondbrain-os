// tool-cost-ledger.ts
//
// Per-call cost telemetry for any LLM-emitting tool. Inspired by BerriAI/litellm
// router_strategy/lowest_cost.py:LowestCostLoggingHandler (commit 2026-04-30):
// observe cost at the same callsite that issues the call, bucket by
// minute-precise key, so leaks surface immediately as a routing signal rather
// than as an after-the-fact audit.
//
// Why SecondBrain needs this:
//   - Claude Max-only rule (memory: feedback_no_fabrication_in_briefings.md)
//     requires production code paths to never hit OpenAI / Groq / direct
//     Anthropic API. There is no mechanical enforcement today; chat.ts,
//     chat-sessions.ts, calls.ts, agent-memory.ts all hold raw API keys.
//   - tool-trace.ts records duration and success but not provider or token
//     counts, so a paid-API call is invisible to the briefing.
//
// This module:
//   - records {timestamp, surface, provider, model, input_tokens,
//     output_tokens, est_cost_usd, wall_ms} as JSONL append.
//   - exposes assertClaudeMaxOnly(span) that throws when provider is not in
//     the allowlist while NODE_ENV === 'production'. Tests can flip the env
//     to verify the throw path without crashing CI.
//   - exposes getDailyTotals(date) and getMinuteBucket(provider, model) so the
//     briefing system-health section can render "0 paid-API hits today" or
//     surface leaks ranked by minute bucket.
//
// Pure fs, no electron coupling. Writer injection mirrors tool-trace.ts.

import * as fs from 'fs';
import * as path from 'path';

// Types

export type Provider =
  | 'claude-max'      // via Claude Code subprocess / harness, no per-token cost
  | 'anthropic-api'   // direct Anthropic SDK (paid, leak)
  | 'openai'          // paid, leak
  | 'groq'            // paid, leak
  | 'together'        // paid, leak
  | 'gemini'          // paid, leak
  | 'vapi'            // metered call provider, allowed
  | 'twilio'          // metered SMS, allowed
  | 'ExampleCo';

export const CLAUDE_MAX_ONLY_ALLOWLIST: ReadonlyArray<Provider> = [
  'claude-max',
  'vapi',
  'twilio',
];

export interface ToolCostRecord {
  timestamp: string;
  surface: string;            // e.g. 'briefing', 'vapi-call', 'chat', 'nightly'
  provider: Provider;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  est_cost_usd: number;
  wall_ms: number;
  minute_bucket: string;      // YYYY-MM-DD-HH-MM
  request_id?: string;
}

export type ToolCostWriter = (record: ToolCostRecord) => void;

// Pricing (current public list pricing per 1M tokens, USD).
// Used only for est_cost_usd. Inaccurate pricing does not affect leak detection
// (provider name is the gate). Update when providers change pricing.
const PRICING_PER_M_TOKENS: Record<string, { input: number; output: number }> = {
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  // Anthropic direct (would only fire if someone bypasses Claude Max)
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
  // Groq
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
};

export function estimateCostUsd(model: string | undefined, inputTokens = 0, outputTokens = 0): number {
  if (!model) return 0;
  const price = PRICING_PER_M_TOKENS[model];
  if (!price) return 0;
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

// Bucketing

export function minuteBucket(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    d.getUTCFullYear(),
    pad(d.getUTCMonth() + 1),
    pad(d.getUTCDate()),
    pad(d.getUTCHours()),
    pad(d.getUTCMinutes()),
  ].join('-');
}

// Enforcement

export class ClaudeMaxOnlyViolation extends Error {
  constructor(public readonly record: ToolCostRecord) {
    super(
      `Claude Max-only violation: provider=${record.provider} surface=${record.surface} model=${record.model ?? '?'}. ` +
      `Production code paths must use Claude Max. Allowlist: ${CLAUDE_MAX_ONLY_ALLOWLIST.join(', ')}.`,
    );
    this.name = 'ClaudeMaxOnlyViolation';
  }
}

export interface AssertOpts {
  // Tests pass nodeEnv explicitly so they can verify both branches.
  // Production callsites pass process.env.NODE_ENV (or omit, which reads it).
  nodeEnv?: string;
  // When true, throw even outside production (used by hooks that always block).
  alwaysThrow?: boolean;
}

export function assertClaudeMaxOnly(record: ToolCostRecord, opts: AssertOpts = {}): void {
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  if (!isProduction && !opts.alwaysThrow) return;
  if (CLAUDE_MAX_ONLY_ALLOWLIST.includes(record.provider)) return;
  throw new ClaudeMaxOnlyViolation(record);
}

// Recording

export function makeFileWriter(filePath: string): ToolCostWriter {
  return (record: ToolCostRecord) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
    } catch {
      // logging is best-effort, never break the caller
    }
  };
}

export interface RecordInput {
  surface: string;
  provider: Provider;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  wall_ms: number;
  request_id?: string;
}

export function recordToolCall(input: RecordInput, writer: ToolCostWriter): ToolCostRecord {
  const now = new Date();
  const record: ToolCostRecord = {
    timestamp: now.toISOString(),
    surface: input.surface,
    provider: input.provider,
    model: input.model,
    input_tokens: input.input_tokens,
    output_tokens: input.output_tokens,
    est_cost_usd: estimateCostUsd(input.model, input.input_tokens, input.output_tokens),
    wall_ms: input.wall_ms,
    minute_bucket: minuteBucket(now),
    request_id: input.request_id,
  };
  writer(record);
  return record;
}

// Wrapper around any LLM call

export interface MeterOpts {
  surface: string;
  provider: Provider;
  model?: string;
  request_id?: string;
  writer: ToolCostWriter;
  // When true, assert before recording so a leak throws BEFORE the paid call
  // would have been attributed. Production wrappers should pass true.
  enforceClaudeMax?: boolean;
  nodeEnv?: string;
}

export interface MeterResult<T> {
  result: T;
  record: ToolCostRecord;
}

// meterCall pre-checks the provider against the allowlist (so a leak short-
// circuits before we run the call), then runs fn, captures token counts via
// the optional second-arg callback, and records a single ledger line.
export async function meterCall<T>(
  opts: MeterOpts,
  fn: () => Promise<{ value: T; input_tokens?: number; output_tokens?: number }>,
): Promise<MeterResult<T>> {
  if (opts.enforceClaudeMax) {
    const probe: ToolCostRecord = {
      timestamp: new Date().toISOString(),
      surface: opts.surface,
      provider: opts.provider,
      model: opts.model,
      est_cost_usd: 0,
      wall_ms: 0,
      minute_bucket: minuteBucket(),
    };
    assertClaudeMaxOnly(probe, { nodeEnv: opts.nodeEnv, alwaysThrow: true });
  }
  const start = Date.now();
  const out = await fn();
  const wall_ms = Date.now() - start;
  const record = recordToolCall(
    {
      surface: opts.surface,
      provider: opts.provider,
      model: opts.model,
      input_tokens: out.input_tokens,
      output_tokens: out.output_tokens,
      wall_ms,
      request_id: opts.request_id,
    },
    opts.writer,
  );
  return { result: out.value, record };
}

// Reading

export function readLedger(filePath: string): ToolCostRecord[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as ToolCostRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is ToolCostRecord => r != null);
}

export interface DailyTotals {
  date: string;          // YYYY-MM-DD UTC
  total_calls: number;
  total_cost_usd: number;
  by_provider: Record<string, { calls: number; cost_usd: number }>;
  leaks: ToolCostRecord[]; // any record whose provider is not in the allowlist
}

export function getDailyTotals(records: ToolCostRecord[], dateUtc: string): DailyTotals {
  const matching = records.filter((r) => r.timestamp.startsWith(dateUtc));
  const by_provider: Record<string, { calls: number; cost_usd: number }> = {};
  let total_cost_usd = 0;
  for (const r of matching) {
    const slot = (by_provider[r.provider] ||= { calls: 0, cost_usd: 0 });
    slot.calls += 1;
    slot.cost_usd += r.est_cost_usd;
    total_cost_usd += r.est_cost_usd;
  }
  const leaks = matching.filter((r) => !CLAUDE_MAX_ONLY_ALLOWLIST.includes(r.provider));
  return {
    date: dateUtc,
    total_calls: matching.length,
    total_cost_usd,
    by_provider,
    leaks,
  };
}

export function getMinuteBucket(records: ToolCostRecord[], bucket: string): ToolCostRecord[] {
  return records.filter((r) => r.minute_bucket === bucket);
}
