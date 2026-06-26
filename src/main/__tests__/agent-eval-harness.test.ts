import { describe, it, expect } from 'vitest';
import {
  runEvals,
  renderReport,
  EqualsExpected,
  Contains,
  IsInstance,
  LLMJudge,
  type EvalCase,
} from '../agent-eval-harness';

describe('agent-eval-harness', () => {
  it('scores an exact-match task at 100% pass rate', async () => {
    const cases: EvalCase<string, string>[] = [
      { name: 'upcase-a', input: 'a', expected: 'A' },
      { name: 'upcase-b', input: 'b', expected: 'B' },
    ];
    const report = await runEvals(cases, (s) => s.toUpperCase(), {
      evaluators: [EqualsExpected()],
    });
    expect(report.total).toBe(2);
    expect(report.passRate).toBe(1);
    expect(report.failures).toEqual([]);
    expect(report.byEvaluator.equals_expected).toBe(1);
  });

  it('flags the specific failing case by name, not by index', async () => {
    const cases: EvalCase<string, string>[] = [
      { name: 'good', input: 'a', expected: 'A' },
      { name: 'bad', input: 'b', expected: 'WRONG' },
    ];
    const report = await runEvals(cases, (s) => s.toUpperCase(), {
      evaluators: [EqualsExpected()],
    });
    expect(report.failures).toEqual(['bad']);
    expect(report.passRate).toBe(0.5);
  });

  it('records a thrown task as an error case scoring 0 without aborting the run', async () => {
    const cases: EvalCase<number, number>[] = [
      { name: 'ok', input: 2, expected: 4 },
      { name: 'boom', input: -1, expected: 0 },
    ];
    const report = await runEvals(
      cases,
      (n) => {
        if (n < 0) throw new Error('negative');
        return n * 2;
      },
      { evaluators: [EqualsExpected()] },
    );
    // The good case still ran and scored.
    expect(report.total).toBe(2);
    const boom = report.cases.find((c) => c.name === 'boom');
    expect(boom?.error).toBe('negative');
    expect(boom?.mean).toBe(0);
    expect(report.failures).toContain('boom');
  });

  it('applies case-local evaluators on top of dataset-level ones', async () => {
    const cases: EvalCase<string, string>[] = [
      {
        name: 'greeting',
        input: 'hi',
        expected: 'hello',
        evaluators: [Contains('has-substr')],
      },
    ];
    // Output contains "hello" but is not exactly "hello", so EqualsExpected
    // fails (0) while Contains passes (1). Mean is 0.5.
    const report = await runEvals(cases, () => 'well hello there', {
      evaluators: [EqualsExpected()],
    });
    const c = report.cases[0];
    expect(c.scores.equals_expected).toBe(0);
    expect(c.scores['has-substr']).toBe(1);
    expect(c.mean).toBe(0.5);
  });

  it('Contains matches array membership', async () => {
    const report = await runEvals(
      [{ name: 'arr', input: null, expected: 'b' }] as EvalCase<null, ExampleCo>[],
      () => ['a', 'b', 'c'],
      { evaluators: [Contains()] },
    );
    expect(report.passRate).toBe(1);
  });

  it('IsInstance guards the output runtime type', async () => {
    const report = await runEvals(
      [{ name: 'shape', input: 1 }] as EvalCase<number, ExampleCo>[],
      () => ['x'],
      { evaluators: [IsInstance('array')] },
    );
    expect(report.byEvaluator.is_instance).toBe(1);
  });

  it('LLMJudge uses the injected judge and never reaches the network', async () => {
    let called = 0;
    const judge = ({ ctx }: { ctx: { output: ExampleCo } }) => {
      called += 1;
      // Pass only when output mentions "faith".
      const ok = String(ctx.output).includes('faith');
      return { score: ok ? 1 : 0, reason: ok ? 'mentions faith' : 'missing' };
    };
    const cases: EvalCase<string, string>[] = [
      { name: 'on-topic', input: 'q1' },
      { name: 'off-topic', input: 'q2' },
    ];
    const report = await runEvals(
      cases,
      (q) => (q === 'q1' ? 'rooted in faith' : 'rooted in fear'),
      { evaluators: [LLMJudge('mentions faith', judge)] },
    );
    expect(called).toBe(2);
    expect(report.cases.find((c) => c.name === 'on-topic')?.mean).toBe(1);
    expect(report.cases.find((c) => c.name === 'off-topic')?.mean).toBe(0);
  });

  it('clamps an out-of-range evaluator score into the unit interval', async () => {
    const rogue = {
      name: 'rogue',
      evaluate: () => 9.9,
    };
    const report = await runEvals(
      [{ name: 'x', input: 0 }] as EvalCase<number, ExampleCo>[],
      () => 0,
      { evaluators: [rogue] },
    );
    expect(report.byEvaluator.rogue).toBe(1);
  });

  it('a throwing evaluator scores 0 for that case but does not crash the run', async () => {
    const rogue = {
      name: 'throws',
      evaluate: () => {
        throw new Error('grader blew up');
      },
    };
    const report = await runEvals(
      [{ name: 'x', input: 0, expected: 0 }] as EvalCase<number, number>[],
      () => 0,
      { evaluators: [EqualsExpected(), rogue] },
    );
    expect(report.cases[0].scores.equals_expected).toBe(1);
    expect(report.cases[0].scores.throws).toBe(0);
  });

  it('renders a text report with a pass rate and no dash characters', () => {
    const text = renderReport({
      total: 1,
      passRate: 1,
      cases: [{ name: 'c1', scores: { equals_expected: 1 }, mean: 1 }],
      byEvaluator: { equals_expected: 1 },
      failures: [],
    });
    expect(text).toContain('pass rate 100%');
    expect(text).toContain('PASS c1');
    const enDash = String.fromCharCode(0x2013);
    const emDash = String.fromCharCode(0x2014);
    expect(text.includes(enDash)).toBe(false);
    expect(text.includes(emDash)).toBe(false);
  });

  it('passRate is 0 for an empty dataset rather than NaN', async () => {
    const report = await runEvals([], () => 0, { evaluators: [EqualsExpected()] });
    expect(report.passRate).toBe(0);
    expect(report.total).toBe(0);
  });
});
