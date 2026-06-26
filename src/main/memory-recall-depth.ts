// memory-recall-depth.ts
//
// Adaptive-depth memory retrieval planner, inspired by CrewAI's RecallFlow.
// SecondBrain's recall path (BM25 search in memory-bm25.ts plus the multi-signal
// fusion in memory-multi-signal-fuse.ts) runs the SAME depth for every query.
// Most recalls are cheap and unambiguous; a few are broad and need the full
// fan-out plus rerank (for example, a short lookup like "what is the visa
// category" versus a broad "summarize the deal history"). Running full depth on
// every recall wastes latency and, when a rerank rung calls a model, tokens.
//
// This module is pure data-in/data-out. It classifies a query by cheap signals
// (length, token count, question words, vagueness markers, explicit entity
// hints) and returns a RecallPlan the caller uses to gate how much retrieval to
// do. It does NOT run any search itself and never touches the network.
//
//   shallow  -> small topK, no fusion, no rerank. Short or exact-looking lookups.
//   standard -> default topK, fusion on, no model rerank. The common case.
//   deep     -> large topK, fusion on, rerank allowed. Broad or vague queries.

export type RecallDepth = 'shallow' | 'standard' | 'deep';

export interface RecallPlan {
  depth: RecallDepth;
  // Suggested topK for the underlying BM25 search.
  topK: number;
  // Whether to run multi-signal fusion (entity + bm25 + temporal).
  useFusion: boolean;
  // Whether a model-backed rerank rung is worth its cost for this query.
  useRerank: boolean;
  // Human-readable justification for logs / observability.
  reason: string;
}

export interface RecallDepthPolicy {
  // A query at or below this many characters is a candidate for shallow.
  shortCharThreshold?: number; // default 24
  // A query at or above this many tokens is a candidate for deep.
  longTokenThreshold?: number; // default 12
  // topK per depth.
  shallowTopK?: number; // default 3
  standardTopK?: number; // default 5
  deepTopK?: number; // default 12
}

// Words that signal a broad, open-ended, or comparative ask. These push toward
// deep retrieval because a single best hit is unlikely to satisfy them.
const VAGUE_MARKERS = [
  'everything',
  'anything',
  'overview',
  'summarize',
  'summary',
  'history',
  'all the',
  'related to',
  'compare',
  'versus',
  'vs',
  'why',
  'how come',
  'context',
  'background',
];

// Question leads that usually map to a single fact. They keep a query shallow
// even if it is a few words long.
const POINTED_LEADS = ['what is', 'who is', 'when is', 'where is', "what's", "who's"];

/**
 * Plan recall depth for a query. Pure function. The caller passes the raw query
 * string; the planner returns how aggressively to retrieve. PRIVATE_NAME or empty
 * input falls back to a safe standard plan rather than throwing.
 */
export function planRecallDepth(query: string, policy: RecallDepthPolicy = {}): RecallPlan {
  const shortChars = policy.shortCharThreshold ?? 24;
  const longTokens = policy.longTokenThreshold ?? 12;
  const shallowTopK = policy.shallowTopK ?? 3;
  const standardTopK = policy.standardTopK ?? 5;
  const deepTopK = policy.deepTopK ?? 12;

  const q = (query ?? '').trim();
  if (!q) {
    return {
      depth: 'standard',
      topK: standardTopK,
      useFusion: true,
      useRerank: false,
      reason: 'empty query, default standard plan',
    };
  }

  const lower = q.toLowerCase();
  const tokens = lower.split(/\s+/).filter(Boolean);
  const tokenCount = tokens.length;
  const isVague = VAGUE_MARKERS.some((m) => lower.includes(m));
  const isPointed = POINTED_LEADS.some((l) => lower.startsWith(l));

  // Deep wins first: a long OR vague query needs the full fan-out, even if it
  // also happens to start with a pointed lead.
  if (isVague || tokenCount >= longTokens) {
    return {
      depth: 'deep',
      topK: deepTopK,
      useFusion: true,
      useRerank: true,
      reason: isVague
        ? 'vague or comparative marker present'
        : `long query (${tokenCount} tokens >= ${longTokens})`,
    };
  }

  // Shallow: short and exact-looking, or a pointed single-fact question.
  if ((q.length <= shortChars && tokenCount <= 4) || (isPointed && tokenCount <= 6)) {
    return {
      depth: 'shallow',
      topK: shallowTopK,
      useFusion: false,
      useRerank: false,
      reason: isPointed
        ? 'pointed single-fact lookup'
        : `short query (${q.length} chars, ${tokenCount} tokens)`,
    };
  }

  return {
    depth: 'standard',
    topK: standardTopK,
    useFusion: true,
    useRerank: false,
    reason: 'standard query, default depth',
  };
}
