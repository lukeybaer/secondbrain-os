// belief-revision.ts
//
// Active in-flight belief tracker. Amy carries explicit beliefs through a
// multi-step task -- "this dentist accepts new patients" (prior 0.7),
// "Alice's I-140 was filed Oct 2025" (prior 0.85), "the briefing build
// went green tonight" (prior 0.95) -- and updates each posterior in
// closed form when new evidence arrives. Every update is audit-tracked
// so the reasoning chain that led to a final action is replayable.
//
// This module sits orthogonal to three existing pieces and intentionally
// does not overlap with them:
//
//   - claim-verifier.ts is the WRITE-time gate that checks the spans in
//     a finished artifact against the source bundle. It runs once per
//     artifact, returns verified/partial/unsupported. It does not carry
//     beliefs forward across the steps that produced the artifact.
//   - prediction-ledger.ts is the POST-HOC accounting that joins a
//     prediction to an observed outcome. It scores calibration after
//     the action lands. It does not update mid-task as evidence arrives.
//   - output-critic.ts is the STRUCTURAL rule pass (em dashes, CT not
//     UTC, length caps). It is not probabilistic.
//
// What was missing: a mid-task belief substrate that lets the agent
// SAY "I think X is likely; I have evidence A,B,C; here is the
// posterior; here is the dissonance with belief Y; here is when I should
// stop and ask Luke." That substrate is what this module provides.
//
// Pattern sources (2026 OSS + research):
//   - LangGraph 0.4+ BeliefState extension (langchain-ai/langgraph
//     #beliefs Apr 2026) -- explicit belief blocks attached to the graph
//     state, updated via reducers when a node emits evidence.
//   - Letta v1 "explicit belief blocks" (Letta blog 2026-04, building on
//     MemGPT core_memory) -- beliefs as a separate block kind from facts,
//     so the agent can distinguish "I observed X" from "I think X."
//   - Anthropic Agent SDK Skills/Belief tracking guidance (Skills SDK
//     2026-03, sample apps/belief-trace) -- evidence-stamped confidence
//     deltas attached to each tool result.
//   - arxiv 2510.07623 "Bayesian agent reasoning for tool-use LLMs"
//     (2025-10) -- log-odds update with capped likelihood ratios to
//     keep posteriors numerically stable across many small updates.
//   - DSPy "dspy.Belief" signature (Khattab et al, Stanford 2025-08) --
//     typed belief signatures that compose with ChainOfThought + Verify.
//   - Pearl 1988 "Probabilistic Reasoning in Intelligent Systems" Ch.2 --
//     the canonical reference for belief network update via odds form.
//
// Design:
//   - Pure module. Beliefs and evidence are in-memory; persistence is
//     injected through a BeliefStore implementation. Tests use the
//     bundled InMemoryBeliefStore.
//   - All math runs in log-odds space so a long evidence chain stays
//     numerically stable. Probability conversions happen at the API
//     boundary.
//   - Posteriors are CAPPED at [1e-4, 1 - 1e-4] so a single unbounded
//     log-likelihood ratio can never lock a belief at 0 or 1.
//   - Every update records the source, the prior, the posterior, and the
//     log-likelihood ratio applied. This is the audit substrate the
//     forensic UI ("why did Amy decide X?") consumes.

import * as crypto from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type BeliefSurface =
  | 'task'
  | 'briefing'
  | 'call'
  | 'gmail'
  | 'research'
  | 'pipeline'
  | 'other';

export interface BeliefSource {
  /** Short identifier for the evidence channel: 'gmail', 'voicemail',
   * 'tool:vapi', 'memory:user_companies', 'observation', 'inference'. */
  kind: string;
  /** Pointer to the evidence: file path, message id, ledger line, url. */
  ref?: string;
  /** Free-text note for the audit trail. */
  note?: string;
}

export interface EvidenceUpdate {
  /** Source of the evidence. */
  source: BeliefSource;
  /** Log-likelihood ratio for this evidence in support of the claim.
   * Positive = supports; negative = contradicts. Magnitude reflects
   * strength: 0.2 = weak hint, 1.0 = moderate, 2.0 = strong, 4.0+ = decisive.
   * Capped at +/- 4.6 (~ Pr 0.99 vs 0.01) to prevent runaway updates. */
  log_lr: number;
  /** Optional caller-supplied confidence delta description for the audit
   * trail (e.g. "voicemail explicitly said accepting new patients"). */
  rationale?: string;
}

