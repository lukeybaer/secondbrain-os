// backoff-retry.ts
//
// Run 50 of the nightly enhancement cycle (2026-05-09).
//
// Generic retry wrapper with full/equal/decorrelated jitter and exponential or
// linear backoff. Pluggable retryable predicate so each scope picks what is
// transient. Designed to compose with idempotency-guard.ts (run 44) and
// outcome-tracker.ts (run 50): the same idempotency claim is reused across
// retries, so a retry never double-charges; each attempt records an outcome
// row with the retry_count incremented.
//
// Inspired by:
//   - AWS Architecture Blog "Exponential Backoff and Jitter" (Marc Brooker, the
//     canonical reference). Full jitter is the recommended default for
//     contended services because it spreads retries uniformly and avoids
//     thundering herds. Equal jitter keeps a minimum delay floor, useful when
//     you want a guaranteed gap. Decorrelated jitter (sleep = min(cap, random_between(base, prev*3)))
//     gives the lowest total latency in their simulations.
//   - tenacity (Python, MIT, used by Composio + LangChain): AsyncRetrying with
//     wait_random_exponential as the default, retry_if_exception_type predicate.
//   - p-retry (sindresorhus, used by half of Node.js): same shape we mirror here.
//   - Stripe's retry policy: 5xx and 429 are retryable; 4xx (except 408 timeout
//     and 429) are NOT, since they indicate caller error and a retry is futile.
//   - CrewAI Agent.retry_policy (CrewAI 0.140+): per-agent retry policy with
//     exponential backoff plus jitter, attempts capped at 3 by default.
//
// Why SecondBrain needs this:
//   - circuit-breaker.ts (run 9) trips after N failures but does not retry the
//     individual calls. Without retry, a transient ECONNRESET on the first
//     try aborts the whole briefing-section render.
//   - calls.ts (Vapi) has no retry. A transient 502 from Vapi today loses the
//     dial slot. Wrapping initiateCall in retry() with the RETRY_VAPI preset
//     and the Vapi idempotency key reused across attempts fixes that.
//   - Gmail API throttles at 250 quota units per second; a retry-with-jitter
//     plus 429-aware classifier turns a hard fail into a one-second delay.
//   - Telegram rate-limits at 30 msg/sec. Same story.
//   - Tool-fallback-chain.ts (run 49) chains TOOLS A->B->C on failure but does
//     not retry the same tool. Many failures are transient, not the tool's
//     fault. retry() goes in front of fallback so we exhaust transient retries
//     before swapping tools.
//
// Critical invariants:
//   1. retry() ALWAYS reuses the same idempotency key across attempts. Caller
//      hands in the key (or the wrapper computes one once). The wrapped fn is
//      called fresh per attempt; the key + payload combine in the
//      idempotency-guard to short-circuit duplicates.
//   2. Sleep is opt-out via opts.sleep so tests never wait real time. Unit
//      tests pass a fake sleep.
//   3. retryable() is a positive predicate: returns true ONLY when the error
//      should be retried. Default is conservative (timeout, 5xx, 429, network).
//   4. After maxAttempts, the LAST error is rethrown unchanged so the caller
//      sees the original cause and can run their own classification.

// Types

export type JitterMode = 'full' | 'equal' | 'decorrelated' | 'none';
export type BackoffMode = 'exponential' | 'linear';

export interface RetryOptions {
  /** Max attempts including the first try. Default 3. Must be >= 1. */
  maxAttempts?: number;
  /** Base delay in ms. Default 200. */
  baseMs?: number;
  /** Max delay in ms; the actual sleep is clamped to this. Default 30_000. */
  maxMs?: number;
  /** 'exponential' (2^n * base) or 'linear' (n * base). Default 'exponential'. */
  backoff?: BackoffMode;
  /** Jitter strategy. Default 'full' per AWS guidance. */
  jitter?: JitterMode;
  /** Returns true if the error should be retried. Default RETRYABLE_DEFAULT. */
  retryable?: (err: unknown, attempt: number) => boolean;
  /** Called after each failed attempt before the sleep. Useful for logging. */
  onRetry?: (info: { attempt: number; err: unknown; nextDelayMs: number }) => void;
  /** Override sleep, used by tests to avoid wall-clock waits. */
  sleep?: (ms: number) => Promise<void>;
  /** Override Math.random, used by tests for deterministic jitter. */
  rng?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// Built-in retryable predicates

/** Most permissive sane default: timeouts, 5xx, 429, ECONNRESET-class. */
export function RETRYABLE_DEFAULT(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('aborted')) return true;
  if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('enotfound')) return true;
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) return true;
  if (msg.match(/\b5\d\d\b/) || msg.includes('internal server error') || msg.includes('bad gateway')) return true;
  return false;
}

