import { describe, it, expect } from 'vitest';
import type { ReasoningRecord } from '../reasoning-tools';
import {
  countReasoningForTurn,
  evaluateStepBudget,
} from '../reasoning-step-budget';

function rec(turn_id: string, kind: 'think' | 'analyze' = 'think', id = `id_${Math.random()}`): ReasoningRecord {
  return {
    reasoning_id: id,
    timestamp: new Date().toISOString(),
    kind,
    body: 'body',
    conclusion: 'conclusion',
    turn_id,
  };
}

describe('reasoning-step-budget', () => {
  it('counts only records matching the supplied turn id', () => {
    const records = [rec('t1'), rec('t2'), rec('t1', 'analyze'), rec('t3')];
    expect(countReasoningForTurn(records, 't1')).toBe(2);
    expect(countReasoningForTurn(records, 't2')).toBe(1);
    expect(countReasoningForTurn(records, 'unknown')).toBe(0);
  });

  it('counts BOTH think and analyze toward the budget', () => {
    const records = [
      rec('t1', 'think'),
      rec('t1', 'analyze'),
      rec('t1', 'think'),
    ];
    expect(countReasoningForTurn(records, 't1')).toBe(3);
  });

  it('returns 0 used when turn_id is empty', () => {
    const records = [rec(''), rec('t1')];
    expect(countReasoningForTurn(records, '')).toBe(0);
  });

  it('reports ok when used is well below the warn threshold', () => {
    const records = [rec('t1'), rec('t1')];
    const verdict = evaluateStepBudget(records, 't1', { cap: 10 });
    expect(verdict.used).toBe(2);
    expect(verdict.cap).toBe(10);
    expect(verdict.warn).toBe(false);
    expect(verdict.exceeded).toBe(false);
    expect(verdict.message).toMatch(/ok/);
  });

  it('warns at the configured ratio without exceeding', () => {
    // cap 5, ratio 0.6 -> warn at ceil(3) = 3
    const records = [rec('t1'), rec('t1'), rec('t1')];
    const verdict = evaluateStepBudget(records, 't1');
    expect(verdict.used).toBe(3);
    expect(verdict.warn).toBe(true);
    expect(verdict.exceeded).toBe(false);
    expect(verdict.message).toMatch(/warning/);
  });

  it('marks exceeded at the cap and tells the model to act', () => {
    const records = Array.from({ length: 6 }, () => rec('t1'));
    const verdict = evaluateStepBudget(records, 't1', { cap: 5 });
    expect(verdict.exceeded).toBe(true);
    expect(verdict.warn).toBe(false); // exceeded takes precedence
    expect(verdict.message).toMatch(/Stop using think\/analyze/);
    expect(verdict.message).toMatch(/concrete action/);
  });

  it('honors a custom cap', () => {
    const records = [rec('t1'), rec('t1')];
    const verdict = evaluateStepBudget(records, 't1', { cap: 2 });
    expect(verdict.exceeded).toBe(true);
    expect(verdict.used).toBe(2);
  });

  it('clamps invalid policy values to safe defaults', () => {
    const records = [rec('t1')];
    const negative = evaluateStepBudget(records, 't1', { cap: -5, warnRatio: -1 });
    expect(negative.cap).toBe(1);
    expect(negative.exceeded).toBe(true);

    const tooHighRatio = evaluateStepBudget(records, 't1', { cap: 10, warnRatio: 99 });
    // warn ratio clamped to 1.0, so warn threshold = 10, and used=1 should not warn
    expect(tooHighRatio.warn).toBe(false);
  });

  it('does not bleed counts across turn ids', () => {
    const records = [
      rec('t1'),
      rec('t1'),
      rec('t1'),
      rec('t2'),
      rec('t2'),
      rec('t2'),
      rec('t2'),
      rec('t2'),
    ];
    expect(evaluateStepBudget(records, 't1', { cap: 5 }).exceeded).toBe(false);
    expect(evaluateStepBudget(records, 't2', { cap: 5 }).exceeded).toBe(true);
  });
});
