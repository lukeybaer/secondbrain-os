// outcome-tracker.test.ts
//
// Frugal vitest suite. No real network, no real timers, tiny JSONL fixtures.
// Verifies record/wrap/markSignal/getStats and the last-write-wins reducer.

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  OutcomeTracker,
  argsHash,
  classifyError,
  newRecordId,
} from '../outcome-tracker';

function tempLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-'));
  return path.join(dir, 'outcomes.jsonl');
}

describe('newRecordId', () => {
  it('returns 12 hex chars', () => {
    expect(newRecordId()).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is unique across many calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(newRecordId());
    expect(seen.size).toBe(200);
  });
});

describe('argsHash', () => {
  it('is order-insensitive on top-level keys', () => {
    expect(argsHash({ a: 1, b: 2 })).toBe(argsHash({ b: 2, a: 1 }));
  });

  it('changes when any value changes', () => {
    expect(argsHash({ a: 1 })).not.toBe(argsHash({ a: 2 }));
  });

  it('handles primitives', () => {
    expect(argsHash('x')).toBe(argsHash('x'));
    expect(argsHash('x')).not.toBe(argsHash('y'));
  });
});

describe('classifyError', () => {
  it('detects timeout', () => {
    expect(classifyError(new Error('Request ETIMEDOUT after 10s'))).toBe('timeout');
    expect(classifyError(new Error('aborted'))).toBe('timeout');
  });

  it('detects network errors', () => {
    expect(classifyError(new Error('ECONNRESET'))).toBe('network');
    expect(classifyError(new Error('getaddrinfo ENOTFOUND'))).toBe('network');
  });

  it('detects http 5xx', () => {
    expect(classifyError(new Error('500 Internal Server Error'))).toBe('http_5xx');
    expect(classifyError(new Error('Bad Gateway'))).toBe('http_5xx');
  });

  it('detects 429 rate limits', () => {
    expect(classifyError(new Error('Too Many Requests 429'))).toBe('http_429');
    expect(classifyError(new Error('rate limit exceeded'))).toBe('http_429');
  });

  it('detects auth failures', () => {
    expect(classifyError(new Error('401 Unauthorized'))).toBe('auth');
    expect(classifyError(new Error('Forbidden'))).toBe('auth');
  });

  it('detects validation', () => {
    expect(classifyError(new Error('schema validation failed'))).toBe('validation');
  });

  it('falls back to app for ExampleCo', () => {
    expect(classifyError(new Error('something weird'))).toBe('app');
  });

  it('returns ExampleCo for null/undefined', () => {
    expect(classifyError(null)).toBe('ExampleCo');
    expect(classifyError(undefined)).toBe('ExampleCo');
  });
});

describe('OutcomeTracker.recordOutcome', () => {
  let logPath: string;
  let tracker: OutcomeTracker;

  beforeEach(() => {
    logPath = tempLog();
    tracker = new OutcomeTracker(logPath);
  });

  it('appends a record and returns the record_id', () => {
    const id = tracker.recordOutcome({
      scope: 'vapi', action: 'initiateCall', args_hash: 'abc', outcome: 'success',
    });
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      record_id: id, scope: 'vapi', action: 'initiateCall', outcome: 'success',
    });
  });

  it('preserves caller-supplied record_id and ts', () => {
    const ts = '2026-01-01T00:00:00.000Z';
    const id = tracker.recordOutcome({
      scope: 'gmail', action: 'sendDraft', args_hash: 'h',
      outcome: 'success', record_id: 'fixedid12345', ts,
    });
    expect(id).toBe('fixedid12345');
    const all = tracker.readAll();
    expect(all[0].ts).toBe(ts);
  });

  it('multiple records append in order', () => {
    tracker.recordOutcome({ scope: 's', action: 'a', args_hash: 'h', outcome: 'success' });
    tracker.recordOutcome({ scope: 's', action: 'a', args_hash: 'h', outcome: 'fail' });
    const all = tracker.readAll();
    expect(all.map(r => r.outcome)).toEqual(['success', 'fail']);
  });
});

