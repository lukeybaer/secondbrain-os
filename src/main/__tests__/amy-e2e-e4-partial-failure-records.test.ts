import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const studioSource = fs.readFileSync(path.join(REPO, 'src/main/studio.ts'), 'utf8');

describe('E4-R2 partial failure still records', () => {
  it('collects failed camera names into warnings instead of aborting immediately', () => {
    expect(studioSource).toContain('const failedCameras: string[] = []');
    expect(studioSource).toContain('failedCameras.push(cam.name)');
    expect(studioSource).toContain('warnings = `${failedCameras.length} camera(s) failed');
    expect(studioSource).toContain('return { success: true, recordingId: id, warnings }');
  });

  it('only errors when every source fails to start', () => {
    const warningIdx = studioSource.indexOf('let warnings: string | undefined');
    const allFailedIdx = studioSource.indexOf('if (activeSessions.length === 0)');
    expect(warningIdx).toBeGreaterThan(0);
    expect(allFailedIdx).toBeGreaterThan(warningIdx);
    expect(studioSource).toContain('All sources failed to start');
  });
});
