/**
 * Tests for the nightly run 112 wiring: self-health-digest now folds in two
 * previously-orphaned modules so they finally run inside the boot-time audit
 * instead of sitting on disk with green tests:
 *
 *   - retry-pressure-report (the run-111 model-retry-loop consumer)
 *   - core-block-health (live core-memory occupancy)
 *
 * Run 112 chose WIRING over building new modules because the wiring audit
 * showed 68 orphaned modules / ~18k dead-weight lines. These tests lock the
 * folds so neither module can be re-orphaned, and prove both inputs stay
 * optional (boot-safe / backward compatible).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildSelfHealthDigest } from '../self-health-digest';

// Minimal synthetic src tree so the wiring auditor has files to scan; the folds
// under test do not depend on its contents.
let srcDir: string;
let workDir: string;

beforeAll(() => {
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh112-src-'));
  fs.writeFileSync(
    path.join(srcDir, 'index.ts'),
    "import './wired';\nexport const x = 1;\n",
  );
  fs.writeFileSync(path.join(srcDir, 'wired.ts'), 'export const y = 2;\n');

  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh112-work-'));
});

afterAll(() => {
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

const baseInputs = () => ({ srcDir, indexContent: '# tiny index\n' });

describe('run-112 self-health folds: optional + backward compatible', () => {
  it('leaves both folds null when their inputs are absent', () => {
    const digest = buildSelfHealthDigest(baseInputs());
    expect(digest.retryPressure).toBeNull();
    expect(digest.coreBlockHealthLine).toBeNull();
    // Existing fields still present (no regression on the run-109 shape).
    expect(digest.wiring).toBeDefined();
    expect(digest.indexBudget).toBeDefined();
  });

  it('stays null + silent when the retry-attempts file is missing', () => {
    const digest = buildSelfHealthDigest({
      ...baseInputs(),
      retryAttemptsPath: path.join(workDir, 'does-not-exist.jsonl'),
    });
    expect(digest.retryPressure).toBeNull();
  });
});

describe('run-112 fold: retry-pressure-report', () => {
  it('aggregates flagged tools into the digest, warnings, and headline', () => {
    // 4 calls of one tool, 3 of which exhausted their cap -> high pressure.
    const attemptsPath = path.join(workDir, 'retry-attempts.jsonl');
    const rec = (terminal: string, corrections: number) =>
      JSON.stringify({
        timestamp: '2026-06-04T00:00:00Z',
        toolName: 'dispatch_validate',
        attempts: corrections + 1,
        corrections,
        terminal,
        violationRules: ['required'],
      });
    fs.writeFileSync(
      attemptsPath,
      [
        rec('exhausted_validation', 2),
        rec('exhausted_validation', 2),
        rec('exhausted_budget', 1),
        rec('ok', 1),
      ].join('\n') + '\n',
    );

    const digest = buildSelfHealthDigest({
      ...baseInputs(),
      retryAttemptsPath: attemptsPath,
    });

    expect(digest.retryPressure).not.toBeNull();
    expect(digest.retryPressure!.totalCalls).toBe(4);
    expect(digest.retryPressure!.flagged.length).toBeGreaterThan(0);
    expect(digest.retryPressure!.flagged[0].toolName).toBe('dispatch_validate');
    // The flagged tool surfaces as a warning and in the headline.
    expect(digest.warnings.some((w) => w.includes('dispatch_validate'))).toBe(
      true,
    );
    expect(digest.headline).toContain('retry pressure');
  });

  it('reports no pressure (null-ish) when every call succeeds first try', () => {
    const attemptsPath = path.join(workDir, 'retry-clean.jsonl');
    const ok = JSON.stringify({
      timestamp: '2026-06-04T00:00:00Z',
      toolName: 'happy_tool',
      attempts: 1,
      corrections: 0,
      terminal: 'ok',
      violationRules: [],
    });
    fs.writeFileSync(attemptsPath, [ok, ok, ok].join('\n') + '\n');

    const digest = buildSelfHealthDigest({
      ...baseInputs(),
      retryAttemptsPath: attemptsPath,
    });
    // Records exist so the report is built, but nothing is flagged.
    expect(digest.retryPressure!.flagged.length).toBe(0);
    expect(digest.headline).not.toContain('retry pressure');
  });
});

describe('run-112 fold: core-block-health', () => {
  it('sets the occupancy line and never crashes on an empty blocks dir', () => {
    const blocksDir = fs.mkdtempSync(path.join(workDir, 'blocks-'));
    const queueDir = path.join(workDir, 'triggers');

    const digest = buildSelfHealthDigest({
      ...baseInputs(),
      coreBlockHealthDirs: { blocksDir, queueDir },
    });

    expect(digest.coreBlockHealthLine).toBe('Core memory: no blocks');
    expect(digest.headline).toContain('Core memory: no blocks');
  });

  it('leaves the line null when the blocks dir does not exist', () => {
    const digest = buildSelfHealthDigest({
      ...baseInputs(),
      coreBlockHealthDirs: {
        blocksDir: path.join(workDir, 'no-such-blocks'),
        queueDir: path.join(workDir, 'no-such-triggers'),
      },
    });
    expect(digest.coreBlockHealthLine).toBeNull();
  });
});
