import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildReflection,
  appendReflection,
  readReflections,
  summarizeReflections,
  detectRecurringFailures,
  buildSelfCorrectionHint,
} from '../agent-reflection';

describe('agent-reflection', () => {
  it('builds a record with required fields', () => {
    const r = buildReflection(
      'dentist-call',
      'book a cleaning without x-rays',
      ['researched 5 clinics', 'called 3'],
      'partial',
      ['script too formal'],
    );
    expect(r.task).toBe('dentist-call');
    expect(r.outcome).toBe('partial');
    expect(r.steps).toHaveLength(2);
    expect(r.related_files).toBeUndefined();
    expect(new Date(r.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('includes related_files when provided', () => {
    const r = buildReflection('x', 'y', [], 'success', [], ['a.ts', 'b.ts']);
    expect(r.related_files).toEqual(['a.ts', 'b.ts']);
  });

  it('appends and reads back JSONL records', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflection-'));
    const file = path.join(dir, 'nested', 'log.jsonl');
    appendReflection(file, buildReflection('t1', 'g1', ['s1'], 'success', []));
    appendReflection(file, buildReflection('t2', 'g2', ['s2'], 'failure', ['l2']));
    const all = readReflections(file);
    expect(all).toHaveLength(2);
    expect(all[0].task).toBe('t1');
    expect(all[1].outcome).toBe('failure');
    expect(all[1].learnings).toEqual(['l2']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty array for missing log', () => {
    expect(readReflections('/nonexistent/path/log.jsonl')).toEqual([]);
  });
});

function rec(
  task: string,
  outcome: 'success' | 'partial' | 'failure' | 'dry-run',
  timestamp: string,
  learnings: string[] = [],
) {
  return {
    timestamp,
    task,
    goal: `${task} goal`,
    steps: ['step'],
    outcome,
    learnings,
  };
}

describe('summarizeReflections', () => {
  it('returns a zeroed summary for no records', () => {
    const s = summarizeReflections([]);
    expect(s.total).toBe(0);
    expect(s.by_outcome).toEqual({ success: 0, partial: 0, failure: 0, 'dry-run': 0 });
    expect(s.tasks).toEqual([]);
    expect(s.success_rate).toBe(0);
    expect(s.top_learnings).toEqual([]);
    expect(s.window_start).toBeNull();
    expect(s.window_end).toBeNull();
  });

  it('counts outcomes and computes a scorable success rate', () => {
    const s = summarizeReflections([
      rec('a', 'success', '2026-05-17T01:00:00Z'),
      rec('b', 'success', '2026-05-17T02:00:00Z'),
      rec('c', 'failure', '2026-05-17T03:00:00Z'),
      rec('d', 'partial', '2026-05-17T04:00:00Z'),
      rec('e', 'dry-run', '2026-05-17T05:00:00Z'),
    ]);
    expect(s.total).toBe(5);
    expect(s.by_outcome.success).toBe(2);
    expect(s.by_outcome['dry-run']).toBe(1);
    // dry-run is excluded from the denominator: 2 / (2+1+1)
    expect(s.success_rate).toBeCloseTo(0.5);
    expect(s.window_start).toBe('2026-05-17T01:00:00Z');
    expect(s.window_end).toBe('2026-05-17T05:00:00Z');
  });

  it('lists distinct tasks sorted and dedupes learnings newest-first', () => {
    const s = summarizeReflections([
      rec('zeta', 'success', '2026-05-17T01:00:00Z', ['older lesson']),
      rec('alpha', 'failure', '2026-05-17T02:00:00Z', ['shared lesson']),
      rec('alpha', 'partial', '2026-05-17T03:00:00Z', ['shared lesson', 'newest lesson']),
    ]);
    expect(s.tasks).toEqual(['alpha', 'zeta']);
    // newest record is scanned first; within a record learnings keep order
    expect(s.top_learnings.slice(0, 2)).toEqual(['shared lesson', 'newest lesson']);
    // 'older lesson' from the earliest record lands last
    expect(s.top_learnings[s.top_learnings.length - 1]).toBe('older lesson');
    // 'shared lesson' appears once despite two occurrences
    expect(s.top_learnings.filter((l) => l === 'shared lesson')).toHaveLength(1);
  });

  it('caps top_learnings at maxLearnings', () => {
    const records = Array.from({ length: 20 }, (_, i) =>
      rec('t', 'success', `2026-05-17T00:00:${String(i).padStart(2, '0')}Z`, [`lesson ${i}`]),
    );
    expect(summarizeReflections(records, 5).top_learnings).toHaveLength(5);
  });
});

describe('detectRecurringFailures', () => {
  it('returns nothing when no task crosses the threshold', () => {
    expect(
      detectRecurringFailures([
        rec('a', 'failure', '2026-05-17T01:00:00Z'),
        rec('b', 'partial', '2026-05-17T02:00:00Z'),
      ]),
    ).toEqual([]);
  });

  it('flags a task that failed or partialed at least threshold times', () => {
    const out = detectRecurringFailures([
      rec('briefing', 'failure', '2026-05-15T01:00:00Z', ['news section empty']),
      rec('briefing', 'success', '2026-05-16T01:00:00Z'),
      rec('briefing', 'partial', '2026-05-17T01:00:00Z', ['mortgage deltas missing']),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].task).toBe('briefing');
    expect(out[0].failure_count).toBe(2);
    expect(out[0].total_runs).toBe(3);
    expect(out[0].last_outcome).toBe('partial');
    expect(out[0].last_timestamp).toBe('2026-05-17T01:00:00Z');
    expect(out[0].sample_learnings).toContain('mortgage deltas missing');
  });

  it('does not count dry-run outcomes as failures', () => {
    expect(
      detectRecurringFailures([
        rec('t', 'dry-run', '2026-05-17T01:00:00Z'),
        rec('t', 'dry-run', '2026-05-17T02:00:00Z'),
      ]),
    ).toEqual([]);
  });

  it('sorts results by failure_count descending', () => {
    const out = detectRecurringFailures([
      rec('low', 'failure', '2026-05-17T01:00:00Z'),
      rec('low', 'partial', '2026-05-17T02:00:00Z'),
      rec('high', 'failure', '2026-05-17T01:00:00Z'),
      rec('high', 'failure', '2026-05-17T02:00:00Z'),
      rec('high', 'partial', '2026-05-17T03:00:00Z'),
    ]);
    expect(out.map((f) => f.task)).toEqual(['high', 'low']);
    expect(out[0].failure_count).toBe(3);
  });

  it('honors a custom threshold', () => {
    const records = [
      rec('t', 'failure', '2026-05-17T01:00:00Z'),
      rec('t', 'failure', '2026-05-17T02:00:00Z'),
      rec('t', 'failure', '2026-05-17T03:00:00Z'),
    ];
    expect(detectRecurringFailures(records, 5)).toEqual([]);
    expect(detectRecurringFailures(records, 3)).toHaveLength(1);
  });
});

describe('buildSelfCorrectionHint', () => {
  it('returns applicable=false when no records match the task', () => {
    const h = buildSelfCorrectionHint('briefing', [
      rec('other', 'failure', '2026-05-17T01:00:00Z'),
    ]);
    expect(h.applicable).toBe(false);
    expect(h.total_runs).toBe(0);
    expect(h.failure_count).toBe(0);
    expect(h.hint_block).toBe('');
  });

  it('produces an applicable hint after a single failure', () => {
    const h = buildSelfCorrectionHint('briefing', [
      rec('briefing', 'failure', '2026-05-17T01:00:00Z', [
        'mortgage block stale by 6h',
      ]),
    ]);
    expect(h.applicable).toBe(true);
    expect(h.failure_count).toBe(1);
    expect(h.total_runs).toBe(1);
    expect(h.last_outcome).toBe('failure');
    expect(h.learnings).toEqual(['mortgage block stale by 6h']);
    expect(h.hint_block).toContain('"briefing"');
    expect(h.hint_block).toContain('mortgage block stale');
    expect(h.hint_block).toContain('Do not repeat');
  });

  it('dedupes learnings newest-first and caps at max_learnings', () => {
    const records = [
      rec('t', 'failure', '2026-05-17T01:00:00Z', ['L1', 'L2']),
      rec('t', 'failure', '2026-05-17T02:00:00Z', ['L2', 'L3']),
      rec('t', 'partial', '2026-05-17T03:00:00Z', ['L3', 'L4', 'L5']),
    ];
    const h = buildSelfCorrectionHint('t', records, { max_learnings: 3 });
    expect(h.learnings).toEqual(['L3', 'L4', 'L5']);
  });

  it('honors max_learnings=0 by omitting the learnings section', () => {
    const h = buildSelfCorrectionHint(
      't',
      [rec('t', 'failure', '2026-05-17T01:00:00Z', ['L1'])],
      { max_learnings: 0 },
    );
    expect(h.applicable).toBe(true);
    expect(h.learnings).toEqual([]);
    expect(h.hint_block).not.toContain('Apply these learnings');
  });

  it('uses success records as a learning source when there are no failures', () => {
    const h = buildSelfCorrectionHint('t', [
      rec('t', 'success', '2026-05-17T01:00:00Z', ['noted: refresh first']),
    ]);
    expect(h.applicable).toBe(true);
    expect(h.failure_count).toBe(0);
    expect(h.learnings).toEqual(['noted: refresh first']);
  });

  it('returns applicable=false for pure success / dry-run history with no learnings', () => {
    const h = buildSelfCorrectionHint('t', [
      rec('t', 'success', '2026-05-17T01:00:00Z'),
      rec('t', 'dry-run', '2026-05-17T02:00:00Z'),
    ]);
    expect(h.applicable).toBe(false);
    expect(h.hint_block).toBe('');
  });
});
