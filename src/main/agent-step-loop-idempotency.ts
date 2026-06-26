// agent-step-loop-idempotency.ts
//
// Run 96 nightly enhancement: glue between agent-step-loop.ts and
// idempotency-guard.ts.
//
// Pattern sources:
//   - Inferable.ai distributed tool calling (2026-04): INSERT-then-execute
//     order; the dedup table is updated BEFORE the side-effecting tool
//     runs, so a crash between execution and commit cannot allow a retry
//     to re-execute.
//   - Stripe idempotency-key (canonical reference): {scope, key} -> result
//     for a TTL window; retries return the same response.
//   - agent-ledger 2026 HN reference: idempotent tool execution for
//     autonomous agents, where the agent's run loop is the durable thing.
//
// Why a new module: agent-step-loop.ts must stay LLM-agnostic and
// idempotency-guard.ts must stay scope-agnostic (it already serves Vapi,
// Twilio, Gmail, scheduled tasks). Putting the bridge in its own module
// means callers opt in by importing this file, and tests can stub the
// guard cleanly.

import * as crypto from 'crypto';
import type { IdempotencyGuard } from './idempotency-guard';
import { deterministicKey, payloadHash } from './idempotency-guard';
import type { IdempotencyHook } from './agent-step-loop';

export interface AdapterOptions {
  /**
   * Scope tag stored on the idempotency record. Defaults to 'agent-loop'.
   * Use a per-caller scope ('briefing', 'voice-call', 'dispatch') so the
   * health probe can group dedup activity by surface.
   */
  scope?: string;
  /**
   * TTL in milliseconds for completed records. After this window the same
   * key is allowed to re-execute as fresh. Defaults to 24h, matching
   * Stripe's canonical TTL.
   */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Build an IdempotencyHook backed by an IdempotencyGuard. The key is
 * derived from {scope, run_id, tool, args_hash} so:
 *   - the same write to the same tool with the same args inside a run is
 *     the same key (resume + retry short-circuit). This matches Stripe's
 *     canonical run-scoped semantics: idempotency is about the LOGICAL
 *     action, not the step that triggered it.
 *   - different arguments to the same tool get different keys (a real
 *     second send to a different recipient is NOT collapsed).
 *   - different runs get different keys (a new run is a clean slate).
 *
 * Side effects:
 *   - claim() is called BEFORE the tool runs. If the slot is already
 *     completed and within TTL, the loop short-circuits with the prior
 *     result.
 *   - On a successful execution, complete() is called with the tool result.
 *   - On a failed execution, fail() is called so a retry is permitted.
 *
 * In-flight conflicts (another caller claimed the slot but has not
 * completed) are surfaced as a duplicate with a synthetic result so the
 * model can observe and recover. The alternative (throwing) would crash
 * the loop, which is worse than letting the model see "another worker is
 * handling this" and react.
 */
export function makeIdempotencyAdapter(
  guard: IdempotencyGuard,
  opts: AdapterOptions = {},
): IdempotencyHook {
  const scope = opts.scope ?? 'agent-loop';
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  return {
    beforeTool(args) {
      const hash = payloadHash(args.arguments);
      const key = deterministicKey(scope, [
        args.run_id,
        args.tool,
        hash,
      ]);
      const claim = guard.claim(key, scope, args.arguments, ttlMs);
      if (claim.state === 'duplicate') {
        return { duplicate: true, result: claim.priorResult };
      }
      if (claim.state === 'in_flight') {
        // Treat as duplicate with a marker payload so the model can see
        // someone else is mid-flight and react. Never crash the loop.
        return {
          duplicate: true,
          result: {
            __idempotency: 'in_flight',
            exec_id: claim.exec_id,
            age_ms: claim.ageMs,
          },
        };
      }
      if (claim.state === 'payload_mismatch') {
        // Same key, different payload. Surfaces as duplicate so the loop
        // does not double-execute; the marker payload tells the model the
        // collision happened.
        return {
          duplicate: true,
          result: {
            __idempotency: 'payload_mismatch',
            expected_hash: claim.expectedHash,
            got_hash: claim.gotHash,
          },
        };
      }
      // Fresh claim. Stash the synthetic exec_id encoded with the key so
      // afterTool can locate the right record.
      return { duplicate: false, exec_id: `${key}:${claim.exec_id}` };
    },

    afterTool(args, outcome) {
      const [key, exec_id] = args.exec_id.split(':');
      if (!key || !exec_id) return;
      try {
        if (outcome.ok) {
          guard.complete(key, exec_id, outcome.result);
        } else {
          guard.fail(key, exec_id, outcome.error);
        }
      } catch {
        // Guard mutation failures must not crash the loop. They are logged
        // upstream by the idempotency module itself.
      }
    },
  };
}

/**
 * In-memory IdempotencyHook for tests. No fs, no JSONL. Behavior is
 * faithful to the guard contract: a successful first call short-circuits
 * the second call with the same key, while a failed call clears the slot.
 */
export class InMemoryIdempotency implements IdempotencyHook {
  private completed = new Map<string, ExampleCo>();
  private inFlight = new Set<string>();

  beforeTool(args: Parameters<IdempotencyHook['beforeTool']>[0]) {
    const key = this.keyFor(args);
    if (this.completed.has(key)) {
      return { duplicate: true as const, result: this.completed.get(key) };
    }
    this.inFlight.add(key);
    return { duplicate: false as const, exec_id: key };
  }

  afterTool(
    args: Parameters<IdempotencyHook['afterTool']>[0],
    outcome: Parameters<IdempotencyHook['afterTool']>[1],
  ) {
    this.inFlight.delete(args.exec_id);
    if (outcome.ok) {
      this.completed.set(args.exec_id, outcome.result);
    }
  }

  private keyFor(args: Parameters<IdempotencyHook['beforeTool']>[0]): string {
    const argsHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(args.arguments))
      .digest('hex')
      .slice(0, 16);
    return `${args.run_id}|${args.tool}|${argsHash}`;
  }

  /** Test helper: how many fresh executions were claimed. */
  completedCount(): number {
    return this.completed.size;
  }
}
