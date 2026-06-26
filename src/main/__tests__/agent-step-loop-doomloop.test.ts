// agent-step-loop-doomloop.test.ts
//
// Run 97 enhancement 1: regression tests for the doom-loop detector.
// Encodes the category (stuck patterns get caught well before max_steps and
// the loop halts with haltReason='doom_loop'), not the literal trigger.
// Per feedback_frugal_regression_tests.md.

import { describe, it, expect } from 'vitest';
import {
  runAgentLoop,
  ToolDef,
  AssistantTurn,
  ChatMessage,
  StepRecord,
  makeToolCallId,
} from '../agent-step-loop';
import {
  detectDoomLoop,
  composeMonitor,
  repeatedToolCallDetector,
  repeatedErrorDetector,
  noProgressDetector,
} from '../agent-step-loop-doomloop';

// Tiny helpers

function scriptedRunner(turns: AssistantTurn[]) {
  let i = 0;
  return async (_messages: ChatMessage[], _tools: ToolDef[]): Promise<AssistantTurn> => {
    if (i >= turns.length) {
      throw new Error(`scripted runner exhausted after ${turns.length} turns`);
    }
    return turns[i++];
  };
}

function step(args: Partial<StepRecord> & Pick<StepRecord, 'step'>): StepRecord {
  return {
    timestamp: new Date(0).toISOString(),
    assistant_content: '',
    tool_calls: [],
    chain_reason: 'heartbeat',
    duration_ms: 0,
    ...args,
  };
}

function tcall(name: string, args: Record<string, ExampleCo> = {}, error?: string) {
  return {
    id: makeToolCallId(),
    name,
    arguments: args,
    result: null,
    request_heartbeat: true,
    error,
    duration_ms: 0,
  };
}

// ── Pure detector tests ─────────────────────────────────────────────────────

describe('detectDoomLoop (pure)', () => {
  it('flags repeated_tool_call when N steps repeat the same (tool, args)', () => {
    const history: StepRecord[] = [
      step({ step: 1, tool_calls: [tcall('search', { q: 'foo' })] }),
      step({ step: 2, tool_calls: [tcall('search', { q: 'foo' })] }),
      step({ step: 3, tool_calls: [tcall('search', { q: 'foo' })] }),
    ];
    const v = detectDoomLoop(history);
    expect(v?.pattern).toBe('repeated_tool_call');
    expect(v?.detail).toContain('search');
  });

  it('does not flag repeated_tool_call when args drift between steps', () => {
    const history: StepRecord[] = [
      step({ step: 1, tool_calls: [tcall('search', { q: 'foo' })] }),
      step({ step: 2, tool_calls: [tcall('search', { q: 'bar' })] }),
      step({ step: 3, tool_calls: [tcall('search', { q: 'baz' })] }),
    ];
    expect(detectDoomLoop(history)).toBeNull();
  });

  it('treats parallel tool calls in different orders as the same signature', () => {
    // Model may emit { a, b } in step 1 and { b, a } in step 2; the
    // canonicalizer should sort so they compare equal.
    const history: StepRecord[] = [
      step({
        step: 1,
        tool_calls: [tcall('a', { x: 1 }), tcall('b', { y: 2 })],
      }),
      step({
        step: 2,
        tool_calls: [tcall('b', { y: 2 }), tcall('a', { x: 1 })],
      }),
      step({
        step: 3,
        tool_calls: [tcall('a', { x: 1 }), tcall('b', { y: 2 })],
      }),
    ];
    const v = detectDoomLoop(history);
    expect(v?.pattern).toBe('repeated_tool_call');
  });

  it('flags repeated_error when M consecutive steps all errored', () => {
    const history: StepRecord[] = [
      step({ step: 1, tool_calls: [tcall('send', { id: 1 }, 'timeout')] }),
      step({ step: 2, tool_calls: [tcall('send', { id: 2 }, 'timeout')] }),
      step({ step: 3, tool_calls: [tcall('send', { id: 3 }, 'timeout')] }),
    ];
    const v = detectDoomLoop(history);
    // repeated_tool_call beats repeated_error in fixed order when args drift;
    // here args drift each step so repeated_tool_call cannot fire and the
    // repeated_error detector wins.
    expect(v?.pattern).toBe('repeated_error');
    expect(v?.detail).toContain('timeout');
  });

  it('flags no_progress when assistant content is unchanged across K steps', () => {
    const history: StepRecord[] = [
      step({
        step: 1,
        assistant_content: 'Still thinking...',
        // Each step has a tool call with unique args so repeated_tool_call
        // does not fire and the no_progress detector wins.
        tool_calls: [tcall('peek', { i: 1 })],
      }),
      step({
        step: 2,
        assistant_content: 'still thinking...',
        tool_calls: [tcall('peek', { i: 2 })],
      }),
      step({
        step: 3,
        assistant_content: 'STILL THINKING...',
        tool_calls: [tcall('peek', { i: 3 })],
      }),
    ];
    const v = detectDoomLoop(history);
    expect(v?.pattern).toBe('no_progress');
  });

  it('returns null when below the warmup window', () => {
    const history: StepRecord[] = [step({ step: 1, tool_calls: [tcall('search', { q: 'foo' })] })];
    expect(detectDoomLoop(history)).toBeNull();
  });

  it('respects custom thresholds', () => {
    const history: StepRecord[] = [
      step({ step: 1, tool_calls: [tcall('search', { q: 'foo' })] }),
      step({ step: 2, tool_calls: [tcall('search', { q: 'foo' })] }),
    ];
    // Default threshold is 3, so no hit; lowering it to 2 trips.
    expect(detectDoomLoop(history)).toBeNull();
    const v = detectDoomLoop(history, { repeatedToolCallThreshold: 2 });
    expect(v?.pattern).toBe('repeated_tool_call');
  });

  it('detector order is repeated_tool_call > repeated_error > no_progress', () => {
    // All three would fire on this history.
    const history: StepRecord[] = [
      step({
        step: 1,
        assistant_content: 'same',
        tool_calls: [tcall('search', { q: 'foo' }, 'boom')],
      }),
      step({
        step: 2,
        assistant_content: 'same',
        tool_calls: [tcall('search', { q: 'foo' }, 'boom')],
      }),
      step({
        step: 3,
        assistant_content: 'same',
        tool_calls: [tcall('search', { q: 'foo' }, 'boom')],
      }),
    ];
    const v = detectDoomLoop(history);
    expect(v?.pattern).toBe('repeated_tool_call');
  });
});

