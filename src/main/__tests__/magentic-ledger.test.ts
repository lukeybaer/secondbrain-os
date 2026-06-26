// magentic-ledger.test.ts
//
// Regression tests for the bounded stall-recovery reducer. Encodes the CATEGORY
// (real progress resets the stall counter; N consecutive stalls trigger exactly
// one replan; replans are capped; max_rounds is the absolute rail; a doom
// verdict overrides a self-reported "progress"), not one literal trigger.
// Per feedback_frugal_regression_tests.md.

import { describe, it, expect } from 'vitest';
import {
  advance,
  applyReplan,
  initState,
  emptyTaskLedger,
  DEFAULT_LIMITS,
  MagenticLimits,
  ProgressLedger,
} from '../magentic-ledger';

const LIMITS: MagenticLimits = { maxRounds: 10, maxStalls: 2, maxResets: 2 };

function ledger(p: Partial<ProgressLedger> = {}): ProgressLedger {
  return {
    isRequestSatisfied: false,
    isInLoop: false,
    isProgressBeingMade: true,
    nextSpeaker: 'researcher',
    instruction: 'do the thing',
    ...p,
  };
}

describe('magentic-ledger advance', () => {
  it('dispatches the next speaker when progress is being made', () => {
    const s = initState(emptyTaskLedger(['a', 'b']));
    const { decision, next } = advance(s, ledger(), LIMITS);
    expect(decision).toEqual({
      kind: 'dispatch',
      speaker: 'researcher',
      instruction: 'do the thing',
    });
    expect(next.roundCount).toBe(1);
    expect(next.stallCount).toBe(0);
  });

  it('returns done when the request is satisfied', () => {
    const s = initState(emptyTaskLedger());
    const { decision } = advance(s, ledger({ isRequestSatisfied: true }), LIMITS);
    expect(decision.kind).toBe('done');
  });

  it('real progress resets the stall counter (no premature replan)', () => {
    let s = initState(emptyTaskLedger());
    // one stall
    s = advance(s, ledger({ isProgressBeingMade: false }), LIMITS).next;
    expect(s.stallCount).toBe(1);
    // then progress -> counter back to 0
    s = advance(s, ledger({ isProgressBeingMade: true }), LIMITS).next;
    expect(s.stallCount).toBe(0);
    // another isolated stall should not have accumulated into a replan
    const r = advance(s, ledger({ isProgressBeingMade: false }), LIMITS);
    expect(r.decision.kind).toBe('dispatch');
  });

  it('triggers exactly one replan after maxStalls consecutive stalls', () => {
    let s = initState(emptyTaskLedger());
    let last = advance(s, ledger({ isInLoop: true }), LIMITS); // stall 1
    s = last.next;
    last = advance(s, ledger({ isInLoop: true }), LIMITS); // stall 2 (== maxStalls, not yet over)
    expect(last.decision.kind).toBe('dispatch');
    s = last.next;
    last = advance(s, ledger({ isInLoop: true }), LIMITS); // stall 3 (> maxStalls) -> replan
    expect(last.decision).toEqual({ kind: 'replan', reason: 'stalled' });
    expect(last.next.resetCount).toBe(1);
    expect(last.next.stallCount).toBe(0); // counter cleared for the fresh plan
  });

  it('caps replans at maxResets then halts', () => {
    let s = initState(emptyTaskLedger());
    s.resetCount = LIMITS.maxResets; // already exhausted resets
    s.stallCount = LIMITS.maxStalls; // one more stall pushes over
    const { decision } = advance(s, ledger({ isInLoop: true }), LIMITS);
    expect(decision).toEqual({ kind: 'halt', reason: 'max_resets' });
  });

  it('halts at max_rounds as the absolute rail', () => {
    let s = initState(emptyTaskLedger());
    s.roundCount = LIMITS.maxRounds; // next advance crosses the cap
    const { decision } = advance(s, ledger(), LIMITS);
    expect(decision).toEqual({ kind: 'halt', reason: 'max_rounds' });
  });

  it('a doom verdict forces a stall even when the LLM claims progress', () => {
    let s = initState(emptyTaskLedger());
    const doom = { pattern: 'repeated_tool_call', detail: 'same call x3' };
    s = advance(s, ledger({ isProgressBeingMade: true }), LIMITS, doom).next;
    expect(s.stallCount).toBe(1); // counted as a stall despite self-reported progress
  });

  it('halts when no next speaker is provided and not stalled', () => {
    const s = initState(emptyTaskLedger());
    const { decision } = advance(s, ledger({ nextSpeaker: null }), LIMITS);
    expect(decision).toEqual({ kind: 'halt', reason: 'no_speaker' });
  });

  it('applyReplan bumps the task ledger revision', () => {
    const s = initState(emptyTaskLedger(['old']));
    const next = applyReplan(s, {
      facts: { given: [], toLookUp: [], toDerive: [] },
      plan: ['new'],
    });
    expect(next.task.revision).toBe(1);
    expect(next.task.plan).toEqual(['new']);
  });

  it('ships sane defaults', () => {
    expect(DEFAULT_LIMITS).toEqual({ maxRounds: 10, maxStalls: 3, maxResets: 2 });
  });
});
