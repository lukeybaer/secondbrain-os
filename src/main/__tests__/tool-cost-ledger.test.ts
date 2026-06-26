import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  recordToolCall,
  estimateCostUsd,
  minuteBucket,
  assertClaudeMaxOnly,
  ClaudeMaxOnlyViolation,
  meterCall,
  readLedger,
  getDailyTotals,
  getMinuteBucket,
  makeFileWriter,
  ToolCostRecord,
  CLAUDE_MAX_ONLY_ALLOWLIST,
} from '../tool-cost-ledger';

describe('tool-cost-ledger', () => {
  it('estimates cost from per-1M-token pricing', () => {
    expect(estimateCostUsd('gpt-4o', 1_000_000, 0)).toBe(2.5);
    expect(estimateCostUsd('gpt-4o', 0, 1_000_000)).toBe(10);
    expect(estimateCostUsd('gpt-4o-mini', 500_000, 500_000)).toBeCloseTo(0.15 / 2 + 0.6 / 2, 6);
  });

  it('returns zero for ExampleCo models so ExampleCo pricing never blocks recording', () => {
    expect(estimateCostUsd('definitely-not-a-real-model', 100, 100)).toBe(0);
    expect(estimateCostUsd(undefined, 100, 100)).toBe(0);
  });

  it('produces a stable minute bucket key', () => {
    const fixed = new Date('2026-05-01T03:14:59.123Z');
    expect(minuteBucket(fixed)).toBe('2026-05-01-03-14');
  });

  it('records a successful call with cost and bucket', () => {
    const records: ToolCostRecord[] = [];
    const writer = (r: ToolCostRecord) => records.push(r);
    const out = recordToolCall(
      {
        surface: 'briefing',
        provider: 'claude-max',
        model: 'claude-opus-4-7',
        input_tokens: 1000,
        output_tokens: 500,
        wall_ms: 120,
      },
      writer,
    );
    expect(records).toHaveLength(1);
    expect(records[0].provider).toBe('claude-max');
    expect(records[0].surface).toBe('briefing');
    expect(records[0].est_cost_usd).toBeGreaterThan(0);
    expect(out.minute_bucket).toMatch(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/);
  });

  it('does not throw outside production for any provider', () => {
    const r: ToolCostRecord = {
      timestamp: '2026-05-01T00:00:00Z',
      surface: 's',
      provider: 'openai',
      est_cost_usd: 0,
      wall_ms: 0,
      minute_bucket: '2026-05-01-00-00',
    };
    expect(() => assertClaudeMaxOnly(r, { nodeEnv: 'development' })).not.toThrow();
    expect(() => assertClaudeMaxOnly(r, { nodeEnv: 'test' })).not.toThrow();
  });

  it('throws ClaudeMaxOnlyViolation in production for non-allowlisted provider', () => {
    const r: ToolCostRecord = {
      timestamp: '2026-05-01T00:00:00Z',
      surface: 'chat',
      provider: 'openai',
      model: 'gpt-4o',
      est_cost_usd: 0,
      wall_ms: 0,
      minute_bucket: '2026-05-01-00-00',
    };
    expect(() => assertClaudeMaxOnly(r, { nodeEnv: 'production' })).toThrow(ClaudeMaxOnlyViolation);
  });

  it('does not throw in production for any allowlisted provider', () => {
    for (const provider of CLAUDE_MAX_ONLY_ALLOWLIST) {
      const r: ToolCostRecord = {
        timestamp: '2026-05-01T00:00:00Z',
        surface: 's',
        provider,
        est_cost_usd: 0,
        wall_ms: 0,
        minute_bucket: '2026-05-01-00-00',
      };
      expect(() => assertClaudeMaxOnly(r, { nodeEnv: 'production' })).not.toThrow();
    }
  });

  it('alwaysThrow forces enforcement even outside production', () => {
    const r: ToolCostRecord = {
      timestamp: '2026-05-01T00:00:00Z',
      surface: 's',
      provider: 'groq',
      est_cost_usd: 0,
      wall_ms: 0,
      minute_bucket: '2026-05-01-00-00',
    };
    expect(() => assertClaudeMaxOnly(r, { nodeEnv: 'development', alwaysThrow: true })).toThrow(
      ClaudeMaxOnlyViolation,
    );
  });

  it('meterCall pre-checks Claude Max enforcement before running fn', async () => {
    const records: ToolCostRecord[] = [];
    let called = false;
    await expect(
      meterCall(
        {
          surface: 'chat',
          provider: 'openai',
          model: 'gpt-4o',
          enforceClaudeMax: true,
          nodeEnv: 'production',
          writer: (r) => records.push(r),
        },
        async () => {
          called = true;
          return { value: 'unreachable' };
        },
      ),
    ).rejects.toThrow(ClaudeMaxOnlyViolation);
    expect(called).toBe(false);
    expect(records).toHaveLength(0);
  });

  it('meterCall records wall_ms and tokens for an allowed provider', async () => {
    const records: ToolCostRecord[] = [];
    const out = await meterCall(
      {
        surface: 'briefing',
        provider: 'claude-max',
        model: 'claude-opus-4-7',
        enforceClaudeMax: true,
        nodeEnv: 'production',
        writer: (r) => records.push(r),
      },
      async () => {
        await new Promise((res) => setTimeout(res, 5));
        return { value: 42, input_tokens: 100, output_tokens: 50 };
      },
    );
    expect(out.result).toBe(42);
    expect(records).toHaveLength(1);
    expect(records[0].input_tokens).toBe(100);
    expect(records[0].output_tokens).toBe(50);
    expect(records[0].wall_ms).toBeGreaterThanOrEqual(0);
  });

  it('round-trips through a file writer and reader', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-ledger-'));
    const file = path.join(dir, 'ledger.jsonl');
    const writer = makeFileWriter(file);
    recordToolCall(
      { surface: 'a', provider: 'claude-max', model: 'claude-opus-4-7', input_tokens: 1, output_tokens: 1, wall_ms: 1 },
      writer,
    );
    recordToolCall(
      { surface: 'b', provider: 'openai', model: 'gpt-4o', input_tokens: 1000, output_tokens: 1000, wall_ms: 2 },
      writer,
    );
    const all = readLedger(file);
    expect(all).toHaveLength(2);
    expect(all[0].provider).toBe('claude-max');
    expect(all[1].provider).toBe('openai');
  });

  it('getDailyTotals aggregates by provider and surfaces leaks', () => {
    const today = '2026-05-01';
    const recs: ToolCostRecord[] = [
      {
        timestamp: `${today}T01:00:00Z`,
        surface: 'briefing',
        provider: 'claude-max',
        model: 'claude-opus-4-7',
        input_tokens: 1000,
        output_tokens: 500,
        est_cost_usd: estimateCostUsd('claude-opus-4-7', 1000, 500),
        wall_ms: 100,
        minute_bucket: `${today}-01-00`,
      },
      {
        timestamp: `${today}T02:30:00Z`,
        surface: 'chat',
        provider: 'openai',
        model: 'gpt-4o',
        input_tokens: 1_000_000,
        output_tokens: 0,
        est_cost_usd: estimateCostUsd('gpt-4o', 1_000_000, 0),
        wall_ms: 200,
        minute_bucket: `${today}-02-30`,
      },
      {
        timestamp: '2026-04-30T23:00:00Z',
        surface: 'old',
        provider: 'claude-max',
        est_cost_usd: 0,
        wall_ms: 1,
        minute_bucket: '2026-04-30-23-00',
      },
    ];
    const totals = getDailyTotals(recs, today);
    expect(totals.total_calls).toBe(2);
    expect(totals.by_provider['openai'].calls).toBe(1);
    expect(totals.by_provider['claude-max'].calls).toBe(1);
    expect(totals.leaks).toHaveLength(1);
    expect(totals.leaks[0].provider).toBe('openai');
    expect(totals.total_cost_usd).toBeCloseTo(2.5 + estimateCostUsd('claude-opus-4-7', 1000, 500), 6);
  });

  it('getMinuteBucket returns only records in that bucket', () => {
    const recs: ToolCostRecord[] = [
      { timestamp: 't', surface: 's', provider: 'claude-max', est_cost_usd: 0, wall_ms: 0, minute_bucket: '2026-05-01-03-14' },
      { timestamp: 't', surface: 's', provider: 'claude-max', est_cost_usd: 0, wall_ms: 0, minute_bucket: '2026-05-01-03-15' },
      { timestamp: 't', surface: 's', provider: 'openai', est_cost_usd: 0, wall_ms: 0, minute_bucket: '2026-05-01-03-14' },
    ];
    expect(getMinuteBucket(recs, '2026-05-01-03-14')).toHaveLength(2);
    expect(getMinuteBucket(recs, '2026-05-01-03-15')).toHaveLength(1);
    expect(getMinuteBucket(recs, 'never')).toHaveLength(0);
  });
});
