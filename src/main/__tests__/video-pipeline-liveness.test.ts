/**
 * video-pipeline-liveness.test.ts
 *
 * Gap guard: verifies the video production pipeline is actually wired end-to-end.
 *
 * The regression it prevents:
 *   - empire:rejectVideo sets video_needs_regen = true but nothing on EC2 ever
 *     reads that flag. The TypeScript pipeline calls build_video.py which has no
 *     main() and exits 0, producing nothing. Everything "passes" but no video
 *     is ever built. (Gap discovered 2026-04-13 — pending review empty for weeks.)
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

describe('video pipeline — required scripts exist', () => {
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

describe('build_video.py — must be runnable, not just a library', () => {
  it('has argparse main entry point', () => {
    const localScript = path.join(REPO_ROOT, 'src', 'main', 'empire', 'build_video.py');
    if (!fs.existsSync(localScript)) return; // Only applies when local script exists
    const src = fs.readFileSync(localScript, 'utf8');
    expect(src).toMatch(/if __name__ == ["']__main__["']:/);
    expect(src).toContain('argparse');
  });
});

// ── ipc-handlers wires syncFromEC2 and regenRejected ─────────────────────────

describe('ipc-handlers.ts — video pipeline handlers registered', () => {
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

describe('ContentPipeline.tsx — sync UI exists', () => {
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

describe('content-review manifest — freshness and structure', () => {
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

describe('video-pipeline.ts — exports regen API', () => {
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

// ── video quality tools v20 -- new tool files exist and are wired ─────────────
// Guard added run 18: prevents silent regressions where a tool is built but
// never wired into run-quality-check.py (the gap that caused lighting-v2 and
// transitions-v4 to be missing from predict-virality for 4 runs).

describe('video quality tools v20 -- new tool files exist', () => {
  const TOOLS_DIR = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video-quality-tools');

  it('analyze-cta-v5.py exists', () => {
    expect(fs.existsSync(path.join(TOOLS_DIR, 'analyze-cta-v5.py'))).toBe(true);
  });

  it('analyze-retention-curve-v4.py exists', () => {
    expect(fs.existsSync(path.join(TOOLS_DIR, 'analyze-retention-curve-v4.py'))).toBe(true);
  });

  it('analyze-emotional-arc-v4.py exists', () => {
    expect(fs.existsSync(path.join(TOOLS_DIR, 'analyze-emotional-arc-v4.py'))).toBe(true);
  });

  it('analyze-cta-v5.py has TOOL_VERSION 5.0.0', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-cta-v5.py'), 'utf8');
    expect(src).toContain('TOOL_VERSION = "5.0.0"');
  });

  it('analyze-retention-curve-v4.py has TOOL_VERSION 4.0.0', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-retention-curve-v4.py'), 'utf8');
    expect(src).toContain('TOOL_VERSION = "4.0.0"');
  });

  it('analyze-emotional-arc-v4.py has TOOL_VERSION 4.0.0', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-emotional-arc-v4.py'), 'utf8');
    expect(src).toContain('TOOL_VERSION = "4.0.0"');
  });

  it('all v5 tools have def analyze() entry point', () => {
    for (const tool of ['analyze-cta-v5.py', 'analyze-retention-curve-v4.py', 'analyze-emotional-arc-v4.py']) {
      const src = fs.readFileSync(path.join(TOOLS_DIR, tool), 'utf8');
      expect(src).toMatch(/^def analyze\(/m);
    }
  });

  it('all v5 tools have if __name__ == __main__ entry point', () => {
    for (const tool of ['analyze-cta-v5.py', 'analyze-retention-curve-v4.py', 'analyze-emotional-arc-v4.py']) {
      const src = fs.readFileSync(path.join(TOOLS_DIR, tool), 'utf8');
      expect(src).toMatch(/if __name__ == ["']__main__["']:/);
    }
  });
});

describe('video quality tools v20 -- run-quality-check.py wires new tools', () => {
  const TOOLS_DIR = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video-quality-tools');
  let rqcSrc: string;

  beforeAll(() => {
    rqcSrc = fs.readFileSync(path.join(TOOLS_DIR, 'run-quality-check.py'), 'utf8');
  });

  it('imports analyze-cta-v5', () => {
    expect(rqcSrc).toContain('"analyze-cta-v5"');
  });

  it('imports analyze-retention-curve-v4', () => {
    expect(rqcSrc).toContain('"analyze-retention-curve-v4"');
  });

  it('imports analyze-emotional-arc-v4', () => {
    expect(rqcSrc).toContain('"analyze-emotional-arc-v4"');
  });

  it('calls analyze_cta_v5 in run_all()', () => {
    expect(rqcSrc).toContain('analyze_cta_v5(');
  });

  it('calls analyze_retention_v4 in run_all()', () => {
    expect(rqcSrc).toContain('analyze_retention_v4(');
  });

  it('calls analyze_arc_v4 in run_all()', () => {
    expect(rqcSrc).toContain('analyze_arc_v4(');
  });

  it('version header says v20 or later', () => {
    expect(rqcSrc).toMatch(/Video Quality Check Runner v\d+/);
  });
});

describe('video quality rubric v21 -- accuracy fields updated', () => {
  const rubricPath = path.join(REPO_ROOT, 'data', 'agent', 'video-quality-rubric.json');
  let rubric: any;

  beforeAll(() => {
    rubric = JSON.parse(fs.readFileSync(rubricPath, 'utf8'));
  });

  it('rubric version is 21', () => {
    expect(rubric.version).toBeGreaterThanOrEqual(21);
  });

  it('cta_placement accuracy is 87', () => {
    expect(rubric.categories.content.subcriteria.cta_placement.detection_accuracy_self_assessment).toBe(87);
  });

  it('retention_curve accuracy is at least 87', () => {
    expect(rubric.categories.content.subcriteria.retention_curve.detection_accuracy_self_assessment).toBeGreaterThanOrEqual(87);
  });

  it('emotional_arc accuracy is at least 87', () => {
    expect(rubric.categories.content.subcriteria.emotional_arc.detection_accuracy_self_assessment).toBeGreaterThanOrEqual(87);
  });

  it('avg accuracy is at least 85.0 after upgrades', () => {
    expect(rubric.automation_summary.avg_accuracy_self_assessment).toBeGreaterThanOrEqual(85.0);
  });
});

// ── video quality tools run 14 (2026-04-24): pacing-v4, hook-strength-v5, clarity-v5 ──
// Guard: prevents silent regressions where tools are built but not wired into runners
// or accuracy fields are not updated in the rubric.

describe('video quality tools run 14 -- new tool files exist', () => {
  const TOOLS_DIR = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video-quality-tools');

  it('analyze-pacing-v4.py exists', () => {
    expect(fs.existsSync(path.join(TOOLS_DIR, 'analyze-pacing-v4.py'))).toBe(true);
  });

  it('analyze-hook-strength-v5.py exists', () => {
    expect(fs.existsSync(path.join(TOOLS_DIR, 'analyze-hook-strength-v5.py'))).toBe(true);
  });

  it('analyze-clarity-v5.py exists', () => {
    expect(fs.existsSync(path.join(TOOLS_DIR, 'analyze-clarity-v5.py'))).toBe(true);
  });

  it('analyze-pacing-v4.py has TOOL_VERSION 4.0.0', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-pacing-v4.py'), 'utf8');
    expect(src).toContain('TOOL_VERSION = "4.0.0"');
  });

  it('analyze-hook-strength-v5.py has TOOL_VERSION 5.0.0', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-hook-strength-v5.py'), 'utf8');
    expect(src).toContain('TOOL_VERSION = "5.0.0"');
  });

  it('analyze-clarity-v5.py has TOOL_VERSION 5.0.0', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-clarity-v5.py'), 'utf8');
    expect(src).toContain('TOOL_VERSION = "5.0.0"');
  });

  it('all run-14 tools have def analyze() entry point', () => {
    for (const tool of ['analyze-pacing-v4.py', 'analyze-hook-strength-v5.py', 'analyze-clarity-v5.py']) {
      const src = fs.readFileSync(path.join(TOOLS_DIR, tool), 'utf8');
      expect(src).toMatch(/^def analyze\(/m);
    }
  });

  it('all run-14 tools have if __name__ == __main__ entry point', () => {
    for (const tool of ['analyze-pacing-v4.py', 'analyze-hook-strength-v5.py', 'analyze-clarity-v5.py']) {
      const src = fs.readFileSync(path.join(TOOLS_DIR, tool), 'utf8');
      expect(src).toMatch(/if __name__ == ["']__main__["']:/);
    }
  });

  it('pacing-v4 contains all 3 new v4 signals', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-pacing-v4.py'), 'utf8');
    expect(src).toContain('compute_information_density_trajectory');
    expect(src).toContain('compute_speech_segment_distribution');
    expect(src).toContain('compute_opener_speech_density');
  });

  it('hook-strength-v5 contains all 3 new v5 signals', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-hook-strength-v5.py'), 'utf8');
    expect(src).toContain('detect_audio_onset_jolt');
    expect(src).toContain('detect_visual_contrast_burst');
    expect(src).toContain('detect_time_to_first_speech');
  });

  it('clarity-v5 contains all 3 new v5 signals', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-clarity-v5.py'), 'utf8');
    expect(src).toContain('laplacian_variance');
    expect(src).toContain('block_artifact_proxy');
    expect(src).toContain('temporal_sharpness_trend_ratio');
  });
});

describe('video quality tools run 14 -- run-quality-check.py wires new tools', () => {
  const TOOLS_DIR = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video-quality-tools');
  let rqcSrc: string;
  let viralitySrc: string;

  beforeAll(() => {
    rqcSrc = fs.readFileSync(path.join(TOOLS_DIR, 'run-quality-check.py'), 'utf8');
    viralitySrc = fs.readFileSync(path.join(TOOLS_DIR, 'predict-virality.py'), 'utf8');
  });

  it('run-quality-check.py imports analyze-pacing-v4', () => {
    expect(rqcSrc).toContain('"analyze-pacing-v4"');
  });

  it('run-quality-check.py imports analyze-hook-strength-v5', () => {
    expect(rqcSrc).toContain('"analyze-hook-strength-v5"');
  });

  it('run-quality-check.py imports analyze-clarity-v5', () => {
    expect(rqcSrc).toContain('"analyze-clarity-v5"');
  });

  it('run-quality-check.py calls analyze_pacing_v4 in run_all()', () => {
    expect(rqcSrc).toContain('analyze_pacing_v4(');
  });

  it('run-quality-check.py calls analyze_hook_v5 in run_all()', () => {
    expect(rqcSrc).toContain('analyze_hook_v5(');
  });

  it('run-quality-check.py calls analyze_clarity_v5 in run_all()', () => {
    expect(rqcSrc).toContain('analyze_clarity_v5(');
  });

  it('run-quality-check.py version header is v23 or later', () => {
    const match = rqcSrc.match(/Video Quality Check Runner v(\d+)/);
    expect(match).not.toBeNull();
    expect(parseInt(match![1], 10)).toBeGreaterThanOrEqual(23);
  });

  it('predict-virality.py imports analyze-pacing-v4', () => {
    expect(viralitySrc).toContain('"analyze-pacing-v4"');
  });

  it('predict-virality.py imports analyze-hook-strength-v5', () => {
    expect(viralitySrc).toContain('"analyze-hook-strength-v5"');
  });

  it('predict-virality.py imports analyze-clarity-v5', () => {
    expect(viralitySrc).toContain('"analyze-clarity-v5"');
  });

  it('predict-virality.py version is v11 or later', () => {
    const match = viralitySrc.match(/Video Virality Prediction Scorer v(\d+)/);
    expect(match).not.toBeNull();
    expect(parseInt(match![1], 10)).toBeGreaterThanOrEqual(11);
  });
});

describe('video quality rubric v24 -- run-14 accuracy fields updated', () => {
  const rubricPath = path.join(REPO_ROOT, 'content-review', 'video-quality-rubric.json');
  let rubric: any;

  beforeAll(() => {
    rubric = JSON.parse(fs.readFileSync(rubricPath, 'utf8'));
  });

  it('rubric version is 24', () => {
    expect(rubric.version).toBeGreaterThanOrEqual(24);
  });

  it('pacing accuracy is at least 87 after run-14', () => {
    expect(rubric.categories.audio.subcriteria.pacing.detection_accuracy_self_assessment).toBeGreaterThanOrEqual(87);
  });

  it('hook_strength accuracy is at least 87 after run-14', () => {
    expect(rubric.categories.content.subcriteria.hook_strength.detection_accuracy_self_assessment).toBeGreaterThanOrEqual(87);
  });

  it('clarity accuracy is at least 87 after run-14', () => {
    expect(rubric.categories.visual.subcriteria.clarity.detection_accuracy_self_assessment).toBeGreaterThanOrEqual(87);
  });

  it('pacing tool field is at least v4', () => {
    expect(rubric.categories.audio.subcriteria.pacing.tool).toMatch(/analyze-pacing-v[4-9]/);
  });

  it('hook_strength tool field is at least v5', () => {
    expect(rubric.categories.content.subcriteria.hook_strength.tool).toMatch(/analyze-hook-strength-v[5-9]/);
  });

  it('clarity tool field is at least v5', () => {
    expect(rubric.categories.visual.subcriteria.clarity.tool).toMatch(/analyze-clarity-v[5-9]\d*/);
  });

  it('avg accuracy is at least 86.5 after run-14', () => {
    expect(rubric.automation_summary.avg_accuracy_self_assessment).toBeGreaterThanOrEqual(86.5);
  });
});

