/**
 * thumbnail-first-frame-defect-detector.test.ts
 *
 * Locks the 2026-05-02 #learn rule + the rubric tool that enforces it.
 * ExampleCo rejected nine_free_ai_tools_2026 four times in a row asking for
 * the thumbnail to appear as the first 0.1s of the video. The rubric
 * had no detector for this so the auto-regen kept producing the same
 * defect. Now there is a detector AND a build-pipeline change.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TOOL = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video-quality-tools', 'analyze-thumbnail-first-frame.py');
const FAST = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video-quality-tools', 'run-quality-check-fast.py');
const AURORA = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video_aurora.py');
const THRESHOLDS = path.join(REPO_ROOT, 'data', 'agent', 'video-quality-thresholds.json');
const MEMORY = path.join(REPO_ROOT, 'memory', 'feedback_shorts_thumbnail_first_frame.md');
const AUDIT = path.join(REPO_ROOT, 'scripts', 'process-rejection-into-rubric.js');

describe('thumbnail-first-frame -- the rubric detector', () => {
  it('analyzer file exists', () => {
    expect(fs.existsSync(TOOL)).toBe(true);
  });

  it('extracts the first frame and compares to the thumbnail via perceptual hash', () => {
    const src = fs.readFileSync(TOOL, 'utf8');
    expect(src).toMatch(/def extract_first_frame/);
    expect(src).toMatch(/def perceptual_hash/);
    expect(src).toMatch(/def hamming_distance/);
    expect(src).toMatch(/-frames:v",\s*"1"/);
  });

  it('emits canonical {scores: {thumbnail_first_frame: {score, raw, feedback}}} shape', () => {
    const src = fs.readFileSync(TOOL, 'utf8');
    expect(src).toMatch(/"thumbnail_first_frame":\s*\{/);
    expect(src).toMatch(/hash_distance/);
    expect(src).toMatch(/thumb_hash/);
    expect(src).toMatch(/first_frame_hash/);
  });
});

describe('rubric integration', () => {
  it('analyze-thumbnail-first-frame is in the fast rubric TOOLS list with thumb arg', () => {
    const src = fs.readFileSync(FAST, 'utf8');
    expect(src).toMatch(/analyze-thumbnail-first-frame/);
    expect(src).toMatch(/m\.analyze\(c\["VIDEO"\],\s*c\["THUMB"\]\)/);
  });

  it('thumbnail_first_frame has threshold 80 for shorts (mandatory) and 0 for youtube (not applicable)', () => {
    const raw = JSON.parse(fs.readFileSync(THRESHOLDS, 'utf8'));
    expect(raw.platforms.shorts.thumbnail_first_frame).toBeGreaterThanOrEqual(70);
    expect(raw.platforms.youtube.thumbnail_first_frame).toBe(0);
  });
});

describe('build pipeline -- thumbnail flash at first 0.1s', () => {
  it('THUMBNAIL_CARD_DURATION = 0.1 (the flash, not the silent intro)', () => {
    const src = fs.readFileSync(AURORA, 'utf8');
    expect(src).toMatch(/THUMBNAIL_CARD_DURATION\s*=\s*0\.1/);
  });

  it('audio plays from t=0 for short cards (no -itsoffset for the 0.1s flash)', () => {
    const src = fs.readFileSync(AURORA, 'utf8');
    // Long card (>= 0.5s) keeps the -itsoffset for the silent-intro
    // pattern; short card (0.1s flash) plays audio under the thumbnail.
    expect(src).toMatch(/THUMBNAIL_CARD_DURATION\s*>=\s*0\.5/);
    // audio_offset only applies for the long-card case.
    expect(src).toMatch(/has_card\s+and\s+THUMBNAIL_CARD_DURATION\s*>=\s*0\.5/);
  });
});

describe('memory + rejection->rubric audit', () => {
  it('memory file documents the rule', () => {
    expect(fs.existsSync(MEMORY)).toBe(true);
    const m = fs.readFileSync(MEMORY, 'utf8');
    expect(m).toMatch(/0\.1s/);
    expect(m).toMatch(/first.*frame/i);
  });

  it('rejection->rubric audit has a thumbnail_first_frame bucket so the defect is auto-classified', () => {
    const src = fs.readFileSync(AUDIT, 'utf8');
    expect(src).toMatch(/thumbnail_first_frame/);
    expect(src).toMatch(/first image in the video/);
  });
});
