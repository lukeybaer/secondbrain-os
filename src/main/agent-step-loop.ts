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
//
// Run 96 nightly enhancement layered three optional hooks onto this loop:
//   - onStepPersist + resumeFrom: durable checkpoint / resume. Pattern source
//     LangGraph v1.2 durable execution + Agno workflow paused_step_index.
//     Lets a crash mid-briefing resume from the last completed step instead
//     of replaying the LLM turns (expensive) and re-firing write tools
//     (destructive).
//   - idempotency: claim-then-execute guard around tools whose descriptor
//     declares side_effects='write'|'destructive'. Pattern source Inferable
//     distributed tool calling + Stripe idempotency-key. Keys are derived
//     deterministically from {run_id, step, tool, args_hash} so a resumed
//     loop short-circuits the prior result instead of re-sending.
//   - traceWriter: per-tool-call OTel-style spans threaded with run_id +
//     step + span_id. Pattern source Agno v2.6.6 trace context preservation
//     + Microsoft Agent Framework middleware. Closes the observability gap
//     where the central loop was the only callsite NOT writing to
//     tool-trace.jsonl.
// All three are optional. Existing callers compile unchanged.

import * as crypto from 'crypto';
import { solveToolRules, type ToolRule } from './tool-rules-solver';
import { SECONDBRAIN_TOOL_RULES } from './tool-rules-presets';
import { recordRulesDecision, type RulesTraceWriter } from './tool-rules-trace';
import { classifyStep, type StepKind } from './agent-step-classifier';
import { applyContextEdit, type ClearToolResultsOptions } from './tool-result-context-editor';
import {
  advance as advanceMagentic,
  type MagenticState,
  type MagenticLimits,
  type StepDecision as MagenticDecision,
} from './magentic-ledger';

const defaultGraphitiAdvisorRuntime = require('../../scripts/lib/graphiti-brain-advisor');

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
  arguments: Record<string, ExampleCo>;
}

export interface ToolResult {
  result: ExampleCo;
  request_heartbeat?: boolean;
  error?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  run: (args: Record<string, ExampleCo>) => Promise<ToolResult> | ToolResult;
  // Side-effect class for idempotency / safety filtering. Defaults to 'read'.
  // Mirrors tool-router.ts ToolDescriptor.side_effects so a single tool
  // record can be passed to both layers. Only 'write' / 'destructive' tools
  // are routed through the optional idempotency hook below.
  side_effects?: 'read' | 'write' | 'destructive';
}

export interface ToolRuleGateOptions {
  rules?: ReadonlyArray<ToolRule>;
  history?: ReadonlyArray<{ tool: string }>;
  approvals?: ReadonlyArray<string>;
  traceWriter?: RulesTraceWriter;
}

export function gateToolDefsByRules(
  tools: ReadonlyArray<ToolDef>,
  options: ToolRuleGateOptions = {},
): ToolDef[] {
  const result = solveToolRules({
    rules: options.rules ?? SECONDBRAIN_TOOL_RULES,
    history: options.history ?? [],
    available: tools.map((tool) => tool.name),
    approvals: options.approvals,
  });
  if (options.traceWriter) recordRulesDecision(result, options.traceWriter);
  const allowed = new Set(result.allowed);
  return tools.filter((tool) => allowed.has(tool.name));
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
    arguments: Record<string, ExampleCo>;
    result: ExampleCo;
    request_heartbeat: boolean;
    error?: string;
    duration_ms: number;
  }>;
  chain_reason: 'heartbeat' | 'tool_error' | 'memory_pressure' | 'none';
  duration_ms: number;
}

export type HaltReason =
  | 'no_heartbeat' // assistant returned final answer with no heartbeat-flagged tool
  | 'max_steps' // reached the safety rail
  | 'no_tool_calls' // assistant returned plain content with no tools requested
  | 'tool_not_found' // model called a tool we don't have registered
  | 'turn_failed' // runTurn rejected
  | 'doom_loop'; // monitor hook detected a stuck pattern before max_steps

export interface AgentLoopResult {
  finalMessage: ChatMessage;
  steps: StepRecord[];
  haltReason: HaltReason;
  haltDetail?: string;
  /**
   * Run id used for checkpointing + idempotency keys. Stable across resumes;
   * a resumed loop reuses the parent run_id so derived keys collide on
   * purpose and short-circuit duplicate write tool calls.
   */
  run_id: string;
  /**
   * Set only when the loop halted on 'doom_loop' AND the caller supplied
   * magenticRecovery state. The Magentic ledger (magentic-ledger.ts) classifies
   * the stall: a 'replan' decision means resets remain so the caller can rewrite
   * its plan and resume; a 'halt' decision means the reset budget is exhausted.
   * This turns a doom-loop halt from a dead-end into a bounded recovery signal.
   */
  recovery?: MagenticDecision;
}

