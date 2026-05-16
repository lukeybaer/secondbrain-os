// timemachine.ts
// Continuous screen capture + audio recording + S3 upload for Time Machine.
// Lightweight: <3% CPU, <100MB RAM. Screenshots every 3s, audio always on.

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { spawn, ChildProcess, execFile } from 'child_process';
import { insertFrame, updateFrameOcr } from './timemachine-db';
import type {
  TimeMachineClusteringSettings,
  TimeMachineDedupeSettings,
  TimeMachinePrivacySettings,
} from './timemachine-types';
import type { ActiveWindowInfo } from './timemachine-privacy';
import { buildPrivacyDrawboxFilter, decidePrivacyCapture } from './timemachine-privacy';
import { TimeMachineDedupe } from './timemachine-dedupe';

// ─── Types ──────────────────────────────────────────────────────────────

export interface TimeMachineConfig {
  enabled: boolean;
  captureIntervalMs: number;
  screenshotQuality: number; // JPEG quality 1-31 (lower = better, 5 ≈ 55%)
  captureAudio: boolean;
  captureMic: boolean;
  captureSystemAudio: boolean;
  retentionScreenshotDays: number;
  retentionAudioDays: number;
  silenceThresholdSeconds: number;
  s3Bucket: string;
  s3Prefix: string;
  privacy: TimeMachinePrivacySettings;
  dedupe: TimeMachineDedupeSettings;
  clustering: TimeMachineClusteringSettings;
}

export interface TimeMachineStatus {
  running: boolean;
  paused: boolean;
  captureCount: number;
  lastCaptureAt: string | null;
  audioRecording: boolean;
  conversationsToday: number;
  privacyActive: boolean;
  privacyReason: string | null;
  privacySkipCount: number;
}

// ─── Paths ──────────────────────────────────────────────────────────────

function dataDir(): string {
  return path.join(app.getPath('userData'), 'data', 'timemachine');
}

function bufferDir(): string {
  return path.join(dataDir(), 'buffer');
}

function screenshotBufferDir(): string {
  const d = new Date();
  const dateStr = d.toISOString().slice(0, 10);
  return path.join(bufferDir(), 'screenshots', dateStr);
}

function audioBufferDir(): string {
  const d = new Date();
  const dateStr = d.toISOString().slice(0, 10);
  return path.join(bufferDir(), 'audio', dateStr);
}

function configPath(): string {
  return path.join(dataDir(), 'config.json');
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Config ─────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: TimeMachineConfig = {
  enabled: false,
  captureIntervalMs: 3000,
  screenshotQuality: 5,
  captureAudio: true,
  captureMic: false,
  captureSystemAudio: true,
  retentionScreenshotDays: 7,
  retentionAudioDays: 30,
  silenceThresholdSeconds: 60,
  s3Bucket: '000000000000-secondbrain-backups',
  s3Prefix: 'timemachine',
  privacy: {
    zones: [],
    pauseSchedules: [],
    excludedApps: [],
    excludedTitlePatterns: [],
    excludedDomains: [],
  },
  dedupe: {
    enabled: true,
    sizeDriftThreshold: 0.05,
    chunkBytes: 4096,
    recentWindowSize: 12,
  },
  clustering: {
    idleGapMinutes: 5,
    topTermCount: 5,
  },
};

function mergeConfig(config: Partial<TimeMachineConfig>): TimeMachineConfig {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    privacy: {
      ...DEFAULT_CONFIG.privacy,
      ...(config.privacy || {}),
    },
    dedupe: {
      ...DEFAULT_CONFIG.dedupe,
      ...(config.dedupe || {}),
    },
    clustering: {
      ...DEFAULT_CONFIG.clustering,
      ...(config.clustering || {}),
    },
  };
}

export function loadTimeMachineConfig(): TimeMachineConfig {
  try {
    if (fs.existsSync(configPath())) {
      return mergeConfig(JSON.parse(fs.readFileSync(configPath(), 'utf-8')));
    }
  } catch {
    /* ignore */
  }
  return mergeConfig({});
}

export function saveTimeMachineConfig(config: Partial<TimeMachineConfig>): TimeMachineConfig {
  ensureDir(dataDir());
  const current = loadTimeMachineConfig();
  const merged = mergeConfig({
    ...current,
    ...config,
    privacy: {
      ...current.privacy,
      ...(config.privacy || {}),
    },
    dedupe: {
      ...current.dedupe,
      ...(config.dedupe || {}),
    },
    clustering: {
      ...current.clustering,
      ...(config.clustering || {}),
    },
  });
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2));
  return merged;
}

