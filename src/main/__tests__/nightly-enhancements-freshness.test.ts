/**
 * Regression test for the nightly-enhancements freshness probe in
 * scripts/health-self-heal.js.
 *
 * Incident 2026-04-13: the `video-quality-research` scheduled task failed
 * overnight due to API rate limits. The task dispatched successfully (no
 * per_task_limit pattern in main.log), ran, hit a rate limit mid-execution,
 * and wrote nothing to nightly-enhancements.jsonl. The existing
 * parseSchedDispatchLog probe did not fire because dispatch itself succeeded.
 * The failure was only discovered when Luke manually triggered a catch-up run.
 *
 * Fix: probeNightlyEnhancements(thresholdHours, appDataOverride) checks the
 * last entry timestamp in nightly-enhancements.jsonl directly. Fires red if
 * >36h since last entry, regardless of failure cause (rate limit, crash,
 * dispatch-stuck, etc.). appDataOverride is injected by tests; production
 * callers omit it and use the module-level APPDATA constant.
 *
 * This test locks the probe contract so it cannot silently drift.
 * See memory/feedback_scheduled_task_dispatch_stuck.md for the postmortem.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Load the exported function via require (health-self-heal is CJS)
const { probeNightlyEnhancements } = require('../../../scripts/health-self-heal.js');

function makeEnhancementsLog(tmpDir: string, entries: object[]): void {
  const agentDir = path.join(tmpDir, 'secondbrain', 'data', 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  const logPath = path.join(agentDir, 'nightly-enhancements.jsonl');
  fs.writeFileSync(logPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

describe('probeNightlyEnhancements', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns green when last entry is within 36h', () => {
    const recentTs = new Date(Date.now() - 12 * 3600_000).toISOString();
    makeEnhancementsLog(tmpDir, [
      {
        run_number: 7,
        timestamp: new Date(Date.now() - 48 * 3600_000).toISOString(),
        tool: 'analyze-trending-topics',
      },
      { run_number: 8, timestamp: recentTs, tool: 'analyze-retention-curve' },
    ]);
    const result = probeNightlyEnhancements(36, tmpDir);
    expect(result.status).toBe('green');
    expect(result.ageHrs).toBeLessThanOrEqual(13);
    expect(result.lastRunTs).toBe(recentTs);
  });

  it('returns red when last entry is older than 36h', () => {
    const staleTs = new Date(Date.now() - 40 * 3600_000).toISOString();
    makeEnhancementsLog(tmpDir, [
      { run_number: 7, timestamp: staleTs, tool: 'analyze-emotional-arc' },
    ]);
    const result = probeNightlyEnhancements(36, tmpDir);
    expect(result.status).toBe('red');
    expect(result.ageHrs).toBeGreaterThanOrEqual(40);
    expect(result.detail).toContain('threshold');
  });

  it('returns red when the log file does not exist', () => {
    // tmpDir exists but has no secondbrain/data/agent/nightly-enhancements.jsonl
    const result = probeNightlyEnhancements(36, tmpDir);
    expect(result.status).toBe('red');
    expect(result.detail).toContain('not found');
    expect(result.lastRunTs).toBeNull();
  });

  it('returns red when the log file is empty', () => {
    const agentDir = path.join(tmpDir, 'secondbrain', 'data', 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'nightly-enhancements.jsonl'), '');
    const result = probeNightlyEnhancements(36, tmpDir);
    expect(result.status).toBe('red');
    expect(result.detail).toContain('empty');
  });

  it('returns red when last entry has no timestamp field', () => {
    makeEnhancementsLog(tmpDir, [{ run_number: 5, tool: 'analyze-framing' }]);
    const result = probeNightlyEnhancements(36, tmpDir);
    expect(result.status).toBe('red');
    expect(result.detail).toContain('no timestamp');
  });

  it('uses only the LAST entry (stale first + fresh last = green)', () => {
    const freshTs = new Date(Date.now() - 2 * 3600_000).toISOString();
    makeEnhancementsLog(tmpDir, [
      { run_number: 1, timestamp: new Date(Date.now() - 200 * 3600_000).toISOString(), tool: 'x' },
      { run_number: 8, timestamp: freshTs, tool: 'analyze-trending-topics' },
    ]);
    const result = probeNightlyEnhancements(36, tmpDir);
    expect(result.status).toBe('green');
    expect(result.lastRunTs).toBe(freshTs);
  });

  it('respects custom threshold argument (12h fresh: green@36, red@10)', () => {
    const ts12h = new Date(Date.now() - 12 * 3600_000).toISOString();
    makeEnhancementsLog(tmpDir, [
      { run_number: 8, timestamp: ts12h, tool: 'analyze-color-consistency' },
    ]);
    expect(probeNightlyEnhancements(36, tmpDir).status).toBe('green');
    expect(probeNightlyEnhancements(10, tmpDir).status).toBe('red');
  });
});