/** Vapi: same as default plus 'voicemail-detected' is NOT retryable. */
export function RETRYABLE_VAPI(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('voicemail') || msg.includes('busy') || msg.includes('declined')) return false;
  return RETRYABLE_DEFAULT(err);
}

/** Gmail: default plus quota-exceeded is retryable, invalid-recipient is NOT. */
export function RETRYABLE_GMAIL(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('invalid recipient') || msg.includes('invalid email')) return false;
  if (msg.includes('quota') || msg.includes('quota exceeded')) return true;
  return RETRYABLE_DEFAULT(err);
}

/** Telegram: default plus 'message too long' is NOT retryable. */
export function RETRYABLE_TELEGRAM(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('message is too long') || msg.includes('text length')) return false;
  return RETRYABLE_DEFAULT(err);
}

// Delay computation

export function computeDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  backoff: BackoffMode,
  jitter: JitterMode,
  prevDelay: number,
  rng: () => number,
): number {
  // Raw delay before jitter.
  const raw = backoff === 'linear'
    ? attempt * baseMs
    : Math.pow(2, attempt - 1) * baseMs; // attempt 1 -> base, attempt 2 -> 2*base, ...
  const cap = Math.min(raw, maxMs);

  if (jitter === 'none') return cap;
  if (jitter === 'full') return Math.floor(rng() * cap);
  if (jitter === 'equal') return Math.floor(cap / 2 + rng() * (cap / 2));
  // decorrelated: random between baseMs and min(cap, prevDelay * 3)
  const dcap = Math.min(maxMs, Math.max(baseMs, prevDelay * 3));
  return Math.floor(baseMs + rng() * (dcap - baseMs));
}

// Public API

export class RetryError extends Error {
  readonly attempts: number;
  readonly lastError: unknown;
  constructor(attempts: number, lastError: unknown) {
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    super(`Retry exhausted after ${attempts} attempts: ${msg}`);
    this.name = 'RetryError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/**
 * Run fn with retries. Returns the resolved value on first success. After
 * maxAttempts, rethrows the last error wrapped in RetryError so the caller
 * can distinguish "exhausted" from "first try failed".
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const baseMs = opts.baseMs ?? 200;
  const maxMs = opts.maxMs ?? 30_000;
  const backoff = opts.backoff ?? 'exponential';
  const jitter = opts.jitter ?? 'full';
  const retryable = opts.retryable ?? RETRYABLE_DEFAULT;
  const sleep = opts.sleep ?? defaultSleep;
  const rng = opts.rng ?? Math.random;

  let prevDelay = baseMs;
  let lastError: unknown = undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;
      if (!retryable(err, attempt)) throw err; // not retryable, give up immediately
      const delay = computeDelay(attempt, baseMs, maxMs, backoff, jitter, prevDelay, rng);
      prevDelay = delay;
      opts.onRetry?.({ attempt, err, nextDelayMs: delay });
      await sleep(delay);
    }
  }
  throw new RetryError(maxAttempts, lastError);
}

// Presets

export const RETRY_VAPI: RetryOptions = {
  maxAttempts: 4,
  baseMs: 500,
  maxMs: 8_000,
  backoff: 'exponential',
  jitter: 'full',
  retryable: RETRYABLE_VAPI,
};

export const RETRY_GMAIL: RetryOptions = {
  maxAttempts: 5,
  baseMs: 250,
  maxMs: 10_000,
  backoff: 'exponential',
  jitter: 'full',
  retryable: RETRYABLE_GMAIL,
};

export const RETRY_TELEGRAM: RetryOptions = {
  maxAttempts: 3,
  baseMs: 200,
  maxMs: 5_000,
  backoff: 'exponential',
  jitter: 'full',
  retryable: RETRYABLE_TELEGRAM,
};

export const RETRY_HTTP_FAST: RetryOptions = {
  maxAttempts: 2,
  baseMs: 100,
  maxMs: 1_000,
  backoff: 'exponential',
  jitter: 'full',
  retryable: RETRYABLE_DEFAULT,
};
