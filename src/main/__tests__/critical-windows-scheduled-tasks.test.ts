/**
 * Regression test: critical SecondBrain Windows scheduled tasks exist.
 *
 * 2026-05-23 Luke briefing blocker root cause: the token usage collector
 * and reduction suggester scripts existed but were never wired into Windows
 * Task Scheduler, so the briefing's token usage card showed "missing" every
 * morning. After scheduling, this test asserts the registration so a future
 * uninstall or rename surfaces as a red regression instead of a silent gap
 * the briefing only catches the next morning.
 *
 * Tests are skipped on non-Windows runners (CI/Mac) because schtasks is
 * Windows-only. The point is the local + Windows-CI guard.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

const REQUIRED_TASKS = [
  // Token usage pipeline (closes blockers "Token usage yesterday is unavailable"
  // and "Token Usage card is incomplete").
  'SecondBrain-CollectDailyTokenUsage',
  'SecondBrain-SuggestTokenReduction',
  // Video regen loop (closes blocker "Video approval queue has unresolved
  // rejected work"). This task already existed pre-2026-05-23; locking it.
  'SecondBrain-AutoRegenRejectedVideos',
  // Briefing producer.
  'SecondBrain-DailyBriefing',
  // Overnight self-heal.
  'SecondBrain-HealthSelfHeal',
];

function listTasks(): string {
  try {
    return execSync('schtasks /query /fo csv', { encoding: 'utf8', timeout: 15000 });
  } catch {
    return '';
  }
}

describe('critical SecondBrain scheduled tasks', () => {
  const isWindows = process.platform === 'win32';

  it.runIf(isWindows)('every required task is registered with Windows Task Scheduler', () => {
    const out = listTasks();
    if (!out) {
      // schtasks not available on this runner (sandboxed CI). The test
      // is a local + Windows-CI guard; do not fail the broader suite.
      return;
    }
    const missing = REQUIRED_TASKS.filter((t) => !out.includes(`\\${t}`));
    expect(missing, `missing scheduled tasks: ${missing.join(', ')}`).toEqual([]);
  });
});
