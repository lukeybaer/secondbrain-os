/**
 * Tests for the nightly run 118 wiring: self-health-digest now folds in THREE
 * previously-orphaned health modules so they finally run at boot instead of
 * sitting on disk with green tests and no importer:
 *
 *   1. skill-registry      -> overdue scheduled tasks (the "a scheduled task
 *                             silently stopped running" / ETIMEDOUT detector).
 *   2. agent-reflection    -> tasks with recurring failure/partial outcomes.
 *   3. agent-decision-log  -> recent escalations in the heal/routing log.
 *
 * Each fold is optional and boot-safe (null + silent until its input path is
 * supplied and non-empty). These tests lock the wiring so the modules cannot be
 * re-orphaned, and prove the folds surface the right warnings on real fixtures.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildSelfHealthDigest } from '../self-health-digest';

let srcDir: string;
let workDir: string;
let skillsDir: string;

beforeAll(() => {
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh118-src-'));
  fs.writeFileSync(path.join(srcDir, 'index.ts'), "import './wired';\nexport const x = 1;\n");
  fs.writeFileSync(path.join(srcDir, 'wired.ts'), 'export const y = 2;\n');
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh118-work-'));

  // A scheduled-tasks/ tree with three daily capabilities.
  skillsDir = path.join(workDir, 'scheduled-tasks');
  for (const name of ['stale-task', 'fresh-task', 'never-run-task']) {
    const dir = path.join(skillsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} does a thing\ncadence: daily\n---\n\nDaily run for ${name}.\n`,
    );
  }
});

afterAll(() => {
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

const baseInputs = () => ({ srcDir, indexContent: '# tiny index\n' });
const file = (name: string) => path.join(workDir, name);

describe('run-118 folds: optional + backward compatible', () => {
  it('leaves all three folds null when no paths are supplied', () => {
    const digest = buildSelfHealthDigest(baseInputs());
    expect(digest.overdueCapabilities).toBeNull();
    expect(digest.overdueLine).toBeNull();
    expect(digest.recurringFailures).toBeNull();
    expect(digest.reflectionLine).toBeNull();
    expect(digest.decisions).toBeNull();
    expect(digest.decisionLine).toBeNull();
    // No new warnings on the clean path.
    expect(digest.warnings).toEqual([]);
  });

  it('stays null + silent when the input files/dirs are missing', () => {
    const digest = buildSelfHealthDigest({
      ...baseInputs(),
      capabilitiesDir: path.join(workDir, 'no-such-dir'),
      reflectionLogPath: file('missing-reflections.jsonl'),
      decisionLogPath: file('missing-decisions.jsonl'),
    });
    expect(digest.overdueCapabilities).toBeNull();
    expect(digest.recurringFailures).toBeNull();
    expect(digest.decisions).toBeNull();
  });
});

describe('run-118 skill-registry fold: overdue scheduled tasks', () => {
  it('flags a recorded-but-stale capability and ignores a fresh one', () => {
    const NOW = Date.UTC(2026, 5, 11, 6, 0, 0); // fixed clock
    const healthPath = file('cap-health.jsonl');
    const staleTs = new Date(NOW - 50 * 3600_000).toISOString(); // 50h ago, cadence 24h*1.25=30 -> overdue
    const freshTs = new Date(NOW - 2 * 3600_000).toISOString(); // 2h ago -> not overdue
    fs.writeFileSync(
      healthPath,
      [
        JSON.stringify({ task: 'stale-task', status: 'success', timestamp: staleTs }),
        JSON.stringify({ task: 'fresh-task', status: 'success', timestamp: freshTs }),
      ].join('\n') + '\n',
    );

    const digest = buildSelfHealthDigest(
      {
        ...baseInputs(),
        capabilitiesDir: skillsDir,
        capabilityHealthPath: healthPath,
      },
      { now: NOW },
    );

    expect(digest.overdueCapabilities).not.toBeNull();
    const names = digest.overdueCapabilities!.map((o) => o.cap.name);
    expect(names).toContain('stale-task');
    expect(names).not.toContain('fresh-task');
    // never-run-task is skipped: include_ExampleCo defaults FALSE in the fold.
    expect(names).not.toContain('never-run-task');
    expect(digest.overdueLine).toContain('overdue');
    expect(digest.warnings.some((w) => w.includes('stale-task'))).toBe(true);
    expect(digest.headline).toContain('overdue');
  });

  it('flags never-run capabilities when include_ExampleCo is opted in', () => {
    const digest = buildSelfHealthDigest({
      ...baseInputs(),
      capabilitiesDir: skillsDir,
      capabilityOverdueOpts: { include_ExampleCo: true },
    });
    const names = digest.overdueCapabilities!.map((o) => o.cap.name);
    // With no health events, every daily capability reads "never run" -> all overdue.
    expect(names).toContain('never-run-task');
    expect(names).toContain('stale-task');
  });
});

describe('run-118 agent-reflection fold: recurring failures', () => {
  it('flags a task that keeps failing and skips legacy rows without a task', () => {
    const logPath = file('reflections.jsonl');
    const rows = [
      // legacy call-reflection row (no task field) -> skipped by detectRecurringFailures
      JSON.stringify({
        timestamp: '2026-06-10T01:00:00.000Z',
        callId: 'abc',
        contact: '+1',
        outcome: 'customer-ended-call',
        reflection: 'manual review needed',
      }),
      // healthy task -> not flagged
      JSON.stringify({
        timestamp: '2026-06-10T02:00:00.000Z',
        task: 'healthy-task',
        goal: 'g',
        steps: [],
        outcome: 'success',
        learnings: [],
      }),
      // flaky task: 2 failures -> meets default threshold 2
      JSON.stringify({
        timestamp: '2026-06-10T03:00:00.000Z',
        task: 'flaky-task',
        goal: 'g',
        steps: [],
        outcome: 'failure',
        learnings: ['retry the auth refresh first'],
      }),
      JSON.stringify({
        timestamp: '2026-06-10T04:00:00.000Z',
        task: 'flaky-task',
        goal: 'g',
        steps: [],
        outcome: 'partial',
        learnings: ['timeout on otter ingest'],
      }),
    ];
    fs.writeFileSync(logPath, rows.join('\n') + '\n');

    const digest = buildSelfHealthDigest({ ...baseInputs(), reflectionLogPath: logPath });
    expect(digest.recurringFailures).not.toBeNull();
    const tasks = digest.recurringFailures!.map((f) => f.task);
    expect(tasks).toContain('flaky-task');
    expect(tasks).not.toContain('healthy-task');
    expect(digest.warnings.some((w) => w.includes('flaky-task'))).toBe(true);
    expect(digest.reflectionLine).toContain('recurring');
  });
});

describe('run-118 agent-decision-log fold: recent escalations', () => {
  it('surfaces escalations recorded in the window', () => {
    const logPath = file('decisions.jsonl');
    const now = new Date().toISOString();
    const rows = [
      JSON.stringify({
        decision_id: 'd1',
        timestamp: now,
        task: 'health-self-heal',
        probe: 's3Parity',
        conditions_evaluated: [],
        decision: 'escalate',
        reason: 'retry count exhausted',
        outcome: 'pending',
      }),
      JSON.stringify({
        decision_id: 'd2',
        timestamp: now,
        task: 'health-self-heal',
        probe: 'ec2',
        conditions_evaluated: [],
        decision: 'no_action',
        reason: 'probe is green',
        outcome: 'success',
      }),
    ];
    fs.writeFileSync(logPath, rows.join('\n') + '\n');

    const digest = buildSelfHealthDigest({ ...baseInputs(), decisionLogPath: logPath });
    expect(digest.decisions).not.toBeNull();
    expect(digest.decisions!.total).toBe(2);
    expect(digest.decisions!.escalations.length).toBe(1);
    expect(digest.decisionLine).toContain('escalated');
    expect(digest.warnings.some((w) => w.includes('s3Parity'))).toBe(true);
  });
});