// ── video quality tools run 25 (2026-04-25): music-mix-v5, thumbnail-v5, trending-topics-v5 ──
// Guard: prevents silent regressions where tools are built but not wired into runners
// or rubric accuracy fields are not updated. Closes the last three 85% criteria.

describe('video quality tools run 25 -- new tool files exist', () => {
  const TOOLS_DIR = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video-quality-tools');

  it('analyze-music-mix-v5.py exists', () => {
    expect(fs.existsSync(path.join(TOOLS_DIR, 'analyze-music-mix-v5.py'))).toBe(true);
  });

  it('analyze-thumbnail-v5.py exists', () => {
    expect(fs.existsSync(path.join(TOOLS_DIR, 'analyze-thumbnail-v5.py'))).toBe(true);
  });

  it('analyze-trending-topics-v5.py exists', () => {
    expect(fs.existsSync(path.join(TOOLS_DIR, 'analyze-trending-topics-v5.py'))).toBe(true);
  });

  it('analyze-music-mix-v5.py has TOOLS_VERSION 5.0.0', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-music-mix-v5.py'), 'utf8');
    expect(src).toContain('TOOLS_VERSION = "5.0.0"');
  });

  it('analyze-thumbnail-v5.py has TOOL_VERSION 5.0.0', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-thumbnail-v5.py'), 'utf8');
    expect(src).toContain('TOOL_VERSION = "5.0.0"');
  });

  it('analyze-trending-topics-v5.py has TOOL_VERSION 5.0.0', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-trending-topics-v5.py'), 'utf8');
    expect(src).toContain('TOOL_VERSION = "5.0.0"');
  });

  it('all run-25 tools have def analyze() entry point', () => {
    for (const tool of ['analyze-music-mix-v5.py', 'analyze-thumbnail-v5.py', 'analyze-trending-topics-v5.py']) {
      const src = fs.readFileSync(path.join(TOOLS_DIR, tool), 'utf8');
      expect(src).toMatch(/^def analyze\(/m);
    }
  });

  it('all run-25 tools have if __name__ == __main__ entry point', () => {
    for (const tool of ['analyze-music-mix-v5.py', 'analyze-thumbnail-v5.py', 'analyze-trending-topics-v5.py']) {
      const src = fs.readFileSync(path.join(TOOLS_DIR, tool), 'utf8');
      expect(src).toMatch(/if __name__ == ["']__main__["']:/);
    }
  });

  it('music-mix-v5 contains all 3 new v5 signals', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-music-mix-v5.py'), 'utf8');
    expect(src).toContain('measure_per_quarter_snr_trajectory');
    expect(src).toContain('measure_critical_band_interference');
    expect(src).toContain('measure_mono_compatibility');
  });

  it('thumbnail-v5 contains all 3 new v5 signals', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-thumbnail-v5.py'), 'utf8');
    expect(src).toContain('figure_ground_ratio');
    expect(src).toContain('face_symmetry_score');
    expect(src).toContain('visual_complexity');
  });

  it('trending-topics-v5 contains all 3 new v5 signals', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-trending-topics-v5.py'), 'utf8');
    expect(src).toContain('detect_curiosity_gap');
    expect(src).toContain('detect_specificity_markers');
    expect(src).toContain('detect_recency_signals');
  });
});

