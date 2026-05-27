// outcome-tracker.ts
//
// Run 50 of the nightly enhancement cycle (2026-05-09).
//
// Per-action outcome ledger. Every side-effecting tool call (Vapi dial, Gmail
// send, Telegram post, Twilio SMS, X publish, Claude run, scheduled-task step)
// gets one record describing how it went: success, fail, no_signal. Latency,
// arg hash, retry count, error class, and an optional delayed signal slot.
// JSONL append-only so any process can read the tail to compute rolling stats
// per scope without locking.
//
// Inspired by:
//   - AutoGen "ConversableAgent feedback loop" (Microsoft, 2026-04 release): every
//     turn carries a structured outcome label that the next turn can read.
//   - LangGraph persistence layer (LangChain, 2026-Q1): durable per-step state so
//     a long-running agent can be resumed and audited deterministically.
//   - Letta "annotated archival memory" (Memgpt successor, 2026-03): episodic
//     records carry an outcome tag that informs which memories to surface later.
//   - CrewAI Agent.execution_log (CrewAI 0.140+): each task records duration +
//     success boolean per agent, used for the kickoff() retry policy.
//   - phidata Workflow.observability (phidata 2.7+): tool call outcomes feed
//     a per-tool reliability score that informs router selection.
//
// Why SecondBrain needs this:
//   - tool-cost-ledger.ts (run 28) tracks dollars spent but not whether the call
//     achieved the goal. The briefing pipeline can be expensive AND useless and
//     today nothing surfaces that.
//   - tool-trace.ts records traces but not labeled outcomes; you cannot ask
//     "what is the success rate of Vapi dentist outbound dials in the last 30
//     days" without writing a custom parser.
//   - The 5:30 AM briefing wants a trustworthy "system health" tile. Without
//     per-action outcome data the only signal is exit code, which lies (a Vapi
//     call that connects but reaches voicemail is a 200 OK and a useless dial).
//   - Recipe.ts (run 40) records recipe definitions but has no outcome feed to
//     learn which recipe variants succeed. This module is the data layer.
//   - Outcome-weighted memory ranking (next-run candidate) needs per-action
//     success counts to bias retrieval toward memories that have led to wins.
//
// Design (zero deps, JSONL append-only, no DB):
//   1. recordOutcome({scope, action, args_hash, outcome, latency_ms, ...}) appends
//      one record. Synchronous append; all callers are I/O-bound already.
//   2. wrap(scope, action, fn, opts?) returns a wrapper that runs fn, measures
//      latency, classifies success/fail by thrown vs resolved, and records.
//   3. markSignal(record_id, signal) lets a later event upgrade a 'no_signal'
//      record to 'success' or 'fail' once user feedback arrives (a reply to an
//      email, a callback from a dialed lead, a click on a Telegram link).
//   4. getStats(scope, opts?) reads the tail and returns rolling success-rate +
//      latency percentiles per scope, optionally filtered by action and time.
//
// Critical invariant: an outcome record is APPEND-ONLY immutable. markSignal
// writes a NEW record referencing the original record_id; readers reduce by
// last-write-wins per record_id. This way the ledger remains a forensic log
// (you can replay history) while still letting delayed feedback retroactively
// label an action.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Types

export type Outcome = 'success' | 'fail' | 'no_signal';

export interface OutcomeRecord {
  record_id: string;     // 12-hex unique per call to recordOutcome
  scope: string;         // 'vapi' | 'gmail' | 'telegram' | 'twilio' | 'x' | 'claude' | 'briefing-section' | 'scheduled-task' | etc
  action: string;        // 'initiateCall' | 'sendDraft' | 'sendMessage' | 'publishPost' | etc
  args_hash: string;     // sha256 of the args, for grouping retries of the same call
  outcome: Outcome;
  ts: string;            // ISO-8601, when the record was created
  latency_ms?: number;   // wall-clock time spent in the underlying call
  error_class?: string;  // short stable token: 'timeout' | 'http_5xx' | 'http_429' | 'auth' | 'validation' | 'app' | 'unknown'
  error_message?: string;// first 200 chars of the error for forensics
  retry_count?: number;  // attempt number (0 = first try)
  signal_for?: string;   // if set, this record updates an earlier record_id
  metadata?: Record<string, unknown>; // free-form, kept small
}

