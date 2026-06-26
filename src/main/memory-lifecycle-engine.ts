// memory-lifecycle-engine.ts
//
// Single tick() entry point that orchestrates the existing memory modules
// (dedup, contradiction, retention, archival) into one deterministic verdict
// per fact. Today every caller (sleep-time consolidation, briefing,
// approval-inbox, manual import scripts) reinvents which signal wins when
// dedup and contradiction-detection both fire, or when a retention score
// says "archive" but contradiction says "newer fact arrived".
//
// Backlog id memory-lifecycle-engine (priority 100, 2026-05-29). The
// underlying primitives all exist:
//   - memory-write-deduplicator.classifyWrite (ADD / UPDATE / SKIP)
//   - memory-contradiction-detector.detectContradictionsForCandidate
//   - memory-confidence-decay.computeRetention + selectArchivalCandidates
// What is missing is the precedence rule that fuses their outputs.
//
// Pattern sources (research 2026-05-29):
//   - Mem0 two-pass ADD/UPDATE/DELETE pipeline with id-preserving UPDATE
//     event (mem0/configs/prompts.py). Mem0 returns one verdict per
//     candidate fact; the same shape works here.
//   - Letta sleep-time compute (Letta v1 blog 2026): a background pass
//     reconciles memory between human interactions. The tick boundary
//     here is the same idea: pass a batch of candidates + existing facts
//     and get back a uniform action list ready to apply.
//   - Graphiti bi-temporal invalidation (getzep/graphiti): contradictions
//     produce INVALIDATE (set valid_to) events alongside the new ADD
//     rather than a destructive replace. The engine surfaces those as
//     CONTRADICT verdicts paired with the new ADD.
//
// Precedence rule (highest wins; first matching verdict is final):
//   1. SKIP        ... dedup classifier returned 'skip' for an exact /
//                      near-duplicate. The candidate is redundant.
//   2. CONTRADICT  ... candidate matches an existing (subject, predicate)
//                      pair but the object differs above the
//                      nearDuplicateThreshold. Emit ADD for the candidate
//                      AND invalidate the older fact.
//   3. UPDATE      ... dedup classifier returned 'update'. Same value,
//                      refresh asOf or confidence on the existing id.
//   4. ADD         ... no existing fact on (subject, predicate) at all.
//
// After the candidate verdicts are computed, the engine evaluates each
// EXISTING fact (and any fact promoted via ADD/UPDATE in this tick)
// against the retention threshold and emits ARCHIVE verdicts for any
// whose score falls below the configured floor.
//
// Pure module: no fs, no electron, no network. The caller passes the
// state in and applies the returned actions to whichever store backs the
// facts (Graphiti, sqlite, contact .md files).

import type {
  MemoryFact,
  ContradictionPair,
} from './memory-contradiction-detector';
import {
  detectContradictionsForCandidate,
} from './memory-contradiction-detector';
import {
  classifyWrite,
  WriteDecision,
  DeduplicateOptions,
} from './memory-write-deduplicator';
import {
  computeRetention,
  rankForRetention,
  selectArchivalCandidates,
  AccessSignal,
  RetentionScore,
  DecayOptions,
} from './memory-confidence-decay';

// ── Verdict types ────────────────────────────────────────────────────────────

export type LifecycleAction = 'add' | 'update' | 'skip' | 'contradict' | 'archive';

export interface LifecycleVerdict {
  action: LifecycleAction;
  // The candidate fact that triggered this verdict, when applicable.
  // For ARCHIVE verdicts this is null; the existing fact id lives in
  // existingFactId instead.
  candidate?: MemoryFact;
  // For UPDATE / SKIP / ARCHIVE: the existing fact id involved.
  existingFactId?: string;
  // For CONTRADICT: the older existing fact that should be invalidated
  // (valid_to set, in Graphiti terms). The candidate is still ADDed.
  invalidates?: ContradictionPair;
  // Confidence the engine has in this verdict in [0, 1]. Aggregates the
  // dedup confidence and the contradiction strength.
  confidence: number;
  // Single-sentence reason suitable for an agent-decision-log entry.
  reason: string;
  // For ARCHIVE: the retention score that produced the verdict.
  retention?: RetentionScore;
}

