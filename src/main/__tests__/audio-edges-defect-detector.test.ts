/**
 * audio-edges-defect-detector.test.ts
 *
 * Locks the 2026-04-30 rejection-driven rubric extension. Luke rejected
 * ai_agent_income_formula with "awkward silence at the beginning, cuts
 * off her voice in the middle of the word at the end." The rubric had
 * no mechanism to detect those defects -- so future builds with the
 * same failure modes could quietly pass and reach his queue again.
 *
 * Two specific defects now have programmatic detection:
 *   1. Leading silence > 0.5s (rejection signal: "awkward silence")
 *   2. Trailing audio loudness above -45 dBFS (rejection signal:
 *      "cuts off mid-word")
 *
 * Plus the build pipeline now refuses to ship a video whose concat is
 * shorter than the source audio, since that's the upstream cause of
 * the trailing-truncation defect.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TOOL = path.join(
  REPO_ROOT,
  'src',
  'main',
  'empire',
  'video-quality-tools',
  'analyze-audio-edges.py',
);
const FAST = path.join(
  REPO_ROOT,
  'src',
  'main',
  'empire',
  'video-quality-tools',
  'run-quality-check-fast.py',
);
const AURORA = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video_aurora.py');
const THRESHOLDS = path.join(REPO_ROOT, 'data', 'agent', 'video-quality-thresholds.json');

describe('analyze-audio-edges -- rejection feedback baked into the rubric', () => {
  it('the analyzer file exists', () => {
    expect(fs.existsSync(TOOL)).toBe(true);
  });

  it('detects leading silence (Luke: "awkward silence at the beginning")', () => {
    const src = fs.readFileSync(TOOL, 'utf8');
    expect(src).toMatch(/def leading_silence_seconds/);
    // Walks 0.1s windows from t=0 measuring RMS directly via astats.
    // Don't switch back to silencedetect -- it misses leading silence
    // when the audio stream's start_time is non-zero (ffmpeg -itsoffset).
    expect(src).toMatch(/measure_window_rms/);
    expect(src).toMatch(/threshold_db\s*=\s*-55/);
  });

  it('detects trailing truncation (Luke: "cuts off her voice in the middle of the word at the end")', () => {
    const src = fs.readFileSync(TOOL, 'utf8');
    expect(src).toMatch(/def trailing_rms_db/);
    // The signal is: last 0.4s above -45 dBFS = audio cuts off while
    // still loud = mid-word truncation. Heavy penalty.
    expect(src).toMatch(/trailing_rms\s*>\s*-45/);
  });

  it('detects video/audio duration mismatch (the upstream cause: -shortest truncated audio)', () => {
    const src = fs.readFileSync(TOOL, 'utf8');
    expect(src).toMatch(/def video_audio_duration_mismatch/);
    expect(src).toMatch(/total_dur\s*-\s*audio_dur/);
  });

  it('returns canonical {tool, scores: {audio_edges: {score, raw, feedback}}, overall_score} shape', () => {
    const src = fs.readFileSync(TOOL, 'utf8');
    expect(src).toMatch(/"tool":\s*"analyze-audio-edges"/);
    expect(src).toMatch(/"audio_edges":\s*\{"score":/);
    expect(src).toMatch(/"overall_score":/);
  });
});

describe('rubric integration', () => {
  it('analyze-audio-edges is in the fast rubric TOOLS list', () => {
    const src = fs.readFileSync(FAST, 'utf8');
    expect(src).toMatch(/"analyze-audio-edges"/);
  });

  it('audio_edges has a 0-95 numeric threshold for shorts and youtube', () => {
    const raw = JSON.parse(fs.readFileSync(THRESHOLDS, 'utf8'));
    expect(raw.platforms.shorts.audio_edges).toBeTypeOf('number');
    expect(raw.platforms.shorts.audio_edges).toBeGreaterThanOrEqual(50);
    expect(raw.platforms.shorts.audio_edges).toBeLessThanOrEqual(95);
    expect(raw.platforms.youtube.audio_edges).toBeTypeOf('number');
  });
});

describe('build pipeline -- defect prevention upstream of detection', () => {
  it('THUMBNAIL_CARD_DURATION default is 0 (no silent intro)', () => {
    const src = fs.readFileSync(AURORA, 'utf8');
    expect(src).toMatch(/THUMBNAIL_CARD_DURATION\s*=\s*0\.0/);
  });

  it('concat duration is validated against target_dur (prevents -shortest audio truncation)', () => {
    const src = fs.readFileSync(AURORA, 'utf8');
    expect(src).toMatch(/MIN_CONCAT_DURATION_RATIO/);
    expect(src).toMatch(/sum_segment_durations/);
    // Both v1 (assemble_video) and v2 (assemble_video_v2) must enforce
    // the concat-length contract.
    expect(src).toMatch(/concat too short: prepped only/);
    expect(src).toMatch(/Audio would truncate mid-word/);
  });

  it('thumbnail card is skipped entirely when duration is 0 (regression: a 0-duration card crashed thumbnail_to_video)', () => {
    const src = fs.readFileSync(AURORA, 'utf8');
    // The has_card guard now AND-checks THUMBNAIL_CARD_DURATION > 0 so a
    // 0-duration card is treated as "no card."
    expect(src).toMatch(/THUMBNAIL_CARD_DURATION\s*>\s*0/);
  });

  it('prep_clip uses -stream_loop -1 so short Pexels clips are looped to reach scene duration (regression: short clips made concat run short and fail concat-validation)', () => {
    const src = fs.readFileSync(AURORA, 'utf8');
    expect(src).toMatch(/"-stream_loop",\s*"-1"/);
  });
});