export type ErrorClass =
  | 'timeout'
  | 'http_5xx'
  | 'http_429'
  | 'http_4xx'
  | 'auth'
  | 'validation'
  | 'network'
  | 'app'
  | 'unknown';

// Helpers

export function newRecordId(): string {
  return crypto.randomBytes(6).toString('hex');
}

export function argsHash(args: unknown): string {
  // Stable JSON: top-level keys sorted, deterministic across processes.
  const json = JSON.stringify(args, Object.keys((args as object) || {}).sort());
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
}

export function classifyError(err: unknown): ErrorClass {
  if (!err) return 'unknown';
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // Cheap stable classification, no regex zoo. Keep tokens short and stable.
  if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('aborted')) return 'timeout';
  if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('enotfound')) return 'network';
  if (msg.match(/\b5\d\d\b/) || msg.includes('internal server error') || msg.includes('bad gateway')) return 'http_5xx';
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) return 'http_429';
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden')) return 'auth';
  if (msg.match(/\b4\d\d\b/)) return 'http_4xx';
  if (msg.includes('invalid') || msg.includes('schema') || msg.includes('validation')) return 'validation';
  return 'app';
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor((p / 100) * (sortedAsc.length - 1))));
  return sortedAsc[rank];
}

// Tracker

export interface OutcomeStats {
  total: number;
  success: number;
  fail: number;
  no_signal: number;
  success_rate: number;     // success / (success + fail), excludes no_signal
  resolution_rate: number;  // (success + fail) / total, how many have a final answer
  p50_latency_ms: number;
  p95_latency_ms: number;
  by_error_class: Record<string, number>;
}

export interface StatsOptions {
  action?: string;
  windowMs?: number;        // only consider records younger than this
  now?: number;             // for tests, override Date.now
}

