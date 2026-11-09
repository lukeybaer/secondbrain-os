// idempotency-guard.ts
//
// Run 44 of the nightly enhancement cycle (2026-05-07).
//
// Claim-slot-first idempotency registry for side-effecting actions: Voice provider
// outbound calls, chat posts, Twilio SMS, Gmail sends, X publish, scheduled
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
//   - calls.ts initiateCall() can fire the same voice provider call twice if the briefing
//     pipeline retries on a transient HTTP error. Voice provider charges per dial.
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
//      - { state: 'outcome_unknown', ageMs } a claim sat in flight past the
//        in-flight TTL (a crash). The side effect may have happened, so it is
//        parked and never retried automatically; resolveOutcomeUnknown() is
//        the explicit way out (state machine audit finding #25, the owner
//        2026-11-03). A claim made with startTracked that never reached
//        markStarted() provably did nothing, so it is released instead.
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
import { createRequire } from 'module';

// ledger-state-machine.js is the shared CJS helper (legal moves, TTL, file
// lock). createRequire keeps electron-vite from rebundling it; the relative
// path resolves from src/main in tests and out/main in the build.
const cjsRequire = createRequire(import.meta.url);

interface SlotMachine {
  assertTransition(from: unknown, to: unknown): string;
  isExpired(state: unknown, since: string | number | undefined, now?: number): boolean;
}

const ledger = cjsRequire('../../scripts/lib/ledger-state-machine.js') as {
  defineStateMachine(spec: {
    name: string;
    transitions: Record<string, string[]>;
    terminal?: string[];
    inFlight?: Record<string, { ttlMs?: number; maxAttempts?: number }>;
  }): SlotMachine;
  withFileLock<T>(file: string, fn: () => T): T;
};

// Types

export type SlotState = 'claimed' | 'completed' | 'failed' | 'outcome_unknown';

/** How long a claim may sit in flight before it is treated as a crash. */
export const DEFAULT_IN_FLIGHT_TTL_MS = 30 * 60 * 1000;

// One exec_id's life. `claimed` is the only in-flight state and it expires;
// `outcome_unknown` is the parked state a crash leaves, resolved only by a
// late complete()/fail() from the real executor or by resolveOutcomeUnknown().
function buildSlotMachine(inFlightTtlMs: number): SlotMachine {
  return ledger.defineStateMachine({
    name: 'idempotency-slot',
    transitions: {
      '': ['claimed'],
      claimed: ['completed', 'failed', 'outcome_unknown'],
      outcome_unknown: ['completed', 'failed'],
    },
    terminal: ['completed', 'failed'],
    inFlight: { claimed: { ttlMs: inFlightTtlMs } },
  });
}

export interface IdempotencyRecord {
  key: string;            // deterministic, caller-supplied
  payload_hash: string;   // sha256 of the request payload, for sanity check
  state: SlotState;
  exec_id: string;        // 12-hex unique per attempt; lets you correlate logs
  claimed_at: string;     // ISO-8601
  completed_at?: string;
  failed_at?: string;
  /** Set by markStarted(): the action is about to run, so it may have run. */
  started_at?: string;
  /** The caller promised to call markStarted() before the action. */
  start_tracked?: boolean;
  outcome_unknown_at?: string;
  ttl_ms: number;
  result?: unknown;       // what complete() persisted; returned on duplicate
  error_summary?: string; // short reason for failure
  scope: string;          // 'vapi' | 'gmail' | 'telegram' | 'twilio' | 'x' | 'scheduled-task' | etc
}

export type ClaimOutcome =
  | { state: 'fresh'; exec_id: string }
  | { state: 'duplicate'; priorResult: unknown; completedAt: string }
  | { state: 'in_flight'; ageMs: number; exec_id: string }
  | { state: 'outcome_unknown'; ageMs: number; exec_id: string; since: string }
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

