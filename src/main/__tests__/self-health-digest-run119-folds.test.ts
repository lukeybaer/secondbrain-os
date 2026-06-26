/**
 * Tests for the nightly run 119 wiring: self-health-digest now folds in THREE
 * more previously-orphaned modules so they finally run at boot instead of
 * sitting on disk with green tests and no importer:
 *
 *   1. token-budget-governor      -> cost/token-governance: a runaway window
 *                                    ('exceeded' verdict) becomes a hard warning.
 *   2. memory-archival-recommender -> memory lifecycle: cold, long-untouched keys
 *                                    become archival candidates (Letta/mem0
 *                                    forget-after-2-months); canonical files are
 *                                    protected.
 *   3. ingest-queue               -> durable-task-queue: failed or escalated
 *                                    items become a hard warning; a large pending
 *                                    backlog is a softer one.
 *
 * Each fold is optional and boot-safe (null + silent until its input path is
 * supplied and non-empty). These tests lock the wiring so the modules cannot be
 * re-orphaned, and prove the folds surface the right signal on real fixtures.
 *
 * The category under test is "an orphaned health module re-orphans" (the
 * nightly-wire-not-orphan regression), not these three named modules.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildSelfHealthDigest } from '../self-health-digest';

let srcDir: string;
let workDir: string;

beforeAll(() => {
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh119-src-'));
  fs.writeFileSync(path.join(srcDir, 'index.ts'), "import './wired';\nexport const x = 1;\n");
  fs.writeFileSync(path.join(srcDir, 'wired.ts'), 'export const y = 2;\n');
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh119-work-'));
});

afterAll(() => {
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

const baseInputs = () => ({ srcDir, indexContent: '# tiny index\n' });
const file = (name: string) => path.join(workDir, name);

describe('run-119 folds: optional + backward compatible', () => {
  it('leaves all three folds null when no paths are supplied', () => {
    const digest = buildSelfHealthDigest(baseInputs());
    expect(digest.tokenBudget).toBeNull();
    expect(digest.tokenBudgetLine).toBeNull();
    expect(digest.archivalRecommendations).toBeNull();
    expect(digest.archivalLine).toBeNull();
    expect(digest.ingestQueue).toBeNull();
    expect(digest.ingestQueueLine).toBeNull();
    expect(digest.warnings).toEqual([]);
  });

  it('stays null + silent when the input files/dirs are missing', () => {
    const missingQueue = path.join(workDir, 'no-such-queue');
    const digest = buildSelfHealthDigest({
      ...baseInputs(),
      tokenUsageLedgerPath: file('missing-tokens.jsonl'),
      memoryTemperatureDir: path.join(workDir, 'no-such-dir'),
      ingestQueueRoot: missingQueue,
    });
    expect(digest.tokenBudget).toBeNull();
    expect(digest.archivalRecommendations).toBeNull();
    expect(digest.ingestQueue).toBeNull();
    expect(digest.warnings).toEqual([]);
    // existsSync guard must NOT create the queue layout at boot.
    expect(fs.existsSync(missingQueue)).toBe(false);
  });
});

describe('run-119 token-budget-governor fold: runaway-window detection', () => {
  it('warns when usage in the window exceeds the hard cap', () => {
    const NOW = Date.UTC(2026, 5, 13, 6, 0, 0);
    const ledgerPath = file('token-usage.jsonl');
    const ts = new Date(NOW - 3_600_000).toISOString(); // 1h ago, inside a 24h window
    fs.writeFileSync(
      ledgerPath,
      [
        JSON.stringify({
          timestamp: ts,
          surface: 'briefing',
          provider: 'anthropic',
          input_tokens: 8_000_000,
          output_tokens: 4_000_000,
          est_cost_usd: 0,
          wall_ms: 1000,
          minute_bucket: ts.slice(0, 16),
        }),
      ].join('\n') + '\n',
    );

    const digest = buildSelfHealthDigest(
      {
        ...baseInputs(),
        tokenUsageLedgerPath: ledgerPath,
        tokenBudgetPolicy: {
          window_ms: 86_400_000,
          warn_tokens: 5_000_000,
          max_tokens: 10_000_000,
        },
      },
      { now: NOW },
    );

    expect(digest.tokenBudget).not.toBeNull();
    expect(digest.tokenBudget!.verdict).toBe('exceeded');
    expect(digest.tokenBudgetLine).toContain('exceeded');
    expect(digest.warnings.some((w) => w.includes('TOKEN BUDGET EXCEEDED'))).toBe(true);
    expect(digest.headline).toContain('Token budget');
  });

  it('stays clean (line only, no warning) when usage is under budget', () => {
    const NOW = Date.UTC(2026, 5, 13, 6, 0, 0);
    const ledgerPath = file('token-usage-low.jsonl');
    const ts = new Date(NOW - 3_600_000).toISOString();
    fs.writeFileSync(
      ledgerPath,
      JSON.stringify({
        timestamp: ts,
        surface: 'chat',
        provider: 'anthropic',
        input_tokens: 1000,
        output_tokens: 500,
        est_cost_usd: 0,
        wall_ms: 100,
        minute_bucket: ts.slice(0, 16),
      }) + '\n',
    );

    const digest = buildSelfHealthDigest(
      { ...baseInputs(), tokenUsageLedgerPath: ledgerPath },
      { now: NOW },
    );
    expect(digest.tokenBudget!.verdict).toBe('ok');
    expect(digest.tokenBudgetLine).toContain('[ok]');
    expect(digest.warnings).toEqual([]);
  });
});

describe('run-119 memory-archival-recommender fold: cold-key candidates', () => {
  it('flags a cold, long-untouched key and never a protected one', () => {
    const NOW = Date.UTC(2026, 5, 13, 6, 0, 0);
    // memory-temperature reads <dir>/memory-access-log.jsonl. Two keys touched
    // once ~120 days ago: one ordinary (a stale candidate), one protected.
    const longAgo = new Date(NOW - 120 * 86_400_000).toISOString();
    fs.writeFileSync(
      path.join(workDir, 'memory-access-log.jsonl'),
      [
        JSON.stringify({ memoryKey: 'reference_old_thing', timestamp: longAgo }),
        JSON.stringify({ memoryKey: 'user_profile', timestamp: longAgo }),
      ].join('\n') + '\n',
    );

    const digest = buildSelfHealthDigest(
      {
        ...baseInputs(),
        memoryTemperatureDir: workDir,
        archivalMinConfidence: 0.3,
      },
      { now: NOW },
    );

    expect(digest.archivalRecommendations).not.toBeNull();
    const keys = digest.archivalRecommendations!.map((r) => r.memoryKey);
    expect(keys).toContain('reference_old_thing');
    expect(keys).not.toContain('user_profile'); // protected by default
    expect(digest.archivalLine).toContain('Memory archive');
    expect(digest.warnings.some((w) => w.includes('reference_old_thing'))).toBe(true);
  });
});

describe('run-119 ingest-queue fold: failed/escalated/backlog detection', () => {
  // Build a real ingest-queue layout (state subdirs + item files) on disk.
  const seedQueue = (root: string, items: Record<string, number>) => {
    for (const [state, n] of Object.entries(items)) {
      const dir = path.join(root, state);
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < n; i++) {
        fs.writeFileSync(
          path.join(dir, `${state}-${i}.json`),
          JSON.stringify({ id: `${state}-${i}` }),
        );
      }
    }
  };

  it('warns when items are failed or escalated', () => {
    const root = path.join(workDir, 'queue-failed');
    seedQueue(root, { pending: 2, failed: 1, escalated: 1 });

    const digest = buildSelfHealthDigest({ ...baseInputs(), ingestQueueRoot: root });
    expect(digest.ingestQueue).not.toBeNull();
    expect(digest.ingestQueue!.failed).toBe(1);
    expect(digest.ingestQueue!.escalated).toBe(1);
    expect(digest.ingestQueueLine).toContain('failed');
    expect(digest.warnings.some((w) => w.includes('failed and 1 escalated'))).toBe(true);
    expect(digest.headline).toContain('Ingest queue');
  });

  it('warns on a large pending backlog even with no failures', () => {
    const root = path.join(workDir, 'queue-backlog');
    seedQueue(root, { pending: 6 });

    const digest = buildSelfHealthDigest({
      ...baseInputs(),
      ingestQueueRoot: root,
      ingestPendingWarnAt: 5,
    });
    expect(digest.ingestQueue!.pending).toBe(6);
    expect(digest.warnings.some((w) => w.includes('pending backlog is 6'))).toBe(true);
  });

  it('is line-only (no warning) on a healthy queue', () => {
    const root = path.join(workDir, 'queue-healthy');
    seedQueue(root, { pending: 1, done: 10 });

    const digest = buildSelfHealthDigest({ ...baseInputs(), ingestQueueRoot: root });
    expect(digest.ingestQueue!.failed).toBe(0);
    expect(digest.ingestQueueLine).toContain('1 pending');
    expect(digest.warnings).toEqual([]);
  });
});
