import { describe, it, expect, beforeEach } from 'vitest';
import {
  McpServerHealth,
  type ProbeResult,
} from '../mcp-server-health';

// Deterministic clock for breaker timing tests.
function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (v: number) => {
      t = v;
    },
  };
}

describe('mcp-server-health: registration', () => {
  it('registers a server and reports ExampleCo status until first sample', () => {
    const mon = new McpServerHealth();
    mon.registerServer('gmail');
    const h = mon.health('gmail');
    expect(h.status).toBe('ExampleCo');
    expect(h.total_samples).toBe(0);
  });

  it('listIds returns all registered ids', () => {
    const mon = new McpServerHealth();
    mon.registerServer('gmail');
    mon.registerServer('vapi');
    mon.registerServer('chrome');
    expect(mon.listIds().sort()).toEqual(['chrome', 'gmail', 'vapi']);
  });

  it('throws when querying an unregistered server', () => {
    const mon = new McpServerHealth();
    expect(() => mon.health('ghost')).toThrow(/server not registered/);
  });
});

describe('mcp-server-health: passive recordCall', () => {
  it('marks server up after several fast successes', () => {
    const mon = new McpServerHealth();
    mon.registerServer('gmail');
    for (let i = 0; i < 5; i++) mon.recordCall('gmail', true, 200);
    const h = mon.health('gmail');
    expect(h.status).toBe('up');
    expect(h.ok_count).toBe(5);
    expect(h.error_rate).toBe(0);
  });

  it('marks server degraded after one failure even if recent successes exist', () => {
    const mon = new McpServerHealth();
    mon.registerServer('gmail');
    mon.recordCall('gmail', true, 200);
    mon.recordCall('gmail', false, 300, 'timeout');
    const h = mon.health('gmail');
    // consecutive_failures > 0 forces degraded even if the rolling rate
    // is moderate -- prevents a fresh failure from being hidden by past
    // successes.
    expect(h.status).toBe('degraded');
    expect(h.last_error).toBe('timeout');
  });

  it('opens the breaker after consecutive failures', () => {
    const mon = new McpServerHealth({
      open_after_consecutive_failures: 3,
    });
    mon.registerServer('gmail');
    mon.recordCall('gmail', false, 100, 'e1');
    mon.recordCall('gmail', false, 100, 'e2');
    mon.recordCall('gmail', false, 100, 'e3');
    const h = mon.health('gmail');
    expect(h.breaker).toBe('open');
    expect(h.status).toBe('down');
  });

  it('opens the breaker when rolling error rate exceeds threshold', () => {
    const mon = new McpServerHealth({
      open_after_consecutive_failures: 100, // disable consecutive trip
      open_at_error_rate: 0.5,
    });
    mon.registerServer('gmail');
    // Need at least 5 samples for the rate trip (guards single-sample noise).
    mon.recordCall('gmail', true, 100);
    mon.recordCall('gmail', false, 100, 'e');
    mon.recordCall('gmail', false, 100, 'e');
    mon.recordCall('gmail', true, 100);
    mon.recordCall('gmail', false, 100, 'e');
    const h = mon.health('gmail');
    expect(h.breaker).toBe('open');
  });

  it('keeps rolling samples bounded by window', () => {
    const mon = new McpServerHealth({ window: 5 });
    mon.registerServer('gmail');
    for (let i = 0; i < 20; i++) mon.recordCall('gmail', true, 100);
    const h = mon.health('gmail');
    expect(h.total_samples).toBe(5);
  });

  it('marks server degraded when p95 latency is very high', () => {
    const mon = new McpServerHealth({ degraded_p95_ms: 1000 });
    mon.registerServer('chrome');
    for (let i = 0; i < 10; i++) mon.recordCall('chrome', true, 2000);
    const h = mon.health('chrome');
    expect(h.status).toBe('degraded');
    expect(h.p95_latency_ms).toBeGreaterThanOrEqual(1000);
  });
});

