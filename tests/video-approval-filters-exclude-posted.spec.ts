/**
 * 2026-05-25 the owner #gap: posted videos kept resurfacing in the Video Approval
 * Queue. videoReadyForApproval and videoNeedsReviewOrRegen must hard-exclude
 * status='posted' so the queue only shows work with a decision left.
 *
 * The real functions are extracted from ec2-server.js and called; the gate
 * helpers they depend on are stubbed to "everything else is fine" so the only
 * thing that can exclude a video is its posted status.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadFunctions } = require('./helpers/extract-source-function.cjs');

const { videoReadyForApproval, videoNeedsReviewOrRegen } = loadFunctions(
  path.join(__dirname, '..', 'ec2-server.js'),
  ['videoNeedsReviewOrRegen', 'videoReadyForApproval'],
  {
    isTerminallyExcludedFromStuckScan: () => false,
    videoIsAbandonedNoArtifactStub: () => false,
    videoTextFitReleaseGate: () => ({ ok: true }),
    videoTextFitBlockSuperseded: () => false,
    videoHasUnresolvedRejectionFeedback: () => false,
    videoContentGateFailed: () => false,
  },
);

describe('video approval filters exclude posted', () => {
  it('a pending_approval video is ready for approval (control)', () => {
    expect(videoReadyForApproval({ status: 'pending_approval' })).toBe(true);
  });

  it('videoReadyForApproval rejects a posted video, even with a stale pending flag shape', () => {
    expect(videoReadyForApproval({ status: 'posted' })).toBe(false);
    expect(videoReadyForApproval({ status: 'posted', video_needs_regen: false })).toBe(false);
  });

  it('videoNeedsReviewOrRegen never lists a posted video as stuck, whatever stale regen flags it carries', () => {
    expect(videoNeedsReviewOrRegen({ status: 'posted' })).toBe(false);
    expect(
      videoNeedsReviewOrRegen({ status: 'posted', video_needs_regen: true, regen_status: 'failed', regen_hard_blocked: true }),
    ).toBe(false);
  });

  it('a non-posted video with the same stale flags is still stuck (control)', () => {
    expect(videoNeedsReviewOrRegen({ status: 'pending_approval', video_needs_regen: true })).toBe(true);
    expect(videoNeedsReviewOrRegen({ status: 'pending_approval', regen_status: 'failed' })).toBe(true);
  });
});
