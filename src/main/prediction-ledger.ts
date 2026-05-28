// prediction-ledger.ts
//
// Predictive-coding pattern for skill harness evolution. Before any non-
// trivial action -- a Gmail send, a Vapi call, a video pipeline run, a
// briefing card refresh, a scheduled-task tick -- the agent records a
// prediction:
//
//     { skill, expected_outcome, confidence, basis }
//
// After the action lands, the agent (or a passive observer) records the
// observed outcome:
//
//     { actual_outcome, evidence_path, deviation }
//
// The two entries are joined by prediction_id into a single ledger line.
// The ledger feeds three downstream consumers:
//
//   1) Per-skill calibration: did this skill's predictions actually match
//      reality? Brier score + accuracy by skill, surfaced as a briefing
//      tile so a drifting skill (e.g. captions-aurora consistently
//      over-predicting a green outcome that ends red) becomes visible.
//   2) LESSONS.md auto-update: a wrong prediction with high prior
//      confidence is the strongest signal for a new LESSONS.md entry.
//   3) Baseline-revert detection: if a skill's accuracy drops sharply
//      against its harness-baseline.json snapshot, the harness can revert
//      a recent change without waiting for a human.
//
// Pattern sources (2026 OSS + research):
//   - Karpathy 2025-12 "Predictive coding for agents" (talk + repo
//     karpathy/agent-predict) -- agents record a prediction before each
//     action; the deviation signal is the highest-fidelity training
//     feedback.
//   - Anthropic "Trajectory predictions" guidance (Skills SDK 2026-03) --
//     each skill declares an expected_outcome shape that the harness can
//     compare against actual.
//   - DSPy assertions + suggestions (Singhvi et al, Stanford 2024-02,
//     dspy.Assert / dspy.Suggest) -- "the model expected X; the assertion
//     verified" loop. We adapt the recording side, leave the verification
//     to the existing claim-verifier + output-critic stack.
//   - LangSmith Eval + trace deltas (langchain-ai/langsmith eval module
//     2026-03) -- per-trace expected vs actual with structured delta
//     output, used for nightly regression detection.
//   - Brier score / calibration (Brier 1950, still the canonical proper
//     scoring rule for probabilistic forecasts) -- gives a numeric per-
//     skill accuracy that survives across runs.
//
// Why SecondBrain needs this:
//   - feedback_briefing_rank_by_importance.md and
//     feedback_briefing_clean_or_blocked_contract.md both demand the
//     briefing surface only verified outcomes. Today there is no
//     mechanical "what did the skill EXPECT vs what HAPPENED" record;
//     LESSONS.md is hand-curated.
//   - harness-baseline.json files exist per skill (scheduled-tasks/<name>
//     /harness-baseline.json) but nothing populates "did this run beat
//     baseline?" automatically.
//   - The feature backlog item harness-evolution-loop (score 45) is a
//     direct ask for "LESSONS.md + predictions/ + baseline-revert per
//     skill". This module is the predictions/ half.
//
// Design:
//   - Pure module. fs is injected via a writer/reader so tests do not
//     touch disk. Production callers wire it to
//     data/agent/prediction-ledger.jsonl.
//   - Append-only JSONL. Each line is either a 'prediction' record, an
//     'outcome' record, or a 'joined' summary written when the outcome
//     is resolved.
//   - resolveOutcome(prediction_id, actual) computes a deviation score
//     (numeric for numeric outcomes; category-distance for categorical;
//     boolean match for boolean) and a calibration contribution.
//   - calibration(skill, since) walks the ledger and returns Brier
//     score + accuracy + recent-trend so the briefing tile can render
//     "Amy is well-calibrated this week" or "captions-aurora drifted".

import * as crypto from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type OutcomeKind = 'boolean' | 'categorical' | 'numeric';

export interface PredictionRecord {
  type: 'prediction';
  id: string;                  // sha256 of {skill, ts, idx} truncated
  ts: string;                  // ISO timestamp
  skill: string;               // scheduled-task name or subsystem id
  outcome_kind: OutcomeKind;
  expected_value: boolean | string | number;
  // For categorical, list of plausible values (sets the entropy floor for
  // calibration). For numeric, [min, max] expected range.
  expected_space?: Array<string | number>;
  confidence: number;          // 0..1, agent's prior on expected_value
  basis: string;               // short text: what the agent based this on
  action_summary?: string;     // optional one-liner of the planned action
}

