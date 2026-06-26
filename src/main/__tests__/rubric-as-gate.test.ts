/**
 * rubric-as-gate.test.ts
 *
 * Locks the 2026-04-30 rule: the multi-dimension rubric IS the gate
 * for promoting a video to pending_approval. The orchestrator's own
 * brightness / mean_lum / non-blank pixel check is an internal
 * sanity probe, not the bar. Without this, future sessions could
 * silently revert to "passes if pixels not black" -- which is exactly
 * the failure mode that produced the 6 rejected videos in the prior
 * run.
 *
 * The test does NOT call the rubric (slow, network-heavy); it locks
 * the source-code structure that wires it as the gate.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const AURORA_PY = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video_aurora.py');
const RUBRIC_PY = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video-quality-tools', 'run-quality-check.py');
const THRESHOLDS_JSON = path.join(REPO_ROOT, 'data', 'agent', 'video-quality-thresholds.json');

const REQUIRED_CRITERIA = [
  'resolution', 'clarity', 'lighting', 'color_grading', 'framing', 'transitions',
  'volume_levels', 'background_noise', 'voice_clarity', 'music_mix', 'pacing',
  'hook_strength', 'retention_curve', 'emotional_arc', 'cta_placement',
  'codec_quality', 'bitrate', 'caption_readability', 'thumbnail_appeal',
  'format_fit', 'trending_topic_alignment', 'hashtag_relevance',
  'camera_stability', 'audio_dynamics', 'scene_variety',
];

describe('rubric-as-gate -- thresholds JSON shape', () => {
  it('thresholds JSON exists at data/agent/video-quality-thresholds.json', () => {
    expect(fs.existsSync(THRESHOLDS_JSON)).toBe(true);
  });

  it('defines per-criterion thresholds for shorts AND youtube', () => {
    const raw = JSON.parse(fs.readFileSync(THRESHOLDS_JSON, 'utf8'));
    expect(raw.platforms).toBeTruthy();
    expect(raw.platforms.shorts).toBeTruthy();
    expect(raw.platforms.youtube).toBeTruthy();
  });

  it('every required rubric criterion has a numeric threshold for shorts', () => {
    const raw = JSON.parse(fs.readFileSync(THRESHOLDS_JSON, 'utf8'));
    const t = raw.platforms.shorts;
    for (const k of REQUIRED_CRITERIA) {
      expect(t[k], `missing threshold for ${k}`).toBeTypeOf('number');
      // 0 is valid (informational-only criteria like camera_stability,
      // emotional_arc, audio_dynamics on multi-clip Pexels stock content).
      // 95 is the upper sanity bound -- nothing above 95 is achievable
      // even for studio production, so a threshold > 95 is unreachable.
      expect(t[k]).toBeGreaterThanOrEqual(0);
      expect(t[k]).toBeLessThanOrEqual(95);
    }
  });

  it('iteration_strategy.max_iterations exists and is sane', () => {
    const raw = JSON.parse(fs.readFileSync(THRESHOLDS_JSON, 'utf8'));
    expect(raw.iteration_strategy).toBeTruthy();
    expect(raw.iteration_strategy.max_iterations).toBeGreaterThanOrEqual(2);
    expect(raw.iteration_strategy.max_iterations).toBeLessThanOrEqual(8);
  });

  it('fix_hints cover the most common failure modes', () => {
    const raw = JSON.parse(fs.readFileSync(THRESHOLDS_JSON, 'utf8'));
    const hints = raw.iteration_strategy.fix_hints;
    // The criteria most likely to fail on a Pexels-assembled short.
    for (const k of ['scene_variety', 'camera_stability', 'hook_strength', 'caption_readability']) {
      expect(hints[k], `missing fix hint for ${k}`).toBeTruthy();
    }
  });
});

describe('rubric-as-gate -- video_aurora.py wires the rubric', () => {
  it('video_aurora.py imports the rubric tool path', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    expect(src).toMatch(/RUBRIC_TOOL\s*=\s*ROOT\s*\/\s*"src"\s*\/\s*"main"\s*\/\s*"empire"\s*\/\s*"video-quality-tools"\s*\/\s*"run-quality-check\.py"/);
    expect(src).toMatch(/RUBRIC_THRESHOLDS\s*=\s*ROOT\s*\/\s*"data"\s*\/\s*"agent"\s*\/\s*"video-quality-thresholds\.json"/);
  });

  it('exposes run_rubric() that invokes run-quality-check.py with --platform + --transcript + --thumbnail', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    expect(src).toMatch(/def run_rubric/);
    expect(src).toMatch(/RUBRIC_TOOL/);
    expect(src).toMatch(/"--platform"/);
    expect(src).toMatch(/"--transcript"/);
    expect(src).toMatch(/"--thumbnail"/);
  });

  it('exposes evaluate_rubric() that compares detailed_scores to thresholds', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    expect(src).toMatch(/def evaluate_rubric/);
    expect(src).toMatch(/detailed_scores/);
    // The function must mark a video failed if ANY criterion is below
    // its threshold. Check both the pass and fail branches exist.
    expect(src).toMatch(/"passed":/);
    expect(src).toMatch(/"failed":/);
  });

  it('assemble_video_v2_until_rubric_passes loops with banned IDs across iterations', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    expect(src).toMatch(/def assemble_video_v2_until_rubric_passes/);
    // Banned-IDs threading -- the iteration loop must hand the prior
    // run's pexels_ids_used into the next build's seed_banned_ids so
    // the rebuilt video uses different visual content.
    expect(src).toMatch(/seed_banned_ids/);
    expect(src).toMatch(/banned\.update\(build\.get\("pexels_ids_used"/);
    expect(src).toMatch(/max_iterations/);
  });

  it('CLI exposes --rubric-gate flag that triggers the iteration wrapper', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    expect(src).toMatch(/--rubric-gate/);
    expect(src).toMatch(/--platform/);
    expect(src).toMatch(/--max-iterations/);
    // Without --transcript the rubric-gate path errors loudly. The v2
    // path is required so we have a transcript to drive scene queries.
    expect(src).toMatch(/--rubric-gate requires --transcript/);
  });

  it('assemble_video_v2 returns pexels_ids_used so the iteration wrapper can ban them', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    // Without this in the result, the wrapper has nothing to ban
    // and iteration N+1 would re-fetch the same clips.
    expect(src).toMatch(/"pexels_ids_used":\s*sorted\(/);
  });

  it('orchestrator path exists at the expected location', () => {
    expect(fs.existsSync(RUBRIC_PY)).toBe(true);
  });

  it('prep_clip exposes a deshake flag (default OFF after 2026-04-30 empirical test)', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    expect(src).toMatch(/def prep_clip/);
    expect(src).toMatch(/deshake=rx=16:ry=16/);
    // Initial 2026-04-30 hypothesis was deshake fixes camera_stability.
    // Empirically the score-0 came from cut-to-cut motion, not per-clip
    // jitter, so deshake added time without moving the metric. Default
    // off; callers can re-enable with deshake=True if a specific source
    // really needs it.
    expect(src).toMatch(/deshake:\s*bool\s*=\s*False/);
  });
});

describe('rubric-as-gate -- the legacy gate is no longer the promotion bar', () => {
  it('verify_video still exists for fast smoke checks but is not the rubric gate', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    // Keep it; assemble_video_v2 still calls it. But the rubric
    // wrapper does NOT use verify_video as the promote-to-queue gate.
    expect(src).toMatch(/def verify_video/);
    // The rubric path explicitly calls run_rubric + evaluate_rubric.
    const rubricFn = src.match(/def assemble_video_v2_until_rubric_passes[\s\S]*?\n(?=def\s|\Z)/);
    expect(rubricFn).toBeTruthy();
    expect(rubricFn![0]).toMatch(/run_rubric/);
    expect(rubricFn![0]).toMatch(/evaluate_rubric/);
  });
});
