// backoff-retry.test.ts
//
// Frugal vitest suite. Fake sleep, deterministic rng, no real timers.

import { describe, it, expect } from 'vitest';
import {
  retry,
  computeDelay,
  RetryError,
  RETRYABLE_DEFAULT,
  RETRYABLE_VAPI,
  RETRYABLE_GMAIL,
  RETRYABLE_TELEGRAM,
  RETRY_VAPI,
  RETRY_GMAIL,
  RETRY_TELEGRAM,
} from '../backoff-retry';

// Fake sleep that records calls instead of waiting.
function fakeSleep(): { fn: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    fn: async (ms: number) => {
      calls.push(ms);
    },
  };
}

const fixedRng =
  (v = 0.5) =>
  () =>
    v;

describe('RETRYABLE_DEFAULT', () => {
  it('retries timeouts', () => {
    expect(RETRYABLE_DEFAULT(new Error('ETIMEDOUT'))).toBe(true);
    expect(RETRYABLE_DEFAULT(new Error('Aborted'))).toBe(true);
  });

  it('retries network errors', () => {
    expect(RETRYABLE_DEFAULT(new Error('ECONNRESET'))).toBe(true);
    expect(RETRYABLE_DEFAULT(new Error('ENOTFOUND host'))).toBe(true);
  });

  it('retries 5xx and 429', () => {
    expect(RETRYABLE_DEFAULT(new Error('500 Internal Server Error'))).toBe(true);
    expect(RETRYABLE_DEFAULT(new Error('429 Too Many Requests'))).toBe(true);
    expect(RETRYABLE_DEFAULT(new Error('rate limit'))).toBe(true);
  });

  it('does NOT retry 4xx other than 429', () => {
    expect(RETRYABLE_DEFAULT(new Error('400 Bad Request'))).toBe(false);
    expect(RETRYABLE_DEFAULT(new Error('401 Unauthorized'))).toBe(false);
    expect(RETRYABLE_DEFAULT(new Error('404 Not Found'))).toBe(false);
  });

  it('does NOT retry random app errors', () => {
    expect(RETRYABLE_DEFAULT(new Error('user not found in cache'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(RETRYABLE_DEFAULT(null)).toBe(false);
  });
});

describe('RETRYABLE_VAPI', () => {
  it('does not retry voicemail/busy/declined', () => {
    expect(RETRYABLE_VAPI(new Error('voicemail-detected'))).toBe(false);
    expect(RETRYABLE_VAPI(new Error('line busy'))).toBe(false);
    expect(RETRYABLE_VAPI(new Error('call declined'))).toBe(false);
  });

  it('still retries transient errors', () => {
    expect(RETRYABLE_VAPI(new Error('502 Bad Gateway'))).toBe(true);
  });
});

describe('RETRYABLE_GMAIL', () => {
  it('does not retry invalid recipient', () => {
    expect(RETRYABLE_GMAIL(new Error('Invalid recipient: foo'))).toBe(false);
    expect(RETRYABLE_GMAIL(new Error('invalid email address'))).toBe(false);
  });

  it('retries quota errors', () => {
    expect(RETRYABLE_GMAIL(new Error('quota exceeded'))).toBe(true);
  });
});

describe('RETRYABLE_TELEGRAM', () => {
  it('does not retry message-too-long', () => {
    expect(RETRYABLE_TELEGRAM(new Error('message is too long'))).toBe(false);
    expect(RETRYABLE_TELEGRAM(new Error('text length exceeds 4096'))).toBe(false);
  });

  it('retries 429', () => {
    expect(RETRYABLE_TELEGRAM(new Error('429 too many requests'))).toBe(true);
  });
});

describe('computeDelay', () => {
  it('exponential with no jitter doubles each attempt', () => {
    const r = fixedRng();
    expect(computeDelay(1, 100, 30_000, 'exponential', 'none', 100, r)).toBe(100);
    expect(computeDelay(2, 100, 30_000, 'exponential', 'none', 100, r)).toBe(200);
    expect(computeDelay(3, 100, 30_000, 'exponential', 'none', 100, r)).toBe(400);
    expect(computeDelay(4, 100, 30_000, 'exponential', 'none', 100, r)).toBe(800);
  });

  it('linear with no jitter scales by attempt', () => {
    const r = fixedRng();
    expect(computeDelay(1, 100, 30_000, 'linear', 'none', 0, r)).toBe(100);
    expect(computeDelay(2, 100, 30_000, 'linear', 'none', 0, r)).toBe(200);
    expect(computeDelay(3, 100, 30_000, 'linear', 'none', 0, r)).toBe(300);
  });

  it('full jitter scales raw delay by rng', () => {
    expect(computeDelay(2, 100, 30_000, 'exponential', 'full', 0, fixedRng(0.5))).toBe(100);
    expect(computeDelay(2, 100, 30_000, 'exponential', 'full', 0, fixedRng(0))).toBe(0);
    expect(computeDelay(2, 100, 30_000, 'exponential', 'full', 0, fixedRng(0.9))).toBe(180);
  });

  it('equal jitter keeps a half-cap floor', () => {
    // attempt 2, base 100 -> raw 200, equal: 100 + rng*100
    expect(computeDelay(2, 100, 30_000, 'exponential', 'equal', 0, fixedRng(0))).toBe(100);
    expect(computeDelay(2, 100, 30_000, 'exponential', 'equal', 0, fixedRng(1))).toBe(200);
  });

  it('decorrelated jitter uses prevDelay', () => {
    // attempt 2, base 100, prevDelay 500. dcap = min(maxMs, max(base, 1500)) = 1500
    // delay = base + rng*(dcap - base) = 100 + rng * 1400
    expect(computeDelay(2, 100, 30_000, 'exponential', 'decorrelated', 500, fixedRng(0))).toBe(100);
    expect(computeDelay(2, 100, 30_000, 'exponential', 'decorrelated', 500, fixedRng(1))).toBe(
      1500,
    );
  });

  it('clamps to maxMs', () => {
    // raw 32000, max 1000 -> cap 1000, no jitter -> 1000
    expect(computeDelay(8, 100, 1000, 'exponential', 'none', 0, fixedRng())).toBe(1000);
  });
});

describe('retry', () => {
  it('returns first attempt result on success', async () => {
    const sleep = fakeSleep();
    const result = await retry(async () => 42, { sleep: sleep.fn });
    expect(result).toBe(42);
    expect(sleep.calls).toHaveLength(0);
  });

  it('retries transient errors and eventually succeeds', async () => {
    const sleep = fakeSleep();
    let calls = 0;
    const result = await retry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('500 Internal Server Error');
        return 'ok';
      },
      { sleep: sleep.fn, rng: fixedRng() },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(sleep.calls).toHaveLength(2); // two retries between three attempts
  });

  it('does not retry non-retryable errors', async () => {
    const sleep = fakeSleep();
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error('400 Bad Request');
        },
        { sleep: sleep.fn },
      ),
    ).rejects.toThrow('400');
    expect(calls).toBe(1);
    expect(sleep.calls).toHaveLength(0);
  });

  it('throws RetryError after maxAttempts', async () => {
    const sleep = fakeSleep();
    let calls = 0;
    let caught: ExampleCo = undefined;
    try {
      await retry(
        async () => {
          calls++;
          throw new Error('502 Bad Gateway');
        },
        { maxAttempts: 3, sleep: sleep.fn, rng: fixedRng() },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RetryError);
    expect((caught as RetryError).attempts).toBe(3);
    expect((caught as RetryError).lastError).toBeInstanceOf(Error);
    expect(((caught as RetryError).lastError as Error).message).toContain('502');
    expect(calls).toBe(3);
    expect(sleep.calls).toHaveLength(2);
  });

  it('passes attempt number to fn', async () => {
    const sleep = fakeSleep();
    const seen: number[] = [];
    let calls = 0;
    await retry(
      async (attempt) => {
        seen.push(attempt);
        calls++;
        if (calls < 2) throw new Error('timeout');
        return 'ok';
      },
      { sleep: sleep.fn },
    );
    expect(seen).toEqual([1, 2]);
  });

  it('calls onRetry hook with attempt, err, delay', async () => {
    const sleep = fakeSleep();
    const events: Array<{ attempt: number; nextDelayMs: number; msg: string }> = [];
    let calls = 0;
    await retry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('429 rate limit');
        return 'ok';
      },
      {
        sleep: sleep.fn,
        rng: fixedRng(),
        onRetry: ({ attempt, err, nextDelayMs }) => {
          events.push({ attempt, nextDelayMs, msg: (err as Error).message });
        },
      },
    );
    expect(events).toHaveLength(2);
    expect(events[0].attempt).toBe(1);
    expect(events[1].attempt).toBe(2);
    expect(events[0].msg).toContain('429');
  });

  it('respects custom retryable predicate', async () => {
    const sleep = fakeSleep();
    let calls = 0;
    const customRetry = (e: ExampleCo) => (e as Error).message.includes('please');
    await retry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('please retry');
        return 'ok';
      },
      { sleep: sleep.fn, retryable: customRetry, rng: fixedRng() },
    );
    expect(calls).toBe(3);
  });

  it('honors maxAttempts = 1 (no retries)', async () => {
    const sleep = fakeSleep();
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error('500');
        },
        { maxAttempts: 1, sleep: sleep.fn },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(sleep.calls).toHaveLength(0);
  });

  it('clamps maxAttempts to >=1 even if 0 supplied', async () => {
    const sleep = fakeSleep();
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error('500');
        },
        { maxAttempts: 0, sleep: sleep.fn },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('retry honors Retry-After', () => {
  // Build an error that looks like a real 429 from a client (status + headers),
  // mirroring the shape retry-taxonomy.classifyError extracts.
  function rateLimited(retryAfterSeconds: number): Error {
    const e = new Error('429 Too Many Requests') as Error & {
      status: number;
      headers: Record<string, string>;
    };
    e.status = 429;
    e.headers = { 'retry-after': String(retryAfterSeconds) };
    return e;
  }

  it('sleeps the server-instructed Retry-After instead of jittered backoff', async () => {
    const sleep = fakeSleep();
    let calls = 0;
    const result = await retry(
      async () => {
        calls++;
        if (calls < 2) throw rateLimited(2); // server says wait 2s
        return 'ok';
      },
      { sleep: sleep.fn, rng: fixedRng(0) /* would yield 0ms backoff */ },
    );
    expect(result).toBe('ok');
    // Without honoring Retry-After, full-jitter with rng=0 would sleep 0ms.
    // With it, we wait the server-instructed 2000ms.
    expect(sleep.calls).toEqual([2000]);
  });

  it('clamps an oversized Retry-After to maxMs', async () => {
    const sleep = fakeSleep();
    let calls = 0;
    await retry(
      async () => {
        calls++;
        if (calls < 2) throw rateLimited(3600); // server says wait an hour
        return 'ok';
      },
      { sleep: sleep.fn, rng: fixedRng(0), maxMs: 5_000 },
    );
    expect(sleep.calls).toEqual([5_000]); // clamped, never stalls a render
  });

  it('falls back to jittered backoff when no Retry-After is present', async () => {
    const sleep = fakeSleep();
    let calls = 0;
    await retry(
      async () => {
        calls++;
        if (calls < 2) throw new Error('503 Service Unavailable');
        return 'ok';
      },
      { sleep: sleep.fn, rng: fixedRng(0.5), baseMs: 100 },
    );
    // attempt 1 raw delay = base 100, full jitter rng 0.5 -> 50ms
    expect(sleep.calls).toEqual([50]);
  });

  it('ignores Retry-After when respectRetryAfter is false', async () => {
    const sleep = fakeSleep();
    let calls = 0;
    await retry(
      async () => {
        calls++;
        if (calls < 2) throw rateLimited(2);
        return 'ok';
      },
      { sleep: sleep.fn, rng: fixedRng(0.5), baseMs: 100, respectRetryAfter: false },
    );
    expect(sleep.calls).toEqual([50]); // jittered, server hint ignored
  });
});

describe('retry deadlineMs budget', () => {
  // Fake clock that advances by whatever the fake sleep "waits".
  function fakeClock() {
    const state = { t: 0 };
    const sleeps: number[] = [];
    return {
      sleeps,
      now: () => state.t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        state.t += ms;
      },
    };
  }

  it('stops retrying once the time budget is spent', async () => {
    const clk = fakeClock();
    let calls = 0;
    let caught: ExampleCo;
    try {
      await retry(
        async () => {
          calls++;
          throw new Error('503 Service Unavailable');
        },
        {
          maxAttempts: 100,
          baseMs: 400,
          maxMs: 100_000,
          jitter: 'none',
          sleep: clk.sleep,
          now: clk.now,
          deadlineMs: 1000,
        },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RetryError);
    // a1 fail -> delay 400 (remaining 1000) sleep 400, clock 400
    // a2 fail -> delay 800, remaining 600 -> clamp to 600, sleep 600, clock 1000
    // a3 fail -> remaining 0 -> break and throw
    expect(clk.sleeps).toEqual([400, 600]);
    expect(calls).toBe(3);
    expect((caught as RetryError).attempts).toBe(3);
  });

  it('never sleeps past the deadline', async () => {
    const clk = fakeClock();
    let calls = 0;
    try {
      await retry(
        async () => {
          calls++;
          throw new Error('500');
        },
        {
          maxAttempts: 100,
          baseMs: 5_000,
          jitter: 'none',
          sleep: clk.sleep,
          now: clk.now,
          deadlineMs: 1_200,
        },
      );
    } catch {
      /* expected */
    }
    // first backoff would be 5000ms but is clamped to the 1200ms remaining.
    expect(clk.sleeps).toEqual([1_200]);
    expect(calls).toBe(2);
  });

  it('does not interfere when the budget is ample', async () => {
    const clk = fakeClock();
    let calls = 0;
    const result = await retry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('timeout');
        return 'ok';
      },
      {
        baseMs: 100,
        jitter: 'none',
        sleep: clk.sleep,
        now: clk.now,
        deadlineMs: 60_000,
        maxAttempts: 5,
      },
    );
    expect(result).toBe('ok');
    expect(clk.sleeps).toEqual([100, 200]); // normal exponential backoff
  });
});

describe('presets', () => {
  it('RETRY_VAPI uses vapi predicate', async () => {
    const sleep = fakeSleep();
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error('voicemail-detected');
        },
        { ...RETRY_VAPI, sleep: sleep.fn },
      ),
    ).rejects.toThrow('voicemail');
    expect(calls).toBe(1); // not retryable
  });

  it('RETRY_GMAIL retries quota errors', async () => {
    const sleep = fakeSleep();
    let calls = 0;
    const result = await retry(
      async () => {
        calls++;
        if (calls < 2) throw new Error('quota exceeded');
        return 'sent';
      },
      { ...RETRY_GMAIL, sleep: sleep.fn, rng: fixedRng() },
    );
    expect(result).toBe('sent');
    expect(calls).toBe(2);
  });

  it('RETRY_TELEGRAM does not retry message-too-long', async () => {
    const sleep = fakeSleep();
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error('message is too long');
        },
        { ...RETRY_TELEGRAM, sleep: sleep.fn },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
