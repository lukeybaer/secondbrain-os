// memory-multi-signal-fuse.ts
//
// Reciprocal Rank Fusion (RRF) for memory search across multiple signal
// sources. Mem0's April 2026 retrieval pattern combines semantic matching,
// BM25 keyword search, and entity-graph mention counts in parallel, then
// fuses their ranked outputs into a single ranking. SecondBrain already
// ships all three signals as independent modules:
//
//   - memory-bm25.ts          searchMemory()         BM25 keyword ranks
//   - entity-memory-graph.ts  EntityMemoryGraph      entity-mention ranks
//   - graphiti-client.ts      searchKnowledge()      semantic ranks
//
// But every caller that wants a unified answer (the chat handler, the
// briefing pipeline, the call-context builder) re-implements its own
// ad-hoc score-merge, usually by interleaving the top-K of each source,
// which is biased toward sources with larger absolute score ranges.
//
// RRF (Cormack, Clarke, Buettcher 2009 SIGIR "Reciprocal rank fusion
// outperforms Condorcet and individual rank learning methods") is the
// well-established default fusion method used by Elasticsearch and
// OpenSearch. It depends only on rank position, not on absolute scores,
// which makes it robust when signals have wildly different score scales.
//
//   score(d) = sum over rankers i: weight_i / (k + rank_i(d))
//
//   - rank_i(d) is d's 1-indexed position in ranker i's result list
//   - d not in ranker i contributes 0 for that term
//   - k is a smoothing constant (60 is the literature default;
//     larger k flattens the ranking, smaller k spikes the top)
//   - weight_i lets callers privilege one signal over another
//     (e.g. entity-graph weight 1.5 when the query is clearly a name)
//
// This module is pure: no fs, no electron, no network. The caller pulls
// rankings from whichever sources are available (graphiti can be down)
// and hands them in. Missing rankers are silently ignored.

// ── Types ───────────────────────────────────────────────────────────────

/**
 * One ranker's contribution: a name, a weight, and its top-K result list
 * in rank order (best first). `id` is whatever the caller uses to identify
 * a memory (a file path, a graphiti node uuid, an entity canonical name).
 *
 * The same id may appear in multiple rankers and is what we fuse on.
 */
export interface RankerInput {
  name: string;
  weight?: number; // default 1.0
  /** Results in rank order, best first. Limit to top-K before passing in. */
  results: Array<{ id: string }>;
}

export interface FusedResult {
  id: string;
  fused_score: number;
  /** Per-ranker 1-indexed rank, or null when the ranker did not include this id. */
  per_ranker_ranks: Record<string, number | null>;
  /** Number of rankers that ranked this id. Useful for tie-breaking and audit. */
  rankers_matched: number;
}

export interface FuseOpts {
  /** RRF smoothing constant. Defaults to 60 (literature standard). */
  k?: number;
  /** Cap on returned results. Defaults to 20. */
  topK?: number;
}

// ── Fusion ──────────────────────────────────────────────────────────────

/**
 * Fuse N ranked result lists into one ranking via Reciprocal Rank Fusion.
 *
 * Empty rankers and empty result lists are silently ignored, so callers
 * can pass an entry for every potential signal source and let the
 * function deal with the ones that returned nothing (graphiti tunnel
 * down, etc.).
 */
export function fuseMemorySignals(
  rankers: RankerInput[],
  opts: FuseOpts = {},
): FusedResult[] {
  const k = Math.max(1, opts.k ?? 60);
  const topK = Math.max(1, opts.topK ?? 20);

  const acc = new Map<string, FusedResult>();
  const rankerNames = new Set<string>();
  for (const r of rankers) {
    if (r.results.length === 0) continue;
    rankerNames.add(r.name);
  }

  for (const r of rankers) {
    if (r.results.length === 0) continue;
    const weight = r.weight === undefined ? 1.0 : r.weight;
    r.results.forEach((item, idx) => {
      const rank = idx + 1;
      let entry = acc.get(item.id);
      if (!entry) {
        entry = {
          id: item.id,
          fused_score: 0,
          per_ranker_ranks: {},
          rankers_matched: 0,
        };
        for (const name of rankerNames) {
          entry.per_ranker_ranks[name] = null;
        }
        acc.set(item.id, entry);
      }
      // Only count the first appearance of an id within a ranker (rank
      // list should be unique anyway, but a defensive guard so a
      // duplicated id does not double-count).
      if (entry.per_ranker_ranks[r.name] !== null) return;
      entry.per_ranker_ranks[r.name] = rank;
      entry.fused_score += weight / (k + rank);
      entry.rankers_matched += 1;
    });
  }

  for (const entry of acc.values()) {
    for (const name of rankerNames) {
      if (!(name in entry.per_ranker_ranks)) {
        entry.per_ranker_ranks[name] = null;
      }
    }
  }

  return Array.from(acc.values())
    .sort((a, b) => {
      if (b.fused_score !== a.fused_score) return b.fused_score - a.fused_score;
      // Tie-breaker: more rankers matched wins (cross-signal consensus).
      if (b.rankers_matched !== a.rankers_matched) {
        return b.rankers_matched - a.rankers_matched;
      }
      // Final tie-breaker: deterministic id sort, so output is stable.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, topK);
}

/**
 * Convenience builder for callers that have multiple sources but only want
 * the top-K ids back, not the fusion telemetry. Returns just the ids in
 * fused-rank order.
 */
export function fuseMemorySignalIds(
  rankers: RankerInput[],
  opts: FuseOpts = {},
): string[] {
  return fuseMemorySignals(rankers, opts).map((r) => r.id);
}
