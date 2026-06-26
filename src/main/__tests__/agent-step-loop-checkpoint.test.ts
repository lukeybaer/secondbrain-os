// agent-step-loop-checkpoint.test.ts
//
// Run 96 nightly enhancement: regression test for the checkpoint + resume
// wire. Encodes the CATEGORY (a snapshot is persisted at each step
// boundary and a resumed loop continues with the same run_id from the next
// step), not the literal trigger. Per feedback_frugal_regression_tests.md.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runAgentLoop,
  resumeAgentLoop,
  ToolDef,
  AssistantTurn,
  ChatMessage,
  AgentLoopSnapshot,
  makeToolCallId,
} from '../agent-step-loop';
import {
  JsonlCheckpointStore,
  MemoryCheckpointStore,
  makePersistHook,
} from '../agent-step-loop-checkpoint';

function scriptedRunner(turns: AssistantTurn[]) {
  let i = 0;
  return async (_messages: ChatMessage[], _tools: ToolDef[]): Promise<AssistantTurn> => {
    if (i >= turns.length) {
      throw new Error(`scripted runner exhausted after ${turns.length} turns`);
    }
    return turns[i++];
  };
}

describe('agent-step-loop checkpoint + resume', () => {
  it('persists a snapshot at every step boundary', async () => {
    const store = new MemoryCheckpointStore();
    const lookup: ToolDef = {
      name: 'lookup_contact',
      description: 'find a contact',
      run: async () => ({ result: { phone: '+15551234567' }, request_heartbeat: true }),
    };
    await runAgentLoop({
      run_id: 'run_test_persist',
      initialMessages: [{ role: 'user', content: 'phone for ExampleCo?' }],
      tools: [lookup],
      runTurn: scriptedRunner([
        {
          content: 'looking up',
          tool_calls: [{ id: makeToolCallId(), name: 'lookup_contact', arguments: { name: 'ExampleCo' } }],
        },
        { content: 'ExampleCo is at +15551234567.' },
      ]),
      onStepPersist: makePersistHook(store),
    });

    const history = store.history();
    // Step 1 (chained) + step 2 (halt) = 2 snapshots minimum.
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history.every((s) => s.run_id === 'run_test_persist')).toBe(true);
    const final = history[history.length - 1];
    expect(final.halt_reason).toBe('no_tool_calls');
    expect(final.step_index).toBe(2);
  });

  it('resumes from snapshot with the same run_id and continues from next step', async () => {
    const store = new MemoryCheckpointStore();
    const callCounts: Record<string, number> = { lookup: 0, calc: 0 };
    const lookup: ToolDef = {
      name: 'lookup',
      description: 'first tool',
      run: async () => {
        callCounts.lookup += 1;
        return { result: 'L', request_heartbeat: true };
      },
    };
    const calc: ToolDef = {
      name: 'calc',
      description: 'second tool',
      run: async () => {
        callCounts.calc += 1;
        return { result: 42, request_heartbeat: true };
      },
    };

    // First leg: runner script "crashes" after step 1 by throwing.
    let crashed = false;
    const crashRunner = scriptedRunner([
      {
        content: 'phase 1',
        tool_calls: [{ id: makeToolCallId(), name: 'lookup', arguments: {} }],
      },
    ]);
    const wrappedRunner = async (m: ChatMessage[], t: ToolDef[]): Promise<AssistantTurn> => {
      if (crashed) throw new Error('simulated crash');
      const turn = await crashRunner(m, t);
      // After delivering the first turn, the next call simulates a crash.
      crashed = true;
      return turn;
    };

    const first = await runAgentLoop({
      run_id: 'run_resume_test',
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [lookup, calc],
      runTurn: wrappedRunner,
      onStepPersist: makePersistHook(store),
    });
    expect(first.haltReason).toBe('turn_failed');
    expect(callCounts.lookup).toBe(1);

    // Second leg: resume from the persisted snapshot with a fresh runner
    // that delivers the next turn.
    const snapshot = store.load('run_resume_test');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.step_index).toBeGreaterThanOrEqual(1);

    const second = await resumeAgentLoop(snapshot as AgentLoopSnapshot, {
      tools: [lookup, calc],
      runTurn: scriptedRunner([
        {
          content: 'phase 2',
          tool_calls: [{ id: makeToolCallId(), name: 'calc', arguments: {} }],
        },
        { content: 'done: 42' },
      ]),
      onStepPersist: makePersistHook(store),
    });

    expect(second.haltReason).toBe('no_tool_calls');
    expect(second.run_id).toBe('run_resume_test');
    // The lookup tool must NOT have been re-executed on resume.
    expect(callCounts.lookup).toBe(1);
    expect(callCounts.calc).toBe(1);
    // Steps array contains the persisted step plus the new ones.
    expect(second.steps.length).toBeGreaterThanOrEqual(2);
  });

  it('jsonl store round-trips a snapshot to disk', () => {
    const tmpFile = path.join(os.tmpdir(), `chkpt-${Date.now()}.jsonl`);
    try {
      const store = new JsonlCheckpointStore(tmpFile);
      const snap: AgentLoopSnapshot = {
        run_id: 'run_disk',
        step_index: 1,
        messages: [{ role: 'user', content: 'hi' }],
        steps: [],
        saved_at: new Date().toISOString(),
      };
      store.save(snap);
      const loaded = store.load('run_disk');
      expect(loaded).not.toBeNull();
      expect(loaded!.step_index).toBe(1);
      expect(loaded!.run_id).toBe('run_disk');
      expect(store.list()).toEqual(['run_disk']);
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  it('persists the failure snapshot on turn_failed so resume sees the crash point', async () => {
    const store = new MemoryCheckpointStore();
    const result = await runAgentLoop({
      run_id: 'run_failure',
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [],
      runTurn: async () => {
        throw new Error('boom');
      },
      onStepPersist: makePersistHook(store),
    });
    expect(result.haltReason).toBe('turn_failed');
    const loaded = store.load('run_failure');
    expect(loaded).not.toBeNull();
    expect(loaded!.halt_reason).toBe('turn_failed');
    expect(loaded!.step_index).toBe(0);
  });
});
