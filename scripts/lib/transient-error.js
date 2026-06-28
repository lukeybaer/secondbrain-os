// scripts/lib/transient-error.js
//
// Run 150 of the nightly enhancement cycle (2026-06-28).
//
// Shared, zero-dependency transient-error classifier + bounded retry helper for
// the CommonJS / EC2 surfaces. SecondBrain already has src/main/backoff-retry.ts
// (run 50), but it is TypeScript/ESM living in the Electron main process and is
// imported by ZERO runtime files -- it cannot be required from the plain-Node
// CJS modules that run the LLM ladder (scripts/lib/ask-ai.js) and the briefing
// news fetch (scripts/lib/news-summarize.js) on EC2. Those two surfaces fail
// SINGLE-SHOT today: one transient ECONNRESET on the Claude rung descends Amy
// to a paid floor, and one transient blip on an article fetch silently drops a
// real article from the briefing news card. This module is the missing CJS-side
// primitive so both can absorb a blip instead of degrading.
//
// Scope discipline: "transient" means the SAME call has a real chance of
// succeeding on an immediate retry -- connection resets, timeouts, DNS hiccups,
// and the retryable HTTP status family (408/425/429/500/502/503/504). A 404, a
// 403, an auth sentinel, or a caller bug is NOT transient and must NOT retry
// (retrying is futile and wastes the dial slot / quota). This mirrors the
// Stripe + tenacity + p-retry classifiers that backoff-retry.ts already cites.
//
// Pure Node builtins. No deps. Sleep is injectable so tests run instantly.

'use strict';

// Node socket / DNS error codes that are worth one more try.
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EAI_AGAIN',
  'EPIPE',
  'ENOTFOUND', // intermittent DNS; a single retry is cheap and often resolves it
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ESOCKETTIMEDOUT',
]);

// HTTP statuses that indicate "try again", per Stripe / tenacity conventions.
// 408 request timeout, 425 too early, 429 rate limited, 5xx server-side.
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

// Substrings that show up in thrown Error messages for transient conditions
// (Node sometimes throws a bare Error('socket hang up') with no .code).
const TRANSIENT_MESSAGE_HINTS = [
  'socket hang up',
  'network',
  'timeout',
  'timed out',
  'temporarily unavailable',
  'rate limit',
  'too many requests',
  'connection reset',
  'econnreset',
  'etimedout',
];

/**
 * Decide whether an error (or an HTTP status number) is worth an immediate
 * retry. Accepts an Error, a number (status code), or a {status|statusCode}
 * object. Defaults to FALSE: an ExampleCo error is treated as non-transient so we
 * never retry a futile call.
 */
function isTransientError(err) {
  if (err == null) return false;

  // Bare status code.
  if (typeof err === 'number') return TRANSIENT_STATUS.has(err);

  // Status ExampleCod on the error/response object.
  const status = err.status || err.statusCode || (err.response && err.response.status);
  if (typeof status === 'number' && TRANSIENT_STATUS.has(status)) return true;

  // Node system-error code.
  if (err.code && TRANSIENT_CODES.has(err.code)) return true;

  // Fall back to message sniffing for code-less transient throws.
  const msg = String((err && err.message) || err).toLowerCase();
  if (!msg) return false;
  return TRANSIENT_MESSAGE_HINTS.some((h) => msg.includes(h));
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run an async fn, retrying ONLY on transient failures, with exponential
 * backoff. Non-transient failures throw immediately (no wasted retries). The
 * last error is rethrown once retries are exhausted, so the caller still sees a
 * loud failure -- this never swallows.
 *
 *   await withTransientRetry(() => callRung(q), { retries: 1, baseMs: 150 })
 *
 * opts:
 *   retries     extra attempts after the first (default 1, so 2 tries total)
 *   baseMs      first backoff delay in ms (default 150)
 *   factor      backoff multiplier (default 2)
 *   maxMs       backoff ceiling in ms (default 2000)
 *   isTransient predicate override (default isTransientError)
 *   sleep       injectable delay (default real setTimeout) -- tests pass a noop
 *   onRetry     callback({ attempt, error, delayMs }) for observability
 */
async function withTransientRetry(fn, opts = {}) {
  const retries = Number.isInteger(opts.retries) ? opts.retries : 1;
  const baseMs = opts.baseMs != null ? opts.baseMs : 150;
  const factor = opts.factor != null ? opts.factor : 2;
  const maxMs = opts.maxMs != null ? opts.maxMs : 2000;
  const isTransient = opts.isTransient || isTransientError;
  const sleep = opts.sleep || defaultSleep;

  let attempt = 0;
  // total attempts = retries + 1
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const canRetry = attempt < retries && isTransient(err);
      if (!canRetry) throw err;
      const delayMs = Math.min(maxMs, baseMs * Math.pow(factor, attempt));
      if (typeof opts.onRetry === 'function') {
        opts.onRetry({ attempt: attempt + 1, error: err, delayMs });
      }
      await sleep(delayMs);
      attempt += 1;
    }
  }
}

module.exports = {
  isTransientError,
  withTransientRetry,
  TRANSIENT_CODES,
  TRANSIENT_STATUS,
};
