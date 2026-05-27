import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  aggregateWindow,
  evaluateBudget,
  wouldExceedBudget,
  TokenBudgetGovernor,
  readLedger,
  makeVerdictFileWriter,
  verdictToRecord,
  LedgerRecord,
  BudgetPolicy,
} from '../token-budget-governor';

function rec(over: Partial<LedgerRecord> = {}): LedgerRecord {
  return {
    timestamp: new Date().toISOString(),
    surface: 'briefing',
    provider: 'claude-max',
    model: 'claude-opus-4-7',
    input_tokens: 100,
    output_tokens: 50,
    est_cost_usd: 0.001,
    wall_ms: 200,
    minute_bucket: '2026-05-08-01-15',
    ...over,
  };
}

describe('token-budget-governor', () => {
  describe('aggregateWindow', () => {
    it('sums tokens and cost across in-window records', () => {
      const now = new Date('2026-05-08T01:30:00Z');
      const records = [
        rec({ timestamp: '2026-05-08T01:25:00Z', input_tokens: 1000, output_tokens: 500, est_cost_usd: 0.05 }),
        rec({ timestamp: '2026-05-08T01:28:00Z', input_tokens: 2000, output_tokens: 1000, est_cost_usd: 0.10 }),
      ];
      const policy: BudgetPolicy = { window_ms: 600_000 }; // 10 min
      const snap = aggregateWindow(records, policy, now);
      expect(snap.records_in_window).toBe(2);
      expect(snap.total_input_tokens).toBe(3000);
      expect(snap.total_output_tokens).toBe(1500);
      expect(snap.total_tokens).toBe(4500);
      expect(snap.total_cost_usd).toBeCloseTo(0.15, 5);
    });

    it('excludes records outside the window', () => {
      const now = new Date('2026-05-08T01:30:00Z');
      const records = [
        rec({ timestamp: '2026-05-08T01:00:00Z', input_tokens: 9999 }), // 30 min ago, outside 10-min window
        rec({ timestamp: '2026-05-08T01:25:00Z', input_tokens: 100 }),
      ];
      const policy: BudgetPolicy = { window_ms: 600_000 };
      const snap = aggregateWindow(records, policy, now);
      expect(snap.records_in_window).toBe(1);
      expect(snap.total_input_tokens).toBe(100);
    });

    it('honors surface_allowlist', () => {
      const now = new Date('2026-05-08T01:30:00Z');
      const records = [
        rec({ timestamp: '2026-05-08T01:25:00Z', surface: 'briefing', input_tokens: 100, output_tokens: 0 }),
        rec({ timestamp: '2026-05-08T01:25:00Z', surface: 'chat', input_tokens: 5000, output_tokens: 0 }),
        rec({ timestamp: '2026-05-08T01:25:00Z', surface: 'vapi-call', input_tokens: 200, output_tokens: 0 }),
      ];
      const policy: BudgetPolicy = { window_ms: 600_000, surface_allowlist: ['briefing', 'vapi-call'] };
      const snap = aggregateWindow(records, policy, now);
      expect(snap.records_in_window).toBe(2);
      expect(snap.total_input_tokens).toBe(300);
      expect(snap.by_surface.briefing.tokens).toBe(100);
      expect(snap.by_surface['vapi-call'].tokens).toBe(200);
      expect(snap.by_surface.chat).toBeUndefined();
    });

    it('honors provider_allowlist', () => {
      const now = new Date('2026-05-08T01:30:00Z');
      const records = [
        rec({ timestamp: '2026-05-08T01:25:00Z', provider: 'claude-max', input_tokens: 100 }),
        rec({ timestamp: '2026-05-08T01:25:00Z', provider: 'openai', input_tokens: 99999 }),
      ];
      const policy: BudgetPolicy = { window_ms: 600_000, provider_allowlist: ['claude-max'] };
      const snap = aggregateWindow(records, policy, now);
      expect(snap.records_in_window).toBe(1);
      expect(snap.total_input_tokens).toBe(100);
    });

    it('skips records with un-parseable timestamps', () => {
      const now = new Date('2026-05-08T01:30:00Z');
      const records = [
        rec({ timestamp: 'not-a-date', input_tokens: 9999 }),
        rec({ timestamp: '2026-05-08T01:25:00Z', input_tokens: 100 }),
      ];
      const snap = aggregateWindow(records, { window_ms: 600_000 }, now);
      expect(snap.records_in_window).toBe(1);
    });

    it('handles missing input/output tokens gracefully', () => {
      const now = new Date('2026-05-08T01:30:00Z');
      const records = [
        { ...rec({ timestamp: '2026-05-08T01:25:00Z' }), input_tokens: undefined, output_tokens: undefined },
      ];
      const snap = aggregateWindow(records, { window_ms: 600_000 }, now);
      expect(snap.total_tokens).toBe(0);
      expect(snap.records_in_window).toBe(1);
    });
  });

  describe('evaluateBudget', () => {
    const now = new Date('2026-05-08T01:30:00Z');
    const policy: BudgetPolicy = {
      window_ms: 3_600_000, // 1 hour
      warn_tokens: 100_000,
      max_tokens: 200_000,
      warn_usd: 1.0,
      max_usd: 5.0,
      compaction_threshold_fraction: 0.8,
    };

    it('returns ok when below all thresholds', () => {
      const records = [rec({ timestamp: '2026-05-08T01:25:00Z', input_tokens: 1000, output_tokens: 500, est_cost_usd: 0.01 })];
      const v = evaluateBudget(records, policy, now);
      expect(v.verdict).toBe('ok');
      expect(v.trigger).toBeUndefined();
    });

    it('emits compaction_due at 80% of warn_tokens (default)', () => {
      const records = [rec({ timestamp: '2026-05-08T01:25:00Z', input_tokens: 50_000, output_tokens: 35_000 })];
      // total = 85_000, compaction floor = 80_000 (80% of 100k)
      const v = evaluateBudget(records, policy, now);
      expect(v.verdict).toBe('compaction_due');
      expect(v.trigger).toBe('compaction');
    });

    it('emits warn at warn_tokens', () => {
      const records = [rec({ timestamp: '2026-05-08T01:25:00Z', input_tokens: 60_000, output_tokens: 50_000 })];
      const v = evaluateBudget(records, policy, now);
      expect(v.verdict).toBe('warn');
      expect(v.trigger).toBe('tokens_warn');
    });

    it('emits exceeded at max_tokens', () => {
      const records = [rec({ timestamp: '2026-05-08T01:25:00Z', input_tokens: 100_000, output_tokens: 100_000 })];
      const v = evaluateBudget(records, policy, now);
      expect(v.verdict).toBe('exceeded');
      expect(v.trigger).toBe('tokens_max');
    });

    it('emits exceeded on max_usd before max_tokens', () => {
      const records = [rec({ timestamp: '2026-05-08T01:25:00Z', input_tokens: 1, output_tokens: 1, est_cost_usd: 6.0 })];
      const v = evaluateBudget(records, policy, now);
      expect(v.verdict).toBe('exceeded');
      expect(v.trigger).toBe('usd_max');
    });

    it('emits warn on warn_usd', () => {
      const records = [rec({ timestamp: '2026-05-08T01:25:00Z', input_tokens: 1, output_tokens: 1, est_cost_usd: 1.5 })];
      const v = evaluateBudget(records, policy, now);
      expect(v.verdict).toBe('warn');
      expect(v.trigger).toBe('usd_warn');
    });

    it('respects custom compaction_threshold_fraction', () => {
      const tightPolicy: BudgetPolicy = { ...policy, compaction_threshold_fraction: 0.5 };
      const records = [rec({ timestamp: '2026-05-08T01:25:00Z', input_tokens: 30_000, output_tokens: 25_000 })];
      // total = 55_000, compaction floor at 50% = 50_000
      const v = evaluateBudget(records, tightPolicy, now);
      expect(v.verdict).toBe('compaction_due');
    });

    it('reason text is non-empty when verdict is non-ok', () => {
      const records = [rec({ timestamp: '2026-05-08T01:25:00Z', input_tokens: 100_000, output_tokens: 100_000 })];
      const v = evaluateBudget(records, policy, now);
      expect(v.reason.length).toBeGreaterThan(0);
    });

    it('hard cap (max_tokens) takes precedence over warn', () => {
      const records = [rec({ timestamp: '2026-05-08T01:25:00Z', input_tokens: 200_001, output_tokens: 0 })];
      const v = evaluateBudget(records, policy, now);
      expect(v.verdict).toBe('exceeded');
      expect(v.trigger).toBe('tokens_max');
    });
  });

  describe('wouldExceedBudget', () => {
    const now = new Date('2026-05-08T01:30:00Z');
    const policy: BudgetPolicy = {
      window_ms: 3_600_000,
      max_tokens: 200_000,
      max_usd: 5.0,
    };

    it('returns false when planned call fits under cap', () => {
      const records = [rec({ timestamp: '2026-05-08T01:25:00Z', input_tokens: 50_000, output_tokens: 25_000 })];
      const exceeded = wouldExceedBudget(records, policy, {
        estimated_input_tokens: 10_000,
        estimated_output_tokens: 5_000,
        estimated_cost_usd: 0.5,
      }, now);
      expect(exceeded).toBe(false);
    });

    it('returns true when planned call would push over max_tokens', () => {
      const records = [rec({ timestamp: '2026-05-08T01:25:00Z', input_tokens: 100_000, output_tokens: 50_000 })];
      const exceeded = wouldExceedBudget(records, policy, {
        estimated_input_tokens: 40_000,
        estimated_output_tokens: 20_000,
        estimated_cost_usd: 0.5,
      }, now);
      expect(exceeded).toBe(true);
    });

    it('returns true when planned call would push over max_usd', () => {
      const records = [rec({ timestamp: '2026-05-08T01:25:00Z', input_tokens: 1, output_tokens: 1, est_cost_usd: 4.5 })];
      const exceeded = wouldExceedBudget(records, policy, {
        estimated_input_tokens: 1,
        estimated_output_tokens: 1,
        estimated_cost_usd: 1.0,
      }, now);
      expect(exceeded).toBe(true);
    });
  });

  describe('readLedger', () => {
    it('returns empty array for missing file', () => {
      const records = readLedger(path.join(os.tmpdir(), `nonexistent-${Date.now()}.jsonl`));
      expect(records).toEqual([]);
    });

    it('parses valid JSONL and skips invalid lines', () => {
      const tmp = path.join(os.tmpdir(), `tbg-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jsonl`);
      fs.writeFileSync(tmp,
        JSON.stringify(rec({ input_tokens: 100 })) + '\n' +
        '\n' +
        'not-json\n' +
        JSON.stringify(rec({ input_tokens: 200 })) + '\n');
      try {
        const records = readLedger(tmp);
        expect(records).toHaveLength(2);
        expect(records[0].input_tokens).toBe(100);
        expect(records[1].input_tokens).toBe(200);
      } finally {
        fs.unlinkSync(tmp);
      }
    });
  });

  describe('TokenBudgetGovernor', () => {
    const policy: BudgetPolicy = {
      window_ms: 3_600_000,
      warn_tokens: 100_000,
      max_tokens: 200_000,
    };
    const now = new Date('2026-05-08T01:30:00Z');

    it('fires onVerdict only on transitions, not on every poll', () => {
      const fired: string[] = [];
      const gov = new TokenBudgetGovernor({ policy, onVerdict: (v) => fired.push(v.verdict) });

      // Two consecutive warn evaluations should fire ONCE
      const warnRecords = [rec({ timestamp: '2026-05-08T01:25:00Z', input_tokens: 60_000, output_tokens: 50_000 })];
      gov.evaluateNow(now, warnRecords);
      gov.evaluateNow(now, warnRecords);
      expect(fired).toEqual(['warn']);

      // Transition to exceeded should fire again
      const exceededRecords = [rec({ timestamp: '2026-05-08T01:25:00Z', input_tokens: 100_000, output_tokens: 100_000 })];
      gov.evaluateNow(now, exceededRecords);
      expect(fired).toEqual(['warn', 'exceeded']);

      // Transition back to ok then to warn should re-fire warn
      const okRecords: LedgerRecord[] = [];
      gov.evaluateNow(now, okRecords);
      gov.evaluateNow(now, warnRecords);
      expect(fired).toEqual(['warn', 'exceeded', 'warn']);
    });

    it('wouldExceedNow uses ledgerPath when no override provided', () => {
      const tmp = path.join(os.tmpdir(), `tbg-gov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jsonl`);
      fs.writeFileSync(tmp, JSON.stringify(rec({ timestamp: now.toISOString(), input_tokens: 150_000, output_tokens: 0 })) + '\n');
      try {
        const gov = new TokenBudgetGovernor({ policy, ledgerPath: tmp });
        const wouldFit = gov.wouldExceedNow({ estimated_input_tokens: 1, estimated_output_tokens: 1, estimated_cost_usd: 0 }, now);
        expect(wouldFit).toBe(false); // 150k + 2 < 200k
        const wouldNot = gov.wouldExceedNow({ estimated_input_tokens: 60_000, estimated_output_tokens: 0, estimated_cost_usd: 0 }, now);
        expect(wouldNot).toBe(true); // 150k + 60k > 200k
      } finally {
        fs.unlinkSync(tmp);
      }
    });
  });

  describe('verdictToRecord and makeVerdictFileWriter', () => {
    it('converts a verdict to a flat record', () => {
      const now = new Date('2026-05-08T01:30:00Z');
      const records = [rec({ timestamp: '2026-05-08T01:25:00Z', input_tokens: 60_000, output_tokens: 50_000 })];
      const verdict = evaluateBudget(records, { window_ms: 3_600_000, warn_tokens: 100_000 }, now);
      const flat = verdictToRecord(verdict);
      expect(flat.verdict).toBe('warn');
      expect(flat.total_tokens).toBe(110_000);
      expect(typeof flat.timestamp).toBe('string');
    });

    it('appends to JSONL file', () => {
      const tmp = path.join(os.tmpdir(), `tbg-writer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jsonl`);
      const writer = makeVerdictFileWriter(tmp);
      const now = new Date('2026-05-08T01:30:00Z');
      const records = [rec({ timestamp: '2026-05-08T01:25:00Z', input_tokens: 60_000, output_tokens: 50_000 })];
      const verdict = evaluateBudget(records, { window_ms: 3_600_000, warn_tokens: 100_000 }, now);
      writer(verdictToRecord(verdict));
      try {
        const text = fs.readFileSync(tmp, 'utf8');
        expect(text.trim().split('\n')).toHaveLength(1);
        const parsed = JSON.parse(text.trim());
        expect(parsed.verdict).toBe('warn');
      } finally {
        fs.unlinkSync(tmp);
      }
    });
  });
});
