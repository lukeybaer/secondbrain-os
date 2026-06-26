// memory-contradiction-detector.ts
//
// Detect when two memory facts assert different objects for the same
// (subject, predicate) pair, so the caller can mark the older one
// invalidated rather than silently keeping both.
//
// Why this matters for Amy: today, contact files, project notes, and
// agent-extracted facts accumulate freely. When ExampleCo moves house, gets a
// new job title, or changes a project deadline, the new fact is written
// next to the old one and no module is responsible for noticing the
// disagreement. Retrieval-time multi-signal fusion happily surfaces both,
// and the briefing or a call script can quote the stale one.
//
// Pattern source: Graphiti's bi-temporal fact invalidation
// (github.com/getzep/graphiti) - facts have validity windows; when a
// contradiction arrives the older fact is marked invalid (valid_to set)
// rather than deleted, preserving the audit trail. This module is the
// detection half: it does not write anywhere, it only returns the set of
// contradiction candidates so the caller (sleep-time consolidation, the
// briefing, an approval-inbox entry) decides what to do.
//
// Distinct from:
//   - memory-write-deduplicator.ts: same subject+predicate AND same object
//     (redundant, not contradictory). dedup decides ADD/UPDATE/SKIP.
//   - memory-temporal-rerank.ts: relevance reranking, not contradiction.
//   - belief-revision.ts: full belief-revision over confidences. This is
//     just structural disagreement detection.
//
// Pure module: no fs, no electron, no network. Caller passes facts in,
// gets contradictions out. Tests use plain JS objects.

// Types

export interface MemoryFact {
  // Stable id of this fact (so the caller can mark/move/delete it).
  id: string;
  // The thing the fact is about. Normalize before passing in
  // (lowercased, trimmed, contact-id rather than display name).
  subject: string;
  // The relation. Same normalization rules as subject.
  predicate: string;
  // The asserted value. Strings only here; the caller is responsible
  // for stringifying structured objects before comparison.
  object: string;
  // ISO timestamp of when the fact was written or last verified.
  // Used to pick which side of a contradiction is the "newer" one.
  asOf: string;
  // Optional confidence in [0, 1]. When set, contradictions where the
  // newer fact is also higher-confidence are stronger signals. Missing
  // confidence is treated as 0.5.
  confidence?: number;
  // Optional source tag (e.g. 'gmail', 'otter', 'call-transcript',
  // 'manual') so the caller can weigh sources differently.
  source?: string;
}

export interface ContradictionPair {
  subject: string;
  predicate: string;
  // The newer (by asOf) fact - the one the caller probably wants to keep.
  newer: MemoryFact;
  // The older (by asOf) fact - the one the caller probably wants to
  // mark invalidated.
  older: MemoryFact;
  // Hours between newer.asOf and older.asOf. Useful for filtering out
  // contradictions where both facts are basically simultaneous (likely
  // a duplicate ingest, not a real change).
  ageGapHours: number;
  // 0..1 score: how strong the contradiction signal is. Combines the
  // newer-fact confidence advantage and the age gap.
  strength: number;
}

export interface DetectOptions {
  // Pairs separated by less than this many hours are skipped (treated
  // as duplicate ingest, not a real contradiction). Default 1 hour.
  minAgeGapHours?: number;
  // Pairs whose strength score is below this are skipped. Default 0.2.
  minStrength?: number;
  // Optional case-normalizer for objects. Default: trim + lowercase.
  // Pass identity to compare verbatim.
  normalizeObject?: (object: string) => string;
}

const DEFAULT_OPTS: Required<Pick<DetectOptions, 'minAgeGapHours' | 'minStrength' | 'normalizeObject'>> = {
  minAgeGapHours: 1,
  minStrength: 0.2,
  normalizeObject: (s: string) => s.trim().toLowerCase(),
};

// Core: detect contradictions across a list of facts