// ── Optional hook contracts (run 96, all optional) ───────────────────────────

/**
 * Snapshot of loop state after a step boundary. Designed for JSONL persistence:
 * append-only, replay-friendly, no binary blobs. Equivalent to LangGraph
 * checkpoint delta but flattened to one record per step boundary.
 */
export interface AgentLoopSnapshot {
  run_id: string;
  step_index: number; // 1-based count of completed steps
  messages: ChatMessage[]; // full conversation up to and including the step
  steps: StepRecord[]; // full StepRecord history for the run
  halt_reason?: HaltReason;
  halt_detail?: string;
  saved_at: string; // ISO 8601
}

/**
 * Persistence callback. Invoked after every step boundary. Best-effort: any
 * exception is swallowed so the loop continues. To resume, load the snapshot
 * back into AgentLoopOptions.resumeFrom and call runAgentLoop again with the
 * same run_id, tools, and runTurn.
 */
export type StepPersistHook = (snapshot: AgentLoopSnapshot) => Promise<void> | void;

/**
 * Idempotency adapter contract. The loop derives a deterministic key per
 * write/destructive tool call and asks the adapter whether the action has
 * already completed. Implementations bridge to idempotency-guard.ts via
 * agent-step-loop-idempotency.ts; tests can substitute an in-memory fake.
 */
export interface IdempotencyHook {
  /**
   * Called before executing a 'write' or 'destructive' tool.
   * Return { duplicate: true, result } to short-circuit and skip execution.
   * Return { duplicate: false, exec_id } to proceed; afterTool will be
   * called with the same exec_id.
   */
  beforeTool(args: {
    run_id: string;
    step: number;
    tool: string;
    arguments: Record<string, ExampleCo>;
  }):
    | Promise<
        | { duplicate: true; result: ExampleCo; exec_id?: string }
        | { duplicate: false; exec_id: string }
      >
    | { duplicate: true; result: ExampleCo; exec_id?: string }
    | { duplicate: false; exec_id: string };
  /** Called after a fresh tool execution succeeds or fails. */
  afterTool(
    args: { run_id: string; step: number; tool: string; exec_id: string },
    outcome: { ok: true; result: ExampleCo } | { ok: false; error: string },
  ): Promise<void> | void;
}

/**
 * OTel-style trace record emitted per tool call from the loop. Shape is a
 * superset of tool-trace.ts ToolTraceRecord (the new fields are optional so
 * existing readers ignore them). span_id correlates tool calls inside the
 * same step; run_id correlates the whole loop; parent_step is the step
 * number the tool was executed within.
 */
export interface LoopTraceRecord {
  timestamp: string;
  tool: string;
  duration_ms: number;
  success: boolean;
  input_size: number;
  output_size: number;
  input_snippet?: string;
  output_snippet?: string;
  error?: string;
  // Run-96 additions:
  span_id: string;
  parent_step: number;
  run_id: string;
  side_effects: 'read' | 'write' | 'destructive';
  // True when the call was short-circuited by the idempotency hook (no
  // actual execution happened). Lets observability distinguish "succeeded
  // because of dedup" from "succeeded because of real execution".
  idempotent_short_circuit?: boolean;
  // Deterministic vs reasoning classification of this step (see
  // agent-step-classifier). Observability only: lets a digest count how many
  // read-only steps could have skipped a model turn. Does not change control
  // flow.
  step_kind?: StepKind;
}

export type LoopTraceWriter = (record: LoopTraceRecord) => void;

/**
 * Doom-loop verdict returned by the optional `monitor` hook. When a monitor
 * returns a verdict the loop halts with haltReason='doom_loop' and the verdict
 * detail is mirrored to haltDetail. Pattern source: OpenHands StuckDetector +
 * Letta v1's "termination is the agent architecture's responsibility" stance +
 * Agno open issue 7133 (default tool_call_limit). max_steps is the unconditional
 * rail; this hook is the smart rail that catches stuck patterns much sooner.
 */
