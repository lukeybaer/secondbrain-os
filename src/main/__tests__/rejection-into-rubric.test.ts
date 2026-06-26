/**
 * rejection-into-rubric.test.ts
 *
 * Locks the 2026-04-30 rule: "rubric should always be updated to keep
 * up with my feedback." Whenever ExampleCo rejects a video, the
 * rejection->rubric audit classifies the feedback into a defect bucket,
 * checks whether existing rubric tools should have caught it, and
 * queues new analyzer creation when no existing tool catches the
 * failure mode.
 *
 * The test does NOT execute the script (it touches the filesystem); it
 * locks the source-code structure so the loop can't be silently
 * disconnected.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'process-rejection-into-rubric.js');
const IPC = path.join(REPO_ROOT, 'src', 'main', 'ipc-handlers.ts');

describe('rejection->rubric audit -- structure', () => {
  it('script exists', () => {
    expect(fs.existsSync(SCRIPT)).toBe(true);
  });

  it('classifies feedback into defect buckets keyed to existing rubric criteria', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/DEFECT_BUCKETS/);
    // The buckets that match our rubric tools must be present.
    for (const bucket of [
      'audio_edges',
      'volume_levels',
      'voice_clarity',
      'music_mix',
      'caption_readability',
      'pacing',
      'hook_strength',
      'thumbnail_appeal',
      'scene_variety',
      'lighting',
      'camera_stability',
    ]) {
      expect(src, `missing bucket ${bucket}`).toMatch(new RegExp(`criterion:\\s*'${bucket}'`));
    }
  });

  it('emits one of three findings per rejection: new_criterion_needed, tool_scored_high_but_ExampleCo_rejected, tool_scored_low_threshold_too_lax', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/new_criterion_needed/);
    expect(src).toMatch(/tool_scored_high_but_ExampleCo_rejected/);
    expect(src).toMatch(/tool_scored_low_threshold_too_lax/);
  });

  it('writes new-analyzer requests to data/agent/rubric-expansion-queue.jsonl', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/rubric-expansion-queue\.jsonl/);
    expect(src).toMatch(/proposed_analyzer/);
  });

  it('logs every analysis to data/agent/rubric-feedback-loop.jsonl for audit', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/rubric-feedback-loop\.jsonl/);
  });

  it('reads scores from manifest.rubric_scores so it can compare what the tool said vs what ExampleCo said', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/rubric_scores/);
    // The kind=tool_scored_high_but_ExampleCo_rejected branch only fires when
    // the tool scored >= 70 but ExampleCo still rejected -- a false-pass signal.
    expect(src).toMatch(/observedScore\s*>=\s*70/);
  });
});

describe('rejection->rubric audit -- wired into the rejection IPC handler', () => {
  it('empire:rejectVideo handler spawns process-rejection-into-rubric.js alongside auto-regen', () => {
    const src = fs.readFileSync(IPC, 'utf8');
    expect(src).toMatch(/process-rejection-into-rubric\.js/);
    // Detached + unref so the IPC handler returns instantly while the
    // audit runs in the background. Best-effort.
    const rejectionBlock = src.match(
      /empire:rejectVideo[\s\S]*?process-rejection-into-rubric\.js[\s\S]*?proc\.unref/,
    );
    expect(rejectionBlock).toBeTruthy();
  });
});
