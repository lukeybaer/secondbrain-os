// memory-bm25.ts
//
// BM25 keyword search over SecondBrain's local memory files.
//
// Problem: graphiti-client.ts provides semantic search over the knowledge graph,
// but semantic search misses exact-phrase queries (named entities, project
// code-names, addresses) where keyword matching is more reliable. When the
// Graphiti SSH tunnel is down this is the only retrieval path.
//
// Solution: index all *.md files under secondbrain/memory/ with BM25,
// exposing ranked search with a score + excerpt per result. Runs fully offline
// with zero external dependencies (pure TypeScript BM25 implementation).
//
// BM25 formula (Okapi BM25):
//   score(q,d) = sum_t IDF(t) * (tf(t,d) * (k1+1)) / (tf(t,d) + k1*(1-b+b*|d|/avgdl))
//   k1 = 1.5, b = 0.75 (standard defaults)
//
// Usage:
//   const idx = new MemoryBM25Index();
//   await idx.build('/path/to/secondbrain/memory');
//   const results = idx.search('project-name topic', 5);

import * as fs from 'fs';
import * as path from 'path';
import { planRecallDepth, type RecallPlan, type RecallDepthPolicy } from './memory-recall-depth';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BM25Result {
  filePath: string; // absolute path to the memory file
  relPath: string; // relative path for display
  score: number;
  excerpt: string; // best-matching sentence (first 300 chars)
  lineNumber: number; // approximate line of best match
}

interface IndexedDoc {
  filePath: string;
  relPath: string;
  terms: string[]; // tokenized terms (lowercased)
  termFreq: Map<string, number>;
  content: string; // raw content for excerpting
  lineCount: number;
}

// ── Tokenizer ─────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      // split on non-alphanumeric (keep hyphens between words as separate tokens)
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
  );
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'is',
  'was',
  'are',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'as',
  'if',
  'so',
  'than',
  'then',
  'i',
  'my',
  'me',
  'we',
  'our',
  'you',
  'your',
  'he',
  'his',
  'she',
  'her',
  'they',
  'their',
]);

// ── BM25 parameters ───────────────────────────────────────────────────────────

const K1 = 1.5;
const B = 0.75;

// ── Index ─────────────────────────────────────────────────────────────────────

export class MemoryBM25Index {
  private docs: IndexedDoc[] = [];
  private idf: Map<string, number> = new Map();
  private avgDocLength = 0;
  private builtAt: Date | null = null;

  // ── Build ──────────────────────────────────────────────────────────────────

  build(memoryDir: string): void {
    this.docs = [];

    const mdFiles = this.walkMd(memoryDir);

    for (const filePath of mdFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const terms = tokenize(content);
        const termFreq = new Map<string, number>();
        for (const t of terms) {
          termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
        }
        this.docs.push({
          filePath,
          relPath: path.relative(memoryDir, filePath).replace(/\\/g, '/'),
          terms,
          termFreq,
          content,
          lineCount: content.split('\n').length,
        });
      } catch {
        /* skip unreadable files */
      }
    }

    this.avgDocLength =
      this.docs.length > 0
        ? this.docs.reduce((s, d) => s + d.terms.length, 0) / this.docs.length
        : 1;

