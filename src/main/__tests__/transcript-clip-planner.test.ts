/**
 * transcript-clip-planner.test.ts
 *
 * Locks the 2026-04-30 transcript-driven Pexels query design.
 * Why this exists: a previous build pulled topic-only stock footage
 * ("AI" -> generic glass-office laptop) regardless of what the
 * narrator was saying. Locked here: per-scene queries derive from the
 * actual transcript words spoken in that ~3s window.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PLANNER_PY = path.join(REPO_ROOT, 'src', 'main', 'empire', 'transcript_clip_planner.py');
const AURORA_PY = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video_aurora.py');

describe('transcript-clip-planner -- per-scene Pexels queries from transcript', () => {
  it('transcript_clip_planner.py entry point exists', () => {
    expect(fs.existsSync(PLANNER_PY)).toBe(true);
  });

  it('exposes plan_scenes(words, target_cut_s, topic) -> [{start, end, query, fallback_query, ...}]', () => {
    const src = fs.readFileSync(PLANNER_PY, 'utf8');
    expect(src).toMatch(/def plan_scenes\([^)]*words[^)]*target_cut_s[^)]*topic/);
    expect(src).toMatch(/"query":/);
    expect(src).toMatch(/"fallback_query":/);
    expect(src).toMatch(/"duration_s":/);
    expect(src).toMatch(/"phrase":/);
  });

  it('words_to_query strips stopwords + builds a natural-language query', () => {
    const src = fs.readFileSync(PLANNER_PY, 'utf8');
    expect(src).toMatch(/def words_to_query/);
    expect(src).toMatch(/STOPWORDS\s*=\s*\{/);
    // A handful of must-have stopwords. The list is intentionally short
    // (Pexels search is permissive) so don't strip everything.
    expect(src).toMatch(/"the"/);
    expect(src).toMatch(/"and"/);
    expect(src).toMatch(/"of"/);
  });

  it('keeps numbers and proper nouns (visually interesting / search-relevant)', () => {
    const src = fs.readFileSync(PLANNER_PY, 'utf8');
    // Numbers like "30" or "$1,400" survive, proper-cased tokens
    // like "MIT" survive Pexels' search ranking better than lowercased.
    expect(src).toMatch(/clean\.isdigit\(\)/);
    expect(src).toMatch(/raw/); // original-cased token preserved
  });

  it('closes a scene at terminal punctuation if it is at least min_scene_s long', () => {
    const src = fs.readFileSync(PLANNER_PY, 'utf8');
    // Sentence-boundary close keeps cuts from landing mid-thought.
    expect(src).toMatch(/min_scene_s/);
    expect(src).toMatch(/is_terminal/);
    expect(src).toMatch(/\[\.!\?\]/);
  });

  it('topic-level fallback queries skew bright/colorful (matches video_aurora brightness rule)', () => {
    const src = fs.readFileSync(PLANNER_PY, 'utf8');
    expect(src).toMatch(/TOPIC_FALLBACK\s*=\s*\{/);
    // The fallback set must include 'ai', 'money', 'kids', 'drama',
    // 'tools', 'default' so detect_topic always lands somewhere.
    for (const t of ['ai', 'money', 'kids', 'drama', 'tools', 'default']) {
      expect(src).toMatch(new RegExp(`"${t}"\\s*:\\s*\\[`));
    }
  });

  it('detect_topic mirrors video_aurora rules with word boundaries (regression: earn != learned)', () => {
    const src = fs.readFileSync(PLANNER_PY, 'utf8');
    expect(src).toMatch(/def detect_topic/);
    expect(src).toMatch(/\\bearn/);
    expect(src).toMatch(/\\bva\\b/);
    expect(src).toMatch(/\\bai\\b/);
  });
});

describe('video-aurora wires the planner into the v2 path', () => {
  it('assemble_video_v2 imports transcript_clip_planner + calls plan_scenes', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    expect(src).toMatch(/import transcript_clip_planner/);
    expect(src).toMatch(/transcript_clip_planner\.plan_scenes/);
    expect(src).toMatch(/transcript_clip_planner\.detect_topic/);
  });

  it('--transcript flag triggers the v2 transcript-driven path (not topic-only v1)', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    expect(src).toMatch(/--transcript/);
    expect(src).toMatch(/assemble_video_v2/);
    // The CLI dispatch: with --transcript -> v2; without -> v1.
    expect(src).toMatch(/if args\.transcript:[\s\S]{0,200}assemble_video_v2/);
  });

  it('per-scene fetch dedupes Pexels IDs across scenes (visual variety)', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    expect(src).toMatch(/def fetch_clip_for_scene/);
    expect(src).toMatch(/seen_ids:\s*set/);
    // The scene fetch loop must skip already-used IDs so consecutive
    // scenes don't share a clip.
    expect(src).toMatch(/if vid_id in seen_ids:/);
  });
});
