// agent-step-loop-ExampleCong.test.ts
//
// Run 96 enhancement 3: regression test for the OTel-style trace wire.
// Encodes the category (every tool call emits one span with run_id +
// parent_step + side_effects + span_id; short-circuited duplicates are
// flagged; the summarizer aggregates correctly), not the literal
// trigger. Per feedback_frugal_regression_tests.md.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runAgentLoop,
  ToolDef,
  AssistantTurn,
  ChatMessage,
  makeToolCallId,
} from '../agent-step-loop';
import { InMemoryIdempotency } from '../agent-step-loop-idempotency';
import {
  MemoryTraceWriter,
  makeFileTraceWriter,
  readTraceFile,
  summarizeByRun,
  readRunSummaries,
} from '../agent-step-loop-ExampleCong';
import type { LoopTraceRecord } from '../agent-step-loop-ExampleCong';

function scriptedRunner(turns: AssistantTurn[]) {
  let i = 0;
  return async (_messages: ChatMessage[], _tools: ToolDef[]): Promise<AssistantTurn> => {
    if (i >= turns.length) {
      throw new Error(`scripted runner exhausted after ${turns.length} turns`);
    }
    return turns[i++];
  };
}

describe('agent-step-loop ExampleCong wire', () => {
  it('emits one trace record per tool call with run_id + parent_step + span_id', async () => {
    const writer = new MemoryTraceWriter();
    const lookup: ToolDef = {
      name: 'lookup',
      description: 'read tool',
      side_effects: 'read',
      run: async () => ({ result: 'ok', request_heartbeat: true }),
    };
    await runAgentLoop({
      run_id: 'run_trace',
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [lookup],
      traceWriter: writer.write,
      runTurn: scriptedRunner([
        {
          content: '',
          tool_calls: [{ id: makeToolCallId(), name: 'lookup', arguments: { name: 'ExampleCo' } }],
        },
        {
          content: '',
          tool_calls: [{ id: makeToolCallId(), name: 'lookup', arguments: { name: 'PRIVATE_NAME' } }],
        },
        { content: 'done' },
      ]),
    });

    expect(writer.records).toHaveLength(2);
    for (const r of writer.records) {
      expect(r.run_id).toBe('run_trace');
      expect(r.tool).toBe('lookup');
      expect(r.side_effects).toBe('read');
      expect(r.span_id).toMatch(/^sp_/);
      expect(r.success).toBe(true);
      // Run-128: a read-only tool with resolved args classifies deterministic.
      expect(r.step_kind).toBe('deterministic');
    }
    expect(writer.records[0].parent_step).toBe(1);
    expect(writer.records[1].parent_step).toBe(2);
    // span_ids are unique per call.
    expect(writer.records[0].span_id).not.toBe(writer.records[1].span_id);
  });

  it('flags idempotent_short_circuit when a write tool is deduped', async () => {
    const writer = new MemoryTraceWriter();
    const hook = new InMemoryIdempotency();
    const send: ToolDef = {
      name: 'send_telegram',
      description: 'send a message',
      side_effects: 'write',
      run: async () => ({ result: { ok: true }, request_heartbeat: true }),
    };
    await runAgentLoop({
      run_id: 'run_short_circuit',
      initialMessages: [{ role: 'user', content: 'send' }],
      tools: [send],
      idempotency: hook,
      traceWriter: writer.write,
      runTurn: scriptedRunner([
        {
          content: '',
          tool_calls: [{ id: makeToolCallId(), name: 'send_telegram', arguments: { body: 'hi' } }],
        },
        // Same args again. Idempotency must short-circuit, trace must flag.
        {
          content: '',
          tool_calls: [{ id: makeToolCallId(), name: 'send_telegram', arguments: { body: 'hi' } }],
        },
        { content: 'done' },
      ]),
    });
    expect(writer.records).toHaveLength(2);
    expect(writer.records[0].idempotent_short_circuit).toBeUndefined();
    expect(writer.records[1].idempotent_short_circuit).toBe(true);
    expect(writer.records[1].side_effects).toBe('write');
    // Run-128: a write tool always classifies reasoning (needs judgment).
    expect(writer.records[0].step_kind).toBe('reasoning');
  });

  it('records failure when a tool throws', async () => {
    const writer = new MemoryTraceWriter();
    const broken: ToolDef = {
      name: 'broken',
      description: 'always fails',
      run: async () => {
        throw new Error('oops');
      },
    };
    await runAgentLoop({
      run_id: 'run_failure',
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [broken],
      traceWriter: writer.write,
      maxSteps: 1,
      runTurn: scriptedRunner([
        {
          content: '',
          tool_calls: [{ id: makeToolCallId(), name: 'broken', arguments: {} }],
        },
      ]),
    });
    expect(writer.records).toHaveLength(1);
    expect(writer.records[0].success).toBe(false);
    expect(writer.records[0].error).toBe('oops');
  });

  it('summarizeByRun aggregates correctly across runs and side effects', async () => {
    const writer = new MemoryTraceWriter();
    const hook = new InMemoryIdempotency();
    const lookup: ToolDef = {
      name: 'lookup',
      description: 'read',
      side_effects: 'read',
      run: async () => ({ result: 'ok', request_heartbeat: true }),
    };
    const send: ToolDef = {
      name: 'send',
      description: 'write',
      side_effects: 'write',
      run: async () => ({ result: { ok: true }, request_heartbeat: true }),
    };
    await runAgentLoop({
      run_id: 'run_summary',
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [lookup, send],
      idempotency: hook,
      traceWriter: writer.write,
      runTurn: scriptedRunner([
        {
          content: '',
          tool_calls: [{ id: makeToolCallId(), name: 'lookup', arguments: {} }],
        },
        {
          content: '',
          tool_calls: [{ id: makeToolCallId(), name: 'send', arguments: { b: 1 } }],
        },
        {
          content: '',
          tool_calls: [{ id: makeToolCallId(), name: 'send', arguments: { b: 1 } }],
        },
        { content: 'done' },
      ]),
    });
    const summaries = summarizeByRun(writer.records);
    expect(summaries).toHaveLength(1);
    const s = summaries[0];
    expect(s.run_id).toBe('run_summary');
    expect(s.total_calls).toBe(3);
    expect(s.distinct_tools).toBe(2);
    expect(s.failures).toBe(0);
    expect(s.by_side_effect.read).toBe(1);
    expect(s.by_side_effect.write).toBe(2);
    expect(s.idempotent_short_circuits).toBe(1);
  });

  it('summarizeByRun ignores base (run-less) records that share the trace sink', () => {
    // The live tool-trace.jsonl is written by BOTH tool-trace.ts (base records,
    // no run_id / side_effects) and the loop (LoopTraceRecords). Summarizing by
    // run must skip the base records, not fold them into a phantom `undefined`
    // run with a junk side-effect bucket. Encodes the category: mixed-shape sink.
    const mixed: LoopTraceRecord[] = [
      // Two real run-scoped records.
      {
        timestamp: '2026-06-21T00:00:00Z',
        tool: 'lookup',
        duration_ms: 10,
        success: true,
        input_size: 0,
        output_size: 0,
        span_id: 'sp_1',
        parent_step: 1,
        run_id: 'run_real',
        side_effects: 'read',
      },
      {
        timestamp: '2026-06-21T00:00:01Z',
        tool: 'send',
        duration_ms: 20,
        success: false,
        input_size: 0,
        output_size: 0,
        span_id: 'sp_2',
        parent_step: 2,
        run_id: 'run_real',
        side_effects: 'write',
      },
      // A base record sharing the file: no run_id, no side_effects. Cast through
      // ExampleCo because that is exactly the malformed shape the live file holds.
      {
        timestamp: '2026-06-21T00:00:02Z',
        tool: 'ipc:something',
        duration_ms: 5,
        success: true,
        input_size: 0,
        output_size: 0,
      } as ExampleCo as LoopTraceRecord,
    ];

    const summaries = summarizeByRun(mixed);
    // Only the real run survives; the run-less base record is dropped.
    expect(summaries).toHaveLength(1);
    const s = summaries[0];
    expect(s.run_id).toBe('run_real');
    expect(s.total_calls).toBe(2);
    expect(s.failures).toBe(1);
    expect(s.distinct_tools).toBe(2);
    // No junk bucket: only the three known classes exist and they sum to the
    // run's real calls (base record's missing side_effects never counted).
    expect(Object.keys(s.by_side_effect).sort()).toEqual(['destructive', 'read', 'write']);
    const sideTotal = s.by_side_effect.read + s.by_side_effect.write + s.by_side_effect.destructive;
    expect(sideTotal).toBe(2);
    expect(Number.isFinite(s.duration_ms_total)).toBe(true);
    expect(s.duration_ms_total).toBe(30);
  });

  it('readRunSummaries rolls a live-shaped JSONL (mixed records) without phantoms', () => {
    const tmpFile = path.join(os.tmpdir(), `trace-mixed-${Date.now()}.jsonl`);
    try {
      const lines = [
        // base record (tool-trace.ts shape) - must be ignored by run rollup
        JSON.stringify({ timestamp: 't', tool: 'ipc:x', duration_ms: 1, success: true }),
        // loop record - counted
        JSON.stringify({
          timestamp: 't',
          tool: 'lookup',
          duration_ms: 2,
          success: true,
          input_size: 0,
          output_size: 0,
          span_id: 'sp_a',
          parent_step: 1,
          run_id: 'run_x',
          side_effects: 'read',
        }),
        '{ this is not json',
      ];
      fs.writeFileSync(tmpFile, lines.join('\n') + '\n');
      const summaries = readRunSummaries(tmpFile);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].run_id).toBe('run_x');
      expect(summaries[0].total_calls).toBe(1);
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  it('file writer round-trips through readTraceFile', () => {
    const tmpFile = path.join(os.tmpdir(), `trace-${Date.now()}.jsonl`);
    try {
      const write = makeFileTraceWriter(tmpFile);
      write({
        timestamp: new Date().toISOString(),
        tool: 't',
        duration_ms: 1,
        success: true,
        input_size: 0,
        output_size: 0,
        span_id: 'sp_aaaa',
        parent_step: 1,
        run_id: 'r1',
        side_effects: 'read',
      });
      const read = readTraceFile(tmpFile);
      expect(read).toHaveLength(1);
      expect(read[0].span_id).toBe('sp_aaaa');
      expect(read[0].run_id).toBe('r1');
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });
});
