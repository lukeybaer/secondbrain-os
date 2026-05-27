// video-pipeline.ts
// Orchestrates the 5:30 AM video build pipeline:
//   3 Channel1 + 2 Channel2 → QC gate → Content Pipeline tab
//
// Uses SQLite process locks (acquireLock) to guarantee one-run-per-day idempotency.
// Spawns the Python empire scripts in empire/ directory.

import * as path from 'path';
import * as fs from 'fs';
import { spawn, spawnSync } from 'child_process';
import { app } from 'electron';
import { acquireLock, releaseLock } from './database-sqlite';

import { getConfig } from './config';
import { appendHeartbeat } from './pipeline-heartbeat';

// ── Path helpers ──────────────────────────────────────────────────────────────

function empireDir(): string {
  // In dev: src/main/empire; in production: resources/empire (packaged)
  const devPath = path.join(__dirname, '..', 'main', 'empire');
  const prodPath = path.join(process.resourcesPath ?? '', 'empire');
  return fs.existsSync(devPath) ? devPath : prodPath;
}

function contentReviewDir(): string {
  return path.join(app.getPath('userData'), 'content-review');
}

function pendingDir(): string {
  return path.join(contentReviewDir(), 'pending');
}

function manifestPath(): string {
  return path.join(pendingDir(), 'manifest.json');
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function heartbeatLogPath(): string {
  return path.join(app.getPath('userData'), 'data', 'agent', 'pipeline-heartbeat.jsonl');
}

// ── Python runner ─────────────────────────────────────────────────────────────

interface PythonResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

// 2026-05-05 #learn (feedback_windows_python_shim_fix.md): on Windows the bare
// `python` command resolves to the Microsoft Store WindowsApps shim by default,
// which prints "Python was not found, run without arguments to install from the
// Microsoft Store" and exits 9009 instead of running a script. The auto-regen
// path silently dies on every rejected video. Resolve a real interpreter once
// and cache it.
let _cachedPythonExe: string | null = null;
function resolvePythonExe(): string {
  if (_cachedPythonExe) return _cachedPythonExe;
  if (process.platform !== 'win32') {
    _cachedPythonExe = 'python3';
    return _cachedPythonExe;
  }
  const fs = require('fs');
  const path = require('path');
  const candidates: string[] = [];
  if (process.env.PYTHON_EXE) candidates.push(process.env.PYTHON_EXE);
  for (const v of ['314', '313', '312', '311', '310']) {
    candidates.push(`C:\\Python${v}\\python.exe`);
  }
  const userBase = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python')
    : '';
  if (userBase) {
    try {
      if (fs.existsSync(userBase)) {
        for (const dir of fs.readdirSync(userBase)) {
          if (/^Python\d{2,3}$/.test(dir)) {
            candidates.push(path.join(userBase, dir, 'python.exe'));
          }
        }
      }
    } catch { /* ignore */ }
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        _cachedPythonExe = c;
        return c;
      }
    } catch { /* skip */ }
  }
  // Python launcher (py.exe) is installed with python.org. Trust PATH for it.
  // Bare 'python' is the last resort since it can hit the WindowsApps shim.
  _cachedPythonExe = 'py.exe';
  return _cachedPythonExe;
}

function runPython(
  scriptPath: string,
  args: string[] = [],
  env?: Record<string, string>,
): Promise<PythonResult> {
  return new Promise((resolve) => {
    const python = resolvePythonExe();
    const proc = spawn(python, [scriptPath, ...args], {
      cwd: empireDir(),
      env: { ...process.env, ...env },
      timeout: 10 * 60 * 1000, // 10 minute max per video
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      resolve({ success: code === 0, stdout, stderr, exitCode: code });
    });

    proc.on('error', (err) => {
      resolve({ success: false, stdout, stderr: err.message, exitCode: -1 });
    });
  });
}

// ── Thumbnail content gate ────────────────────────────────────────────────────
// 2026-04-29 fix: mtime guard from 2026-04-26 catches "regen never wrote a new
// file." This catches the next layer: regen wrote a NEW file but the new file
// is still 96% black-with-text (Grok background failed silently and the EC2
// fallback rendered title text on a black canvas). Same defect, fourth time,
// "where's the QC #gap" rejection on 2026-04-29.
//
// The check shells out to scripts/check-thumbnail-quality.py which does a
// pixel histogram analysis (no API, no model, ~100ms). Falls open (returns ok)
// only when the script itself is unreachable -- never when content is bad.
export interface ThumbnailQualityResult {
  ok: boolean;
  reason: string;
  metrics?: Record<string, number>;
}

