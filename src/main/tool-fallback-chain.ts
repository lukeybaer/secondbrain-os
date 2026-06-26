// tool-fallback-chain.ts
//
// Provider failover chain. Tries providers in declared order; on a transient
// failure (rate limit, 5xx, network error, circuit-breaker OPEN, predicate
// match), falls through to the next provider with the same logical request.
// Permanent failures (4xx that are not 429) short-circuit the chain so we do
// not pound a busted endpoint with the same bad payload.
//
// Patterns synthesized from:
//   - LangChain RunnableWithFallbacks (langchain-core/runnables/fallbacks.py
//     v0.3.x) -- declarative `.with_fallbacks([...])` chain that retries the
//     identical input on the next runnable when the primary throws.
//   - LiteLLM router fallbacks (litellm/router_strategy/fallbacks.py
//     2026-04-30) -- model-list with `fallbacks` config keyed by error type
//     (RateLimitError, BadRequestError, Timeout) and per-model deadlines.
//   - Letta (formerly MemGPT) provider_failover (letta/llm/llm_api_tools.py
//     2026-03) -- explicit `is_transient_error()` classifier so 4xx that are
//     not 429 are NOT retried on a sibling provider.
//   - Temporal Workflow ChildPolicy / Activity options retryPolicy
//     (sdk-typescript v1.13) -- nonRetryableErrorTypes prevents fallback on
//     deterministic errors (validation failures, malformed inputs).
//
// Why SecondBrain needs this:
//   - calls.ts hits Vapi as the only voice provider; if Vapi 5xxs the
//     briefing's outbound dial fails and ExampleCo gets no notification at all,
//     when Twilio SMS would have been a perfectly good fallback.
//   - briefing-api.ts and chat.ts run via the Claude Max harness; on harness
//     down they have no parallel path to AWS Bedrock anthropic.* models,
//     even though config supports both.
//   - Gmail send (telegram.ts neighbour) has no fallback to Telegram when
//     SMTP is degraded; users get silence instead of a downgraded delivery.
//   - circuit-breaker.ts opens the circuit on threshold breach but the
//     caller still has to handle the throw. The fallback chain is the
//     natural complement: when CB is OPEN OR the call throws transient,
//     auto-route to the next provider in the chain, never asking the
//     caller to write try/catch boilerplate.
//
// Design:
//   - Pure module: no electron, no network, no fs side effects beyond an
//     optional event writer (mirrors tool-trace.ts).
//   - Each provider is described by `{ name, fn, isTransientError? }`.
//   - The chain returns the first successful result OR the last error
//     wrapped in a `FallbackChainExhausted` with the per-provider
//     attempt log, so callers can decide policy when EVERY provider is down.
//   - Integrates with circuit-breaker by accepting an optional `breaker`
//     per provider; if `breaker.isOpen()` we skip it without firing fn,
//     mirroring how Hystrix short-circuits when downstream is known dead.

import * as fs from 'fs';
import * as path from 'path';

// Types

export interface FallbackProvider<T> {
  /** Stable name for telemetry. e.g. 'claude-max', 'bedrock-claude', 'twilio'. */
  name: string;
  /** Invoke the provider. Throws on failure. */
  fn: () => Promise<T>;
  /**
   * Optional classifier. Returning true means "this error is transient,
   * try the next provider"; false means "this error is permanent, abort the
   * whole chain because every sibling will hit the same wall".
   *
   * Default classifier (when omitted): treat HTTP-style errors with status
   * 429, 500, 502, 503, 504, and anything matching /timeout|ETIMEDOUT|ECONNRESET|network/i
   * as transient. All other errors are treated as permanent.
   */
  isTransientError?: (err: ExampleCo) => boolean;
  /**
   * Optional pre-flight gate. When provided and returns false, the provider
   * is skipped silently (chain continues). Used to check circuit-breaker
   * state without coupling this module to circuit-breaker.ts.
   */
  shouldAttempt?: () => boolean;
}

export type AttemptOutcome = 'success' | 'transient_error' | 'permanent_error' | 'skipped';

export interface ProviderAttempt {
  provider: string;
  outcome: AttemptOutcome;
  duration_ms: number;
  error?: string;
  started_at: string;
}

export interface ChainResult<T> {
  ok: true;
  value: T;
  winning_provider: string;
  attempts: ProviderAttempt[];
}

export interface ChainExhausted {
  ok: false;
  attempts: ProviderAttempt[];
  /** Last error encountered. May be permanent (chain aborted) or transient
   *  (every provider failed). Inspect `attempts` for the full ledger. */
  error: Error;
  reason: 'all_transient' | 'permanent_aborted' | 'all_skipped';
}

export type AttemptWriter = (record: AttemptRecord) => void;

export interface AttemptRecord {
  timestamp: string;
  chain: string; // chain id passed to runFallbackChain
  provider: string;
  outcome: AttemptOutcome;
  duration_ms: number;
  error?: string;
}

// Default classifier

// `\b5\d\d\b` matches any 5xx code (500..599) word in a message, not just the
// 502/503/504 trio that was hardcoded before. A provider that throws
// `new Error('HTTP 500 Internal Server Error')` with no .status field used to be
// classified permanent and abort the whole chain; now it falls through to the
// next provider, matching the status-field path (status >= 500 is transient).
// The word boundaries keep it from matching e.g. "1500ms" or "5000".
const DEFAULT_TRANSIENT_PATTERN =
  /timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network|fetch failed|socket hang up|\b5\d\d\b|rate limit|too many requests/i;

