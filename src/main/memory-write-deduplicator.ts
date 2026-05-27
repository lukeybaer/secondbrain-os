// memory-write-deduplicator.ts
//
// At write time, classify an incoming fact against the existing memory
// as ADD (genuinely new), UPDATE (a newer version of an existing fact),
// or SKIP (redundant, already known).
//
// Why this matters for Amy: today, every ingest path (Gmail, Otter,
// LinkedIn nightly, call-extract, manual edits in the dashboard) writes
// into Tier 2 with no guard against re-ingesting the same fact under a
// new id. Over weeks the same claim ("Bryant is at PixSeat") appears
// dozens of times across contact history, briefing dispatches, and
// agent-extracted notes. Retrieval surfaces all of them, the briefing
// repeats them, and the noise floor rises.
//
// Pattern source: mem0's April 2026 "ADD-only with extraction"
// (mem0ai/mem0) - one LLM call produces ADD/UPDATE/NOOP per candidate
// against the recall set, never overwriting silently. This module is
// the deterministic triage layer the LLM call would normally guard:
// most candidates (exact duplicates from a re-pull, near-duplicates
// after whitespace+case normalization, same-(subject,predicate)-same-
// object refreshes) can be classified without an LLM call at all, so
// the LLM only sees genuine novelty.
//
// Distinct from:
//   - memory-contradiction-detector.ts: same (subject, predicate),
//     DIFFERENT object => contradiction (caller decides what to do).
//     This module covers same (subject, predicate), SAME object =>
//     dedup or update by recency.
//   - memory-multi-signal-fuse.ts: read-time relevance ranking, not
//     write-time triage.
//   - memory-temperature.ts / -temporal-rerank.ts: scoring of facts
//     that are already in the store.
//
// Pure module: no fs, no electron, no network. Caller passes the
// candidate plus the existing facts, gets back a decision.

import type { MemoryFact } from './memory-contradiction-detector';

// Types

export type WriteAction = 'add' | 'update' | 'skip';

export interface WriteDecision {
  action: WriteAction;
  // The existing fact that triggered the update or skip, if any.
  // Always set for 'update' and 'skip'; undefined for 'add'.
  matchedExistingId?: string;
  // 0..1 confidence that the chosen action is correct. Useful for
  // routing ambiguous candidates to LLM-call review instead of acting
  // on them automatically.
  confidence: number;
  // One-line reason, suitable for an agent-decision-log entry.
  reason: string;
}

export interface DeduplicateOptions {
  // Two object strings are considered "same value" when their
  // normalized forms match. Default: trim + lowercase + collapse
  // internal whitespace.
  normalizeObject?: (object: string) => string;
  // When the candidate matches an existing fact with the same object
  // but a NEWER asOf, the action is 'update' (refresh asOf). When the
  // existing fact is newer or equal, the action is 'skip'.
  // This threshold (in hours) is the minimum freshness gap required
  // to count as an update. Default 24h, so a re-pull within a day is
  // treated as a duplicate.
  updateFreshnessHours?: number;
  // When the candidate's confidence beats the existing fact's
  // confidence by at least this delta, an 'update' is allowed even
  // if the asOf gap is below updateFreshnessHours. Default 0.25.
  updateConfidenceDelta?: number;
  // String-similarity threshold in [0, 1] for "near-duplicate"
  // detection on the object. Below this, treat as a different value
  // and defer to the contradiction-detector instead of skipping.
  // Default 0.85 (token-set Jaccard).
  nearDuplicateThreshold?: number;
}

const DEFAULT_OPTS: Required<DeduplicateOptions> = {
  normalizeObject: (s: string) =>
    s.trim().toLowerCase().replace(/\s+/g, ' '),
  updateFreshnessHours: 24,
  updateConfidenceDelta: 0.25,
  nearDuplicateThreshold: 0.85,
};