export function checkThumbnailQuality(thumbPath: string): ThumbnailQualityResult {
  return runQualityGate(thumbPath, 'check-thumbnail-quality.py', `thumbnail file missing: ${thumbPath}`);
}

// Video content gate -- locked 2026-04-29. Catches two failure modes the
// thumbnail gate can't see: (1) the mp4 has audio but the video stream is
// effectively empty (video_dur << audio_dur, playback shows black), and
// (2) the mp4 has video frames but they are all blank (B-roll never
// rendered, just a black canvas with audio over it). Both happened in
// today's regen output -- ai_agent_income_formula had video_dur=0.23s
// vs audio_dur=28.2s, and three other videos had all-blank body frames.
// Implementation lives in scripts/check-video-content-not-blank.py and
// uses ffprobe + ffmpeg + the thumbnail gate per-frame.
export function checkVideoContent(videoPath: string): ThumbnailQualityResult {
  return runQualityGate(videoPath, 'check-video-content-not-blank.py', `video file missing: ${videoPath}`, 60_000);
}

function runQualityGate(
  artifactPath: string,
  scriptName: string,
  missingMsg: string,
  timeoutMs: number = 15_000,
): ThumbnailQualityResult {
  if (!fs.existsSync(artifactPath)) {
    return { ok: false, reason: missingMsg };
  }
  const repoRoot = path.resolve(__dirname, '..', '..');
  const script = path.join(repoRoot, 'scripts', scriptName);
  if (!fs.existsSync(script)) {
    return { ok: false, reason: `quality gate tool missing: ${script}` };
  }
  const candidates = process.platform === 'win32'
    ? ['py', 'python', 'python3']
    : ['python3', 'python'];
  let lastErr = '';
  for (const bin of candidates) {
    const r = spawnSync(bin, [script, artifactPath], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      lastErr = `${bin} not found`;
      continue;
    }
    if (r.status === null) {
      lastErr = `${bin} did not exit (timeout?)`;
      continue;
    }
    try {
      const parsed = JSON.parse((r.stdout || '').trim()) as ThumbnailQualityResult;
      return parsed;
    } catch {
      return {
        ok: false,
        reason: `quality gate output unparseable (exit ${r.status}): ${(r.stdout || r.stderr || '').slice(0, 200)}`,
      };
    }
  }
  return { ok: false, reason: `quality gate could not run any python: ${lastErr}` };
}

// ── Video spec builder ────────────────────────────────────────────────────────

interface VideoSpec {
  channel: 'Channel1' | 'Channel2';
  style: string;
  description: string;
}

function getTodayVideoSpecs(): VideoSpec[] {
  return [
    {
      channel: 'Channel1',
      style: '2m_narration',
      description: 'Investigative AI story with specific stat or number in title',
    },
    {
      channel: 'Channel1',
      style: 'income_opportunity',
      description: 'Income/opportunity angle — how AI makes money or saves time',
    },
    {
      channel: 'Channel1',
      style: 'countdown_revelatory',
      description: "Countdown list or 'nobody talks about' revelatory format",
    },
    {
      channel: 'Channel2',
      style: 'grok_aurora_illustrated',
      description: 'Gentle illustrated story — Grok Aurora 3-scene animation with lullaby music',
    },
    {
      channel: 'Channel2',
      style: 'grok_aurora_illustrated',
      description: 'Second illustrated story — different character and setting',
    },
  ];
}

// ── Manifest helpers ──────────────────────────────────────────────────────────

interface ManifestEntry {
  id: string;
  title?: string;
  channel: string;
  style: string;
  built_at: string;
  status: 'pending_approval' | 'approved' | 'rejected' | 'uploaded';
  video_path?: string;
  thumbnail_path?: string;
  qc_passed: boolean;
  qc_notes?: string;
}

function loadManifest(): ManifestEntry[] {
  if (!fs.existsSync(manifestPath())) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(), 'utf-8'));
    return Array.isArray(raw) ? raw : Object.values(raw);
  } catch {
    return [];
  }
}

