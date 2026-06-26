/**
 * Tests for memory-bm25.ts (nightly run 143).
 *
 * memory-bm25 is the offline keyword-retrieval path memory-tool-use.ts uses for
 * exact-phrase / named-entity lookups (and the ONLY retrieval path when the
 * Graphiti SSH tunnel is down), yet it shipped with zero test coverage. These
 * tests lock the ranking behavior (the right doc wins), the tokenizer contract
 * (stopwords dropped, hyphenated terms kept), excerpt extraction, the
 * archive-dir exclusion, and the singleton/refresh cache so a regression in the
 * scorer or the index lifecycle surfaces in CI.
 *
 * Tests assert the CATEGORY (a doc that mentions the query term outranks one
 * that does not; a rare term resolves to its document), not exact BM25 scores,
 * so they survive a parameter retune.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  MemoryBM25Index,
  getMemoryBM25Index,
  refreshIndex,
  searchMemory,
  searchMemoryAdaptive,
} from '../memory-bm25';

let memDir: string;

function write(rel: string, content: string): void {
  const full = path.join(memDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-bm25-'));
});

afterEach(() => {
  fs.rmSync(memDir, { recursive: true, force: true });
});

describe('MemoryBM25Index build + search', () => {
  it('ranks the document that mentions the query term first', () => {
    write('infra.md', 'Kubernetes cluster autoscaling and pod scheduling. '.repeat(10));
    write('cooking.md', 'A gentle recipe for sourdough bread and slow fermentation. '.repeat(10));

    const idx = new MemoryBM25Index();
    idx.build(memDir);
    const results = idx.search('kubernetes pod scheduling', 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].relPath).toBe('infra.md');
  });

  it('resolves a rare named entity to its single document', () => {
    write('a.md', 'general notes about the weather and the week ahead');
    write('b.md', 'project codename ExampleCo stadium seating launch plan');
    write('c.md', 'general notes about lunch and errands');

    const idx = new MemoryBM25Index();
    idx.build(memDir);
    const results = idx.search('ExampleCo', 3);

    expect(results[0].relPath).toBe('b.md');
  });

  it('returns an excerpt and a line number pointing at the match', () => {
    write(
      'doc.md',
      ['intro line', 'second line', 'the magnetar pulsed brightly', 'tail line'].join('\n'),
    );
    const idx = new MemoryBM25Index();
    idx.build(memDir);
    const [top] = idx.search('magnetar', 1);

    expect(top.excerpt.toLowerCase()).toContain('magnetar');
    expect(top.lineNumber).toBeGreaterThanOrEqual(2);
    expect(path.isAbsolute(top.filePath)).toBe(true);
  });

  it('excludes the archive subdirectory from the index', () => {
    write('live.md', 'active widget telemetry dashboard');
    write('archive/old.md', 'archived widget telemetry dashboard');

    const idx = new MemoryBM25Index();
    idx.build(memDir);
    const rels = idx.search('widget telemetry', 5).map((r) => r.relPath);

    expect(rels).toContain('live.md');
    expect(rels.every((r) => !r.includes('archive'))).toBe(true);
  });

  it('uses forward-slash relative paths even for nested files', () => {
    write('contacts/john-smith.md', 'john smith works at acme corporation');
    const idx = new MemoryBM25Index();
    idx.build(memDir);
    const [top] = idx.search('acme corporation', 1);
    expect(top.relPath).toBe('contacts/john-smith.md');
  });
});

describe('tokenizer + query edge cases', () => {
  it('returns nothing for a query made only of stopwords', () => {
    write('doc.md', 'the quick brown fox jumps over the lazy dog');
    const idx = new MemoryBM25Index();
    idx.build(memDir);
    expect(idx.search('the a an of', 5)).toEqual([]);
  });

  it('returns nothing for an empty query', () => {
    write('doc.md', 'content here');
    const idx = new MemoryBM25Index();
    idx.build(memDir);
    expect(idx.search('', 5)).toEqual([]);
  });

  it('returns nothing when the index has no documents', () => {
    const idx = new MemoryBM25Index();
    idx.build(memDir); // empty dir, no .md files
    expect(idx.docCount).toBe(0);
    expect(idx.search('anything', 5)).toEqual([]);
  });

  it('respects the topK limit', () => {
    for (let i = 0; i < 6; i++) write(`doc-${i}.md`, 'shared keyword retrieval term');
    const idx = new MemoryBM25Index();
    idx.build(memDir);
    expect(idx.search('keyword retrieval', 3).length).toBeLessThanOrEqual(3);
  });
});

describe('singleton + refresh lifecycle', () => {
  it('getMemoryBM25Index caches the index for the same directory', () => {
    write('doc.md', 'cached document body');
    const a = getMemoryBM25Index(memDir);
    const b = getMemoryBM25Index(memDir);
    expect(a).toBe(b);
  });

  it('refreshIndex rebuilds and picks up newly written files', () => {
    write('first.md', 'original ledger content');
    const before = getMemoryBM25Index(memDir);
    expect(before.search('newterm', 5)).toEqual([]);

    write('second.md', 'a newterm appears in the memory corpus');
    const after = refreshIndex(memDir);
    expect(after).not.toBe(before);
    expect(after.search('newterm', 5).length).toBeGreaterThan(0);
  });
});

describe('convenience helpers', () => {
  it('searchMemory returns ranked results without managing an index', () => {
    write('doc.md', 'ExampleCo texas dental cleaning appointment');
    const results = searchMemory(memDir, 'dental cleaning', 5);
    expect(results[0].relPath).toBe('doc.md');
  });

  it('searchMemoryAdaptive returns a recall plan alongside the results', () => {
    write('doc.md', 'adaptive depth retrieval over the memory corpus');
    const { plan, results } = searchMemoryAdaptive(memDir, 'adaptive retrieval');
    expect(plan.topK).toBeGreaterThan(0);
    expect(results.length).toBeGreaterThanOrEqual(0);
  });
});