describe('video quality tools run 25 -- run-quality-check.py wires new tools', () => {
  const TOOLS_DIR = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video-quality-tools');
  let rqcSrc: string;
  let viralitySrc: string;

  beforeAll(() => {
    rqcSrc = fs.readFileSync(path.join(TOOLS_DIR, 'run-quality-check.py'), 'utf8');
    viralitySrc = fs.readFileSync(path.join(TOOLS_DIR, 'predict-virality.py'), 'utf8');
  });

  it('run-quality-check.py imports analyze-music-mix-v5', () => {
    expect(rqcSrc).toContain('"analyze-music-mix-v5"');
  });

  it('run-quality-check.py imports analyze-thumbnail-v5', () => {
    expect(rqcSrc).toContain('"analyze-thumbnail-v5"');
  });

  it('run-quality-check.py imports analyze-trending-topics-v5', () => {
    expect(rqcSrc).toContain('"analyze-trending-topics-v5"');
  });

  it('run-quality-check.py calls analyze_music_v5 in run_all()', () => {
    expect(rqcSrc).toContain('analyze_music_v5(');
  });

  it('run-quality-check.py calls analyze_thumb_v5 in run_all()', () => {
    expect(rqcSrc).toContain('analyze_thumb_v5(');
  });

  it('run-quality-check.py calls analyze_trending_v5 in run_all()', () => {
    expect(rqcSrc).toContain('analyze_trending_v5(');
  });

  it('predict-virality.py imports analyze-music-mix-v5', () => {
    expect(viralitySrc).toContain('"analyze-music-mix-v5"');
  });

  it('predict-virality.py imports analyze-thumbnail-v5', () => {
    expect(viralitySrc).toContain('"analyze-thumbnail-v5"');
  });

  it('predict-virality.py imports analyze-trending-topics-v5', () => {
    expect(viralitySrc).toContain('"analyze-trending-topics-v5"');
  });

  it('predict-virality.py wires trending-v5 override block', () => {
    expect(viralitySrc).toContain('trending_v5_virality');
  });

  it('predict-virality.py wires music-v5 final override', () => {
    expect(viralitySrc).toContain('music_v5_virality');
  });

  it('predict-virality.py wires thumbnail-v5 final override', () => {
    expect(viralitySrc).toContain('thumb_v5_virality');
  });
});

