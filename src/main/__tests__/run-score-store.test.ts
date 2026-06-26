// GAP 2 (nightly enhancement run 139): a DECOUPLED run-score store.
//
// Amy runs rich multi-step work (briefings, nightly fan-outs, calls) but had no
// after-the-fact quality layer: tool-trace.ts records what happened (success
// bool, durations) and outcome-tracker.ts records binary per-action labels, but
// nothing attaches a post-hoc quality SCORE to a run_id, possibly hours later,
// from a separate evaluator. This is the Langfuse "scores are a separate object
// keyed by traceId" model (Run-132 deferred gap A).
//
// Contract pinned (the category):
//  1. A score is keyed by run_id and persists even if no trace exists for that
//     run (true decoupling -- the scorer must not need the trace present).
//  2. Multiple scores (different name/source/time) can attach to one run_id.
//  3. summarizeScores aggregates by name over a time window (count/mean/min/max).
//  4. Credential shapes are redacted before persistence (same disk-boundary rule
//     as tool-trace.ts, since this JSONL feeds the briefing + S3 meta).

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  appendScore,
  scoresForRun,
  summarizeScores,
  readRecentScores,
  RunScore,
} from '../run-score-store';

function tmpScoresPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-scores-'));
  return path.join(dir, 'run-scores.jsonl');
}

function score(partial: Partial<RunScore>): RunScore {
  return {
    run_id: 'run-1',
    name: 'briefing_quality',
    value: 0.8,
    data_type: 'numeric',
    source: 'llm_judge',
    scored_at: '2026-06-20T05:30:00.000Z',
    ...partial,
  };
}

describe('run-score-store', () => {
  let p: string;
  beforeEach(() => {
    p = tmpScoresPath();
  });

  it('persists a score keyed by run_id even when no trace exists for it', () => {
    appendScore(p, score({ run_id: 'orphan-run' }));
    const got = scoresForRun(p, 'orphan-run');
    expect(got).toHaveLength(1);
    expect(got[0].value).toBe(0.8);
  });

  it('attaches multiple decoupled scores (different source/time) to one run_id', () => {
    appendScore(p, score({ name: 'briefing_quality', source: 'llm_judge', value: 0.9 }));
    appendScore(p, score({ name: 'heal_effectiveness', source: 'heuristic', value: 0.5 }));
    appendScore(
      p,
      score({
        name: 'briefing_quality',
        source: 'human',
        value: 1,
        scored_at: '2026-06-20T09:00:00.000Z',
      }),
    );
    const got = scoresForRun(p, 'run-1');
    expect(got).toHaveLength(3);
    expect(new Set(got.map((s) => s.source))).toEqual(new Set(['llm_judge', 'heuristic', 'human']));
  });

  it('summarizes by name over a window (count/mean/min/max)', () => {
    const now = Date.now();
    const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
    appendScore(p, score({ name: 'briefing_quality', value: 0.6, scored_at: iso(1) }));
    appendScore(p, score({ name: 'briefing_quality', value: 1.0, scored_at: iso(2) }));
    appendScore(p, score({ name: 'briefing_quality', value: 0.5, scored_at: iso(100) })); // outside 24h
    appendScore(p, score({ name: 'call_outcome', value: 0.0, scored_at: iso(1) })); // other name
    const s = summarizeScores(p, 'briefing_quality', 24);
    expect(s.count).toBe(2);
    expect(s.mean).toBeCloseTo(0.8, 5);
    expect(s.min).toBe(0.6);
    expect(s.max).toBe(1.0);
  });

  it('summarize returns zero-count for an unseen name without throwing', () => {
    appendScore(p, score({ name: 'briefing_quality' }));
    const s = summarizeScores(p, 'nope', 24);
    expect(s.count).toBe(0);
    expect(s.mean).toBe(0);
  });

  it('redacts credential shapes before persistence', () => {
    appendScore(
      p,
      score({ comment: 'judge saw token sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 in the run' }),
    );
    const raw = fs.readFileSync(p, 'utf8');
    expect(raw).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    // The score still round-trips as valid JSON with the comment field present.
    const got = scoresForRun(p, 'run-1');
    expect(got[0].comment).toBeTruthy();
  });

  it('readRecentScores returns newest-first and tolerates a missing file', () => {
    expect(readRecentScores(path.join(os.tmpdir(), 'nope-' + process.pid + '.jsonl'))).toEqual([]);
    appendScore(p, score({ scored_at: '2026-06-20T05:00:00.000Z', value: 0.1 }));
    appendScore(p, score({ scored_at: '2026-06-20T06:00:00.000Z', value: 0.2 }));
    const recent = readRecentScores(p, 10);
    expect(recent[0].value).toBe(0.2);
  });

  it('appendScore never throws on an unwritable path (best-effort, like tool-trace)', () => {
    // A directory path as the file target -> write fails internally, must not throw.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-scores-dir-'));
    expect(() => appendScore(dir, score({}))).not.toThrow();
  });
});
