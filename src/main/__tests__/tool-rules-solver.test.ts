import { describe, expect, it } from 'vitest';
import { nextAllowedTools, solveToolRules } from '../tool-rules-solver';

describe('tool-rules-solver', () => {
  it('requires init tools before any other tool can run', () => {
    const result = solveToolRules({
      rules: [{ type: 'init', tool: 'archive_raw' }],
      history: [],
      available: ['archive_raw', 'summarize', 'send'],
    });

    expect(result.allowed).toEqual(['archive_raw']);
    expect(result.blocked.map((b) => b.tool)).toEqual(['summarize', 'send']);
  });

  it('enforces child rules immediately after a parent tool', () => {
    const result = solveToolRules({
      rules: [{ type: 'child', parent: 'send_message', children: ['write_receipt'] }],
      history: [{ tool: 'archive_raw' }, { tool: 'send_message' }],
      available: ['write_receipt', 'send_message', 'summarize'],
    });

    expect(result.allowed).toEqual(['write_receipt']);
    expect(result.blocked.every((b) => b.rule === 'child')).toBe(true);
  });

  it('caps repeated destructive tools', () => {
    const result = solveToolRules({
      rules: [{ type: 'max_count', tool: 'place_outbound_call', max: 1 }],
      history: [{ tool: 'place_outbound_call' }],
      available: ['place_outbound_call', 'write_receipt'],
    });

    expect(result.allowed).toEqual(['write_receipt']);
    expect(result.blocked[0]).toMatchObject({ tool: 'place_outbound_call', rule: 'max_count' });
  });

  it('surfaces approval-gated tools separately', () => {
    const result = solveToolRules({
      rules: [{ type: 'requires_approval', tool: 'gmail_send' }],
      history: [{ tool: 'draft_reply' }],
      available: ['gmail_send', 'memory_search'],
    });

    expect(result.allowed).toEqual(['memory_search']);
    expect(result.requires_approval).toEqual(['gmail_send']);
  });

  it('stops after a terminal tool', () => {
    const result = solveToolRules({
      rules: [{ type: 'terminal', tool: 'write_receipt' }],
      history: [{ tool: 'write_receipt' }],
      available: ['memory_search', 'gmail_send'],
    });

    expect(result.terminated).toBe(true);
    expect(result.allowed).toEqual([]);
  });

  it('returns allowed tool names through the convenience helper', () => {
    expect(
      nextAllowedTools({
        rules: [],
        history: [],
        available: ['memory_search'],
      }),
    ).toEqual(['memory_search']);
  });
});
