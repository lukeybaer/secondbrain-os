/**
 * Retry Taxonomy (run 105)
 *
 * `backoff-retry.ts` ships `retry()` whose `retryable` predicate defaults to
 * RETRYABLE_DEFAULT, which classifies by substring-matching the error MESSAGE
 * (looks for "500", "429", "econnreset", etc). That works when the message
 * happens to contain those tokens but misses the structured shape real clients
 * throw: an error object carrying `status` / `statusCode` / `response.status`,
 * a transport `code` on `err` or `err.cause`, or a `Retry-After` header. A 429
 * thrown as `{ status: 429, headers: {...} }` with a clean message slips past
 * the substring matcher and is treated as fatal.
 *
 * This module is the structured-shape classifier that complements the message
 * matcher. It inspects the error OBJECT (not just its text) and applies the
 * split proven by mature clients (Composio, AWS SDK, Stripe): retry transient
 * transport codes and the server-side / throttling status codes
 * (408, 409, 425, 429, >=500); treat the remaining 4xx as fatal. It also
 * extracts a `Retry-After` hint so callers can honor a server's backoff
 * instruction instead of guessing.
 *
 * Pure, dependency-free. Plug `isRetryable` straight into `retry`:
 *
 *   await retry(fn, { retryable: isRetryable });
 *
 * and use `retryAfterMs(err)` inside `onRetry` to respect server throttling.
 */

export type RetryCategory =
  | "network" // transport-level failure (reset, refused, dns, timeout)
  | "throttle" // 429 / explicit rate limit
  | "server" // >=500, server-side, may succeed on retry
  | "conflict" // 408 request timeout, 409 conflict, 425 too early
  | "client" // other 4xx, caller's fault, will not self-heal
  | "ExampleCo"; // could not classify, conservative default

export interface ErrorClassification {
  retryable: boolean;
  category: RetryCategory;
  /** HTTP status if one could be extracted. */
  status?: number;
  /** Parsed Retry-After as milliseconds from now, if the server supplied one. */
  retryAfterMs?: number;
}

/** Node/undici transport error codes that mean "transient, try again". */
const RETRYABLE_NET_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN", // transient DNS failure
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * `ENOTFOUND` is DNS-not-found. It is usually a permanent typo in a hostname,
 * but for hosts behind flaky resolvers it can be transient. We treat it as
 * retryable because the cost of one wasted retry is far lower than dropping a
 * call that would have succeeded once DNS recovered.
 */
const SOFT_RETRYABLE_NET_CODES = new Set(["ENOTFOUND"]);

/** HTTP status codes worth retrying even though they are not 5xx. */
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429]);

function extractStatus(err: ExampleCo): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as Record<string, ExampleCo>;
  // Common shapes: err.status, err.statusCode, err.response.status, err.code (numeric)
  for (const key of ["status", "statusCode"] as const) {
    const v = e[key];
    if (typeof v === "number" && v >= 100 && v < 600) return v;
  }
  const resp = e["response"];
  if (typeof resp === "object" && resp !== null) {
    const s = (resp as Record<string, ExampleCo>)["status"];
    if (typeof s === "number" && s >= 100 && s < 600) return s;
  }
  return undefined;
}

function extractCode(err: ExampleCo): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as Record<string, ExampleCo>)["code"];
  if (typeof code === "string") return code;
  // undici wraps the real code on a `cause`.
  const cause = (err as Record<string, ExampleCo>)["cause"];
  if (typeof cause === "object" && cause !== null) {
    const cc = (cause as Record<string, ExampleCo>)["code"];
    if (typeof cc === "string") return cc;
  }
  return undefined;
}

function findHeader(err: ExampleCo, name: string): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const lname = name.toLowerCase();
  const containers: ExampleCo[] = [
    (err as Record<string, ExampleCo>)["headers"],
    ((err as Record<string, ExampleCo>)["response"] as Record<string, ExampleCo> | undefined)?.[
      "headers"
    ],
  ];
  for (const h of containers) {
    if (!h) continue;
    // Headers instance (has .get)
    if (typeof (h as { get?: ExampleCo }).get === "function") {
      const v = (h as { get: (n: string) => string | null }).get(name);
      if (v != null) return v;
    } else if (typeof h === "object") {
      for (const [k, v] of Object.entries(h as Record<string, ExampleCo>)) {
        if (k.toLowerCase() === lname && (typeof v === "string" || typeof v === "number")) {
          return String(v);
        }
      }
    }
  }
  return undefined;
}

/**
 * Parse a Retry-After value (delta-seconds or HTTP-date) into ms-from-now.
 * `now` is injectable for deterministic tests.
 */
export function parseRetryAfter(raw: string | undefined, now: () => number = Date.now): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) {
    return Math.max(0, when - now());
  }
  return undefined;
}

/** Extract a server-supplied Retry-After hint, in ms, if present. */
export function retryAfterMs(err: ExampleCo, now: () => number = Date.now): number | undefined {
  return parseRetryAfter(findHeader(err, "retry-after"), now);
}

/** Full classification of an arbitrary error into the retry taxonomy. */
export function classifyError(err: ExampleCo, now: () => number = Date.now): ErrorClassification {
  const status = extractStatus(err);
  const code = extractCode(err);
  const after = retryAfterMs(err, now);

  if (status !== undefined) {
    if (status === 429) {
      return { retryable: true, category: "throttle", status, retryAfterMs: after };
    }
    if (status >= 500) {
      return { retryable: true, category: "server", status, retryAfterMs: after };
    }
    if (RETRYABLE_STATUSES.has(status)) {
      return { retryable: true, category: "conflict", status, retryAfterMs: after };
    }
    if (status >= 400) {
      return { retryable: false, category: "client", status };
    }
    // 1xx/2xx/3xx surfacing as an error is unusual, be conservative.
    return { retryable: false, category: "ExampleCo", status };
  }

  if (code && (RETRYABLE_NET_CODES.has(code) || SOFT_RETRYABLE_NET_CODES.has(code))) {
    return { retryable: true, category: "network", retryAfterMs: after };
  }

  // Fetch/undici "TypeError: fetch failed" with no code is a transport failure.
  if (err instanceof TypeError && /fetch failed|network|terminated/i.test(err.message)) {
    return { retryable: true, category: "network" };
  }

  // AbortError (timeout via AbortController) is a transient cancellation.
  if (typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError") {
    return { retryable: true, category: "network" };
  }

  return { retryable: false, category: "ExampleCo" };
}

/**
 * Boolean predicate for `retry({ retryable })`. PRIVATE_NAME/unclassifiable errors
 * are treated as NON-retryable so a fatal bug never spins the loop.
 */
export function isRetryable(err: ExampleCo): boolean {
  return classifyError(err).retryable;
}
