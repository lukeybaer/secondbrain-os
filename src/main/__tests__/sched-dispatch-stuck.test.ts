/**
 * Regression test for the stuck scheduled-task dispatch probe in
 * scripts/health-self-heal.js.
 *
 * Incident 2026-04-11: the `secondbrain-nightly-enhancement` scheduled task
 * stopped running silently for ~24 hours because its host Claude Code agent
 * session hit "This conversation is too long to continue" and then every
 * subsequent dispatch tick hit `per_task_limit (active=1, limit=1)`. No alert
 * fired. The loop was dark and the owner only noticed because dispatch was visibly
 * broken in the UI.
 *
 * The fix was `parseSchedDispatchLog()` , a pure parser that scans the last
 * 24h of `AppData/Roaming/Claude/logs/main.log` for the stuck signatures and
 * flags the daily health check red. This test locks the parser patterns so
 * they can never silently drift.
 *
 * See memory/feedback_scheduled_task_dispatch_stuck.md for the postmortem.
 */

import { describe, it, expect } from 'vitest';

const { parseSchedDispatchLog } = require('../../../scripts/health-self-heal.js');

function ts(offsetHours: number, now: number): string {
  const d = new Date(now - offsetHours * 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

describe('parseSchedDispatchLog', () => {
  const now = Date.parse('2026-04-11T13:00:00Z');

  it('returns green when no stuck-dispatch signatures appear in the window', () => {
    const log = [
      `${ts(1, now)} [info] [ScheduledTasks] Dispatched daily-briefing`,
      `${ts(2, now)} [info] [ScheduledTasks] Task completed successfully`,
    ].join('\n');
    const result = parseSchedDispatchLog(log, now);
    expect(result.status).toBe('green');
    expect(result.stuckTasks).toEqual([]);
    expect(result.tooLongCount).toBe(0);
  });

  it('flags red when a task is stuck on per_task_limit', () => {
    const log = [
      `${ts(1, now)} [info] [ScheduledTasks] Skipping dispatch for secondbrain-nightly-enhancement: per_task_limit (active=1, limit=1)`,
      `${ts(2, now)} [info] [ScheduledTasks] Skipping dispatch for secondbrain-nightly-enhancement: per_task_limit (active=1, limit=1)`,
    ].join('\n');
    const result = parseSchedDispatchLog(log, now);
    expect(result.status).toBe('red');
    expect(result.stuckTasks).toContain('secondbrain-nightly-enhancement');
    expect(result.detail).toContain('stuck');
  });

  it('flags red when a "conversation too long" error appears', () => {
    const log = [
      `${ts(1, now)} [info] [CycleHealth] Unhealthy cycle: {`,
      `  error_message: 'This conversation is too long to continue. Start a new session, or remove some tools to free up space.',`,
      `  transcript_size_bytes: 17071447`,
      `}`,
    ].join('\n');
    // Only the line with a timestamp prefix will be parsed , match the exact
    // production log shape where the error appears on a timestamped line.
    const logWithTsOnErrorLine = [
      `${ts(1, now)} [info] [APIError] error_message: 'This conversation is too long to continue. Start a new session, or remove some tools to free up space.'`,
    ].join('\n');
    const result = parseSchedDispatchLog(logWithTsOnErrorLine, now);
    expect(result.status).toBe('red');
    expect(result.tooLongCount).toBeGreaterThanOrEqual(1);
    expect(result.detail).toContain('context-too-long');
  });

  it('ignores entries older than 24 hours', () => {
    const log = [
      `${ts(48, now)} [info] [ScheduledTasks] Skipping dispatch for secondbrain-nightly-enhancement: per_task_limit (active=1, limit=1)`,
      `${ts(30, now)} [info] [APIError] error_message: 'This conversation is too long to continue.'`,
    ].join('\n');
    const result = parseSchedDispatchLog(log, now);
    expect(result.status).toBe('green');
    expect(result.stuckTasks).toEqual([]);
    expect(result.tooLongCount).toBe(0);
  });

  it('reports multiple distinct stuck tasks', () => {
    const log = [
      `${ts(1, now)} [info] [ScheduledTasks] Skipping dispatch for secondbrain-nightly-enhancement: per_task_limit (active=1, limit=1)`,
      `${ts(2, now)} [info] [ScheduledTasks] Skipping dispatch for video-quality-research: per_task_limit (active=1, limit=1)`,
    ].join('\n');
    const result = parseSchedDispatchLog(log, now);
    expect(result.status).toBe('red');
    expect(result.stuckTasks.sort()).toEqual(
      ['secondbrain-nightly-enhancement', 'video-quality-research'].sort(),
    );
  });
});
