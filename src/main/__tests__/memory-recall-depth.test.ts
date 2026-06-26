import { describe, it, expect } from 'vitest';
import { planRecallDepth } from '../memory-recall-depth';

describe('memory-recall-depth', () => {
  it('plans shallow for a short exact-looking lookup', () => {
    const plan = planRecallDepth('visa category');
    expect(plan.depth).toBe('shallow');
    expect(plan.useFusion).toBe(false);
    expect(plan.useRerank).toBe(false);
    expect(plan.topK).toBe(3);
  });

  it('plans shallow for a pointed single-fact question', () => {
    const plan = planRecallDepth('what is the briefing time');
    expect(plan.depth).toBe('shallow');
    expect(plan.useRerank).toBe(false);
  });

  it('plans deep for a vague or comparative query even if short', () => {
    const plan = planRecallDepth('compare BAI vs ITM');
    expect(plan.depth).toBe('deep');
    expect(plan.useFusion).toBe(true);
    expect(plan.useRerank).toBe(true);
    expect(plan.topK).toBe(12);
  });

  it('plans deep for a long query regardless of wording', () => {
    const plan = planRecallDepth(
      'find the dentist in ExampleCo who agreed to skip the x rays before the cleaning appointment please',
    );
    expect(plan.depth).toBe('deep');
    expect(plan.reason).toContain('long query');
  });

  it('deep wins over a pointed lead when the query is also vague', () => {
    // Starts with a pointed lead but contains a vague marker -> deep, not shallow.
    const plan = planRecallDepth('what is the history of the acme deal');
    expect(plan.depth).toBe('deep');
  });

  it('plans standard for a mid-length specific query', () => {
    const plan = planRecallDepth('dentist appointment outcome for the second call');
    expect(plan.depth).toBe('standard');
    expect(plan.useFusion).toBe(true);
    expect(plan.useRerank).toBe(false);
    expect(plan.topK).toBe(5);
  });

  it('falls back to a safe standard plan for empty input', () => {
    const plan = planRecallDepth('   ');
    expect(plan.depth).toBe('standard');
    expect(plan.useFusion).toBe(true);
  });

  it('honors policy overrides for thresholds and topK', () => {
    const plan = planRecallDepth('alpha beta gamma', {
      longTokenThreshold: 3,
      deepTopK: 99,
    });
    expect(plan.depth).toBe('deep');
    expect(plan.topK).toBe(99);
  });

  it('never returns rerank without fusion (rerank implies the full path)', () => {
    for (const q of ['x', 'what is x', 'summarize everything about acme', 'a b c d e f g']) {
      const plan = planRecallDepth(q);
      if (plan.useRerank) expect(plan.useFusion).toBe(true);
    }
  });
});
