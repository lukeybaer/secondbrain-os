import { describe, it, expect, vi } from 'vitest';
import {
  runFallbackChain,
  runFallbackChainOrThrow,
  defaultIsTransientError,
  rateLimitOnlyClassifier,
  nonRetryableTagClassifier,
  FallbackChainExhausted,
  AttemptRecord,
  FallbackProvider,
} from '../tool-fallback-chain';

describe('tool-fallback-chain', () => {
  describe('defaultIsTransientError', () => {
    it('treats HTTP 429 as transient', () => {
      expect(defaultIsTransientError({ status: 429 })).toBe(true);
      expect(defaultIsTransientError({ statusCode: 429 })).toBe(true);
    });
    it('treats HTTP 5xx as transient', () => {
      expect(defaultIsTransientError({ status: 500 })).toBe(true);
      expect(defaultIsTransientError({ status: 502 })).toBe(true);
      expect(defaultIsTransientError({ status: 503 })).toBe(true);
      expect(defaultIsTransientError({ status: 504 })).toBe(true);
      expect(defaultIsTransientError({ status: 599 })).toBe(true);
    });
    it('treats HTTP 4xx (except 429) as permanent', () => {
      expect(defaultIsTransientError({ status: 400 })).toBe(false);
      expect(defaultIsTransientError({ status: 401 })).toBe(false);
      expect(defaultIsTransientError({ status: 403 })).toBe(false);
      expect(defaultIsTransientError({ status: 404 })).toBe(false);
      expect(defaultIsTransientError({ status: 422 })).toBe(false);
    });
    it('treats node network codes as transient', () => {
      expect(defaultIsTransientError({ code: 'ETIMEDOUT' })).toBe(true);
      expect(defaultIsTransientError({ code: 'ECONNRESET' })).toBe(true);
      expect(defaultIsTransientError({ code: 'EAI_AGAIN' })).toBe(true);
      expect(defaultIsTransientError({ code: 'ECONNREFUSED' })).toBe(true);
      expect(defaultIsTransientError({ code: 'ENOTFOUND' })).toBe(true);
    });
    it('treats messages mentioning timeout/network as transient', () => {
      expect(defaultIsTransientError(new Error('request timeout exceeded'))).toBe(true);
      expect(defaultIsTransientError(new Error('rate limit hit'))).toBe(true);
      expect(defaultIsTransientError(new Error('socket hang up'))).toBe(true);
      expect(defaultIsTransientError(new Error('fetch failed'))).toBe(true);
    });
    it('treats any 5xx in a message (no status field) as transient', () => {
      // The whole 500..599 range, not just the old 502/503/504 trio. A provider
      // that throws a bare Error must still fail over instead of aborting.
      expect(defaultIsTransientError(new Error('HTTP 500 Internal Server Error'))).toBe(true);
      expect(defaultIsTransientError(new Error('Upstream returned 599'))).toBe(true);
      expect(defaultIsTransientError(new Error('502 Bad Gateway'))).toBe(true);
    });
    it('does not match numbers that merely contain 5xx digits', () => {
      // Word boundaries keep "1500ms" and "5000" from looking like a 5xx code.
      expect(defaultIsTransientError(new Error('took 1500ms to parse'))).toBe(false);
      expect(defaultIsTransientError(new Error('budget of 5000 tokens'))).toBe(false);
    });
    it('returns false for null and undefined', () => {
      expect(defaultIsTransientError(null)).toBe(false);
      expect(defaultIsTransientError(undefined)).toBe(false);
    });
    it('returns false for vanilla validation errors', () => {
      expect(defaultIsTransientError(new Error('phone number must be E.164'))).toBe(false);
    });
  });

  describe('rateLimitOnlyClassifier', () => {
    it('matches only 429', () => {
      expect(rateLimitOnlyClassifier({ status: 429 })).toBe(true);
      expect(rateLimitOnlyClassifier({ status: 500 })).toBe(false);
      expect(rateLimitOnlyClassifier({ status: 503 })).toBe(false);
      expect(rateLimitOnlyClassifier({ statusCode: 429 })).toBe(true);
    });
  });

  describe('nonRetryableTagClassifier', () => {
    it('treats nonRetryable=true as permanent', () => {
      const err: { message: string; nonRetryable: boolean } = {
        message: 'bad input',
        nonRetryable: true,
      };
      expect(nonRetryableTagClassifier(err)).toBe(false);
    });
    it('treats untagged errors as transient', () => {
      expect(nonRetryableTagClassifier(new Error('whatever'))).toBe(true);
    });
  });

  describe('runFallbackChain', () => {
    it('returns the first provider value when it succeeds', async () => {
      const providers: FallbackProvider<string>[] = [
        { name: 'primary', fn: async () => 'one' },
        { name: 'secondary', fn: async () => 'two' },
      ];
      const result = await runFallbackChain(providers, { chain: 'test' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('one');
        expect(result.winning_provider).toBe('primary');
        expect(result.attempts).toHaveLength(1);
        expect(result.attempts[0].outcome).toBe('success');
      }
    });

    it('falls through to secondary on transient primary error', async () => {
      const transient = Object.assign(new Error('timeout'), { status: 503 });
      const providers: FallbackProvider<string>[] = [
        {
          name: 'primary',
          fn: async () => {
            throw transient;
          },
        },
        { name: 'secondary', fn: async () => 'rescued' },
      ];
      const result = await runFallbackChain(providers, { chain: 'test' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('rescued');
        expect(result.winning_provider).toBe('secondary');
        expect(result.attempts).toHaveLength(2);
        expect(result.attempts[0].outcome).toBe('transient_error');
        expect(result.attempts[1].outcome).toBe('success');
      }
    });

    it('aborts on permanent error and does NOT call sibling providers', async () => {
      const sibling = vi.fn(async () => 'should-never-fire');
      const providers: FallbackProvider<string>[] = [
        {
          name: 'primary',
          fn: async () => {
            throw Object.assign(new Error('bad input'), { status: 400 });
          },
        },
        { name: 'secondary', fn: sibling },
      ];
      const result = await runFallbackChain(providers, { chain: 'test' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('permanent_aborted');
        expect(result.attempts).toHaveLength(1);
        expect(result.attempts[0].outcome).toBe('permanent_error');
      }
      expect(sibling).not.toHaveBeenCalled();
    });

    it('returns chain-exhausted when every provider transient-fails', async () => {
      const providers: FallbackProvider<string>[] = [
        {
          name: 'a',
          fn: async () => {
            throw Object.assign(new Error('rl'), { status: 429 });
          },
        },
        {
          name: 'b',
          fn: async () => {
            throw Object.assign(new Error('rl'), { status: 429 });
          },
        },
        {
          name: 'c',
          fn: async () => {
            throw Object.assign(new Error('rl'), { status: 429 });
          },
        },
      ];
      const result = await runFallbackChain(providers, { chain: 'test' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('all_transient');
        expect(result.attempts).toHaveLength(3);
        expect(result.attempts.every((a) => a.outcome === 'transient_error')).toBe(true);
      }
    });

    it('skips providers whose shouldAttempt returns false (circuit-breaker integration)', async () => {
      const ran = vi.fn(async () => 'late-success');
      const providers: FallbackProvider<string>[] = [
        { name: 'primary', fn: async () => 'should-not-fire-1', shouldAttempt: () => false },
        { name: 'secondary', fn: async () => 'should-not-fire-2', shouldAttempt: () => false },
        { name: 'tertiary', fn: ran },
      ];
      const result = await runFallbackChain(providers, { chain: 'test' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('late-success');
        expect(result.winning_provider).toBe('tertiary');
        expect(result.attempts.filter((a) => a.outcome === 'skipped')).toHaveLength(2);
      }
      expect(ran).toHaveBeenCalledOnce();
    });

    it('returns all_skipped when every provider is skipped', async () => {
      const providers: FallbackProvider<string>[] = [
        { name: 'a', fn: async () => 'x', shouldAttempt: () => false },
        { name: 'b', fn: async () => 'y', shouldAttempt: () => false },
      ];
      const result = await runFallbackChain(providers, { chain: 'test' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('all_skipped');
      }
    });

    it('handles empty provider list', async () => {
      const result = await runFallbackChain([], { chain: 'test' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('all_skipped');
      }
    });

    it('honors custom isTransientError per provider', async () => {
      // primary uses rateLimitOnly; a 503 from primary is NOT transient under
      // this classifier and aborts the chain even though default would retry.
      const provider1: FallbackProvider<string> = {
        name: 'primary',
        fn: async () => {
          throw Object.assign(new Error('5xx'), { status: 503 });
        },
        isTransientError: rateLimitOnlyClassifier,
      };
      const provider2: FallbackProvider<string> = {
        name: 'secondary',
        fn: async () => 'should-not-fire',
      };
      const result = await runFallbackChain([provider1, provider2], { chain: 'test' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('permanent_aborted');
        expect(result.attempts).toHaveLength(1);
      }
    });

    it('writes one AttemptRecord per attempt to writer', async () => {
      const records: AttemptRecord[] = [];
      const providers: FallbackProvider<string>[] = [
        {
          name: 'primary',
          fn: async () => {
            throw Object.assign(new Error('rl'), { status: 429 });
          },
        },
        { name: 'secondary', fn: async () => 'ok' },
      ];
      await runFallbackChain(providers, { chain: 'gmail-send', writer: (r) => records.push(r) });
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        chain: 'gmail-send',
        provider: 'primary',
        outcome: 'transient_error',
      });
      expect(records[1]).toMatchObject({
        chain: 'gmail-send',
        provider: 'secondary',
        outcome: 'success',
      });
      expect(records.every((r) => typeof r.duration_ms === 'number' && r.duration_ms >= 0)).toBe(
        true,
      );
    });
  });

  describe('runFallbackChainOrThrow', () => {
    it('returns the value on success', async () => {
      const providers: FallbackProvider<number>[] = [{ name: 'a', fn: async () => 42 }];
      const v = await runFallbackChainOrThrow(providers, { chain: 'test' });
      expect(v).toBe(42);
    });
    it('throws FallbackChainExhausted on chain exhaustion', async () => {
      const providers: FallbackProvider<number>[] = [
        {
          name: 'a',
          fn: async () => {
            throw Object.assign(new Error('rl'), { status: 429 });
          },
        },
      ];
      await expect(
        runFallbackChainOrThrow(providers, { chain: 'voice-out' }),
      ).rejects.toBeInstanceOf(FallbackChainExhausted);
    });
    it('FallbackChainExhausted ExampleCos chain id and result', async () => {
      const providers: FallbackProvider<number>[] = [
        {
          name: 'a',
          fn: async () => {
            throw Object.assign(new Error('rl'), { status: 429 });
          },
        },
      ];
      try {
        await runFallbackChainOrThrow(providers, { chain: 'voice-out' });
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(FallbackChainExhausted);
        const fe = e as FallbackChainExhausted;
        expect(fe.chain).toBe('voice-out');
        expect(fe.result.attempts).toHaveLength(1);
      }
    });
  });
});
