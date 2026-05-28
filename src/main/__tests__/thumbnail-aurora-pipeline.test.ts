/**
 * thumbnail-aurora-pipeline.test.ts
 *
 * Locks the 2026-04-29 evening fix: autonomous thumbnail generator that
 * replaces the procedural make_thumbnail_v2 with a Bedrock Stable Image
 * Ultra cinematic background + PIL text compositor, verified by the
 * existing pixel-content gate.
 *
 * The test does NOT call Bedrock (no network from CI). It locks the
 * source-code structure: the entry point exists, the auto-regen script
 * routes thumbnail_needs_regen through it, and the SKILL.md is present
 * with the right shape so future sessions know the contract.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const AURORA_PY = path.join(REPO_ROOT, 'src', 'main', 'empire', 'thumbnail_aurora.py');
const AUTO_REGEN = path.join(REPO_ROOT, 'scripts', 'auto-regen-rejected-videos.js');
const SKILL_MD = path.join(REPO_ROOT, 'scheduled-tasks', 'thumbnail-aurora', 'SKILL.md');
const MEMORY_PROJECT = path.join(REPO_ROOT, 'memory', 'project_youtube_monetization_pipeline.md');

describe('thumbnail-aurora -- autonomous thumbnail generator', () => {
  it('thumbnail_aurora.py entry point exists', () => {
    expect(fs.existsSync(AURORA_PY)).toBe(true);
  });

  it('uses AWS Bedrock Stable Image Ultra (us-west-2) as primary model', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    expect(src).toMatch(/BEDROCK_REGION\s*=\s*['"]us-west-2['"]/);
    expect(src).toMatch(/stability\.stable-image-ultra-v1:1/);
  });

  // 2026-05-24 Luke gap: the prior implementation only mixed the
  // rejection_note into the random seed. That meant Bedrock got the same
  // prompt as before, just with a different seed; the rejection's actual
  // content (e.g. "background is symmetric", "centered title text",
  // "procedural template") never reached the model, so regen kept producing
  // the same class of thumbnail that was rejected. The fix routes the
  // rejection_note through synthesize_bg_prompt + negative_prompt so the
  // model sees concrete avoidances on the next attempt.
  it('synthesize_bg_prompt accepts a rejection_note argument', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    expect(src).toMatch(/def synthesize_bg_prompt\([^)]*rejection_note/);
  });

  it('negative_prompt accepts a rejection_note argument', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    expect(src).toMatch(/def negative_prompt\([^)]*rejection_note/);
  });

  it('generate_thumbnail passes rejection_note into synthesize_bg_prompt and negative_prompt (not just seed)', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    expect(src).toMatch(/synthesize_bg_prompt\([^)]*rejection_note[^)]*\)/);
    expect(src).toMatch(/negative_prompt\([^)]*rejection_note[^)]*\)/);
  });

  it('parse_rejection_directives extracts at least the symmetric/centered/procedural avoidances', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    expect(src).toMatch(/def parse_rejection_directives/);
    expect(src).toMatch(/symmetr/);
    expect(src).toMatch(/centered/);
    expect(src).toMatch(/procedural/);
  });

  it('verifies output via the pixel-content gate before claiming success', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    expect(src).toMatch(/check-thumbnail-quality\.py/);
    expect(src).toMatch(/verify_thumbnail/);
    // Three retry attempts before giving up (autonomy guarantee).
    expect(src).toMatch(/MAX_ATTEMPTS\s*=\s*3/);
  });

  it('renders text with thick black stroke + drop shadow + top gradient', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    // Three signature compositor moves from the MrBeast / Veritasium pattern.
    expect(src).toMatch(/draw_text_with_stroke_and_shadow/);
    expect(src).toMatch(/apply_top_gradient/);
    expect(src).toMatch(/GaussianBlur/);
  });

  it('topic detection uses word boundaries on short keywords (regression: earn matched learned)', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    // The 2026-04-29 bug: the kids "Robot Who Learned to Dream" got matched
    // by the money rule because /earn/ matched inside "learned". The fix
    // is `\bearn` (word boundary). If anyone removes the word boundaries
    // the regression returns -- this test forbids that.
    expect(src).toMatch(/\\bearn/);
    expect(src).toMatch(/\\bva\\b/);
    expect(src).toMatch(/\\bai\\b/);
    // Kids rule must be FIRST in TOPIC_RULES so it wins ties with the
    // money/AI rules (a "Robot Dream" title should not get a money scene).
    const topicRulesBlock = src.match(/TOPIC_RULES\s*=\s*\[[\s\S]*?\n\]/);
    expect(topicRulesBlock).toBeTruthy();
    const firstRule = topicRulesBlock![0].split('(r"')[1] || '';
    expect(firstRule.toLowerCase()).toMatch(/kid|child|robot|elephant|whale|dragon/);
  });

  it('failed runs delete the bad output -- never leave a known-bad thumbnail on disk', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    // After all attempts fail, the orchestrator unlinks the output file.
    expect(src).toMatch(/out_path\.unlink/);
  });
});

describe('thumbnail-aurora -- wired into the regen loop', () => {
  it('auto-regen-rejected-videos.js calls thumbnail_aurora.py for thumbnails', () => {
    const src = fs.readFileSync(AUTO_REGEN, 'utf8');
    expect(src).toMatch(/thumbnail_aurora\.py/);
    expect(src).toMatch(/regenThumbnailLocally/);
    // The thumbnail step must run BEFORE the video step. Originally the
    // video step was an EC2 SSH call; 2026-04-29 evening it became a
    // local Pexels + ffmpeg path (regenVideoLocally). Either way, the
    // ordering is locked: thumbnail rejection regen runs first, then
    // the (separate) video regen. This decouples the fast cheap step
    // from the slow expensive one and ensures a thumbnail rejection
    // never has to wait on a video rebuild.
    const thumbCallIdx = src.indexOf('regenThumbnailLocally(v');
    const videoCallIdx = src.indexOf('regenVideoLocally(v');
    expect(thumbCallIdx).toBeGreaterThan(0);
    expect(videoCallIdx).toBeGreaterThan(0);
    expect(thumbCallIdx).toBeLessThan(videoCallIdx);
  });

  it('only triggers video regen when video_needs_regen is set (decoupled from thumbnail)', () => {
    const src = fs.readFileSync(AUTO_REGEN, 'utf8');
    // The video regen call must be inside an `if (v.video_needs_regen)`
    // block, not unconditional. A thumbnail-only rejection should never
    // trigger a (slow) video rebuild.
    expect(src).toMatch(/if\s*\(\s*v\.video_needs_regen\s*\)\s*\{[\s\S]*?regenVideoLocally/);
  });
});

describe('thumbnail-aurora -- skill + memory documentation', () => {
  it('scheduled-tasks/thumbnail-aurora/SKILL.md exists and has the contract', () => {
    expect(fs.existsSync(SKILL_MD)).toBe(true);
    const skill = fs.readFileSync(SKILL_MD, 'utf8');
    expect(skill).toMatch(/^---\r?\nname:\s*thumbnail-aurora\r?\n/);
    expect(skill).toMatch(/Bedrock Stable Image Ultra/i);
    expect(skill).toMatch(/check-thumbnail-quality\.py/);
    expect(skill).toMatch(/empire:rejectVideo/);
  });

  it('memory anchors the YouTube monetization goal as the project north star', () => {
    expect(fs.existsSync(MEMORY_PROJECT)).toBe(true);
    const mem = fs.readFileSync(MEMORY_PROJECT, 'utf8');
    expect(mem).toMatch(/canonical:\s*true/);
    expect(mem).toMatch(/YouTube/i);
    expect(mem).toMatch(/autonomous/i);
    expect(mem).toMatch(/2026-04-29/);
  });
});
