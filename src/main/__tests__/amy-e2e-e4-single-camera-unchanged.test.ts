import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatLabel, planCameraFormats } from '../studio-policy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const studioSource = fs.readFileSync(path.join(REPO, 'src/main/studio.ts'), 'utf8');

describe('E4-R1 single camera unchanged', () => {
  it('keeps the single-camera default raw path before MJPEG fallbacks', () => {
    const plans = planCameraFormats([{ name: 'SoloCam', position: 'front' }]);
    expect(plans[0].formats.map(formatLabel)).toEqual([
      'default',
      'mjpeg:1280x720',
      'mjpeg:640x480',
    ]);
  });

  it('keeps the screen recording gdigrab and explicit audio-map path intact', () => {
    expect(studioSource).toContain("args.push('-f', 'gdigrab', '-framerate', '30', '-i', 'desktop')");
    expect(studioSource).toContain("args.push('-map', '0:v', '-map', '1:a')");
    expect(studioSource).toContain("args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000')");
  });
});