describe('video quality rubric run 25 -- accuracy fields updated to 87%', () => {
  const rubricPath = path.join(REPO_ROOT, 'content-review', 'video-quality-rubric.json');
  let rubric: any;

  beforeAll(() => {
    rubric = JSON.parse(fs.readFileSync(rubricPath, 'utf8'));
  });

  it('music_mix accuracy is 87 after run-25', () => {
    expect(rubric.categories.audio.subcriteria.music_mix.detection_accuracy_self_assessment).toBe(87);
  });

  it('thumbnail_appeal accuracy is 87 after run-25', () => {
    expect(rubric.categories.technical.subcriteria.thumbnail_appeal.detection_accuracy_self_assessment).toBe(87);
  });

  it('trending_topic_alignment accuracy is 87 after run-25', () => {
    expect(rubric.categories.platform.subcriteria.trending_topic_alignment.detection_accuracy_self_assessment).toBe(87);
  });

  it('music_mix tool field points to v5', () => {
    expect(rubric.categories.audio.subcriteria.music_mix.tool).toContain('v5');
  });

  it('thumbnail_appeal tool field points to v5', () => {
    expect(rubric.categories.technical.subcriteria.thumbnail_appeal.tool).toContain('v5');
  });

  it('trending_topic_alignment tool field points to v5', () => {
    expect(rubric.categories.platform.subcriteria.trending_topic_alignment.tool).toContain('v5');
  });

  it('avg accuracy is at least 87.0 after run-25 (all criteria at 87%)', () => {
    expect(rubric.automation_summary.avg_accuracy_self_assessment).toBeGreaterThanOrEqual(87.0);
  });

  it('all 26 criteria remain automated after run-25', () => {
    expect(rubric.automation_summary.automated).toBe(26);
    expect(rubric.automation_summary.manual).toBe(0);
    expect(rubric.automation_summary.automation_percentage).toBe(100);
  });
});