    this.computeIDF();
    this.builtAt = new Date();
  }

  private walkMd(dir: string): string[] {
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && e.name !== 'archive' && e.name !== 'node_modules') {
          results.push(...this.walkMd(full));
        } else if (e.isFile() && e.name.endsWith('.md')) {
          results.push(full);
        }
      }
    } catch {
      /* skip inaccessible dirs */
    }
    return results;
  }

  private computeIDF(): void {
    this.idf.clear();
    const N = this.docs.length;
    if (N === 0) return;

    // Count how many docs contain each term
    const df = new Map<string, number>();
    for (const doc of this.docs) {
      const seen = new Set<string>();
      for (const t of doc.terms) {
        if (!seen.has(t)) {
          df.set(t, (df.get(t) ?? 0) + 1);
          seen.add(t);
        }
      }
    }

    for (const [term, docFreq] of df) {
      // Smoothed IDF: ln((N - df + 0.5) / (df + 0.5) + 1)
      this.idf.set(term, Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1));
    }
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  search(query: string, topK: number = 5): BM25Result[] {
    if (this.docs.length === 0) return [];

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return [];

    const scored: { doc: IndexedDoc; score: number }[] = [];

    for (const doc of this.docs) {
      let score = 0;
      const dl = doc.terms.length;

      for (const term of queryTerms) {
        const idfVal = this.idf.get(term) ?? 0;
        if (idfVal === 0) continue;

        const tf = doc.termFreq.get(term) ?? 0;
        if (tf === 0) continue;

        const numerator = tf * (K1 + 1);
        const denominator = tf + K1 * (1 - B + B * (dl / this.avgDocLength));
        score += idfVal * (numerator / denominator);
      }

      if (score > 0) {
        scored.push({ doc, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, topK).map(({ doc, score }) => {
      const { excerpt, lineNumber } = this.bestExcerpt(doc.content, queryTerms);
      return {
        filePath: doc.filePath,
        relPath: doc.relPath,
        score: Math.round(score * 100) / 100,
        excerpt,
        lineNumber,
      };
    });
  }

  // ── Excerpt extraction ─────────────────────────────────────────────────────

  private bestExcerpt(
    content: string,
    queryTerms: string[],
    maxLen: number = 300,
  ): { excerpt: string; lineNumber: number } {
    const lines = content.split('\n');
    let bestScore = -1;
    let bestLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase();
      let hits = 0;
      for (const t of queryTerms) {
        if (lower.includes(t)) hits++;
      }
      if (hits > bestScore) {
        bestScore = hits;
        bestLine = i;
      }
    }

    // Include surrounding context (3 lines before + 3 after)
    const start = Math.max(0, bestLine - 1);
    const end = Math.min(lines.length - 1, bestLine + 2);
    const raw = lines
      .slice(start, end + 1)
      .join(' ')
      .trim();
    const excerpt = raw.length > maxLen ? raw.slice(0, maxLen) + '...' : raw;

    return { excerpt, lineNumber: bestLine + 1 };
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  get docCount(): number {
    return this.docs.length;
  }
  get indexedAt(): Date | null {
    return this.builtAt;
  }
}

// ── Singleton + lazy init ─────────────────────────────────────────────────────
// The index is built once per process start and refreshed during sleep-time
// consolidation. Callers should call refreshIndex() if memory files change.

let _index: MemoryBM25Index | null = null;
let _memoryDir: string | null = null;

export function getMemoryBM25Index(memoryDir: string): MemoryBM25Index {
  if (!_index || _memoryDir !== memoryDir) {
    _index = new MemoryBM25Index();
    _index.build(memoryDir);
    _memoryDir = memoryDir;
  }
  return _index;
}

export function refreshIndex(memoryDir: string): MemoryBM25Index {
  _index = new MemoryBM25Index();
  _index.build(memoryDir);
  _memoryDir = memoryDir;
  return _index;
}

// ── Convenience search ────────────────────────────────────────────────────────
// Use when you have a memoryDir and just want results without managing the index.

export function searchMemory(memoryDir: string, query: string, topK: number = 5): BM25Result[] {
  return getMemoryBM25Index(memoryDir).search(query, topK);
}

// ── Adaptive-depth search ───────────────────────────────────────────────────
// Gates retrieval cost on the query: a short single-fact lookup pulls a small
// topK, a broad or vague query pulls the full fan-out. The plan is returned
// alongside the results so the caller can decide whether to run the heavier
// fusion / rerank rungs (see memory-recall-depth and memory-multi-signal-fuse).

export function searchMemoryAdaptive(
  memoryDir: string,
  query: string,
  policy: RecallDepthPolicy = {},
): { plan: RecallPlan; results: BM25Result[] } {
  const plan = planRecallDepth(query, policy);
  const results = getMemoryBM25Index(memoryDir).search(query, plan.topK);
  return { plan, results };
}
