/**
 * video-pipeline-liveness.test.ts
 *
 * Gap guard: verifies the video production pipeline is actually wired end-to-end.
 *
 * The regression it prevents:
 *   - empire:rejectVideo sets video_needs_regen = true but nothing on EC2 ever
 *     reads that flag. The TypeScript pipeline calls build_video.py which has no
 *     main() and exits 0, producing nothing. Everything "passes" but no video
 *     is ever built. (Gap discovered 2026-04-13 , pending review empty for weeks.)
 *
 * These tests verify the mechanical contracts that must hold for the pipeline
 * to actually produce videos. They are NOT integration tests (no network calls).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');
const PENDING_DIR = path.join(REPO_ROOT, 'content-review', 'pending');
const MANIFEST_PATH = path.join(PENDING_DIR, 'manifest.json');

// ── Queue + build scripts exist ───────────────────────────────────────────────

describe('video pipeline , required scripts exist', () => {
  it('ec2-build-from-queue.py exists', () => {
    expect(fs.existsSync(path.join(SCRIPTS_DIR, 'ec2-build-from-queue.py'))).toBe(true);
  });

  it('ec2-build-from-queue.py has if __name__ == __main__ entry point', () => {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'ec2-build-from-queue.py'), 'utf8');
    expect(src).toMatch(/if __name__ == ["']__main__["']:/);
  });

  it('daily-video-topic-gen.js exists', () => {
    expect(fs.existsSync(path.join(SCRIPTS_DIR, 'daily-video-topic-gen.js'))).toBe(true);
  });

  it('sync-videos-from-ec2.js exists', () => {
    expect(fs.existsSync(path.join(SCRIPTS_DIR, 'sync-videos-from-ec2.js'))).toBe(true);
  });

  it('ec2-build-queue.json exists and has at least one video', () => {
    const queuePath = path.join(SCRIPTS_DIR, 'ec2-build-queue.json');
    expect(fs.existsSync(queuePath)).toBe(true);
    const q = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    expect(Array.isArray(q.videos)).toBe(true);
    expect(q.videos.length).toBeGreaterThan(0);
  });
});

// ── build_video.py must have a main() entry point ────────────────────────────

describe('build_video.py , must be runnable, not just a library', () => {
  it('has argparse main entry point', () => {
    const localScript = path.join(REPO_ROOT, 'src', 'main', 'empire', 'build_video.py');
    if (!fs.existsSync(localScript)) return; // Only applies when local script exists
    const src = fs.readFileSync(localScript, 'utf8');
    expect(src).toMatch(/if __name__ == ["']__main__["']:/);
    expect(src).toContain('argparse');
  });
});

// ── ipc-handlers wires syncFromEC2 and regenRejected ─────────────────────────

describe('ipc-handlers.ts , video pipeline handlers registered', () => {
  const ipcPath = path.join(REPO_ROOT, 'src', 'main', 'ipc-handlers.ts');
  let src: string;

  beforeAll(() => {
    src = fs.readFileSync(ipcPath, 'utf8');
  });

  it('registers empire:regenRejected', () => {
    expect(src).toContain("'empire:regenRejected'");
  });

  it('registers empire:syncFromEC2', () => {
    expect(src).toContain("'empire:syncFromEC2'");
  });

  it('imports regenRejectedVideos from video-pipeline', () => {
    expect(src).toContain('regenRejectedVideos');
  });
});

// ── ContentPipeline has sync button ──────────────────────────────────────────

describe('ContentPipeline.tsx , sync UI exists', () => {
  const uiPath = path.join(REPO_ROOT, 'src', 'renderer', 'src', 'pages', 'ContentPipeline.tsx');
  let src: string;

  beforeAll(() => {
    src = fs.readFileSync(uiPath, 'utf8');
  });

  it('has handleSyncFromEC2 function', () => {
    expect(src).toContain('handleSyncFromEC2');
  });

  it('calls empire:syncFromEC2 IPC', () => {
    expect(src).toContain("'empire:syncFromEC2'");
  });

  it('has Sync EC2 button text', () => {
    expect(src).toContain('Sync EC2');
  });
});

// ── Manifest freshness ────────────────────────────────────────────────────────

describe('content-review manifest , freshness and structure', () => {
  let manifest: any;

  beforeAll(() => {
    if (!fs.existsSync(MANIFEST_PATH)) return;
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  });

  it('manifest.json exists', () => {
    expect(fs.existsSync(MANIFEST_PATH)).toBe(true);
  });

  it('has a videos array', () => {
    expect(Array.isArray(manifest?.videos)).toBe(true);
  });

  it('every video with status pending_approval has a video_file', () => {
    if (!manifest?.videos) return;
    const pending = manifest.videos.filter((v: any) => v.status === 'pending_approval');
    for (const v of pending) {
      expect(v.video_file).toBeTruthy();
    }
  });

  it('no video has both pending_approval status and video_needs_regen true', () => {
    if (!manifest?.videos) return;
    const contradictions = manifest.videos.filter(
      (v: any) => v.status === 'pending_approval' && v.video_needs_regen === true,
    );
    expect(contradictions).toHaveLength(0);
  });
});

// ── video-pipeline.ts exports the regen functions ────────────────────────────

describe('video-pipeline.ts , exports regen API', () => {
  const pipelinePath = path.join(REPO_ROOT, 'src', 'main', 'video-pipeline.ts');
  let src: string;

  beforeAll(() => {
    src = fs.readFileSync(pipelinePath, 'utf8');
  });

  it('exports buildRejectedVideo', () => {
    expect(src).toContain('export async function buildRejectedVideo');
  });

  it('exports regenRejectedVideos', () => {
    expect(src).toContain('export async function regenRejectedVideos');
  });

  it('passes REJECTION_NOTE env var to build script', () => {
    expect(src).toContain('REJECTION_NOTE');
  });
});
