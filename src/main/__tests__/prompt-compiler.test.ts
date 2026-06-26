import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  compilePrompt,
  loadCompiledPrompt,
  renderCompiledPrompt,
  TrainExample,
} from '../prompt-compiler';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-'));
}

describe('compilePrompt', () => {
  it('keeps only demos that score above the threshold', async () => {
    const train: TrainExample<string, string>[] = [
      { input: 'a', expected: 'A' },
      { input: 'b', expected: 'B' },
      { input: 'c', expected: 'C' },
    ];
    // Teacher uppercases for a and c, returns wrong answer for b.
    const runCandidate = (inp: string) => (inp === 'b' ? 'wrong' : inp.toUpperCase());
    const metric = (cand: string, exp: string) => (cand === exp ? 1 : 0);

    const out = await compilePrompt({
      promptKey: 'test.upper',
      basePrompt: 'Uppercase the letter.',
      trainset: train,
      runCandidate,
      metric,
      metricThreshold: 0.6,
      outputDir: tempDir(),
    });

    expect(out.demos).toHaveLength(2);
    expect(out.demos.map((d) => d.input).sort()).toEqual(['a', 'c']);
    expect(out.compiled_score).toBe(1);
    expect(out.baseline_score).toBeCloseTo(2 / 3, 4);
    expect(out.notes).toContain('kept 2 of 3');
  });

  it('writes deterministic JSON artifact to outputDir/{promptKey}.json', async () => {
    const dir = tempDir();
    const out = await compilePrompt({
      promptKey: 'briefing.greeting',
      basePrompt: 'Greet warmly.',
      trainset: [{ input: 'hi', expected: 'hello!' }],
      runCandidate: () => 'hello!',
      metric: (a, b) => (a === b ? 1 : 0),
      outputDir: dir,
    });

    const filePath = path.join(dir, 'briefing.greeting.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(parsed.prompt_key).toBe('briefing.greeting');
    expect(parsed.demos).toHaveLength(1);
    expect(parsed.compiled_at).toBe(out.compiled_at);
  });

  it('caps demos at maxDemos using highest-score-first ordering', async () => {
    const train: TrainExample<number, number>[] = [
      { input: 1, expected: 1 },
      { input: 2, expected: 2 },
      { input: 3, expected: 3 },
      { input: 4, expected: 4 },
      { input: 5, expected: 5 },
    ];
    // All pass perfectly; cap should drop the last 2 by index after the sort tie-break.
    const out = await compilePrompt({
      promptKey: 'test.cap',
      basePrompt: 'identity',
      trainset: train,
      runCandidate: (n) => n,
      metric: () => 1,
      maxDemos: 3,
      outputDir: tempDir(),
    });
    expect(out.demos).toHaveLength(3);
    expect(out.demos.map((d) => d.input)).toEqual([1, 2, 3]);
  });

  it('treats teacher failures as 0-score and continues the run', async () => {
    const train: TrainExample<string, string>[] = [
      { input: 'good', expected: 'GOOD' },
      { input: 'bad', expected: 'BAD' },
    ];
    const out = await compilePrompt({
      promptKey: 'test.failures',
      basePrompt: 'upper',
      trainset: train,
      runCandidate: (s) => {
        if (s === 'bad') throw new Error('teacher fell over');
        return s.toUpperCase();
      },
      metric: (a, b) => (a === b ? 1 : 0),
      outputDir: tempDir(),
    });
    expect(out.demos).toHaveLength(1);
    expect(out.demos[0].input).toBe('good');
    expect(out.baseline_score).toBeCloseTo(0.5, 4);
  });

  it('rejects empty trainset and unsafe promptKey', async () => {
    const dir = tempDir();
    await expect(
      compilePrompt({
        promptKey: 'ok',
        basePrompt: 'p',
        trainset: [],
        runCandidate: () => 'x',
        metric: () => 1,
        outputDir: dir,
      }),
    ).rejects.toThrow(/trainset/);

    await expect(
      compilePrompt({
        promptKey: '../escape',
        basePrompt: 'p',
        trainset: [{ input: 1, expected: 1 }],
        runCandidate: () => 1,
        metric: () => 1,
        outputDir: dir,
      }),
    ).rejects.toThrow(/filesystem-safe/);
  });

  it('clamps metric output to [0,1] and ignores NaN', async () => {
    const out = await compilePrompt({
      promptKey: 'test.clamp',
      basePrompt: 'p',
      trainset: [
        { input: 1, expected: 1 },
        { input: 2, expected: 2 },
        { input: 3, expected: 3 },
      ],
      runCandidate: (n) => n,
      metric: (_a, b) => {
        if (b === 1) return 5; // clamped to 1
        if (b === 2) return -3; // clamped to 0
        return Number.NaN; // becomes 0
      },
      metricThreshold: 0.5,
      outputDir: tempDir(),
    });
    expect(out.demos).toHaveLength(1);
    expect(out.demos[0].input).toBe(1);
    expect(out.demos[0].score).toBe(1);
  });
});

describe('loadCompiledPrompt + renderCompiledPrompt', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });

  it('returns fallback prompt when no artifact exists', () => {
    const loaded = loadCompiledPrompt('missing.key', 'fallback prompt', dir);
    expect(loaded.base_prompt).toBe('fallback prompt');
    expect(loaded.demos).toEqual([]);
    expect((loaded as { fallback?: boolean }).fallback).toBe(true);
  });

  it('round-trips a compiled prompt and renders demos as Input/Output blocks', async () => {
    await compilePrompt({
      promptKey: 'render.test',
      basePrompt: 'Reverse the word.',
      trainset: [
        { input: 'cat', expected: 'tac' },
        { input: 'dog', expected: 'god' },
      ],
      runCandidate: (s: string) => s.split('').reverse().join(''),
      metric: (a, b) => (a === b ? 1 : 0),
      outputDir: dir,
    });

    const loaded = loadCompiledPrompt('render.test', 'unused', dir);
    const rendered = renderCompiledPrompt(loaded);
    expect(rendered).toContain('Reverse the word.');
    expect(rendered).toContain('# Examples');
    expect(rendered).toContain('Input: cat');
    expect(rendered).toContain('Output: tac');
    expect(rendered).toContain('Input: dog');
  });

  it('renders only the base prompt when there are no demos', () => {
    const out = renderCompiledPrompt({ base_prompt: 'just this', demos: [] });
    expect(out).toBe('just this');
  });

  it('handles corrupt artifacts by returning the fallback', () => {
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
    const loaded = loadCompiledPrompt('broken', 'fb', dir);
    expect(loaded.base_prompt).toBe('fb');
    expect((loaded as { fallback?: boolean }).fallback).toBe(true);
  });
});