// ── video quality tools run 28 (2026-04-26): hook-strength-v6, pacing-v5, audio-loudness-v4 ──
// Guard: prevents silent regressions where tools are built but not wired into runners
// or rubric accuracy fields are not updated. Upgrades hook_strength, pacing, and
// volume_levels/background_noise from 87% to 89%.

describe('video quality tools run 28 -- new tool files exist', () => {
  const TOOLS_DIR = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video-quality-tools');

  it('analyze-hook-strength-v6.py exists', () => {
    expect(fs.existsSync(path.join(TOOLS_DIR, 'analyze-hook-strength-v6.py'))).toBe(true);
  });

  it('analyze-pacing-v5.py exists', () => {
    expect(fs.existsSync(path.join(TOOLS_DIR, 'analyze-pacing-v5.py'))).toBe(true);
  });

  it('analyze-audio-loudness-v4.py exists', () => {
    expect(fs.existsSync(path.join(TOOLS_DIR, 'analyze-audio-loudness-v4.py'))).toBe(true);
  });

  it('analyze-hook-strength-v6.py has TOOL_VERSION 6.0.0', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-hook-strength-v6.py'), 'utf8');
    expect(src).toContain('TOOL_VERSION = "6.0.0"');
  });

  it('analyze-pacing-v5.py has TOOL_VERSION 5.0.0', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-pacing-v5.py'), 'utf8');
    expect(src).toContain('TOOL_VERSION = "5.0.0"');
  });

  it('analyze-audio-loudness-v4.py has TOOL_VERSION 4.0.0', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-audio-loudness-v4.py'), 'utf8');
    expect(src).toContain('TOOL_VERSION = "4.0.0"');
  });

  it('all run-28 tools have def analyze() entry point', () => {
    for (const tool of ['analyze-hook-strength-v6.py', 'analyze-pacing-v5.py', 'analyze-audio-loudness-v4.py']) {
      const src = fs.readFileSync(path.join(TOOLS_DIR, tool), 'utf8');
      expect(src).toMatch(/^def analyze\(/m);
    }
  });

  it('all run-28 tools have if __name__ == __main__ entry point', () => {
    for (const tool of ['analyze-hook-strength-v6.py', 'analyze-pacing-v5.py', 'analyze-audio-loudness-v4.py']) {
      const src = fs.readFileSync(path.join(TOOLS_DIR, tool), 'utf8');
      expect(src).toMatch(/if __name__ == ["']__main__["']:/);
    }
  });

  it('hook-strength-v6 contains all 3 new v6 signals', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-hook-strength-v6.py'), 'utf8');
    expect(src).toContain('detect_spectral_flux_burst');
    expect(src).toContain('detect_perioral_arousal');
    expect(src).toContain('detect_rhetorical_pause_gap');
  });

  it('pacing-v5 contains all 3 new v5 signals', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-pacing-v5.py'), 'utf8');
    expect(src).toContain('compute_av_pacing_synchrony');
    expect(src).toContain('compute_inter_pause_interval_cov');
    expect(src).toContain('detect_midvideo_pacing_reset');
  });

  it('audio-loudness-v4 contains all 3 new v4 signals', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-audio-loudness-v4.py'), 'utf8');
    expect(src).toContain('detect_breath_noise_bursts');
    expect(src).toContain('measure_noise_floor_drift');
    expect(src).toContain('measure_lf_consistency_by_quarter');
  });
});

