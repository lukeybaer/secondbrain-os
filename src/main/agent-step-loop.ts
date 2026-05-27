// agent-step-loop.ts
//
// Letta-style multi-step agent loop with request_heartbeat semantics.
//
// Pattern source: letta/letta Agent.step() / inner_step() loop. Each tool call
// can request a heartbeat to chain another reasoning step before control
// returns to the caller. Memory pressure or function failure can also force a
// chain. The loop is bounded by max_steps and a no_heartbeat halt condition.
//
// Why SecondBrain needs this:
//   - calls.ts and live-call-control.ts invoke Claude in single-shot mode
//   - knowledge-worker.ts runs single-pass research
//   - There is no place a tool result can say "I need to think again before
//     answering" without the caller hand-rolling a state machine
//
// This module is LLM-agnostic: callers inject `runTurn` so the loop can be
// driven by claude-runner.ts, the Anthropic SDK, or a fake in tests. Each
// step is recorded so the briefing can surface "Amy chained N steps when
// drafting the dentist call script."

import * as crypto from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  result: unknown;
  request_heartbeat?: boolean;
  error?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  run: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
}

export interface AssistantTurn {
  content: string;
  tool_calls?: ToolCall[];
}

export interface StepRecord {
  step: number;
  timestamp: string;
  assistant_content: string;
  tool_calls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    result: unknown;
    request_heartbeat: boolean;
    error?: string;
    duration_ms: number;
  }>;
  chain_reason: 'heartbeat' | 'tool_error' | 'memory_pressure' | 'none';
  duration_ms: number;
}

export type HaltReason =
  | 'no_heartbeat'      // assistant returned final answer with no heartbeat-flagged tool
  | 'max_steps'         // reached the safety rail
  | 'no_tool_calls'     // assistant returned plain content with no tools requested
  | 'tool_not_found'    // model called a tool we don't have registered
  | 'turn_failed';      // runTurn rejected

export interface AgentLoopResult {
  finalMessage: ChatMessage;
  steps: StepRecord[];
  haltReason: HaltReason;
  haltDetail?: string;
}

export interface AgentLoopOptions {
  /** Conversation seed. Must include at least one user message. */
  initialMessages: ChatMessage[];
  /** Tool registry. Tool names must be unique. */
  tools: ToolDef[];
  /** Driver: takes the conversation + tool definitions, returns one assistant turn. */
  runTurn: (messages: ChatMessage[], tools: ToolDef[]) => Promise<AssistantTurn>;
  /** Hard cap on chained steps. Letta default is 7. */
  maxSteps?: number;
  /** If false the loop runs exactly one step regardless of heartbeat. */
  chaining?: boolean;
  /** Called after every step. Use to log into agent-decision-log.ts. */
  onStep?: (s: StepRecord) => void;
  /** Optional probe that returns true if memory is under pressure. Forces a chain. */
  isMemoryPressured?: () => boolean | Promise<boolean>;
}

