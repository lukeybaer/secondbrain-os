// run-score-store.ts
//
// Decoupled, post-hoc quality SCORES for agent runs -- the Langfuse "scores are
// a separate object keyed by traceId" model, adapted to Amy's file-based JSONL.
//
// Why this exists (the gap it closes): tool-trace.ts records WHAT a run did
// (success flag, durations); outcome-tracker.ts records binary per-action labels.
// Neither attaches a numeric/categorical QUALITY score to a run_id from a
// SEPARATE evaluator that may run hours later (an LLM-judge pass over a finished
// briefing, a post-call transcript review). Decoupling is the whole point: the
// score is its own append-only record joined to the run only by run_id, so the
// scorer never has to touch the immutable trace and quality can be trended over
// time independent of execution.
//
// Mirrors tool-trace.ts exactly: pure fs (no electron coupling), append-only
// JSONL, redactDeep at the disk boundary (this file feeds the briefing and is
// shipped to S3 in the session meta), best-effort writes that never throw.

import * as fs from 'fs';
import * as path from 'path';
import { redactDeep } from './redact-secrets';

export type ScoreDataType = 'numeric' | 'boolean' | 'categorical';
export type ScoreSource = 'llm_judge' | 'heuristic' | 'human';

export interface RunScore {
  /** Joins to a run/trace/call id. The score persists even if no trace exists. */
  run_id: string;
  /** Score dimension, e.g. 'briefing_quality' | 'heal_effectiveness' | 'call_outcome'. */
  name: string;
  /** Numeric value (0..1 for numeric/boolean; a mapped code for categorical). */
  value: number;
  data_type: ScoreDataType;
  /** Who produced it: an LLM judge, a heuristic, or a human annotation. */
  source: ScoreSource;
  /** Optional judge reasoning / annotation note. */
  comment?: string;
  /** ISO timestamp the score was produced -- may be HOURS after the run. */
  scored_at: string;
}

export interface ScoreSummary {
  name: string;
  count: number;
  mean: number;
  min: number;
  max: number;
  window_hours: number;
}

/** Append one score as a JSONL line. Best-effort: never throws on the caller. */
export function appendScore(scoresPath: string, scoreInput: RunScore): void {
  try {
    fs.mkdirSync(path.dirname(scoresPath), { recursive: true });
    fs.appendFileSync(scoresPath, JSON.stringify(redactDeep(scoreInput)) + '\n');
  } catch {
    /* scoring is best-effort observability; never break the caller */
  }
}

function readAll(scoresPath: string): RunScore[] {
  if (!fs.existsSync(scoresPath)) return [];
  try {
    return fs
      .readFileSync(scoresPath, 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as RunScore;
        } catch {
          return null;
        }
      })
      .filter((s): s is RunScore => s !== null);
  } catch {
    return [];
  }
}

/** All scores attached to a run_id, oldest-first. */
export function scoresForRun(scoresPath: string, runId: string): RunScore[] {
  return readAll(scoresPath).filter((s) => s.run_id === runId);
}

/** Recent scores, newest-first by scored_at. */
export function readRecentScores(scoresPath: string, limit = 50): RunScore[] {
  return readAll(scoresPath)
    .sort((a, b) => new Date(b.scored_at).getTime() - new Date(a.scored_at).getTime())
    .slice(0, limit);
}

/** Aggregate one score dimension over the last `windowHours`. */
export function summarizeScores(scoresPath: string, name: string, windowHours = 24): ScoreSummary {
  const cutoff = Date.now() - windowHours * 3_600_000;
  const values = readAll(scoresPath)
    .filter((s) => s.name === name && new Date(s.scored_at).getTime() >= cutoff)
    .map((s) => s.value);
  if (values.length === 0) {
    return { name, count: 0, mean: 0, min: 0, max: 0, window_hours: windowHours };
  }
  const sum = values.reduce((a, v) => a + v, 0);
  return {
    name,
    count: values.length,
    mean: sum / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    window_hours: windowHours,
  };
}
