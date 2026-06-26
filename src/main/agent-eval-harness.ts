// agent-eval-harness.ts
//
// A tiny, code-first regression-eval harness modeled on pydantic-evals.
// SecondBrain has a lot of RUNTIME critics (output-critic, claim-verifier,
// prediction-ledger, output-validator) that score one live turn as it happens.
// What it lacked was an OFFLINE scored test-suite abstraction: a way to pin a
// set of inputs to expected outcomes, run any task function over all of them,
// and get a single repeatable scorecard. Without that, changes to memory
// retrieval, tool routing, or the step loop get eyeballed on a couple of
// examples instead of regression-tested.
//
// Reference: https://pydantic.dev/docs/ai/evals/evals/
//
// Shape mirrors pydantic-evals:
//   - Case: one input, optional expected output, metadata, case-local evaluators.
//   - Evaluator: async (ctx) -> 0..1 score, where ctx exposes input/output/expected.
//   - runEvals(cases, task, datasetEvaluators): runs the task over every case,
//     applies dataset-level + case-level evaluators, aggregates into a report.
//
// This module is pure orchestration. It does NOT call any model itself. The
// LLMJudge evaluator takes an injected judge function so the harness stays
// unit-testable offline and so the caller controls which model (and which rung
// of the LLM fallback ladder) does the judging.

// ── Core types ────────────────────────────────────────────────────────────────

export interface EvalCase<I = ExampleCo, O = ExampleCo> {
  // Stable identifier for the case. Used in the report so a regression points
  // at a specific case, not a row index that shifts when cases are added.
  name: string;
  input: I;
  // Optional ground truth. EqualsExpected / Contains need it; LLMJudge does not.
  expected?: O;
  // Free-form tags the caller can assert on or slice the report by.
  metadata?: Record<string, ExampleCo>;
  // Evaluators that only apply to this case, on top of the dataset-level ones.
  evaluators?: Evaluator<I, O>[];
}

export interface EvaluatorContext<I = ExampleCo, O = ExampleCo> {
  name: string;
  input: I;
  output: O;
  expected?: O;
  metadata?: Record<string, ExampleCo>;
}

export interface Evaluator<I = ExampleCo, O = ExampleCo> {
  // Stable name so a failing score points at the evaluator that produced it.
  name: string;
  // Returns a score in [0, 1]. 1 is a full pass, 0 a full fail. Scores are
  // clamped by the harness so a misbehaving evaluator cannot skew the average
  // outside the unit interval.
  evaluate(ctx: EvaluatorContext<I, O>): Promise<number> | number;
}

// A task takes a case input and produces an output. May be async (the common
// case: it calls the live agent / a memory query / a tool route).
export type EvalTask<I = ExampleCo, O = ExampleCo> = (input: I) => Promise<O> | O;

export interface CaseScore {
  name: string;
  // Evaluator name -> score in [0,1]. Empty when the task threw.
  scores: Record<string, number>;
  // Mean of this case's evaluator scores, or 0 when the task threw.
  mean: number;
  // Set when the task function itself threw. The case scores 0 and is counted
  // as a failure rather than crashing the whole run.
  error?: string;
}

export interface EvaluationReport {
  total: number;
  // Mean across every case mean. The single headline number.
  passRate: number;
  cases: CaseScore[];
  // Per-evaluator mean across all cases that ran that evaluator.
  byEvaluator: Record<string, number>;
  // Names of cases whose mean fell below the failure threshold.
  failures: string[];
}

export interface RunEvalsOptions {
  // Evaluators applied to every case, in addition to each case's own.
  evaluators?: Evaluator[];
  // A case mean below this counts as a failure in report.failures. Default 1.0,
  // i.e. every evaluator must fully pass. Loosen for fuzzy graders.
  passThreshold?: number;
}

// ── Built-in evaluators ───────────────────────────────────────────────────────

// Strict deep-equality against the expected value. Scores 1 or 0.
export function EqualsExpected(name = 'equals_expected'): Evaluator {
  return {
    name,
    evaluate(ctx) {
      if (ctx.expected === undefined) return 0;
      return deepEqual(ctx.output, ctx.expected) ? 1 : 0;
    },
  };
}

// Substring / membership check. For string output, expected must be a substring.
// For array output, expected must be an element. Case-insensitive for strings.
export function Contains(name = 'contains'): Evaluator {
  return {
    name,
    evaluate(ctx) {
      const { output, expected } = ctx;
      if (expected === undefined) return 0;
      if (typeof output === 'string' && typeof expected === 'string') {
        return output.toLowerCase().includes(expected.toLowerCase()) ? 1 : 0;
      }
      if (Array.isArray(output)) {
        return output.some((el) => deepEqual(el, expected)) ? 1 : 0;
      }
      return 0;
    },
  };
}

