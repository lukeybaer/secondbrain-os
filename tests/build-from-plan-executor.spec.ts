/**
 * 2026-05-26 ExampleCo: scripts/build-from-plan.py is the DUMB executor.
 * It reads a build plan JSON and runs ElevenLabs/Pexels/ffmpeg/music
 * mix mechanically. It has NO opinions, NO fallback heuristics, NO
 * hardcoded MUSIC_MAP, NO JESSICA_ID default. Every craft decision
 * comes from the plan; missing required fields fail fast with
 * MISSING_PLAN_FIELD.
 *
 * Tests source-pin the absence of legacy hardcodes (so a future
 * "helpful" refactor cannot reintroduce them) and the presence of
 * the strict plan-field accessors.
 *
 * Plan ref: ~/.claude/plans/distributed-questing-wilkinson.md (Category 4)
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..');
const EXEC = path.join(REPO, 'scripts', 'build-from-plan.py');
const SRC = fs.readFileSync(EXEC, 'utf8');

describe('build-from-plan.py executor is dumb (no opinions, no fallbacks)', () => {
  it('exists and is a python file', () => {
    expect(fs.existsSync(EXEC)).toBe(true);
    expect(SRC).toMatch(/^#!\/usr\/bin\/env python3|^#!\s*python3|^import |^from /m);
  });

  it('contains no MUSIC_MAP hardcoded dict (music.track comes from plan)', () => {
    expect(SRC).not.toMatch(/MUSIC_MAP\s*=/);
    expect(SRC).not.toMatch(/MUSIC_BY_TOPIC\s*=/);
  });

  it('contains no JESSICA_ID = "..." hardcoded default (voice.id comes from plan)', () => {
    expect(SRC).not.toMatch(/JESSICA_ID\s*=\s*["']/);
    expect(SRC).not.toMatch(/POLLY_VOICE_ID\s*=\s*["']/);
  });

  it('contains no extract_list_items / pickIcon / sentenceToCard / conceptLabels heuristics', () => {
    expect(SRC).not.toMatch(/def extract_list_items\b/);
    expect(SRC).not.toMatch(/def pick_icon\b/);
    expect(SRC).not.toMatch(/def sentenceToCard\b/);
    expect(SRC).not.toMatch(/def concept_labels\b/);
  });

  it('contains no apply_regen_overrides (planner emits final spec values directly)', () => {
    expect(SRC).not.toMatch(/def apply_regen_overrides\b/);
  });

  it('every REQUIRED plan field is accessed via require_field(plan, "<name>") helper', () => {
    // The helper raises MISSING_PLAN_FIELD on absence. Tests pin that all
    // required fields use it.
    expect(SRC).toMatch(/def require_field\s*\(/);
    for (const f of ['plan_version', 'video_id', 'channel', 'voice', 'script',
                     'captions', 'stock_clips', 'music', 'animations',
                     'reflections_addressed', 'plan_confidence']) {
      expect(SRC, `require_field("${f}") must appear in executor`).toMatch(new RegExp(`require_field\\([^)]*["']${f}["']`));
    }
  });

  it('require_field raises MISSING_PLAN_FIELD with the field name', () => {
    expect(SRC).toMatch(/MISSING_PLAN_FIELD/);
  });

  it('exits non-zero (sys.exit(1) or raise) on missing required field', () => {
    expect(SRC).toMatch(/sys\.exit\(1\)|raise\b/);
  });

  it('voice.id flows verbatim into ElevenLabs text-to-speech URL (no override path)', () => {
    expect(SRC).toMatch(/text-to-speech\/\{voice_id\}|text-to-speech\/\{[^}]*voice[^}]*\}/);
    // No fallback ID: should never see a hex-like literal next to the URL.
    expect(SRC).not.toMatch(/text-to-speech\/[A-Za-z0-9]{20}/);
  });

  it('music.track is resolved relative to the music asset dir (empire/assets/sounds by default) and fails fast when missing', () => {
    // Default path is empire/assets/sounds/ (the canonical library). Env
    // override via SECONDBRAIN_MUSIC_DIR is allowed for tests.
    expect(SRC).toMatch(/empire[\\/]assets[\\/]sounds|empire\/assets\/sounds|SECONDBRAIN_MUSIC_DIR/);
    expect(SRC).toMatch(/MUSIC_TRACK_MISSING|MUSIC.*missing|music.*not.*found/i);
  });

  it('tags rendering is fully driven by plan["tags"]; absent or empty skips that layer', () => {
    // Look for: if plan.get("tags"): ... else: skip
    expect(SRC).toMatch(/plan\.get\(["']tags["']\)|"tags" in plan|plan\[["']tags["']\]/);
    expect(SRC).toMatch(/skip.*tag|no.*tag|tag.*skip/i);
  });

  it('stock fetching iterates plan["stock_clips"] and uses each entry\'s query', () => {
    expect(SRC).toMatch(/plan.*stock_clips|stock_clips.*plan/);
    expect(SRC).toMatch(/fetch_stock\(|pexels|Pexels/);
  });

  it('captions emphasis_color comes from plan["captions"]["emphasis_color"]', () => {
    expect(SRC).toMatch(/captions["'][^"']*["']emphasis_color["']|captions.*emphasis_color/);
  });

  it('animations.density flows from plan["animations"]["density"] (no default)', () => {
    expect(SRC).toMatch(/animations[\s\S]{0,80}density/);
  });

  it('does NOT import or call render_playwright_overlay (tag derivation moved to planner)', () => {
    expect(SRC).not.toMatch(/render_playwright_overlay/);
    expect(SRC).not.toMatch(/playwright_aurora_overlay/);
  });

  it('exit codes are documented (0 success, 1 missing field, 2 asset missing, 3 ffmpeg fail)', () => {
    // Loose contract: at least the exit codes are mentioned in the docstring.
    expect(SRC).toMatch(/exit\s+code|Exit codes|exit\(0\)|exit\(1\)/);
  });

  it('reads the plan file path from --plan CLI arg, not from a default location', () => {
    expect(SRC).toMatch(/--plan\b/);
    // The plan path is required; missing it fails fast.
    expect(SRC).toMatch(/MISSING_PLAN_ARG|--plan.*required|argparse/);
  });

  it('writes a build manifest receipt (used_plan_path, exit_status, asset paths)', () => {
    // The manifest receipt lets the orchestrator know what the executor did.
    expect(SRC).toMatch(/build.manifest|build_manifest|receipt|used_plan_path|plan_path/i);
  });
});
