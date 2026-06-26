// GAP 3 (nightly enhancement run 139): post-call quality scoring.
//
// calls.ts recorded a Vapi dial's status and a binary completed flag, but never
// SCORED whether the call achieved its goal with any confidence/objection
// detail, and nothing fed a run-quality score into the new decoupled store.
// This module scores a finished call's transcript against its goal and maps the
// result onto a RunScore (composes GAP 2 + GAP 3): the dentist workflow now
// answers "did this dial move us forward and why" instead of just "it connected".
//
// Contract pinned (the category -- goal attainment of ANY call, not the dentist
// phrasing): agreement -> goal_met, refusal -> not met, objections surfaced, an
// injected judge can override the heuristic, and the result maps to a RunScore.

import { describe, it, expect } from 'vitest';
import { heuristicCallScore, scoreCall, callScoreToRunScore, CallScore } from '../call-score';

const GOAL = 'Schedule a dental cleaning without new X-rays.';

const AGREE = `
AI: Could we book a cleaning without new X-rays for now?
Receptionist: Yes, that works. We can schedule you for next Tuesday at 10am.
AI: Perfect, thank you.
`;

const REFUSE = `
AI: Could we book a cleaning without new X-rays for now?
Receptionist: No, I'm sorry, our policy requires X-rays before any cleaning. We can't make an exception.
AI: Understood.
`;

describe('heuristicCallScore', () => {
  it('marks goal_met true on a clear agreement transcript', () => {
    const s = heuristicCallScore(AGREE, GOAL);
    expect(s.goal_met).toBe(true);
    expect(s.confidence).toBeGreaterThan(0.5);
  });

  it('marks goal_met false on a clear refusal transcript', () => {
    const s = heuristicCallScore(REFUSE, GOAL);
    expect(s.goal_met).toBe(false);
    expect(s.objections.length).toBeGreaterThan(0);
  });

  it('returns low-confidence not-met on an empty/blank transcript (no fabrication)', () => {
    const s = heuristicCallScore('   ', GOAL);
    expect(s.goal_met).toBe(false);
    expect(s.confidence).toBeLessThan(0.5);
  });
});

describe('scoreCall with an injected judge', () => {
  it('delegates to the injected judge (LLM ladder controlled by caller)', async () => {
    const stub = async () => ({ goal_met: true, confidence: 0.95, objections: ['none'] });
    const s = await scoreCall(REFUSE, GOAL, stub);
    // Judge overrides the heuristic -- the refusal text would heuristically be
    // not-met, but the injected judge said met.
    expect(s.goal_met).toBe(true);
    expect(s.confidence).toBe(0.95);
  });

  it('falls back to the heuristic when no judge is provided', async () => {
    const s = await scoreCall(AGREE, GOAL);
    expect(s.goal_met).toBe(true);
  });
});

describe('callScoreToRunScore', () => {
  it('maps a CallScore onto a RunScore keyed by the call id', () => {
    const cs: CallScore = { goal_met: true, confidence: 0.8, objections: [] };
    const rs = callScoreToRunScore('call-abc', cs, 'heuristic', '2026-06-20T05:30:00.000Z');
    expect(rs.run_id).toBe('call-abc');
    expect(rs.name).toBe('call_outcome');
    expect(rs.data_type).toBe('numeric');
    expect(rs.source).toBe('heuristic');
    // value encodes goal attainment confidence; goal not met inverts the signal.
    expect(rs.value).toBeCloseTo(0.8, 5);
    const missed = callScoreToRunScore(
      'call-x',
      { goal_met: false, confidence: 0.9, objections: ['policy'] },
      'heuristic',
      '2026-06-20T05:30:00.000Z',
    );
    expect(missed.value).toBeCloseTo(0.1, 5);
    expect(missed.comment).toContain('policy');
  });
});
