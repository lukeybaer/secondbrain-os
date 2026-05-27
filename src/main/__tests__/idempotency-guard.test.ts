// idempotency-guard.test.ts
//
// Tests the claim-slot-first registry. Frugal: tiny JSONL, no real network,
// no real timers, deterministic keys. Confirms the agent-ledger ordering
// invariant (claim then execute then complete) holds under crashes and
// duplicate calls.

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  IdempotencyGuard,
  deterministicKey,
  payloadHash,
  runIdempotent,
} from '../idempotency-guard';

function tempLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idem-'));
  return path.join(dir, 'idempotency.jsonl');
}

describe('deterministicKey', () => {
  it('is stable across calls with the same inputs', () => {
    expect(deterministicKey('vapi', ['call', '+15550001234', 'dentist-script'])).toBe(
      deterministicKey('vapi', ['call', '+15550001234', 'dentist-script']),
    );
  });

  it('changes when any part changes', () => {
    const a = deterministicKey('vapi', ['call', '+15550001234', 'v1']);
    const b = deterministicKey('vapi', ['call', '+15550001234', 'v2']);
    expect(a).not.toBe(b);
  });

  it('scope changes the key even if parts match', () => {
    const a = deterministicKey('vapi', ['x', 'y']);
    const b = deterministicKey('twilio', ['x', 'y']);
    expect(a).not.toBe(b);
  });
});

describe('payloadHash', () => {
  it('is order-insensitive on top-level keys', () => {
    const a = payloadHash({ to: 'a@b.c', subject: 'hi' });
    const b = payloadHash({ subject: 'hi', to: 'a@b.c' });
    expect(a).toBe(b);
  });

  it('changes when any value changes', () => {
    const a = payloadHash({ to: 'a@b.c', subject: 'hi' });
    const b = payloadHash({ to: 'a@b.c', subject: 'hello' });
    expect(a).not.toBe(b);
  });
});

describe('IdempotencyGuard', () => {
  let logPath: string;
  let guard: IdempotencyGuard;

  beforeEach(() => {
    logPath = tempLog();
    guard = new IdempotencyGuard(logPath);
  });

  it('first claim is fresh', () => {
    const out = guard.claim('k1', 'vapi', { to: '+1' }, 60_000);
    expect(out.state).toBe('fresh');
    if (out.state === 'fresh') expect(out.exec_id).toMatch(/^[0-9a-f]{12}$/);
  });

  it('second claim with same payload before completion is in_flight', () => {
    const first = guard.claim('k1', 'vapi', { to: '+1' }, 60_000);
    expect(first.state).toBe('fresh');
    const second = guard.claim('k1', 'vapi', { to: '+1' }, 60_000);
    expect(second.state).toBe('in_flight');
  });

  it('after complete, duplicate claim returns the prior result', () => {
    const first = guard.claim('k1', 'vapi', { to: '+1' }, 60_000);
    if (first.state !== 'fresh') throw new Error('expected fresh');
    guard.complete('k1', first.exec_id, { call_id: 'vapi-abc-123' });
    const second = guard.claim('k1', 'vapi', { to: '+1' }, 60_000);
    expect(second.state).toBe('duplicate');
    if (second.state === 'duplicate') {
      expect(second.priorResult).toEqual({ call_id: 'vapi-abc-123' });
    }
  });

  it('payload mismatch detected when same key collides with different payload', () => {
    const first = guard.claim('k1', 'vapi', { to: '+1' }, 60_000);
    if (first.state !== 'fresh') throw new Error('expected fresh');
    guard.complete('k1', first.exec_id, { ok: true });
    const collide = guard.claim('k1', 'vapi', { to: '+2' }, 60_000);
    expect(collide.state).toBe('payload_mismatch');
  });

  it('after fail, a fresh retry is allowed for the same key', () => {
    const first = guard.claim('k1', 'vapi', { to: '+1' }, 60_000);
    if (first.state !== 'fresh') throw new Error('expected fresh');
    guard.fail('k1', first.exec_id, 'transport error');
    const retry = guard.claim('k1', 'vapi', { to: '+1' }, 60_000);
    expect(retry.state).toBe('fresh');
  });

  it('TTL expiry lets a duplicate claim run again', () => {
    const first = guard.claim('k1', 'vapi', { to: '+1' }, 1); // 1ms TTL
    if (first.state !== 'fresh') throw new Error('expected fresh');
    guard.complete('k1', first.exec_id, { ok: true });
    // Wait past the TTL deterministically.
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy-wait is fine for a 5ms test
    }
    const second = guard.claim('k1', 'vapi', { to: '+1' }, 60_000);
    expect(second.state).toBe('fresh');
  });

  it('complete throws when called without a claim', () => {
    expect(() => guard.complete('never-claimed', 'deadbeefdead', { x: 1 })).toThrow(
      /no claimed slot/,
    );
  });

  it('fail is tolerant of a missing claim (defensive finally blocks)', () => {
    expect(() => guard.fail('never-claimed', 'deadbeefdead', 'oops')).not.toThrow();
  });

  it('inspect returns the latest record', () => {
    const first = guard.claim('k1', 'vapi', { to: '+1' }, 60_000);
    if (first.state !== 'fresh') throw new Error('expected fresh');
    guard.complete('k1', first.exec_id, { call_id: 'abc' });
    const rec = guard.inspect('k1');
    expect(rec?.state).toBe('completed');
    expect(rec?.result).toEqual({ call_id: 'abc' });
  });

  it('stats counts records by state', () => {
    const a = guard.claim('a', 'vapi', { x: 1 }, 60_000);
    if (a.state !== 'fresh') throw new Error();
    guard.complete('a', a.exec_id, {});
    const b = guard.claim('b', 'vapi', { x: 2 }, 60_000);
    if (b.state !== 'fresh') throw new Error();
    guard.fail('b', b.exec_id, 'x');
    guard.claim('c', 'vapi', { x: 3 }, 60_000); // left claimed
    const s = guard.stats();
    expect(s.completed).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.claimed).toBe(1);
    expect(s.total).toBe(3);
  });
});

