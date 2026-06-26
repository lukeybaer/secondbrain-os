// prompt-compiler.ts
//
// DSPy-style BootstrapFewShot compiler for SecondBrain prompts.
//
// Pattern source: stanfordnlp/dspy BootstrapFewShot.compile(). A teacher pass
// runs candidate inputs through the prompt, scores each output against the
// expected value via a caller-supplied metric, and keeps only the demos that
// pass. Survivors are baked into the final prompt as few-shot examples.
//
// Why SecondBrain needs this:
//   - preference-learner.ts and behaviour-adjustment.ts tune knobs but never
//     touch the prompts themselves
//   - briefing prompts and Vapi system prompts are static strings updated by
//     hand
//   - rejections.jsonl + content-review/LEARNINGS.md are ground-truth
//     trainsets that already exist; nothing reads them as prompt training data
//
// The compiler is LLM-agnostic. Callers inject a `runCandidate` function that
// the teacher uses to produce candidate outputs. The output is a deterministic
// JSON artifact written to data/agent/compiled-prompts/{key}.json that the
// briefing/call/news pipelines load at runtime — no DSPy dependency at runtime.

import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TrainExample<I = ExampleCo, O = ExampleCo> {
  /** Input the prompt is supposed to handle. Used to drive the teacher pass. */
  input: I;
  /** Ground truth the metric scores against. */
  expected: O;
  /** Free-form label so the briefing can show "kept N of M from <source>". */
  source?: string;
}

export interface CompiledDemo<I = ExampleCo, O = ExampleCo> {
  input: I;
  output: O;
  score: number;
}

export interface CompiledPrompt<I = ExampleCo, O = ExampleCo> {
  prompt_key: string;
  compiled_at: string;
  base_prompt: string;
  demos: CompiledDemo<I, O>[];
  baseline_score: number;
  compiled_score: number;
  trainset_size: number;
  /** Threshold used during compilation. */
  metric_threshold: number;
  /** Brief notes for the briefing surface. */
  notes: string;
}

export interface CompileOptions<I = ExampleCo, O = ExampleCo> {
  /** Stable key — used as the filename. e.g. "briefing.news_summary". */
  promptKey: string;
  /** The static prompt before any demos are baked in. */
  basePrompt: string;
  /** Training examples. The compiler scores each one. */
  trainset: TrainExample<I, O>[];
  /** Teacher pass: produce a candidate output for the input. */
  runCandidate: (input: I, basePrompt: string) => Promise<O> | O;
  /** Score in [0, 1]. Examples scoring >= threshold become demos. */
  metric: (candidate: O, expected: O) => number;
  /** Default 0.6. */
  metricThreshold?: number;
  /** Default 4. Hard cap on demos in the compiled prompt. */
  maxDemos?: number;
  /** Where to write {promptKey}.json. Default `${cwd}/data/agent/compiled-prompts/`. */
  outputDir?: string;
}

// ── Compile ───────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_MAX_DEMOS = 4;