export class OutcomeTracker {
  private logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  }

  /**
   * Append one record. Returns the record_id so callers can later attach a
   * delayed signal via markSignal().
   */
  recordOutcome(rec: Omit<OutcomeRecord, 'record_id' | 'ts'> & { record_id?: string; ts?: string }): string {
    const record_id = rec.record_id || newRecordId();
    const ts = rec.ts || new Date().toISOString();
    const full: OutcomeRecord = { ...rec, record_id, ts };
    fs.appendFileSync(this.logPath, JSON.stringify(full) + '\n');
    return record_id;
  }

  /**
   * Update an earlier record's outcome (delayed signal). Writes a new record
   * with signal_for = original record_id. Readers do last-write-wins per
   * record_id when reducing.
   */
  markSignal(originalRecordId: string, signal: Outcome, metadata?: Record<string, unknown>): string {
    return this.recordOutcome({
      scope: 'signal',
      action: 'mark',
      args_hash: '-',
      outcome: signal,
      signal_for: originalRecordId,
      metadata,
    });
  }

  /**
   * Wrap an async function so it auto-records a success on resolve and a fail
   * on throw. Returns whatever fn returns; rethrows on error so the caller
   * still sees the original failure.
   */
  async wrap<T>(
    scope: string,
    action: string,
    args: unknown,
    fn: () => Promise<T>,
    opts?: { retry_count?: number; metadataOnSuccess?: (result: T) => Record<string, unknown> },
  ): Promise<T> {
    const start = Date.now();
    const ah = argsHash(args);
    try {
      const result = await fn();
      this.recordOutcome({
        scope,
        action,
        args_hash: ah,
        outcome: 'success',
        latency_ms: Date.now() - start,
        retry_count: opts?.retry_count,
        metadata: opts?.metadataOnSuccess?.(result),
      });
      return result;
    } catch (err) {
      this.recordOutcome({
        scope,
        action,
        args_hash: ah,
        outcome: 'fail',
        latency_ms: Date.now() - start,
        retry_count: opts?.retry_count,
        error_class: classifyError(err),
        error_message: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
      throw err;
    }
  }

  /**
   * Read all records. Returns them in append order (oldest first).
   * For large logs the caller can pass a tailLimit to bound memory.
   */
  readAll(tailLimit?: number): OutcomeRecord[] {
    if (!fs.existsSync(this.logPath)) return [];
    const lines = fs.readFileSync(this.logPath, 'utf8').split('\n');
    const trimmed = tailLimit ? lines.slice(-tailLimit - 1) : lines;
    const out: OutcomeRecord[] = [];
    for (const line of trimmed) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as OutcomeRecord);
      } catch {
        // skip malformed lines, do not fail the whole read
      }
    }
    return out;
  }

  /**
   * Reduce records to last-write-wins by record_id.
   * A markSignal record with signal_for = X rewrites X's outcome.
   */
  reduce(records: OutcomeRecord[]): OutcomeRecord[] {
    const byId = new Map<string, OutcomeRecord>();
    for (const r of records) {
      if (r.signal_for) {
        const original = byId.get(r.signal_for);
        if (original) {
          byId.set(r.signal_for, {
            ...original,
            outcome: r.outcome,
            metadata: { ...(original.metadata || {}), ...(r.metadata || {}) },
          });
        }
        continue;
      }
      byId.set(r.record_id, r);
    }
    return Array.from(byId.values());
  }

  /**
   * Compute rolling stats for a scope. action and windowMs are optional filters.
   */
  getStats(scope: string, opts: StatsOptions = {}): OutcomeStats {
    const now = opts.now ?? Date.now();
    const all = this.reduce(this.readAll());
    const filtered = all.filter(r => {
      if (r.scope !== scope) return false;
      if (opts.action && r.action !== opts.action) return false;
      if (opts.windowMs != null) {
        const age = now - Date.parse(r.ts);
        if (age > opts.windowMs) return false;
      }
      return true;
    });

    let success = 0, fail = 0, no_signal = 0;
    const lats: number[] = [];
    const byErr: Record<string, number> = {};
    for (const r of filtered) {
      if (r.outcome === 'success') success++;
      else if (r.outcome === 'fail') fail++;
      else no_signal++;
      if (typeof r.latency_ms === 'number') lats.push(r.latency_ms);
      if (r.error_class) byErr[r.error_class] = (byErr[r.error_class] || 0) + 1;
    }
    lats.sort((a, b) => a - b);
    const total = filtered.length;
    const decided = success + fail;
    return {
      total,
      success,
      fail,
      no_signal,
      success_rate: decided > 0 ? success / decided : 0,
      resolution_rate: total > 0 ? decided / total : 0,
      p50_latency_ms: percentile(lats, 50),
      p95_latency_ms: percentile(lats, 95),
      by_error_class: byErr,
    };
  }
}

// Default singleton lazy-bound to a module-level path. Callers in main process
// can swap in a path via getDefaultTracker(customPath). Tests should always
// instantiate their own to avoid file-system bleed.

let defaultTracker: OutcomeTracker | null = null;

export function getDefaultTracker(logPath?: string): OutcomeTracker {
  if (logPath) {
    defaultTracker = new OutcomeTracker(logPath);
    return defaultTracker;
  }
  if (!defaultTracker) {
    // Fallback path for production. Caller should set explicitly via init().
    const home = process.env.APPDATA || process.env.HOME || process.cwd();
    const fallback = path.join(home, 'secondbrain', 'data', 'agent', 'outcomes.jsonl');
    defaultTracker = new OutcomeTracker(fallback);
  }
  return defaultTracker;
}

/**
 * Convenience top-level: record an outcome on the default tracker. For non-test
 * code that does not want to instantiate. Tests should always use their own
 * OutcomeTracker instance.
 */
export function recordOutcome(rec: Omit<OutcomeRecord, 'record_id' | 'ts'>): string {
  return getDefaultTracker().recordOutcome(rec);
}
