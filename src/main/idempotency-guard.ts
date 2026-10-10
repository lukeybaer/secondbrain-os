// idempotency-guard.ts
//
// Run 44 of the nightly enhancement cycle (2026-05-07).
//
// Claim-slot-first idempotency registry for side-effecting actions: Vapi
// outbound calls, Telegram posts, Twilio SMS, Gmail sends, X publish, scheduled
// task triggers. Every external action that costs money or generates a public
// artifact gets a deterministic key and a JSONL slot before the action fires.
// If the same key is presented again within the TTL window, the action is
// short-circuited and the prior result is returned instead.
//
// Inspired by:
//   - Inferable.ai "Distributed Tool Calling" (2026-04 blog): idempotency key
//     on every external tool call, durable in postgres, INSERT-then-execute
//     order. https://www.inferable.ai/blog/posts/distributed-tool-calling-message-queues
//   - aipatternbook.com Idempotency entry: deterministic key from
//     {workflow_run_id, step_index, action_type}, NEVER from execution time.
//   - Stripe API idempotency-key header pattern (the canonical version): same
//     key returns the same response for 24h, retries do not double-charge.
//   - agent-ledger HN show (item 46933954, 2026-04): idempotent tool execution
//     for AI agents, claim slot first so a crash between execution and logging
//     does not let the next retry re-execute.
//
// Why SecondBrain needs this:
//   - calls.ts initiateCall() can fire the same Vapi call twice if the briefing
//     pipeline retries on a transient HTTP error. Vapi charges per dial.
//   - twilio-sms.ts and x-publisher.ts have no dedup. A retry double-posts.
//   - Gmail send pipeline (reference_gmail_send_pipeline.md) has no key on
//     drafts, a flaky scheduled task can resend the same draft.
//   - Scheduled tasks (12 of them) trigger by cron. If the runner restarts
//     mid-task, the next cron fires the same body of work.
//
// Design (zero deps, JSONL append-only, no DB):
//   1. claim(key, ttlMs, payloadHash) returns one of:
//      - { state: 'fresh' } means slot is yours, proceed and call complete()
//      - { state: 'duplicate', priorResult } already executed inside TTL, skip
//      - { state: 'in_flight', ageMs } claimed but not completed, caller decides
//        (escalate to human, fail closed, or proceed with new key).
//   2. complete(key, result) writes the terminal record so future claims see
//      the prior result.
//   3. fail(key, errorSummary) marks the slot as failed so retries are allowed
//      with a new exec_id.
//
// Critical ordering rule (the bug agent-ledger calls out): always
// claim-then-execute, never execute-then-log. A crash between execute and log
// means the dedup table doesn't know the action happened, and the next retry
// will re-execute. This module enforces the order via the API shape: you
// cannot complete() until you have claimed().

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Types

export type SlotState = 'claimed' | 'completed' | 'failed';

export interface IdempotencyRecord {
  key: string;            // deterministic, caller-supplied
  payload_hash: string;   // sha256 of the request payload, for sanity check
  state: SlotState;
  exec_id: string;        // 12-hex unique per attempt; lets you correlate logs
  claimed_at: string;     // ISO-8601
  completed_at?: string;
  failed_at?: string;
  ttl_ms: number;
  result?: unknown;       // what complete() persisted; returned on duplicate
  error_summary?: string; // short reason for failure
  scope: string;          // 'vapi' | 'gmail' | 'telegram' | 'twilio' | 'x' | 'scheduled-task' | etc
}

export type ClaimOutcome =
  | { state: 'fresh'; exec_id: string }
  | { state: 'duplicate'; priorResult: unknown; completedAt: string }
  | { state: 'in_flight'; ageMs: number; exec_id: string }
  | { state: 'payload_mismatch'; expectedHash: string; gotHash: string };

// Helpers

