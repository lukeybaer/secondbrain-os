// agent-step-loop-idempotency.test.ts
//
// Run 96 enhancement 2: regression test for the idempotency adapter wire.
// Encodes the category, not the literal trigger:
//   - write/destructive tools route through claim/complete; read tools do not
//   - a resumed loop with the same run_id short-circuits write tools the
//     prior leg already completed; the underlying tool runner is not invoked
//   - failed write tools clear the slot so a retry is permitted
// Per feedback_frugal_regression_tests.md.

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
  makeToolCallId,
} from '../agent-step-loop';
import { IdempotencyGuard } from '../idempotency-guard';
import {
  makeIdempotencyAdapter,
  InMemoryIdempotency,
} from '../agent-step-loop-idempotency';
import {
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

describe('agent-step-loop idempotency adapter', () => {
  it('read tools bypass the idempotency hook entirely', async () => {
    const hook = new InMemoryIdempotency();
    let runs = 0;
    const lookup: ToolDef = {
      name: 'lookup',
      description: 'read-only lookup',
      side_effects: 'read',
      run: async () => {
        runs += 1;
        return { result: 'ok', request_heartbeat: true };
      },
    };
    await runAgentLoop({
      run_id: 'run_read',
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [lookup],
      idempotency: hook,
      runTurn: scriptedRunner([
        {
          content: '',
          tool_calls: [{ id: makeToolCallId(), name: 'lookup', arguments: {} }],
        },
        { content: 'done' },
      ]),
    });
    expect(runs).toBe(1);
    expect(hook.completedCount()).toBe(0); // read class never claims
  });

  it('write tool runs once on fresh, short-circuits on duplicate', async () => {
    const hook = new InMemoryIdempotency();
    let sends = 0;
    const send: ToolDef = {
      name: 'send_telegram',
      description: 'send a telegram message',
      side_effects: 'write',
      run: async () => {
        sends += 1;
        return { result: { message_id: sends }, request_heartbeat: true };
      },
    };

    // Leg 1: fresh send goes through.
    await runAgentLoop({
      run_id: 'run_write_dedup',
      initialMessages: [{ role: 'user', content: 'send' }],
      tools: [send],
      idempotency: hook,
      runTurn: scriptedRunner([
        {
          content: '',
          tool_calls: [{ id: makeToolCallId(), name: 'send_telegram', arguments: { body: 'hi' } }],
        },
        { content: 'sent' },
      ]),
    });
    expect(sends).toBe(1);

    // Leg 2: same run_id, same step (because we restart from step 1), same
    // tool, same arguments. The hook must short-circuit; sends stays at 1.
    await runAgentLoop({
      run_id: 'run_write_dedup',
      initialMessages: [{ role: 'user', content: 'send' }],
      tools: [send],
      idempotency: hook,
      runTurn: scriptedRunner([
        {
          content: '',
          tool_calls: [{ id: makeToolCallId(), name: 'send_telegram', arguments: { body: 'hi' } }],
        },
        { content: 'sent' },
      ]),
    });
    expect(sends).toBe(1);
  });

  it('different arguments to the same tool are treated as distinct', async () => {
    const hook = new InMemoryIdempotency();
    let sends = 0;
    const send: ToolDef = {
      name: 'send_telegram',
      description: 'send a telegram message',
      side_effects: 'write',
      run: async () => {
        sends += 1;
        return { result: { ok: true }, request_heartbeat: true };
      },
    };
    await runAgentLoop({
      run_id: 'run_distinct_args',
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [send],
      idempotency: hook,
      runTurn: scriptedRunner([
        {
          content: '',
          tool_calls: [{ id: makeToolCallId(), name: 'send_telegram', arguments: { body: 'a' } }],
        },
        {
          content: '',
          tool_calls: [{ id: makeToolCallId(), name: 'send_telegram', arguments: { body: 'b' } }],
        },
        { content: 'done' },
      ]),
    });
    expect(sends).toBe(2);
  });

  it('checkpoint + resume + idempotency together: write tool not re-executed', async () => {
    const store = new MemoryCheckpointStore();
    const hook = new InMemoryIdempotency();
    let sends = 0;
    const send: ToolDef = {
      name: 'send_telegram',
      description: 'send a telegram message',
      side_effects: 'write',
      run: async () => {
        sends += 1;
        return { result: { ok: true }, request_heartbeat: true };
      },
    };

    // Leg 1 crashes the runner on the second turn so step 1 completes but
    // the loop returns with turn_failed. Snapshot must capture step 1.
    let nextThrows = false;
    const wrappedRunner = async (m: ChatMessage[], t: ToolDef[]): Promise<AssistantTurn> => {
      if (nextThrows) throw new Error('boom');
      nextThrows = true;
      return {
        content: '',
        tool_calls: [{ id: makeToolCallId(), name: 'send_telegram', arguments: { body: 'x' } }],
      };
    };

    const first = await runAgentLoop({
      run_id: 'run_resume_dedup',
      initialMessages: [{ role: 'user', content: 'send' }],
      tools: [send],
      idempotency: hook,
      onStepPersist: makePersistHook(store),
      runTurn: wrappedRunner,
    });
    expect(first.haltReason).toBe('turn_failed');
    expect(sends).toBe(1);

    // Leg 2: resume from the snapshot, replay the same tool call.
    const snapshot = store.load('run_resume_dedup');
    expect(snapshot).not.toBeNull();

    await resumeAgentLoop(snapshot!, {
      tools: [send],
      idempotency: hook,
      runTurn: scriptedRunner([
        // The model decides to issue the same write again. The loop must
        // see the duplicate and short-circuit; sends stays at 1.
        {
          content: '',
          tool_calls: [{ id: makeToolCallId(), name: 'send_telegram', arguments: { body: 'x' } }],
        },
        { content: 'finished' },
      ]),
      onStepPersist: makePersistHook(store),
    });
    expect(sends).toBe(1);
  });

  it('IdempotencyGuard adapter persists slots and dedupes across processes', () => {
    const tmpFile = path.join(os.tmpdir(), `idem-${Date.now()}.jsonl`);
    try {
      const guard = new IdempotencyGuard(tmpFile);
      const adapter = makeIdempotencyAdapter(guard, { scope: 'test', ttlMs: 60_000 });
      const args = {
        run_id: 'r1',
        step: 1,
        tool: 'send_x',
        arguments: { to: '+15550100100', body: 'hi' },
      };
      // First call: fresh.
      const first = adapter.beforeTool(args) as { duplicate: false; exec_id: string };
      expect(first.duplicate).toBe(false);
      adapter.afterTool(
        { run_id: args.run_id, step: args.step, tool: args.tool, exec_id: first.exec_id },
        { ok: true, result: { sent: true } },
      );
      // Second call with identical key: duplicate.
      const second = adapter.beforeTool(args) as { duplicate: true; result: ExampleCo };
      expect(second.duplicate).toBe(true);
      expect((second.result as { sent: boolean }).sent).toBe(true);
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });
});
