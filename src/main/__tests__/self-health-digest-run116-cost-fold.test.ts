/**
 * Tests for the nightly run 116 wiring: self-health-digest now folds in the
 * previously-orphaned tool-cost-ledger so the Claude-Max-only rule is enforced
 * at runtime, not just in tool-cost-ledger's own unit tests.
 *
 * Research grounding (AgentOps / CrewAI 2026): production agent stacks treat
 * per-call LLM cost tracking and leak detection as a first-class observability
 * tier. SecondBrain already had the ledger module (recordToolCall / readLedger /
 * getDailyTotals) but nothing read it inside the boot-time self-audit, so a paid
 * provider slipping into a production path would never surface. This fold closes
 * that gap: any record outside CLAUDE_MAX_ONLY_ALLOWLIST is a hard warning.
 *
 * These tests lock the fold so the ledger cannot be re-orphaned and prove the
 * input stays optional (boot-safe / backward compatible).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildSelfHealthDigest } from '../self-health-digest';
import { ToolCostRecord } from '../tool-cost-ledger';

let srcDir: string;
let workDir: string;

beforeAll(() => {
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh116-src-'));
  fs.writeFileSync(path.join(srcDir, 'index.ts'), "import './wired';\nexport const x = 1;\n");
  fs.writeFileSync(path.join(srcDir, 'wired.ts'), 'export const y = 2;\n');
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh116-work-'));
});

afterAll(() => {
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

const baseInputs = () => ({ srcDir, indexContent: '# tiny index\n' });

function writeLedger(name: string, records: ToolCostRecord[]): string {
  const p = path.join(workDir, name);
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function rec(over: Partial<ToolCostRecord>): ToolCostRecord {
  return {
    timestamp: '2026-06-07T10:00:00.000Z',
    surface: 'nightly',
    provider: 'claude-max',
    est_cost_usd: 0,
    wall_ms: 100,
    minute_bucket: '2026-06-07-10-00',
    ...over,
  };
}

describe('run-116 cost fold: optional + backward compatible', () => {
  it('leaves cost null when no ledger path is supplied', () => {
    const digest = buildSelfHealthDigest(baseInputs());
    expect(digest.cost).toBeNull();
    expect(digest.costLine).toBeNull();
    // No regression on the existing shape.
    expect(digest.wiring).toBeDefined();
    expect(digest.retryPressure).toBeNull();
  });

  it('stays null + silent when the ledger file is missing', () => {
    const digest = buildSelfHealthDigest({
      ...baseInputs(),
      toolCostLedgerPath: path.join(workDir, 'nope.jsonl'),
    });
    expect(digest.cost).toBeNull();
    expect(digest.costLine).toBeNull();
  });
});

describe('run-116 cost fold: Claude-Max-only leak detection', () => {
  it('flags a paid-provider record as a hard leak warning', () => {
    const p = writeLedger('leak.jsonl', [
      rec({ provider: 'claude-max', est_cost_usd: 0 }),
      rec({ provider: 'openai', est_cost_usd: 0.42, surface: 'chat' }),
    ]);
    const digest = buildSelfHealthDigest({
      ...baseInputs(),
      toolCostLedgerPath: p,
      todayUtc: '2026-06-07',
    });
    expect(digest.cost).not.toBeNull();
    expect(digest.cost!.leaks.length).toBe(1);
    const leakWarn = digest.warnings.find((w) => w.includes('CLAUDE-MAX-ONLY LEAK'));
    expect(leakWarn).toBeTruthy();
    expect(leakWarn).toContain('openai');
    expect(digest.headline).toContain('LEAK');
  });

  it('does NOT flag allowlisted metered providers (vapi, twilio)', () => {
    const p = writeLedger('allowed.jsonl', [
      rec({ provider: 'vapi', est_cost_usd: 0.1, surface: 'vapi-call' }),
      rec({ provider: 'twilio', est_cost_usd: 0.01, surface: 'sms' }),
      rec({ provider: 'claude-max' }),
    ]);
    const digest = buildSelfHealthDigest({
      ...baseInputs(),
      toolCostLedgerPath: p,
      todayUtc: '2026-06-07',
    });
    expect(digest.cost!.leaks.length).toBe(0);
    expect(digest.warnings.some((w) => w.includes('LEAK'))).toBe(false);
  });

  it('warns when daily spend exceeds the budget threshold', () => {
    const p = writeLedger('spend.jsonl', [
      rec({ provider: 'vapi', est_cost_usd: 2.5, surface: 'vapi-call' }),
    ]);
    const digest = buildSelfHealthDigest(
      { ...baseInputs(), toolCostLedgerPath: p, todayUtc: '2026-06-07' },
      { maxDailyCostUsd: 1.0 },
    );
    expect(digest.warnings.some((w) => w.includes('daily budget'))).toBe(true);
  });

  it('scopes totals to the requested UTC date only', () => {
    const p = writeLedger('dated.jsonl', [
      rec({ timestamp: '2026-06-07T01:00:00.000Z', est_cost_usd: 0 }),
      rec({ timestamp: '2026-06-06T01:00:00.000Z', est_cost_usd: 0 }),
    ]);
    const digest = buildSelfHealthDigest({
      ...baseInputs(),
      toolCostLedgerPath: p,
      todayUtc: '2026-06-07',
    });
    expect(digest.cost!.total_calls).toBe(1);
    expect(digest.cost!.date).toBe('2026-06-07');
  });
});
