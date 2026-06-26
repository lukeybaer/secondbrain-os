import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('auto regen rejection regressions', () => {
  it('preserves EC2 overlay metrics through the final content gate', () => {
    const src = read('scripts/auto-regen-rejected-videos.js');

    expect(src).toContain('playwright_overlay: playwrightReceipt');
    expect(src).toContain('numbered_overlay_events');
    expect(src).toContain('rubric_scores: rubricScores');
    expect(src).toContain('regen_video_content_metrics');
    expect(src).toContain('content_gate: videoQuality.metrics');
  });

  it('maps detected step overlays into the numbered_overlays rejection gate', () => {
    const src = read('scripts/auto-regen-rejected-videos.js');

    expect(src).toContain('const stepCardCount = Number(eventCounts.stepCard || 0);');
    expect(src).toContain(
      'const assNumberCount = (log.match(/\"type\":\\s*\"number\"/g) || []).length;',
    );
    expect(src).toContain('numbered_overlays: numberedOverlayScore');
  });

  it('does not leave failed video regens in pending approval state', () => {
    const src = read('scripts/auto-regen-rejected-videos.js');

    expect(src).toContain('for (let attempt = 1; attempt <= 3; attempt += 1)');
    expect(src).toContain('ec2 mp4 pull failed after 3 attempts');
    expect(src).toMatch(/if \(!auroraVideoResult\.ok\) \{[\s\S]*?v\.status = 'video_rejected'/);
  });

  it('only clears cached EC2 voice files when the rejection is about audio', () => {
    const src = read('scripts/auto-regen-rejected-videos.js');

    expect(src).toContain('function shouldRegenerateVoice');
    expect(src).toContain('if (shouldRegenerateVoice(v))');
    expect(src).toContain(
      "'voice.mp3', 'voice_human.mp3', 'voice_padded.mp3', 'voice_polished.mp3'",
    );
  });

  it('writes semantic fix summaries instead of generic animation counts', () => {
    const src = read('scripts/auto-regen-rejected-videos.js');

    expect(src).toContain('function describeFixFromRejection');
    expect(src).toContain("? 'word-aligned' : 'slowed'");
    expect(src).toContain('popup story cards');
    expect(src).toContain('word-aligned');
    expect(src).toContain('first card now names the stolen skill');
    expect(src).toContain('removed the accidental duplicate one-step overlay');
    expect(src).toContain('const existingIdx = (v.feedback_history || []).findIndex');
    // whitespace-tolerant: the assignment may be single- or multi-line formatted
    expect(src).toMatch(
      /v\.feedback_history\[existingIdx\]\s*=\s*\{\s*\.\.\.v\.feedback_history\[existingIdx\],\s*\.\.\.historyEntry,?\s*\}/,
    );
    expect(src).not.toContain('const cap = m.kinetic_events ? m.kinetic_events');
    expect(src).not.toContain('v.fix_summary = fixParts.length');
  });

  it('does not rerender Amy-review feedback until an agent explicitly forces regen', () => {
    const src = read('scripts/auto-regen-rejected-videos.js');

    expect(src).toContain("const force = args.includes('--force');");
    expect(src).toContain('amy_review_queued');
    expect(src).toContain('amy_review_in_progress');
    expect(src).toContain('node scripts/auto-regen-rejected-videos.js --force --id X');
    expect(src).toContain('amy_review_queued items wait for Claude/Amy review');
  });

  it('uses one latest rejection variable for rubric and legacy promotion paths', () => {
    const src = read('scripts/auto-regen-rejected-videos.js');

    expect(src).toContain(
      'const latestRejection = verifyRejectionTokens.latestRejectionFor(v.id);',
    );
    expect(src).toContain('verifyRejectionTokens.evaluate(v, latestRejection)');
    // whitespace-tolerant: the call may wrap its first arg onto a new line
    expect(src).toMatch(/describeFixFromRejection\(\s*latestRejection/);
    expect(src).not.toContain('if (rejection) v.previous_feedback');
  });

  it('clears stale regen errors when a rebuilt video is promoted for review', () => {
    const src = read('scripts/auto-regen-rejected-videos.js');

    expect(src).toContain('delete v.regen_error;');
    expect(src).toContain('delete v.regen_failed_at;');
    expect(src).toContain('delete v.regen_hard_blocked;');
    expect(src).toContain('delete v.regen_hard_block_reason;');
  });
});
