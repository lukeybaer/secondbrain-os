// atomic-fact-extractor.test.ts
//
// Run 97 enhancement 3: regression tests for the heuristic fact extractor.
// Encodes the category (each rule extracts the right predicate/object pair,
// the extractor is deterministic, and re-ingest of the same chunk produces
// stable ids the lifecycle engine can dedupe against), not the literal
// matched string. Per feedback_frugal_regression_tests.md.

import { describe, it, expect } from 'vitest';
import {
  extractFacts,
  extractBatch,
  listRuleCategories,
  InboundChunk,
} from '../atomic-fact-extractor';

function chunk(over: Partial<InboundChunk> & Pick<InboundChunk, 'text'>): InboundChunk {
  return {
    chunkId: 'ck_1',
    source: 'otter',
    timestamp: '2026-05-29T00:00:00Z',
    ...over,
  };
}

describe('atomic-fact-extractor.extractFacts', () => {
  it('extracts a lives_in fact from a first-person location statement', () => {
    const facts = extractFacts(
      chunk({ text: "I moved to Springfield last month." }),
    );
    expect(facts.length).toBeGreaterThan(0);
    const livesIn = facts.find((f) => f.predicate === 'lives_in');
    expect(livesIn?.object).toBe('springfield');
    expect(livesIn?.subject).toBe('ExampleCo');
    expect(livesIn?.source).toBe('otter');
  });

  it('extracts an employer fact', () => {
    const facts = extractFacts(
      chunk({ text: "I'm VP at Acme and we just shipped a release." }),
    );
    const emp = facts.find((f) => f.predicate === 'employer');
    expect(emp?.object).toContain('Acme');
  });

  it('extracts a relationship fact with the typed predicate', () => {
    const facts = extractFacts(
      chunk({ text: "My wife Sarah is finishing her dissertation." }),
    );
    const wife = facts.find((f) => f.predicate === 'relation.wife');
    expect(wife?.object).toBe('Sarah');
  });

  it('extracts a birthday fact preserving the date string', () => {
    const facts = extractFacts(
      chunk({ text: "My birthday is March 12." }),
    );
    const bday = facts.find((f) => f.predicate === 'birthday');
    expect(bday?.object).toBe('March 12');
  });

  it('extracts a phone fact, normalized to digits', () => {
    const facts = extractFacts(
      chunk({ text: "My number is 555-123-4567 if you need me." }),
    );
    const phone = facts.find((f) => f.predicate === 'phone');
    expect(phone?.object).toBe('5551234567');
    expect(phone?.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('returns empty when no rule matches', () => {
    const facts = extractFacts(
      chunk({ text: "The weather is nice today." }),
    );
    expect(facts).toHaveLength(0);
  });

  it('respects subjectHint to override the default subject', () => {
    const facts = extractFacts(
      chunk({ text: "I live in ExampleCo.", subjectHint: 'contact_x' }),
    );
    expect(facts[0]?.subject).toBe('contact_x');
  });

  it('respects minConfidence floor', () => {
    const facts = extractFacts(
      chunk({ text: "I prefer dark coffee in the morning." }),
      { minConfidence: 0.6 },
    );
    expect(facts.find((f) => f.predicate === 'preference')).toBeUndefined();
  });

  it('respects maxPerChunk cap', () => {
    const text =
      "I live in Springfield. My wife Sarah is great. My birthday is March 12. " +
      "My number is 555-123-4567. I'm VP at Acme.";
    const facts = extractFacts(chunk({ text }), { maxPerChunk: 2 });
    expect(facts.length).toBeLessThanOrEqual(2);
  });

  it('produces the same fact id for re-ingestion of the same chunk', () => {
    const c = chunk({ text: "I moved to Springfield." });
    const a = extractFacts(c);
    const b = extractFacts(c);
    expect(a[0]?.id).toBe(b[0]?.id);
  });

  it('produces different ids for different chunkIds even with the same text', () => {
    const a = extractFacts(chunk({ text: "I moved to Springfield.", chunkId: 'ck_a' }));
    const b = extractFacts(chunk({ text: "I moved to Springfield.", chunkId: 'ck_b' }));
    expect(a[0]?.id).not.toBe(b[0]?.id);
  });

  it('deduplicates exact (subject, predicate, object) within a single chunk', () => {
    // Two clauses that the same rule would match. The internal seenKey
    // set drops the duplicate.
    const text = "I moved to Springfield last year. I moved to Springfield again recently.";
    const facts = extractFacts(chunk({ text }));
    const livesInFacts = facts.filter((f) => f.predicate === 'lives_in');
    expect(livesInFacts.length).toBe(1);
  });

  it('threads the chunk timestamp into every fact as asOf', () => {
    const facts = extractFacts(
      chunk({ text: "I live in Springfield.", timestamp: '2026-01-15T08:00:00Z' }),
    );
    expect(facts[0]?.asOf).toBe('2026-01-15T08:00:00Z');
  });
});

describe('atomic-fact-extractor.extractBatch', () => {
  it('flattens facts across multiple chunks in input order', () => {
    const chunks = [
      chunk({ chunkId: 'c1', text: "I moved to Springfield." }),
      chunk({ chunkId: 'c2', text: "My wife Sarah is great." }),
    ];
    const facts = extractBatch(chunks);
    expect(facts.length).toBeGreaterThanOrEqual(2);
    expect(facts[0].predicate).toBe('lives_in');
    expect(facts[facts.length - 1].predicate).toBe('relation.wife');
  });
});

describe('listRuleCategories', () => {
  it('returns the canonical category list non-empty', () => {
    const cats = listRuleCategories();
    expect(cats.length).toBeGreaterThan(5);
    expect(cats).toContain('lives_in');
    expect(cats).toContain('phone');
  });
});
