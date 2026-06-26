import { describe, it, expect } from 'vitest';
import { gateToolDefsByRules, type ToolDef } from '../agent-step-loop';
import type { ToolRule } from '../tool-rules-solver';
import type { RulesTraceRecord } from '../tool-rules-trace';

const def = (name: string): ToolDef => ({
  name,
  description: name,
  run: async () => ({ result: name }),
});

describe('gateToolDefsByRules', () => {
  it('drops a tool blocked by an explicit rule, preserving order', () => {
    const tools = [def('memory_search'), def('gmail_send'), def('web_search')];
    const rules: ToolRule[] = [{ type: 'requires_approval', tool: 'gmail_send' }];
    const gated = gateToolDefsByRules(tools, { rules });
    expect(gated.map((t) => t.name)).toEqual(['memory_search', 'web_search']);
  });

  it('lets an approved tool through', () => {
    const tools = [def('gmail_send')];
    const rules: ToolRule[] = [{ type: 'requires_approval', tool: 'gmail_send' }];
    const gated = gateToolDefsByRules(tools, { rules, approvals: ['gmail_send'] });
    expect(gated.map((t) => t.name)).toEqual(['gmail_send']);
  });

  it('enforces no-redial from history', () => {
    const tools = [def('place_outbound_call'), def('web_search')];
    const rules: ToolRule[] = [{ type: 'max_count', tool: 'place_outbound_call', max: 1 }];
    const gated = gateToolDefsByRules(tools, {
      rules,
      history: [{ tool: 'place_outbound_call' }],
    });
    expect(gated.map((t) => t.name)).toEqual(['web_search']);
  });

  it('feeds the decision to an injected trace writer', () => {
    const tools = [def('gmail_send'), def('web_search')];
    const rules: ToolRule[] = [{ type: 'requires_approval', tool: 'gmail_send' }];
    const records: RulesTraceRecord[] = [];
    gateToolDefsByRules(tools, { rules, traceWriter: (r) => records.push(r) });
    expect(records).toHaveLength(1);
    expect(records[0].blocked_count).toBe(1);
    expect(records[0].requires_approval).toEqual(['gmail_send']);
  });

  it('defaults to the registry-derived SECONDBRAIN_TOOL_RULES when no rules given', () => {
    // gmail_send is approval-gated in the default registry, so without an
    // approval it must be filtered out by the default rule set.
    const tools = [def('memory_search'), def('gmail_send')];
    const gated = gateToolDefsByRules(tools);
    expect(gated.map((t) => t.name)).toContain('memory_search');
    expect(gated.map((t) => t.name)).not.toContain('gmail_send');
  });
});