export interface LifecycleSummary {
  add: number;
  update: number;
  skip: number;
  contradict: number;
  archive: number;
}

// ── Input ────────────────────────────────────────────────────────────────────

export interface LifecycleTickInput {
  // New facts arriving in this tick. May be empty when running a pure
  // retention-only sweep (e.g. nightly archival pass).
  candidates: MemoryFact[];
  // The full set of currently-live facts the engine should consider.
  // For very large stores the caller should pre-filter to the same
  // subject(s) as the candidates plus any facts due for retention review.
  existing: MemoryFact[];
  // Access signal per fact id. Missing entries default to zero reads.
  // Only required for the retention pass; pass {} to skip retention.
  accessByFactId?: Record<string, AccessSignal>;
}

export interface LifecycleTickOptions {
  // Dedup classifier knobs.
  dedup?: DeduplicateOptions;
  // Contradiction-detector knobs. Forwarded to
  // detectContradictionsForCandidate.
  contradictionMinStrength?: number;
  contradictionMinAgeGapHours?: number;
  // Retention scoring knobs.
  decay?: DecayOptions;
  // Retention score floor; facts at or below this score are archived.
  // Default 0.2. Pass 0 to disable retention archival.
  archiveBelow?: number;
  // Optional fact-ids that the retention pass MUST skip (e.g. the engine
  // already emitted a CONTRADICT verdict for them; archiving the older
  // side twice would be incoherent).
  excludeFromRetention?: Set<string>;
}

const DEFAULT_OPTIONS: Required<Omit<LifecycleTickOptions, 'dedup' | 'decay' | 'excludeFromRetention'>> = {
  contradictionMinStrength: 0.2,
  contradictionMinAgeGapHours: 1,
  archiveBelow: 0.2,
};

// ── Core ─────────────────────────────────────────────────────────────────────

/**
 * Run one lifecycle tick. For each candidate emits exactly one of
 * {ADD, UPDATE, SKIP, CONTRADICT} (CONTRADICT implies the candidate is
 * also added). Then evaluates retention over the live set and emits
 * ARCHIVE for any fact whose retention score falls below archiveBelow.
 *
 * Verdicts are deterministic: same inputs in, same verdicts out, same
 * order. Callers can persist the verdict list as a JSONL audit trail.
 */
