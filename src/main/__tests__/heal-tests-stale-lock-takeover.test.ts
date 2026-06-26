/**
 * Regression test: a heal-tests run that crashes without releasing its lock
 * must NOT block every future run forever.
 *
 * 2026-06-09 #gap. The 22:00 nightly loop (pid 25184) acquired the lock,
 * crashed mid-attempt (leaving an orphaned vitest worker), and never ran
 * releaseLock(). The lockfile persisted. Every subsequent run skipped with
 * "another heal-tests run is active (pid 25184)" -- because on Windows
 * Node's `process.kill(pid, 0)` returned success for the dead/recycled pid
 * (tasklist showed NO such process and zero node.exe running, yet
 * isPidAlive returned true). So a single crashed run silently disabled the
 * loop the briefing's "looping on this" claim depends on, with no time
 * bound on how long the block lasts.
 *
 * Root-cause fix: lock staleness can no longer rest on pid-liveness alone.
 * A lock is also stale once its age exceeds the maximum legitimate loop
 * wall time (derived from its own --max/--interval argv). This bounds any
 * crashed run's lock to <= one full legitimate loop duration, after which
 * the next run takes over instead of skipping indefinitely.
 *
 * Category encoded (not the literal pid 25184): "an unreleased lock whose
 * pid the OS reports as alive must still expire by age."
 */

import { describe, it, expect } from 'vitest';
import * as heal from '../../../scripts/heal-tests.js';

const MINUTE = 60 * 1000;

describe('heal-tests stale-lock takeover by age', () => {
  it('exports the staleness helpers', () => {
    expect(typeof (heal as any).isLockStale).toBe('function');
    expect(typeof (heal as any).maxLockWallMs).toBe('function');
  });

  it('derives a ceiling from --max/--interval that exceeds a single interval', () => {
    const argv = ['--loop', '--max=8', '--interval=1800000'];
    const ceiling = (heal as any).maxLockWallMs(argv);
    // 8 * 30min + 8 * per-attempt-timeout + buffer -- must clear the
    // worst-case legitimate run, i.e. well past one 30-min interval.
    expect(ceiling).toBeGreaterThan(8 * 1800000);
  });

  it('falls back to a non-trivial ceiling when argv is missing', () => {
    const ceiling = (heal as any).maxLockWallMs(undefined);
    expect(ceiling).toBeGreaterThan(60 * MINUTE);
  });

  it('treats an over-age lock as stale EVEN when the pid reports alive', () => {
    const now = 10_000 * MINUTE;
    const argv = ['--loop', '--max=8', '--interval=1800000'];
    const ceiling = (heal as any).maxLockWallMs(argv);
    const lock = {
      pid: 25184,
      startedAt: new Date(now - ceiling - MINUTE).toISOString(),
      argv,
    };
    const alwaysAlive = () => true; // simulate Windows false-positive
    expect((heal as any).isLockStale(lock, now, alwaysAlive)).toBe(true);
  });

  it('does NOT treat a fresh lock with a live pid as stale (legit concurrent run still skips)', () => {
    const now = 10_000 * MINUTE;
    const argv = ['--loop', '--max=8', '--interval=1800000'];
    const lock = {
      pid: 12345,
      startedAt: new Date(now - 5 * MINUTE).toISOString(),
      argv,
    };
    const alwaysAlive = () => true;
    expect((heal as any).isLockStale(lock, now, alwaysAlive)).toBe(false);
  });

  it('treats a lock with a dead pid as stale regardless of age', () => {
    const now = 10_000 * MINUTE;
    const lock = {
      pid: 999999,
      startedAt: new Date(now - MINUTE).toISOString(),
      argv: ['--loop', '--max=8', '--interval=1800000'],
    };
    const neverAlive = () => false;
    expect((heal as any).isLockStale(lock, now, neverAlive)).toBe(true);
  });

  it('treats a corrupt/invalid lock as stale', () => {
    const neverMatters = () => true;
    expect((heal as any).isLockStale(null, 0, neverMatters)).toBe(true);
    expect(
      (heal as any).isLockStale({ pid: 1, startedAt: 'not-a-date', argv: [] }, 0, neverMatters),
    ).toBe(true);
  });
});