// Core: classify the candidate against the existing facts.
//
// Algorithm:
//   1. Filter existing facts to the same (subject, predicate) group.
//      Different subject or predicate => no match possible.
//   2. Among that group, look for an existing fact whose normalized
//      object equals or near-matches the candidate's normalized object.
//   3. If no match: action = 'add'.
//   4. If matched and candidate is meaningfully newer (or higher-
//      confidence): action = 'update'.
//   5. Otherwise: action = 'skip'.
export function classifyWrite(
  candidate: MemoryFact,
  existing: MemoryFact[],
  options: DeduplicateOptions = {},
): WriteDecision {
  const opts = { ...DEFAULT_OPTS, ...options };

  const sameKey = existing.filter(
    (e) => e.subject === candidate.subject && e.predicate === candidate.predicate,
  );

  if (sameKey.length === 0) {
    return {
      action: 'add',
      confidence: 1,
      reason: 'no existing fact on this (subject, predicate)',
    };
  }

  const candObj = opts.normalizeObject(candidate.object);
  const candTs = Date.parse(candidate.asOf);
  const candConf = candidate.confidence ?? 0.5;

  // Best match: highest similarity, then newest, then highest confidence.
  let best: { fact: MemoryFact; similarity: number } | null = null;
  for (const e of sameKey) {
    const eObj = opts.normalizeObject(e.object);
    let sim: number;
    if (candObj === eObj) sim = 1;
    else sim = tokenSetJaccard(candObj, eObj);
    if (best === null || sim > best.similarity) {
      best = { fact: e, similarity: sim };
    }
  }

  // If the best match is below the near-duplicate threshold, the
  // candidate is asserting a different value: this is contradiction
  // territory, not dedup territory. Hand off by emitting an 'add' with
  // a low-confidence reason so the caller can route it to the
  // contradiction-detector.
  if (best === null || best.similarity < opts.nearDuplicateThreshold) {
    return {
      action: 'add',
      confidence: 0.5,
      reason: `no near-duplicate found (best similarity ${(best?.similarity ?? 0).toFixed(2)}); caller should also check contradictions`,
    };
  }

  const eTs = Date.parse(best.fact.asOf);
  const eConf = best.fact.confidence ?? 0.5;
  const freshnessHours = Number.isFinite(candTs) && Number.isFinite(eTs)
    ? (candTs - eTs) / 3_600_000
    : 0;
  const confidenceAdvantage = candConf - eConf;

  // Update if the candidate is meaningfully newer OR meaningfully
  // higher-confidence (e.g. a manual entry beating an auto-extracted one).
  if (
    freshnessHours >= opts.updateFreshnessHours ||
    confidenceAdvantage >= opts.updateConfidenceDelta
  ) {
    const reason =
      freshnessHours >= opts.updateFreshnessHours
        ? `same value, candidate is ${freshnessHours.toFixed(1)}h newer (>= ${opts.updateFreshnessHours}h)`
        : `same value, candidate confidence beats existing by ${confidenceAdvantage.toFixed(2)} (>= ${opts.updateConfidenceDelta})`;
    return {
      action: 'update',
      matchedExistingId: best.fact.id,
      confidence: Math.min(1, 0.6 + 0.4 * best.similarity),
      reason,
    };
  }

  return {
    action: 'skip',
    matchedExistingId: best.fact.id,
    confidence: Math.min(1, 0.6 + 0.4 * best.similarity),
    reason: best.similarity === 1
      ? 'exact duplicate of existing fact, no freshness or confidence advantage'
      : `near-duplicate (similarity ${best.similarity.toFixed(2)}), no freshness or confidence advantage`,
  };
}

// Token-set Jaccard similarity on normalized object strings.
//
// This is the same shape used by mem0's near-duplicate detection in
// their multi-signal retrieval (token-overlap is one of three signals).
// Cheap, no embeddings, robust to word order. We split on whitespace
// only; for short phrase-like objects ("McKinney TX 75071") this is
// plenty.
function tokenSetJaccard(a: string, b: string): number {
  const ta = new Set(a.split(/\s+/).filter(Boolean));
  const tb = new Set(b.split(/\s+/).filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return inter / union;
}

// Convenience: classify a batch of candidates at once.
//
// Each candidate is classified against the original existing set;
// candidates do NOT see each other (the caller decides ordering if
// they want to chain). Returns decisions in input order.
export function classifyWrites(
  candidates: MemoryFact[],
  existing: MemoryFact[],
  options: DeduplicateOptions = {},
): WriteDecision[] {
  return candidates.map((c) => classifyWrite(c, existing, options));
}

// Summarise a batch decision for the briefing.
//
// Returns counts of each action plus the human-readable reasons that
// triggered any 'skip' or 'update'. Useful as a daily ledger entry.
export function summariseDecisions(decisions: WriteDecision[]): {
  add: number;
  update: number;
  skip: number;
  total: number;
  reasons: string[];
} {
  let add = 0;
  let update = 0;
  let skip = 0;
  const reasons: string[] = [];
  for (const d of decisions) {
    if (d.action === 'add') add++;
    else if (d.action === 'update') {
      update++;
      reasons.push(`UPDATE ${d.matchedExistingId}: ${d.reason}`);
    } else {
      skip++;
      reasons.push(`SKIP ${d.matchedExistingId}: ${d.reason}`);
    }
  }
  return { add, update, skip, total: decisions.length, reasons };
}