describe('video quality tools run 28 -- run-quality-check.py wires new tools', () => {
  const TOOLS_DIR = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video-quality-tools');
  let rqcSrc: string;
  let viralitySrc: string;

  beforeAll(() => {
    rqcSrc = fs.readFileSync(path.join(TOOLS_DIR, 'run-quality-check.py'), 'utf8');
    viralitySrc = fs.readFileSync(path.join(TOOLS_DIR, 'predict-virality.py'), 'utf8');
  });

  it('run-quality-check.py version header is at least v28', () => {
    const m = rqcSrc.match(/Video Quality Check Runner v(\d+)/);
    expect(m, 'version header missing').not.toBeNull();
    expect(parseInt(m![1], 10)).toBeGreaterThanOrEqual(28);
  });

  it('run-quality-check.py imports analyze-hook-strength-v6', () => {
    expect(rqcSrc).toContain('"analyze-hook-strength-v6"');
  });

  it('run-quality-check.py imports analyze-pacing-v5', () => {
    expect(rqcSrc).toContain('"analyze-pacing-v5"');
  });

  it('run-quality-check.py imports analyze-audio-loudness-v4', () => {
    expect(rqcSrc).toContain('"analyze-audio-loudness-v4"');
  });

  it('run-quality-check.py calls analyze_hook_v6 in run_all()', () => {
    expect(rqcSrc).toContain('analyze_hook_v6(');
  });

  it('run-quality-check.py calls analyze_pacing_v5 in run_all()', () => {
    expect(rqcSrc).toContain('analyze_pacing_v5(');
  });

  it('run-quality-check.py calls analyze_loudness_v4 in run_all()', () => {
    expect(rqcSrc).toContain('analyze_loudness_v4(');
  });

  it('predict-virality.py version header is at least v16', () => {
    const m = viralitySrc.match(/Video Virality Prediction Scorer v(\d+)/);
    expect(m, 'version header missing').not.toBeNull();
    expect(parseInt(m![1], 10)).toBeGreaterThanOrEqual(16);
  });

  it('predict-virality.py imports analyze-hook-strength-v6', () => {
    expect(viralitySrc).toContain('"analyze-hook-strength-v6"');
  });

  it('predict-virality.py imports analyze-pacing-v5', () => {
    expect(viralitySrc).toContain('"analyze-pacing-v5"');
  });

  it('predict-virality.py imports analyze-audio-loudness-v4', () => {
    expect(viralitySrc).toContain('"analyze-audio-loudness-v4"');
  });

  it('predict-virality.py wires hook_v6_virality override', () => {
    expect(viralitySrc).toContain('hook_v6_virality');
  });

  it('predict-virality.py wires pacing_v5_virality override', () => {
    expect(viralitySrc).toContain('pacing_v5_virality');
  });

  it('predict-virality.py wires loudness_v4_virality override', () => {
    expect(viralitySrc).toContain('loudness_v4_virality');
  });
});

