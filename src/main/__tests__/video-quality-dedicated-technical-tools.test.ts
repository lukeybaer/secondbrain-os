/**
 * video-quality-dedicated-technical-tools.test.ts
 *
 * Regression test for run 62 (2026-05-15) plus run 63 (2026-05-15 same day): verifies that
 * the previously-generic technical and platform criteria now have dedicated tools wired
 * into run-quality-check.py and the rubric:
 *   run 62: resolution, codec_quality, bitrate -> dedicated v2 tools
 *   run 63: resolution -> v3 (wraps v2 + 3 orthogonal signals),
 *           codec_quality -> v3 (wraps v2 + 3 orthogonal signals),
 *           format_fit -> dedicated v2 (was the LAST acc=0 criterion)
 *
 * Prevents: criteria falling back to the generic analyze-technical-specs.py with acc=0
 * when dedicated tools exist on disk but are not wired into the runner or rubric.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TOOLS_DIR = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video-quality-tools');
const RUBRIC_PATH = path.join(REPO_ROOT, 'data', 'agent', 'video-quality-rubric.json');
const RUNNER_PATH = path.join(TOOLS_DIR, 'run-quality-check.py');

describe('dedicated technical tools exist on disk', () => {
  const tools = [
    'analyze-resolution-v2.py',
    'analyze-codec-quality-v2.py',
    'analyze-bitrate-v2.py',
    'analyze-resolution-v3.py',
    'analyze-codec-quality-v3.py',
    'analyze-format-fit-v2.py',
  ];

  for (const tool of tools) {
    it(`${tool} exists`, () => {
      expect(fs.existsSync(path.join(TOOLS_DIR, tool))).toBe(true);
    });

    it(`${tool} has analyze() function`, () => {
      const src = fs.readFileSync(path.join(TOOLS_DIR, tool), 'utf8');
      expect(src).toContain('def analyze(');
    });

    it(`${tool} returns tool name in output`, () => {
      const src = fs.readFileSync(path.join(TOOLS_DIR, tool), 'utf8');
      const toolName = tool.replace('.py', '');
      expect(src).toContain(`"tool": "${toolName}"`);
    });
  }
});

describe('rubric references dedicated tools (not generic)', () => {
  let rubric: any;

  it('rubric loads', () => {
    rubric = JSON.parse(fs.readFileSync(RUBRIC_PATH, 'utf8'));
    expect(parseInt(String(rubric.version).replace(/^v/i, ''), 10)).toBeGreaterThanOrEqual(67);
  });

  // Version-agnostic: the nightly video-quality-tools task keeps bumping
  // version suffixes (v2 -> v3 -> v4...). Pinning an exact version made this
  // test go stale on every bump. The real invariant is that each technical
  // criterion uses a DEDICATED versioned tool (analyze-<criterion>-v<N>.py),
  // not the generic analyze-technical-specs.py fallback.
  const dedicated = (criterion: string) =>
    new RegExp(`^analyze-${criterion}-v\\d+\\.py$`);

  it('visual.resolution uses a dedicated analyze-resolution tool, not the generic one', () => {
    const sub = rubric.categories.visual.subcriteria.resolution;
    expect(sub.tool).toMatch(dedicated('resolution'));
    expect(fs.existsSync(path.join(TOOLS_DIR, sub.tool))).toBe(true);
    expect(sub.detection_accuracy_self_assessment).toBeGreaterThanOrEqual(97);
  });

  it('technical.codec_quality uses a dedicated analyze-codec-quality tool', () => {
    const sub = rubric.categories.technical.subcriteria.codec_quality;
    expect(sub.tool).toMatch(dedicated('codec-quality'));
    expect(fs.existsSync(path.join(TOOLS_DIR, sub.tool))).toBe(true);
    expect(sub.detection_accuracy_self_assessment).toBeGreaterThanOrEqual(97);
  });

  it('technical.bitrate uses a dedicated analyze-bitrate tool', () => {
    const sub = rubric.categories.technical.subcriteria.bitrate;
    expect(sub.tool).toMatch(dedicated('bitrate'));
    expect(fs.existsSync(path.join(TOOLS_DIR, sub.tool))).toBe(true);
    expect(sub.detection_accuracy_self_assessment).toBeGreaterThanOrEqual(97);
  });

  it('platform.format_fit uses a dedicated analyze-format-fit tool', () => {
    const sub = rubric.categories.platform.subcriteria.format_fit;
    expect(sub.tool).toMatch(dedicated('format-fit'));
    expect(fs.existsSync(path.join(TOOLS_DIR, sub.tool))).toBe(true);
    expect(sub.detection_accuracy_self_assessment).toBeGreaterThanOrEqual(97);
    // Historical milestone (was acc=0 then 97 in run 63). Durable invariant:
    // accuracy_after must be at least the prior baseline. accuracy_before may
    // be re-baselined when a follow-up improvement raises the criterion.
    if (typeof sub.accuracy_before === 'number' && typeof sub.accuracy_after === 'number') {
      expect(sub.accuracy_after).toBeGreaterThanOrEqual(sub.accuracy_before);
    }
  });

  it('no remaining criteria at acc=0', () => {
    const accZero: string[] = [];
    for (const [catName, cat] of Object.entries<any>(rubric.categories)) {
      for (const [subName, sub] of Object.entries<any>(cat.subcriteria || {})) {
        const acc = sub.detection_accuracy_self_assessment ?? 0;
        if (acc === 0) accZero.push(`${catName}.${subName}`);
      }
    }
    expect(accZero).toEqual([]);
  });
});

describe('run-quality-check.py imports and wires dedicated tools', () => {
  let runnerSrc: string;

  it('runner loads', () => {
    runnerSrc = fs.readFileSync(RUNNER_PATH, 'utf8');
    expect(runnerSrc.length).toBeGreaterThan(0);
  });

  it('imports analyze-resolution-v2', () => {
    expect(runnerSrc).toContain('importlib.import_module("analyze-resolution-v2")');
  });

  it('imports analyze-codec-quality-v2', () => {
    expect(runnerSrc).toContain('importlib.import_module("analyze-codec-quality-v2")');
  });

  it('imports analyze-bitrate-v2', () => {
    expect(runnerSrc).toContain('importlib.import_module("analyze-bitrate-v2")');
  });

  it('imports analyze-format-fit-v2 (run 63)', () => {
    expect(runnerSrc).toContain('importlib.import_module("analyze-format-fit-v2")');
  });

  it('imports analyze-resolution-v3 (run 63)', () => {
    expect(runnerSrc).toContain('importlib.import_module("analyze-resolution-v3")');
  });

  it('imports analyze-codec-quality-v3 (run 63)', () => {
    expect(runnerSrc).toContain('importlib.import_module("analyze-codec-quality-v3")');
  });

  it('overrides tech_results with v2 resolution scores', () => {
    expect(runnerSrc).toContain('resolution_v2_results');
  });

  it('overrides tech_results with v2 codec scores', () => {
    expect(runnerSrc).toContain('codec_v2_results');
  });

  it('overrides tech_results with v2 bitrate scores', () => {
    expect(runnerSrc).toContain('bitrate_v2_results');
  });

  it('overrides tech_results with v2 format_fit scores (run 63)', () => {
    expect(runnerSrc).toContain('format_fit_v2_results');
  });

  it('overrides tech_results with v3 resolution scores (run 63)', () => {
    expect(runnerSrc).toContain('resolution_v3_results');
  });

  it('overrides tech_results with v3 codec scores (run 63)', () => {
    expect(runnerSrc).toContain('codec_v3_results');
  });
});
