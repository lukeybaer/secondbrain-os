import { describe, it, expect } from 'vitest';
import {
  auditIndexBudget,
  renderIndexBudgetHeadline,
} from '../memory-index-budget-audit';

describe('auditIndexBudget', () => {
  it('reports healthy when under budget with no long lines', () => {
    const audit = auditIndexBudget('- [A](a.md) hook\n- [B](b.md) hook\n', {
      budgetBytes: 1000,
      maxLineLength: 200,
    });
    expect(audit.overBudget).toBe(false);
    expect(audit.bytesOver).toBe(0);
    expect(audit.longLines).toHaveLength(0);
  });

  it('flags over-budget and computes bytesOver', () => {
    const content = 'x'.repeat(500);
    const audit = auditIndexBudget(content, { budgetBytes: 100, maxLineLength: 1000 });
    expect(audit.overBudget).toBe(true);
    expect(audit.bytesOver).toBe(400);
  });

  it('identifies lines exceeding the per-line char limit', () => {
    const content = ['short', 'x'.repeat(250), 'also short', 'y'.repeat(300)].join('\n');
    const audit = auditIndexBudget(content, { budgetBytes: 100000, maxLineLength: 200 });
    expect(audit.longLines).toHaveLength(2);
    expect(audit.longLines.map((l) => l.lineNumber)).toEqual([2, 4]);
    expect(audit.longLines[0].length).toBe(250);
  });

  it('orders worst offenders longest-first and respects worstCount', () => {
    const content = ['a'.repeat(210), 'b'.repeat(500), 'c'.repeat(300)].join('\n');
    const audit = auditIndexBudget(content, {
      budgetBytes: 100000,
      maxLineLength: 200,
      worstCount: 2,
    });
    expect(audit.worstOffenders).toHaveLength(2);
    expect(audit.worstOffenders.map((l) => l.length)).toEqual([500, 300]);
  });

  it('reports trimmingWouldSuffice when line trims reclaim enough bytes', () => {
    // One 1000-char line, budget small. Trimming to 200 reclaims 800 bytes.
    const content = 'z'.repeat(1000);
    const audit = auditIndexBudget(content, { budgetBytes: 300, maxLineLength: 200 });
    expect(audit.bytesOver).toBe(700);
    expect(audit.reclaimableByTrimming).toBe(800);
    expect(audit.trimmingWouldSuffice).toBe(true);
  });

  it('reports trimmingWouldSuffice false when trims are not enough', () => {
    // Budget so small that even trimming long lines to the limit leaves the
    // file over budget (the kept content still exceeds it).
    const content = ['z'.repeat(400), 'k'.repeat(190)].join('\n');
    const audit = auditIndexBudget(content, { budgetBytes: 150, maxLineLength: 200 });
    expect(audit.overBudget).toBe(true);
    expect(audit.trimmingWouldSuffice).toBe(false);
  });

  it('uses sane defaults matching the loader (24.4 KB, 200 chars)', () => {
    const audit = auditIndexBudget('hello\n');
    expect(audit.budgetBytes).toBe(Math.round(24.4 * 1024));
    expect(audit.maxLineLength).toBe(200);
    expect(audit.overBudget).toBe(false);
  });

  it('estimates reclaimable bytes for multibyte lines', () => {
    // 210 emoji (each 4 bytes utf8, 2 code units length-wise). length counts
    // UTF-16 code units, so verify reclaim is scaled by bytes-per-char.
    const line = '🎯'.repeat(210); // length 420 (2 per emoji), 840 bytes
    const audit = auditIndexBudget(line, { budgetBytes: 100, maxLineLength: 200 });
    expect(audit.longLines).toHaveLength(1);
    expect(audit.reclaimableByTrimming).toBeGreaterThan(0);
  });
});

describe('renderIndexBudgetHeadline', () => {
  it('says healthy when under budget and no long lines', () => {
    const audit = auditIndexBudget('- a\n- b\n', { budgetBytes: 10000, maxLineLength: 200 });
    expect(renderIndexBudgetHeadline(audit)).toMatch(/healthy/);
  });

  it('warns that the loader is truncating when over budget', () => {
    const audit = auditIndexBudget('x'.repeat(30000), {
      budgetBytes: 24986,
      maxLineLength: 200,
    });
    const line = renderIndexBudgetHeadline(audit);
    expect(line).toMatch(/OVER budget/);
    expect(line).toMatch(/truncating/);
  });

  it('advises moving detail into topic files when trimming is not enough', () => {
    const content = ['z'.repeat(400), 'k'.repeat(190)].join('\n');
    const audit = auditIndexBudget(content, { budgetBytes: 150, maxLineLength: 200 });
    expect(renderIndexBudgetHeadline(audit)).toMatch(/topic files/);
  });
});