export function tick(
  input: LifecycleTickInput,
  options: LifecycleTickOptions = {},
): { verdicts: LifecycleVerdict[]; summary: LifecycleSummary } {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const verdicts: LifecycleVerdict[] = [];
  const invalidatedIds = new Set<string>(options.excludeFromRetention ?? []);

  // 1. Candidate phase: ADD / UPDATE / SKIP / CONTRADICT
  for (const cand of input.candidates) {
    const dedup = classifyWrite(cand, input.existing, opts.dedup);

    if (dedup.action === 'skip') {
      verdicts.push({
        action: 'skip',
        candidate: cand,
        existingFactId: dedup.matchedExistingId,
        confidence: dedup.confidence,
        reason: `dedup: ${dedup.reason}`,
      });
      continue;
    }

    if (dedup.action === 'update') {
      verdicts.push({
        action: 'update',
        candidate: cand,
        existingFactId: dedup.matchedExistingId,
        confidence: dedup.confidence,
        reason: `dedup: ${dedup.reason}`,
      });
      continue;
    }

    // dedup.action === 'add': check for contradiction before emitting.
    const contradictions = detectContradictionsForCandidate(cand, input.existing, {
      minStrength: opts.contradictionMinStrength,
      minAgeGapHours: opts.contradictionMinAgeGapHours,
    });

    if (contradictions.length > 0) {
      // The dedup classifier already flagged "no near-duplicate found" so
      // every contradiction here represents an older asOf with a
      // different object. Emit the ADD for the candidate AND a CONTRADICT
      // verdict per older fact that loses.
      verdicts.push({
        action: 'add',
        candidate: cand,
        confidence: aggregateAddConfidence(dedup, contradictions),
        reason: `add: ${cand.subject}/${cand.predicate} (replaces ${contradictions.length} older)`,
      });
      for (const pair of contradictions) {
        verdicts.push({
          action: 'contradict',
          candidate: cand,
          existingFactId: pair.older.id,
          invalidates: pair,
          confidence: pair.strength,
          reason: contradictionReason(pair),
        });
        invalidatedIds.add(pair.older.id);
      }
      continue;
    }

    // Plain ADD: no existing match, no contradiction.
    verdicts.push({
      action: 'add',
      candidate: cand,
      confidence: dedup.confidence,
      reason: `add: ${dedup.reason}`,
    });
  }

  // 2. Retention phase: ARCHIVE
  if (opts.archiveBelow > 0 && input.accessByFactId) {
    const accessByFactId = input.accessByFactId;
    const eligible = input.existing.filter((f) => !invalidatedIds.has(f.id));
    const ranked = rankForRetention(
      eligible.map((f) => ({
        fact: f,
        access: accessByFactId[f.id] ?? { readCount: 0, lastReadAt: null },
      })),
      opts.decay,
    );
    const archiveCandidates = selectArchivalCandidates(ranked, opts.archiveBelow);
    const factById = new Map(input.existing.map((f) => [f.id, f]));
    for (const score of archiveCandidates) {
      const fact = factById.get(score.factId);
      verdicts.push({
        action: 'archive',
        existingFactId: score.factId,
        confidence: 1 - score.score,
        reason: `retention: ${score.explanation}`,
        retention: score,
        candidate: fact,
      });
    }
  }

  return { verdicts, summary: summarize(verdicts) };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function summarize(verdicts: LifecycleVerdict[]): LifecycleSummary {
  const out: LifecycleSummary = { add: 0, update: 0, skip: 0, contradict: 0, archive: 0 };
  for (const v of verdicts) out[v.action] += 1;
  return out;
}

function aggregateAddConfidence(
  dedup: WriteDecision,
  contradictions: ContradictionPair[],
): number {
  // When the dedup classifier flagged "no near-duplicate found" at low
  // confidence, the contradiction signal upgrades the verdict. Take the
  // max of dedup confidence and the strongest contradiction signal.
  const strongest = contradictions.reduce((m, c) => Math.max(m, c.strength), 0);
  return Math.max(dedup.confidence, strongest);
}

function contradictionReason(pair: ContradictionPair): string {
  return (
    `contradicts older ${pair.older.subject}/${pair.older.predicate}=` +
    `"${pair.older.object}" (strength ${pair.strength.toFixed(2)}, ` +
    `gap ${pair.ageGapHours.toFixed(1)}h)`
  );
}

// ── Convenience: per-fact retention without candidates ───────────────────────

/**
 * Run JUST the retention pass over a fact set, no candidate processing.
 * Useful for a nightly archival sweep that has no new candidates to
 * consider. Returns the ARCHIVE verdicts in weakest-first order.
 */
export function retentionTick(
  facts: MemoryFact[],
  accessByFactId: Record<string, AccessSignal>,
  options: Pick<LifecycleTickOptions, 'decay' | 'archiveBelow' | 'excludeFromRetention'> = {},
): LifecycleVerdict[] {
  const archiveBelow = options.archiveBelow ?? DEFAULT_OPTIONS.archiveBelow;
  if (archiveBelow <= 0) return [];
  const excluded = options.excludeFromRetention ?? new Set<string>();
  const eligible = facts.filter((f) => !excluded.has(f.id));
  const ranked = rankForRetention(
    eligible.map((f) => ({
      fact: f,
      access: accessByFactId[f.id] ?? { readCount: 0, lastReadAt: null },
    })),
    options.decay,
  );
  const archiveCandidates = selectArchivalCandidates(ranked, archiveBelow);
  const factById = new Map(facts.map((f) => [f.id, f]));
  return archiveCandidates.map((score) => ({
    action: 'archive' as const,
    existingFactId: score.factId,
    confidence: 1 - score.score,
    reason: `retention: ${score.explanation}`,
    retention: score,
    candidate: factById.get(score.factId),
  }));
}

/**
 * Score a single fact without applying any verdict logic. Thin wrapper
 * over computeRetention so callers do not have to import two modules
 * when they only want to know "is this fact load-bearing?".
 */
export function scoreFact(
  fact: MemoryFact,
  access: AccessSignal,
  options: DecayOptions = {},
): RetentionScore {
  return computeRetention(fact, access, options);
}
