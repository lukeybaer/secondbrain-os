// memory-confidence-decay.ts
//
// Compute a single retention score per memory fact that blends four
// independent signals into one comparable number: base confidence (was
// this fact trusted when written?), freshness (Ebbinghaus forgetting
// curve over time since asOf), access intensity (how often / how
// recently has anything read this fact?), and pinning (predicate-level
// or subject-level rules that keep a fact alive regardless of cold-
// ness, e.g. user_profile, AMY_REQUIREMENTS, immigration filings).
//
// Why this matters for Amy: memory-temperature.ts measures access
// hotness, memory-temporal-rerank.ts measures freshness of fact, and
// memory-archival-recommender.ts uses temperature alone to decide
// archive moves. None of them weighs source confidence (a manually
// curated `user_profile` line vs. an auto-extracted call snippet) or
// honors a pinning rule. This module is the missing single score that
// composes all four signals so the briefing card, the archival job,
// and the prompt-builder all agree on which facts are "load-bearing"
// and which are noise.
//
// Pattern source: Letta sleep-time consolidation (Letta v0.7 docs
// 2026-03) which classifies memory into core / archival based on a
// blended retention score; agentmemory's 4-tier consolidation pattern
// (ExampleCog00/agentmemory) which adds an explicit base-confidence
// factor and pinning rules; Ebbinghaus 1885 / Anderson 1991 ACT-R
// declarative-memory activation as the freshness curve.
//
// Distinct from:
//   - memory-temperature.ts: counts access events only.
//   - memory-temporal-rerank.ts: blends freshness into a relevance
//     score for a single query. Per-query, not per-fact.
//   - memory-archival-recommender.ts: temperature + persistence ->
//     archive recommendations. This module produces the *retention
//     score* the recommender (or sleep-time-consolidation) can use
//     instead of bare temperature.
//
// Pure module: no fs, no electron, no network. Caller passes the
// inputs in, gets the score out.

import type { MemoryFact } from './memory-contradiction-detector';

// Types

export interface AccessSignal {
  // Number of times this fact has been read in the window the caller
  // cares about (e.g. last 30 days).
  readCount: number;
  // ISO timestamp of the most recent read, or null if never read.
  lastReadAt: string | null;
}

export interface PinningRule {
  // Match by exact subject (e.g. "user_profile"), by predicate
  // (e.g. "immigration_status"), or by a custom predicate function.
  subject?: string;
  predicate?: string;
  match?: (fact: MemoryFact) => boolean;
  // Boost added to the retention score (clamped to [0, 1]). 1.0 means
  // "never archive this fact regardless of other signals".
  boost: number;
  // Optional rationale, surfaced in the explanation.
  reason?: string;
}

export interface RetentionScore {
  factId: string;
  score: number; // 0..1
  baseConfidence: number;
  freshness: number;
  accessIntensity: number;
  pinning: number;
  appliedRules: string[];
  explanation: string;
}

export interface DecayOptions {
  // Half-life in days for the Ebbinghaus freshness curve. After this
  // many days a fact's freshness component decays to 0.5. Default 180
  // days for general facts; pass 14 for current-state queries and
  // 365+ for stable identity facts like birth date or wife name.
  halfLifeDays?: number;
  // Half-life in days for access intensity decay. Default 30 days.
  accessHalfLifeDays?: number;
  // Cap on the access-intensity component before blending; prevents a
  // single hot fact from dominating the score. Default 1.0 (no cap
  // beyond the natural saturation).
  accessCap?: number;
  // Blend weights for the four components. Defaults sum to 1:
  // base 0.20, freshness 0.30, access 0.20, pinning 0.30.
  // Weights are renormalized if they do not sum to 1.
  weights?: {
    baseConfidence?: number;
    freshness?: number;
    accessIntensity?: number;
    pinning?: number;
  };
  // Pinning rules applied in order. The highest matching boost wins
  // (rules don't stack), so the strongest pin dominates.
  pinningRules?: PinningRule[];
  // Clock injection for tests.
  now?: Date;
}

const DEFAULT_WEIGHTS = {
  baseConfidence: 0.2,
  freshness: 0.3,
  accessIntensity: 0.2,
  pinning: 0.3,
};

const DEFAULT_HALF_LIFE_DAYS = 180;
const DEFAULT_ACCESS_HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 86_400_000;

// Core: compute the retention score for a single fact

