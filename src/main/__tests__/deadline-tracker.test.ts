import { describe, it, expect } from 'vitest';
import {
  Deadline,
  DeadlineExceeded,
  withDeadline,
  withDeadlineAsync,
} from '../deadline-tracker';

// Manual clock for deterministic tests
function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    set: (ms: number) => { t = ms; },
  };
}

describe('deadline-tracker', () => {
  describe('Deadline construction', () => {
    it('rejects non-positive budgets', () => {
      expect(() => new Deadline({ id: 'x', budget_ms: 0 })).toThrow(/budget_ms/);
      expect(() => new Deadline({ id: 'x', budget_ms: -1 })).toThrow(/budget_ms/);
    });
    it('rejects empty ids', () => {
      expect(() => new Deadline({ id: '', budget_ms: 1000 })).toThrow(/id/);
    });
    it('records start_ms and end_ms from clock', () => {
      const clk = makeClock(5_000);
      const d = new Deadline({ id: 'x', budget_ms: 1000, now: clk.now });
      expect(d.start_ms).toBe(5_000);
      expect(d.end_ms).toBe(6_000);
      expect(d.budget_ms).toBe(1000);
    });
  });

  describe('elapsed/remaining', () => {
    it('elapsed grows with clock', () => {
      const clk = makeClock();
      const d = new Deadline({ id: 'x', budget_ms: 1000, now: clk.now });
      expect(d.elapsed()).toBe(0);
      clk.advance(250);
      expect(d.elapsed()).toBe(250);
      clk.advance(750);
      expect(d.elapsed()).toBe(1000);
    });
    it('remaining shrinks with clock and clamps at 0', () => {
      const clk = makeClock();
      const d = new Deadline({ id: 'x', budget_ms: 1000, now: clk.now });
      expect(d.remaining()).toBe(1000);
      clk.advance(400);
      expect(d.remaining()).toBe(600);
      clk.advance(600);
      expect(d.remaining()).toBe(0);
      clk.advance(5000); // way past
      expect(d.remaining()).toBe(0); // still clamped
    });
    it('expired() flips at end_ms', () => {
      const clk = makeClock();
      const d = new Deadline({ id: 'x', budget_ms: 1000, now: clk.now });
      expect(d.expired()).toBe(false);
      clk.advance(999);
      expect(d.expired()).toBe(false);
      clk.advance(1);
      expect(d.expired()).toBe(true);
    });
  });

  describe('grace period', () => {
    it('expiredHard waits for grace_ms after end_ms', () => {
      const clk = makeClock();
      const d = new Deadline({ id: 'x', budget_ms: 1000, grace_ms: 500, now: clk.now });
      clk.advance(1000); // hit end
      expect(d.expired()).toBe(true);
      expect(d.expiredHard()).toBe(false); // grace still
      clk.advance(499);
      expect(d.expiredHard()).toBe(false);
      clk.advance(1);
      expect(d.expiredHard()).toBe(true);
    });
  });

  describe('usedFraction', () => {
    it('reports 0 at start, 1 at end, > 1 past', () => {
      const clk = makeClock();
      const d = new Deadline({ id: 'x', budget_ms: 1000, now: clk.now });
      expect(d.usedFraction()).toBe(0);
      clk.advance(500);
      expect(d.usedFraction()).toBe(0.5);
      clk.advance(500);
      expect(d.usedFraction()).toBe(1.0);
      clk.advance(500);
      expect(d.usedFraction()).toBe(1.5);
    });
  });

  describe('checkpoint', () => {
    it('records milestones with elapsed and remaining at the moment of the check', () => {
      const clk = makeClock();
      const d = new Deadline({ id: 'x', budget_ms: 1000, now: clk.now });
      clk.advance(300);
      const cp = d.checkpoint('section_one_done', { rows: 42 });
      expect(cp.elapsed_ms).toBe(300);
      expect(cp.remaining_ms).toBe(700);
      expect(cp.metadata).toEqual({ rows: 42 });
      const log = d.getCheckpoints();
      expect(log).toHaveLength(1);
      expect(log[0].name).toBe('section_one_done');
    });
  });

  describe('enforce', () => {
    it('passes when within budget and records a check', () => {
      const clk = makeClock();
      const d = new Deadline({ id: 'x', budget_ms: 1000, now: clk.now });
      clk.advance(500);
      expect(() => d.enforce('mid')).not.toThrow();
      const log = d.getCheckpoints();
      expect(log).toHaveLength(1);
      expect(log[0].name).toBe('mid:check');
      expect(log[0].metadata).toEqual({ passed: true });
    });
    it('throws DeadlineExceeded when expired and grace exhausted', () => {
      const clk = makeClock();
      const d = new Deadline({ id: 'briefing-run', budget_ms: 1000, now: clk.now });
      clk.advance(1500);
      expect(() => d.enforce('after_section_two')).toThrowError(DeadlineExceeded);
    });
    it('honors grace by default', () => {
      const clk = makeClock();
      const d = new Deadline({ id: 'briefing-run', budget_ms: 1000, grace_ms: 500, now: clk.now });
      clk.advance(1200); // past end, inside grace
      expect(() => d.enforce('cleanup')).not.toThrow();
      clk.advance(500); // out of grace too
      expect(() => d.enforce('cleanup_too_late')).toThrow();
    });
    it('skips grace when allowGrace=false', () => {
      const clk = makeClock();
      const d = new Deadline({ id: 'briefing-run', budget_ms: 1000, grace_ms: 500, now: clk.now });
      clk.advance(1100);
      expect(() => d.enforce('hard_cutoff', false)).toThrowError(DeadlineExceeded);
    });
    it('DeadlineExceeded ExampleCos id, stage, elapsed, budget, checkpoints', () => {
      const clk = makeClock();
      const d = new Deadline({ id: 'nightly', budget_ms: 1000, now: clk.now });
      clk.advance(300);
      d.checkpoint('research_done');
      clk.advance(1000);
      try {
        d.enforce('commits');
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(DeadlineExceeded);
        const de = e as DeadlineExceeded;
        expect(de.deadlineId).toBe('nightly');
        expect(de.stage).toBe('commits');
        expect(de.budget_ms).toBe(1000);
        expect(de.elapsed_ms).toBeGreaterThanOrEqual(1300);
        expect(de.checkpoints.length).toBeGreaterThanOrEqual(2); // research_done + commits:expired
      }
    });
  });

  describe('hasBudget', () => {
    it('returns true when remaining >= min_ms', () => {
      const clk = makeClock();
      const d = new Deadline({ id: 'x', budget_ms: 1000, now: clk.now });
      expect(d.hasBudget(500)).toBe(true);
      expect(d.hasBudget(1000)).toBe(true);
      expect(d.hasBudget(1001)).toBe(false);
      clk.advance(600);
      expect(d.hasBudget(400)).toBe(true);
      expect(d.hasBudget(401)).toBe(false);
    });
  });

  describe('withChildBudget', () => {
    it('returns a child deadline shorter than the parent', () => {
      const clk = makeClock();
      const parent = new Deadline({ id: 'parent', budget_ms: 1000, now: clk.now });
      clk.advance(200);
      const child = parent.withChildBudget('child', 300);
      expect(child.budget_ms).toBe(300);
      expect(child.id).toBe('child');
      // child end is now + 300 = 1_000_200 + 300 = 1_000_500
      expect(child.end_ms - child.start_ms).toBe(300);
    });
    it('child can NEVER extend parent (capped at parent.remaining)', () => {
      const clk = makeClock();
      const parent = new Deadline({ id: 'parent', budget_ms: 1000, now: clk.now });
      clk.advance(800); // 200 left on parent
      const child = parent.withChildBudget('child', 999_999);
      expect(child.budget_ms).toBe(200);
    });
    it('throws DeadlineExceeded when parent already expired', () => {
      const clk = makeClock();
      const parent = new Deadline({ id: 'parent', budget_ms: 1000, now: clk.now });
      clk.advance(1500);
      expect(() => parent.withChildBudget('child', 100)).toThrowError(DeadlineExceeded);
    });
  });

  describe('race', () => {
    it('returns fn value when fn resolves before deadline', async () => {
      const d = new Deadline({ id: 'x', budget_ms: 1000 });
      const v = await d.race('quick', async () => 'done');
      expect(v).toBe('done');
    });
    it('rejects with DeadlineExceeded when fn outlasts deadline', async () => {
      const d = new Deadline({ id: 'x', budget_ms: 50 });
      await expect(d.race('slow', () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 200))))
        .rejects.toBeInstanceOf(DeadlineExceeded);
    });
    it('rejects immediately when deadline already expired', async () => {
      const clk = makeClock();
      const d = new Deadline({ id: 'x', budget_ms: 50, now: clk.now });
      clk.advance(100); // already expired
      await expect(d.race('after', async () => 'never')).rejects.toBeInstanceOf(DeadlineExceeded);
    });
    it('propagates errors from fn unchanged', async () => {
      const d = new Deadline({ id: 'x', budget_ms: 1000 });
      await expect(d.race('err', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    });
  });

  describe('toJSON', () => {
    it('returns a snapshot suitable for logging', () => {
      const clk = makeClock();
      const d = new Deadline({ id: 'briefing-run', budget_ms: 1000, now: clk.now });
      clk.advance(300);
      d.checkpoint('section_one');
      const snap = d.toJSON();
      expect(snap.id).toBe('briefing-run');
      expect(snap.budget_ms).toBe(1000);
      expect(snap.elapsed_ms).toBe(300);
      expect(snap.remaining_ms).toBe(700);
      expect(snap.expired).toBe(false);
      expect(snap.checkpoints).toHaveLength(1);
    });
  });

  describe('factory helpers', () => {
    it('withDeadline creates an instance', () => {
      const d = withDeadline('x', 100);
      expect(d).toBeInstanceOf(Deadline);
      expect(d.id).toBe('x');
      expect(d.budget_ms).toBe(100);
    });
    it('withDeadlineAsync runs fn and returns its value', async () => {
      const v = await withDeadlineAsync('x', 1000, async (d) => {
        expect(d).toBeInstanceOf(Deadline);
        return 'ok';
      });
      expect(v).toBe('ok');
    });
    it('withDeadlineAsync rejects when fn outlasts budget', async () => {
      await expect(withDeadlineAsync('x', 30, () => new Promise((r) => setTimeout(r, 200))))
        .rejects.toBeInstanceOf(DeadlineExceeded);
    });
  });
});
