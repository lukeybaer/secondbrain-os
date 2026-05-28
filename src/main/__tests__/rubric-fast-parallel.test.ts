/**
 * rubric-fast-parallel.test.ts
 *
 * Locks the 2026-04-30 fast-parallel rubric. The canonical orchestrator
 * (run-quality-check.py) imports v2-v7 of every tool ever shipped and
 * runs them sequentially; the override pattern only uses the latest
 * version's score, so 80% of compute is thrown away. The fast variant
 * calls 21 latest-version tools in parallel.
 *
 * The test does NOT execute the rubric (slow even at 4-worker
 * parallel); it locks the source-code structure that delivers the
 * speedup so a future session cannot silently regress it.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FAST = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video-quality-tools', 'run-quality-check-fast.py');
const AURORA = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video_aurora.py');

describe('rubric-fast-parallel -- structure', () => {
  it('run-quality-check-fast.py exists', () => {
    expect(fs.existsSync(FAST)).toBe(true);
  });

  it('uses ThreadPoolExecutor with configurable workers (default 4)', () => {
    const src = fs.readFileSync(FAST, 'utf8');
    expect(src).toMatch(/ThreadPoolExecutor/);
    expect(src).toMatch(/max_workers=workers/);
    expect(src).toMatch(/--workers/);
    expect(src).toMatch(/default=4/);
  });

  it('TOOLS list has at least 20 entries (latest version of each criterion only)', () => {
    const src = fs.readFileSync(FAST, 'utf8');
    const toolsBlock = src.match(/TOOLS\s*=\s*\[([\s\S]*?)\n\]/);
    expect(toolsBlock).toBeTruthy();
    const lines = toolsBlock![1].split('\n').filter(l => l.trim().startsWith('('));
    expect(lines.length).toBeGreaterThanOrEqual(20);
    // Upper bound tracks actual growth: was 21 (2026-04-28), now 24 (2026-05-09 +audio-edges/thumb-frame/numbered-list).
    // Update this when new criteria are added.
    expect(lines.length).toBeLessThanOrEqual(30);
  });

  it('TOOLS list does NOT include v2/v3/v4 of any criterion that has a v5+', () => {
    const src = fs.readFileSync(FAST, 'utf8');
    // Latest-only assertion: pacing must be v6, hook-strength v7, cta v7,
    // transitions v7, clarity v6, framing v6, etc. The whole point of the
    // fast variant is to skip the older versions.
    expect(src).toMatch(/analyze-pacing-v6/);
    expect(src).toMatch(/analyze-hook-strength-v7/);
    expect(src).toMatch(/analyze-cta-v7/);
    expect(src).toMatch(/analyze-transitions-v7/);
    expect(src).toMatch(/analyze-clarity-v6/);
    expect(src).not.toMatch(/analyze-pacing-v3/);
    expect(src).not.toMatch(/analyze-hook-strength-v3/);
    expect(src).not.toMatch(/analyze-cta-v3/);
  });

  it('normalizes bare-number scores to {score, raw} dicts (regression: trending_topics-v6 returns bare numbers)', () => {
    const src = fs.readFileSync(FAST, 'utf8');
    expect(src).toMatch(/_bare_score_to_dict/);
    expect(src).toMatch(/isinstance\(v,\s*\(int,\s*float\)\)/);
  });

  it('emits same JSON shape as canonical orchestrator (overall_score, virality_score, detailed_scores, category_scores)', () => {
    const src = fs.readFileSync(FAST, 'utf8');
    expect(src).toMatch(/"overall_score":/);
    expect(src).toMatch(/"virality_score":/);
    expect(src).toMatch(/"detailed_scores":/);
    expect(src).toMatch(/"category_scores":/);
    expect(src).toMatch(/"publish_recommendation":/);
  });

  it('emits per-tool timing so we can spot the new bottleneck after each run', () => {
    const src = fs.readFileSync(FAST, 'utf8');
    expect(src).toMatch(/"tool_timing_s":/);
    expect(src).toMatch(/"wall_time_s":/);
    expect(src).toMatch(/rubric_variant.*fast_parallel/);
  });
});

describe('video-aurora -- defaults to fast rubric', () => {
  it('run_rubric default arg fast=True', () => {
    const src = fs.readFileSync(AURORA, 'utf8');
    expect(src).toMatch(/RUBRIC_TOOL_FAST\s*=/);
    // The function signature should default fast=True so existing callers
    // get the speedup without code changes.
    expect(src).toMatch(/fast:\s*bool\s*=\s*True/);
    // The fast/slow toggle uses the same JSON shape so evaluate_rubric
    // and the threshold check work unchanged either way.
    expect(src).toMatch(/tool\s*=\s*RUBRIC_TOOL_FAST\s+if\s+fast\s+else\s+RUBRIC_TOOL/);
  });

  it('run_rubric forwards --srt-file when the sidecar exists (regression: caption-readability needs the path)', () => {
    const src = fs.readFileSync(AURORA, 'utf8');
    expect(src).toMatch(/srt_path:\s*Optional\[Path\]/);
    expect(src).toMatch(/"--srt-file"/);
  });

  it('iteration loop passes the sidecar SRT to run_rubric (regression: cleanup deleted it before it could be scored)', () => {
    const src = fs.readFileSync(AURORA, 'utf8');
    // assemble_video_v2 now copies the sidecar SRT to out_path's sibling
    // before cleanup. The wrapper points run_rubric at it.
    expect(src).toMatch(/sidecar_srt\s*=\s*out_path\.with_suffix\("\.srt"\)/);
    expect(src).toMatch(/srt_path=sidecar_srt\s+if\s+sidecar_srt\.exists\(\)\s+else\s+None/);
  });

  it('prep_clip deshake is opt-in (default OFF) -- regression on 2026-04-30 hypothesis', () => {
    const src = fs.readFileSync(AURORA, 'utf8');
    // Initial 2026-04-30 build defaulted deshake=True to address
    // camera_stability scoring 0. Empirically the score-0 came from
    // cut-to-cut motion not per-clip jitter, so deshake was just slowing
    // the prep stage. Default off; callers opt in.
    expect(src).toMatch(/deshake:\s*bool\s*=\s*False/);
  });
});
