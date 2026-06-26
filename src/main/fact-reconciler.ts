// fact-reconciler.ts
//
// Deterministically MERGE a contradiction pair into a single reconciled fact
// with provenance and a superseded-history trail. This is the consolidation
// step that sits AFTER memory-contradiction-detector.ts:
//
//   detectContradictions()  -> finds disagreeing (subject, predicate) facts
//   reconcile()             -> picks the winner, closes the loser's validity
//                              window, and emits ONE canonical record
//
// Pattern synthesized from:
//   - CrewAI Cognition Memory (2026): "consolidation on encode" merges
//     competing facts into a single coherent record (e.g. DB Postgres->MySQL)
//     instead of storing both, rather than leaving two live rows.
//   - Letta memory blocks: a fact has a value + an auditable supersede trail;
//     the loser is not deleted, it is marked superseded_by with its validity
//     window closed so history is recoverable.
//   - Bitemporal modeling (valid-time vs transaction-time): the winner's
//     validFrom and the loser's invalidatedAt give a closed interval per fact.
//
// Why SecondBrain needs this:
//   memory-contradiction-detector only DETECTS (a subject's title is VP vs
//   "...is SVP"); sleep-time-consolidation LLM-summarizes whole blocks. Nothing
//   deterministically turns the pair into one current fact. Without it a call
//   script or briefing can still quote the stale row because BOTH survive.
//
// Pure module: no electron, no network, no fs. Input -> output only.

import type { MemoryFact, ContradictionPair } from './memory-contradiction-detector';

// ── Policy ────────────────────────────────────────────────────────────────

export type ResolutionPolicy = 'recency' | 'confidence' | 'source-priority';

export interface ReconcilePolicy {
  // How to pick the winner when two facts disagree.
  policy: ResolutionPolicy;
  // For 'source-priority': sources earlier in the list outrank later ones.
  // A source not present in the list ranks below every listed source.
  sourcePriority?: ReadonlyArray<string>;
  // Normalizer used to decide whether the two objects actually AGREE
  // (in which case this is a dedup, not a conflict). Default: trim+lowercase,
  // matching memory-contradiction-detector's default.
  normalizeObject?: (object: string) => string;
}

const DEFAULT_NORMALIZE = (s: string): string => s.trim().toLowerCase();
const DEFAULT_CONFIDENCE = 0.5;

// ── Output ──────────────────────────────────────────────────────────────

export interface SupersededFact {
  id: string;
  object: string;
  asOf: string;
  // The loser's validity window is closed at the winner's asOf: from this
  // instant forward the loser is no longer the current value.
  invalidatedAt: string;
  confidence: number;
  source?: string;
}

export interface ReconciledFact {
  subject: string;
  predicate: string;
  // The canonical, current value.
  object: string;
  // Identity + provenance of the winning fact.
  winnerId: string;
  validFrom: string; // winner.asOf
  confidence: number;
  source?: string;
  // The loser ExampleCod forward, or null when the two facts agreed (dedup).
  superseded: SupersededFact | null;
  // True when the two facts asserted the SAME value (after normalization):
  // there was no real conflict, just a duplicate ingest. The newer row wins,
  // the older is dropped (superseded === null).
  agreed: boolean;
  // Human-readable rationale, e.g. "recency: 2026-06-05 > 2026-05-01".
  reason: string;
}

// ── Core ────────────────────────────────────────────────────────────────

function conf(f: MemoryFact): number {
  return typeof f.confidence === 'number' ? f.confidence : DEFAULT_CONFIDENCE;
}

function newer(a: MemoryFact, b: MemoryFact): MemoryFact {
  // Later asOf wins; on an exact tie keep `a` (caller-stable order).
  return Date.parse(b.asOf) > Date.parse(a.asOf) ? b : a;
}

function sourceRank(source: string | undefined, priority: ReadonlyArray<string>): number {
  if (!source) return priority.length; // ExampleCo source ranks last
  const i = priority.indexOf(source);
  return i === -1 ? priority.length : i;
}

