// circuit-breaker.ts
//
// Resilience layer for external API calls (Vapi, Gmail, Telegram, Graphiti).
// Implements three-state circuit breaker (closed → open → half-open) with
// per-tool exponential backoff and jitter.
//
// Pattern: Portkey / Netflix Hystrix adapted for single-process Node.js.
// Why: tool-trace.ts observes failures but doesn't prevent cascading failures
// when one API goes down. Without a circuit breaker, a dead Vapi endpoint
// hammers retries for every caller simultaneously and burns tokens.
//
// State machine:
//   CLOSED  → normal operation, failures tracked
//   OPEN    → all calls rejected immediately (fast-fail), resetTimeout cooldown
//   HALF_OPEN → one probe call allowed; success → CLOSED, failure → OPEN
//
// Usage:
//   const cb = getCircuitBreaker('vapi');
//   const result = await cb.execute(() => callVapiApi(params));

import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number;  // failures before tripping (default: 5)
  successThreshold?: number;  // successes in HALF_OPEN to close (default: 2)
  resetTimeoutMs?: number;    // ms to wait before probing again (default: 60_000)
  maxRetries?: number;        // max attempts per call (default: 3)
  baseDelayMs?: number;       // base for exponential backoff (default: 500)
  maxDelayMs?: number;        // cap on backoff delay (default: 30_000)
  jitterFactor?: number;      // random jitter 0..1 (default: 0.3)
}

export interface CircuitBreakerStats {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  totalCalls: number;
  lastFailureAt: string | null;
  lastStateChange: string;
}

// ── Circuit Breaker ───────────────────────────────────────────────────────────

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private successes = 0;
  private totalCalls = 0;
  private lastFailureAt: number | null = null;
  private lastStateChange = Date.now();

  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterFactor: number;

  constructor(
    public readonly name: string,
    opts: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.successThreshold = opts.successThreshold ?? 2;
    this.resetTimeoutMs   = opts.resetTimeoutMs   ?? 60_000;
    this.maxRetries       = opts.maxRetries       ?? 3;
    this.baseDelayMs      = opts.baseDelayMs      ?? 500;
    this.maxDelayMs       = opts.maxDelayMs       ?? 30_000;
    this.jitterFactor     = opts.jitterFactor     ?? 0.3;
  }

  // ── State helpers ────────────────────────────────────────────────────────────

  private trip(): void {
    this.state = 'OPEN';
    this.lastStateChange = Date.now();
  }

  private reset(): void {
    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.lastStateChange = Date.now();
  }

  private probe(): void {
    this.state = 'HALF_OPEN';
    this.successes = 0;
    this.lastStateChange = Date.now();
  }

  // ── Backoff ──────────────────────────────────────────────────────────────────

  private backoffMs(attempt: number): number {
    const exp = Math.min(this.baseDelayMs * Math.pow(2, attempt), this.maxDelayMs);
    const jitter = exp * this.jitterFactor * Math.random();
    return Math.floor(exp + jitter);
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ── Execute ──────────────────────────────────────────────────────────────────

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Transition OPEN → HALF_OPEN after cooldown
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - (this.lastFailureAt ?? this.lastStateChange);
      if (elapsed >= this.resetTimeoutMs) {
        this.probe();
      } else {
        const waitMs = this.resetTimeoutMs - elapsed;
        throw new CircuitOpenError(this.name, waitMs);
      }
    }

    let lastErr: ExampleCo;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      this.totalCalls++;

      try {
        const result = await fn();

        // Success
        if (this.state === 'HALF_OPEN') {
          this.successes++;
          if (this.successes >= this.successThreshold) this.reset();
        } else {
          // Partial recovery: decay failures on success
          if (this.failures > 0) this.failures = Math.max(0, this.failures - 1);
        }

        return result;
      } catch (err) {
        lastErr = err;
        this.failures++;
        this.lastFailureAt = Date.now();

        if (this.state === 'HALF_OPEN') {
          // Any failure in probe mode re-opens immediately
          this.trip();
          throw err;
        }

        if (this.failures >= this.failureThreshold) {
          this.trip();
          throw new CircuitOpenError(this.name, this.resetTimeoutMs);
        }

        // Retry with backoff (last attempt does not sleep)
        if (attempt < this.maxRetries - 1) {
          await this.sleep(this.backoffMs(attempt));
        }
      }
    }

    throw lastErr;
  }

  // ── Stats ────────────────────────────────────────────────────────────────────

  stats(): CircuitBreakerStats {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      totalCalls: this.totalCalls,
      lastFailureAt: this.lastFailureAt
        ? new Date(this.lastFailureAt).toISOString()
        : null,
      lastStateChange: new Date(this.lastStateChange).toISOString(),
    };
  }

  /** Manually reset (e.g. after a deployment that fixed the downstream service). */
  forceReset(): void {
    this.reset();
  }
}

// ── Typed error ───────────────────────────────────────────────────────────────

export class CircuitOpenError extends Error {
  constructor(
    public readonly circuitName: string,
    public readonly retryAfterMs: number,
  ) {
    super(
      `Circuit "${circuitName}" is OPEN. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`,
    );
    this.name = 'CircuitOpenError';
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────
// One shared breaker per external dependency, lazily created.

const _registry = new Map<string, CircuitBreaker>();

const PRESETS: Record<string, CircuitBreakerOptions> = {
  vapi:     { failureThreshold: 3, resetTimeoutMs: 30_000,  maxRetries: 2, baseDelayMs: 1_000 },
  gmail:    { failureThreshold: 5, resetTimeoutMs: 60_000,  maxRetries: 3, baseDelayMs: 500   },
  telegram: { failureThreshold: 5, resetTimeoutMs: 60_000,  maxRetries: 3, baseDelayMs: 500   },
  graphiti: { failureThreshold: 3, resetTimeoutMs: 120_000, maxRetries: 2, baseDelayMs: 2_000 },
  otter:    { failureThreshold: 5, resetTimeoutMs: 60_000,  maxRetries: 3, baseDelayMs: 1_000 },
};

export function getCircuitBreaker(name: string, opts?: CircuitBreakerOptions): CircuitBreaker {
  if (!_registry.has(name)) {
    _registry.set(name, new CircuitBreaker(name, opts ?? PRESETS[name] ?? {}));
  }
  return _registry.get(name)!;
}

/** Snapshot of all known circuit breakers. Used by health checks. */
export function allCircuitStats(): CircuitBreakerStats[] {
  return Array.from(_registry.values()).map((cb) => cb.stats());
}

// ── Snapshot persistence ──────────────────────────────────────────────────────
// Write stats to a JSONL log so the briefing can surface tripped circuits.

export function writeCircuitSnapshot(logPath: string): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const record = {
      timestamp: new Date().toISOString(),
      circuits: allCircuitStats(),
    };
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
  } catch {
    /* best-effort */
  }
}