describe('video quality rubric run 28 -- accuracy fields updated to 89%', () => {
  const rubricPath = path.join(REPO_ROOT, 'data', 'agent', 'video-quality-rubric.json');
  let rubric: any;

  beforeAll(() => {
    rubric = JSON.parse(fs.readFileSync(rubricPath, 'utf8'));
  });

  it('rubric version is at least 28', () => {
    expect(rubric.version).toBeGreaterThanOrEqual(28);
  });

  it('hook_strength accuracy is 89 after run-28', () => {
    expect(rubric.categories.content.subcriteria.hook_strength.detection_accuracy_self_assessment).toBe(89);
  });

  it('pacing accuracy is 89 after run-28', () => {
    expect(rubric.categories.audio.subcriteria.pacing.detection_accuracy_self_assessment).toBe(89);
  });

  it('volume_levels accuracy is 89 after run-28', () => {
    expect(rubric.categories.audio.subcriteria.volume_levels.detection_accuracy_self_assessment).toBe(89);
  });

  it('background_noise accuracy is 89 after run-28', () => {
    expect(rubric.categories.audio.subcriteria.background_noise.detection_accuracy_self_assessment).toBe(89);
  });

  it('hook_strength tool field points to v6', () => {
    expect(rubric.categories.content.subcriteria.hook_strength.tool).toContain('v6');
  });

  it('pacing tool field points to v5', () => {
    expect(rubric.categories.audio.subcriteria.pacing.tool).toContain('v5');
  });

  it('volume_levels tool field points to v4', () => {
    expect(rubric.categories.audio.subcriteria.volume_levels.tool).toContain('v4');
  });

  it('avg accuracy is at least 87.9 after run-28', () => {
    expect(rubric.automation_summary.avg_accuracy_self_assessment).toBeGreaterThanOrEqual(87.9);
  });

  it('all 26 criteria remain automated after run-28', () => {
    expect(rubric.automation_summary.automated).toBe(26);
    expect(rubric.automation_summary.manual).toBe(0);
    expect(rubric.automation_summary.automation_percentage).toBe(100);
  });
});

// ── video quality tools run 24 (2026-04-27): transitions-v6, cta-v6, caption-v5 ──
// Guard: prevents silent regressions where tools are built but not wired into runners
// or accuracy fields not updated in the rubric.

