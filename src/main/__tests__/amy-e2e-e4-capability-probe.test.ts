import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatLabel, planCameraFormats } from '../studio-policy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const studioSource = fs.readFileSync(path.join(REPO, 'src/main/studio.ts'), 'utf8');

describe('E4-K3 camera capability probe', () => {
  it('drops formats marked unsupported by the per-camera probe', () => {
    const plans = planCameraFormats(
      [{ name: 'StrictCam', position: 'front' }],
      { StrictCam: { unsupported: ['default', 'mjpeg:1280x720'] } },
    );
    expect(plans[0].formats.map(formatLabel)).toEqual(['mjpeg:640x480']);
  });

  it('never lets a failed probe block recording or empty the plan', () => {
    const failedProbe = planCameraFormats(
      [{ name: 'BusyCam', position: 'front' }],
      { BusyCam: { probeFailed: true, unsupported: ['default', 'mjpeg:1280x720'] } },
    );
    expect(failedProbe[0].formats.map(formatLabel)).toEqual([
      'default',
      'mjpeg:1280x720',
      'mjpeg:640x480',
    ]);

    const emptyWouldBeUnsafe = planCameraFormats(
      [{ name: 'OddCam', position: 'front' }],
      { OddCam: { unsupported: ['default', 'mjpeg:1280x720', 'mjpeg:640x480'] } },
    );
    expect(emptyWouldBeUnsafe[0].formats.length).toBeGreaterThan(0);
  });

  it('runs cached probes before building the format plan', () => {
    const probeIdx = studioSource.indexOf('probeCameraCached(cam.name)');
    const planIdx = studioSource.indexOf('planCameraFormats(cameras, probeResults)');
    expect(probeIdx).toBeGreaterThan(0);
    expect(planIdx).toBeGreaterThan(probeIdx);
  });
});
