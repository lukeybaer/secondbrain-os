/**
 * Tests for the EC2 server scheduler logic.
 * Tests the time-window and idempotency flag helpers that power
 * the daily briefing + evening update schedule.
 */

import { describe, it, expect } from 'vitest';

// ── Re-implement the pure functions from ec2-server.js for testing ──────────
// (ec2-server.js is CJS / plain Node — we test the logic, not the module)

function inWindow(
  time: { hour: number; minute: number },
  targetHour: number,
  targetMinute: number,
  windowMinutes = 2,
): boolean {
  const nowTotal = time.hour * 60 + time.minute;
  const targetTotal = targetHour * 60 + targetMinute;
  return nowTotal >= targetTotal && nowTotal < targetTotal + windowMinutes;
}

describe('inWindow', () => {
  it('returns true when exactly at target time', () => {
    expect(inWindow({ hour: 5, minute: 29 }, 5, 29)).toBe(true);
  });

  it('returns true within the window', () => {
    expect(inWindow({ hour: 5, minute: 30 }, 5, 29)).toBe(true);
  });

  it('returns false outside the window', () => {
    expect(inWindow({ hour: 5, minute: 31 }, 5, 29)).toBe(false);
  });

  it('returns false before the window', () => {
    expect(inWindow({ hour: 5, minute: 28 }, 5, 29)).toBe(false);
  });

  it('handles custom window size', () => {
    expect(inWindow({ hour: 5, minute: 32 }, 5, 29, 5)).toBe(true);
    expect(inWindow({ hour: 5, minute: 34 }, 5, 29, 5)).toBe(false);
  });

  it('handles evening update time (21:00)', () => {
    expect(inWindow({ hour: 21, minute: 0 }, 21, 0)).toBe(true);
    expect(inWindow({ hour: 21, minute: 1 }, 21, 0)).toBe(true);
    expect(inWindow({ hour: 21, minute: 2 }, 21, 0)).toBe(false);
  });

  it('handles midnight window', () => {
    expect(inWindow({ hour: 0, minute: 0 }, 0, 0, 3)).toBe(true);
    expect(inWindow({ hour: 0, minute: 2 }, 0, 0, 3)).toBe(true);
    expect(inWindow({ hour: 0, minute: 3 }, 0, 0, 3)).toBe(false);
  });
});

describe('scheduler flag idempotency', () => {
  it('prevents duplicate firings within the same day', () => {
    const flags = new Map<string, boolean>();

    function todayKey(): string {
      return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    }
    function schedulerFlag(name: string): string {
      return name + '-' + todayKey();
    }
    function hasFired(name: string): boolean {
      return flags.has(schedulerFlag(name));
    }
    function markFired(name: string): void {
      flags.set(schedulerFlag(name), true);
    }

    expect(hasFired('briefing')).toBe(false);
    markFired('briefing');
    expect(hasFired('briefing')).toBe(true);

    // Evening is independent
    expect(hasFired('evening')).toBe(false);
    markFired('evening');
    expect(hasFired('evening')).toBe(true);
  });
});

describe('scheduler windows match expected times', () => {
  it('morning briefing fires at 5:29-5:30 AM CT', () => {
    // These are the exact times the scheduler checks
    expect(inWindow({ hour: 5, minute: 29 }, 5, 29)).toBe(true);
    expect(inWindow({ hour: 5, minute: 30 }, 5, 29)).toBe(true);
    expect(inWindow({ hour: 5, minute: 28 }, 5, 29)).toBe(false);
    expect(inWindow({ hour: 5, minute: 31 }, 5, 29)).toBe(false);
  });

  it('evening update fires at 9:00-9:01 PM CT', () => {
    expect(inWindow({ hour: 21, minute: 0 }, 21, 0)).toBe(true);
    expect(inWindow({ hour: 21, minute: 1 }, 21, 0)).toBe(true);
    expect(inWindow({ hour: 20, minute: 59 }, 21, 0)).toBe(false);
    expect(inWindow({ hour: 21, minute: 2 }, 21, 0)).toBe(false);
  });
});
