/**
 * video-blank-dark-footage.test.ts
 *
 * FIX A (2026-07-13): scripts/check-video-content-not-blank.py mis-classified
 * legitimately DARK-but-textured storytelling B-roll as a "BLANK VIDEO". It
 * samples three body frames and runs each through the strict thumbnail gate; a
 * firefly-at-night frame (pct_near_black ~50-71%, mean_luminance ~31-44, but
 * luminance stddev ~42-46) fails the thumbnail bar, so all three samples were
 * counted blank and a perfectly good video was rejected. That false rejection
 * fed the destructive regen path (FIX C).
 *
 * The fix adds a stddev-based real-content override: a sampled BODY frame whose
 * luminance stddev clears STDDEV_REAL_CONTENT_MIN (~30) has real texture and is
 * NOT counted toward blank_count. A genuinely blank/black frame has stddev ~0
 * and is still counted. The thumbnail gate itself is unchanged (thumbnails
 * still must pass the strict bar).
 *
 * This test builds two synthetic mp4s with ffmpeg -- one dark-but-textured, one
 * flat black -- and asserts the dark-textured one now PASSES while the flat
 * black one still FAILS.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const VIDEO_GATE = path.join(REPO_ROOT, 'scripts', 'check-video-content-not-blank.py');
const THUMB_GATE = path.join(REPO_ROOT, 'scripts', 'check-thumbnail-quality.py');

function pythonBins(): string[] {
  return process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
}

function ffmpegAvailable(): boolean {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf-8' });
  return !(r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT');
}

function runGate(gate: string, artifact: string, timeoutMs = 90_000): any | null {
  for (const bin of pythonBins()) {
    const r = spawnSync(bin, [gate, artifact], { encoding: 'utf-8', timeout: timeoutMs });
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

// Grayscale P3 PPM writer (same shape as thumbnail-quality-gate.test.ts).
function writePpm(file: string, pixel: (x: number, y: number) => number) {
  const width = 180;
  const height = 320;
  const chunks = [`P3\n${width} ${height}\n255\n`];
  for (let y = 0; y < height; y++) {
    const row: string[] = [];
    for (let x = 0; x < width; x++) {
      const v = Math.max(0, Math.min(255, Math.round(pixel(x, y))));
      row.push(`${v} ${v} ${v}`);
    }
    chunks.push(row.join(' '), '\n');
  }
  fs.writeFileSync(file, chunks.join(''));
}

// Loop a still image into a lossless 12s mp4 (>7.5s so the gate can sample the
// body after the 2.5s thumbnail-card offset). Lossless + coarse blocks so the
// extracted-JPEG stddev survives compression.
function loopImageToMp4(image: string, out: string): boolean {
  const r = spawnSync(
    'ffmpeg',
    [
      '-y', '-v', 'error',
      '-loop', '1', '-i', image,
      '-t', '12', '-r', '30',
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264', '-qp', '0',
      out,
    ],
    { encoding: 'utf-8', timeout: 60_000 },
  );
  return r.status === 0 && fs.existsSync(out) && fs.statSync(out).size > 0;
}

describe('FIX A -- dark-but-textured footage is not a false-positive blank', () => {
  it('gate script exists', () => {
    expect(fs.existsSync(VIDEO_GATE)).toBe(true);
  });

  it('STDDEV_REAL_CONTENT_MIN override is present and near 30', () => {
    const src = fs.readFileSync(VIDEO_GATE, 'utf8');
    const m = src.match(/STDDEV_REAL_CONTENT_MIN\s*=\s*([\d.]+)/);
    expect(m).toBeTruthy();
    const v = parseFloat(m![1]);
    expect(v).toBeGreaterThanOrEqual(25);
    expect(v).toBeLessThanOrEqual(35);
    // The override must read stddev from the per-frame gate metrics, computed
    // the same way the file already samples frames.
    expect(src).toMatch(/stddev_luminance/);
    expect(src).toMatch(/frame_has_real_texture/);
  });

  it('thumbnail gate is NOT weakened -- it still rejects the dark frame', () => {
    if (!fs.existsSync(THUMB_GATE)) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixa-thumb-'));
    const img = path.join(dir, 'dark.ppm');
    // 65% near-black rows, 35% mid-gray rows -> fails thumbnail gate on
    // pct_near_black > 50%, but ExampleCos high luminance stddev.
    writePpm(img, (_x, y) => (y < 320 * 0.65 ? 0 : 120));
    const res = runGate(THUMB_GATE, img, 20_000);
    expect(res).not.toBeNull();
    expect(res.ok).toBe(false);
    expect(res.metrics.stddev_luminance).toBeGreaterThanOrEqual(30);
  });

  it('dark-textured video PASSES; flat-black video still FAILS', () => {
    if (!ffmpegAvailable()) return; // environment without ffmpeg: skip
    if (!fs.existsSync(VIDEO_GATE) || !fs.existsSync(THUMB_GATE)) return;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixa-video-'));

    const darkPpm = path.join(dir, 'dark.ppm');
    writePpm(darkPpm, (_x, y) => (y < 320 * 0.65 ? 0 : 120));
    const darkMp4 = path.join(dir, 'dark.mp4');
    const flatPpm = path.join(dir, 'flat.ppm');
    writePpm(flatPpm, () => 0);
    const flatMp4 = path.join(dir, 'flat.mp4');

    // If ffmpeg cannot encode here, don't assert (environment issue, not a
    // regression). When it can, the assertions below lock the fix.
    if (!loopImageToMp4(darkPpm, darkMp4) || !loopImageToMp4(flatPpm, flatMp4)) return;

    const darkResult = runGate(VIDEO_GATE, darkMp4);
    expect(darkResult).not.toBeNull();
    expect(darkResult.ok).toBe(true);
    expect(darkResult.metrics.samples_blank).toBe(0);
    // The override actually fired (frames failed the strict thumbnail bar but
    // were kept for real texture).
    const overrides = (darkResult.metrics.frames || []).filter(
      (f: any) => f.real_texture_override === true,
    );
    expect(overrides.length).toBeGreaterThan(0);

    const flatResult = runGate(VIDEO_GATE, flatMp4);
    expect(flatResult).not.toBeNull();
    expect(flatResult.ok).toBe(false);
    expect(flatResult.metrics.samples_blank).toBeGreaterThan(0);
    expect(flatResult.reason).toMatch(/BLANK VIDEO/);
  });
});