export interface OutcomeRecord {
  type: 'outcome';
  prediction_id: string;
  observed_ts: string;
  actual_value: boolean | string | number;
  evidence_path?: string;      // pointer to ledger/log/trace
  notes?: string;
}

export interface JoinedDeviation {
  type: 'joined';
  prediction_id: string;
  skill: string;
  ts: string;                  // outcome_ts
  matched: boolean;
  deviation: number;           // 0 if matched; (0..1] if not (semantic distance)
  brier_contribution: number;  // (confidence - hit)^2 where hit in {0,1}
  expected_value: boolean | string | number;
  actual_value: boolean | string | number;
  notes?: string;
}

export type LedgerRecord = PredictionRecord | OutcomeRecord | JoinedDeviation;

export interface LedgerIO {
  /** Append a single record. Implementations must be atomic per line. */
  append: (rec: LedgerRecord) => void | Promise<void>;
  /** Read all records since a given ISO timestamp (inclusive). */
  readSince: (sinceIso?: string) => LedgerRecord[] | Promise<LedgerRecord[]>;
}

// ── In-memory IO (for tests + tier-1 callers without fs) ──────────────────────

export class InMemoryLedger implements LedgerIO {
  private _records: LedgerRecord[] = [];
  append(rec: LedgerRecord): void {
    // Defensive copy so mutation after append does not corrupt history.
    this._records.push(JSON.parse(JSON.stringify(rec)));
  }
  readSince(sinceIso?: string): LedgerRecord[] {
    if (!sinceIso) return this._records.slice();
    return this._records.filter((r) => recordTimestamp(r) >= sinceIso);
  }
  /** Test helper: clear the in-memory store. */
  clear(): void {
    this._records.length = 0;
  }
}

function recordTimestamp(r: LedgerRecord): string {
  if (r.type === 'prediction') return r.ts;
  if (r.type === 'outcome') return r.observed_ts;
  return r.ts;
}

// ── Prediction recording ──────────────────────────────────────────────────────

export interface RecordPredictionInput {
  skill: string;
  outcome_kind: OutcomeKind;
  expected_value: boolean | string | number;
  confidence: number;
  basis: string;
  expected_space?: Array<string | number>;
  action_summary?: string;
  now?: () => Date;
  idx?: number; // optional disambiguator if multiple predictions fire in the same ms
}

export async function recordPrediction(
  io: LedgerIO,
  input: RecordPredictionInput
): Promise<PredictionRecord> {
  validatePredictionInput(input);
  const now = (input.now ?? (() => new Date()))();
  const ts = now.toISOString();
  const idx = input.idx ?? 0;
  const id = crypto
    .createHash('sha256')
    .update(`${input.skill}|${ts}|${idx}|${JSON.stringify(input.expected_value)}`)
    .digest('hex')
    .slice(0, 16);
  const rec: PredictionRecord = {
    type: 'prediction',
    id,
    ts,
    skill: input.skill,
    outcome_kind: input.outcome_kind,
    expected_value: input.expected_value,
    expected_space: input.expected_space,
    confidence: input.confidence,
    basis: input.basis,
    action_summary: input.action_summary,
  };
  await io.append(rec);
  return rec;
}