// ── Loop ──────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_STEPS = 7;

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    initialMessages,
    tools,
    runTurn,
    maxSteps = DEFAULT_MAX_STEPS,
    chaining = true,
    onStep,
    isMemoryPressured,
  } = opts;

  if (initialMessages.length === 0) {
    throw new Error('runAgentLoop: initialMessages must not be empty');
  }
  const toolsByName = new Map<string, ToolDef>();
  for (const t of tools) {
    if (toolsByName.has(t.name)) {
      throw new Error(`runAgentLoop: duplicate tool name "${t.name}"`);
    }
    toolsByName.set(t.name, t);
  }

  const messages: ChatMessage[] = [...initialMessages];
  const steps: StepRecord[] = [];

  for (let stepNum = 1; stepNum <= maxSteps; stepNum++) {
    const stepStart = Date.now();
    let turn: AssistantTurn;
    try {
      turn = await runTurn(messages, tools);
    } catch (err) {
      return {
        finalMessage: messages[messages.length - 1],
        steps,
        haltReason: 'turn_failed',
        haltDetail: err instanceof Error ? err.message : String(err),
      };
    }

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: turn.content ?? '',
      tool_calls: turn.tool_calls,
    };
    messages.push(assistantMsg);

    const toolCalls = turn.tool_calls ?? [];

    // Plain answer — done unless memory pressure forces a chain.
    if (toolCalls.length === 0) {
      const pressured = chaining && (await safeMemoryCheck(isMemoryPressured));
      const record: StepRecord = {
        step: stepNum,
        timestamp: new Date().toISOString(),
        assistant_content: assistantMsg.content,
        tool_calls: [],
        chain_reason: pressured ? 'memory_pressure' : 'none',
        duration_ms: Date.now() - stepStart,
      };
      steps.push(record);
      onStep?.(record);

      if (!pressured) {
        return {
          finalMessage: assistantMsg,
          steps,
          haltReason: 'no_tool_calls',
        };
      }
      // Memory-pressure chain: synthesize a system nudge and continue.
      messages.push({
        role: 'user',
        content: '[system] Memory pressure detected. Reflect on what to evict before answering.',
      });
      continue;
    }

    // Execute tools.
    const toolRecords: StepRecord['tool_calls'] = [];
    let anyHeartbeat = false;
    let anyError = false;
    let unknownTool: string | null = null;

    for (const call of toolCalls) {
      const tool = toolsByName.get(call.name);
      if (!tool) {
        unknownTool = call.name;
        break;
      }
      const callStart = Date.now();
      let toolResult: ToolResult;
      try {
        toolResult = await tool.run(call.arguments ?? {});
      } catch (err) {
        toolResult = {
          result: null,
          error: err instanceof Error ? err.message : String(err),
          request_heartbeat: true, // errors force a chain so the model can recover
        };
      }
      const dur = Date.now() - callStart;
      const heartbeat = toolResult.request_heartbeat === true;
      if (heartbeat) anyHeartbeat = true;
      if (toolResult.error) anyError = true;

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify({
          result: toolResult.result,
          ...(toolResult.error ? { error: toolResult.error } : {}),
        }),
      });
      toolRecords.push({
        id: call.id,
        name: call.name,
        arguments: call.arguments ?? {},
        result: toolResult.result,
        request_heartbeat: heartbeat,
        error: toolResult.error,
        duration_ms: dur,
      });
    }

    if (unknownTool) {
      const record: StepRecord = {
        step: stepNum,
        timestamp: new Date().toISOString(),
        assistant_content: assistantMsg.content,
        tool_calls: toolRecords,
        chain_reason: 'none',
        duration_ms: Date.now() - stepStart,
      };
      steps.push(record);
      onStep?.(record);
      return {
        finalMessage: assistantMsg,
        steps,
        haltReason: 'tool_not_found',
        haltDetail: unknownTool,
      };
    }

    const pressured = chaining && (await safeMemoryCheck(isMemoryPressured));
    const shouldChain =
      chaining && (anyHeartbeat || anyError || pressured);
    // Precedence: tool_error > heartbeat > memory_pressure. Errors come first so
    // the briefing log distinguishes "had to recover" from "model wanted more thought."
    const chainReason: StepRecord['chain_reason'] = anyError
      ? 'tool_error'
      : anyHeartbeat
      ? 'heartbeat'
      : pressured
      ? 'memory_pressure'
      : 'none';

    const record: StepRecord = {
      step: stepNum,
      timestamp: new Date().toISOString(),
      assistant_content: assistantMsg.content,
      tool_calls: toolRecords,
      chain_reason: chainReason,
      duration_ms: Date.now() - stepStart,
    };
    steps.push(record);
    onStep?.(record);

    if (!shouldChain) {
      return {
        finalMessage: assistantMsg,
        steps,
        haltReason: 'no_heartbeat',
      };
    }
  }

  return {
    finalMessage: messages[messages.length - 1],
    steps,
    haltReason: 'max_steps',
    haltDetail: `reached cap of ${maxSteps}`,
  };
}

async function safeMemoryCheck(
  probe: AgentLoopOptions['isMemoryPressured'],
): Promise<boolean> {
  if (!probe) return false;
  try {
    return Boolean(await probe());
  } catch {
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate a tool-call id with the same shape as Anthropic / OpenAI. */
export function makeToolCallId(): string {
  return 'tc_' + crypto.randomBytes(8).toString('hex');
}

/** Convenience: build a tool def whose runner always asks for a heartbeat. */
export function chainingTool(
  name: string,
  description: string,
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown,
): ToolDef {
  return {
    name,
    description,
    run: async (args) => ({ result: await run(args), request_heartbeat: true }),
  };
}