export async function compilePrompt<I, O>(
  opts: CompileOptions<I, O>,
): Promise<CompiledPrompt<I, O>> {
  const {
    promptKey,
    basePrompt,
    trainset,
    runCandidate,
    metric,
    metricThreshold = DEFAULT_THRESHOLD,
    maxDemos = DEFAULT_MAX_DEMOS,
    outputDir,
  } = opts;

  if (!promptKey || !/^[a-z0-9_.-]+$/i.test(promptKey)) {
    throw new Error(`compilePrompt: promptKey must be filesystem-safe, got "${promptKey}"`);
  }
  if (trainset.length === 0) {
    throw new Error('compilePrompt: trainset must not be empty');
  }
  if (metricThreshold < 0 || metricThreshold > 1) {
    throw new Error(`compilePrompt: metricThreshold must be in [0, 1], got ${metricThreshold}`);
  }

  // Score every candidate via the teacher.
  const scored: Array<CompiledDemo<I, O> & { passed: boolean }> = [];
  let baselineSum = 0;
  for (const ex of trainset) {
    let candidate: O;
    try {
      candidate = await runCandidate(ex.input, basePrompt);
    } catch {
      // Treat teacher failure as a 0-score example. Don't drop the run.
      scored.push({ input: ex.input, output: ex.expected, score: 0, passed: false });
      continue;
    }
    const raw = metric(candidate, ex.expected);
    const score = clamp01(raw);
    baselineSum += score;
    scored.push({
      input: ex.input,
      output: candidate,
      score,
      passed: score >= metricThreshold,
    });
  }

  const baselineScore = scored.length > 0 ? baselineSum / scored.length : 0;

  // Survivors become demos. Deterministic order: highest score first, ties by index.
  const survivors = scored
    .map((s, i) => ({ ...s, _i: i }))
    .filter((s) => s.passed)
    .sort((a, b) => b.score - a.score || a._i - b._i)
    .slice(0, maxDemos)
    .map(({ input, output, score }) => ({ input, output, score }));

  const compiledScore =
    survivors.length > 0
      ? survivors.reduce((s, d) => s + d.score, 0) / survivors.length
      : 0;

  const compiled: CompiledPrompt<I, O> = {
    prompt_key: promptKey,
    compiled_at: new Date().toISOString(),
    base_prompt: basePrompt,
    demos: survivors,
    baseline_score: round4(baselineScore),
    compiled_score: round4(compiledScore),
    trainset_size: trainset.length,
    metric_threshold: metricThreshold,
    notes: `kept ${survivors.length} of ${trainset.length} (threshold ${metricThreshold})`,
  };

  // Write artifact.
  const dir = outputDir ?? defaultOutputDir();
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${promptKey}.json`);
  fs.writeFileSync(outPath, JSON.stringify(compiled, null, 2), 'utf8');

  return compiled;
}

// ── Loader (used by briefing / call / news pipelines at runtime) ──────────────

export interface RenderOptions {
  /** Override the demos baked at compile time. Useful for tests. */
  demosOverride?: CompiledDemo[];
}

/**
 * Load a compiled prompt and render it as a single string with demos
 * appended. Falls back to `fallbackPrompt` if no compiled artifact exists
 * — that path keeps the briefing running even on first ever boot.
 */
export function loadCompiledPrompt(
  promptKey: string,
  fallbackPrompt: string,
  outputDir?: string,
): CompiledPrompt | { prompt_key: string; base_prompt: string; demos: []; fallback: true } {
  const dir = outputDir ?? defaultOutputDir();
  const p = path.join(dir, `${promptKey}.json`);
  if (!fs.existsSync(p)) {
    return { prompt_key: promptKey, base_prompt: fallbackPrompt, demos: [], fallback: true };
  }
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as CompiledPrompt;
  } catch {
    return { prompt_key: promptKey, base_prompt: fallbackPrompt, demos: [], fallback: true };
  }
}

/**
 * Render a compiled prompt as a single string with demos appended in
 * standard "Input/Output" few-shot format.
 */
export function renderCompiledPrompt(
  compiled: { base_prompt: string; demos: CompiledDemo[] },
  opts: RenderOptions = {},
): string {
  const demos = opts.demosOverride ?? compiled.demos;
  if (demos.length === 0) return compiled.base_prompt;

  const lines = [compiled.base_prompt, '', '# Examples'];
  demos.forEach((d, i) => {
    lines.push(`## Example ${i + 1}`);
    lines.push(`Input: ${stringify(d.input)}`);
    lines.push(`Output: ${stringify(d.output)}`);
    lines.push('');
  });
  return lines.join('\n');
}

// ── Internals ─────────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (Number.isNaN(n) || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function stringify(v: ExampleCo): string {
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function defaultOutputDir(): string {
  return path.join(process.cwd(), 'data', 'agent', 'compiled-prompts');
}
