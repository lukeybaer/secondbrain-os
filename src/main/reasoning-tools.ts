// reasoning-tools.ts
//
// Agno-style reasoning-as-tool primitives. Agno's ReasoningTools exposes
// `think()` and `analyze()` as first-class tools the model decides to call,
// rather than baking a "chain of thought" loop into the framework. The win:
// reasoning is now an explicit, auditable, structured tool call instead of
// freeform text inside the assistant turn. Three concrete benefits:
//   1. Decision audits show *what* Amy was thinking before acting.
//   2. Reasoning steps are countable, so analysis-paralysis can be bounded
//      (see reasoning-step-budget.ts).
//   3. The same tool surface works in any client (Claude, Codex, briefing
//      subagents) because it's just an Anthropic tool definition.
//
// This module intentionally does NOT route into agent-decision-log.ts, which
// is shaped for control-flow routing (heal/skip/escalate). Reasoning is a
// different kind of record, freeform thought plus tentative plan or
// observation plus conclusion, and deserves its own append-only ledger.
//
// Output: data/agent/reasoning-trace.jsonl

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Types

export type ReasoningKind = 'think' | 'analyze';

export interface ReasoningRecord {
  reasoning_id: string;
  timestamp: string;
  kind: ReasoningKind;
  // For think(): caller-supplied free-form thought
  // For analyze(): caller-supplied observation
  body: string;
  // For think(): the plan or next action the model committed to
  // For analyze(): the conclusion drawn from the observation
  conclusion?: string;
  // Optional session/turn correlation id so a step-budget can count "thinks
  // in this turn" without scanning the whole ledger.
  turn_id?: string;
  // Optional caller tag (e.g. "briefing", "outbound-call", "dispatch") so the
  // briefing can attribute reasoning to its source surface.
  source?: string;
}

// Tool definitions (Anthropic format, mirrors memory-tool-use.ts shape)

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, ExampleCo>;
    required: string[];
  };
}

export const REASONING_TOOLS: AnthropicToolDefinition[] = [
  {
    name: 'think',
    description:
      "Record a brief reasoning step and the action you plan to take next. Use this BEFORE any irreversible action (sending a message, making a call, writing memory, committing code) so the audit trail captures why. The output is a confirmation that the thought was logged; nothing in the world changes.",
    input_schema: {
      type: 'object',
      properties: {
        thought: {
          type: 'string',
          description: 'Short free-form reasoning. One or two sentences is ideal.',
        },
        plan: {
          type: 'string',
          description: 'The concrete next action you commit to after this thought.',
        },
      },
      required: ['thought', 'plan'],
    },
  },
  {
    name: 'analyze',
    description:
      "Record an observation about a recent tool result, error, or external fact, and the conclusion you draw from it. Use this AFTER a tool call returns surprising or important data, before you decide what to do with it. The output is a confirmation; nothing in the world changes.",
    input_schema: {
      type: 'object',
      properties: {
        observation: {
          type: 'string',
          description: 'What you saw (one or two sentences, concrete and factual).',
        },
        conclusion: {
          type: 'string',
          description: 'What you take from it. The decision this observation drives.',
        },
      },
      required: ['observation', 'conclusion'],
    },
  },
];

// Executor

export interface ReasoningToolResult {
  success: boolean;
  output: string;
  record?: ReasoningRecord;
}

export interface ReasoningContext {
  logPath: string;     // absolute path to reasoning-trace.jsonl
  turn_id?: string;    // optional correlation id supplied by caller
  source?: string;     // optional caller tag (briefing, call, dispatch, etc.)
}

export function executeReasoningTool(
  name: string,
  input: Record<string, ExampleCo>,
  ctx: ReasoningContext,
): ReasoningToolResult {
  try {
    if (name === 'think') {
      const thought = String(input.thought ?? '').trim();
      const plan = String(input.plan ?? '').trim();
      if (!thought) return { success: false, output: 'thought is required' };
      if (!plan) return { success: false, output: 'plan is required' };

      const record = appendReasoning(ctx.logPath, {
        kind: 'think',
        body: thought,
        conclusion: plan,
        turn_id: ctx.turn_id,
        source: ctx.source,
      });
      return {
        success: true,
        output: `Thought recorded (id ${record.reasoning_id}). Now execute: ${plan}`,
        record,
      };
    }

    if (name === 'analyze') {
      const observation = String(input.observation ?? '').trim();
      const conclusion = String(input.conclusion ?? '').trim();
      if (!observation) return { success: false, output: 'observation is required' };
      if (!conclusion) return { success: false, output: 'conclusion is required' };

      const record = appendReasoning(ctx.logPath, {
        kind: 'analyze',
        body: observation,
        conclusion,
        turn_id: ctx.turn_id,
        source: ctx.source,
      });
      return {
        success: true,
        output: `Analysis recorded (id ${record.reasoning_id}). Conclusion: ${conclusion}`,
        record,
      };
    }

    return { success: false, output: `PRIVATE_NAME reasoning tool: ${name}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Reasoning tool error: ${msg}` };
  }
}

// Ledger helpers (pure, no electron coupling)

export function appendReasoning(
  logPath: string,
  partial: Omit<ReasoningRecord, 'reasoning_id' | 'timestamp'>,
): ReasoningRecord {
  const record: ReasoningRecord = {
    reasoning_id: crypto.randomBytes(6).toString('hex'),
    timestamp: new Date().toISOString(),
    ...partial,
  };
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // Reasoning trace failures must never break the caller.
  }
  return record;
}

export function readReasoning(logPath: string, limit = 200): ReasoningRecord[] {
  if (!fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim());
  const out: ReasoningRecord[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line) as ReasoningRecord);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

// Helper: check if a tool block is a reasoning tool

export function isReasoningTool(name: string): boolean {
  return REASONING_TOOLS.some((t) => t.name === name);
}