export function computeRetention(
  fact: MemoryFact,
  access: AccessSignal,
  options: DecayOptions = {},
): RetentionScore {
  const now = options.now ?? new Date();
  const halfLifeDays = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const accessHalfLifeDays = options.accessHalfLifeDays ?? DEFAULT_ACCESS_HALF_LIFE_DAYS;
  const accessCap = options.accessCap ?? 1.0;
  const weights = normalizeWeights(options.weights);

  // Base confidence: trust at the moment of write. Missing => 0.5.
  const baseConfidence = clamp01(fact.confidence ?? 0.5);

  // Freshness: exponential decay from asOf. Future timestamps capped
  // at 1, unparseable timestamps treated as ancient (0.05 floor).
  const factTs = Date.parse(fact.asOf);
  let freshness: number;
  if (!Number.isFinite(factTs)) {
    freshness = 0.05;
  } else {
    const ageDays = Math.max(0, (now.getTime() - factTs) / MS_PER_DAY);
    freshness = Math.pow(0.5, ageDays / halfLifeDays);
  }

  // Access intensity: blend read count (saturating) with recency of
  // the most recent read.
  const countFactor = 1 - Math.exp(-access.readCount / 5); // ~0.63 at 5 reads, ~0.86 at 10
  let recencyFactor = 0;
  if (access.lastReadAt) {
    const readTs = Date.parse(access.lastReadAt);
    if (Number.isFinite(readTs)) {
      const ageDays = Math.max(0, (now.getTime() - readTs) / MS_PER_DAY);
      recencyFactor = Math.pow(0.5, ageDays / accessHalfLifeDays);
    }
  }
  const accessIntensity = clamp01(
    Math.min(accessCap, 0.5 * countFactor + 0.5 * recencyFactor),
  );

  // Pinning: highest matching boost wins.
  const { pinning, appliedRules } = applyPinning(fact, options.pinningRules ?? []);

  const score = clamp01(
    weights.baseConfidence * baseConfidence +
      weights.freshness * freshness +
      weights.accessIntensity * accessIntensity +
      weights.pinning * pinning,
  );

  const explanation = formatExplanation({
    baseConfidence,
    freshness,
    accessIntensity,
    pinning,
    weights,
    score,
    appliedRules,
  });

  return {
    factId: fact.id,
    score,
    baseConfidence,
    freshness,
    accessIntensity,
    pinning,
    appliedRules,
    explanation,
  };
}

// Score a batch and return them sorted weakest-first (so the caller
// can take the head of the list for archival candidates).
export function rankForRetention(
  facts: Array<{ fact: MemoryFact; access: AccessSignal }>,
  options: DecayOptions = {},
): RetentionScore[] {
  const scored = facts.map((f) => computeRetention(f.fact, f.access, options));
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.factId < b.factId ? -1 : 1; // deterministic tie-break
  });
  return scored;
}

// Filter to facts whose retention score falls below a threshold. The
// archival recommender / sleep-time consolidation can use this directly:
// any returned fact is a candidate for archive (or for re-verification
// if the caller would rather refresh than archive).
export function selectArchivalCandidates(
  scores: RetentionScore[],
  threshold: number,
): RetentionScore[] {
  return scores.filter((s) => s.score < threshold);
}

// Helpers

function normalizeWeights(
  weights: DecayOptions['weights'],
): Required<NonNullable<DecayOptions['weights']>> {
  const w = { ...DEFAULT_WEIGHTS, ...(weights ?? {}) };
  const total =
    w.baseConfidence + w.freshness + w.accessIntensity + w.pinning;
  if (total <= 0) return { ...DEFAULT_WEIGHTS };
  return {
    baseConfidence: w.baseConfidence / total,
    freshness: w.freshness / total,
    accessIntensity: w.accessIntensity / total,
    pinning: w.pinning / total,
  };
}

function applyPinning(
  fact: MemoryFact,
  rules: PinningRule[],
): { pinning: number; appliedRules: string[] } {
  let pinning = 0;
  const applied: string[] = [];
  for (const rule of rules) {
    if (rule.subject !== undefined && rule.subject !== fact.subject) continue;
    if (rule.predicate !== undefined && rule.predicate !== fact.predicate) continue;
    if (rule.match && !rule.match(fact)) continue;
    if (rule.boost > pinning) pinning = clamp01(rule.boost);
    applied.push(rule.reason ?? `pin(${rule.subject ?? '*'}/${rule.predicate ?? '*'})`);
  }
  return { pinning, appliedRules: applied };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function formatExplanation(parts: {
  baseConfidence: number;
  freshness: number;
  accessIntensity: number;
  pinning: number;
  weights: { baseConfidence: number; freshness: number; accessIntensity: number; pinning: number };
  score: number;
  appliedRules: string[];
}): string {
  const w = parts.weights;
  const pin = parts.appliedRules.length > 0
    ? ` pin[${parts.appliedRules.join(', ')}]`
    : '';
  return (
    `score ${parts.score.toFixed(3)} = ` +
    `${w.baseConfidence.toFixed(2)}*conf(${parts.baseConfidence.toFixed(2)}) + ` +
    `${w.freshness.toFixed(2)}*fresh(${parts.freshness.toFixed(2)}) + ` +
    `${w.accessIntensity.toFixed(2)}*access(${parts.accessIntensity.toFixed(2)}) + ` +
    `${w.pinning.toFixed(2)}*pin(${parts.pinning.toFixed(2)})${pin}`
  );
}
