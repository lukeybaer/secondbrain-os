import { describe, it, expect } from 'vitest';
import { classifyStep, countSkippableSteps, type PlannedStep } from '../agent-step-classifier';

describe('agent-step-classifier', () => {
  it('classifies a read-only idempotent resolved-arg tool as deterministic', () => {
    const v = classifyStep({
      tool: 'search_memory',
      sideEffects: 'read',
      idempotent: true,
      approval: 'none',
      argsResolved: true,
    });
    expect(v.kind).toBe('deterministic');
    expect(v.skipModelTurn).toBe(true);
  });

  it('classifies a bare reasoning step (no tool) as reasoning', () => {
    const v = classifyStep({});
    expect(v.kind).toBe('reasoning');
    expect(v.skipModelTurn).toBe(false);
  });

  it('classifies known reasoning tools as reasoning even if read-only', () => {
    for (const tool of ['think', 'analyze', 'plan', 'Reflect']) {
      const v = classifyStep({ tool, sideEffects: 'read', idempotent: true });
      expect(v.kind).toBe('reasoning');
    }
  });

  it('forces a write tool to reasoning regardless of other flags', () => {
    const v = classifyStep({
      tool: 'send_email',
      sideEffects: 'write',
      idempotent: true,
      approval: 'none',
      argsResolved: true,
    });
    expect(v.kind).toBe('reasoning');
    expect(v.reason).toContain('write');
  });

  it('forces a destructive tool to reasoning', () => {
    const v = classifyStep({ tool: 'delete_record', sideEffects: 'destructive' });
    expect(v.kind).toBe('reasoning');
  });

  it('keeps an approval-gated read tool in reasoning', () => {
    const v = classifyStep({
      tool: 'read_pii',
      sideEffects: 'read',
      idempotent: true,
      approval: 'review',
      argsResolved: true,
    });
    expect(v.kind).toBe('reasoning');
    expect(v.reason).toContain('approval');
  });

  it('keeps a step with unresolved args in reasoning', () => {
    const v = classifyStep({
      tool: 'search_memory',
      sideEffects: 'read',
      idempotent: true,
      argsResolved: false,
    });
    expect(v.kind).toBe('reasoning');
    expect(v.reason).toContain('arguments');
  });

  it('does not assume an ExampleCo side-effect class is safe', () => {
    const v = classifyStep({ tool: 'mystery', idempotent: true, argsResolved: true });
    expect(v.kind).toBe('reasoning');
  });

  it('keeps a read tool not marked idempotent in reasoning', () => {
    const v = classifyStep({
      tool: 'pop_queue',
      sideEffects: 'read',
      idempotent: false,
      argsResolved: true,
    });
    expect(v.kind).toBe('reasoning');
  });

  it('honors an explicit forceKind override', () => {
    const det = classifyStep({ tool: 'think', forceKind: 'deterministic' });
    expect(det.kind).toBe('deterministic');
    expect(det.skipModelTurn).toBe(true);
    const reason = classifyStep({
      tool: 'search_memory',
      sideEffects: 'read',
      idempotent: true,
      argsResolved: true,
      forceKind: 'reasoning',
    });
    expect(reason.kind).toBe('reasoning');
  });

  it('counts skippable steps across a planned turn', () => {
    const steps: PlannedStep[] = [
      { tool: 'search_memory', sideEffects: 'read', idempotent: true, argsResolved: true },
      { tool: 'get_config', sideEffects: 'read', idempotent: true, argsResolved: true },
      { tool: 'send_email', sideEffects: 'write' },
      {}, // bare reasoning
    ];
    expect(countSkippableSteps(steps)).toBe(2);
  });

  it('never sets skipModelTurn on a reasoning verdict', () => {
    const samples: PlannedStep[] = [
      {},
      { tool: 'think' },
      { tool: 'send_email', sideEffects: 'write' },
      { tool: 'x', sideEffects: 'read', idempotent: false },
    ];
    for (const s of samples) {
      const v = classifyStep(s);
      if (v.kind === 'reasoning') expect(v.skipModelTurn).toBe(false);
    }
  });
});