// ─── State ──────────────────────────────────────────────────────────────

let running = false;
let paused = false;
let captureTimer: ReturnType<typeof setTimeout> | null = null;
let audioProcess: ChildProcess | null = null;
let captureCount = 0;
let lastCaptureAt: string | null = null;
let privacyActive = false;
let privacyReason: string | null = null;
let privacySkipCount = 0;
const dedupe = new TimeMachineDedupe(DEFAULT_CONFIG.dedupe);

async function getActiveWindowInfo(): Promise<ActiveWindowInfo | null> {
  try {
    const mod = await import('get-windows');
    return (await mod.activeWindow()) ?? null;
  } catch {
    return null;
  }
}

// ─── Screenshot Capture ─────────────────────────────────────────────────

async function captureScreenshot(): Promise<{ filePath: string; fileSize: number } | null> {
  const dir = screenshotBufferDir();
  ensureDir(dir);

  const now = new Date();
  const timeStr = now.toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `${timeStr}.jpg`);

  const config = loadTimeMachineConfig();
  const privacyFilter = buildPrivacyDrawboxFilter(config.privacy.zones);
  const args = [
    '-f',
    'gdigrab',
    '-i',
    'desktop',
    '-frames:v',
    '1',
    '-q:v',
    String(config.screenshotQuality),
  ];
  if (privacyFilter) args.push('-vf', privacyFilter);
  args.push('-y', filePath);

  return new Promise((resolve) => {
    const proc = spawn(
      'ffmpeg',
      args,
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const timeout = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 5000);

    proc.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0 && fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        resolve({ filePath, fileSize: stat.size });
      } else {
        resolve(null);
      }
    });

    proc.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

// ─── OCR via Tesseract ──────────────────────────────────────────────────

const TESSERACT_PATH = 'C:/Program Files/Tesseract-OCR/tesseract.exe';

