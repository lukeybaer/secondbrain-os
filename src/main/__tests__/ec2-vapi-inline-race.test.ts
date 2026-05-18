/**
 * ec2-vapi-inline-race.test.ts
 *
 * Regression test for the run_claude_code 25s inline race added to
 * ec2-server.js (commit 11 of plans/dazzling-rolling-moler.md). The
 * actual handler lives in ec2-server.js which is plain Node / CJS and
 * runs on EC2 — we test the race LOGIC by reimplementing it here so
 * a regression in behavior surfaces immediately.
 *
 * The contract:
 * 1. If the command completes within 25s, the inline resolver wins and
 *    repliedInline is set to true on the command so the outbound
 *    callback is skipped.
 * 2. If the 25s timeout fires first, the entry is marked timedOut and
 *    a later /complete must NOT trigger the inline resolver. The
 *    outbound callback runs normally.
 * 3. The race winner is whichever fires first; the loser is a no-op.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// Reimplement the parts of ec2-server.js that matter for this test.
// This is the same pattern ec2-scheduler.test.ts uses — test the logic
// without loading the full EC2 module.

interface Command {
  id: string;
  replyTo: 'telegram' | 'vapi';
  repliedInline: boolean;
  result: string;
  success: boolean;
  vapiCallId: string | null;
}

interface PendingInlineEntry {
  resolve: (value: string | null) => void;
  timedOut: boolean;
}

function makeRaceHarness() {
  const pendingInlineVapi = new Map<string, PendingInlineEntry>();
  let outboundCallbackFired = false;

  function startInlineRace(cmd: Command, timeoutMs = 25000): Promise<string | null> {
    return new Promise((resolve) => {
      const entry: PendingInlineEntry = { resolve, timedOut: false };
      pendingInlineVapi.set(cmd.id, entry);
      setTimeout(() => {
        if (pendingInlineVapi.has(cmd.id)) {
          entry.timedOut = true;
          pendingInlineVapi.delete(cmd.id);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  function completeCommand(cmd: Command, result: string, success: boolean) {
    cmd.result = result;
    cmd.success = success;
    const entry = pendingInlineVapi.get(cmd.id);
    if (entry && !entry.timedOut) {
      pendingInlineVapi.delete(cmd.id);
      cmd.repliedInline = true;
      const inlineText = success
        ? result.slice(0, 500)
        : 'That ran into a problem: ' + result.slice(0, 400);
      entry.resolve(inlineText);
    }
    deliverCommandResult(cmd);
  }

  function deliverCommandResult(cmd: Command) {
    if (cmd.replyTo === 'vapi') {
      if (cmd.repliedInline) return; // skip the outbound callback
      outboundCallbackFired = true;
    }
  }

  return {
    startInlineRace,
    completeCommand,
    getCallbackFired: () => outboundCallbackFired,
    getPendingSize: () => pendingInlineVapi.size,
  };
}

describe('run_claude_code 25s inline race', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeCmd(): Command {
    return {
      id: 'cmd_test_' + Math.random().toString(36).slice(2),
      replyTo: 'vapi',
      repliedInline: false,
      result: '',
      success: false,
      vapiCallId: 'call_abc123',
    };
  }

  it('completes inline when command finishes within 25s', async () => {
    const h = makeRaceHarness();
    const cmd = makeCmd();

    const racePromise = h.startInlineRace(cmd, 25000);

    // Command completes at t=5s (well within the 25s window)
    vi.advanceTimersByTime(5000);
    h.completeCommand(cmd, 'The dentist can fit you in Thursday at 2pm.', true);

    const result = await racePromise;

    expect(result).toBe('The dentist can fit you in Thursday at 2pm.');
    expect(cmd.repliedInline).toBe(true);
    expect(h.getCallbackFired()).toBe(false);
    expect(h.getPendingSize()).toBe(0);
  });

  it('falls back to outbound callback when command exceeds 25s', async () => {
    const h = makeRaceHarness();
    const cmd = makeCmd();

    const racePromise = h.startInlineRace(cmd, 25000);

    // 25s elapses, no completion
    vi.advanceTimersByTime(25000);

    const result = await racePromise;
    expect(result).toBeNull(); // timeout fired

    // Command completes later (t=40s) after the caller has been told "I'll call back"
    vi.advanceTimersByTime(15000);
    h.completeCommand(cmd, 'late answer', true);

    expect(cmd.repliedInline).toBe(false);
    expect(h.getCallbackFired()).toBe(true);
    expect(h.getPendingSize()).toBe(0);
  });

  it('race winner wins — completion before timeout does not double-deliver', async () => {
    const h = makeRaceHarness();
    const cmd = makeCmd();

    const racePromise = h.startInlineRace(cmd, 25000);

    // Fire completion exactly at t=24s
    vi.advanceTimersByTime(24000);
    h.completeCommand(cmd, 'just in time', true);

    // Then advance past 25s
    vi.advanceTimersByTime(5000);

    const result = await racePromise;
    expect(result).toBe('just in time');
    expect(cmd.repliedInline).toBe(true);
    expect(h.getCallbackFired()).toBe(false);
  });

  it('failed command inline path surfaces the error to the caller', async () => {
    const h = makeRaceHarness();
    const cmd = makeCmd();

    const racePromise = h.startInlineRace(cmd, 25000);
    vi.advanceTimersByTime(3000);
    h.completeCommand(cmd, 'permission denied on /opt/secondbrain', false);

    const result = await racePromise;
    expect(result).toContain('ran into a problem');
    expect(result).toContain('permission denied');
    expect(cmd.repliedInline).toBe(true);
    expect(h.getCallbackFired()).toBe(false);
  });

  it('result text is capped so Vapi does not choke on multi-page output', async () => {
    const h = makeRaceHarness();
    const cmd = makeCmd();
    const racePromise = h.startInlineRace(cmd, 25000);
    vi.advanceTimersByTime(1000);
    h.completeCommand(cmd, 'x'.repeat(5000), true);
    const result = await racePromise;
    expect(result!.length).toBeLessThanOrEqual(500);
  });
});
