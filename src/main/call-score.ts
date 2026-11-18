// call-score.ts
//
// Post-call quality scoring: did a finished call achieve its goal, and why?
//
// calls.ts already records a binary `completed` flag, but nothing scored a call
// with a confidence + objection detail or fed a run-quality score into the
// decoupled run-score store. This module does both, and composes with GAP 2:
// `callScoreToRunScore` maps a CallScore onto a RunScore (name 'call_outcome')
// so a call's quality trends alongside briefing/heal quality.
//
// The default `heuristicCallScore` is pure (no LLM cost) and is what calls.ts
// wires in on call end. `scoreCall` accepts an INJECTED judge so a caller can
// upgrade to an LLM grade under the ask-ai fallback ladder without this module
// taking a model dependency (same injected-judge pattern as agent-eval-harness).

import { RunScore, ScoreSource } from './run-score-store';

export interface CallScore {
  /** Did the call achieve its stated goal? */
  goal_met: boolean;
  /** Confidence in goal_met, 0..1. */
  confidence: number;
  /** Objections / blockers the callee raised (empty when none surfaced). */
  objections: string[];
}

export type CallJudge = (args: {
  transcript: string;
  goal: string;
}) => Promise<CallScore> | CallScore;

// Agreement vs refusal lexicons. Deliberately small and generic: the signal is
// the BALANCE of agreement to refusal cues, not any one phrase, so it generalizes
// past the dentist script to any goal-oriented call.
const AGREE_CUES = [
  'yes',
  'sure',
  'of course',
  'that works',
  'we can',
  'i can',
  'no problem',
  'happy to',
  'absolutely',
  'schedule you',
  'book you',
  'set you up',
  'see you',
];
const REFUSE_CUES = [
  "can't",
  'cannot',
  'unable',
  'not able',
  'no exception',
  "won't",
  'will not',
  'required',
  'we require',
  'policy',
  'unfortunately',
  'not possible',
  "don't allow",
];
// Phrases that introduce an objection clause; the sentence they appear in is
// captured as the objection text.
const OBJECTION_MARKERS = [
  'policy',
  'require',
  'unable',
  "can't",
  'cannot',
  'unfortunately',
  'need to',
  'must',
];

function countCues(haystack: string, cues: string[]): number {
  return cues.reduce((n, cue) => (haystack.includes(cue) ? n + 1 : n), 0);
}

function extractObjections(transcript: string): string[] {
  const sentences = transcript
    .split(/[\n.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const found = sentences.filter((s) => {
    const low = s.toLowerCase();
    return OBJECTION_MARKERS.some((m) => low.includes(m));
  });
  // Dedup + cap to keep the score compact.
  return Array.from(new Set(found)).slice(0, 5);
}

/**
 * Pure, LLM-free goal-attainment scorer. Confidence scales with how decisively
 * agreement cues outweigh refusal cues (or vice versa); a blank or signal-less
 * transcript yields low confidence and goal_met=false (never fabricate success).
 */
export function heuristicCallScore(transcript: string, _goal: string): CallScore {
  const text = (transcript || '').toLowerCase();
  if (!text.trim()) {
    return { goal_met: false, confidence: 0.1, objections: [] };
  }
  const agree = countCues(text, AGREE_CUES);
  const refuse = countCues(text, REFUSE_CUES);
  const objections = extractObjections(transcript);

  if (agree === 0 && refuse === 0) {
    // Talked, but no clear resolution signal either way.
    return { goal_met: false, confidence: 0.3, objections };
  }
  const goal_met = agree > refuse;
  const total = agree + refuse;
  const dominant = Math.max(agree, refuse);
  // 0.5 floor when signals tie-lean, up to ~0.95 when one side dominates.
  const confidence = Math.min(0.95, 0.5 + 0.45 * (dominant / total - 0.5) * 2);
  return { goal_met, confidence: Number(confidence.toFixed(3)), objections };
}

/**
 * Score a call. With no judge, uses the heuristic; with an injected judge, the
 * judge's verdict wins (the caller owns the model + the LLM fallback ladder).
 */
export async function scoreCall(
  transcript: string,
  goal: string,
  judge?: CallJudge,
): Promise<CallScore> {
  if (!judge) return heuristicCallScore(transcript, goal);
  return judge({ transcript, goal });
}

/**
 * Map a CallScore onto a decoupled RunScore (GAP 2 store), keyed by the call id.
 * `value` encodes goal-attainment confidence: confidence when met, inverted when
 * not, so a high-confidence MISS scores near 0 and a high-confidence WIN near 1.
 */
export function callScoreToRunScore(
  callId: string,
  score: CallScore,
  source: ScoreSource,
  scoredAt: string,
): RunScore {
  const value = score.goal_met ? score.confidence : 1 - score.confidence;
  const comment = score.objections.length
    ? `goal_met=${score.goal_met}; objections: ${score.objections.join(' | ')}`
    : `goal_met=${score.goal_met}`;
  return {
    run_id: callId,
    name: 'call_outcome',
    value: Number(value.toFixed(3)),
    data_type: 'numeric',
    source,
    comment,
    scored_at: scoredAt,
  };
}
