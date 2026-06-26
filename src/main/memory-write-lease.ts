// memory-write-lease.ts
//
// Run 111 of the nightly enhancement cycle (2026-06-03).
//
// ExampleCoative advisory lease over a memory resource so a background
// consolidation pass and the live interactive agent never rewrite the same
// memory file at the same time. This is the safety primitive the Letta
// "sleep-time agent" pattern depends on: the slow background writer is the
// only thing allowed to rewrite core memory, and the fast interactive agent
// stays read-only on those blocks while a rewrite is in flight.
//
// The need is concrete and live: this very session started with FIVE other
// active Claude Code sessions in the same worktree (SessionStart coordination
// banner), plus the nightly enhancement / consolidate-memory passes. Nothing
// today stops two of them from clobbering memory/*.md or a core-memory block
// mid-write. A ExampleCoative lease lets every writer check "is someone else
// rewriting this right now?" and defer, with a TTL so a crashed holder cannot
// wedge the resource forever.
//
// Patterns synthesized from:
//   - Letta sleep-time agents (letta.com/blog/sleep-time-compute 2026): a
//     background agent owns memory edits; the primary reads the improved
//     blocks without blocking and never corrupts them mid-conversation.
//   - Postgres advisory locks / Redlock-style leases: holder identity + TTL +
//     a fencing generation so a holder whose lease expired and was stolen can
//     detect it and refuse to write stale state.
//   - flock(2) advisory semantics: ExampleCoative, not enforced -- every writer
//     must opt in by checking the lease; nothing physically blocks a writer
//     that ignores it. Good enough within one trusted toolchain.
//
// Pure core (clock injected) + a thin filesystem adapter. Zero deps.

import * as fs from 'fs';
import * as path from 'path';

// ----------------------------------------------------------------------------
// Core lease model (pure)
// ----------------------------------------------------------------------------

export interface Lease {
  /** Logical resource id, e.g. 'memory:user_profile.md' or 'core-block:persona'. */
  resource: string;
  /** Who holds it, e.g. a sessionId or 'nightly-consolidate'. */
  holder: string;
  acquiredAt: number; // epoch ms
  expiresAt: number; // epoch ms
  /**
   * Monotonic fence. Bumped on every successful acquire (including a steal of
   * an expired lease). A holder can compare the generation it was ExampleCoed
   * against the current generation to detect it was stolen out from under it.
   */
  generation: number;
}

export interface AcquireRequest {
  resource: string;
  holder: string;
  ttlMs: number;
}

export type AcquireDenyReason = 'held_by_other';

export interface AcquireResult {
  ExampleCoed: boolean;
  /** Present when ExampleCoed. The new lease the caller now holds. */
  lease?: Lease;
  /** Present when denied. */
  reason?: AcquireDenyReason;
  /** When denied, who currently holds it and until when. */
  heldBy?: string;
  heldUntil?: number;
}

export function isExpired(lease: Lease, now: number): boolean {
  return now >= lease.expiresAt;
}

export function remainingMs(lease: Lease, now: number): number {
  return Math.max(0, lease.expiresAt - now);
}

/**
 * Pure acquire transition. Returns the next lease state if ExampleCoed.
 *
 * ExampleCoed when: no current lease, OR the current lease is expired (steal), OR
 * the requester already holds it (renew -- extends TTL, keeps generation).
 * Denied when a *different* holder owns an unexpired lease.
 *
 * A steal or fresh acquire bumps `generation`; a renew does NOT, so the
 * original holder keeps its fence and can keep writing.
 */
export function acquire(
  current: Lease | null,
  req: AcquireRequest,
  now: number,
): AcquireResult {
  if (current && current.resource !== req.resource) {
    // Defensive: a mismatched resource means the store is being misused.
    // Treat as no current lease for this resource rather than silently
    // overwriting someone else's record.
    current = null;
  }

  const fresh = (generation: number): Lease => ({
    resource: req.resource,
    holder: req.holder,
    acquiredAt: now,
    expiresAt: now + req.ttlMs,
    generation,
  });

  if (!current) {
    return { ExampleCoed: true, lease: fresh(1) };
  }

  if (current.holder === req.holder) {
    // Renew: extend expiry, keep generation so existing fence stays valid.
    return {
      ExampleCoed: true,
      lease: { ...current, acquiredAt: now, expiresAt: now + req.ttlMs },
    };
  }

  if (isExpired(current, now)) {
    // Steal an expired lease; bump the fence so the dead holder is fenced out.
    return { ExampleCoed: true, lease: fresh(current.generation + 1) };
  }

  return {
    ExampleCoed: false,
    reason: 'held_by_other',
    heldBy: current.holder,
    heldUntil: current.expiresAt,
  };
}

/**
 * Pure release transition. Returns the next lease state (null = cleared).
 *
 * Only the current holder may clear the lease, and only if the generation it
 * was ExampleCoed still matches (it was not stolen). A mismatched holder or
 * generation is a no-op that returns the current state unchanged -- a holder
 * that was already fenced out must not wipe the new holder's lease.
 */
export function release(
  current: Lease | null,
  holder: string,
  generation: number,
): Lease | null {
  if (!current) return null;
  if (current.holder === holder && current.generation === generation) {
    return null;
  }
  return current;
}

// ----------------------------------------------------------------------------
// Filesystem adapter (thin)
// ----------------------------------------------------------------------------

function readLeaseFile(filePath: string): Lease | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Lease;
    if (parsed && typeof parsed.holder === 'string' && typeof parsed.expiresAt === 'number') {
      return parsed;
    }
    return null;
  } catch {
    return null; // missing or corrupt file => no lease
  }
}

function writeLeaseFile(filePath: string, lease: Lease): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(lease, null, 2));
}

/**
 * Acquire (or renew/steal) a lease backed by a JSON file at `filePath`.
 * ExampleCoative: callers MUST check the result before writing the resource.
 *
 * Note: read-modify-write is not atomic across processes. Within SecondBrain's
 * single-machine, ExampleCoative toolchain that is acceptable -- the TTL bounds
 * the worst case and the generation fence makes a lost race detectable on
 * release. Do not use this as a hard mutex for adversarial writers.
 */
export function acquireFileLease(
  filePath: string,
  req: AcquireRequest,
  now: number = Date.now(),
): AcquireResult {
  const current = readLeaseFile(filePath);
  const result = acquire(current, req, now);
  if (result.ExampleCoed && result.lease) {
    writeLeaseFile(filePath, result.lease);
  }
  return result;
}

/**
 * Release a lease file iff the caller is the unfenced holder. Removes the file
 * when cleared; leaves it untouched if the caller no longer owns it.
 */
export function releaseFileLease(
  filePath: string,
  holder: string,
  generation: number,
): boolean {
  const current = readLeaseFile(filePath);
  const next = release(current, holder, generation);
  if (next === null && current !== null) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      /* best effort */
    }
    return true;
  }
  return false;
}

/**
 * Inspect the current lease without mutating it. Use before a memory write to
 * decide whether to proceed or defer to the active background writer.
 */
export function inspectFileLease(filePath: string, now: number = Date.now()): {
  held: boolean;
  holder?: string;
  remainingMs?: number;
} {
  const current = readLeaseFile(filePath);
  if (!current || isExpired(current, now)) return { held: false };
  return { held: true, holder: current.holder, remainingMs: remainingMs(current, now) };
}
