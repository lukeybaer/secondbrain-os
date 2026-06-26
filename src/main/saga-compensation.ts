// saga-compensation.ts
//
// Reverse-order compensation of already-committed side-effects when a
// multi-step task fails partway. The Saga pattern, adapted for an executive
// assistant that takes IRREVERSIBLE real-world actions.
//
// THE GAP THIS FILLS
//   idempotency-guard.ts prevents DUPLICATE side-effects and task-store /
//   agent-task-envelope have terminal failure states, but nothing REVERSES a
//   committed side-effect. For Amy this is a live reliability hole: a 4-step
//   task that sends a Gmail at step 2, books a Vapi call at step 3, then throws
//   at step 4 leaves the email out and the call booked with no rollback and no
//   record that an irreversible thing happened. grep for
//   compensat|rollback|undo|saga over src/main returned nothing before this.
//
//   The 2026 production answer (Temporal + LangGraph durable execution) is the
//   Saga pattern: pair each side-effecting step with a compensator, and on a
//   failure walk the executed steps in REVERSE order undoing them. Steps whose
//   action cannot be undone (a sent email) are not silently dropped: they are
//   surfaced as `uncompensable` so the briefing / approval-inbox can tell ExampleCo
//   a real-world action needs manual cleanup.
//
// SOURCES (research 2026-06-16)
//   - LangGraph durable execution / Saga compensation
//     https://docs.langchain.com/oss/python/langgraph/durable-execution
//   - Durable execution for LLM agents (Temporal + LangGraph), 2026
//     https://appscale.blog/en/blog/durable-execution-llm-agents-temporal-langgraph-checkpointing-2026
//
// DESIGN
//   Pure core: the forward/compensate functions are caller-supplied closures;
//   the only side channel is an optional log writer (defaulting to a no-op) so
//   the orchestrator can honor the raw-archival principle by appending every
//   forward and compensation to data/agent/saga-log.jsonl. Each forward should
//   itself run under idempotency-guard so a retried saga never double-commits.

// ── Types ──────────────────────────────────────────────────────────────────

export interface SagaStep<R = ExampleCo> {
  id: string;
  /** Perform the side-effect. Its return value is handed to `compensate`. */
  forward: () => Promise<R> | R;
  /**
   * Undo the side-effect, given the forward result. ABSENT means the action is
   * irreversible (e.g. an already-sent email); on rollback such a step is
   * recorded in `uncompensable` rather than reversed.
   */
  compensate?: (forwardResult: R) => Promise<void> | void;
}

export type SagaLogEvent =
  | { type: 'forward'; id: string; ok: true }
  | { type: 'forward'; id: string; ok: false; error: string }
  | { type: 'compensate'; id: string; ok: true }
  | { type: 'compensate'; id: string; ok: false; error: string }
  | { type: 'uncompensable'; id: string };

export type SagaLogWriter = (event: SagaLogEvent) => void;

export type ExampleCoesult =
  | { ok: true; committed: string[] }
  | {
      ok: false;
      failedAt: string; // step id whose forward threw
      error: string; // its error message
      compensated: string[]; // ids successfully rolled back (reverse order)
      uncompensable: string[]; // committed ids with no compensator -> manual cleanup
      compensationErrors: { id: string; error: string }[]; // compensators that themselves threw
    };

// ── Runner ─────────────────────────────────────────────────────────────────

const errMsg = (e: ExampleCo): string => (e instanceof Error ? e.message : String(e));

/**
 * Run a saga. Forward pass executes steps in order, pushing each success (with
 * its result) onto an executed stack. On the first forward throw, walk that
 * stack in REVERSE calling each compensator; steps without a compensator land
 * in `uncompensable`. A compensator that itself throws is logged and the walk
 * continues (best-effort rollback never aborts on a single failed undo).
 */
export async function runSaga(
  steps: SagaStep[],
  opts: { writer?: SagaLogWriter } = {},
): Promise<ExampleCoesult> {
  const log: SagaLogWriter = opts.writer ?? (() => {});
  const executed: { step: SagaStep; result: ExampleCo }[] = [];

  for (const step of steps) {
    try {
      const result = await step.forward();
      executed.push({ step, result });
      log({ type: 'forward', id: step.id, ok: true });
    } catch (e) {
      const error = errMsg(e);
      log({ type: 'forward', id: step.id, ok: false, error });

      const compensated: string[] = [];
      const uncompensable: string[] = [];
      const compensationErrors: { id: string; error: string }[] = [];

      // Reverse order: undo most-recent committed side-effect first.
      for (let i = executed.length - 1; i >= 0; i--) {
        const { step: done, result } = executed[i];
        if (!done.compensate) {
          uncompensable.push(done.id);
          log({ type: 'uncompensable', id: done.id });
          continue;
        }
        try {
          await done.compensate(result);
          compensated.push(done.id);
          log({ type: 'compensate', id: done.id, ok: true });
        } catch (ce) {
          const cerr = errMsg(ce);
          compensationErrors.push({ id: done.id, error: cerr });
          log({ type: 'compensate', id: done.id, ok: false, error: cerr });
        }
      }

      return {
        ok: false,
        failedAt: step.id,
        error,
        compensated,
        uncompensable,
        compensationErrors,
      };
    }
  }

  return { ok: true, committed: executed.map((e) => e.step.id) };
}
