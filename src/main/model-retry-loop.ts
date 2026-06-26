// model-retry-loop.ts
//
// Run 111 of the nightly enhancement cycle (2026-06-03).
//
// Bounded "validate -> correct -> retry" driver for tool/model calls. This is
// the orchestration half that preflight-validator.ts deliberately left out:
// preflight-validator turns a malformed call into a structured Violation[],
// but nothing here consumed that list to drive a *bounded* self-correction
// loop. So a confused model that keeps emitting bad args either crashed hard
// or, worse, was retried with no cap and burned unbounded tokens.
//
// This module closes that gap. It runs a caller-supplied validate() (normally
// preflight-validator.validate against a Schema), and on failure builds a
// structured correction prompt from the exact violations, hands it to a
// caller-supplied regenerate() (the model call), and re-validates -- up to a
// per-tool cap AND an aggregate cap. A type-valid-but-semantically-wrong
// result can raise ModelRetry from execute() to request one more targeted
// correction without failing the whole run. Once a cap is hit it fails LOUD
// (RetryExhaustedError), never silently returns a bad call.
//
// Patterns synthesized from:
//   - pydantic-ai ModelRetry + retries (ai.pydantic.dev/api/retries 2026-05):
//     schema validation failure auto-generates a RetryPromptPart with the
//     exact error fed back to the model; tool code can raise ModelRetry for
//     semantic failures; retry caps are per-tool / per-toolset / agent-wide.
//   - BAML schema-aligned parsing: feed back the specific field that failed,
//     not a generic "invalid JSON".
//   - OpenAI/Anthropic tool-use guidance: bound the correction loop so a
//     looping model cannot run away with the token budget.
//
// Why SecondBrain needs this:
//   - Dispatch payloads (data/agent/dispatch-queue.jsonl) are model-authored;
//     a malformed one currently fails at the executor boundary with a generic
//     error and no structured second chance.
//   - Outbound tool args (Vapi initiateCall, Gmail send, Telegram) already
//     have schemas in preflight-validator but no driver that lets the model
//     fix its own mistake within a hard cap.
//   - The attempt records this emits feed retry-pressure-report.ts so the
//     briefing can surface which tools' schemas keep confusing the model.
//
// Zero deps. Pure core (clock injected); the async driver is the only side.

import type { Violation, ValidationResult } from './preflight-validator';

// ----------------------------------------------------------------------------
// Signals
// ----------------------------------------------------------------------------

/**
 * Raise from execute() when args passed validation but are semantically wrong
 * (e.g. the model picked a real-but-nonexistent contact, or a date in the
 * past). ExampleCos a reason the model reads on its next attempt. Mirrors
 * pydantic-ai's ModelRetry.
 */
export class ModelRetry extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'ModelRetry';
  }
}

/**
 * Thrown when the per-tool or aggregate retry cap is reached without a valid,
 * successful call. Fail-loud terminal state -- callers MUST handle it; the bad
 * call never executes.
 */
export class RetryExhaustedError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly attempts: number,
    public readonly lastViolations: Violation[],
    public readonly reason: 'validation' | 'semantic' | 'budget',
  ) {
    const head = lastViolations
      .slice(0, 3)
      .map((v) => `${v.path || '<root>'}: ${v.message}`)
      .join('; ');
    super(
      `model-retry exhausted for ${toolName} after ${attempts} attempt(s) [${reason}]` +
        (head ? `: ${head}` : ''),
    );
    this.name = 'RetryExhaustedError';
  }
}

// ----------------------------------------------------------------------------
// Retry budget (per-tool + aggregate caps)
// ----------------------------------------------------------------------------

export interface RetryBudgetPolicy {
  /** Max correction retries for any single tool call. Default 2. */
  perToolMax: number;
  /** Max correction retries summed across all tools in this budget. Default 8. */
  aggregateMax: number;
}

export const DEFAULT_RETRY_POLICY: RetryBudgetPolicy = {
  perToolMax: 2,
  aggregateMax: 8,
};

/**
 * Mutable retry accountant shared across calls in one agent turn. Counts only
 * *correction* retries (the initial attempt is free). Pure logic; no I/O.
 */
export class RetryBudget {
  private perTool = new Map<string, number>();
  private total = 0;

  constructor(private readonly policy: RetryBudgetPolicy = DEFAULT_RETRY_POLICY) {}

  /** True if `toolName` may take another correction retry under both caps. */
  canRetry(toolName: string): boolean {
    const used = this.perTool.get(toolName) ?? 0;
    return used < this.policy.perToolMax && this.total < this.policy.aggregateMax;
  }

  /** Record one consumed correction retry for `toolName`. */
  consume(toolName: string): void {
    this.perTool.set(toolName, (this.perTool.get(toolName) ?? 0) + 1);
    this.total += 1;
  }

  used(toolName: string): number {
    return this.perTool.get(toolName) ?? 0;
  }

  totalUsed(): number {
    return this.total;
  }

  getPolicy(): RetryBudgetPolicy {
    return this.policy;
  }
}

// ----------------------------------------------------------------------------
// Correction prompt (pure)
// ----------------------------------------------------------------------------

/**
 * Build the structured correction prompt fed back to the model. Lists each
 * violation as `path | rule | message` so the model can target the exact
 * field, and states the remaining attempt budget so it does not stall.
 */
export function buildCorrectionPrompt(
  toolName: string,
  violations: Violation[],
  attempt: number,
  perToolMax: number,
): string {
  const remaining = Math.max(0, perToolMax - attempt);
  const lines = violations.map((v) => {
    const got = v.got === undefined ? '' : ` (got: ${JSON.stringify(v.got)})`;
    return `  - ${v.path || '<root>'} [${v.rule}]: ${v.message}${got}`;
  });
  return (
    `Your call to "${toolName}" was rejected by validation. ` +
    `Fix these field(s) and return corrected arguments only:\n` +
    lines.join('\n') +
    `\nAttempt ${attempt} of ${perToolMax}. ${remaining} correction(s) left, then the call is abandoned.`
  );
}