describe('mcp-server-health: active probe', () => {
  let clock: ReturnType<typeof makeClock>;
  beforeEach(() => {
    clock = makeClock();
  });

  function okProbe(): ProbeResult {
    return { ok: true, latency_ms: 100 };
  }
  function failProbe(): ProbeResult {
    return { ok: false, latency_ms: 100, error: 'connection_refused' };
  }

  it('records probe results into the rolling window', async () => {
    const mon = new McpServerHealth({ now: clock.now });
    mon.registerServer('gmail', async () => okProbe());
    await mon.probe('gmail');
    await mon.probe('gmail');
    const h = mon.health('gmail');
    expect(h.total_samples).toBe(2);
    expect(h.status).toBe('up');
  });

  it('catches a probe that throws and treats it as a failure', async () => {
    const mon = new McpServerHealth({ now: clock.now });
    mon.registerServer('vapi', async () => {
      throw new Error('socket hangup');
    });
    const r = await mon.probe('vapi');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('socket hangup');
  });

  it('opens the breaker after consecutive failing probes', async () => {
    const mon = new McpServerHealth({
      open_after_consecutive_failures: 2,
      now: clock.now,
    });
    mon.registerServer('vapi', async () => failProbe());
    await mon.probe('vapi');
    await mon.probe('vapi');
    expect(mon.health('vapi').breaker).toBe('open');
  });

  it('rejects probes during cooldown with a synthetic result', async () => {
    const mon = new McpServerHealth({
      open_after_consecutive_failures: 1,
      cooldown_ms: 60_000,
      now: clock.now,
    });
    mon.registerServer('vapi', async () => failProbe());
    await mon.probe('vapi');
    // Still in cooldown.
    clock.advance(10_000);
    const r = await mon.probe('vapi');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('breaker_open_cooldown');
  });

  it('half-opens after cooldown and closes on success', async () => {
    let nextOk = false;
    const mon = new McpServerHealth({
      open_after_consecutive_failures: 1,
      cooldown_ms: 10_000,
      close_after_consecutive_successes: 1,
      now: clock.now,
    });
    mon.registerServer('vapi', async () =>
      nextOk ? okProbe() : failProbe()
    );
    await mon.probe('vapi');
    expect(mon.health('vapi').breaker).toBe('open');
    clock.advance(11_000);
    nextOk = true;
    await mon.probe('vapi');
    expect(mon.health('vapi').breaker).toBe('closed');
  });

  it('re-opens after a failed half-open trial', async () => {
    const mon = new McpServerHealth({
      open_after_consecutive_failures: 1,
      cooldown_ms: 10_000,
      now: clock.now,
    });
    mon.registerServer('vapi', async () => failProbe());
    await mon.probe('vapi');
    clock.advance(11_000);
    const r = await mon.probe('vapi');
    expect(r.ok).toBe(false);
    expect(mon.health('vapi').breaker).toBe('open');
  });

  it('probeAll runs every registered probe', async () => {
    const mon = new McpServerHealth({ now: clock.now });
    mon.registerServer('gmail', async () => okProbe());
    mon.registerServer('vapi', async () => failProbe());
    mon.registerServer('no-probe'); // no probe fn -> skipped
    const results = await mon.probeAll();
    expect(results.gmail.ok).toBe(true);
    expect(results.vapi.ok).toBe(false);
    expect(results['no-probe']).toBeUndefined();
  });
});

describe('mcp-server-health: pickHealthy', () => {
  it('returns the first non-down candidate', () => {
    const mon = new McpServerHealth({
      open_after_consecutive_failures: 1,
    });
    mon.registerServer('claude-haiku');
    mon.registerServer('claude-sonnet');
    mon.registerServer('claude-opus');
    // Trip claude-haiku.
    mon.recordCall('claude-haiku', false, 100, 'e');
    // Make sonnet healthy.
    for (let i = 0; i < 3; i++) mon.recordCall('claude-sonnet', true, 100);
    const pick = mon.pickHealthy([
      'claude-haiku',
      'claude-sonnet',
      'claude-opus',
    ]);
    expect(pick).toBe('claude-sonnet');
  });

  it('falls through to ExampleCo candidate when allowed', () => {
    const mon = new McpServerHealth({
      open_after_consecutive_failures: 1,
    });
    mon.registerServer('down');
    mon.registerServer('ExampleCo');
    mon.recordCall('down', false, 100, 'e');
    const pick = mon.pickHealthy(['down', 'ExampleCo']);
    expect(pick).toBe('ExampleCo');
  });

  it('skips degraded when allowDegraded is false', () => {
    const mon = new McpServerHealth({ degraded_p95_ms: 100 });
    mon.registerServer('slow');
    mon.registerServer('fast');
    for (let i = 0; i < 5; i++) mon.recordCall('slow', true, 5000);
    for (let i = 0; i < 5; i++) mon.recordCall('fast', true, 50);
    const pick = mon.pickHealthy(['slow', 'fast'], { allowDegraded: false });
    expect(pick).toBe('fast');
  });

  it('returns undefined when every candidate is down', () => {
    const mon = new McpServerHealth({
      open_after_consecutive_failures: 1,
    });
    mon.registerServer('a');
    mon.registerServer('b');
    mon.recordCall('a', false, 100, 'e');
    mon.recordCall('b', false, 100, 'e');
    expect(mon.pickHealthy(['a', 'b'])).toBeUndefined();
  });

  it('ignores candidates that are not registered', () => {
    const mon = new McpServerHealth();
    mon.registerServer('a');
    for (let i = 0; i < 3; i++) mon.recordCall('a', true, 100);
    expect(mon.pickHealthy(['ghost', 'a'])).toBe('a');
  });
});

describe('mcp-server-health: reset', () => {
  it('clears samples and breaker state', () => {
    const mon = new McpServerHealth({
      open_after_consecutive_failures: 1,
    });
    mon.registerServer('a');
    mon.recordCall('a', false, 100, 'e');
    expect(mon.health('a').breaker).toBe('open');
    mon.reset('a');
    const h = mon.health('a');
    expect(h.breaker).toBe('closed');
    expect(h.total_samples).toBe(0);
    expect(h.status).toBe('ExampleCo');
  });
});
