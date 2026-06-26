/**
 * Tests for self-health-digest.ts (nightly run 109).
 *
 * Verifies the digest composes the three previously-orphaned audit modules
 * correctly: module wiring, Tier-1 index budget, and core-block eviction.
 * The companion self-health-startup-wiring.test.ts locks the runtime wiring so
 * this capability cannot be re-orphaned.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  recommendEvictions,
  evaluateSelfHealth,
  buildSelfHealthDigest,
  persistSelfHealthDigest,
  renderSelfHealthHeadline,
  CoreBlockInput,
} from '../self-health-digest';

// A small synthetic src tree so the wiring auditor has real files to scan.
let srcDir: string;

beforeAll(() => {
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-digest-'));
  // index.ts is a default entrypoint and imports the wired module.
  fs.writeFileSync(path.join(srcDir, 'index.ts'), "import { run } from './wired-mod';\nrun();\n");
  fs.writeFileSync(path.join(srcDir, 'wired-mod.ts'), 'export function run() { return 1; }\n');
  // Two orphans: one tested, one not. Neither is imported by anything.
  fs.writeFileSync(
    path.join(srcDir, 'orphan-tested.ts'),
    '// '.repeat(1) + '\n'.repeat(50) + 'export const a = 1;\n',
  );
  fs.writeFileSync(path.join(srcDir, 'orphan-untested.ts'), 'export const b = 2;\n');
  fs.mkdirSync(path.join(srcDir, '__tests__'));
  fs.writeFileSync(
    path.join(srcDir, '__tests__', 'orphan-tested.test.ts'),
    "import { a } from '../orphan-tested';\n",
  );
});

afterAll(() => {
  fs.rmSync(srcDir, { recursive: true, force: true });
});

describe('recommendEvictions', () => {
  it('returns a plan only for blocks over their byte limit', () => {
    const blocks: CoreBlockInput[] = [
      { name: 'small', content: 'a\nb\nc', limitBytes: 10_000 },
      {
        name: 'overflowing',
        content: Array.from({ length: 200 }, (_, i) => `line ${i} cold`).join('\n'),
        limitBytes: 200,
      },
    ];
    const plans = recommendEvictions(blocks);
    expect(plans).toHaveLength(1);
    expect(plans[0].block).toBe('overflowing');
    expect(plans[0].needsEviction).toBe(true);
    expect(plans[0].evict.length).toBeGreaterThan(0);
    expect(plans[0].reclaimedBytes).toBeGreaterThan(0);
  });

  it('never evicts pinned lines', () => {
    const content = Array.from({ length: 50 }, (_, i) => `row ${i}`).join('\n');
    const plans = recommendEvictions([
      { name: 'pinned-block', content, limitBytes: 50, pinnedLineIndexes: [0, 1] },
    ]);
    expect(plans).toHaveLength(1);
    const evictedTexts = plans[0].evict.map((l) => l.text);
    expect(evictedTexts).not.toContain('row 0');
    expect(evictedTexts).not.toContain('row 1');
  });

  it('returns empty for no blocks', () => {
    expect(recommendEvictions()).toEqual([]);
    expect(recommendEvictions([])).toEqual([]);
  });
});

describe('evaluateSelfHealth', () => {
  it('warns when the Tier-1 index is over budget', () => {
    const overBudgetIndex = 'x'.repeat(30_000);
    const digest = buildSelfHealthDigest({ srcDir, indexContent: overBudgetIndex });
    expect(digest.indexBudget.overBudget).toBe(true);
    expect(digest.warnings.some((w) => /index OVER budget/i.test(w))).toBe(true);
  });

  it('warns when orphan count exceeds the threshold', () => {
    const digest = buildSelfHealthDigest({ srcDir, indexContent: 'tiny' }, { maxOrphanModules: 1 });
    expect(digest.wiring.orphanModules).toBeGreaterThan(1);
    expect(digest.warnings.some((w) => /orphaned modules/i.test(w))).toBe(true);
  });

  it('is clean (no warnings) when thresholds are generous and index fits', () => {
    const digest = buildSelfHealthDigest(
      { srcDir, indexContent: 'tiny' },
      { maxOrphanModules: 1000, maxOrphanLines: 1_000_000 },
    );
    expect(digest.indexBudget.overBudget).toBe(false);
    expect(digest.warnings).toEqual([]);
  });

  it('escalates blockedByPins separately from a normal eviction', () => {
    // A block whose pinned content alone exceeds the limit cannot be fixed by
    // eviction. evaluateSelfHealth must say so explicitly.
    const content = ['PINNED A', 'PINNED B', 'cold 1', 'cold 2'].join('\n');
    const plans = recommendEvictions([
      { name: 'pin-heavy', content, limitBytes: 5, pinnedLineIndexes: [0, 1] },
    ]);
    const warnings = evaluateSelfHealth(
      { orphanModules: 0, deadWeightLines: 0, orphans: [] } as never,
      { overBudget: false, bytesOver: 0 } as never,
      plans,
    );
    expect(warnings.some((w) => /pins themselves need review/i.test(w))).toBe(true);
  });
});

describe('buildSelfHealthDigest', () => {
  it('classifies the synthetic tree (wired / orphan-tested / orphan-untested)', () => {
    const digest = buildSelfHealthDigest({ srcDir, indexContent: 'tiny' });
    expect(digest.wiring.wiredModules).toBeGreaterThanOrEqual(1);
    const names = digest.wiring.orphans.map((o) => o.name);
    expect(names).toContain('orphan-tested');
    expect(names).toContain('orphan-untested');
    expect(names).not.toContain('wired-mod');
  });

  it('produces a non-empty composed headline', () => {
    const digest = buildSelfHealthDigest({ srcDir, indexContent: 'tiny' });
    expect(digest.headline).toBe(renderSelfHealthHeadline(digest));
    expect(digest.headline.length).toBeGreaterThan(0);
  });
});

describe('observability folding (run 109 E3)', () => {
  it('is null when no trace path is supplied', () => {
    const digest = buildSelfHealthDigest({ srcDir, indexContent: 'tiny' });
    expect(digest.observability).toBeNull();
  });

  it('folds tool-health + error clusters into the digest and warnings', () => {
    const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-trace-'));
    const tracePath = path.join(traceDir, 'tool-trace.jsonl');
    try {
      const now = Date.now();
      const recs: string[] = [];
      // A consistently failing tool, recent enough to cluster.
      for (let i = 0; i < 6; i++) {
        recs.push(
          JSON.stringify({
            timestamp: new Date(now - i * 1000).toISOString(),
            tool: 'flaky:send',
            success: false,
            duration_ms: 12,
            error: 'ECONNRESET upstream',
          }),
        );
      }
      // A healthy tool so the digest is not trivially empty.
      recs.push(
        JSON.stringify({
          timestamp: new Date(now).toISOString(),
          tool: 'memory:read',
          success: true,
          duration_ms: 3,
        }),
      );
      fs.writeFileSync(tracePath, recs.join('\n') + '\n');

      const digest = buildSelfHealthDigest({
        srcDir,
        indexContent: 'tiny',
        tracePath,
      });
      expect(digest.observability).not.toBeNull();
      expect(digest.observability!.all_clear).toBe(false);
      // The observability tier-1 line must appear in the composed headline and
      // be surfaced as a self-health warning (no silent swallow).
      expect(digest.headline).toContain(digest.observability!.tier1);
      expect(digest.warnings).toContain(digest.observability!.tier1);
    } finally {
      fs.rmSync(traceDir, { recursive: true, force: true });
    }
  });

  it('a missing trace file yields null observability (no throw)', () => {
    const digest = buildSelfHealthDigest({
      srcDir,
      indexContent: 'tiny',
      tracePath: path.join(os.tmpdir(), 'does-not-exist-xyz.jsonl'),
    });
    expect(digest.observability).toBeNull();
  });
});

describe('cost-integrity fold (run 143)', () => {
  // Helper: write a tmp dir with a tool-cost ledger and a per-task claims file,
  // run the digest, and clean up. ledger rows are keyed by `surface` (the
  // per-task scope tag the fold re-keys to taskId).
  function withCostFixture(
    ledgerRows: Array<{
      surface: string;
      input_tokens: number;
      output_tokens: number;
      est_cost_usd: number;
    }>,
    claimRows: Array<{ taskId: string; tokensIn: number; tokensOut: number; usd: number }> | string,
    run: (inputs: { toolCostLedgerPath: string; taskCostClaimsPath: string }) => void,
  ): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-costint-'));
    try {
      const ledgerPath = path.join(dir, 'tool-cost-ledger.jsonl');
      const claimsPath = path.join(dir, 'task-cost-claims.jsonl');
      fs.writeFileSync(
        ledgerPath,
        ledgerRows
          .map((r) => JSON.stringify({ timestamp: '2026-06-22T00:00:00Z', ...r }))
          .join('\n') + '\n',
      );
      fs.writeFileSync(
        claimsPath,
        typeof claimRows === 'string'
          ? claimRows
          : claimRows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
      run({ toolCostLedgerPath: ledgerPath, taskCostClaimsPath: claimsPath });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('reconciles cleanly when claimed totals match the captured ledger', () => {
    withCostFixture(
      [{ surface: 'briefing', input_tokens: 1000, output_tokens: 500, est_cost_usd: 0.45 }],
      [{ taskId: 'briefing', tokensIn: 1000, tokensOut: 500, usd: 0.45 }],
      ({ toolCostLedgerPath, taskCostClaimsPath }) => {
        const digest = buildSelfHealthDigest({
          srcDir,
          indexContent: 'tiny',
          toolCostLedgerPath,
          taskCostClaimsPath,
        });
        expect(digest.costIntegrity).not.toBeNull();
        expect(digest.costIntegrity!.summary.clean).toBe(true);
        expect(digest.costIntegrityLine).toContain('reconcile');
        expect(digest.headline).toContain(digest.costIntegrityLine!);
        // A clean reconciliation must NOT add an integrity warning.
        expect(digest.warnings.some((w) => w.startsWith('Tool-cost integrity'))).toBe(false);
      },
    );
  });

  it('flags an undercount as a warning when the ledger is missing spend', () => {
    // Claimed 1500 tokens but only one 600-token call captured: an undercount.
    withCostFixture(
      [{ surface: 'chat', input_tokens: 400, output_tokens: 200, est_cost_usd: 0.1 }],
      [{ taskId: 'chat', tokensIn: 1000, tokensOut: 500, usd: 0.5 }],
      ({ toolCostLedgerPath, taskCostClaimsPath }) => {
        const digest = buildSelfHealthDigest({
          srcDir,
          indexContent: 'tiny',
          toolCostLedgerPath,
          taskCostClaimsPath,
        });
        expect(digest.costIntegrity!.summary.undercount).toBe(1);
        expect(digest.costIntegrityLine).toContain('undercount');
        expect(
          digest.warnings.some(
            (w) => w.startsWith('Tool-cost integrity') && w.includes('UNDERCOUNTS'),
          ),
        ).toBe(true);
      },
    );
  });

  it('flags claimed spend with zero captured calls as no-data', () => {
    withCostFixture(
      [{ surface: 'briefing', input_tokens: 100, output_tokens: 50, est_cost_usd: 0.01 }],
      [{ taskId: 'orphaned-surface', tokensIn: 5000, tokensOut: 2000, usd: 1.2 }],
      ({ toolCostLedgerPath, taskCostClaimsPath }) => {
        const digest = buildSelfHealthDigest({
          srcDir,
          indexContent: 'tiny',
          toolCostLedgerPath,
          taskCostClaimsPath,
        });
        expect(digest.costIntegrity!.summary.noData).toBe(1);
        expect(digest.warnings.some((w) => w.includes('zero captured entries'))).toBe(true);
      },
    );
  });

  it('skips malformed claim lines rather than breaking the digest', () => {
    withCostFixture(
      [{ surface: 'briefing', input_tokens: 1000, output_tokens: 500, est_cost_usd: 0.45 }],
      '{ this is not json\n' +
        JSON.stringify({ taskId: 'briefing', tokensIn: 1000, tokensOut: 500, usd: 0.45 }) +
        '\n',
      ({ toolCostLedgerPath, taskCostClaimsPath }) => {
        const digest = buildSelfHealthDigest({
          srcDir,
          indexContent: 'tiny',
          toolCostLedgerPath,
          taskCostClaimsPath,
        });
        expect(digest.costIntegrity).not.toBeNull();
        expect(digest.costIntegrity!.summary.total).toBe(1);
        expect(digest.costIntegrity!.summary.clean).toBe(true);
      },
    );
  });

  it('stays null when either the claims file or the ledger is absent', () => {
    // Ledger present, no claims path → null.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-costint-'));
    try {
      const ledgerPath = path.join(dir, 'tool-cost-ledger.jsonl');
      fs.writeFileSync(
        ledgerPath,
        JSON.stringify({
          timestamp: '2026-06-22T00:00:00Z',
          surface: 'x',
          input_tokens: 1,
          output_tokens: 1,
          est_cost_usd: 0,
        }) + '\n',
      );
      const noClaims = buildSelfHealthDigest({
        srcDir,
        indexContent: 'tiny',
        toolCostLedgerPath: ledgerPath,
      });
      expect(noClaims.costIntegrity).toBeNull();
      expect(noClaims.costIntegrityLine).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists the cost-integrity summary into the JSON artifact', () => {
    withCostFixture(
      [{ surface: 'chat', input_tokens: 400, output_tokens: 200, est_cost_usd: 0.1 }],
      [{ taskId: 'chat', tokensIn: 1000, tokensOut: 500, usd: 0.5 }],
      ({ toolCostLedgerPath, taskCostClaimsPath }) => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-costint-out-'));
        try {
          const digest = buildSelfHealthDigest({
            srcDir,
            indexContent: 'tiny',
            toolCostLedgerPath,
            taskCostClaimsPath,
          });
          const p = persistSelfHealthDigest(outDir, digest, '2026-06-22T08:00:00Z');
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
          expect(parsed.costIntegrity).not.toBeNull();
          expect(parsed.costIntegrity.undercount).toBe(1);
          expect(parsed.costIntegrity.problems.length).toBeGreaterThan(0);
          expect(parsed.costIntegrity.problems[0].status).toBe('undercount');
        } finally {
          fs.rmSync(outDir, { recursive: true, force: true });
        }
      },
    );
  });
});

describe('persistSelfHealthDigest', () => {
  it('writes a readable JSON artifact with the headline and warnings', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-out-'));
    try {
      const digest = buildSelfHealthDigest(
        { srcDir, indexContent: 'tiny' },
        { maxOrphanModules: 1 },
      );
      const p = persistSelfHealthDigest(outDir, digest, '2026-06-02T08:00:00Z');
      expect(p.endsWith('self-health-digest.json')).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      expect(parsed.generated_at).toBe('2026-06-02T08:00:00Z');
      expect(parsed.headline).toBe(digest.headline);
      expect(Array.isArray(parsed.warnings)).toBe(true);
      expect(parsed.wiring.orphanModules).toBe(digest.wiring.orphanModules);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