export interface IdempotencyGuardOptions {
  /** In-flight TTL. Past it a claim is a crash, not a running action. */
  inFlightTtlMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export class IdempotencyGuard {
  private logPath: string;
  private machine: SlotMachine;
  private now: () => number;

  constructor(logPath: string, opts: IdempotencyGuardOptions = {}) {
    this.logPath = logPath;
    this.machine = buildSlotMachine(opts.inFlightTtlMs ?? DEFAULT_IN_FLIGHT_TTL_MS);
    this.now = opts.now ?? (() => Date.now());
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

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /** The newest record of one attempt (exec_id), or null. */
  private latestFor(key: string, exec_id: string): IdempotencyRecord | null {
    return this.recordsFor(key).find((r) => r.exec_id === exec_id) ?? null;
  }

  /**
   * A claim past the in-flight TTL is a crash. If the caller tracks starts and
   * never reached markStarted(), nothing happened: release it (failed) so the
   * key can run again. Anything else may have had its side effect, so it is
   * parked as outcome_unknown and nothing retries it on its own.
   */
  private settleExpired(stale: IdempotencyRecord): 'released' | 'outcome_unknown' {
    if (stale.start_tracked && !stale.started_at) {
      this.machine.assertTransition(stale.state, 'failed');
      this.append({
        ...stale,
        state: 'failed',
        failed_at: this.nowIso(),
        error_summary: 'claim expired before the action started',
      });
      return 'released';
    }
    this.machine.assertTransition(stale.state, 'outcome_unknown');
    this.append({ ...stale, state: 'outcome_unknown', outcome_unknown_at: this.nowIso() });
    return 'outcome_unknown';
  }

  /**
   * Claim a slot. Caller MUST follow with complete() or fail() once the action
   * resolves. Same key with same payload inside TTL returns 'duplicate' with
   * the prior result. Same key with DIFFERENT payload returns 'payload_mismatch'
   * so the caller knows two different actions are colliding.
   *
   * A claim still in flight past the in-flight TTL is settled here (see
   * settleExpired): the answer is 'outcome_unknown', or a fresh slot when the
   * stale claim provably never started. `startTracked` promises a markStarted()
   * call right before the side effect, which is what makes "never started"
   * provable; without it a stale claim is always outcome_unknown.
   */
  claim(
    key: string,
    scope: string,
    payload: unknown,
    ttlMs: number,
    opts: { startTracked?: boolean } = {},
  ): ClaimOutcome {
    // Read, decision and append are one step: two processes that both find a
    // stale claim must not both settle it or both take the slot.
    return ledger.withFileLock(this.logPath, () =>
      this.claimLocked(key, scope, payload, ttlMs, opts),
    );
  }

  private claimLocked(
    key: string,
    scope: string,
    payload: unknown,
    ttlMs: number,
    opts: { startTracked?: boolean },
  ): ClaimOutcome {
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

      const nowMs = this.now();
      const claimedAt = Date.parse(latest.claimed_at);
      const ageMs = nowMs - claimedAt;

      if (latest.state === 'completed') {
        // Dedupe window runs from completion, so a late complete() or a
        // resolved outcome_unknown still gets its full window.
        const doneAt = Date.parse(latest.completed_at || latest.claimed_at);
        if (nowMs - doneAt < latest.ttl_ms) {
          return {
            state: 'duplicate',
            priorResult: latest.result,
            completedAt: latest.completed_at || latest.claimed_at,
          };
        }
        // TTL expired, fall through to fresh claim.
      }

      if (latest.state === 'outcome_unknown') {
        // Parked by an earlier crash. Never retried automatically.
        return {
          state: 'outcome_unknown',
          ageMs,
          exec_id: latest.exec_id,
          since: latest.outcome_unknown_at || latest.claimed_at,
        };
      }

      if (latest.state === 'claimed') {
        if (!this.machine.isExpired('claimed', latest.claimed_at, nowMs)) {
          // In-flight: another caller has the slot but has not finished.
          // Caller decides whether to wait, escalate, or fail closed.
          return { state: 'in_flight', ageMs, exec_id: latest.exec_id };
        }
        if (this.settleExpired(latest) === 'outcome_unknown') {
          return {
            state: 'outcome_unknown',
            ageMs,
            exec_id: latest.exec_id,
            since: this.nowIso(),
          };
        }
        // Released: the stale claim never started. Fall through to fresh.
      }
    }

    // Fresh claim path.
    const exec_id = newExecId();
    const rec: IdempotencyRecord = {
      key,
      payload_hash: incomingHash,
      state: 'claimed',
      exec_id,
      claimed_at: this.nowIso(),
      ttl_ms: ttlMs,
      scope,
    };
    if (opts.startTracked) rec.start_tracked = true;
    this.append(rec);
    return { state: 'fresh', exec_id };
  }

  /**
   * Record that the action is about to run. Call it right before the side
   * effect, for a claim made with startTracked. From here a crash leaves
   * outcome_unknown, not a free retry. Throws when the claim is no longer
   * this caller's (released or settled meanwhile): do not run the action.
   */
  markStarted(key: string, exec_id: string): void {
    ledger.withFileLock(this.logPath, () => {
      const latest = this.latestFor(key, exec_id);
      if (!latest || latest.state !== 'claimed') {
        throw new Error(
          `markStarted: no live claim for key=${key} exec_id=${exec_id}. Do not run the action.`,
        );
      }
      if (latest.started_at) return;
      this.append({ ...latest, started_at: this.nowIso() });
    });
  }

  /**
   * Mark the claimed slot as completed. Stores the result so future duplicate
   * calls can short-circuit and return it. A late complete() on a slot parked
   * as outcome_unknown is the real executor reporting in: it resolves it.
   */
  complete(key: string, exec_id: string, result: unknown): void {
    ledger.withFileLock(this.logPath, () => {
      const latest = this.latestFor(key, exec_id);
      if (!latest) {
        throw new Error(
          `complete: no claimed slot for key=${key} exec_id=${exec_id}. ` +
            `Caller must claim() first; never call complete() out of order.`,
        );
      }
      this.machine.assertTransition(latest.state, 'completed');
      this.append({
        ...latest,
        state: 'completed',
        completed_at: this.nowIso(),
        result,
      });
    });
  }

  /**
   * Mark the claimed slot as failed. Future claims with the same key will be
   * allowed (a fail does NOT count as a completion).
   */
  fail(key: string, exec_id: string, errorSummary: string): void {
    ledger.withFileLock(this.logPath, () => {
      const latest = this.latestFor(key, exec_id);
      // Tolerate fail() on a missing or already-settled claim so callers can
      // defensively emit it from finally blocks without crashing.
      if (!latest || (latest.state !== 'claimed' && latest.state !== 'outcome_unknown')) return;
      this.append({
        ...latest,
        state: 'failed',
        failed_at: this.nowIso(),
        error_summary: errorSummary.slice(0, 500),
      });
    });
  }

  /**
   * The explicit way out of outcome_unknown, for a person or a reconcile job
   * that checked the outside world. `happened` records the result and makes
   * later claims duplicates; `did_not_happen` frees the key for a retry.
   */
  resolveOutcomeUnknown(
    key: string,
    exec_id: string,
    resolution:
      | { outcome: 'happened'; result?: unknown }
      | { outcome: 'did_not_happen'; note?: string },
  ): void {
    ledger.withFileLock(this.logPath, () => {
      const latest = this.latestFor(key, exec_id);
      if (!latest || latest.state !== 'outcome_unknown') {
        throw new Error(
          `resolveOutcomeUnknown: key=${key} exec_id=${exec_id} is not parked as outcome_unknown.`,
        );
      }
      if (resolution.outcome === 'happened') {
        this.machine.assertTransition(latest.state, 'completed');
        this.append({
          ...latest,
          state: 'completed',
          completed_at: this.nowIso(),
          result: resolution.result,
        });
        return;
      }
      this.machine.assertTransition(latest.state, 'failed');
      this.append({
        ...latest,
        state: 'failed',
        failed_at: this.nowIso(),
        error_summary: (resolution.note || 'confirmed it did not happen').slice(0, 500),
      });
    });
  }

  /**
   * Settle every claim that sat in flight past the TTL, so a crash shows up as
   * outcome_unknown (or is released) without waiting for the next claim of that
   * key. Safe to run on a timer.
   */
  sweepExpired(): { outcome_unknown: string[]; released: string[] } {
    const out = { outcome_unknown: [] as string[], released: [] as string[] };
    if (!fs.existsSync(this.logPath)) return out;
    return ledger.withFileLock(this.logPath, () => {
      const latestByKey = new Map<string, IdempotencyRecord>();
      for (const line of fs.readFileSync(this.logPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as IdempotencyRecord;
          latestByKey.set(rec.key, rec);
        } catch {
          // ignore malformed
        }
      }
      const nowMs = this.now();
      for (const rec of latestByKey.values()) {
        if (rec.state !== 'claimed') continue;
        if (!this.machine.isExpired('claimed', rec.claimed_at, nowMs)) continue;
        const verdict = this.settleExpired(rec);
        out[verdict === 'released' ? 'released' : 'outcome_unknown'].push(rec.key);
      }
      return out;
    });
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
   * (not raw line count); the four states sum to total.
   */
  stats(): {
    claimed: number;
    completed: number;
    failed: number;
    outcome_unknown: number;
    total: number;
  } {
    if (!fs.existsSync(this.logPath)) {
      return { claimed: 0, completed: 0, failed: 0, outcome_unknown: 0, total: 0 };
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
    const out = { claimed: 0, completed: 0, failed: 0, outcome_unknown: 0, total: latestByKey.size };
    for (const rec of latestByKey.values()) {
      if (rec.state === 'claimed') out.claimed += 1;
      else if (rec.state === 'completed') out.completed += 1;
      else if (rec.state === 'failed') out.failed += 1;
      else if (rec.state === 'outcome_unknown') out.outcome_unknown += 1;
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
 * The claim is start-tracked: markStarted() runs right before the action, so
 * a crash before that point is released and a crash after it is parked as
 * outcome_unknown (never silently re-run).
 *
 * Returns:
 *   - { fresh: true, result } when the action ran for the first time
 *   - { fresh: false, result } when a prior successful run was reused
 *   - throws if a payload mismatch, in-flight collision or outcome_unknown
 *     blocks the action
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
  const claim = guard.claim(opts.key, opts.scope, opts.payload, opts.ttlMs, {
    startTracked: true,
  });

  if (claim.state === 'duplicate') {
    return { fresh: false, result: claim.priorResult as T };
  }

  if (claim.state === 'payload_mismatch') {
    throw new Error(
      `idempotency payload mismatch: key=${opts.key} expected ${claim.expectedHash} got ${claim.gotHash}`,
    );
  }

  if (claim.state === 'outcome_unknown') {
    throw new Error(
      `idempotency outcome_unknown: key=${opts.key} exec_id=${claim.exec_id} since ${claim.since}; ` +
        `check the outside world, then resolveOutcomeUnknown()`,
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

  // claim.state === 'fresh'. markStarted sits outside the try: if the claim was
  // released meanwhile it throws, and fail() must not touch that record.
  guard.markStarted(opts.key, claim.exec_id);
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