function saveManifest(entries: ManifestEntry[]): void {
  const dir = pendingDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath(), JSON.stringify(entries, null, 2), 'utf-8');
}

function addToManifest(entry: ManifestEntry): void {
  const entries = loadManifest();
  const idx = entries.findIndex((e) => e.id === entry.id);
  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }
  saveManifest(entries);
}

// ── Build pipeline ────────────────────────────────────────────────────────────

async function buildSingleVideo(spec: VideoSpec, index: number): Promise<ManifestEntry> {
  const empire = empireDir();
  const buildScript = path.join(empire, 'build_video.py');
  const qcScript = path.join(empire, 'qc_agent.py');

  const videoId = `${todayKey()}_${spec.channel.toLowerCase()}_${index + 1}`;
  const outputDir = path.join(pendingDir(), videoId);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const entry: ManifestEntry = {
    id: videoId,
    channel: spec.channel,
    style: spec.style,
    built_at: new Date().toISOString(),
    status: 'pending_approval',
    qc_passed: false,
  };

  // Check if build_video.py actually exists
  if (!fs.existsSync(buildScript)) {
    console.log(
      `[video-pipeline] build_video.py not found at ${buildScript} — generating placeholder`,
    );
    // Create a placeholder manifest entry so the Content Pipeline tab has something to show
    const placeholderEntry: ManifestEntry = {
      ...entry,
      title: `${spec.channel}: ${spec.description}`,
      qc_passed: false,
      qc_notes:
        'Empire build scripts not yet configured on this machine. Videos must be built on the GCP VM.',
      status: 'pending_approval',
    };
    addToManifest(placeholderEntry);
    return placeholderEntry;
  }

  console.log(`[video-pipeline] Building ${videoId} (${spec.channel} / ${spec.style})`);

  // Step 1: Build video
  const buildResult = await runPython(buildScript, [
    '--channel',
    spec.channel,
    '--style',
    spec.style,
    '--output-dir',
    outputDir,
    '--description',
    spec.description,
  ]);

  if (!buildResult.success) {
    const errSnip = buildResult.stderr.slice(0, 200);
    console.error(`[video-pipeline] Build failed for ${videoId}:`, buildResult.stderr.slice(0, 500));
    appendHeartbeat(heartbeatLogPath(), {
      timestamp: new Date().toISOString(),
      task: 'video-pipeline',
      status: 'error',
      video_id: videoId,
      error_type: 'build_failed',
      error: errSnip,
    });
    entry.qc_notes = `Build failed: ${errSnip}`;
    addToManifest(entry);
    return entry;
  }

  appendHeartbeat(heartbeatLogPath(), {
    timestamp: new Date().toISOString(),
    task: 'video-pipeline',
    status: 'video_built',
    video_id: videoId,
  });

  // Try to find produced files
  const files = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
  const videoFile = files.find((f) => f.endsWith('.mp4'));
  const thumbFile = files.find((f) => f.endsWith('.jpg') || f.endsWith('.png'));

  if (videoFile) entry.video_path = path.join(outputDir, videoFile);
  if (thumbFile) entry.thumbnail_path = path.join(outputDir, thumbFile);

  // Step 2: QC gate
  if (fs.existsSync(qcScript) && entry.video_path) {
    const qcResult = await runPython(qcScript, [entry.video_path]);
    entry.qc_passed = qcResult.success;
    entry.qc_notes = qcResult.stdout.slice(0, 500) || qcResult.stderr.slice(0, 500);
    appendHeartbeat(heartbeatLogPath(), {
      timestamp: new Date().toISOString(),
      task: 'video-pipeline',
      status: qcResult.success ? 'qc_passed' : 'qc_failed',
      video_id: videoId,
      ...(qcResult.success ? {} : { error_type: 'qc_failed', error: entry.qc_notes?.slice(0, 200) }),
    });
  }

  // Try to extract title from build output
  const titleMatch = buildResult.stdout.match(/TITLE:\s*(.+)/);
  if (titleMatch) entry.title = titleMatch[1].trim();

  addToManifest(entry);
  return entry;
}

// ── Main pipeline entry ───────────────────────────────────────────────────────

