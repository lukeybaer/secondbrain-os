/**
 * auto-regen-thumbnail-honesty.test.ts
 *
 * Gap guard for 2026-04-26 incident: Luke rejected 5 videos at 14:07 CT
 * with notes like "terrible thumbnail #gap". Auto-regen ran at 15:42 CT and
 * marked all 5 as `regen_completed_at` with `status: pending_approval` ---
 * but the thumbnail jpg files on disk were never actually rewritten. They had
 * the SAME mtime as before the rejection. The pipeline lied. Luke saw the
 * exact same bad thumbnails back in his queue 90 minutes later.
 *
 * Two contracts this test locks:
 *
 * 1. THUMBNAIL REJECTIONS MUST TRIGGER REGEN. The legacy
 *    `auto-regen-rejected-videos.js` only filtered by `video_needs_regen`,
 *    completely ignoring `thumbnail_needs_regen`. Any flagged video must be
 *    picked up regardless of which artifact was rejected.
 *
 * 2. REGEN MUST VERIFY ARTIFACT CHANGED. Before any code is allowed to set
 *    `regen_completed_at` and `status: pending_approval`, the artifact file's
 *    mtime must be strictly newer than the rejection timestamp. If the file
 *    didn't actually change, the regen failed --- mark it failed loud, do
 *    NOT cycle the video back into Luke's review queue.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const AUTO_REGEN_PATH = path.join(REPO_ROOT, 'scripts', 'auto-regen-rejected-videos.js');
const VIDEO_PIPELINE_PATH = path.join(REPO_ROOT, 'src', 'main', 'video-pipeline.ts');

describe('auto-regen honesty contract', () => {
  it('auto-regen-rejected-videos.js filter includes thumbnail_needs_regen', () => {
    const src = fs.readFileSync(AUTO_REGEN_PATH, 'utf8');
    // The candidate filter must accept BOTH video_needs_regen and
    // thumbnail_needs_regen. Original bug: filter only matched
    // video_needs_regen so thumbnail rejections sat in pending_approval
    // forever or got falsely re-queued.
    expect(src).toMatch(/thumbnail_needs_regen/);
    // The candidate-selection filter (the one that walks the manifest)
    // must reference both flags.
    const candidateFilter = src.match(
      /\.filter\(\s*\([^)]*\)\s*=>\s*[^)]*video_needs_regen[^)]*thumbnail_needs_regen[^)]*\)/,
    );
    expect(candidateFilter).toBeTruthy();
  });

  it('auto-regen-rejected-videos.js verifies artifact mtime before marking complete', () => {
    const src = fs.readFileSync(AUTO_REGEN_PATH, 'utf8');
    // Must call statSync on the artifact file and gate `regen_completed_at`
    // and `status: pending_approval` on the file actually being newer.
    expect(src).toMatch(/statSync|fs\.stat/);
    expect(src).toMatch(/mtime/i);
  });

  it('video-pipeline.ts regenRejectedVideos verifies artifact mtime before success', () => {
    const src = fs.readFileSync(VIDEO_PIPELINE_PATH, 'utf8');
    // The success branch in regenRejectedVideos must verify the produced
    // file is actually newer than the rejection timestamp before clearing
    // regen flags / setting status='pending_approval'.
    expect(src).toMatch(/regenRejectedVideos/);
    // The regen function must capture mtime before the build, check after,
    // and gate the success path on the artifact actually changing.
    expect(src).toMatch(/mtime guard/);
    expect(src).toMatch(/beforeMp4|beforeThumb/);
    expect(src).toMatch(/afterMp4|afterThumb/);
    // The buildRejectedVideo success branch must NOT unconditionally set
    // status='pending_approval' --- it must check the mtime guard first.
    const successBranchMatch = src.match(
      /if\s*\(\s*result\.success\s*\)\s*\{[\s\S]*?\n\s{4}\}\s*else\s*\{/,
    );
    expect(successBranchMatch).toBeTruthy();
    expect(successBranchMatch![0]).toMatch(/videoChanged|thumbChanged/);
  });
});

describe('manifest sanity', () => {
  const MANIFEST_PATH = path.join(REPO_ROOT, 'content-review', 'pending', 'manifest.json');

  it('no entry has status=pending_approval AND thumbnail_needs_regen=true (lying state)', () => {
    if (!fs.existsSync(MANIFEST_PATH)) return;
    const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const lying = (m.videos || []).filter(
      (v: any) =>
        v.status === 'pending_approval' &&
        (v.thumbnail_needs_regen === true || v.video_needs_regen === true),
    );
    expect(lying.map((v: any) => v.id)).toEqual([]);
  });
});
