// memory-temporal-rerank.ts
//
// Temporal-aware re-ranking for memory search results. Mem0's April 2026
// retrieval pattern fuses semantic + BM25 + entity ranks (now implemented
// in memory-multi-signal-fuse.ts) and then applies "temporal reasoning
// for context-aware retrieval" so that a memory from this week beats an
// equally-relevant memory from 18 months ago all else equal.
//
// Why this is a separate primitive from memory-temperature.ts:
//
//   memory-temperature.ts ranks BY ACCESS HOTNESS: how often a memory
//   has been read, weighted with a decay so old reads matter less. It
//   is a hotness-of-memory measure, not a freshness-of-fact measure.
//
//   memory-temporal-rerank.ts ranks BY MEMORY AGE: when was the memory
//   itself written or last verified. A briefing fact written today is
//   considered fresher than one written in 2024 even if neither has
//   been touched recently. Useful when the query is about Luke's
//   CURRENT state (where does he live, who is he meeting next week)
//   versus historical state.
//
// The two compose: memory-temperature decides which memories are
// hot enough to expose in the system prompt at all; memory-temporal-rerank
// decides, among a set of search hits, which ones are most likely to
// reflect Luke's current reality.
//
// Formula (exponential half-life decay):
//
//   adjusted = base * (1 - lambda) + recency * lambda
//   recency  = exp(-ln2 * age_days / halflife_days)   in [0, 1]
//
//   lambda in [0, 1] is the recency weight (0 = pure relevance,
//   1 = pure recency). Default 0.3 reranks gently so a strongly
//   relevant old hit can still outrank a marginally relevant recent
//   one, but a tie goes to recency.
//
// Half-life default is 180 days, which matches how often Luke's
// circumstances meaningfully change (job, address, project list).
// Briefing-class lookups should pass a shorter half-life (14 days)
// because their relevance horizon is "what is true today."
//
// Pure module: no fs, no electron, no network. The caller supplies a
// timestamp per item and gets a re-ordered list back.

// ── Types ───────────────────────────────────────────────────────────────

export interface ScoredItem {
  /** Caller's opaque identifier. */
  id: string;
  /** Pre-rerank relevance score (from RRF, embedding cosine, etc.). */
  score: number;
  /** ISO timestamp of when the memory was last verified or written. */
  timestamp: string;
}

export interface RerankedItem extends ScoredItem {
  /** Score after temporal blending. Sorted desc by this. */
  adjusted_score: number;
  /** 0..1 recency factor used. 1 = today, 0 = far past. */
  recency_factor: number;
  /** Days between `timestamp` and `now`. Negative for future timestamps. */
  age_days: number;
}

export interface RerankOpts {
  /** Recency weight, 0..1. 0 = ignore time, 1 = ignore relevance. Default 0.3. */
  lambda?: number;
  /** Exponential half-life in days. Default 180. */
  halflifeDays?: number;
  /** Reference timestamp for "now". Defaults to current time. Pass for tests. */
  now?: Date;
}

// ── Rerank ──────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;
const LN2 = Math.log(2);

/**
 * Re-rank a relevance-scored list by blending in a recency factor.
 *
 * Items with unparseable `timestamp` get recency_factor=0 (treated as
 * ancient) rather than being dropped. That preserves them in the result
 * set, but unweighted, so a typo in a frontmatter date does not erase a
 * memory from search results.
 *
 * Future-dated items (timestamp after `now`) are capped at recency=1.0
 * so a scheduled-task memory dated next week is not penalized.
 */
export function rerankByRecency(
  items: ScoredItem[],
  opts: RerankOpts = {},
): RerankedItem[] {
  const lambda = clamp01(opts.lambda ?? 0.3);
  const halflife = Math.max(0.1, opts.halflifeDays ?? 180);
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  return items
    .map((it) => {
      const ageDays = computeAgeDays(it.timestamp, nowMs);
      const recency = computeRecency(ageDays, halflife);
      const adjusted = it.score * (1 - lambda) + recency * lambda * scoreScale(items);
      return {
        ...it,
        adjusted_score: adjusted,
        recency_factor: recency,
        age_days: ageDays,
      };
    })
    .sort((a, b) => {
      if (b.adjusted_score !== a.adjusted_score) {
        return b.adjusted_score - a.adjusted_score;
      }
      if (b.recency_factor !== a.recency_factor) {
        return b.recency_factor - a.recency_factor;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/**
 * Compute the recency factor for one timestamp without sorting anything.
 * Useful for callers that want to attach a recency badge to a single
 * result without running the whole list through rerank.
 */
export function recencyFactor(
  timestamp: string,
  opts: { halflifeDays?: number; now?: Date } = {},
): number {
  const halflife = Math.max(0.1, opts.halflifeDays ?? 180);
  const nowMs = (opts.now ?? new Date()).getTime();
  return computeRecency(computeAgeDays(timestamp, nowMs), halflife);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function computeAgeDays(timestamp: string, nowMs: number): number {
  const t = Date.parse(timestamp);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (nowMs - t) / MS_PER_DAY;
}

function computeRecency(ageDays: number, halflife: number): number {
  if (!Number.isFinite(ageDays)) return 0;
  if (ageDays <= 0) return 1.0; // future-dated, treat as fresh
  return Math.exp((-LN2 * ageDays) / halflife);
}

/**
 * Normalize the recency contribution into the same magnitude band as the
 * relevance scores. Without this, when relevance scores are tiny RRF
 * fractions (e.g. 0.015), lambda=0.3 on a 0..1 recency would dominate
 * the ranking entirely, defeating the "blend, do not replace" intent.
 *
 * Uses the max relevance score of the input as the scale anchor. Falls
 * back to 1.0 when the input is empty or all-zero (no harm: adjusted ==
 * recency * lambda in that case).
 */
function scoreScale(items: ScoredItem[]): number {
  let max = 0;
  for (const it of items) {
    if (Number.isFinite(it.score) && it.score > max) max = it.score;
  }
  return max > 0 ? max : 1.0;
}
