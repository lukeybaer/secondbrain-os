// memory-block-editor.test.ts
//
// Regression tests for verbatim line-targeted block edits. Encodes the CATEGORY
// (a unique verbatim match edits one spot without touching the rest; zero and
// multiple matches both REFUSE the edit; over-limit refuses; an edit batch is
// all-or-nothing so a failing edit leaves the base untouched), not one literal
// trigger. Per feedback_frugal_regression_tests.md.

import { describe, it, expect } from 'vitest';
import {
  memoryReplace,
  memoryInsert,
  applyEditBatch,
  renderWithLineNumbers,
  MemoryEditError,
} from '../memory-block-editor';

const BIG = 10000;

describe('memoryReplace', () => {
  it('replaces a unique verbatim match and leaves the rest intact', () => {
    const block = 'name: ExampleCo\ncity: ExampleCo\nrole: VP';
    const r = memoryReplace(block, 'city: ExampleCo', 'city: ExampleCo', BIG);
    expect(r.content).toBe('name: ExampleCo\ncity: ExampleCo\nrole: VP');
    expect(r.matchedLine).toBe(2);
    expect(r.changed).toBe(true);
  });

  it('refuses (NO_MATCH) when old_string is not present verbatim', () => {
    expect(() => memoryReplace('a\nb', 'c', 'x', BIG)).toThrow(MemoryEditError);
    try {
      memoryReplace('a\nb', 'c', 'x', BIG);
    } catch (e) {
      expect((e as MemoryEditError).code).toBe('NO_MATCH');
    }
  });

  it('refuses (AMBIGUOUS) rather than guessing when old_string appears twice', () => {
    try {
      memoryReplace('x\nfoo\nfoo\ny', 'foo', 'bar', BIG);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as MemoryEditError).code).toBe('AMBIGUOUS');
    }
  });

  it('is whitespace-sensitive (verbatim, not normalized)', () => {
    // two spaces in target should not match a single-space block
    expect(() => memoryReplace('a b', 'a  b', 'x', BIG)).toThrow(/did not appear/);
  });

  it('refuses (OVER_LIMIT) when the result would exceed the block limit', () => {
    try {
      memoryReplace('short', 'short', 'x'.repeat(100), 10);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as MemoryEditError).code).toBe('OVER_LIMIT');
    }
  });

  it('rejects an empty old_string', () => {
    try {
      memoryReplace('abc', '', 'x', BIG);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as MemoryEditError).code).toBe('EMPTY_TARGET');
    }
  });
});

describe('memoryInsert', () => {
  it('inserts at the top with line 0', () => {
    expect(memoryInsert('a\nb', 'top', 0, BIG).content).toBe('top\na\nb');
  });
  it('inserts in the middle after a given line', () => {
    expect(memoryInsert('a\nb\nc', 'mid', 1, BIG).content).toBe('a\nmid\nb\nc');
  });
  it('appends at end with -1 / omitted', () => {
    expect(memoryInsert('a\nb', 'end', -1, BIG).content).toBe('a\nb\nend');
    expect(memoryInsert('a\nb', 'end', undefined, BIG).content).toBe('a\nb\nend');
  });
  it('strips line-number prefixes from inserted text', () => {
    expect(memoryInsert('a', '12: hello', -1, BIG).content).toBe('a\nhello');
  });
  it('refuses over-limit inserts', () => {
    try {
      memoryInsert('a', 'x'.repeat(100), -1, 10);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as MemoryEditError).code).toBe('OVER_LIMIT');
    }
  });
});

describe('renderWithLineNumbers', () => {
  it('prefixes each line with a 1-based number', () => {
    expect(renderWithLineNumbers('a\nb')).toBe('1: a\n2: b');
  });
});

describe('applyEditBatch (memory_finish_edits semantics)', () => {
  it('applies a fully-valid batch and reports the count', () => {
    const block = 'k1: v1\nk2: v2';
    const out = applyEditBatch(
      block,
      [
        { kind: 'replace', oldString: 'v1', newString: 'V1' },
        { kind: 'insert', newString: 'k3: v3' },
      ],
      BIG,
    );
    expect(out.content).toBe('k1: V1\nk2: v2\nk3: v3');
    expect(out.applied).toBe(2);
  });

  it('is all-or-nothing: a failing edit throws and yields no partial content', () => {
    const block = 'k1: v1\nk2: v2';
    // second edit overflows the tiny limit; the whole batch must be rejected
    expect(() =>
      applyEditBatch(
        block,
        [
          { kind: 'replace', oldString: 'v1', newString: 'V1' },
          { kind: 'insert', newString: 'x'.repeat(500) },
        ],
        20,
      ),
    ).toThrow(MemoryEditError);
    // base string is a const; the point is the function returns nothing on failure
    expect(block).toBe('k1: v1\nk2: v2');
  });
});