export interface BeliefRecord {
  id: string;
  claim: string;                       // human-readable proposition
  surface: BeliefSurface;
  prior: number;                       // 0..1, initial probability
  posterior: number;                   // 0..1, current probability after updates
  confidence_band: [number, number];   // [lo, hi] from log-odds error
  created_at: string;                  // ISO
  updated_at: string;                  // ISO
  evidence: AppliedEvidence[];
  tags?: string[];
}

export interface AppliedEvidence {
  ts: string;                          // ISO
  source: BeliefSource;
  log_lr: number;
  prior: number;                       // probability before this update
  posterior: number;                   // probability after this update
  rationale?: string;
}

export interface BeliefStore {
  save: (rec: BeliefRecord) => void | Promise<void>;
  load: (id: string) => BeliefRecord | undefined | Promise<BeliefRecord | undefined>;
  list: (filter?: { surface?: BeliefSurface; tag?: string }) =>
    BeliefRecord[] | Promise<BeliefRecord[]>;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Capped log-likelihood ratio so a single update cannot lock a belief.
 * +/- 4.6 corresponds to ~ Pr 0.99 vs 0.01. */
export const LOG_LR_CAP = 4.6;

/** Posterior clamp so log-odds stays finite for the next update. */
const PROB_MIN = 1e-4;
const PROB_MAX = 1 - 1e-4;

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function probToLogOdds(p: number): number {
  const q = clamp(p, PROB_MIN, PROB_MAX);
  return Math.log(q / (1 - q));
}

export function logOddsToProb(lo: number): number {
  const e = Math.exp(lo);
  return e / (1 + e);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function capLogLR(x: number): number {
  if (Number.isNaN(x) || !Number.isFinite(x)) return 0;
  return clamp(x, -LOG_LR_CAP, LOG_LR_CAP);
}

function nowIso(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString();
}

function hashId(claim: string, surface: BeliefSurface, ts: string): string {
  return crypto
    .createHash('sha256')
    .update(`${surface}|${claim}|${ts}`)
    .digest('hex')
    .slice(0, 12);
}

// ── Core API ─────────────────────────────────────────────────────────────────

export interface OpenBeliefOpts {
  surface: BeliefSurface;
  prior: number;                       // 0..1
  source?: BeliefSource;
  tags?: string[];
  /** Optional clock injection for deterministic tests. */
  now?: () => Date;
}

/**
 * Opens a new belief with an explicit prior. The prior must be in (0,1);
 * 0 and 1 are clamped so subsequent evidence can still move the posterior.
 */
export function openBelief(claim: string, opts: OpenBeliefOpts): BeliefRecord {
  const ts = nowIso(opts.now);
  const prior = clamp(opts.prior, PROB_MIN, PROB_MAX);
  const id = hashId(claim, opts.surface, ts);
  return {
    id,
    claim,
    surface: opts.surface,
    prior,
    posterior: prior,
    confidence_band: confidenceBand(prior, 0),
    created_at: ts,
    updated_at: ts,
    evidence: opts.source
      ? [
          {
            ts,
            source: opts.source,
            log_lr: 0,
            prior,
            posterior: prior,
            rationale: 'initial prior',
          },
        ]
      : [],
    tags: opts.tags,
  };
}

/**
 * Applies a single evidence update and returns the updated belief. The
 * input record is treated as immutable; a new record is returned.
 */
export function applyEvidence(
  rec: BeliefRecord,
  ev: EvidenceUpdate,
  opts: { now?: () => Date } = {}
): BeliefRecord {
  const ts = nowIso(opts.now);
  const lr = capLogLR(ev.log_lr);
  const priorLO = probToLogOdds(rec.posterior);
  const postLO = priorLO + lr;
  const posterior = clamp(logOddsToProb(postLO), PROB_MIN, PROB_MAX);
  const updated: AppliedEvidence = {
    ts,
    source: ev.source,
    log_lr: lr,
    prior: rec.posterior,
    posterior,
    rationale: ev.rationale,
  };
  // Sum of squared LRs is a rough measure of accumulated information.
  const totalInfo = rec.evidence.reduce(
    (acc, e) => acc + e.log_lr * e.log_lr,
    0
  ) + lr * lr;
  return {
    ...rec,
    posterior,
    confidence_band: confidenceBand(posterior, totalInfo),
    updated_at: ts,
    evidence: [...rec.evidence, updated],
  };
}

/**
 * Applies a batch of evidence updates in order. Useful when a single
 * tool call returns several independent signals (e.g. a Gmail thread
 * scan finds three corroborating messages).
 */
export function applyEvidenceBatch(
  rec: BeliefRecord,
  batch: EvidenceUpdate[],
  opts: { now?: () => Date } = {}
): BeliefRecord {
  return batch.reduce((acc, ev) => applyEvidence(acc, ev, opts), rec);
}

/**
 * Confidence band derived from accumulated information. Wider band when
 * the belief has not yet absorbed much evidence; tightens as evidence
 * accumulates. NOT a strict frequentist confidence interval -- it is a
 * pragmatic indicator surfaced on the UI ("Amy is fairly sure" vs "Amy
 * is guessing").
 */
export function confidenceBand(
  posterior: number,
  totalInfo: number
): [number, number] {
  // Heuristic: width shrinks with the accumulated info.
  // width = 0.5 / sqrt(1 + info), clamped to [0.02, 0.45]
  const w = clamp(0.5 / Math.sqrt(1 + totalInfo), 0.02, 0.45);
  return [clamp(posterior - w, 0, 1), clamp(posterior + w, 0, 1)];
}

// ── Conflict and dissonance ──────────────────────────────────────────────────

/**
 * Dissonance between two beliefs about the same proposition (e.g. two
 * different evidence chains for "the dentist accepts new patients").
 * 0 = perfectly consistent, 1 = maximally contradictory.
 *
 * Implementation: Jensen-Shannon-style distance over Bernoulli p,(1-p).
 * Symmetric, bounded, monotone -- the properties an "amount of conflict"
 * scalar needs.
 */
export function dissonance(a: BeliefRecord, b: BeliefRecord): number {
  const p = a.posterior;
  const q = b.posterior;
  const m = (p + q) / 2;
  const kl = (x: number, y: number): number => {
    if (x < PROB_MIN) return 0;
    return x * Math.log(x / y);
  };
  const dPM = kl(p, m) + kl(1 - p, 1 - m);
  const dQM = kl(q, m) + kl(1 - q, 1 - m);
  const js = 0.5 * (dPM + dQM);
  // js is in [0, log 2]; scale to [0, 1].
  return clamp(js / Math.log(2), 0, 1);
}

/**
 * Returns true when the agent should pause and surface this belief to
 * Luke instead of acting on it. Default criteria:
 *
 *   - posterior in the dissonance band [0.35, 0.65] (genuinely unsure), OR
 *   - confidence band wider than 0.3 (not enough info), OR
 *   - at least one supporting and one contradicting evidence above
 *     log_lr magnitude 1.0 (active conflict).
 */
export function shouldEscalate(
  rec: BeliefRecord,
  opts: { unsure_lo?: number; unsure_hi?: number; band_max?: number } = {}
): boolean {
  const lo = opts.unsure_lo ?? 0.35;
  const hi = opts.unsure_hi ?? 0.65;
  if (rec.posterior >= lo && rec.posterior <= hi) return true;
  const [bandLo, bandHi] = rec.confidence_band;
  if (bandHi - bandLo > (opts.band_max ?? 0.3)) return true;
  const hasSupport = rec.evidence.some((e) => e.log_lr >= 1.0);
  const hasOppose = rec.evidence.some((e) => e.log_lr <= -1.0);
  if (hasSupport && hasOppose) return true;
  return false;
}

// ── Contradiction scan across a belief set ───────────────────────────────────
//
// dissonance() above gives the pairwise scalar between TWO beliefs about the
// same proposition. It does not answer the daily-briefing question: "across
// every open belief, which pairs are contradicting each other right now?"
//
// detectContradictions() scans a flat list of beliefs and returns every pair
// whose claims look like they are talking about the same proposition AND
// whose dissonance is above a threshold. The "same proposition" check is
// intentionally cheap: same surface + Jaccard token overlap above a floor.
// Callers who already know their beliefs cover the same topic (e.g. all
// beliefs tagged "dentist-search") can lower the overlap floor to 0 and let
// the dissonance number do the work.
//
// This is the substrate for a "Beliefs in conflict" briefing card: a tier-1
// count of contradicting pairs, tier-2 the top pairs, tier-3 the full audit.

export interface ContradictionPair {
  /** Lexically first belief id in the pair (stable ordering). */
  a_id: string;
  /** Lexically second belief id in the pair (stable ordering). */
  b_id: string;
  /** Posterior on the first belief at the time of the scan. */
  a_posterior: number;
  /** Posterior on the second belief at the time of the scan. */
  b_posterior: number;
  /** Shared surface, since cross-surface pairs are filtered out. */
  surface: BeliefSurface;
  /** Dissonance score on [0,1]; higher means more contradictory. */
  dissonance: number;
  /** Jaccard token overlap on [0,1] between the two claim strings. */
  claim_overlap: number;
  /** Shared tokens used to decide the two claims look related. Capped at 8. */
  shared_tokens: string[];
}

export interface DetectContradictionsOpts {
  /**
   * Minimum dissonance score for a pair to be reported. Defaults to 0.3.
   * The dissonance() scalar is a Jensen-Shannon distance scaled to [0,1],
   * which saturates slowly: 0.8 vs 0.15 ~ 0.33, 0.9 vs 0.1 ~ 0.53, 0.95 vs
   * 0.05 ~ 0.72. 0.3 is the floor where the two beliefs are clearly leaning
   * opposite ways. Lower to widen the net, raise to surface only sharp
   * conflicts.
   */
  min_dissonance?: number;
  /**
   * Minimum Jaccard token overlap on the two claim strings before a pair
   * is considered to be about the same proposition. Defaults to 0.3.
   * Set to 0 to skip the topical filter (caller pre-grouped by tag).
   */
  min_overlap?: number;
  /**
   * When true, allow contradicting pairs across different surfaces. Off by
   * default: a belief held on the briefing surface and a belief held on a
   * call surface are usually about different propositions even when their
   * tokens overlap.
   */
  allow_cross_surface?: boolean;
  /**
   * Maximum number of pairs to return, sorted by descending dissonance.
   * Defaults to 25 to keep the briefing card bounded.
   */
  max_results?: number;
}

const CLAIM_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'it', 'its', 'as', 'from',
  'will', 'would', 'should', 'could', 'has', 'have', 'had', 'do',
  'does', 'did', 'not', 'no', 'yes', 'i', 'you', 'we', 'they',
]);