// ── Loop integration tests ──────────────────────────────────────────────────

describe('runAgentLoop with monitor hook', () => {
  it('halts with haltReason=doom_loop when the monitor returns a verdict', async () => {
    const tools: ToolDef[] = [
      {
        name: 'noop',
        description: '',
        run: async () => ({ result: 'x', request_heartbeat: true }),
      },
    ];
    const turns: AssistantTurn[] = [
      { content: '', tool_calls: [{ id: makeToolCallId(), name: 'noop', arguments: {} }] },
      { content: '', tool_calls: [{ id: makeToolCallId(), name: 'noop', arguments: {} }] },
      { content: '', tool_calls: [{ id: makeToolCallId(), name: 'noop', arguments: {} }] },
      // 4th turn would be the next chain attempt if the monitor did NOT halt.
      // We expect haltReason='doom_loop' BEFORE this turn fires.
      { content: 'should not be reached', tool_calls: [] },
    ];

    const result = await runAgentLoop({
      initialMessages: [{ role: 'user', content: 'go' }],
      tools,
      runTurn: scriptedRunner(turns),
      maxSteps: 10,
      monitor: composeMonitor(),
    });

    expect(result.haltReason).toBe('doom_loop');
    expect(result.haltDetail).toContain('repeated_tool_call');
    expect(result.steps.length).toBe(3);
  });

  it('attaches a Magentic recovery decision on a doom-loop halt when recovery state is supplied', async () => {
    const tools: ToolDef[] = [
      {
        name: 'noop',
        description: '',
        run: async () => ({ result: 'x', request_heartbeat: true }),
      },
    ];
    const turns: AssistantTurn[] = [
      { content: '', tool_calls: [{ id: makeToolCallId(), name: 'noop', arguments: {} }] },
      { content: '', tool_calls: [{ id: makeToolCallId(), name: 'noop', arguments: {} }] },
      { content: '', tool_calls: [{ id: makeToolCallId(), name: 'noop', arguments: {} }] },
      { content: 'unreached', tool_calls: [] },
    ];
    // resets remain (resetCount 0, maxResets 1) and we are already at the stall
    // ceiling, so the doom verdict should push to a 'replan' recommendation.
    const result = await runAgentLoop({
      initialMessages: [{ role: 'user', content: 'go' }],
      tools,
      runTurn: scriptedRunner(turns),
      maxSteps: 10,
      monitor: composeMonitor(),
      magenticRecovery: {
        state: {
          task: { facts: { given: [], toLookUp: [], toDerive: [] }, plan: [], revision: 0 },
          stallCount: 1,
          resetCount: 0,
          roundCount: 0,
        },
        limits: { maxRounds: 10, maxStalls: 1, maxResets: 1 },
      },
    });
    expect(result.haltReason).toBe('doom_loop');
    expect(result.recovery).toEqual({ kind: 'replan', reason: 'stalled' });
  });

  it('omits recovery when no magenticRecovery state is supplied', async () => {
    const tools: ToolDef[] = [
      {
        name: 'noop',
        description: '',
        run: async () => ({ result: 'x', request_heartbeat: true }),
      },
    ];
    const turns: AssistantTurn[] = [
      { content: '', tool_calls: [{ id: makeToolCallId(), name: 'noop', arguments: {} }] },
      { content: '', tool_calls: [{ id: makeToolCallId(), name: 'noop', arguments: {} }] },
      { content: '', tool_calls: [{ id: makeToolCallId(), name: 'noop', arguments: {} }] },
      { content: 'unreached', tool_calls: [] },
    ];
    const result = await runAgentLoop({
      initialMessages: [{ role: 'user', content: 'go' }],
      tools,
      runTurn: scriptedRunner(turns),
      maxSteps: 10,
      monitor: composeMonitor(),
    });
    expect(result.haltReason).toBe('doom_loop');
    expect(result.recovery).toBeUndefined();
  });

  it('does not halt when the monitor returns null', async () => {
    const tools: ToolDef[] = [
      { name: 'noop', description: '', run: async () => ({ result: 'x' }) },
    ];
    const turns: AssistantTurn[] = [{ content: 'final', tool_calls: [] }];
    const result = await runAgentLoop({
      initialMessages: [{ role: 'user', content: 'go' }],
      tools,
      runTurn: scriptedRunner(turns),
      monitor: () => null,
    });
    expect(result.haltReason).toBe('no_tool_calls');
  });

  it('survives a buggy monitor without breaking the loop', async () => {
    const tools: ToolDef[] = [
      { name: 'noop', description: '', run: async () => ({ result: 'x' }) },
    ];
    const turns: AssistantTurn[] = [
      { content: '', tool_calls: [{ id: makeToolCallId(), name: 'noop', arguments: {} }] },
      { content: 'done', tool_calls: [] },
    ];
    const result = await runAgentLoop({
      initialMessages: [{ role: 'user', content: 'go' }],
      tools,
      runTurn: scriptedRunner(turns),
      monitor: () => {
        throw new Error('monitor exploded');
      },
    });
    // Tool returned no heartbeat so the loop halts naturally; the buggy
    // monitor did NOT bubble up its exception.
    expect(result.haltReason).toBe('no_heartbeat');
  });
});

// ── Composer / extension tests ──────────────────────────────────────────────

describe('composeMonitor', () => {
  it('built-in detectors fire before custom ones', () => {
    const monitor = composeMonitor([() => ({ pattern: 'custom', detail: 'should not fire' })]);
    const history: StepRecord[] = [
      step({ step: 1, tool_calls: [tcall('search', { q: 'foo' })] }),
      step({ step: 2, tool_calls: [tcall('search', { q: 'foo' })] }),
      step({ step: 3, tool_calls: [tcall('search', { q: 'foo' })] }),
    ];
    expect(monitor(history)).toMatchObject({ pattern: 'repeated_tool_call' });
  });

  it('custom detector fires when built-ins return null', () => {
    const monitor = composeMonitor([
      (steps) => (steps.length >= 2 ? { pattern: 'custom_flag', detail: 'custom hit' } : null),
    ]);
    const history: StepRecord[] = [
      step({
        step: 1,
        assistant_content: 'a',
        tool_calls: [tcall('search', { q: 'foo' })],
      }),
      step({
        step: 2,
        assistant_content: 'b',
        tool_calls: [tcall('search', { q: 'bar' })],
      }),
    ];
    expect(monitor(history)).toMatchObject({ pattern: 'custom_flag' });
  });
});
