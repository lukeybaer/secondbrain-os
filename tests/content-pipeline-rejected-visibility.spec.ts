/**
 * Regression guard: 2026-04-20 — rejected videos must remain visible in the UI
 * even after they transition to regen_queued (the regen/RSL loop status).
 *
 * On 2026-04-20 Luke asked "where did the rejected videos go?" — the UI showed
 * 0 in Pending Review, 3 in Upload Queue, 17 Published, nothing Rejected. The
 * 5 videos with rejection feedback were in status=regen_queued (or trashed),
 * and ContentPipeline.tsx's rejected filter only matched
 * video_rejected | thumbnail_rejected | rejected. The Rejected section
 * conditionally renders only when rejected.length > 0, so it disappeared
 * entirely. 5 rejection events in rejections.jsonl were invisible to Luke.
 *
 * This test locks the rejected filter to include regen_queued and trashed so
 * the section shows the backlog of feedback-in-flight videos.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const UI = path.join(__dirname, '..', 'src', 'renderer', 'src', 'pages', 'ContentPipeline.tsx');

describe('ContentPipeline.tsx rejected filter visibility (2026-04-20)', () => {
  const src = fs.readFileSync(UI, 'utf8');

  it('rejected filter includes regen_queued so in-flight regens stay visible', () => {
    // Find the rejected filter block — arrow function returns a boolean expression,
    // so it ends at the first ",\n  );" after the declaration.
    const m = src.match(/const\s+rejected\s*=\s*videos\.filter\([\s\S]*?\)\s*;/);
    expect(m, 'rejected filter block not found').toBeTruthy();
    const block = m![0];
    expect(block).toContain("'regen_queued'");
    expect(block).toContain("'trashed'");
    expect(block).toContain("'video_rejected'");
    expect(block).toContain("'thumbnail_rejected'");
    expect(block).toContain("'rejected'");
  });

  it('PendingVideo status union includes regen_queued (TS type matches runtime)', () => {
    // The status type union covers ContentPipeline.tsx's PendingVideo.
    expect(src).toMatch(/status:\s*\n?\s*\|\s*'pending_approval'[\s\S]{0,400}\|\s*'regen_queued'/);
  });
});