export interface DoomVerdict {
  pattern: string; // short category id, e.g. 'repeated_tool_call'
  detail: string; // human-readable explanation for the briefing
}

/**
 * Called after every step record is pushed. Returns null to continue or a
 * verdict to halt. Pure by contract: the loop swallows exceptions so a buggy
 * monitor never breaks the loop, but it should be deterministic given the
 * same step history.
 */
export type DoomMonitor = (
  steps: ReadonlyArray<StepRecord>,
) => DoomVerdict | null | Promise<DoomVerdict | null>;

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
  /**
   * Optional deterministic context editing (tool-result-context-editor.ts).
   * When set, before each turn the loop evicts the oldest tool-result contents
   * once the transcript crosses the trigger, keeping the most recent results and
   * leaving a placeholder breadcrumb. Message count/pairing is preserved. Opt-in
   * and a no-op below the trigger, so short loops are unaffected.
   */
  contextEdit?: ClearToolResultsOptions;
  // ── Run-96 optional hooks ────────────────────────────────────────────────
  /**
   * Stable identifier for this logical run. Defaults to a fresh random id.
   * Pass the same run_id on resume so checkpoint + idempotency keys collide
   * on purpose. Surfaces as `result.run_id` for the caller to record.
   */
  run_id?: string;
  /** Persistence callback called after each completed step. Best-effort. */
  onStepPersist?: StepPersistHook;
  /** Replay seed. When set, the loop starts from snapshot.step_index + 1. */
  resumeFrom?: AgentLoopSnapshot;
  /** Idempotency adapter for write/destructive tools. */
  idempotency?: IdempotencyHook;
  /** Per-tool-call trace writer. */
  traceWriter?: LoopTraceWriter;
  /**
   * Optional doom-loop monitor. Called after every step. Returning a verdict
   * halts the loop with haltReason='doom_loop'. Wraps `detectDoomLoop` from
   * agent-step-loop-doomloop.ts in the typical caller, but can be any
   * deterministic function over the step history.
   */
  monitor?: DoomMonitor;
  /**
   * Optional bounded-recovery state + limits (magentic-ledger.ts). When set and
   * the doom monitor fires, the loop runs one Magentic `advance` with the doom
   * verdict forcing isInLoop=true and attaches the resulting decision to
   * result.recovery. The caller uses it to decide whether to replan-and-resume
   * (resets remain) or accept the halt (reset budget exhausted). Pure: the loop
   * itself does not replan; it only reports the recommendation.
   */
  magenticRecovery?: { state: MagenticState; limits?: MagenticLimits };
  /**
   * Prompt-time memory advisor. Production defaults to the shared Graphiti
   * runtime; tests may pass false or a fake with the same methods.
   */
  graphitiAdvisor?: false | typeof defaultGraphitiAdvisorRuntime;
}

