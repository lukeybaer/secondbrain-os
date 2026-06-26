import { describe, it, expect } from 'vitest';
import {
  packTools,
  itemsFromCandidates,
  estimateTokenCost,
  estimateDollarCost,
  type PackItem,
} from '../tool-budget-packer';
import type { RouteCandidate, ToolDescriptor } from '../tool-router';

function item(p: Partial<PackItem> & Pick<PackItem, 'name' | 'score' | 'tokenCost'>): PackItem {
  return { dollarCost: 0, mustInclude: false, ...p };
}

describe('packTools - value-density packing within a token budget', () => {
  it('keeps the highest score-per-token tools and drops the overflow with a reason', () => {
    const items = [
      item({ name: 'a', score: 0.9, tokenCost: 100 }), // density 0.009
      item({ name: 'b', score: 0.8, tokenCost: 50 }),  // density 0.016 (best)
      item({ name: 'c', score: 0.3, tokenCost: 100 }), // density 0.003
    ];
    const r = packTools(items, { tokenBudget: 160 });
    const names = r.selected.map((s) => s.name);
    expect(names).toContain('b'); // best density slots first
    expect(names).toContain('a');
    expect(names).not.toContain('c'); // does not fit -> dropped
    expect(r.dropped.find((d) => d.item.name === 'c')!.reason).toBe('token-budget');
    expect(r.tokensUsed).toBe(150);
    expect(r.utilization).toBeCloseTo(150 / 160, 5);
  });

  it('continues scanning after a non-fitting item so a smaller one can still slot in', () => {
    const items = [
      item({ name: 'big', score: 1.0, tokenCost: 90 }),
      item({ name: 'small', score: 0.5, tokenCost: 10 }),
    ];
    // Budget 95: 'big' (density 0.011) is taken first, then 'small' fits in the
    // remaining 5? No - 10 > 5, so small is dropped. Use budget 100 to fit both.
    const r = packTools(items, { tokenBudget: 100 });
    expect(r.selected.map((s) => s.name).sort()).toEqual(['big', 'small']);
  });
});

describe('packTools - must-include is unconditional', () => {
  it('keeps a must-include tool even when it does not fit, and flags overflow', () => {
    const items = [
      item({ name: 'huge', score: 0.1, tokenCost: 500, mustInclude: true }),
      item({ name: 'b', score: 0.9, tokenCost: 50 }),
    ];
    const r = packTools(items, { tokenBudget: 100 });
    expect(r.selected.map((s) => s.name)).toContain('huge');
    expect(r.overflowFromMustInclude).toBe(true);
    // The remaining budget is already blown, so 'b' cannot be added.
    expect(r.dropped.find((d) => d.item.name === 'b')!.reason).toBe('token-budget');
  });
});

describe('packTools - dollar budget is a second binding constraint', () => {
  it('drops a tool that fits tokens but blows the cost budget', () => {
    const items = [
      item({ name: 'cheap', score: 0.5, tokenCost: 10, dollarCost: 0.001 }),
      item({ name: 'pricey', score: 0.9, tokenCost: 10, dollarCost: 0.05 }),
    ];
    const r = packTools(items, { tokenBudget: 1000, costBudget: 0.01 });
    // 'pricey' has higher density but its dollar cost exceeds the budget.
    expect(r.selected.map((s) => s.name)).toContain('cheap');
    const droppedPricey = r.dropped.find((d) => d.item.name === 'pricey');
    expect(droppedPricey!.reason).toBe('cost-budget');
  });
});

describe('packTools - zero-value tools are noise', () => {
  it('drops tools with score <= 0 even when budget remains', () => {
    const items = [
      item({ name: 'good', score: 0.7, tokenCost: 10 }),
      item({ name: 'noise', score: 0, tokenCost: 5 }),
    ];
    const r = packTools(items, { tokenBudget: 1000 });
    expect(r.selected.map((s) => s.name)).toEqual(['good']);
    expect(r.dropped.find((d) => d.item.name === 'noise')!.reason).toBe('zero-or-negative-value');
  });
});

describe('cost estimation + candidate adapter', () => {
  function tool(p: Partial<ToolDescriptor> & Pick<ToolDescriptor, 'name' | 'description'>): ToolDescriptor {
    return p;
  }

  it('estimates token cost from name + description + tags with framing overhead', () => {
    const t = tool({ name: 'x', description: 'a'.repeat(40), tags: ['b'.repeat(8)] });
    // (1 + 40 + 8 + 2 separators) / 4 rounded up + 12 framing
    expect(estimateTokenCost(t)).toBeGreaterThan(12);
  });

  it('maps cost_class to dollar estimates with free defaulting to 0', () => {
    expect(estimateDollarCost(tool({ name: 'a', description: 'd' }))).toBe(0);
    expect(estimateDollarCost(tool({ name: 'a', description: 'd', cost_class: 'paid' }))).toBeGreaterThan(0);
  });

  it('builds pack items from route candidates and honors mustInclude names', () => {
    const candidates: RouteCandidate[] = [
      { tool: tool({ name: 'gmail-send', description: 'send mail' }), score: 0.8, matched_terms: ['mail'] },
      { tool: tool({ name: 'vapi-call', description: 'place a call' }), score: 0.6, matched_terms: ['call'] },
    ];
    const items = itemsFromCandidates(candidates, { mustInclude: ['vapi-call'] });
    expect(items.find((i) => i.name === 'vapi-call')!.mustInclude).toBe(true);
    expect(items.find((i) => i.name === 'gmail-send')!.mustInclude).toBe(false);
    expect(items.every((i) => i.tokenCost > 0)).toBe(true);
  });
});
