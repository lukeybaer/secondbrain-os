import { describe, it, expect } from 'vitest';
import {
  classifyWrite,
  classifyWrites,
  summariseDecisions,
} from '../memory-write-deduplicator';
import type { MemoryFact } from '../memory-contradiction-detector';

function fact(
  id: string,
  subject: string,
  predicate: string,
  object: string,
  asOf: string,
  extra: Partial<MemoryFact> = {},
): MemoryFact {
  return { id, subject, predicate, object, asOf, ...extra };
}

describe('memory-write-deduplicator', () => {
  it('returns add when no fact on this (subject, predicate) exists', () => {
    const decision = classifyWrite(
      fact('new', 'luke', 'city', 'McKinney', '2026-05-01T00:00:00Z'),
      [fact('a', 'luke', 'role', 'VP', '2026-04-01T00:00:00Z')],
    );
    expect(decision.action).toBe('add');
    expect(decision.matchedExistingId).toBeUndefined();
    expect(decision.confidence).toBe(1);
  });

  it('returns skip on an exact duplicate within the freshness window', () => {
    const decision = classifyWrite(
      fact('new', 'luke', 'city', 'McKinney', '2026-05-01T05:00:00Z'),
      [fact('a',  'luke', 'city', 'McKinney', '2026-05-01T00:00:00Z')],
    );
    expect(decision.action).toBe('skip');
    expect(decision.matchedExistingId).toBe('a');
    expect(decision.reason).toMatch(/exact duplicate/);
  });

  it('returns update when the candidate is meaningfully newer with the same object', () => {
    const decision = classifyWrite(
      fact('new', 'luke', 'city', 'McKinney', '2026-05-05T00:00:00Z'),
      [fact('a',  'luke', 'city', 'McKinney', '2026-05-01T00:00:00Z')],
    );
    expect(decision.action).toBe('update');
    expect(decision.matchedExistingId).toBe('a');
    expect(decision.reason).toMatch(/newer/);
  });

  it('honors a custom updateFreshnessHours threshold', () => {
    const within = classifyWrite(
      fact('new', 'luke', 'city', 'McKinney', '2026-05-01T05:00:00Z'),
      [fact('a',  'luke', 'city', 'McKinney', '2026-05-01T00:00:00Z')],
      { updateFreshnessHours: 2 },
    );
    expect(within.action).toBe('update');

    const tooFresh = classifyWrite(
      fact('new', 'luke', 'city', 'McKinney', '2026-05-01T01:00:00Z'),
      [fact('a',  'luke', 'city', 'McKinney', '2026-05-01T00:00:00Z')],
      { updateFreshnessHours: 4 },
    );
    expect(tooFresh.action).toBe('skip');
  });

  it('updates on confidence advantage even when not newer', () => {
    const decision = classifyWrite(
      fact('new', 'luke', 'city', 'McKinney', '2026-05-01T00:00:00Z', { confidence: 0.95 }),
      [fact('a',  'luke', 'city', 'McKinney', '2026-05-01T00:00:00Z', { confidence: 0.4 })],
    );
    expect(decision.action).toBe('update');
    expect(decision.reason).toMatch(/confidence/);
  });

  it('skips when the existing fact is higher-confidence and same age', () => {
    const decision = classifyWrite(
      fact('new', 'luke', 'city', 'McKinney', '2026-05-01T00:00:00Z', { confidence: 0.3 }),
      [fact('a',  'luke', 'city', 'McKinney', '2026-05-01T00:00:00Z', { confidence: 0.9 })],
    );
    expect(decision.action).toBe('skip');
  });

  it('normalizes whitespace and case for the same-object check', () => {
    const decision = classifyWrite(
      fact('new', 'luke', 'city', '  McKinney  TX', '2026-05-01T05:00:00Z'),
      [fact('a',  'luke', 'city', 'mckinney tx',    '2026-05-01T00:00:00Z')],
    );
    expect(decision.action).toBe('skip');
  });

  it('treats a near-duplicate as a match (token-set Jaccard)', () => {
    const decision = classifyWrite(
      fact('new', 'bryant', 'employer', 'PixSeat Inc',          '2026-05-01T05:00:00Z'),
      [fact('a',  'bryant', 'employer', 'PixSeat',              '2026-05-01T00:00:00Z')],
    );
    // tokens: {pixseat, inc} vs {pixseat} => intersect 1 / union 2 = 0.5 < 0.85
    // Default threshold rejects this as a near-duplicate, so it routes to add+contradiction-check.
    expect(decision.action).toBe('add');
    expect(decision.reason).toMatch(/no near-duplicate/);
  });

  it('treats a near-duplicate as a match when threshold is relaxed', () => {
    const decision = classifyWrite(
      fact('new', 'bryant', 'employer', 'PixSeat Inc',          '2026-05-01T05:00:00Z'),
      [fact('a',  'bryant', 'employer', 'PixSeat',              '2026-05-01T00:00:00Z')],
      { nearDuplicateThreshold: 0.4 },
    );
    expect(decision.action).toBe('skip');
    expect(decision.matchedExistingId).toBe('a');
  });

  it('treats a contradicting object as add (handing off to contradiction-detector)', () => {
    const decision = classifyWrite(
      fact('new', 'luke', 'city', 'Frisco',   '2026-05-01T05:00:00Z'),
      [fact('a',  'luke', 'city', 'McKinney', '2026-04-01T00:00:00Z')],
    );
    expect(decision.action).toBe('add');
    expect(decision.reason).toMatch(/contradiction/i);
  });

  it('matches against the most similar existing fact when multiple compete', () => {
    const decision = classifyWrite(
      fact('new', 'luke', 'project', 'PixSeat live ops',        '2026-05-05T00:00:00Z'),
      [
        fact('a', 'luke', 'project', 'PixSeat live ops',        '2026-05-01T00:00:00Z'),
        fact('b', 'luke', 'project', 'ITM addiction app',       '2026-05-01T00:00:00Z'),
      ],
    );
    expect(decision.action).toBe('update');
    expect(decision.matchedExistingId).toBe('a');
  });

  it('classifyWrites returns one decision per candidate, in order', () => {
    const existing = [fact('a', 'luke', 'city', 'McKinney', '2026-04-01T00:00:00Z')];
    const decisions = classifyWrites(
      [
        fact('c1', 'luke', 'city', 'McKinney', '2026-04-01T02:00:00Z'), // skip
        fact('c2', 'luke', 'city', 'McKinney', '2026-05-01T00:00:00Z'), // update
        fact('c3', 'luke', 'role', 'VP',       '2026-05-01T00:00:00Z'), // add
      ],
      existing,
    );
    expect(decisions.map((d) => d.action)).toEqual(['skip', 'update', 'add']);
  });

  it('summariseDecisions counts actions and surfaces skip/update reasons', () => {
    const decisions = classifyWrites(
      [
        fact('c1', 'luke', 'city', 'McKinney', '2026-04-01T02:00:00Z'),
        fact('c2', 'luke', 'city', 'McKinney', '2026-05-01T00:00:00Z'),
        fact('c3', 'luke', 'role', 'VP',       '2026-05-01T00:00:00Z'),
      ],
      [fact('a', 'luke', 'city', 'McKinney', '2026-04-01T00:00:00Z')],
    );
    const summary = summariseDecisions(decisions);
    expect(summary.add).toBe(1);
    expect(summary.update).toBe(1);
    expect(summary.skip).toBe(1);
    expect(summary.total).toBe(3);
    expect(summary.reasons.some((r) => r.startsWith('SKIP'))).toBe(true);
    expect(summary.reasons.some((r) => r.startsWith('UPDATE'))).toBe(true);
  });

  it('handles empty existing list gracefully', () => {
    const decision = classifyWrite(
      fact('new', 'luke', 'city', 'McKinney', '2026-05-01T00:00:00Z'),
      [],
    );
    expect(decision.action).toBe('add');
  });
});
