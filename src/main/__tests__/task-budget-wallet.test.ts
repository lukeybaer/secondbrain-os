import { describe, it, expect, vi } from 'vitest';
import {
  TaskBudgetWallet,
  BudgetExhaustedError,
  withBudget,
} from '../task-budget-wallet';

function makeClock(start = 1000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('TaskBudgetWallet: construction', () => {
  it('rejects empty task_id', () => {
    expect(() => new TaskBudgetWallet('', { tokens: 100 })).toThrow();
  });

  it('rejects negative or non-finite caps', () => {
    expect(() => new TaskBudgetWallet('t', { tokens: -1 })).toThrow();
    expect(() => new TaskBudgetWallet('t', { cost_usd: Number.NaN })).toThrow();
    expect(() => new TaskBudgetWallet('t', { wall_ms: Number.POSITIVE_INFINITY })).toThrow();
  });

  it('opens with zero usage and full remaining', () => {
    const w = new TaskBudgetWallet('t', { tokens: 100, cost_usd: 0.5 });
    expect(w.usage.tokens).toBe(0);
    expect(w.snapshot().remaining.tokens).toBe(100);
    expect(w.snapshot().remaining.cost_usd).toBeCloseTo(0.5);
    // Missing cap => Infinity remaining (no limit).
    expect(w.snapshot().remaining.wall_ms).toBe(Infinity);
  });
});

describe('TaskBudgetWallet: deduct', () => {
  it('records successful deductions and updates usage', () => {
    const w = new TaskBudgetWallet('t', { tokens: 1000 });
    w.deduct({ tokens: 300 }, 'llm:haiku');
    w.deduct({ tokens: 200 }, 'llm:haiku');
    expect(w.usage.tokens).toBe(500);
    expect(w.snapshot().history.length).toBe(2);
    expect(w.snapshot().history[0].reason).toBe('llm:haiku');
  });

  it('throws BudgetExhaustedError when a cap is exceeded', () => {
    const w = new TaskBudgetWallet('t', { tokens: 100 });
    w.deduct({ tokens: 60 }, 'first');
    expect(() => w.deduct({ tokens: 50 }, 'second')).toThrow(BudgetExhaustedError);
    expect(w.exhausted).toBe(true);
    expect(w.exhausted_by).toBe('tokens');
  });

  it('does not mutate usage when refusing an oversize deduction', () => {
    const w = new TaskBudgetWallet('t', { tokens: 100 });
    w.deduct({ tokens: 60 }, 'first');
    try {
      w.deduct({ tokens: 50 }, 'oversize');
    } catch {
      /* expected */
    }
    // Usage stayed at 60; we refused the oversize spend.
    expect(w.usage.tokens).toBe(60);
    // But history shows the refusal for post-mortem.
    const refusals = w.snapshot().history.filter((h) => h.reason.startsWith('refused:'));
    expect(refusals.length).toBe(1);
  });

  it('every deduct after exhaustion also throws', () => {
    const w = new TaskBudgetWallet('t', { tokens: 100 });
    w.deduct({ tokens: 100 }, 'fill');
    expect(() => w.deduct({ tokens: 1 }, 'after')).toThrow(BudgetExhaustedError);
    expect(() => w.deduct({ tokens: 1 }, 'again')).toThrow(BudgetExhaustedError);
  });

  it('canSpend returns false without throwing', () => {
    const w = new TaskBudgetWallet('t', { tokens: 100 });
    w.deduct({ tokens: 80 }, 'a');
    expect(w.canSpend({ tokens: 21 })).toBe(false);
    expect(w.canSpend({ tokens: 19 })).toBe(true);
    // canSpend never throws or mutates.
    expect(w.exhausted).toBe(false);
    expect(w.usage.tokens).toBe(80);
  });
});

describe('TaskBudgetWallet: soft warning', () => {
  it('fires on_warn exactly once per resource when crossing the threshold', () => {
    const on_warn = vi.fn();
    const w = new TaskBudgetWallet('t', { tokens: 100 }, { warn_at: 0.5, on_warn });
    w.deduct({ tokens: 40 }, 'a');
    expect(on_warn).not.toHaveBeenCalled();
    w.deduct({ tokens: 20 }, 'b'); // crosses 60% (>50%)
    expect(on_warn).toHaveBeenCalledTimes(1);
    expect(on_warn.mock.calls[0][0]).toBe('tokens');
    w.deduct({ tokens: 10 }, 'c'); // 70% still above threshold
    expect(on_warn).toHaveBeenCalledTimes(1); // only fires ONCE
  });

  it('hook failures do not break the deduct path', () => {
    const w = new TaskBudgetWallet(
      't',
      { tokens: 100 },
      {
        warn_at: 0.5,
        on_warn: () => {
          throw new Error('hook went boom');
        },
      }
    );
    expect(() => w.deduct({ tokens: 60 }, 'a')).not.toThrow();
    expect(w.usage.tokens).toBe(60);
  });
});

describe('TaskBudgetWallet: wall-clock', () => {
  it('charges elapsed wall_ms via injected clock', () => {
    const clk = makeClock(0);
    const w = new TaskBudgetWallet('t', { wall_ms: 1000 }, { now: clk.now });
    clk.advance(400);
    w.touchWallClock();
    expect(w.usage.wall_ms).toBe(400);
    clk.advance(300);
    w.touchWallClock();
    expect(w.usage.wall_ms).toBe(700);
  });

  it('exhausts when wall_ms cap is exceeded', () => {
    const clk = makeClock(0);
    const w = new TaskBudgetWallet('t', { wall_ms: 500 }, { now: clk.now });
    clk.advance(600);
    expect(() => w.touchWallClock()).toThrow(BudgetExhaustedError);
    expect(w.exhausted_by).toBe('wall_ms');
  });

  it('touchWallClock is a no-op when no time has passed', () => {
    const clk = makeClock(1000);
    const w = new TaskBudgetWallet('t', { wall_ms: 100 }, { now: clk.now });
    w.touchWallClock();
    w.touchWallClock();
    expect(w.usage.wall_ms).toBe(0);
  });
});

describe('TaskBudgetWallet: spawn / child wallets', () => {
  it('child cap is clamped to the parent remaining', () => {
    const parent = new TaskBudgetWallet('p', { tokens: 100 });
    parent.deduct({ tokens: 30 }, 'a');
    const child = parent.spawn('c', { tokens: 200 });
    // Child requested 200, but parent only has 70 remaining.
    expect(child.snapshot().caps.tokens).toBe(70);
  });

  it('child deductions also charge the parent', () => {
    const parent = new TaskBudgetWallet('p', { tokens: 100 });
    const child = parent.spawn('c', { tokens: 50 });
    child.deduct({ tokens: 40 }, 'in_child');
    expect(child.usage.tokens).toBe(40);
    expect(parent.usage.tokens).toBe(40);
  });

  it('parent exhaustion propagates to child', () => {
    const parent = new TaskBudgetWallet('p', { tokens: 100 });
    const child = parent.spawn('c', { tokens: 100 });
    // Drain via the parent directly.
    parent.deduct({ tokens: 95 }, 'parent_burn');
    // Child only has effective 5 left.
    expect(() => child.deduct({ tokens: 10 }, 'child_overrun')).toThrow(
      BudgetExhaustedError
    );
  });

  it('cannot spawn from an exhausted parent', () => {
    const parent = new TaskBudgetWallet('p', { tokens: 100 });
    parent.deduct({ tokens: 100 }, 'fill');
    // Push the parent past its cap to actually mark it exhausted.
    try {
      parent.deduct({ tokens: 1 }, 'overflow');
    } catch {
      /* expected */
    }
    expect(parent.exhausted).toBe(true);
    expect(() => parent.spawn('c', { tokens: 1 })).toThrow(BudgetExhaustedError);
  });
});

describe('TaskBudgetWallet: withBudget wrapper', () => {
  it('runs the wrapped function and deducts the estimate', async () => {
    const w = new TaskBudgetWallet('t', { tokens: 100 });
    const fn = vi.fn(async (n: number) => n * 2);
    const wrapped = withBudget(w, { tokens: 30 }, 'tool:double', fn);
    const out = await wrapped(7);
    expect(out).toBe(14);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(w.usage.tokens).toBe(30);
  });

  it('does not invoke the wrapped fn when budget is exhausted', async () => {
    const w = new TaskBudgetWallet('t', { tokens: 10 });
    const fn = vi.fn(async () => 'ran');
    const wrapped = withBudget(w, { tokens: 20 }, 'tool:big', fn);
    await expect(wrapped()).rejects.toThrow(BudgetExhaustedError);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('TaskBudgetWallet: snapshot', () => {
  it('returns defensive copies; mutating snapshot does not affect wallet', () => {
    const w = new TaskBudgetWallet('t', { tokens: 100 });
    w.deduct({ tokens: 25 }, 'a');
    const snap = w.snapshot();
    snap.usage.tokens = 999;
    snap.history.push({ at_ms: 0, reason: 'hack', delta: {} });
    expect(w.usage.tokens).toBe(25);
    expect(w.snapshot().history.length).toBe(1);
  });

  it('renders pct_used and NaN for unset caps', () => {
    const w = new TaskBudgetWallet('t', { tokens: 100 });
    w.deduct({ tokens: 25, cost_usd: 0.01 }, 'a');
    const snap = w.snapshot();
    expect(snap.pct_used.tokens).toBeCloseTo(0.25);
    expect(Number.isNaN(snap.pct_used.cost_usd)).toBe(true);
  });
});

describe('TaskBudgetWallet: retries resource', () => {
  it('counts retries independently of tokens', () => {
    const w = new TaskBudgetWallet('t', { retries: 3 });
    w.deduct({ retries: 1 }, 'retry-1');
    w.deduct({ retries: 1 }, 'retry-2');
    w.deduct({ retries: 1 }, 'retry-3');
    expect(() => w.deduct({ retries: 1 }, 'retry-4')).toThrow(BudgetExhaustedError);
    expect(w.exhausted_by).toBe('retries');
  });
});
