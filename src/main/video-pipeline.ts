// video-pipeline.ts
// Orchestrates the 5:30 AM video build pipeline:
//   3 AILifeHacks + 2 BedtimeStories → QC gate → Content Pipeline tab
//
// Uses SQLite process locks (acquireLock) to guarantee one-run-per-day idempotency.
// Spawns the Python empire scripts in empire/ directory.

import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { app } from 'electron';
import { acquireLock, releaseLock } from './database-sqlite';

import { getConfig } from './config';

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

// ── Python runner ─────────────────────────────────────────────────────────────

interface PythonResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runPython(
  scriptPath: string,
  args: string[] = [],
  env?: Record<string, string>,
): Promise<PythonResult> {
  return new Promise((resolve) => {
    // Try python3 first, fall back to python
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const proc = spawn(python, [scriptPath, ...args], {
      cwd: empireDir(),
      env: { ...process.env, ...env },
      timeout: 10 * 60 * 1000, // 10 minute max per video
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

// ── Video spec builder ────────────────────────────────────────────────────────

interface VideoSpec {
  channel: 'AILifeHacks' | 'BedtimeStories';
  style: string;
  description: string;
}

function getTodayVideoSpecs(): VideoSpec[] {
  return [
    {
      channel: 'AILifeHacks',
      style: '2m_narration',
      description: 'Investigative AI story with specific stat or number in title',
    },
    {
      channel: 'AILifeHacks',
      style: 'income_opportunity',
      description: 'Income/opportunity angle — how AI makes money or saves time',
    },
    {
      channel: 'AILifeHacks',
      style: 'countdown_revelatory',
      description: "Countdown list or 'nobody talks about' revelatory format",
    },
    {
      channel: 'BedtimeStories',
      style: 'grok_aurora_illustrated',
      description: 'Gentle illustrated story — Grok Aurora 3-scene animation with lullaby music',
    },
    {
      channel: 'BedtimeStories',
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
    console.error(
      `[video-pipeline] Build failed for ${videoId}:`,
      buildResult.stderr.slice(0, 500),
    );
    entry.qc_notes = `Build failed: ${buildResult.stderr.slice(0, 200)}`;
    addToManifest(entry);
    return entry;
  }

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

  console.log(`[video-pipeline] Starting — building ${specs.length} videos`);

  // Telegram is daily-briefing-only — log pipeline start to console instead
  console.log(
    `[video-pipeline] Starting — building ${specs.length} videos (3 AILifeHacks + 2 BedtimeStories)`,
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

/** How many videos are currently pending Luke's approval. */
export function pendingVideoCount(): number {
  const entries = loadManifest();
  return entries.filter((e) => e.status === 'pending_approval').length;
}
