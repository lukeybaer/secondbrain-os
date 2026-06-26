import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const mainSource = fs.readFileSync(path.join(REPO, 'src/main/studio.ts'), 'utf8');
const preloadSource = fs.readFileSync(path.join(REPO, 'src/preload/index.ts'), 'utf8');
const rendererSource = fs.readFileSync(path.join(REPO, 'src/renderer/src/pages/Studio.tsx'), 'utf8');

describe('E4-K4 camera health UI', () => {
  it('publishes per-source health changes from the main process', () => {
    expect(mainSource).toContain("webContents.send('studio:camera-health'");
    expect(mainSource).toContain("setCameraHealth(position, 'died')");
    expect(mainSource).toContain("setCameraHealth(cam.position, 'failed')");
    expect(mainSource).toContain("setCameraHealth(cam.position, 'recording')");
  });

  it('bridges camera-health events through preload into the renderer', () => {
    expect(preloadSource).toContain('onCameraHealth');
    expect(preloadSource).toContain("ipcRenderer.on('studio:camera-health'");
    expect(preloadSource).toContain('offCameraHealth');
  });

  it('renders warnings and live health statuses on the Studio page', () => {
    expect(rendererSource).toContain('onCameraHealth');
    expect(rendererSource).toContain('offCameraHealth');
    expect(rendererSource).toContain('setWarnings(result.warnings || null)');
    expect(rendererSource).toContain('{warnings &&');
    expect(rendererSource).toContain('S.healthDot');
    expect(rendererSource).toContain('statusLabel');
  });
});