describe('runIdempotent', () => {
  let logPath: string;
  let guard: IdempotencyGuard;

  beforeEach(() => {
    logPath = tempLog();
    guard = new IdempotencyGuard(logPath);
  });

  it('runs the action on first call, returns fresh:true', async () => {
    let calls = 0;
    const out = await runIdempotent(
      guard,
      { key: 'k', scope: 'vapi', payload: { to: '+1' }, ttlMs: 60_000 },
      async () => {
        calls += 1;
        return 'ok';
      },
    );
    expect(out.fresh).toBe(true);
    expect(out.result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('skips the action on duplicate call, returns fresh:false with prior result', async () => {
    let calls = 0;
    const action = async () => {
      calls += 1;
      return 'first';
    };

    const a = await runIdempotent(
      guard,
      { key: 'k', scope: 'vapi', payload: { to: '+1' }, ttlMs: 60_000 },
      action,
    );
    const b = await runIdempotent(
      guard,
      { key: 'k', scope: 'vapi', payload: { to: '+1' }, ttlMs: 60_000 },
      action,
    );

    expect(a.fresh).toBe(true);
    expect(b.fresh).toBe(false);
    expect(b.result).toBe('first');
    expect(calls).toBe(1); // critical: action only ran once
  });

  it('on action throw, marks slot failed and lets the next call retry', async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return 'recovered';
    };

    await expect(
      runIdempotent(
        guard,
        { key: 'k', scope: 'vapi', payload: { to: '+1' }, ttlMs: 60_000 },
        flaky,
      ),
    ).rejects.toThrow(/transient/);

    const retry = await runIdempotent(
      guard,
      { key: 'k', scope: 'vapi', payload: { to: '+1' }, ttlMs: 60_000 },
      flaky,
    );
    expect(retry.fresh).toBe(true);
    expect(retry.result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('payload mismatch throws rather than silently re-running', async () => {
    const first = await runIdempotent(
      guard,
      { key: 'k', scope: 'vapi', payload: { to: '+1' }, ttlMs: 60_000 },
      async () => 'a',
    );
    expect(first.fresh).toBe(true);

    await expect(
      runIdempotent(
        guard,
        { key: 'k', scope: 'vapi', payload: { to: '+2' }, ttlMs: 60_000 },
        async () => 'b',
      ),
    ).rejects.toThrow(/payload mismatch/);
  });
});
