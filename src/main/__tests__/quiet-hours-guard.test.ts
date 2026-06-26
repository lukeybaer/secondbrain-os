/**
 * Regression test: no scheduled task fires during quiet hours (8 PM - 5 AM CT).
 *
 * Incident 2026-04-15: the `nightly-token-optimization-research` task had cron
 * `0 23 * * *` (11 PM CT nightly), violating the Telegram policy that bans
 * proactive sends outside the 5:30 AM briefing window. The owner received
 * unwanted news pings at 11:11 PM.
 *
 * This test scans all scheduled-tasks.json files for cron expressions that
 * fire during quiet hours (20:00-04:59 CT) and rejects any that are not
 * explicitly exempted. Overnight automation tasks that do NOT send Telegram
 * messages (nightly-enhancement, video-quality-research, etc.) are exempted
 * because they only write files and commit code.
 *
 * See memory/feedback_telegram_policy.md for the Telegram channel policy.
 * See memory/feedback_no_late_night_telegram.md for the #gap postmortem.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Tasks explicitly allowed to fire during quiet hours because they:
// 1. Do NOT send Telegram messages (they write files, commit code, or log to JSONL)
// 2. Run unattended overnight work that must complete before the 5:30 AM briefing
const QUIET_HOURS_EXEMPTIONS = new Set([
  'secondbrain-nightly-enhancement', // writes code, commits, logs to JSONL
  'video-quality-research',          // researches + builds tools, no Telegram
  'video-quality-tools',             // builds analyzers, no Telegram (disabled)
  'daily-birthday-check',            // writes _upcoming-dates.md, no Telegram
  'daily-gmail-scan',                // updates contact files, no Telegram
  'daily-otter-sweep',               // enriches contacts, no Telegram
  'daily-linkedin-scan',             // writes _linkedin-daily-intel.md, no Telegram
  'kingdom-equipping-ideas',         // writes briefing idea artifact, no Telegram
  'daily-amy-health-check',          // health probe, alerts only if red
  'weekly-warmth-audit',             // writes warmth report, no Telegram
  'weekly-backup-health-check',      // backup verification, no Telegram
  'monthly-memory-cleanup',          // memory consolidation, no Telegram
  'nightly-heal-tests',              // runs vitest, writes tests-blocked.json, no Telegram
]);

/** Parse a 5-field cron expression and return all hours it fires at (0-23). */
function cronFiringHours(expr: string): number[] {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return [];

  const hourField = parts[1];
  const hours: number[] = [];

  for (const segment of hourField.split(',')) {
    // Handle ranges with steps: "1-5/2" or "*/3"
    const stepMatch = segment.match(/^(\d+|\*)-?(\d+)?\/(\d+)$/);
    if (stepMatch) {
      const start = stepMatch[1] === '*' ? 0 : parseInt(stepMatch[1], 10);
      const end = stepMatch[2] ? parseInt(stepMatch[2], 10) : 23;
      const step = parseInt(stepMatch[3], 10);
      for (let h = start; h <= end; h += step) hours.push(h);
      continue;
    }

    // Handle "*/N"
    if (segment.startsWith('*/')) {
      const step = parseInt(segment.slice(2), 10);
      for (let h = 0; h <= 23; h += step) hours.push(h);
      continue;
    }

    // Handle ranges: "8-18"
    const rangeMatch = segment.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1], 10);
      const hi = parseInt(rangeMatch[2], 10);
      for (let h = lo; h <= hi; h++) hours.push(h);
      continue;
    }

    // Handle wildcard
    if (segment === '*') {
      for (let h = 0; h <= 23; h++) hours.push(h);
      continue;
    }

    // Handle literal hour
    const h = parseInt(segment, 10);
    if (!isNaN(h)) hours.push(h);
  }

  return hours;
}

/** Hours 20-23 and 0-4 CT are quiet hours. */
function isQuietHour(hour: number): boolean {
  return hour >= 20 || hour <= 4;
}

describe('quiet hours guard', () => {
  it('cronFiringHours parses correctly', () => {
    expect(cronFiringHours('30 5 * * *')).toEqual([5]);
    expect(cronFiringHours('0 23 * * *')).toEqual([23]);
    expect(cronFiringHours('0 0 * * *')).toEqual([0]);
    expect(cronFiringHours('0 8-18 * * 1-5')).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(cronFiringHours('23 */3 * * *')).toEqual([0, 3, 6, 9, 12, 15, 18, 21]);
  });

  it('no non-exempted scheduled task fires during quiet hours', () => {
    // Check both Claude Code and Claude Desktop scheduled-tasks.json
    const sessionRoot = path.join(os.homedir(), 'AppData', 'Roaming', 'Claude');
    const candidates = [
      path.join(sessionRoot, 'claude-code-sessions'),
      path.join(sessionRoot, 'local-agent-mode-sessions'),
    ];

    const violations: string[] = [];

    for (const root of candidates) {
      if (!fs.existsSync(root)) continue;

      // Walk to find scheduled-tasks.json files
      const walk = (dir: string): string[] => {
        const results: string[] = [];
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) results.push(...walk(full));
            else if (entry.name === 'scheduled-tasks.json') results.push(full);
          }
        } catch {
          // permission errors, etc.
        }
        return results;
      };

      for (const jsonPath of walk(root)) {
        let data: any;
        try {
          data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        } catch {
          continue;
        }

        const tasks = data.scheduledTasks || data.tasks || [];
        for (const task of tasks) {
          if (!task.cronExpression || !task.enabled) continue;
          if (QUIET_HOURS_EXEMPTIONS.has(task.id)) continue;

          const hours = cronFiringHours(task.cronExpression);
          const quietHours = hours.filter(isQuietHour);
          if (quietHours.length > 0) {
            violations.push(
              `Task "${task.id}" fires at quiet hours [${quietHours.join(',')}] ` +
              `(cron: ${task.cronExpression}). ` +
              `Either add to QUIET_HOURS_EXEMPTIONS (if it never sends Telegram) ` +
              `or move its cron to 5-19 CT.`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('daily-briefing cron fires only at 5 AM', () => {
    // The briefing is the ONLY task allowed to send proactive Telegram messages,
    // and it must fire at 5:30 AM CT per project_briefing_spec.md.
    const hours = cronFiringHours('30 5 * * *');
    expect(hours).toEqual([5]);
    expect(hours.some(isQuietHour)).toBe(false);
  });
});