// ── Loop ──────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_STEPS = 7;

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  // Unit tests are deliberately network-free unless they inject a fake advisor.
  // Production still defaults to the shared runtime.
  const graphitiAdvisor =
    opts.graphitiAdvisor === false ||
    (opts.graphitiAdvisor === undefined && process.env.VITEST === 'true')
      ? null
      : (opts.graphitiAdvisor ?? defaultGraphitiAdvisorRuntime);
  const firstUserPrompt =
    (opts.initialMessages || [])
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .at(-1) || 'Run Amy agent loop';
  // Begin before validation and registry preparation so recall overlaps the
  // ordinary setup work below.
  const graphitiHandle = graphitiAdvisor?.beginGraphitiConsult({
    prompt: firstUserPrompt,
    surface: 'agent-loop',
    conversationId: opts.run_id || '',
    project: 'SecondBrain agent loop',
    visibility: 'owner_private',
  });
  let graphitiEnvelope: any = null;
  const {
    initialMessages,
    tools,
    runTurn,
    maxSteps = DEFAULT_MAX_STEPS,
    chaining = true,
    onStep,
    isMemoryPressured,
    onStepPersist,
    resumeFrom,
    idempotency,
    traceWriter,
    monitor,
    magenticRecovery,
    contextEdit,
  } = opts;

  if (initialMessages.length === 0 && !resumeFrom) {
    throw new Error('runAgentLoop: initialMessages must not be empty');
  }
  const toolsByName = new Map<string, ToolDef>();
  for (const t of tools) {
    if (toolsByName.has(t.name)) {
      throw new Error(`runAgentLoop: duplicate tool name "${t.name}"`);
    }
    toolsByName.set(t.name, t);
  }

  // Resume seed wins over initialMessages on conflict so a crashed loop can
  // continue with the exact conversation it had at the time of the crash.
  const run_id =
    opts.run_id ?? resumeFrom?.run_id ?? 'run_' + crypto.randomBytes(6).toString('hex');
  const messages: ChatMessage[] = resumeFrom ? [...resumeFrom.messages] : [...initialMessages];
  const steps: StepRecord[] = resumeFrom ? [...resumeFrom.steps] : [];
  const startStep = resumeFrom ? resumeFrom.step_index + 1 : 1;

  if (graphitiHandle) {
    graphitiEnvelope = await graphitiHandle.finalize({ waitMs: 30_000 });
    messages.unshift({
      role: 'system',
      content: graphitiAdvisor.buildAdvisorPromptBlock(graphitiEnvelope),
    });
  }

  const finalizeGraphitiAnswer = async (message: ChatMessage): Promise<ChatMessage> => {
    if (!graphitiAdvisor || !graphitiEnvelope || message.role !== 'assistant') return message;
    const answerActionId = `${run_id}-answer`;
    const initialReceipt = graphitiAdvisor.createDispositionReceipt({
      envelope: graphitiEnvelope,
      output: message.content,
      answerActionId,
      visibility: 'owner_private',
    });
    let content = graphitiAdvisor.attachGraphitiImpact(
      message.content,
      graphitiAdvisor.formatGraphitiImpact(graphitiEnvelope, initialReceipt),
    );
    if (!/^\s*(?:#{1,6}\s*)?Codex impact\s*:/im.test(content)) {
      const graphitiAt = content.search(/^\s*(?:#{1,6}\s*)?Graphiti impact\s*:/im);
      const codex = 'Codex impact: none. This action ran through Amy agent loop.';
      content =
        graphitiAt >= 0
          ? `${content.slice(0, graphitiAt).trimEnd()}\n\n${codex}\n\n${content.slice(graphitiAt)}`
          : `${content}\n\n${codex}`;
    }
    const receipt = graphitiAdvisor.createDispositionReceipt({
      envelope: graphitiEnvelope,
      output: content,
      answerActionId,
      visibility: 'owner_private',
    });
    try {
      graphitiAdvisor.recordDispositionReceipt(receipt);
    } catch {
      /* surfaced in health */
    }
    return { ...message, content };
  };

  for (let stepNum = startStep; stepNum <= maxSteps; stepNum++) {
    const stepStart = Date.now();

    // Deterministic context editing before the turn: on a long loop this evicts
    // the oldest bulky tool-result contents (keeping the most recent) so the
    // window does not blow up mid-run. In-place so the array reference the step
    // snapshots capture is preserved; a no-op below the trigger.
    if (contextEdit) {
      applyContextEdit(messages, contextEdit);
    }

    let turn: AssistantTurn;
    try {
      turn = await runTurn(messages, tools);
    } catch (err) {
      const haltDetail = err instanceof Error ? err.message : String(err);
      await safePersist(onStepPersist, {
        run_id,
        step_index: stepNum - 1,
        messages,
        steps,
        halt_reason: 'turn_failed',
        halt_detail: haltDetail,
        saved_at: new Date().toISOString(),
      });
      return {
        finalMessage: await finalizeGraphitiAnswer(messages[messages.length - 1]),
        steps,
        haltReason: 'turn_failed',
        haltDetail,
        run_id,
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
        await safePersist(onStepPersist, {
          run_id,
          step_index: stepNum,
          messages,
          steps,
          halt_reason: 'no_tool_calls',
          saved_at: new Date().toISOString(),
        });
        return {
          finalMessage: await finalizeGraphitiAnswer(assistantMsg),
          steps,
          haltReason: 'no_tool_calls',
          run_id,
        };
      }
      await safePersist(onStepPersist, {
        run_id,
        step_index: stepNum,
        messages,
        steps,
        saved_at: new Date().toISOString(),
      });
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
    let ExampleCoTool: string | null = null;

    for (const call of toolCalls) {
      const tool = toolsByName.get(call.name);
      if (!tool) {
        ExampleCoTool = call.name;
        break;
      }
      const sideEffects = tool.side_effects ?? 'read';
      const isWriteClass = sideEffects === 'write' || sideEffects === 'destructive';
      const args = call.arguments ?? {};
      const callStart = Date.now();
      const span_id = 'sp_' + crypto.randomBytes(6).toString('hex');
      let toolResult: ToolResult;
      let shortCircuit = false;
      let execId: string | null = null;

      if (graphitiAdvisor && isWriteClass) {
        await graphitiAdvisor.consultBeforeAmyAction({
          action: `${call.name} ${safeStringify(args)}`,
          actionType: sideEffects,
          surface: 'agent-loop',
          conversationId: run_id,
          project: 'SecondBrain agent loop',
          answerActionId: `${run_id}-${stepNum}-${call.id}`,
          visibility: 'owner_private',
          ignoredReason:
            'Ignored at the execution boundary because the agent selected these tool arguments after receiving the turn-level advisor context; recall did not change the already-planned call.',
        });
      }

      // Idempotency claim path (write/destructive only).
      if (idempotency && isWriteClass) {
        try {
          const claim = await Promise.resolve(
            idempotency.beforeTool({
              run_id,
              step: stepNum,
              tool: call.name,
              arguments: args,
            }),
          );
          if (claim.duplicate) {
            toolResult = { result: claim.result };
            shortCircuit = true;
          } else {
            execId = claim.exec_id;
            try {
              toolResult = await tool.run(args);
              await Promise.resolve(
                idempotency.afterTool(
                  { run_id, step: stepNum, tool: call.name, exec_id: execId },
                  { ok: true, result: toolResult.result },
                ),
              ).catch(() => {});
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              await Promise.resolve(
                idempotency.afterTool(
                  { run_id, step: stepNum, tool: call.name, exec_id: execId },
                  { ok: false, error: errMsg },
                ),
              ).catch(() => {});
              toolResult = {
                result: null,
                error: errMsg,
                request_heartbeat: true,
              };
            }
          }
        } catch (err) {
          // Adapter itself crashed. Fall back to direct execution so the loop
          // never gets stuck on a broken guard. The trace record still flags
          // the failure path for observability.
          try {
            toolResult = await tool.run(args);
          } catch (innerErr) {
            toolResult = {
              result: null,
              error: innerErr instanceof Error ? innerErr.message : String(innerErr),
              request_heartbeat: true,
            };
          }
        }
      } else {
        try {
          toolResult = await tool.run(args);
        } catch (err) {
          toolResult = {
            result: null,
            error: err instanceof Error ? err.message : String(err),
            request_heartbeat: true,
          };
        }
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
        arguments: args,
        result: toolResult.result,
        request_heartbeat: heartbeat,
        error: toolResult.error,
        duration_ms: dur,
      });

      // Trace span emission (best-effort).
      if (traceWriter) {
        try {
          const inputJson = safeStringify(args);
          const outputJson = safeStringify(toolResult.result);
          traceWriter({
            timestamp: new Date(callStart).toISOString(),
            tool: call.name,
            duration_ms: dur,
            success: !toolResult.error,
            input_size: inputJson.length,
            output_size: outputJson.length,
            input_snippet: snippet(inputJson),
            output_snippet: snippet(outputJson),
            error: toolResult.error,
            span_id,
            parent_step: stepNum,
            run_id,
            side_effects: sideEffects,
            step_kind: classifyStep({
              tool: call.name,
              sideEffects,
              argsResolved: true,
            }).kind,
            ...(shortCircuit ? { idempotent_short_circuit: true } : {}),
          });
        } catch {
          /* trace is best-effort */
        }
      }
    }

    if (ExampleCoTool) {
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
      await safePersist(onStepPersist, {
        run_id,
        step_index: stepNum,
        messages,
        steps,
        halt_reason: 'tool_not_found',
        halt_detail: ExampleCoTool,
        saved_at: new Date().toISOString(),
      });
      return {
        finalMessage: await finalizeGraphitiAnswer(assistantMsg),
        steps,
        haltReason: 'tool_not_found',
        haltDetail: ExampleCoTool,
        run_id,
      };
    }

    const pressured = chaining && (await safeMemoryCheck(isMemoryPressured));
    const shouldChain = chaining && (anyHeartbeat || anyError || pressured);
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

    // Doom-loop monitor: smart rail that fires before max_steps when the
    // history shows a stuck pattern. Best-effort: a buggy monitor never
    // breaks the loop, but a returned verdict halts immediately.
    const verdict = await safeMonitor(monitor, steps);
    if (verdict) {
      await safePersist(onStepPersist, {
        run_id,
        step_index: stepNum,
        messages,
        steps,
        halt_reason: 'doom_loop',
        halt_detail: `${verdict.pattern}: ${verdict.detail}`,
        saved_at: new Date().toISOString(),
      });
      // Bounded recovery: when the caller supplied Magentic state, classify the
      // stall (replan if resets remain, else halt) and report it. The loop does
      // not itself replan; it hands the caller an actionable decision so a
      // doom-loop halt is a recovery signal, not a dead-end.
      let recovery: MagenticDecision | undefined;
      if (magenticRecovery) {
        recovery = advanceMagentic(
          magenticRecovery.state,
          {
            isRequestSatisfied: false,
            isInLoop: true,
            isProgressBeingMade: false,
            nextSpeaker: null,
            instruction: '',
          },
          magenticRecovery.limits,
          verdict,
        ).decision;
      }
      return {
        finalMessage: await finalizeGraphitiAnswer(assistantMsg),
        steps,
        haltReason: 'doom_loop',
        haltDetail: `${verdict.pattern}: ${verdict.detail}`,
        run_id,
        ...(recovery ? { recovery } : {}),
      };
    }

    if (!shouldChain) {
      await safePersist(onStepPersist, {
        run_id,
        step_index: stepNum,
        messages,
        steps,
        halt_reason: 'no_heartbeat',
        saved_at: new Date().toISOString(),
      });
      return {
        finalMessage: await finalizeGraphitiAnswer(assistantMsg),
        steps,
        haltReason: 'no_heartbeat',
        run_id,
      };
    }

    // Step boundary persistence on a chaining step. A resumed loop continues
    // from step_index + 1, so the snapshot captures everything completed.
    await safePersist(onStepPersist, {
      run_id,
      step_index: stepNum,
      messages,
      steps,
      saved_at: new Date().toISOString(),
    });
  }

  const detail = `reached cap of ${maxSteps}`;
  await safePersist(onStepPersist, {
    run_id,
    step_index: maxSteps,
    messages,
    steps,
    halt_reason: 'max_steps',
    halt_detail: detail,
    saved_at: new Date().toISOString(),
  });
  return {
    finalMessage: await finalizeGraphitiAnswer(messages[messages.length - 1]),
    steps,
    haltReason: 'max_steps',
    haltDetail: detail,
    run_id,
  };
}

async function safeMemoryCheck(probe: AgentLoopOptions['isMemoryPressured']): Promise<boolean> {
  if (!probe) return false;
  try {
    return Boolean(await probe());
  } catch {
    return false;
  }
}

async function safeMonitor(
  monitor: DoomMonitor | undefined,
  steps: ReadonlyArray<StepRecord>,
): Promise<DoomVerdict | null> {
  if (!monitor) return null;
  try {
    return (await Promise.resolve(monitor(steps))) ?? null;
  } catch {
    return null;
  }
}

async function safePersist(
  hook: StepPersistHook | undefined,
  snapshot: AgentLoopSnapshot,
): Promise<void> {
  if (!hook) return;
  try {
    await Promise.resolve(hook(snapshot));
  } catch {
    /* persistence is best-effort; never break the loop */
  }
}

const SNIPPET_LIMIT = 200;

function safeStringify(value: ExampleCo): string {
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function snippet(s: string): string | undefined {
  if (!s) return undefined;
  return s.length > SNIPPET_LIMIT ? s.slice(0, SNIPPET_LIMIT) + '...' : s;
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
  run: (args: Record<string, ExampleCo>) => Promise<ExampleCo> | ExampleCo,
): ToolDef {
  return {
    name,
    description,
    run: async (args) => ({ result: await run(args), request_heartbeat: true }),
  };
}

/**
 * Resume a previously checkpointed loop. Reads the snapshot, restores
 * messages + steps + run_id, and continues execution from the step after
 * the one persisted. Equivalent to calling runAgentLoop with resumeFrom
 * set, but reads nicer at callsites.
 *
 * Returns the same AgentLoopResult shape as runAgentLoop. The steps array
 * in the result includes BOTH the persisted history and any new steps run
 * after resumption, so the caller has a complete picture.
 */
export async function resumeAgentLoop(
  snapshot: AgentLoopSnapshot,
  opts: Omit<AgentLoopOptions, 'initialMessages' | 'resumeFrom' | 'run_id'>,
): Promise<AgentLoopResult> {
  return runAgentLoop({
    ...opts,
    run_id: snapshot.run_id,
    resumeFrom: snapshot,
    initialMessages: snapshot.messages,
  });
}
