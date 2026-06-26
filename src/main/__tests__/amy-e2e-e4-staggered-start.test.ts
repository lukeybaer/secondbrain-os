import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStagger } from '../studio-policy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const studioSource = fs.readFileSync(path.join(REPO, 'src/main/studio.ts'), 'utf8');

describe('E4-K1 staggered camera start', () => {
  it('computes sequential offsets and never schedules two cameras together', () => {
    expect(startStagger(0)).toBe(200);
    expect(startStagger(1)).toBe(700);
    expect(startStagger(2)).toBe(1200);
    expect(startStagger(3)).toBe(1700);
  });

  it('supports explicit timing knobs for future tuning', () => {
    expect(startStagger(0, { screenFirstMs: 100, perCameraMs: 250 })).toBe(100);
    expect(startStagger(2, { screenFirstMs: 100, perCameraMs: 250 })).toBe(600);
  });

  it('starts screen capture before the camera loop and awaits each stagger', () => {
    const screenIdx = studioSource.indexOf('Start screen recording FIRST');
    const cameraLoopIdx = studioSource.indexOf('for (let i = 0; i < cameras.length; i++)');
    expect(screenIdx).toBeGreaterThan(0);
    expect(cameraLoopIdx).toBeGreaterThan(screenIdx);
    expect(studioSource).toContain('const waitMs = startStagger(i)');
    expect(studioSource).toContain('if (waitMs > 0) await sleep(waitMs);');
  });
});
