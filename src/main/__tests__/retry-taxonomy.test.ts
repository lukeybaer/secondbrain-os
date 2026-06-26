import { describe, it, expect } from "vitest";
import {
  classifyError,
  isRetryable,
  retryAfterMs,
  parseRetryAfter,
} from "../retry-taxonomy";

describe("retry-taxonomy classifyError", () => {
  it("retries 429 throttling and surfaces it as the throttle category", () => {
    const c = classifyError({ status: 429 });
    expect(c.retryable).toBe(true);
    expect(c.category).toBe("throttle");
    expect(c.status).toBe(429);
  });

  it("retries any 5xx as server errors", () => {
    for (const status of [500, 502, 503, 504]) {
      const c = classifyError({ statusCode: status });
      expect(c.retryable).toBe(true);
      expect(c.category).toBe("server");
    }
  });

  it("retries 408/409/425 as conflict-class transients", () => {
    for (const status of [408, 409, 425]) {
      expect(classifyError({ status }).retryable).toBe(true);
      expect(classifyError({ status }).category).toBe("conflict");
    }
  });

  it("does NOT retry fatal 4xx (auth, bad request, not found, forbidden)", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const c = classifyError({ status });
      expect(c.retryable).toBe(false);
      expect(c.category).toBe("client");
    }
  });

  it("reads status nested under err.response.status", () => {
    expect(classifyError({ response: { status: 503 } }).retryable).toBe(true);
    expect(classifyError({ response: { status: 401 } }).retryable).toBe(false);
  });

  it("retries transient transport codes", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET"]) {
      const c = classifyError({ code });
      expect(c.retryable).toBe(true);
      expect(c.category).toBe("network");
    }
  });

  it("reads a transport code wrapped on err.cause (undici shape)", () => {
    const c = classifyError({ message: "fetch failed", cause: { code: "ECONNREFUSED" } });
    expect(c.retryable).toBe(true);
    expect(c.category).toBe("network");
  });

  it("treats AbortError (timeout) as retryable network", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(classifyError(e).retryable).toBe(true);
  });

  it("treats a bare fetch-failed TypeError as retryable network", () => {
    expect(classifyError(new TypeError("fetch failed")).retryable).toBe(true);
  });

  it("defaults ExampleCo/unclassifiable errors to NON-retryable so bugs do not spin", () => {
    expect(classifyError(new Error("kaboom in business logic")).retryable).toBe(false);
    expect(classifyError(null).retryable).toBe(false);
    expect(classifyError("string error").retryable).toBe(false);
  });
});

describe("retry-taxonomy isRetryable predicate", () => {
  it("matches classifyError.retryable and is wireable into withBackoff", () => {
    expect(isRetryable({ status: 503 })).toBe(true);
    expect(isRetryable({ status: 404 })).toBe(false);
  });
});

describe("retry-taxonomy Retry-After parsing", () => {
  it("parses delta-seconds into milliseconds", () => {
    expect(parseRetryAfter("30")).toBe(30000);
  });

  it("parses an HTTP-date relative to an injected now", () => {
    const now = () => Date.parse("2026-01-01T00:00:00Z");
    const ms = parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", now);
    expect(ms).toBe(10000);
  });

  it("never returns a negative wait for a past date", () => {
    const now = () => Date.parse("2026-01-01T00:01:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now)).toBe(0);
  });

  it("returns undefined for missing or garbage values", () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("soon-ish")).toBeUndefined();
  });

  it("extracts Retry-After from a 429 across header shapes (plain object, Headers, response.headers)", () => {
    expect(retryAfterMs({ status: 429, headers: { "retry-after": "5" } })).toBe(5000);
    expect(
      retryAfterMs({ status: 429, response: { headers: { "Retry-After": "7" } } }),
    ).toBe(7000);
    const h = new Headers();
    h.set("retry-after", "9");
    expect(retryAfterMs({ status: 429, headers: h })).toBe(9000);
  });

  it("attaches the parsed retryAfterMs onto the classification for a throttled call", () => {
    const c = classifyError({ status: 429, headers: { "retry-after": "12" } });
    expect(c.retryAfterMs).toBe(12000);
  });
});
