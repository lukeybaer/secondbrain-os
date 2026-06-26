import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatLabel, planCameraFormats } from '../studio-policy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const policySource = fs.readFileSync(path.join(REPO, 'src/main/studio-policy.ts'), 'utf8');

describe('E4-R4 NexiGo raw-default-first regression', () => {
  it('does not special-case NexiGo into MJPEG-first behavior', () => {
    const plans = planCameraFormats([{ name: 'NexiGo N60 FHD Webcam', position: 'front' }]);
    expect(plans[0].formats.map(formatLabel)[0]).toBe('default');
    expect(plans[0].formats.map(formatLabel)).toContain('mjpeg:1280x720');
  });

  it('documents the reason raw default stays first for cameras one and two', () => {
    expect(policySource).toContain('NexiGo raw YUV stable');
    expect(policySource).toContain('Cameras at index 0-1 keep today');
    expect(policySource).not.toContain('MJPEG_FIRST_CAMERAS');
  });
});