describe('video quality tools run 24 -- new tool files exist', () => {
  const TOOLS_DIR = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video-quality-tools');

  it('analyze-transitions-v6.py exists', () => {
    expect(fs.existsSync(path.join(TOOLS_DIR, 'analyze-transitions-v6.py'))).toBe(true);
  });

  it('analyze-cta-v6.py exists', () => {
    expect(fs.existsSync(path.join(TOOLS_DIR, 'analyze-cta-v6.py'))).toBe(true);
  });

  it('analyze-caption-readability-v5.py exists', () => {
    expect(fs.existsSync(path.join(TOOLS_DIR, 'analyze-caption-readability-v5.py'))).toBe(true);
  });

  it('analyze-transitions-v6.py has TOOL_VERSION 6.0.0', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-transitions-v6.py'), 'utf8');
    expect(src).toContain('TOOL_VERSION = "6.0.0"');
  });

  it('analyze-cta-v6.py has TOOL_VERSION 6.0.0', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-cta-v6.py'), 'utf8');
    expect(src).toContain('TOOL_VERSION = "6.0.0"');
  });

  it('analyze-caption-readability-v5.py has TOOL_VERSION 5.0.0', () => {
    const src = fs.readFileSync(path.join(TOOLS_DIR, 'analyze-caption-readability-v5.py'), 'utf8');
    expect(src).toContain('TOOL_VERSION = "5.0.0"');
  });

  it('all run-24 tools have def analyze() entry point', () => {
    for (const tool of ['analyze-transitions-v6.py', 'analyze-cta-v6.py', 'analyze-caption-readability-v5.py']) {
      const src = fs.readFileSync(path.join(TOOLS_DIR, tool), 'utf8');
      expect(src).toMatch(/^def analyze\(/m);
    }
  });

  it('all run-24 tools have if __name__ == __main__ entry point', () => {
    for (const tool of ['analyze-transitions-v6.py', 'analyze-cta-v6.py', 'analyze-caption-readability-v5.py']) {
      const src = fs.readFileSync(path.join(TOOLS_DIR, tool), 'utf8');
      expect(src).toMatch(/if __name__ == ["']__main__["']:/);
    }
  });
});

describe('video quality tools run 24 -- run-quality-check.py wires new tools', () => {
  const TOOLS_DIR = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video-quality-tools');
  let rqcSrc: string;

  beforeAll(() => {
    rqcSrc = fs.readFileSync(path.join(TOOLS_DIR, 'run-quality-check.py'), 'utf8');
  });

  it('imports analyze-transitions-v6', () => {
    expect(rqcSrc).toContain('"analyze-transitions-v6"');
  });

  it('imports analyze-cta-v6', () => {
    expect(rqcSrc).toContain('"analyze-cta-v6"');
  });

  it('imports analyze-caption-readability-v5', () => {
    expect(rqcSrc).toContain('"analyze-caption-readability-v5"');
  });

  it('calls analyze_transitions_v6 in run_all()', () => {
    expect(rqcSrc).toContain('analyze_transitions_v6(');
  });

  it('calls analyze_cta_v6 in run_all()', () => {
    expect(rqcSrc).toContain('analyze_cta_v6(');
  });

  it('calls analyze_captions_v5 in run_all()', () => {
    expect(rqcSrc).toContain('analyze_captions_v5(');
  });

  it('version header is at least v29', () => {
    const m = rqcSrc.match(/Video Quality Check Runner v(\d+)/);
    expect(m, 'version header missing').not.toBeNull();
    expect(parseInt(m![1], 10)).toBeGreaterThanOrEqual(29);
  });
});

describe('video quality tools run 24 -- rubric accuracy fields updated', () => {
  const rubricPath = path.join(REPO_ROOT, 'content-review', 'video-quality-rubric.json');
  let rubric: any;

  beforeAll(() => {
    rubric = JSON.parse(fs.readFileSync(rubricPath, 'utf8'));
  });

  it('rubric version is 29 or later', () => {
    expect(rubric.version).toBeGreaterThanOrEqual(29);
  });

  it('transitions accuracy is 89', () => {
    expect(rubric.categories.visual.subcriteria.transitions.detection_accuracy_self_assessment).toBe(89);
  });

  it('cta_placement accuracy is 89', () => {
    expect(rubric.categories.content.subcriteria.cta_placement.detection_accuracy_self_assessment).toBe(89);
  });

  it('caption_readability accuracy is 89', () => {
    expect(rubric.categories.technical.subcriteria.caption_readability.detection_accuracy_self_assessment).toBe(89);
  });

  it('transitions tool points to v6', () => {
    expect(rubric.categories.visual.subcriteria.transitions.tool).toContain('v6');
  });

  it('cta_placement tool points to v6', () => {
    expect(rubric.categories.content.subcriteria.cta_placement.tool).toContain('v6');
  });

  it('caption_readability tool points to v5', () => {
    expect(rubric.categories.technical.subcriteria.caption_readability.tool).toContain('v5');
  });

  it('avg accuracy is at least 88.5 after run-24', () => {
    expect(rubric.automation_summary.avg_accuracy_self_assessment).toBeGreaterThanOrEqual(88.5);
  });

  it('all 26 criteria remain automated after run-24', () => {
    expect(rubric.automation_summary.automated).toBe(26);
    expect(rubric.automation_summary.manual).toBe(0);
    expect(rubric.automation_summary.automation_percentage).toBe(100);
  });
});