export function deterministicKey(scope: string, parts: Array<string | number>): string {
  // SHA-256 truncated to 16 hex chars. Deterministic across processes.
  const seed = `${scope}::${parts.join('|')}`;
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

export function payloadHash(payload: unknown): string {
  const json = JSON.stringify(payload, Object.keys(payload as object || {}).sort());
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function newExecId(): string {
  return crypto.randomBytes(6).toString('hex');
}

// Registry

export class IdempotencyGuard {
  private logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  }

  /**
   * Read all records for a key. Returns latest-first (most recent record at index 0).
   * Pure read; safe to call from anywhere.
   */
  private recordsFor(key: string): IdempotencyRecord[] {
    if (!fs.existsSync(this.logPath)) return [];
    const lines = fs.readFileSync(this.logPath, 'utf8').split('\n');
    const out: IdempotencyRecord[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as IdempotencyRecord;
        if (rec.key === key) out.push(rec);
      } catch {
        // skip malformed lines, do not fail the whole read
      }
    }
    return out.reverse();
  }

  private append(rec: IdempotencyRecord): void {
    fs.appendFileSync(this.logPath, JSON.stringify(rec) + '\n');
  }

  /**
   * Claim a slot. Caller MUST follow with complete() or fail() once the action
   * resolves. Same key with same payload inside TTL returns 'duplicate' with
   * the prior result. Same key with DIFFERENT payload returns 'payload_mismatch'
   * so the caller knows two different actions are colliding.
   */
  claim(key: string, scope: string, payload: unknown, ttlMs: number): ClaimOutcome {
    const incomingHash = payloadHash(payload);
    const records = this.recordsFor(key); // latest-first

    // The latest record dictates current state. A 'failed' latest means the
    // previous attempt aborted and a fresh retry is allowed. Records older
    // than the latest are history; only the head matters for routing.
    const latest = records[0];

    if (latest && latest.state !== 'failed') {
      if (latest.payload_hash !== incomingHash) {
        return {
          state: 'payload_mismatch',
          expectedHash: latest.payload_hash,
          gotHash: incomingHash,
        };
      }

      const claimedAt = Date.parse(latest.claimed_at);
      const ageMs = Date.now() - claimedAt;

      if (latest.state === 'completed') {
        if (ageMs < latest.ttl_ms) {
          return {
            state: 'duplicate',
            priorResult: latest.result,
            completedAt: latest.completed_at || latest.claimed_at,
          };
        }
        // TTL expired, fall through to fresh claim.
      }

      if (latest.state === 'claimed') {
        // In-flight: another caller has the slot but has not finished.
        // Caller decides whether to wait, escalate, or fail closed.
        return { state: 'in_flight', ageMs, exec_id: latest.exec_id };
      }
    }

    // Fresh claim path.
    const exec_id = newExecId();
    const rec: IdempotencyRecord = {
      key,
      payload_hash: incomingHash,
      state: 'claimed',
      exec_id,
      claimed_at: new Date().toISOString(),
      ttl_ms: ttlMs,
      scope,
    };
    this.append(rec);
    return { state: 'fresh', exec_id };
  }

  /**
   * Mark the claimed slot as completed. Stores the result so future duplicate
   * calls can short-circuit and return it.
   */
  complete(key: string, exec_id: string, result: unknown): void {
    const records = this.recordsFor(key);
    const claim = records.find((r) => r.exec_id === exec_id && r.state === 'claimed');
    if (!claim) {
      throw new Error(
        `complete: no claimed slot for key=${key} exec_id=${exec_id}. ` +
          `Caller must claim() first; never call complete() out of order.`,
      );
    }
    const rec: IdempotencyRecord = {
      ...claim,
      state: 'completed',
      completed_at: new Date().toISOString(),
      result,
    };
    this.append(rec);
  }

  /**
   * Mark the claimed slot as failed. Future claims with the same key will be
   * allowed (a fail does NOT count as a completion).
   */
  fail(key: string, exec_id: string, errorSummary: string): void {
    const records = this.recordsFor(key);
    const claim = records.find((r) => r.exec_id === exec_id && r.state === 'claimed');
    if (!claim) {
      // Tolerate fail() on a non-existent claim so callers can defensively
      // emit it from finally blocks without crashing.
      return;
    }
    const rec: IdempotencyRecord = {
      ...claim,
      state: 'failed',
      failed_at: new Date().toISOString(),
      error_summary: errorSummary.slice(0, 500),
    };
    this.append(rec);
  }

  /**
   * Read the latest record for a key. Useful for inspection / debugging.
   */
  inspect(key: string): IdempotencyRecord | null {
    const records = this.recordsFor(key);
    return records[0] || null;
  }

  /**
   * Count distinct keys by their LATEST state. Cheap O(n) scan; n is bounded
   * by the JSONL file size which the briefing rotates. total = distinct keys
   * (not raw line count); claimed/completed/failed sum to total.
   */
  stats(): { claimed: number; completed: number; failed: number; total: number } {
    if (!fs.existsSync(this.logPath)) {
      return { claimed: 0, completed: 0, failed: 0, total: 0 };
    }
    const lines = fs.readFileSync(this.logPath, 'utf8').split('\n');
    const latestByKey = new Map<string, IdempotencyRecord>();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as IdempotencyRecord;
        latestByKey.set(rec.key, rec); // last write wins, file is append-order
      } catch {
        // ignore malformed
      }
    }
    const out = { claimed: 0, completed: 0, failed: 0, total: latestByKey.size };
    for (const rec of latestByKey.values()) {
      if (rec.state === 'claimed') out.claimed += 1;
      else if (rec.state === 'completed') out.completed += 1;
      else if (rec.state === 'failed') out.failed += 1;
    }
    return out;
  }
}

// Convenience wrapper

/**
 * Run an action under idempotency protection. The signature matches the
 * Inferable / agent-ledger pattern: claim, execute, complete on success, fail
 * on throw. The caller never sees claim/complete/fail directly.
 *
 * Returns:
 *   - { fresh: true, result } when the action ran for the first time
 *   - { fresh: false, result } when a prior successful run was reused
 *   - throws if a payload mismatch or in-flight collision blocks the action
 */
export async function runIdempotent<T>(
  guard: IdempotencyGuard,
  opts: {
    key: string;
    scope: string;
    payload: unknown;
    ttlMs: number;
    onInFlight?: 'wait' | 'reject';
  },
  action: () => Promise<T>,
): Promise<{ fresh: boolean; result: T }> {
  const claim = guard.claim(opts.key, opts.scope, opts.payload, opts.ttlMs);

  if (claim.state === 'duplicate') {
    return { fresh: false, result: claim.priorResult as T };
  }

  if (claim.state === 'payload_mismatch') {
    throw new Error(
      `idempotency payload mismatch: key=${opts.key} expected ${claim.expectedHash} got ${claim.gotHash}`,
    );
  }

  if (claim.state === 'in_flight') {
    if (opts.onInFlight === 'reject' || !opts.onInFlight) {
      throw new Error(
        `idempotency in_flight: key=${opts.key} held by exec_id=${claim.exec_id} for ${claim.ageMs}ms`,
      );
    }
    // 'wait' is a placeholder for future cooperative waiting; for now, behave
    // identically to reject so callers get a deterministic error.
    throw new Error(
      `idempotency in_flight: key=${opts.key} (wait mode not yet implemented)`,
    );
  }

  // claim.state === 'fresh'
  try {
    const result = await action();
    guard.complete(opts.key, claim.exec_id, result);
    return { fresh: true, result };
  } catch (err) {
    const summary = err instanceof Error ? err.message : String(err);
    guard.fail(opts.key, claim.exec_id, summary);
    throw err;
  }
}
