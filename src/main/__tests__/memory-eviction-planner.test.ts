import { describe, it, expect } from 'vitest';
import {
  planEviction,
  linesFromContent,
  contentFromKept,
  type EvictionLine,
} from '../memory-eviction-planner';

function line(text: string, ref?: string, pinned = false): EvictionLine {
  return { text, lastReferencedAt: ref, pinned };
}

describe('planEviction', () => {
  it('does nothing when the block is under the limit', () => {
    const plan = planEviction([line('a'), line('b')], 1000);
    expect(plan.needsEviction).toBe(false);
    expect(plan.evict).toHaveLength(0);
    expect(plan.keep).toHaveLength(2);
    expect(plan.overBy).toBe(0);
  });

  it('evicts the coldest (oldest-referenced) lines first', () => {
    const lines = [
      line('hot', '2026-05-31T00:00:00Z'),
      line('cold', '2026-01-01T00:00:00Z'),
      line('warm', '2026-05-01T00:00:00Z'),
    ];
    // Each line is short; force a tiny limit so exactly one must go.
    // bytes per line ~ len+1; set limit so target evicts the coldest only.
    const total = lines.reduce((s, l) => s + Buffer.byteLength(l.text) + 1, 0);
    const plan = planEviction(lines, total - 1, { headroomRatio: 0 });
    expect(plan.needsEviction).toBe(true);
    expect(plan.evict.map((l) => l.text)).toEqual(['cold']);
    expect(plan.keep.map((l) => l.text)).toEqual(['hot', 'warm']);
  });

  it('treats never-referenced lines as the coldest', () => {
    const lines = [
      line('referenced', '2026-05-31T00:00:00Z'),
      line('never'),
    ];
    const total = lines.reduce((s, l) => s + Buffer.byteLength(l.text) + 1, 0);
    const plan = planEviction(lines, total - 1, { headroomRatio: 0 });
    expect(plan.evict.map((l) => l.text)).toEqual(['never']);
  });

  it('never evicts pinned lines, even under pressure', () => {
    const lines = [
      line('pinned-important', '2020-01-01T00:00:00Z', true),
      line('evictable', '2026-05-31T00:00:00Z'),
    ];
    const total = lines.reduce((s, l) => s + Buffer.byteLength(l.text) + 1, 0);
    const plan = planEviction(lines, total - 1, { headroomRatio: 0 });
    expect(plan.evict.map((l) => l.text)).toEqual(['evictable']);
    expect(plan.keep.some((l) => l.pinned)).toBe(true);
  });

  it('reports blockedByPins when pinned content alone exceeds the limit', () => {
    const lines = [
      line('a'.repeat(100), '2020-01-01T00:00:00Z', true),
      line('b'.repeat(100), '2020-01-01T00:00:00Z', true),
    ];
    const plan = planEviction(lines, 50);
    expect(plan.blockedByPins).toBe(true);
    expect(plan.evict).toHaveLength(0); // nothing non-pinned to evict
    expect(plan.resultingBytes).toBeGreaterThan(plan.limit);
  });

  it('leaves headroom so the next append does not immediately overflow', () => {
    // 11 lines of 9 chars + newline = 10 bytes each = 110 bytes total.
    // limit 100 (so 110 > 100 forces eviction), headroom 0.2 => target 80.
    const lines = Array.from({ length: 11 }, (_, i) =>
      line('xxxxxxxx' + i, `2026-0${(i % 9) + 1}-01T00:00:00Z`),
    );
    const plan = planEviction(lines, 100, { headroomRatio: 0.2 });
    expect(plan.needsEviction).toBe(true);
    expect(plan.resultingBytes).toBeLessThanOrEqual(80);
  });

  it('preserves original block order in keep and evict', () => {
    const lines = [
      line('first', '2026-01-01T00:00:00Z'),
      line('second', '2026-06-01T00:00:00Z'),
      line('third', '2026-02-01T00:00:00Z'),
      line('fourth', '2026-06-01T00:00:00Z'),
    ];
    // "second"+"fourth" = 7+7 = 14 bytes. limit 14 forces eviction of the
    // two coldest (first=Jan, third=Feb) and keeps the two June lines.
    const plan = planEviction(lines, 14, { headroomRatio: 0 });
    // evicted should appear in original order
    const evicted = plan.evict.map((l) => l.text);
    expect(evicted).toEqual(['first', 'third']);
    // kept in original order
    expect(plan.keep.map((l) => l.text)).toEqual(['second', 'fourth']);
  });

  it('counts multibyte utf8 correctly', () => {
    const emoji = line('🎯🎯🎯'); // 12 bytes + newline
    const plan = planEviction([emoji], 5);
    expect(plan.blockBytes).toBe(13);
    expect(plan.overBy).toBe(8);
  });
});

describe('linesFromContent / contentFromKept round-trip', () => {
  it('splits content and drops the trailing empty line', () => {
    const lines = linesFromContent('one\ntwo\nthree\n');
    expect(lines.map((l) => l.text)).toEqual(['one', 'two', 'three']);
  });

  it('applies reference times and pins by index', () => {
    const lines = linesFromContent(
      'a\nb\nc',
      { 1: '2026-05-01T00:00:00Z' },
      new Set([0]),
    );
    expect(lines[0].pinned).toBe(true);
    expect(lines[1].lastReferencedAt).toBe('2026-05-01T00:00:00Z');
    expect(lines[2].pinned).toBe(false);
  });

  it('reassembles kept lines into a block body', () => {
    // keep1/keep2 are recently referenced; drop is never referenced (coldest),
    // so drop is the one evicted under pressure.
    const lines = linesFromContent('keep1\ndrop\nkeep2', {
      0: '2026-05-01T00:00:00Z',
      2: '2026-05-01T00:00:00Z',
    });
    const total = lines.reduce((s, l) => s + Buffer.byteLength(l.text) + 1, 0);
    const plan = planEviction(lines, total - 5, { headroomRatio: 0 });
    expect(plan.evict.map((l) => l.text)).toEqual(['drop']);
    expect(contentFromKept(plan)).toBe('keep1\nkeep2');
  });
});