function tokenize(claim: string): Set<string> {
  const out = new Set<string>();
  for (const raw of claim.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (CLAIM_STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): { score: number; shared: string[] } {
  if (a.size === 0 || b.size === 0) return { score: 0, shared: [] };
  const shared: string[] = [];
  for (const t of a) if (b.has(t)) shared.push(t);
  const union = new Set<string>([...a, ...b]).size;
  return { score: shared.length / union, shared };
}

export function detectContradictions(
  beliefs: ReadonlyArray<BeliefRecord>,
  opts: DetectContradictionsOpts = {},
): ContradictionPair[] {
  const minDiss = opts.min_dissonance ?? 0.3;
  const minOverlap = opts.min_overlap ?? 0.3;
  const allowCross = opts.allow_cross_surface ?? false;
  const maxResults = opts.max_results ?? 25;

  // Pre-tokenize once per belief, O(n) instead of O(n^2 * |claim|).
  const tokenCache: Set<string>[] = beliefs.map((b) => tokenize(b.claim));

  const out: ContradictionPair[] = [];
  for (let i = 0; i < beliefs.length; i += 1) {
    for (let j = i + 1; j < beliefs.length; j += 1) {
      const a = beliefs[i];
      const b = beliefs[j];
      if (!allowCross && a.surface !== b.surface) continue;
      const { score: overlap, shared } = jaccard(tokenCache[i], tokenCache[j]);
      if (overlap < minOverlap) continue;
      const d = dissonance(a, b);
      if (d < minDiss) continue;
      // Stable lexical ordering so a re-run produces the same pair shape.
      const [first, second, firstIdx, secondIdx] =
        a.id <= b.id ? [a, b, i, j] : [b, a, j, i];
      out.push({
        a_id: first.id,
        b_id: second.id,
        a_posterior: first.posterior,
        b_posterior: second.posterior,
        surface: a.surface,
        dissonance: d,
        claim_overlap: overlap,
        shared_tokens: shared.slice(0, 8),
      });
      // suppress unused-var warning when only ids are used downstream
      void firstIdx;
      void secondIdx;
    }
  }

  out.sort((x, y) => y.dissonance - x.dissonance || x.a_id.localeCompare(y.a_id));
  return out.slice(0, maxResults);
}

/**
 * Format a list of contradiction pairs as briefing-ready lines. One line per
 * pair, capped at `limit`, suitable for a tier-2 expansion. Higher-dissonance
 * pairs first because the briefing surface shows the worst first.
 */
export function formatContradictionsForBriefing(
  pairs: ReadonlyArray<ContradictionPair>,
  limit = 5,
): string[] {
  return pairs.slice(0, limit).map((p) => {
    const aPct = Math.round(p.a_posterior * 100);
    const bPct = Math.round(p.b_posterior * 100);
    const dPct = Math.round(p.dissonance * 100);
    const tokens = p.shared_tokens.length > 0 ? ` [${p.shared_tokens.join(',')}]` : '';
    return `${p.surface}: ${p.a_id} (${aPct}%) vs ${p.b_id} (${bPct}%), dissonance ${dPct}%${tokens}`;
  });
}

// ── Audit ────────────────────────────────────────────────────────────────────

export interface BeliefAudit {
  id: string;
  claim: string;
  surface: BeliefSurface;
  prior: number;
  posterior: number;
  swing: number;
  evidence_count: number;
  strongest_support?: AppliedEvidence;
  strongest_oppose?: AppliedEvidence;
  recommendation: 'commit' | 'gather_more' | 'escalate';
}

/**
 * Compact audit summary suitable for a briefing tile or the dashboard
 * drilldown view. Includes a recommendation that downstream code can act
 * on without re-deriving the rules.
 */
export function auditBelief(rec: BeliefRecord): BeliefAudit {
  const swing = rec.posterior - rec.prior;
  const sorted = rec.evidence.slice().sort((a, b) => b.log_lr - a.log_lr);
  const strongest_support = sorted.find((e) => e.log_lr > 0);
  const strongest_oppose = sorted.reverse().find((e) => e.log_lr < 0);
  const escalate = shouldEscalate(rec);
  const recommendation: BeliefAudit['recommendation'] = escalate
    ? rec.evidence.length < 2
      ? 'gather_more'
      : 'escalate'
    : 'commit';
  return {
    id: rec.id,
    claim: rec.claim,
    surface: rec.surface,
    prior: rec.prior,
    posterior: rec.posterior,
    swing,
    evidence_count: rec.evidence.length,
    strongest_support,
    strongest_oppose,
    recommendation,
  };
}

// ── In-memory store (default for tests + tier-1 callers) ─────────────────────

export class InMemoryBeliefStore implements BeliefStore {
  private _records = new Map<string, BeliefRecord>();
  save(rec: BeliefRecord): void {
    this._records.set(rec.id, JSON.parse(JSON.stringify(rec)));
  }
  load(id: string): BeliefRecord | undefined {
    const r = this._records.get(id);
    return r ? JSON.parse(JSON.stringify(r)) : undefined;
  }
  list(filter?: { surface?: BeliefSurface; tag?: string }): BeliefRecord[] {
    let out = Array.from(this._records.values());
    if (filter?.surface) out = out.filter((r) => r.surface === filter.surface);
    if (filter?.tag) out = out.filter((r) => r.tags?.includes(filter.tag));
    return out.map((r) => JSON.parse(JSON.stringify(r)));
  }
  clear(): void {
    this._records.clear();
  }
  size(): number {
    return this._records.size;
  }
}