export function defaultIsTransientError(err: ExampleCo): boolean {
  if (err == null) return false;
  // status code on common HTTP error shapes
  const e = err as {
    status?: number;
    statusCode?: number;
    code?: string | number;
    message?: string;
  };
  const status =
    typeof e.status === 'number'
      ? e.status
      : typeof e.statusCode === 'number'
        ? e.statusCode
        : undefined;
  if (status === 429 || (status != null && status >= 500 && status <= 599)) return true;
  // node fetch / fs / network style
  const code = typeof e.code === 'string' ? e.code : '';
  if (['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ECONNREFUSED', 'ENOTFOUND'].includes(code))
    return true;
  const msg = typeof e.message === 'string' ? e.message : String(err);
  return DEFAULT_TRANSIENT_PATTERN.test(msg);
}

// File writer (optional)

export function makeFileWriter(filePath: string): AttemptWriter {
  return (record: AttemptRecord) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
    } catch {
      // best-effort
    }
  };
}

// Core run

export interface RunFallbackOpts {
  /** Stable id for telemetry/tests. e.g. 'gmail-send', 'voice-out', 'llm-chat'. */
  chain: string;
  /** Optional writer for AttemptRecord JSONL. Defaults to no-op. */
  writer?: AttemptWriter;
}

export async function runFallbackChain<T>(
  providers: ReadonlyArray<FallbackProvider<T>>,
  opts: RunFallbackOpts,
): Promise<ChainResult<T> | ChainExhausted> {
  if (providers.length === 0) {
    return {
      ok: false,
      attempts: [],
      error: new Error('runFallbackChain: empty provider list'),
      reason: 'all_skipped',
    };
  }
  const attempts: ProviderAttempt[] = [];
  const writer = opts.writer ?? noopWriter;

  for (const provider of providers) {
    const started_at = new Date().toISOString();
    const t0 = Date.now();

    if (provider.shouldAttempt && !provider.shouldAttempt()) {
      const att: ProviderAttempt = {
        provider: provider.name,
        outcome: 'skipped',
        duration_ms: 0,
        started_at,
      };
      attempts.push(att);
      writer({
        timestamp: started_at,
        chain: opts.chain,
        provider: provider.name,
        outcome: 'skipped',
        duration_ms: 0,
      });
      continue;
    }

    try {
      const value = await provider.fn();
      const duration_ms = Date.now() - t0;
      attempts.push({
        provider: provider.name,
        outcome: 'success',
        duration_ms,
        started_at,
      });
      writer({
        timestamp: started_at,
        chain: opts.chain,
        provider: provider.name,
        outcome: 'success',
        duration_ms,
      });
      return { ok: true, value, winning_provider: provider.name, attempts };
    } catch (err) {
      const duration_ms = Date.now() - t0;
      const classifier = provider.isTransientError ?? defaultIsTransientError;
      const transient = classifier(err);
      const error_msg = err instanceof Error ? err.message : String(err);
      const outcome: AttemptOutcome = transient ? 'transient_error' : 'permanent_error';
      attempts.push({
        provider: provider.name,
        outcome,
        duration_ms,
        error: error_msg,
        started_at,
      });
      writer({
        timestamp: started_at,
        chain: opts.chain,
        provider: provider.name,
        outcome,
        duration_ms,
        error: error_msg,
      });
      if (!transient) {
        return {
          ok: false,
          attempts,
          error: err instanceof Error ? err : new Error(error_msg),
          reason: 'permanent_aborted',
        };
      }
      // continue to next provider
    }
  }

  // all attempts either skipped or transient_error
  const allSkipped = attempts.every((a) => a.outcome === 'skipped');
  const last = attempts[attempts.length - 1];
  const lastErrMsg = last?.error ?? 'all providers skipped';
  return {
    ok: false,
    attempts,
    error: new Error(`runFallbackChain[${opts.chain}] exhausted: ${lastErrMsg}`),
    reason: allSkipped ? 'all_skipped' : 'all_transient',
  };
}

const noopWriter: AttemptWriter = () => {};

// Small helper for the common case where the caller wants the value or a throw

export async function runFallbackChainOrThrow<T>(
  providers: ReadonlyArray<FallbackProvider<T>>,
  opts: RunFallbackOpts,
): Promise<T> {
  const result = await runFallbackChain(providers, opts);
  if (result.ok) return result.value;
  throw new FallbackChainExhausted(opts.chain, result);
}

export class FallbackChainExhausted extends Error {
  constructor(
    public readonly chain: string,
    public readonly result: ChainExhausted,
  ) {
    super(
      `Fallback chain '${chain}' exhausted: ${result.reason} (${result.attempts.length} attempts)`,
    );
    this.name = 'FallbackChainExhausted';
  }
}

// Pre-built classifiers

/** HTTP 429 only (rate limit) -- useful when caller wants ONLY rate-limit
 *  errors to fall through, treating 5xx as permanent so we do not paper
 *  over real backend bugs by silently routing to a sibling. */
export function rateLimitOnlyClassifier(err: ExampleCo): boolean {
  const e = err as { status?: number; statusCode?: number };
  return e.status === 429 || e.statusCode === 429;
}

/** Pattern from Letta provider_failover: anything explicitly tagged
 *  `nonRetryable=true` is permanent, everything else is transient. Used by
 *  callers that wrap their own validators with `(err as any).nonRetryable = true`. */
export function nonRetryableTagClassifier(err: ExampleCo): boolean {
  const e = err as { nonRetryable?: boolean };
  return !e.nonRetryable;
}