function validatePredictionInput(input: RecordPredictionInput): void {
  if (!input.skill || typeof input.skill !== 'string') {
    throw new Error('skill is required');
  }
  if (!['boolean', 'categorical', 'numeric'].includes(input.outcome_kind)) {
    throw new Error(`unknown outcome_kind: ${input.outcome_kind}`);
  }
  if (
    typeof input.confidence !== 'number' ||
    Number.isNaN(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1
  ) {
    throw new Error('confidence must be a number in [0, 1]');
  }
  if (!input.basis || typeof input.basis !== 'string') {
    throw new Error('basis is required (free-text rationale)');
  }
  if (input.outcome_kind === 'numeric') {
    if (typeof input.expected_value !== 'number' || !Number.isFinite(input.expected_value)) {
      throw new Error('numeric prediction requires a finite numeric expected_value');
    }
    if (input.expected_space) {
      if (input.expected_space.length !== 2) {
        throw new Error('numeric expected_space must be [min, max]');
      }
      const [min, max] = input.expected_space as [number, number];
      if (typeof min !== 'number' || typeof max !== 'number' || min >= max) {
        throw new Error('numeric expected_space must satisfy min < max');
      }
    }
  } else if (input.outcome_kind === 'boolean') {
    if (typeof input.expected_value !== 'boolean') {
      throw new Error('boolean prediction requires a boolean expected_value');
    }
  } else if (input.outcome_kind === 'categorical') {
    if (typeof input.expected_value !== 'string') {
      throw new Error('categorical prediction requires a string expected_value');
    }
    if (input.expected_space && input.expected_space.length < 2) {
      throw new Error('categorical expected_space must list at least two options');
    }
  }
}

// ── Outcome resolution ────────────────────────────────────────────────────────

export interface ResolveOutcomeInput {
  prediction_id: string;
  actual_value: boolean | string | number;
  evidence_path?: string;
  notes?: string;
  now?: () => Date;
}

export async function resolveOutcome(
  io: LedgerIO,
  input: ResolveOutcomeInput
): Promise<JoinedDeviation> {
  const all = await io.readSince();
  const prediction = all.find(
    (r): r is PredictionRecord => r.type === 'prediction' && r.id === input.prediction_id
  );
  if (!prediction) {
    throw new Error(`no prediction found with id ${input.prediction_id}`);
  }
  const now = (input.now ?? (() => new Date()))();
  const ts = now.toISOString();
  const outcomeRec: OutcomeRecord = {
    type: 'outcome',
    prediction_id: input.prediction_id,
    observed_ts: ts,
    actual_value: input.actual_value,
    evidence_path: input.evidence_path,
    notes: input.notes,
  };
  await io.append(outcomeRec);

  const { matched, deviation } = computeDeviation(prediction, input.actual_value);
  const hit = matched ? 1 : 0;
  const brier = Math.pow(prediction.confidence - hit, 2);
  const joined: JoinedDeviation = {
    type: 'joined',
    prediction_id: prediction.id,
    skill: prediction.skill,
    ts,
    matched,
    deviation,
    brier_contribution: brier,
    expected_value: prediction.expected_value,
    actual_value: input.actual_value,
    notes: input.notes,
  };
  await io.append(joined);
  return joined;
}

export function computeDeviation(
  prediction: PredictionRecord,
  actual: boolean | string | number
): { matched: boolean; deviation: number } {
  if (prediction.outcome_kind === 'boolean') {
    if (typeof actual !== 'boolean') {
      throw new Error('boolean prediction needs boolean actual');
    }
    return { matched: prediction.expected_value === actual, deviation: prediction.expected_value === actual ? 0 : 1 };
  }
  if (prediction.outcome_kind === 'categorical') {
    if (typeof actual !== 'string') {
      throw new Error('categorical prediction needs string actual');
    }
    const expected = prediction.expected_value as string;
    if (expected === actual) return { matched: true, deviation: 0 };
    // Coarse distance: if both values are in the expected_space, distance is
    // their index gap normalised; otherwise it is 1 (max distance).
    const space = prediction.expected_space as string[] | undefined;
    if (space && space.length >= 2) {
      const iE = space.indexOf(expected);
      const iA = space.indexOf(actual);
      if (iE >= 0 && iA >= 0) {
        const dev = Math.abs(iE - iA) / (space.length - 1);
        return { matched: false, deviation: dev };
      }
    }
    return { matched: false, deviation: 1 };
  }
  if (prediction.outcome_kind === 'numeric') {
    if (typeof actual !== 'number' || !Number.isFinite(actual)) {
      throw new Error('numeric prediction needs finite numeric actual');
    }
    const expected = prediction.expected_value as number;
    if (expected === actual) return { matched: true, deviation: 0 };
    const space = prediction.expected_space as [number, number] | undefined;
    const range = space ? Math.max(1e-9, space[1] - space[0]) : Math.max(1, Math.abs(expected));
    const dev = Math.min(1, Math.abs(expected - actual) / range);
    // Numeric matches treat within-5%-of-range as a match (calibration is
    // not point-accuracy; "the briefing took ~22s, we predicted 23s" should
    // count as matched).
    const matched = dev <= 0.05;
    return { matched, deviation: dev };
  }
  throw new Error('unreachable');
}

// ── Calibration aggregates ───────────────────────────────────────────────────

export interface CalibrationStats {
  skill: string;
  total: number;
  matched: number;
  accuracy: number;            // matched / total
  mean_brier: number;          // lower is better, 0..1
  mean_deviation: number;      // 0..1, avg deviation across joined outcomes
  trend_recent: number;        // accuracy over the LAST 5 outcomes vs all-time
  most_recent_ts?: string;
}

export interface SystemCalibration {
  by_skill: CalibrationStats[];
  overall: Omit<CalibrationStats, 'skill'> & { skills: number };
}

export async function calibration(
  io: LedgerIO,
  opts: { since?: string; skill?: string } = {}
): Promise<SystemCalibration> {
  const records = await io.readSince(opts.since);
  const joined = records.filter((r): r is JoinedDeviation => r.type === 'joined');
  const filtered = opts.skill ? joined.filter((j) => j.skill === opts.skill) : joined;

  const bySkill = new Map<string, JoinedDeviation[]>();
  for (const j of filtered) {
    if (!bySkill.has(j.skill)) bySkill.set(j.skill, []);
    bySkill.get(j.skill)!.push(j);
  }

  const skillStats: CalibrationStats[] = [];
  for (const [skill, entries] of bySkill.entries()) {
    skillStats.push(statsFor(skill, entries));
  }
  skillStats.sort((a, b) => b.total - a.total);

  const overall = statsFor('__overall__', filtered);
  const { skill: _drop, ...overallNoSkill } = overall;
  void _drop;
  return {
    by_skill: skillStats,
    overall: { ...overallNoSkill, skills: bySkill.size },
  };
}

function statsFor(skill: string, entries: JoinedDeviation[]): CalibrationStats {
  if (entries.length === 0) {
    return {
      skill,
      total: 0,
      matched: 0,
      accuracy: 0,
      mean_brier: 0,
      mean_deviation: 0,
      trend_recent: 0,
    };
  }
  const sorted = entries.slice().sort((a, b) => (a.ts > b.ts ? 1 : -1));
  const total = sorted.length;
  const matched = sorted.filter((e) => e.matched).length;
  const accuracy = matched / total;
  const mean_brier = sorted.reduce((s, e) => s + e.brier_contribution, 0) / total;
  const mean_deviation = sorted.reduce((s, e) => s + e.deviation, 0) / total;
  const recentSlice = sorted.slice(-5);
  const recentAcc = recentSlice.filter((e) => e.matched).length / recentSlice.length;
  return {
    skill,
    total,
    matched,
    accuracy,
    mean_brier,
    mean_deviation,
    trend_recent: recentAcc,
    most_recent_ts: sorted[sorted.length - 1].ts,
  };
}

// ── Drift detection ──────────────────────────────────────────────────────────

/**
 * Returns skills where the trend_recent accuracy dropped by at least
 * `drop_threshold` (default 0.2) versus the all-time accuracy, given at
 * least `min_samples` joined outcomes. These are candidates for harness
 * baseline-revert.
 */
export async function detectDrift(
  io: LedgerIO,
  opts: { drop_threshold?: number; min_samples?: number; since?: string } = {}
): Promise<Array<CalibrationStats & { drop: number }>> {
  const dropThreshold = opts.drop_threshold ?? 0.2;
  const minSamples = opts.min_samples ?? 5;
  const cal = await calibration(io, { since: opts.since });
  const flagged: Array<CalibrationStats & { drop: number }> = [];
  for (const stat of cal.by_skill) {
    if (stat.total < minSamples) continue;
    const drop = stat.accuracy - stat.trend_recent;
    if (drop >= dropThreshold) flagged.push({ ...stat, drop });
  }
  flagged.sort((a, b) => b.drop - a.drop);
  return flagged;
}
