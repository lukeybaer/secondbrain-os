import { describe, it, expect } from 'vitest';
import {
  runAgentLoop,
  ToolDef,
  AssistantTurn,
  ChatMessage,
  makeToolCallId,
  chainingTool,
} from '../agent-step-loop';

// Tiny scripted "LLM" — the test feeds it a queue of turns to return.
function scriptedRunner(turns: AssistantTurn[]) {
  let i = 0;
  return async (_messages: ChatMessage[], _tools: ToolDef[]): Promise<AssistantTurn> => {
    if (i >= turns.length) {
      throw new Error(`scripted runner exhausted after ${turns.length} turns`);
    }
    return turns[i++];
  };
}

describe('runAgentLoop', () => {
  it('halts immediately when the assistant returns no tool calls', async () => {
    const result = await runAgentLoop({
      initialMessages: [{ role: 'user', content: 'hello' }],
      tools: [],
      runTurn: scriptedRunner([{ content: 'hi back' }]),
    });

    expect(result.haltReason).toBe('no_tool_calls');
    expect(result.steps).toHaveLength(1);
    expect(result.finalMessage.content).toBe('hi back');
  });

  it('chains a step when a tool requests a heartbeat, then halts', async () => {
    const lookupCalls: Record<string, unknown>[] = [];
    const lookup: ToolDef = {
      name: 'lookup_contact',
      description: 'find a contact by name',
      run: async (args) => {
        lookupCalls.push(args);
        return { result: { phone: '+15551234567' }, request_heartbeat: true };
      },
    };

    const turns: AssistantTurn[] = [
      {
        content: 'looking up',
        tool_calls: [{ id: makeToolCallId(), name: 'lookup_contact', arguments: { name: 'Luke' } }],
      },
      { content: 'Luke is at +15551234567.' },
    ];

    const result = await runAgentLoop({
      initialMessages: [{ role: 'user', content: 'phone for Luke?' }],
      tools: [lookup],
      runTurn: scriptedRunner(turns),
    });

    expect(result.haltReason).toBe('no_tool_calls');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].chain_reason).toBe('heartbeat');
    expect(result.steps[1].chain_reason).toBe('none');
    expect(lookupCalls).toEqual([{ name: 'Luke' }]);
  });

  it('halts with no_heartbeat when tool result has no heartbeat flag', async () => {
    const tool: ToolDef = {
      name: 'noop',
      description: 'noop',
      run: async () => ({ result: 'ok' }),
    };
    const result = await runAgentLoop({
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      runTurn: scriptedRunner([
        { content: '', tool_calls: [{ id: 't1', name: 'noop', arguments: {} }] },
      ]),
    });
    expect(result.haltReason).toBe('no_heartbeat');
    expect(result.steps).toHaveLength(1);
  });

  it('treats tool errors as a chain reason and surfaces them as ToolResult.error', async () => {
    const tool: ToolDef = {
      name: 'flaky',
      description: 'always throws',
      run: async () => {
        throw new Error('disk full');
      },
    };
    const turns: AssistantTurn[] = [
      { content: '', tool_calls: [{ id: 't1', name: 'flaky', arguments: {} }] },
      { content: 'recovered' },
    ];
    const result = await runAgentLoop({
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      runTurn: scriptedRunner(turns),
    });
    expect(result.steps[0].chain_reason).toBe('tool_error');
    expect(result.steps[0].tool_calls[0].error).toBe('disk full');
    expect(result.haltReason).toBe('no_tool_calls');
  });

  it('respects maxSteps as a safety rail and halts with max_steps', async () => {
    const heartbeating: ToolDef = chainingTool('keep_going', 'always asks for more', () => 'x');
    const infiniteTurns = (): AssistantTurn => ({
      content: '',
      tool_calls: [{ id: makeToolCallId(), name: 'keep_going', arguments: {} }],
    });
    const turns = Array.from({ length: 10 }, infiniteTurns);

    const result = await runAgentLoop({
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [heartbeating],
      runTurn: scriptedRunner(turns),
      maxSteps: 3,
    });

    expect(result.haltReason).toBe('max_steps');
    expect(result.steps).toHaveLength(3);
  });

  it('halts with tool_not_found if the model calls an unregistered tool', async () => {
    const result = await runAgentLoop({
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [],
      runTurn: scriptedRunner([
        { content: '', tool_calls: [{ id: 't1', name: 'phantom', arguments: {} }] },
      ]),
    });
    expect(result.haltReason).toBe('tool_not_found');
    expect(result.haltDetail).toBe('phantom');
  });

  it('halts with turn_failed if the runner rejects', async () => {
    const result = await runAgentLoop({
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [],
      runTurn: async () => {
        throw new Error('claude offline');
      },
    });
    expect(result.haltReason).toBe('turn_failed');
    expect(result.haltDetail).toBe('claude offline');
  });

  it('forces a chain when isMemoryPressured returns true even without heartbeat', async () => {
    const pressed = { value: true };
    const tool: ToolDef = {
      name: 'noop',
      description: 'noop',
      run: async () => ({ result: 'ok' }), // no heartbeat
    };
    const turns: AssistantTurn[] = [
      { content: '', tool_calls: [{ id: 't1', name: 'noop', arguments: {} }] },
      { content: 'after eviction' }, // pressure still true so we chain again
      { content: 'final' },
    ];

    const result = await runAgentLoop({
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      runTurn: scriptedRunner(turns),
      isMemoryPressured: () => {
        const v = pressed.value;
        pressed.value = false; // pressure clears after one chain
        return v;
      },
    });

    expect(result.steps[0].chain_reason).toBe('memory_pressure');
    expect(result.steps).toHaveLength(2);
    expect(result.haltReason).toBe('no_tool_calls');
  });

  it('rejects duplicate tool registrations', async () => {
    const t: ToolDef = { name: 'dup', description: '', run: async () => ({ result: 1 }) };
    await expect(
      runAgentLoop({
        initialMessages: [{ role: 'user', content: 'go' }],
        tools: [t, t],
        runTurn: scriptedRunner([{ content: 'ok' }]),
      }),
    ).rejects.toThrow(/duplicate tool/);
  });

  it('rejects empty initialMessages', async () => {
    await expect(
      runAgentLoop({
        initialMessages: [],
        tools: [],
        runTurn: scriptedRunner([{ content: 'x' }]),
      }),
    ).rejects.toThrow(/initialMessages/);
  });

  it('invokes onStep for every step in order', async () => {
    const seen: number[] = [];
    const turns: AssistantTurn[] = [
      { content: '', tool_calls: [{ id: 't1', name: 'k', arguments: {} }] },
      { content: 'done' },
    ];
    await runAgentLoop({
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [chainingTool('k', '', () => 'x')],
      runTurn: scriptedRunner(turns),
      onStep: (s) => seen.push(s.step),
    });
    expect(seen).toEqual([1, 2]);
  });

  it('chaining=false runs exactly one step even with heartbeat', async () => {
    const turns: AssistantTurn[] = [
      { content: '', tool_calls: [{ id: 't1', name: 'k', arguments: {} }] },
    ];
    const result = await runAgentLoop({
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [chainingTool('k', '', () => 'x')],
      runTurn: scriptedRunner(turns),
      chaining: false,
    });
    expect(result.steps).toHaveLength(1);
    expect(result.haltReason).toBe('no_heartbeat');
  });
});
