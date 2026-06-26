import { describe, expect, it } from 'vitest';
import { buildRulesTrace, recordRulesDecision, summarizeRulesDecision } from '../tool-rules-trace';
import type { SolveResult } from '../tool-rules-solver';

const RESULT: SolveResult = {
  allowed: ['memory_search'],
  blocked: [
    {
      tool: 'gmail_send',
      rule: 'requires_approval',
      reason: 'needs approval',
    },
    {
      tool: 'place_outbound_call',
      rule: 'max_count',
      reason: 'already called once',
    },
  ],
  requires_approval: ['gmail_send'],
  terminated: false,
};

describe('tool-rules-trace', () => {
  it('summarizes allowed, blocked, and approval-gated tools', () => {
    expect(summarizeRulesDecision(RESULT)).toBe(
      'tool-rules: 1 allowed, 2 blocked (1 max_count, 1 requires_approval); 1 awaiting approval',
    );
  });

  it('builds a structured trace record', () => {
    const trace = buildRulesTrace(RESULT);

    expect(trace.allowed_count).toBe(1);
    expect(trace.blocked_count).toBe(2);
    expect(trace.blocked_by_rule.requires_approval).toBe(1);
    expect(trace.blocked_by_rule.max_count).toBe(1);
  });

  it('does not let writer errors break routing', () => {
    const trace = recordRulesDecision(RESULT, () => {
      throw new Error('writer down');
    });

    expect(trace.summary).toContain('1 allowed');
  });
});