/**
 * Pick the winner of two facts under the given policy, returning the winner,
 * the loser, and a one-line reason. Ties always degrade to recency, then to
 * the caller's argument order (a before b) so the result is deterministic.
 */
function pickWinner(
  a: MemoryFact,
  b: MemoryFact,
  policy: ReconcilePolicy,
): { winner: MemoryFact; loser: MemoryFact; reason: string } {
  switch (policy.policy) {
    case 'confidence': {
      const ca = conf(a);
      const cb = conf(b);
      if (ca !== cb) {
        const winner = ca > cb ? a : b;
        const loser = winner === a ? b : a;
        return { winner, loser, reason: `confidence: ${conf(winner)} > ${conf(loser)}` };
      }
      const winner = newer(a, b);
      const loser = winner === a ? b : a;
      return { winner, loser, reason: `confidence tie (${ca}), fell back to recency: ${winner.asOf} >= ${loser.asOf}` };
    }
    case 'source-priority': {
      const priority = policy.sourcePriority ?? [];
      const ra = sourceRank(a.source, priority);
      const rb = sourceRank(b.source, priority);
      if (ra !== rb) {
        const winner = ra < rb ? a : b;
        const loser = winner === a ? b : a;
        return { winner, loser, reason: `source-priority: ${winner.source ?? '(none)'} outranks ${loser.source ?? '(none)'}` };
      }
      const winner = newer(a, b);
      const loser = winner === a ? b : a;
      return { winner, loser, reason: `source tie (${a.source ?? '(none)'}), fell back to recency: ${winner.asOf} >= ${loser.asOf}` };
    }
    case 'recency':
    default: {
      const winner = newer(a, b);
      const loser = winner === a ? b : a;
      return { winner, loser, reason: `recency: ${winner.asOf} >= ${loser.asOf}` };
    }
  }
}

/**
 * Reconcile two facts about the SAME (subject, predicate) into one canonical
 * record. Throws if the facts are not about the same subject+predicate, since
 * that is a caller error (they belong to different rows, not a conflict).
 */
export function reconcile(
  a: MemoryFact,
  b: MemoryFact,
  policy: ReconcilePolicy = { policy: 'recency' },
): ReconciledFact {
  if (a.subject !== b.subject || a.predicate !== b.predicate) {
    throw new Error(
      `reconcile: facts are not about the same (subject, predicate): ` +
        `(${a.subject}, ${a.predicate}) vs (${b.subject}, ${b.predicate})`,
    );
  }

  const normalize = policy.normalizeObject ?? DEFAULT_NORMALIZE;
  const agreed = normalize(a.object) === normalize(b.object);

  if (agreed) {
    // No real conflict: keep the newer assertion, drop the duplicate.
    const winner = newer(a, b);
    return {
      subject: winner.subject,
      predicate: winner.predicate,
      object: winner.object,
      winnerId: winner.id,
      validFrom: winner.asOf,
      confidence: conf(winner),
      source: winner.source,
      superseded: null,
      agreed: true,
      reason: `agreed values, deduped to newer fact (${winner.asOf})`,
    };
  }

  const { winner, loser, reason } = pickWinner(a, b, policy);
  return {
    subject: winner.subject,
    predicate: winner.predicate,
    object: winner.object,
    winnerId: winner.id,
    validFrom: winner.asOf,
    confidence: conf(winner),
    source: winner.source,
    superseded: {
      id: loser.id,
      object: loser.object,
      asOf: loser.asOf,
      invalidatedAt: winner.asOf,
      confidence: conf(loser),
      source: loser.source,
    },
    agreed: false,
    reason,
  };
}

/**
 * Reconcile a batch of contradiction pairs (the output of
 * detectContradictions) into canonical records, one per pair. Pairs are
 * already grouped by (subject, predicate) and ordered newer/older.
 */
export function reconcilePairs(
  pairs: ReadonlyArray<ContradictionPair>,
  policy: ReconcilePolicy = { policy: 'recency' },
): ReconciledFact[] {
  return pairs.map((p) => reconcile(p.newer, p.older, policy));
}