export function detectContradictions(
  facts: MemoryFact[],
  options: DetectOptions = {},
): ContradictionPair[] {
  const opts = { ...DEFAULT_OPTS, ...options };

  // Group by (subject, predicate). Two facts can only contradict if
  // they make different assertions about the same thing.
  const groups = new Map<string, MemoryFact[]>();
  for (const fact of facts) {
    const key = `${fact.subject}::${fact.predicate}`;
    const list = groups.get(key) ?? [];
    list.push(fact);
    groups.set(key, list);
  }

  const out: ContradictionPair[] = [];
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    // Compare every pair in the group; in practice groups stay small
    // because (subject, predicate) is narrow.
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const aObj = opts.normalizeObject(a.object);
        const bObj = opts.normalizeObject(b.object);
        if (aObj === bObj) continue; // same value, not a contradiction
        const aTs = parseTs(a.asOf);
        const bTs = parseTs(b.asOf);
        if (aTs === null || bTs === null) continue;
        const newer = aTs >= bTs ? a : b;
        const older = aTs >= bTs ? b : a;
        const ageGapHours = Math.abs(aTs - bTs) / 3_600_000;
        if (ageGapHours < opts.minAgeGapHours) continue;
        const strength = scorePair(newer, older, ageGapHours);
        if (strength < opts.minStrength) continue;
        out.push({
          subject: a.subject,
          predicate: a.predicate,
          newer,
          older,
          ageGapHours,
          strength,
        });
      }
    }
  }

  // Strongest first, deterministic tiebreak on older.id then newer.id
  out.sort((x, y) => {
    if (y.strength !== x.strength) return y.strength - x.strength;
    if (x.older.id !== y.older.id) return x.older.id < y.older.id ? -1 : 1;
    return x.newer.id < y.newer.id ? -1 : 1;
  });
  return out;
}

// Score a single contradiction pair on [0, 1].
//
// Two signals:
//   confidenceAdvantage: how much higher-confidence the newer fact is
//   than the older one. If both are ExampleCo, contributes 0.5 (neutral).
//   ageWeight: longer gaps are stronger evidence the world has actually
//   changed rather than the same event reported twice from different
//   sources within minutes. Saturates after ~30 days.
function scorePair(newer: MemoryFact, older: MemoryFact, ageGapHours: number): number {
  const newerConf = newer.confidence ?? 0.5;
  const olderConf = older.confidence ?? 0.5;
  // Map [-1, +1] confidence delta into [0, 1] with 0.5 = no advantage.
  const confidenceAdvantage = 0.5 + (newerConf - olderConf) / 2;
  // Saturating curve: 0 at 0 hours, ~0.5 at 30 days, ~0.86 at 90 days.
  const ageDays = ageGapHours / 24;
  const ageWeight = 1 - Math.exp(-ageDays / 60);
  // Blend 60% age, 40% confidence. Age is the harder signal: a new
  // verified fact from a month later is almost certainly the truth,
  // regardless of confidence labels we may or may not have on either.
  return Math.max(0, Math.min(1, 0.6 * ageWeight + 0.4 * confidenceAdvantage));
}

function parseTs(s: string): number | null {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// Convenience: detect contradictions against a single new candidate.
//
// The common write-path question is "I'm about to add this new fact,
// does it contradict anything I already know?". This wraps the full
// detector and returns only pairs involving the candidate.
export function detectContradictionsForCandidate(
  candidate: MemoryFact,
  existing: MemoryFact[],
  options: DetectOptions = {},
): ContradictionPair[] {
  const all = [...existing, candidate];
  const allPairs = detectContradictions(all, options);
  return allPairs.filter(
    (p) => p.newer.id === candidate.id || p.older.id === candidate.id,
  );
}

// Summarise for the briefing / Telegram.
//
// Returns a one-line digest per contradiction in human-readable form.
export function summariseContradictions(pairs: ContradictionPair[]): string[] {
  return pairs.map((p) => {
    const strengthPct = Math.round(p.strength * 100);
    const days = (p.ageGapHours / 24).toFixed(1);
    return (
      `${p.subject} ${p.predicate}: ` +
      `was "${p.older.object}" (${p.older.asOf}), ` +
      `now "${p.newer.object}" (${p.newer.asOf}) ` +
      `[${days}d gap, ${strengthPct}% strength]`
    );
  });
}

if (require.main === module) {
  // CLI: read facts from stdin as JSON array, print contradictions.
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { buf += chunk; });
  process.stdin.on('end', () => {
    try {
      const facts = JSON.parse(buf) as MemoryFact[];
      const pairs = detectContradictions(facts);
      process.stdout.write(JSON.stringify({
        contradiction_count: pairs.length,
        contradictions: pairs,
        summary: summariseContradictions(pairs),
      }, null, 2) + '\n');
    } catch (err) {
      process.stderr.write(`memory-contradiction-detector: ${(err as Error).message}\n`);
      process.exit(1);
    }
  });
}