export interface PipelineResult {
  ran: boolean;
  built: number;
  qcPassed: number;
  entries: ManifestEntry[];
  error?: string;
}

export async function runVideoPipeline(): Promise<PipelineResult> {
  const lockKey = `video-pipeline-${todayKey()}`;

  // One run per day
  if (!acquireLock(lockKey, 'video-pipeline', 90)) {
    console.log('[video-pipeline] Already ran today — skipping');
    return { ran: false, built: 0, qcPassed: 0, entries: [] };
  }

  const config = getConfig();
  const specs = getTodayVideoSpecs();
  const results: ManifestEntry[] = [];

  appendHeartbeat(heartbeatLogPath(), {
    timestamp: new Date().toISOString(),
    task: 'video-pipeline',
    status: 'started',
    details: `building ${specs.length} videos`,
  });

  console.log(`[video-pipeline] Starting — building ${specs.length} videos`);

  // Telegram is daily-briefing-only — log pipeline start to console instead
  console.log(
    `[video-pipeline] Starting — building ${specs.length} videos (3 Channel1 + 2 Channel2)`,
  );

  let buildErrors = 0;
  for (let i = 0; i < specs.length; i++) {
    try {
      const entry = await buildSingleVideo(specs[i], i);
      results.push(entry);
      console.log(`[video-pipeline] ${entry.id} — QC ${entry.qc_passed ? 'PASSED' : 'FAILED'}`);
    } catch (err: any) {
      buildErrors++;
      console.error(`[video-pipeline] Error building video ${i + 1}:`, err.message);
    }
  }

  const qcPassed = results.filter((r) => r.qc_passed).length;
  const built = results.length;

  appendHeartbeat(heartbeatLogPath(), {
    timestamp: new Date().toISOString(),
    task: 'video-pipeline',
    status: 'completed',
    details: `${built} built, ${qcPassed} passed QC`,
  });

  // Release lock on success (keep on failure so we can retry manually)
  if (built === specs.length) {
    releaseLock(lockKey);
    // Re-acquire a lighter "done" lock so we don't re-run
    acquireLock(`${lockKey}-done`, 'video-pipeline-done', 24 * 60);
  }

  // Telegram is daily-briefing-only — log results to console
  console.log(`[video-pipeline] Complete: ${qcPassed}/${built} passed QC`);

  console.log(`[video-pipeline] Done. ${built} built, ${qcPassed} passed QC`);
  return { ran: true, built, qcPassed, entries: results };
}

/** How many videos are currently pending the owner's approval. */
export function pendingVideoCount(): number {
  const entries = loadManifest();
  return entries.filter((e) => e.status === 'pending_approval').length;
}

// ── Rejected video regeneration ───────────────────────────────────────────────

export interface RegenResult {
  videoId: string;
  success: boolean;
  error?: string;
}

/**
 * Rebuild a single rejected video with its rejection feedback baked in.
 * Passes REJECTION_NOTE and REGEN_VIDEO_ID env vars to build_video.py so the
 * script can incorporate the feedback into the generation prompt.
 */
