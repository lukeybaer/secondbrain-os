/**
 * Tests for the nightly run 116 wiring: self-health-digest now folds in the
 * previously-orphaned outcome-tracker so per-scope failure rates surface inside
 * the boot-time self-audit.
 *
 * Research grounding (AgentOps 2026): failure detection -- automatically
 * flagging actions/tools whose success rate has degraded -- is a core
 * observability tier. SecondBrain already recorded outcomes (OutcomeTracker)
 * but nothing read them in the self-audit, so a quietly-failing scope would
 * never raise a flag. This fold closes that gap.
 *
 * The fold relies on the new OutcomeTracker.summarizeAllScopes() helper, which
 * is also exercised here. Tests lock the fold (cannot be re-orphaned) and prove
 * the input stays optional / boot-safe.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildSelfHealthDigest } from '../self-health-digest';
import { OutcomeTracker } from '../outcome-tracker';

let srcDir: string;
let workDir: string;

beforeAll(() => {
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh116o-src-'));
  fs.writeFileSync(path.join(srcDir, 'index.ts'), "import './wired';\nexport const x = 1;\n");
  fs.writeFileSync(path.join(srcDir, 'wired.ts'), 'export const y = 2;\n');
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh116o-work-'));
});

afterAll(() => {
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

const baseInputs = () => ({ srcDir, indexContent: '# tiny index\n' });

function makeLog(name: string): string {
  return path.join(workDir, name);
}

describe('run-116 outcome fold: optional + backward compatible', () => {
  it('leaves outcomes null when no log path is supplied', () => {
    const digest = buildSelfHealthDigest(baseInputs());
    expect(digest.outcomes).toBeNull();
    expect(digest.outcomeLine).toBeNull();
  });

  it('stays null + silent when the outcome log is missing', () => {
    const digest = buildSelfHealthDigest({
      ...baseInputs(),
      outcomeLogPath: makeLog('missing.jsonl'),
    });
    expect(digest.outcomes).toBeNull();
  });
});

describe('run-116 outcome fold: failure detection', () => {
  it('flags a scope whose success rate is below the floor', () => {
    const logPath = makeLog('failing.jsonl');
    const t = new OutcomeTracker(logPath);
    // healthy scope: 5/5 succeed
    for (let i = 0; i < 5; i++) {
      t.recordOutcome({
        scope: 'gmail-scan',
        action: 'fetch',
        args_hash: String(i),
        outcome: 'success',
      });
    }
    // failing scope: 1 success, 5 fails -> 17% success, 6 decided (>= min 5)
    t.recordOutcome({ scope: 'vapi-call', action: 'dial', args_hash: 's', outcome: 'success' });
    for (let i = 0; i < 5; i++) {
      t.recordOutcome({
        scope: 'vapi-call',
        action: 'dial',
        args_hash: 'f' + i,
        outcome: 'fail',
        error_class: 'timeout',
      });
    }

    const digest = buildSelfHealthDigest({ ...baseInputs(), outcomeLogPath: logPath });
    expect(digest.outcomes).not.toBeNull();
    expect(digest.outcomes!.length).toBe(2);
    const warn = digest.warnings.find((w) => w.includes('vapi-call'));
    expect(warn).toBeTruthy();
    expect(warn).toContain('timeout');
    // healthy scope must NOT warn
    expect(digest.warnings.some((w) => w.includes('gmail-scan'))).toBe(false);
    expect(digest.outcomeLine).toContain('scope');
    expect(digest.headline).toContain('Outcomes');
  });

  it('does not warn when sample size is below the minimum', () => {
    const logPath = makeLog('tiny.jsonl');
    const t = new OutcomeTracker(logPath);
    // 2 fails only -> below default min of 5 decided records
    t.recordOutcome({ scope: 'rare-op', action: 'x', args_hash: '1', outcome: 'fail' });
    t.recordOutcome({ scope: 'rare-op', action: 'x', args_hash: '2', outcome: 'fail' });

    const digest = buildSelfHealthDigest({ ...baseInputs(), outcomeLogPath: logPath });
    expect(digest.outcomes!.length).toBe(1);
    expect(digest.warnings.some((w) => w.includes('rare-op'))).toBe(false);
  });

  it('respects a custom fail-rate threshold', () => {
    const logPath = makeLog('threshold.jsonl');
    const t = new OutcomeTracker(logPath);
    // 7 success, 3 fail -> 70% success. Default floor 70% passes; a stricter
    // 20% fail ceiling (80% floor) flags it.
    for (let i = 0; i < 7; i++) {
      t.recordOutcome({ scope: 'svc', action: 'a', args_hash: 's' + i, outcome: 'success' });
    }
    for (let i = 0; i < 3; i++) {
      t.recordOutcome({ scope: 'svc', action: 'a', args_hash: 'f' + i, outcome: 'fail' });
    }
    const lax = buildSelfHealthDigest({ ...baseInputs(), outcomeLogPath: logPath });
    expect(lax.warnings.some((w) => w.includes('svc'))).toBe(false);

    const strict = buildSelfHealthDigest(
      { ...baseInputs(), outcomeLogPath: logPath },
      { maxOutcomeFailRate: 0.2 },
    );
    expect(strict.warnings.some((w) => w.includes('svc'))).toBe(true);
  });
});