describe('OutcomeTracker.wrap', () => {
  let tracker: OutcomeTracker;
  beforeEach(() => { tracker = new OutcomeTracker(tempLog()); });

  it('records success when fn resolves', async () => {
    const result = await tracker.wrap('vapi', 'initiateCall', { to: '+1' }, async () => 42);
    expect(result).toBe(42);
    const all = tracker.readAll();
    expect(all).toHaveLength(1);
    expect(all[0].outcome).toBe('success');
    expect(all[0].latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('records fail and rethrows when fn throws', async () => {
    await expect(
      tracker.wrap('gmail', 'sendDraft', { to: 'x' }, async () => {
        throw new Error('500 Internal Server Error');
      }),
    ).rejects.toThrow('500');
    const all = tracker.readAll();
    expect(all).toHaveLength(1);
    expect(all[0].outcome).toBe('fail');
    expect(all[0].error_class).toBe('http_5xx');
    expect(all[0].error_message).toContain('500');
  });

  it('records retry_count when supplied', async () => {
    await tracker.wrap('telegram', 'sendMessage', {}, async () => 'ok', { retry_count: 2 });
    const all = tracker.readAll();
    expect(all[0].retry_count).toBe(2);
  });

  it('attaches metadataOnSuccess hook output', async () => {
    await tracker.wrap('briefing-section', 'render', { id: 'news' }, async () => ({ items: 7 }), {
      metadataOnSuccess: (r) => ({ items: r.items }),
    });
    const all = tracker.readAll();
    expect(all[0].metadata).toEqual({ items: 7 });
  });
});

describe('OutcomeTracker.markSignal', () => {
  let tracker: OutcomeTracker;
  beforeEach(() => { tracker = new OutcomeTracker(tempLog()); });

  it('upgrades a no_signal to success on later feedback', () => {
    const id = tracker.recordOutcome({
      scope: 'gmail', action: 'sendDraft', args_hash: 'h', outcome: 'no_signal',
    });
    tracker.markSignal(id, 'success', { reply_received: true });
    const reduced = tracker.reduce(tracker.readAll());
    const target = reduced.find(r => r.record_id === id);
    expect(target?.outcome).toBe('success');
    expect(target?.metadata).toMatchObject({ reply_received: true });
  });

  it('downgrades a success to fail when feedback contradicts', () => {
    const id = tracker.recordOutcome({
      scope: 'vapi', action: 'initiateCall', args_hash: 'h', outcome: 'success',
    });
    tracker.markSignal(id, 'fail', { reason: 'voicemail' });
    const reduced = tracker.reduce(tracker.readAll());
    expect(reduced.find(r => r.record_id === id)?.outcome).toBe('fail');
  });

  it('signal for a missing record_id is silently dropped from the reduced view', () => {
    tracker.markSignal('nonexistent1', 'success');
    const reduced = tracker.reduce(tracker.readAll());
    // No record to update; the signal record itself is not surfaced.
    expect(reduced).toHaveLength(0);
  });

  it('the raw log keeps both the original AND the signal record (forensic)', () => {
    const id = tracker.recordOutcome({
      scope: 's', action: 'a', args_hash: 'h', outcome: 'no_signal',
    });
    tracker.markSignal(id, 'success');
    expect(tracker.readAll()).toHaveLength(2);
  });
});

describe('OutcomeTracker.getStats', () => {
  let tracker: OutcomeTracker;
  beforeEach(() => { tracker = new OutcomeTracker(tempLog()); });

  it('returns zeros for an empty scope', () => {
    const s = tracker.getStats('nope');
    expect(s.total).toBe(0);
    expect(s.success_rate).toBe(0);
    expect(s.p50_latency_ms).toBe(0);
  });

  it('computes success_rate excluding no_signal', () => {
    for (let i = 0; i < 8; i++) tracker.recordOutcome({ scope: 'vapi', action: 'a', args_hash: 'h', outcome: 'success', latency_ms: 100 });
    for (let i = 0; i < 2; i++) tracker.recordOutcome({ scope: 'vapi', action: 'a', args_hash: 'h', outcome: 'fail', latency_ms: 200, error_class: 'timeout' });
    for (let i = 0; i < 5; i++) tracker.recordOutcome({ scope: 'vapi', action: 'a', args_hash: 'h', outcome: 'no_signal' });
    const s = tracker.getStats('vapi');
    expect(s.total).toBe(15);
    expect(s.success).toBe(8);
    expect(s.fail).toBe(2);
    expect(s.no_signal).toBe(5);
    expect(s.success_rate).toBeCloseTo(8 / 10);
    expect(s.resolution_rate).toBeCloseTo(10 / 15);
    expect(s.by_error_class).toEqual({ timeout: 2 });
  });

  it('respects the action filter', () => {
    tracker.recordOutcome({ scope: 'gmail', action: 'sendDraft', args_hash: 'h', outcome: 'success' });
    tracker.recordOutcome({ scope: 'gmail', action: 'createDraft', args_hash: 'h', outcome: 'fail' });
    expect(tracker.getStats('gmail', { action: 'sendDraft' }).total).toBe(1);
    expect(tracker.getStats('gmail', { action: 'createDraft' }).total).toBe(1);
  });

  it('respects the time window', () => {
    const now = Date.parse('2026-05-09T00:00:00Z');
    tracker.recordOutcome({ scope: 's', action: 'a', args_hash: 'h', outcome: 'success', ts: '2026-05-08T23:50:00Z' }); // 10 min old
    tracker.recordOutcome({ scope: 's', action: 'a', args_hash: 'h', outcome: 'success', ts: '2026-05-08T22:00:00Z' }); // 2 hr old
    expect(tracker.getStats('s', { windowMs: 60 * 60 * 1000, now }).total).toBe(1);
    expect(tracker.getStats('s', { windowMs: 24 * 60 * 60 * 1000, now }).total).toBe(2);
  });

  it('p50 and p95 latency from sorted records', () => {
    [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].forEach(l =>
      tracker.recordOutcome({ scope: 's', action: 'a', args_hash: 'h', outcome: 'success', latency_ms: l }),
    );
    const s = tracker.getStats('s');
    // floor((p/100) * (n-1)): p50 -> 4 -> 50, p95 -> 8 -> 90
    expect(s.p50_latency_ms).toBe(50);
    expect(s.p95_latency_ms).toBe(90);
  });

  it('signal records do not double-count in stats', () => {
    const id = tracker.recordOutcome({ scope: 's', action: 'a', args_hash: 'h', outcome: 'no_signal' });
    tracker.markSignal(id, 'success');
    const s = tracker.getStats('s');
    expect(s.total).toBe(1);
    expect(s.success).toBe(1);
    expect(s.no_signal).toBe(0);
  });
});

describe('OutcomeTracker.readAll', () => {
  let tracker: OutcomeTracker;
  beforeEach(() => { tracker = new OutcomeTracker(tempLog()); });

  it('skips malformed JSON lines instead of throwing', () => {
    tracker.recordOutcome({ scope: 's', action: 'a', args_hash: 'h', outcome: 'success' });
    fs.appendFileSync((tracker as any).logPath, 'not-json-at-all\n');
    tracker.recordOutcome({ scope: 's', action: 'a', args_hash: 'h', outcome: 'fail' });
    const all = tracker.readAll();
    expect(all).toHaveLength(2);
  });

  it('returns empty when the log does not exist yet', () => {
    const fresh = new OutcomeTracker(tempLog());
    expect(fresh.readAll()).toEqual([]);
  });

  it('respects tailLimit', () => {
    for (let i = 0; i < 20; i++) tracker.recordOutcome({ scope: 's', action: 'a', args_hash: String(i), outcome: 'success' });
    expect(tracker.readAll(5).length).toBeLessThanOrEqual(6);
  });
});