export async function buildRejectedVideo(
  videoId: string,
  channel: string,
  originalTitle: string,
  rejectionNote: string,
  outputBaseDir: string,
): Promise<RegenResult> {
  const empire = empireDir();
  const buildScript = path.join(empire, 'build_video.py');
  const qcScript = path.join(empire, 'qc_agent.py');
  const outputDir = path.join(outputBaseDir, videoId);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  if (!fs.existsSync(buildScript)) {
    return {
      videoId,
      success: false,
      error: 'build_video.py not found — rebuild must run on the production VM',
    };
  }

  const description = [
    `REGEN: ${originalTitle}`,
    rejectionNote ? `REJECTION FEEDBACK (fix these issues): ${rejectionNote}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const buildResult = await runPython(
    buildScript,
    [
      '--channel',
      channel,
      '--style',
      'auto',
      '--output-dir',
      outputDir,
      '--description',
      description,
    ],
    { REJECTION_NOTE: rejectionNote, REGEN_VIDEO_ID: videoId },
  );

  if (!buildResult.success) {
    return {
      videoId,
      success: false,
      error: `Build failed (exit ${buildResult.exitCode}): ${buildResult.stderr.slice(0, 300)}`,
    };
  }

  // Run QC if available
  const files = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
  const videoFile = files.find((f) => f.endsWith('.mp4'));
  if (videoFile && fs.existsSync(qcScript)) {
    await runPython(qcScript, [path.join(outputDir, videoFile)]);
  }

  return { videoId, success: true };
}

/**
 * Scan the content-review manifest for videos marked video_needs_regen or
 * thumbnail_needs_regen and trigger a rebuild for each one.
 */
export async function regenRejectedVideos(contentRoot: string): Promise<RegenResult[]> {
  const pendingManifestPath = path.join(contentRoot, 'content-review', 'pending', 'manifest.json');
  if (!fs.existsSync(pendingManifestPath)) return [];

  const manifest = JSON.parse(fs.readFileSync(pendingManifestPath, 'utf-8'));
  const videos: any[] = Array.isArray(manifest.videos) ? manifest.videos : [];
  const flagged = videos.filter(
    (v) => v.video_needs_regen === true || v.thumbnail_needs_regen === true,
  );

  if (flagged.length === 0) return [];

  const results: RegenResult[] = [];
  const outputBaseDir = path.join(contentRoot, 'content-review', 'pending');

  function mtimeOrZero(p: string): number {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  }

  for (const video of flagged) {
    const rejectionNote = video.video_rejection_note || video.thumbnail_rejection_note || '';

    // Mark regen in progress so UI shows status
    video.regen_status = 'in_progress';
    video.regen_started_at = new Date().toISOString();
    fs.writeFileSync(pendingManifestPath, JSON.stringify(manifest, null, 2));

    // Honesty contract (locked 2026-04-26): capture pre-build mtimes so
    // success can only be claimed when the artifact actually changed. The
    // ad-hoc "marathon dispatch" Python flow that caused the gap wrote
    // regen_completed_at without rewriting the thumbnail jpg, cycling the
    // SAME bad artifact back into Luke's queue. Never again.
    const mp4Path = path.join(outputBaseDir, video.id, `${video.id}.mp4`);
    const thumbPath = path.join(outputBaseDir, video.id, `${video.id}_thumb.jpg`);
    const flatMp4 = path.join(outputBaseDir, `${video.id}.mp4`);
    const flatThumb = path.join(outputBaseDir, `${video.id}_thumb.jpg`);
    const beforeMp4 = Math.max(mtimeOrZero(mp4Path), mtimeOrZero(flatMp4));
    const beforeThumb = Math.max(mtimeOrZero(thumbPath), mtimeOrZero(flatThumb));

    const result = await buildRejectedVideo(
      video.id,
      video.channel || process.env.YT_CHANNEL_PRIMARY || '',
      video.title || video.id,
      rejectionNote,
      outputBaseDir,
    );

    if (result.success) {
      const afterMp4 = Math.max(mtimeOrZero(mp4Path), mtimeOrZero(flatMp4));
      const afterThumb = Math.max(mtimeOrZero(thumbPath), mtimeOrZero(flatThumb));
      const videoChanged = afterMp4 > beforeMp4;
      const thumbChanged = afterThumb > beforeThumb;

      const failures: string[] = [];
      if (video.video_needs_regen === true && !videoChanged) {
        failures.push('mp4 mtime unchanged');
      }
      if (video.thumbnail_needs_regen === true && !thumbChanged) {
        failures.push('thumb mtime unchanged');
      }

      if (failures.length > 0) {
        // Build claimed success but artifact mtime didn't move --- the
        // pipeline lied. Mark failed and leave the rejection state intact
        // so this video does NOT cycle back into Luke's review queue.
        video.regen_status = 'failed';
        video.regen_error = 'mtime guard: ' + failures.join('; ');
        video.regen_failed_at = new Date().toISOString();
        results.push({
          videoId: video.id,
          success: false,
          error: 'mtime guard: ' + failures.join('; '),
        });
        fs.writeFileSync(pendingManifestPath, JSON.stringify(manifest, null, 2));
        continue;
      }

      // Quality gate (locked 2026-04-29): mtime moved but the new file might
      // still be 96% black-with-text (Grok bg failed silently). Run the
      // pixel-histogram check on any thumbnail that was just regenerated.
      // If it fails, treat the regen as a failure and leave the rejection
      // state intact -- never cycle a blank thumbnail back to Luke.
      if (thumbChanged) {
        const livePath = fs.existsSync(thumbPath) ? thumbPath : flatThumb;
        const quality = checkThumbnailQuality(livePath);
        if (!quality.ok) {
          video.regen_status = 'failed';
          video.regen_error = `thumbnail quality gate: ${quality.reason}`;
          video.regen_failed_at = new Date().toISOString();
          if (quality.metrics) video.regen_thumbnail_metrics = quality.metrics;
          results.push({
            videoId: video.id,
            success: false,
            error: `thumbnail quality gate: ${quality.reason}`,
          });
          fs.writeFileSync(pendingManifestPath, JSON.stringify(manifest, null, 2));
          continue;
        }
        if (quality.metrics) video.regen_thumbnail_metrics = quality.metrics;
      }

      // Video content gate (locked 2026-04-29 evening): a regenerated mp4
      // can have audio + a thumbnail card but a body that is uniformly
      // black (B-roll never rendered) or a video stream that is empty
      // (video_dur << audio_dur). Both happened tonight. Sample three
      // frames from the body and run them through the thumbnail gate.
      if (videoChanged) {
        const liveMp4 = fs.existsSync(mp4Path) ? mp4Path : flatMp4;
        const videoQuality = checkVideoContent(liveMp4);
        if (!videoQuality.ok) {
          video.regen_status = 'failed';
          video.regen_error = `video content gate: ${videoQuality.reason}`;
          video.regen_failed_at = new Date().toISOString();
          if (videoQuality.metrics) video.regen_video_metrics = videoQuality.metrics;
          results.push({
            videoId: video.id,
            success: false,
            error: `video content gate: ${videoQuality.reason}`,
          });
          fs.writeFileSync(pendingManifestPath, JSON.stringify(manifest, null, 2));
          continue;
        }
        if (videoQuality.metrics) video.regen_video_metrics = videoQuality.metrics;
      }

      // Real regen: clear only the flags for artifacts that actually moved.
      if (videoChanged) video.video_needs_regen = false;
      if (thumbChanged) video.thumbnail_needs_regen = false;
      video.regen_status = 'done';
      video.regen_completed_at = new Date().toISOString();
      video.status = 'pending_approval';
      // 2026-05-05 Luke: the review screen has a "Previous Feedback" panel
      // (ContentPipeline.tsx:818-860) wired to video.previous_feedback +
      // video.fix_summary, but the regen flow used to save the rejection
      // note as `previous_rejection_note` so the panel never rendered.
      // Field rename here makes the panel light up. fix_summary is a
      // 1-line synthesis of what actually changed in this regen, so when
      // the video comes back to Luke he sees both his original feedback
      // AND the change made in response to it.
      video.previous_feedback = rejectionNote;
      const fixParts: string[] = [];
      if (thumbChanged) {
        const tm = video.regen_thumbnail_metrics || {};
        const lum = typeof tm.mean_luminance === 'number' ? `lum ${Math.round(tm.mean_luminance)}` : '';
        const mae = typeof tm.lr_mirror_mae === 'number' ? `lr_mae ${Math.round(tm.lr_mirror_mae)}` : '';
        fixParts.push(`thumbnail regenerated (${[lum, mae].filter(Boolean).join(', ')})`);
      }
      if (videoChanged) {
        const vm = video.regen_video_metrics || {};
        const dur = typeof vm.duration_s === 'number' ? `${vm.duration_s.toFixed(1)}s` : '';
        const samples = (vm.samples_taken && vm.samples_blank !== undefined)
          ? `${vm.samples_taken - (vm.samples_blank || 0)}/${vm.samples_taken} body frames clean`
          : '';
        fixParts.push(`video regenerated (${[dur, samples].filter(Boolean).join(', ')})`);
      }
      video.fix_summary = fixParts.length > 0
        ? fixParts.join('; ')
        : 'regenerated, no measured changes';
    } else {
      video.regen_status = 'failed';
      video.regen_error = result.error;
      video.regen_failed_at = new Date().toISOString();
    }

    fs.writeFileSync(pendingManifestPath, JSON.stringify(manifest, null, 2));
    results.push(result);
  }

  return results;
}