/**
 * Build the correction prompt for a semantic ModelRetry (args were type-valid
 * but execute() rejected them with a reason).
 */
export function buildSemanticCorrectionPrompt(
  toolName: string,
  reason: string,
  attempt: number,
  perToolMax: number,
): string {
  const remaining = Math.max(0, perToolMax - attempt);
  return (
    `Your call to "${toolName}" was syntactically valid but rejected: ${reason}. ` +
    `Return corrected arguments. Attempt ${attempt} of ${perToolMax}, ${remaining} left.`
  );
}

// ----------------------------------------------------------------------------
// Attempt record (consumed by retry-pressure-report.ts)
// ----------------------------------------------------------------------------

export type AttemptTerminal = 'ok' | 'exhausted_validation' | 'exhausted_semantic' | 'exhausted_budget';

export interface RetryAttemptRecord {
  timestamp: string;
  toolName: string;
  /** Number of attempts made (1 = succeeded first try, no corrections). */
  attempts: number;
  /** Correction retries actually consumed (attempts - 1). */
  corrections: number;
  terminal: AttemptTerminal;
  /** Rules that fired across the whole loop, e.g. ['required','pattern']. */
  violationRules: string[];
}

export type AttemptWriter = (record: RetryAttemptRecord) => void;

// ----------------------------------------------------------------------------
// Driver
// ----------------------------------------------------------------------------

export interface ModelRetryOptions<TArgs, TResult> {
  toolName: string;
  initialArgs: TArgs;
  /** Validate args (typically preflight-validator.validate(args, schema)). */
  validate: (args: TArgs) => ValidationResult;
  /**
   * Produce corrected args given the structured correction prompt and the
   * previous (rejected) args. This is the model call. Only invoked on failure.
   */
  regenerate: (correctionPrompt: string, prevArgs: TArgs, attempt: number) => Promise<TArgs>;
  /**
   * Execute the validated call. May raise ModelRetry to request a semantic
   * correction; any other throw propagates unchanged (not a retry signal).
   */
  execute: (args: TArgs) => Promise<TResult>;
  budget?: RetryBudget;
  policy?: RetryBudgetPolicy;
  writer?: AttemptWriter;
  now?: () => number;
}

export interface ModelRetryResult<TArgs, TResult> {
  result: TResult;
  /** The args that finally succeeded (possibly model-corrected). */
  args: TArgs;
  attempts: number;
  corrections: number;
}

/**
 * Run a tool call through the bounded validate -> correct -> retry loop.
 * Resolves with the successful result, or rejects with RetryExhaustedError
 * (fail-loud) when a cap is hit. Emits one RetryAttemptRecord via writer.
 */
export async function runWithModelRetry<TArgs, TResult>(
  opts: ModelRetryOptions<TArgs, TResult>,
): Promise<ModelRetryResult<TArgs, TResult>> {
  const budget = opts.budget ?? new RetryBudget(opts.policy ?? DEFAULT_RETRY_POLICY);
  const policy = budget.getPolicy();
  const now = opts.now ?? Date.now;
  const perToolMax = policy.perToolMax;

  let args = opts.initialArgs;
  let attempts = 0;
  const seenRules = new Set<string>();
  let lastViolations: Violation[] = [];

  const emit = (terminal: AttemptTerminal) => {
    if (opts.writer) {
      opts.writer({
        timestamp: new Date(now()).toISOString(),
        toolName: opts.toolName,
        attempts,
        corrections: Math.max(0, attempts - 1),
        terminal,
        violationRules: [...seenRules],
      });
    }
  };

  // attempts loop: 1 initial + up to perToolMax corrections
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempts += 1;

    // 1. structural validation
    const vr = opts.validate(args);
    if (!vr.valid) {
      lastViolations = vr.violations;
      for (const v of vr.violations) seenRules.add(v.rule);
      const usedSoFar = budget.used(opts.toolName);
      if (!budget.canRetry(opts.toolName)) {
        emit(usedSoFar >= perToolMax ? 'exhausted_validation' : 'exhausted_budget');
        throw new RetryExhaustedError(
          opts.toolName,
          attempts,
          lastViolations,
          usedSoFar >= perToolMax ? 'validation' : 'budget',
        );
      }
      budget.consume(opts.toolName);
      const prompt = buildCorrectionPrompt(opts.toolName, vr.violations, usedSoFar + 1, perToolMax);
      args = await opts.regenerate(prompt, args, usedSoFar + 1);
      continue;
    }

    // 2. execute; ModelRetry => semantic correction
    try {
      const result = await opts.execute(args);
      emit('ok');
      return { result, args, attempts, corrections: Math.max(0, attempts - 1) };
    } catch (err) {
      if (!(err instanceof ModelRetry)) throw err;
      seenRules.add('semantic');
      const usedSoFar = budget.used(opts.toolName);
      if (!budget.canRetry(opts.toolName)) {
        emit(usedSoFar >= perToolMax ? 'exhausted_semantic' : 'exhausted_budget');
        throw new RetryExhaustedError(
          opts.toolName,
          attempts,
          lastViolations,
          usedSoFar >= perToolMax ? 'semantic' : 'budget',
        );
      }
      budget.consume(opts.toolName);
      const prompt = buildSemanticCorrectionPrompt(opts.toolName, err.reason, usedSoFar + 1, perToolMax);
      args = await opts.regenerate(prompt, args, usedSoFar + 1);
      continue;
    }
  }
}
