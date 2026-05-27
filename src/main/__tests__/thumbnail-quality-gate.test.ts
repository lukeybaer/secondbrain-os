/**
 * thumbnail-quality-gate.test.ts
 *
 * Locks the 2026-04-29 fix for the FOURTH cycle of blank thumbnails reaching
 * Luke's review queue. Prior fix (2026-04-26) caught regen paths that lied
 * about producing a new file ("mtime guard"). New defect: regen DID write a
 * new thumbnail but the new thumbnail was 96% black-with-text -- Grok bg
 * generation failed silently on EC2 and the fallback rendered title text on
 * a black canvas. mtime moved, status went to pending_approval, Luke saw
 * the same blank thumbnail back in his queue.
 *
 * The gate (scripts/check-thumbnail-quality.py) does a pixel histogram check
 * (no model, no API). FAIL when:
 *   pct_near_black > 50%  OR  mean_luminance < 40
 *   OR (pct_bright < 4% AND mean_luminance < 60)
 *
 * Four contracts locked here:
 *
 * 1. The gate script itself exists and behaves correctly on fixtures.
 * 2. video-pipeline.ts::regenRejectedVideos calls the gate after the mtime
 *    guard and treats failure as a regen failure (no status promotion).
 * 3. scripts/auto-regen-rejected-videos.js + scripts/sync-videos-from-ec2.js
 *    call the gate before clearing thumbnail_needs_regen / promoting to
 *    pending_approval.
 * 4. Manifest sanity: no entry is in pending_approval while its thumbnail
 *    file fails the gate. (The lying-state check, extended from the 2026-04-26
 *    auto-regen-thumbnail-honesty manifest sanity test.)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const GATE = path.join(REPO_ROOT, 'scripts', 'check-thumbnail-quality.py');
const VIDEO_GATE = path.join(REPO_ROOT, 'scripts', 'check-video-content-not-blank.py');
const PIPELINE = path.join(REPO_ROOT, 'src', 'main', 'video-pipeline.ts');
const AUTO_REGEN = path.join(REPO_ROOT, 'scripts', 'auto-regen-rejected-videos.js');
const SYNC_FROM_EC2 = path.join(REPO_ROOT, 'scripts', 'sync-videos-from-ec2.js');
const QC_AGENT = path.join(REPO_ROOT, 'src', 'main', 'empire', 'qc_agent.py');
const MANIFEST = path.join(REPO_ROOT, 'content-review', 'pending', 'manifest.json');
const PENDING_DIR = path.dirname(MANIFEST);

function pythonBins(): string[] {
  return process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
}

function runGate(thumbPath: string): { ok: boolean; reason: string; metrics?: Record<string, number> } | null {
  if (!fs.existsSync(GATE)) return null;
  for (const bin of pythonBins()) {
    const r = spawnSync(bin, [GATE, thumbPath], { encoding: 'utf-8', timeout: 15_000 });
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') continue;
    if (r.status === null) continue;
    try {
      return JSON.parse((r.stdout || '').trim());
    } catch {
      return null;
    }
  }
  return null;
}

describe('thumbnail quality gate -- script behavior', () => {
  it('script exists at scripts/check-thumbnail-quality.py', () => {
    expect(fs.existsSync(GATE)).toBe(true);
  });

  it('approves a known-good Grok thumbnail (kids_tiny_elephant)', () => {
    const good = path.join(PENDING_DIR, 'kids_tiny_elephant_thumb.jpg');
    if (!fs.existsSync(good)) return;
    const result = runGate(good);
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
  });

  it('lr_mae threshold is preserved at 14 (procedural-template guard)', () => {
    // The 2026-04-29 evening fix added an lr_mirror_mae check to catch
    // procedural-template thumbnails (gold_money / navy_bold / etc. with
    // centered text on a symmetric background). The threshold is calibrated
    // at 14: all 4 procedural templates measured 8.4-11.9, all 3 known-good
    // thumbnails measured 18.9-33.4. If anyone weakens the threshold below
    // 14 the regression is back -- this test forbids that.
    const gateSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'check-thumbnail-quality.py'), 'utf8');
    const match = gateSrc.match(/LR_MIRROR_MAE_MIN\s*=\s*([\d.]+)/);
    expect(match).toBeTruthy();
    expect(parseFloat(match![1])).toBeGreaterThanOrEqual(14);
  });
});

describe('thumbnail quality gate -- code paths wire it in', () => {
  it('video-pipeline.ts wires checkThumbnailQuality after the mtime guard', () => {
    const src = fs.readFileSync(PIPELINE, 'utf8');
    expect(src).toMatch(/checkThumbnailQuality/);
    // The gate must run inside regenRejectedVideos AFTER the mtime guard
    // (failures.length > 0 branch), and a failure must NOT clear flags or
    // promote status. Loose check: the quality gate string and a `continue`
    // appear inside the success branch.
    const regenFn = src.match(/export async function regenRejectedVideos[\s\S]*?\n\}/);
    expect(regenFn).toBeTruthy();
    expect(regenFn![0]).toMatch(/quality gate|checkThumbnailQuality/i);
    expect(regenFn![0]).toMatch(/regen_status\s*=\s*['"]failed['"]/);
  });

  it('scripts/auto-regen-rejected-videos.js calls the quality gate', () => {
    const src = fs.readFileSync(AUTO_REGEN, 'utf8');
    expect(src).toMatch(/check-thumbnail-quality\.py|checkThumbnailQuality/);
    expect(src).toMatch(/quality gate/i);
  });

  it('scripts/sync-videos-from-ec2.js calls the quality gate before clearing thumbnail_needs_regen', () => {
    const src = fs.readFileSync(SYNC_FROM_EC2, 'utf8');
    expect(src).toMatch(/check-thumbnail-quality\.py|checkThumbnailQuality/);
    expect(src).toMatch(/quality gate/i);
  });

  it('video-pipeline.ts wires checkVideoContent for video stream + blank-frame defects', () => {
    const src = fs.readFileSync(PIPELINE, 'utf8');
    expect(src).toMatch(/checkVideoContent/);
    expect(src).toMatch(/check-video-content-not-blank\.py/);
    const regenFn = src.match(/export async function regenRejectedVideos[\s\S]*?\n\}/);
    expect(regenFn).toBeTruthy();
    expect(regenFn![0]).toMatch(/video content gate|checkVideoContent/i);
  });

  it('scripts/auto-regen-rejected-videos.js calls the video content gate', () => {
    const src = fs.readFileSync(AUTO_REGEN, 'utf8');
    expect(src).toMatch(/check-video-content-not-blank\.py|checkVideoContent/);
    expect(src).toMatch(/video content gate/i);
    expect(src).toContain("v.status = 'video_rejected'");
    expect(src).toContain('v.video_needs_regen = true');
  });

  it('video gate fails closed when the body is too short to sample', () => {
    const src = fs.readFileSync(VIDEO_GATE, 'utf8');
    expect(src).toContain('video body too short to sample');
    expect(src).toContain('BROKEN VIDEO STREAM');
    expect(src).not.toContain('"ok": True,\n            "reason": f"video body too short to sample');
  });

  it('scripts/sync-videos-from-ec2.js runs both gates on update + new-entry paths', () => {
    const src = fs.readFileSync(SYNC_FROM_EC2, 'utf8');
    expect(src).toMatch(/check-video-content-not-blank\.py|checkVideoContent/);
    // The new-entry creation path must call BOTH gates so blank videos
    // never enter the manifest as pending_approval.
    expect(src).toMatch(/checkVideoContent\(localMp4\)/);
    expect(src).toMatch(/checkThumbnailQuality\(localThumb\)/);
  });

  it('qc_agent.py thumbnail_not_black check delegates to the quality gate, not file size', () => {
    const src = fs.readFileSync(QC_AGENT, 'utf8');
    // The old broken check just looked at file size > 20KB. The new check
    // must invoke check-thumbnail-quality.py (or otherwise fail hard on
    // blank thumbnails).
    const blockMatch = src.match(/@check\("thumbnail_not_black"\)[\s\S]*?(?=@check|\Z)/);
    expect(blockMatch).toBeTruthy();
    expect(blockMatch![0]).toMatch(/check-thumbnail-quality\.py/);
    expect(blockMatch![0]).toMatch(/BLANK THUMBNAIL|blank thumbnail/i);
  });
});

describe('quality gates -- manifest sanity (the lying-state check)', () => {
  function runScript(scriptPath: string, artifactPath: string, timeoutMs: number) {
    for (const bin of pythonBins()) {
      const r = spawnSync(bin, [scriptPath, artifactPath], { encoding: 'utf-8', timeout: timeoutMs });
      if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if (r.status === null) continue;
      try {
        return JSON.parse((r.stdout || '').trim());
      } catch {
        return null;
      }
    }
    return null;
  }

  it('no manifest entry is in pending_approval while its thumbnail OR video fails the gate', { timeout: 180_000 }, () => {
    if (!fs.existsSync(MANIFEST)) return;
    if (!fs.existsSync(GATE) || !fs.existsSync(VIDEO_GATE)) return;
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const lying: { id: string; target: string; reason: string }[] = [];
    for (const v of manifest.videos || []) {
      if (v.status !== 'pending_approval') continue;
      const thumbName = v.thumbnail_file;
      if (thumbName) {
        const thumbPath = path.join(PENDING_DIR, thumbName);
        if (fs.existsSync(thumbPath)) {
          const result = runScript(GATE, thumbPath, 15_000);
          if (result && !result.ok) {
            lying.push({ id: v.id, target: 'thumbnail', reason: result.reason });
          }
        }
      }
      const videoName = v.video_file;
      if (videoName) {
        const videoPath = path.join(PENDING_DIR, videoName);
        if (fs.existsSync(videoPath)) {
          const result = runScript(VIDEO_GATE, videoPath, 90_000);
          if (result && !result.ok) {
            lying.push({ id: v.id, target: 'video', reason: result.reason });
          }
        }
      }
    }
    if (lying.length > 0) {
      const detail = lying
        .map((e) => `  - ${e.id} [${e.target}]: ${e.reason}`)
        .join('\n');
      throw new Error(
        `Found ${lying.length} lying-state entries in pending_approval:\n${detail}\n` +
          `These should be marked *_needs_regen and status=thumbnail_rejected/video_rejected.`,
      );
    }
    expect(lying).toEqual([]);
  });
});
