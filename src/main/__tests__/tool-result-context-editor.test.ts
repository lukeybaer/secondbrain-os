import { describe, it, expect } from 'vitest';
import {
  clearToolResults,
  applyContextEdit,
  estimateTokensDefault,
  type EditableMessage,
} from '../tool-result-context-editor';

// tool-result-context-editor is the pure-TS analogue of Anthropic's
// clear_tool_uses: once a long loop's transcript crosses a token trigger, the
// OLDEST tool-result contents are replaced with a placeholder while the most
// recent N stay intact and protected tools are never touched. Per
// feedback_frugal_regression_tests these lock the CONTRACT (trigger gate,
// keep-N, exclude, at-least floor, count/pairing preserved), not one payload.

// Small estimator so tests reason in "tokens" directly: 1 char == 1 token.
const oneCharPerToken = (t: string) => t.length;

function convo(toolBytes: number, n: number): EditableMessage[] {
  const msgs: EditableMessage[] = [{ role: 'user', content: 'go' }];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, name: `tool${i}` }] });
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: 'R'.repeat(toolBytes) });
  }
  return msgs;
}

describe('clearToolResults trigger + keep-N', () => {
  it('is a no-op below the token trigger', () => {
    const msgs = convo(10, 3);
    const r = clearToolResults(msgs, { triggerTokens: 1000, estimateTokens: oneCharPerToken });
    expect(r.edited).toBe(false);
    expect(r.clearedIds).toEqual([]);
    expect(r.messages).toEqual(msgs);
  });

  it('clears oldest tool results and keeps the most recent N', () => {
    const msgs = convo(100, 5); // 5 tool results * 100 = 500 tokens
    const r = clearToolResults(msgs, {
      triggerTokens: 250,
      keepRecentToolResults: 2,
      clearAtLeastTokens: 1,
      estimateTokens: oneCharPerToken,
    });
    expect(r.edited).toBe(true);
    // 5 tool results, keep last 2 -> clear first 3
    expect(r.clearedIds).toEqual(['c0', 'c1', 'c2']);
    expect(r.clearedTokens).toBe(300);
    // last two remain full length
    const toolMsgs = r.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs[3].content).toBe('R'.repeat(100));
    expect(toolMsgs[4].content).toBe('R'.repeat(100));
    // cleared ones carry a placeholder breadcrumb, not the payload
    expect(toolMsgs[0].content).toMatch(/cleared/i);
    expect(toolMsgs[0].content).toContain('tool0');
  });

  it('preserves message count and non-tool messages', () => {
    const msgs = convo(100, 4);
    const r = clearToolResults(msgs, {
      triggerTokens: 100,
      keepRecentToolResults: 1,
      clearAtLeastTokens: 1,
      estimateTokens: oneCharPerToken,
    });
    expect(r.messages).toHaveLength(msgs.length);
    expect(r.messages[0]).toEqual({ role: 'user', content: 'go' });
  });

  it('never clears excludeTools results', () => {
    const msgs = convo(100, 4);
    // tool1 is protected; it must keep its payload even though it is old.
    const r = clearToolResults(msgs, {
      triggerTokens: 100,
      keepRecentToolResults: 0,
      clearAtLeastTokens: 1,
      excludeTools: ['tool1'],
      estimateTokens: oneCharPerToken,
    });
    expect(r.clearedIds).not.toContain('c1');
    const protectedMsg = r.messages.find((m) => m.tool_call_id === 'c1');
    expect(protectedMsg!.content).toBe('R'.repeat(100));
  });

  it('vetoes a trivial edit below clearAtLeastTokens', () => {
    const msgs = convo(30, 4); // over a low trigger, but each result is tiny
    const r = clearToolResults(msgs, {
      triggerTokens: 100,
      keepRecentToolResults: 3,
      clearAtLeastTokens: 1000, // reclaimable (30) is far below
      estimateTokens: oneCharPerToken,
    });
    expect(r.edited).toBe(false);
  });

  it('does not mutate the input array', () => {
    const msgs = convo(100, 5);
    const before = msgs[2].content;
    clearToolResults(msgs, {
      triggerTokens: 100,
      keepRecentToolResults: 0,
      clearAtLeastTokens: 1,
      estimateTokens: oneCharPerToken,
    });
    expect(msgs[2].content).toBe(before);
  });

  it('is deterministic', () => {
    const a = clearToolResults(convo(100, 5), {
      triggerTokens: 100,
      estimateTokens: oneCharPerToken,
    });
    const b = clearToolResults(convo(100, 5), {
      triggerTokens: 100,
      estimateTokens: oneCharPerToken,
    });
    expect(a).toEqual(b);
  });
});

describe('applyContextEdit (in-place)', () => {
  it('rewrites cleared contents on the existing objects, preserving identity', () => {
    const msgs = convo(100, 4);
    const firstToolRef = msgs[2]; // role:'tool', c0
    const res = applyContextEdit(msgs, {
      triggerTokens: 100,
      keepRecentToolResults: 1,
      clearAtLeastTokens: 1,
      estimateTokens: oneCharPerToken,
    });
    expect(res.edited).toBe(true);
    // same object reference, new content
    expect(msgs[2]).toBe(firstToolRef);
    expect(msgs[2].content).toMatch(/cleared/i);
  });

  it('leaves the array untouched below the trigger', () => {
    const msgs = convo(10, 2);
    const snapshot = msgs.map((m) => m.content);
    const res = applyContextEdit(msgs, { triggerTokens: 10_000, estimateTokens: oneCharPerToken });
    expect(res.edited).toBe(false);
    expect(msgs.map((m) => m.content)).toEqual(snapshot);
  });
});

describe('estimateTokensDefault', () => {
  it('approximates ~4 chars per token', () => {
    expect(estimateTokensDefault('12345678')).toBe(2);
    expect(estimateTokensDefault('')).toBe(0);
  });
});