// Runtime-type guard. Scores 1 when typeof output matches, else 0. Useful for
// "did the task return a string / object at all" smoke checks.
export function IsInstance(expectedType: string, name = 'is_instance'): Evaluator {
  return {
    name,
    evaluate(ctx) {
      if (expectedType === 'array') return Array.isArray(ctx.output) ? 1 : 0;
      return typeof ctx.output === expectedType ? 1 : 0;
    },
  };
}

export interface LLMJudgeVerdict {
  // 1 = rubric satisfied, 0 = not. Fractional allowed for partial-credit judges.
  score: number;
  reason?: string;
}

// Sends the output (and rubric) to an injected judge function. The judge is the
// caller's responsibility so the harness never reaches the network on its own
// and so the LLM fallback ladder governs which model judges. The judge receives
// the rubric plus the full evaluator context.
export function LLMJudge(
  rubric: string,
  judge: (args: {
    rubric: string;
    ctx: EvaluatorContext;
  }) => Promise<LLMJudgeVerdict> | LLMJudgeVerdict,
  name = 'llm_judge',
): Evaluator {
  return {
    name,
    async evaluate(ctx) {
      const verdict = await judge({ rubric, ctx });
      return clamp01(verdict?.score ?? 0);
    },
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

/**
 * Run `task` over every case, score with dataset-level + case-level evaluators,
 * and aggregate into a report. A task that throws does not abort the run: that
 * case is recorded with error set and a mean of 0. Cases run sequentially so a
 * shared live resource (one agent, one DB) is not hammered concurrently; switch
 * to a pooled runner only if a caller needs it.
 */
export async function runEvals<I = ExampleCo, O = ExampleCo>(
  cases: readonly EvalCase<I, O>[],
  task: EvalTask<I, O>,
  options: RunEvalsOptions = {},
): Promise<EvaluationReport> {
  const datasetEvaluators = (options.evaluators ?? []) as Evaluator<I, O>[];
  const passThreshold = clamp01(options.passThreshold ?? 1);

  const caseScores: CaseScore[] = [];
  const evaluatorTotals: Record<string, { sum: number; n: number }> = {};

  for (const c of cases) {
    const evaluators = [...datasetEvaluators, ...(c.evaluators ?? [])];
    let output: O;
    try {
      output = await task(c.input);
    } catch (err) {
      caseScores.push({
        name: c.name,
        scores: {},
        mean: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const ctx: EvaluatorContext<I, O> = {
      name: c.name,
      input: c.input,
      output,
      expected: c.expected,
      metadata: c.metadata,
    };

    const scores: Record<string, number> = {};
    for (const ev of evaluators) {
      let score: number;
      try {
        score = clamp01(await ev.evaluate(ctx));
      } catch {
        // An evaluator that throws scores 0 for this case rather than killing
        // the run. The harness must survive a flaky grader.
        score = 0;
      }
      scores[ev.name] = score;
      const t = (evaluatorTotals[ev.name] ??= { sum: 0, n: 0 });
      t.sum += score;
      t.n += 1;
    }

    const vals = Object.values(scores);
    const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    caseScores.push({ name: c.name, scores, mean });
  }

  const byEvaluator: Record<string, number> = {};
  for (const [k, v] of Object.entries(evaluatorTotals)) {
    byEvaluator[k] = v.n ? v.sum / v.n : 0;
  }

  const passRate = caseScores.length
    ? caseScores.reduce((a, c) => a + c.mean, 0) / caseScores.length
    : 0;

  const failures = caseScores.filter((c) => c.mean < passThreshold).map((c) => c.name);

  return {
    total: caseScores.length,
    passRate,
    cases: caseScores,
    byEvaluator,
    failures,
  };
}

/**
 * Render a report as a compact text table for logs / the briefing. No color,
 * no em dashes, safe to drop into a Telegram message or a console.
 */
export function renderReport(report: EvaluationReport): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const lines: string[] = [];
  lines.push(
    `Eval: ${report.total} cases, pass rate ${pct(report.passRate)}, ` +
      `${report.failures.length} failing`,
  );
  for (const c of report.cases) {
    const tag = c.error
      ? `ERROR ${c.error}`
      : Object.entries(c.scores)
          .map(([k, v]) => `${k}=${pct(v)}`)
          .join(' ');
    lines.push(`  ${c.mean >= 1 ? 'PASS' : 'FAIL'} ${c.name}: ${tag}`);
  }
  if (Object.keys(report.byEvaluator).length) {
    const ev = Object.entries(report.byEvaluator)
      .map(([k, v]) => `${k}=${pct(v)}`)
      .join(' ');
    lines.push(`  by evaluator: ${ev}`);
  }
  return lines.join('\n');
}

// ── helpers ───────────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function deepEqual(a: ExampleCo, b: ExampleCo): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((el, i) => deepEqual(el, b[i]));
  }
  const ao = a as Record<string, ExampleCo>;
  const bo = b as Record<string, ExampleCo>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual(ao[k], bo[k]));
}