async function ocrScreenshot(imagePath: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      TESSERACT_PATH,
      [imagePath, 'stdout', '-l', 'eng', '--psm', '3'],
      { timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve('');
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

// ─── S3 Upload ──────────────────────────────────────────────────────────

async function uploadToS3(localPath: string, s3Key: string): Promise<boolean> {
  const config = loadTimeMachineConfig();
  return new Promise((resolve) => {
    const proc = spawn(
      'aws',
      [
        's3',
        'cp',
        localPath,
        `s3://${config.s3Bucket}/${s3Key}`,
        '--region',
        'us-east-1',
        '--quiet',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    proc.on('exit', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

// ─── Audio Capture ──────────────────────────────────────────────────────

async function startAudioCapture(): Promise<void> {
  if (audioProcess) return;

  const config = loadTimeMachineConfig();
  if (!config.captureAudio) return;

  const dir = audioBufferDir();
  ensureDir(dir);

  // Detect audio loopback device
  const audioDevice = await detectAudioLoopback();
  if (!audioDevice) {
    console.warn('[timemachine] No audio loopback device found');
    return;
  }

  const outputPattern = path.join(dir, '%H-%M.opus');

  audioProcess = spawn(
    'ffmpeg',
    [
      '-f',
      'dshow',
      '-i',
      `audio=${audioDevice}`,
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-f',
      'segment',
      '-segment_time',
      '3600',
      '-strftime',
      '0',
      '-y',
      outputPattern,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  audioProcess.on('exit', () => {
    audioProcess = null;
  });
  audioProcess.on('error', () => {
    audioProcess = null;
  });
}

function stopAudioCapture(): Promise<void> {
  return new Promise((resolve) => {
    if (!audioProcess) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      audioProcess?.kill();
      audioProcess = null;
      resolve();
    }, 5000);

    audioProcess.on('exit', () => {
      clearTimeout(timeout);
      audioProcess = null;
      resolve();
    });

    audioProcess.stdin?.write('q');
    audioProcess.stdin?.end();
  });
}

async function detectAudioLoopback(): Promise<string | null> {
  // Use studio's detectDevices to find audio devices
  const { detectDevices } = await import('./studio');
  const devices = await detectDevices();
  const audioDevices = devices.filter((d) => d.type === 'audio');

  // Look for stereo mix, loopback, or "what you hear" device
  const loopback = audioDevices.find((d) =>
    /stereo mix|loopback|what.?you.?hear|wave out/i.test(d.name),
  );

  if (loopback) return loopback.name;

  // Fall back to first audio device
  return audioDevices.length > 0 ? audioDevices[0].name : null;
}

// ─── Capture Loop ───────────────────────────────────────────────────────

async function captureOnce(): Promise<void> {
  const config = loadTimeMachineConfig();
  const now = new Date();
  const timestamp = now.toISOString();
  const dateStr = now.toISOString().slice(0, 10);
  const activeWindow = await getActiveWindowInfo();
  const privacyDecision = decidePrivacyCapture(config.privacy, activeWindow, now);

  privacyActive = !privacyDecision.allowed;
  privacyReason = privacyDecision.reason;

  if (!privacyDecision.allowed) {
    privacySkipCount++;
    await stopAudioCapture();
    return;
  }

  if (config.captureAudio && !audioProcess) {
    await startAudioCapture();
  }

  // Take screenshot (fast , ~200ms)
  const result = await captureScreenshot();
  if (!result) return;

  const { filePath, fileSize } = result;
  dedupe.updateSettings(config.dedupe);
  const dup = dedupe.check(filePath, fileSize);

  if (dup) {
    // Duplicate , delete immediately, insert minimal record
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
    insertFrame(timestamp, '', null, null, fileSize, true);
    captureCount++;
    lastCaptureAt = timestamp;
    return;
  }

  // Insert frame immediately with empty OCR (so capture loop isn't blocked)
  const s3Key = `${config.s3Prefix}/screenshots/${dateStr}/${path.basename(filePath)}`;
  const frameId = insertFrame(timestamp, '', s3Key, filePath, fileSize, false);
  captureCount++;
  lastCaptureAt = timestamp;

  // Background: OCR first, THEN S3 upload (file must exist for Tesseract)
  ocrScreenshot(filePath)
    .then((ocrText) => {
      if (ocrText) {
        try {
          updateFrameOcr(frameId, ocrText);
          console.log(`[timemachine] OCR'd frame ${frameId}: ${ocrText.length} chars`);
        } catch (e: any) {
          console.error(`[timemachine] updateFrameOcr failed:`, e.message);
        }
      } else {
        console.warn(`[timemachine] OCR returned empty for ${path.basename(filePath)}`);
      }

      // Only upload to S3 AFTER OCR is done (so file still exists for Tesseract)
      uploadToS3(filePath, s3Key)
        .then((ok) => {
          if (ok) {
            try {
              fs.unlinkSync(filePath);
            } catch {
              /* ignore */
            }
          }
        })
        .catch(() => {
          /* S3 failure , file stays local */
        });
    })
    .catch((err) => {
      console.error(`[timemachine] OCR error:`, err);
      // Still try S3 even if OCR fails
      uploadToS3(filePath, s3Key).catch(() => {});
    });
}

async function captureLoop(): Promise<void> {
  if (!running || paused) return;

  try {
    await captureOnce();
  } catch (err: any) {
    console.error('[timemachine] capture error:', err.message);
  }

  if (running && !paused) {
    const config = loadTimeMachineConfig();
    captureTimer = setTimeout(captureLoop, config.captureIntervalMs);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────

export async function startTimeMachine(): Promise<{ success: boolean; error?: string }> {
  if (running) return { success: false, error: 'Already running' };

  try {
    running = true;
    paused = false;
    captureCount = 0;
    privacyActive = false;
    privacyReason = null;
    privacySkipCount = 0;
    dedupe.updateSettings(loadTimeMachineConfig().dedupe);
    dedupe.reset();

    console.log('[timemachine] started');

    // Start audio capture
    await startAudioCapture();

    // Start screenshot capture loop
    captureLoop();

    return { success: true };
  } catch (err: any) {
    running = false;
    return { success: false, error: err.message };
  }
}

export async function stopTimeMachine(): Promise<void> {
  running = false;
  paused = false;

  if (captureTimer) {
    clearTimeout(captureTimer);
    captureTimer = null;
  }

  await stopAudioCapture();
  console.log('[timemachine] stopped');
}

export function pauseTimeMachine(): void {
  paused = true;
  if (captureTimer) {
    clearTimeout(captureTimer);
    captureTimer = null;
  }
}

export function resumeTimeMachine(): void {
  if (!running) return;
  paused = false;
  captureLoop();
}

export function getTimeMachineStatus(): TimeMachineStatus {
  return {
    running,
    paused,
    captureCount,
    lastCaptureAt,
    audioRecording: audioProcess !== null,
    conversationsToday: 0, // Updated by conversation detector
    privacyActive,
    privacyReason,
    privacySkipCount,
  };
}
