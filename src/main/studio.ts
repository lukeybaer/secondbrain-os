// studio.ts
// Direct FFmpeg multi-camera recording for SecondBrain Studio.
// Spawns one FFmpeg process per camera + screen. No OBS dependency.
// Auto-discovers connected cameras, records to MKV, remuxes to MP4.

import * as fs from 'fs';
import * as path from 'path';
import { app, BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import { getConfig } from './config';
import { planCameraFormats, startStagger, type CameraProbeResults } from './studio-policy';

// ─── Types ──────────────────────────────────────────────────────────────

export interface DetectedDevice {
  name: string;
  type: 'video' | 'audio';
}

export interface StudioCamera {
  id: string;
  name: string; // dshow device name (from auto-detect)
  audioDevice?: string; // paired audio device name
  position: 'front' | 'side' | 'overhead' | 'extra';
  enabled: boolean;
}

export interface StudioRecording {
  id: string;
  startedAt: string;
  stoppedAt?: string;
  durationSeconds?: number;
  cameras: StudioCamera[];
  files: Record<string, string>; // position → file path
  screenFile?: string;
  audioFile?: string;
  /** Wall-clock spawn time (Date.now() ms) per output file: positions + 'screen'. */
  syncAnchors?: Record<string, number>;
  status:
    | 'recording'
    | 'stopped'
    | 'transcribing'
    | 'analyzing'
    | 'rendering'
    | 'complete'
    | 'error';
  transcript?: StudioTranscript;
  edl?: EditDecision[];
  outputFiles?: {
    linkedin?: string;
    youtube?: string;
  };
  warnings?: string[];
  sourceIssues?: string[];
  error?: string;
  markers: StudioMarker[];
}

export interface StudioMarker {
  timestamp: number;
  type: 'retake' | 'highlight' | 'section';
  label?: string;
}

export interface StudioTranscript {
  words: TranscriptWord[];
  fullText: string;
  sections: TranscriptSection[];
}

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
}

export interface TranscriptSection {
  start: number;
  end: number;
  text: string;
  topic?: string;
}

export interface EditDecision {
  camera: string;
  start: number;
  end: number;
  type: 'intro' | 'key_point' | 'screen_demo' | 'transition' | 'conclusion' | 'b_roll';
  zoom?: number;
  transition?: 'cut' | 'crossfade';
}

export interface StudioConfig {
  recordingDir: string;
  defaultFormat: 'linkedin' | 'youtube' | 'both';
  lowerThirdName: string;
  lowerThirdTitle: string;
  recordScreen: boolean;
  useNvenc: boolean;
  cameras: StudioCamera[];
}

// ─── Paths ──────────────────────────────────────────────────────────────

function dataDir(): string {
  return path.join(app.getPath('userData'), 'data', 'studio');
}

function recordingsDir(): string {
  const config = loadStudioConfig();
  return config.recordingDir || path.join(dataDir(), 'recordings');
}

function configPath(): string {
  return path.join(dataDir(), 'config.json');
}

function recordingPath(id: string): string {
  return path.join(recordingsDir(), id);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Config ─────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: StudioConfig = {
  recordingDir: '',
  defaultFormat: 'both',
  lowerThirdName: 'the owner',
  lowerThirdTitle: 'VP Data Analytics',
  recordScreen: true,
  useNvenc: false,
  cameras: [],
};

export function loadStudioConfig(): StudioConfig {
  try {
    if (fs.existsSync(configPath())) {
      const raw = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
      return { ...DEFAULT_CONFIG, ...raw };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_CONFIG };
}

export function saveStudioConfig(config: Partial<StudioConfig>): StudioConfig {
  ensureDir(dataDir());
  const current = loadStudioConfig();
  const merged = { ...current, ...config };
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2));
  return merged;
}

// ─── Camera Discovery ───────────────────────────────────────────────────

// Cache device list — ffmpeg -list_devices hangs on repeated calls because
// dshow state gets corrupted. Cache for 60s, refreshable via Refresh button.
let cachedDevices: DetectedDevice[] | null = null;
let cachedDevicesAt = 0;
let detectDevicesInFlight: Promise<DetectedDevice[]> | null = null;
const DEVICE_CACHE_TTL = 600_000; // 10 minutes — dshow hangs on repeated calls

interface DetectDevicesOptions {
  force?: boolean;
}

export function clearDeviceCache(): void {
  cachedDevices = null;
  cachedDevicesAt = 0;
  console.log('[studio] Device cache cleared');
}

export async function detectDevices(options: DetectDevicesOptions = {}): Promise<DetectedDevice[]> {
  // Return cached results if fresh enough
  if (!options.force && cachedDevices && Date.now() - cachedDevicesAt < DEVICE_CACHE_TTL) {
    console.log(`[studio] Using cached devices (${cachedDevices.length} devices)`);
    return cachedDevices;
  }
  if (detectDevicesInFlight) {
    console.log('[studio] Reusing in-flight device detection');
    return detectDevicesInFlight;
  }

  detectDevicesInFlight = new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
      windowsHide: true,
    });

    let stderr = '';
    let resolved = false;

    const parseDevices = (): DetectedDevice[] => {
      const devices: DetectedDevice[] = [];
      for (const line of stderr.split('\n')) {
        if (line.includes('@device')) continue;
        const match = line.match(/\[dshow[^\]]*\]\s+"(.+?)"\s+\((video|audio)\)/);
        if (match) {
          devices.push({ name: match[1], type: match[2] as 'video' | 'audio' });
        }
      }
      console.log(
        `[studio] detectDevices found ${devices.length} devices: ${devices.map((d) => `${d.name} (${d.type})`).join(', ') || 'none'}`,
      );
      return devices;
    };

    ffmpeg.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Hard timeout: if device enumeration hangs, resolve with what we have
    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      console.warn('[studio] detectDevices timed out after 5s — using partial results');
      try {
        ffmpeg.kill();
      } catch {
        /* */
      }
      const devices = parseDevices();
      // Manual refresh/start must use the fresh device truth, even if fewer cameras are present.
      if (options.force || !cachedDevices || devices.length >= cachedDevices.length) {
        cachedDevices = devices;
        cachedDevicesAt = Date.now();
      } else if (cachedDevices) {
        console.log(
          `[studio] Keeping better cached results (${cachedDevices.length} > ${devices.length})`,
        );
        resolve(cachedDevices);
        return;
      }
      resolve(devices);
    }, 5000);

    ffmpeg.on('close', () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      const devices = parseDevices();
      // Manual refresh/start must use the fresh device truth, even if fewer cameras are present.
      if (options.force || !cachedDevices || devices.length >= cachedDevices.length) {
        cachedDevices = devices;
        cachedDevicesAt = Date.now();
      } else if (cachedDevices) {
        console.log(
          `[studio] Keeping better cached results (${cachedDevices.length} > ${devices.length})`,
        );
        resolve(cachedDevices);
        return;
      }
      resolve(devices);
    });

    ffmpeg.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      console.error('[studio] detectDevices spawn error:', err.message);
      reject(new Error(`FFmpeg not found: ${err.message}`));
    });
  });
  try {
    return await detectDevicesInFlight;
  } finally {
    detectDevicesInFlight = null;
  }
}

export async function detectCameras(): Promise<DetectedDevice[]> {
  let all: DetectedDevice[] = [];
  try {
    all = await detectDevices();
  } catch (err) {
    console.warn('[studio] detectDevices failed, will try built-in fallback:', err);
  }
  const cameras = all.filter((d) => d.type === 'video');

  // Fallback: if no cameras detected, probe common built-in camera names directly
  if (cameras.length === 0) {
    const fallbackNames = ['Integrated Camera', 'Integrated Webcam', 'USB Camera', 'HD Webcam'];
    for (const name of fallbackNames) {
      const works = await probeCameraByName(name);
      if (works) {
        console.log(`[studio] built-in camera fallback found: "${name}"`);
        cameras.push({ name, type: 'video' });
        break;
      }
    }
  }

  return cameras;
}

/** Probe whether a dshow video device name is valid by attempting a short ffmpeg open. */
async function probeCameraByName(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(
      'ffmpeg',
      ['-f', 'dshow', '-i', `video=${name}`, '-t', '0', '-f', 'null', '-'],
      { windowsHide: true },
    );
    let resolved = false;
    const finish = (ok: boolean) => {
      if (resolved) return;
      resolved = true;
      try {
        probe.kill();
      } catch {
        /* ok */
      }
      resolve(ok);
    };
    // If ffmpeg opens the device, stderr will contain "Input #0" — success
    probe.stderr?.on('data', (data: Buffer) => {
      if (data.toString().includes('Input #0')) finish(true);
    });
    probe.on('exit', (code) => finish(code === 0));
    probe.on('error', () => finish(false));
    setTimeout(() => finish(false), 5000);
  });
}

export async function detectAudioDevices(): Promise<DetectedDevice[]> {
  const all = await detectDevices();
  return all.filter((d) => d.type === 'audio');
}

// ─── NVENC Detection ────────────────────────────────────────────────────

export async function checkNvenc(): Promise<boolean> {
  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-encoders'], { windowsHide: true });
    let stdout = '';
    ffmpeg.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    ffmpeg.on('exit', () => {
      resolve(stdout.includes('h264_nvenc'));
    });
    ffmpeg.on('error', () => {
      resolve(false);
    });
  });
}

// ─── Camera Pre-Validation ─────────────────────────────────────────────

/** Fallback formats to try when the default dshow capture fails (e.g. USB 2.0 bandwidth). */
export const CAMERA_FALLBACK_FORMATS: Array<
  | {
      vcodec: string;
      videoSize: string;
    }
  | undefined
> = [
  { vcodec: 'mjpeg', videoSize: '1280x720' },
  { vcodec: 'mjpeg', videoSize: '640x480' },
  undefined, // retry with no forced format (let dshow negotiate)
];

/**
 * Validate that a camera can be opened by ffmpeg with a short 0.5s test capture.
 * Returns true if the capture succeeds (exit code 0).
 */
export function validateCamera(
  cameraName: string,
  forceFormat?: { vcodec: string; videoSize: string },
): Promise<boolean> {
  return new Promise((resolve) => {
    const args: string[] = ['-f', 'dshow'];
    if (forceFormat) {
      args.push('-vcodec', forceFormat.vcodec, '-video_size', forceFormat.videoSize);
    }
    args.push('-i', `video=${cameraName}`, '-t', '0.5', '-f', 'null', '-');

    const proc = spawn('ffmpeg', args, { windowsHide: true });
    let resolved = false;

    const finish = (ok: boolean) => {
      if (resolved) return;
      resolved = true;
      try {
        proc.kill();
      } catch {
        /* ok */
      }
      resolve(ok);
    };

    proc.on('exit', (code) => finish(code === 0));
    proc.on('error', () => finish(false));
    // Hard timeout — don't let a camera probe hang forever
    setTimeout(() => finish(false), 5000);
  });
}

// ─── FFmpeg Recording Processes ─────────────────────────────────────────

interface FFmpegSession {
  process: ChildProcess;
  outputPath: string;
  source: string;
  startTime: bigint;
  exited: boolean;
  exitCode?: number | null;
  stderrTail: string;
  observedFrames: number;
  lastProgressAtMs: number;
  lastBytes: number;
  lastByteAtMs: number;
  byteMonitor?: NodeJS.Timeout;
}

let activeSessions: FFmpegSession[] = [];
let activeRecording: StudioRecording | null = null;

// ─── Per-Camera Live Health ─────────────────────────────────────────────

export type CameraHealthStatus = 'starting' | 'recording' | 'died' | 'failed';

let cameraHealth: Record<string, CameraHealthStatus> = {};

export function getCameraHealth(): Record<string, CameraHealthStatus> {
  return { ...cameraHealth };
}

/** Push the current health map to the renderer on every change. */
function emitCameraHealth(): void {
  try {
    const win = BrowserWindow?.getAllWindows?.()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('studio:camera-health', getCameraHealth());
    }
  } catch {
    /* no window available (tests, headless) */
  }
}

function setCameraHealth(position: string, status: CameraHealthStatus): void {
  cameraHealth[position] = status;
  emitCameraHealth();
}

function resetCameraHealth(): void {
  cameraHealth = {};
  emitCameraHealth();
}

/** Mid-recording health monitor: detect source death during recording. */
function attachDeathMonitor(session: FFmpegSession, position: string, name: string): void {
  session.process.on('exit', (code) => {
    if (activeRecording && code !== 0 && code !== null) {
      const elapsed = Number(process.hrtime.bigint() - session.startTime) / 1e9;
      console.error(
        `[studio] CAMERA DIED: "${name}" (${position}) exited with code ${code} after ${elapsed.toFixed(1)}s`,
      );
      setCameraHealth(position, 'died');
    }
  });
}

// ─── Camera Probe Cache ─────────────────────────────────────────────────
// dshow opens are slow and flaky when hammered, so each camera is probed at
// most once per PROBE_CACHE_TTL before planning. A probe failure never
// blocks recording: the camera just keeps its full format plan.

const PROBE_CACHE_TTL = 600_000; // 10 minutes

const probeCache = new Map<string, { at: number; ok: boolean }>();

export function clearProbeCache(): void {
  probeCache.clear();
}

/** Seed probe results without spawning ffmpeg (tests, warm paths). */
export function seedProbeCache(names: string[], ok = true): void {
  for (const name of names) probeCache.set(name, { at: Date.now(), ok });
}

async function probeCameraCached(name: string): Promise<boolean> {
  const cached = probeCache.get(name);
  if (cached && Date.now() - cached.at < PROBE_CACHE_TTL) return cached.ok;
  let ok = false;
  try {
    ok = await probeCameraByName(name);
  } catch {
    ok = false;
  }
  probeCache.set(name, { at: Date.now(), ok });
  return ok;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const STARTUP_WARMUP_TIMEOUT_MS = 2000;
const STARTUP_MIN_BYTES = 1024;
const STARTUP_MIN_FRAMES = 1;
const MIN_FILE_SIZE = 1024;
const SOURCE_DURATION_TOLERANCE_SECONDS = 3;
// Static webcam footage compresses aggressively. ExampleCo's integrated camera produced
// about 4.7 KB/sec during a valid 15s capture, so keep the floor below that.
const MIN_CAMERA_BYTES_PER_SECOND = 2_000;

function buildCameraArgs(
  cameraName: string,
  audioDevice: string | undefined,
  outputPath: string,
  useNvenc: boolean,
  forceFormat?: { vcodec: string; videoSize: string },
): string[] {
  const args: string[] = ['-stats_period', '0.5', '-f', 'dshow', '-rtbufsize', '512M'];

  // If a fallback format is specified (e.g. MJPEG after default failed), force it
  if (forceFormat) {
    args.push(
      '-vcodec',
      forceFormat.vcodec,
      '-video_size',
      forceFormat.videoSize,
      '-framerate',
      '30',
    );
  }

  args.push('-i', audioDevice ? `video=${cameraName}:audio=${audioDevice}` : `video=${cameraName}`);

  if (useNvenc) {
    args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '18', '-b:v', '0');
  } else {
    args.push('-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-tune', 'film');
  }

  if (audioDevice) {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  }

  args.push('-y', outputPath);
  return args;
}

function buildScreenArgs(outputPath: string, _useNvenc: boolean, audioDevice?: string): string[] {
  const args: string[] = ['-stats_period', '0.5'];

  // Always use gdigrab — ddagrab + h264_nvenc fails with "Error while opening encoder"
  // because ddagrab outputs a pixel format NVENC can't accept directly.
  // gdigrab + libx264 ultrafast is fast enough and actually works.
  args.push('-f', 'gdigrab', '-framerate', '30', '-i', 'desktop');

  // Capture audio from microphone alongside screen
  if (audioDevice) {
    args.push('-f', 'dshow', '-i', `audio=${audioDevice}`);
  }

  // Explicit stream mapping required when combining gdigrab + dshow audio.
  // Without -map, FFmpeg's default "shortest stream wins" stops recording
  // when the dshow audio buffer times out (~8s).
  if (audioDevice) {
    args.push('-map', '0:v', '-map', '1:a');
  }

  args.push('-c:v', 'libx264', '-crf', '18', '-preset', 'ultrafast');

  if (audioDevice) {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  }

  args.push('-y', outputPath);
  return args;
}

function spawnFFmpeg(args: string[], source: string, outputPath: string): FFmpegSession {
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  const session: FFmpegSession = {
    process: proc,
    outputPath,
    source,
    startTime: process.hrtime.bigint(),
    exited: false,
    stderrTail: '',
    observedFrames: 0,
    lastProgressAtMs: 0,
    lastBytes: 0,
    lastByteAtMs: 0,
  };

  const pollOutputBytes = () => {
    try {
      if (!fs.existsSync(outputPath)) return;
      const size = fs.statSync(outputPath).size;
      if (size > session.lastBytes) {
        session.lastBytes = size;
        session.lastByteAtMs = Date.now();
      }
    } catch {
      /* file may not exist yet */
    }
  };

  session.byteMonitor = setInterval(pollOutputBytes, 500);
  session.byteMonitor.unref?.();

  proc.stderr?.on('data', (data: Buffer) => {
    const line = data.toString();
    session.stderrTail = (session.stderrTail + line).slice(-2000);
    const frameMatches = [...line.matchAll(/frame=\s*(\d+)/g)];
    for (const match of frameMatches) {
      const frames = Number(match[1]);
      if (Number.isFinite(frames) && frames > session.observedFrames) {
        session.observedFrames = frames;
        session.lastProgressAtMs = Date.now();
      }
    }
    pollOutputBytes();
    if (line.includes('Error') || line.includes('error')) {
      console.error(`[studio:${source}] ${line.trim()}`);
    }
  });

  proc.on('exit', (code) => {
    session.exited = true;
    session.exitCode = code;
    if (session.byteMonitor) clearInterval(session.byteMonitor);
    pollOutputBytes();
    if (code !== 0 && code !== null) {
      console.error(`[studio:${source}] FFmpeg exited with code ${code}`);
    }
  });

  proc.stdin?.on?.('error', (err: Error) => {
    console.warn(`[studio:${source}] FFmpeg stdin closed: ${err.message}`);
  });

  return session;
}

function stopFFmpegSession(session: FFmpegSession, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve) => {
    if (session.exited) {
      if (session.byteMonitor) clearInterval(session.byteMonitor);
      resolve(session.outputPath);
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (session.byteMonitor) clearInterval(session.byteMonitor);
      resolve(session.outputPath);
    };

    const timeout = setTimeout(() => {
      try {
        session.process.kill();
      } catch {
        /* already gone */
      }
      finish(); // MKV is still usable even on forced kill
    }, timeoutMs);

    session.process.once('exit', finish);

    // Graceful stop: send 'q' to stdin
    const stdin = session.process.stdin as any;
    if (stdin && stdin.writable !== false && !stdin.destroyed && !stdin.writableEnded) {
      try {
        stdin.write('q');
        stdin.end();
      } catch (err: any) {
        console.warn(`[studio:${session.source}] Could not send FFmpeg stop signal: ${err.message}`);
        try {
          session.process.kill();
        } catch {
          /* already gone */
        }
      }
    } else {
      try {
        session.process.kill();
      } catch {
        /* already gone */
      }
    }
  });
}

async function waitForSourceWarmup(
  session: FFmpegSession,
  label: string,
  timeoutMs = STARTUP_WARMUP_TIMEOUT_MS,
): Promise<{ ok: boolean; reason?: string }> {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, reason?: string) => {
      if (settled) return;
      settled = true;
      clearInterval(check);
      session.process.off?.('exit', onExit);
      resolve({ ok, reason });
    };

    const hasUsableSignal = () =>
      session.observedFrames >= STARTUP_MIN_FRAMES || session.lastBytes >= STARTUP_MIN_BYTES;

    const onExit = (code: number | null) => {
      finish(false, `${label} exited during startup with code ${code}`);
    };

    const check = setInterval(() => {
      if (hasUsableSignal()) {
        finish(true);
        return;
      }
      if (session.exited) {
        finish(false, `${label} exited during startup with code ${session.exitCode}`);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        finish(
          false,
          `${label} produced no usable video frames or file data within ${Math.round(timeoutMs / 1000)}s`,
        );
      }
    }, 100);
    check.unref?.();

    session.process.once('exit', onExit);
  });
}

function probeMediaDuration(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=nokey=1:noprint_wrappers=1',
        filePath,
      ],
      { windowsHide: true },
    );
    let stdout = '';
    let settled = false;

    const finish = (duration: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(duration);
    };

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      const duration = Number(stdout.trim());
      finish(Number.isFinite(duration) && duration > 0 ? duration : null);
    });

    proc.on('error', () => finish(null));

    const timeout = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      finish(null);
    }, 5000);
    timeout.unref?.();
  });
}

async function validateStoppedSource(
  position: string,
  filePath: string | undefined,
  expectedDurationSeconds: number | undefined,
  options: { camera: boolean },
): Promise<string | null> {
  if (!filePath || !fs.existsSync(filePath)) {
    return `${position} missing file`;
  }

  const stat = fs.statSync(filePath);
  if (stat.size < MIN_FILE_SIZE) {
    return `${position} file too small (${stat.size} bytes)`;
  }

  const duration = await probeMediaDuration(filePath);
  if (duration === null) return null;

  if (
    expectedDurationSeconds &&
    expectedDurationSeconds >= SOURCE_DURATION_TOLERANCE_SECONDS + 2 &&
    duration < expectedDurationSeconds - SOURCE_DURATION_TOLERANCE_SECONDS
  ) {
    return `${position} stopped early (${duration.toFixed(1)}s of ${expectedDurationSeconds}s)`;
  }

  if (options.camera && duration >= 3) {
    const bytesPerSecond = stat.size / duration;
    if (bytesPerSecond < MIN_CAMERA_BYTES_PER_SECOND) {
      return `${position} video data too low (${Math.round(bytesPerSecond)} bytes/sec)`;
    }
  }

  return null;
}

async function validateStoppedRecording(
  recording: StudioRecording,
  sessions: FFmpegSession[],
): Promise<string[]> {
  const issues: string[] = [];
  const expectedDuration = recording.durationSeconds;

  for (const session of sessions) {
    if (session.exitCode !== undefined && session.exitCode !== 0 && session.exitCode !== null) {
      issues.push(`${session.source} recorder died before stop`);
    }
  }

  for (const [position, filePath] of Object.entries(recording.files)) {
    const issue = await validateStoppedSource(position, filePath, expectedDuration, {
      camera: position !== 'screen',
    });
    if (issue) {
      console.warn(
        `[studio] Post-validation: dropping invalid source reference for "${position}": ${issue}`,
      );
      delete recording.files[position];
      issues.push(issue);
    }
  }

  if (recording.screenFile) {
    const issue = await validateStoppedSource('screen', recording.screenFile, expectedDuration, {
      camera: false,
    });
    if (issue) {
      console.warn(`[studio] Post-validation: dropping invalid screen source reference: ${issue}`);
      delete recording.files['screen'];
      recording.screenFile = undefined;
      issues.push(issue);
    }
  }

  return [...new Set(issues)];
}

// ─── Remux MKV → MP4 ───────────────────────────────────────────────────

async function remuxToMp4(mkvPath: string): Promise<string> {
  const mp4Path = mkvPath.replace(/\.mkv$/, '.mp4');
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-i', mkvPath, '-c', 'copy', '-y', mp4Path], {
      windowsHide: true,
    });
    proc.on('exit', (code) => {
      if (code === 0) resolve(mp4Path);
      else reject(new Error(`Remux failed for ${mkvPath}`));
    });
    proc.on('error', reject);
  });
}

// ─── Recording Management ───────────────────────────────────────────────

export interface StartRecordingOptions {
  cameras?: Array<{ id: string; name: string; position: string; enabled: boolean }>;
  audioDevice?: string;
}

export async function detectRecordingInputs(): Promise<StartRecordingOptions> {
  let devices: DetectedDevice[] = [];
  try {
    devices = await detectDevices({ force: true });
  } catch {
    /* keep empty */
  }
  const cameras = devices
    .filter((d) => d.type === 'video' && !d.name.includes('OBS'))
    .map((d, i) => ({
      id: `cam_${i}`,
      name: d.name,
      position: (['front', 'side', 'overhead', 'extra'] as const)[i] || 'extra',
      enabled: true,
    }));
  const audioDevice = devices.find((d) => d.type === 'audio')?.name;
  return { cameras, audioDevice };
}

export async function startRecording(opts?: StartRecordingOptions): Promise<{
  success: boolean;
  recordingId?: string;
  warnings?: string;
  error?: string;
}> {
  if (activeRecording) {
    return { success: false, error: 'Recording already in progress' };
  }

  // Kill any orphaned FFmpeg processes from previous failed recordings
  for (const session of activeSessions) {
    try {
      session.process.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }
  activeSessions = [];

  try {
    const config = loadStudioConfig();
    const id = `rec_${Date.now()}`;
    const recDir = recordingPath(id);
    ensureDir(recDir);

    // Use pre-resolved cameras/audio from IPC handler — no detection here.
    let cameras = opts?.cameras ?? config.cameras.filter((c) => c.enabled);
    const defaultAudioDevice = opts?.audioDevice ?? (config as any).defaultAudioDevice;

    if (cameras.length === 0) {
      return {
        success: false,
        error: 'No cameras available. Check that cameras are connected and click Refresh.',
      };
    }

    console.log(
      `[studio] startRecording: id=${id}, cameras=[${cameras.map((c) => c.name).join(', ')}], audio=${defaultAudioDevice ?? 'none'}`,
    );

    // Audio goes to screen recording ONLY — never to cameras.
    // dshow audio is exclusive on Windows: if a camera holds the mic,
    // the screen recording blocks until the camera dies, making
    // total time = camera_duration + screen_duration (serial, not parallel).
    console.log(`[studio] Audio will be captured by screen recording only`);

    activeSessions = [];
    const files: Record<string, string> = {};
    const syncAnchors: Record<string, number> = {};
    const startupFailures: string[] = [];
    resetCameraHealth();

    const recordingStartedAtMs = Date.now();

    // Start screen recording FIRST so audio capture begins immediately.
    // Camera probing/warmup can take seconds, causing the screen to start
    // late and be shorter than cameras if started after them.
    let screenFile: string | undefined;
    if (config.recordScreen) {
      const screenOutput = path.join(recDir, 'screen.mkv');
      const args = buildScreenArgs(screenOutput, config.useNvenc, defaultAudioDevice);
      const session = spawnFFmpeg(args, 'screen', screenOutput);
      syncAnchors['screen'] = Date.now();
      const warmup = await waitForSourceWarmup(session, 'screen');
      if (warmup.ok) {
        activeSessions.push(session);
        screenFile = screenOutput;
        setCameraHealth('screen', 'recording');
        attachDeathMonitor(session, 'screen', 'screen');
        console.log(`[studio] Screen recording started (with audio: ${!!defaultAudioDevice})`);
      } else {
        await stopFFmpegSession(session, 1000);
        setCameraHealth('screen', 'failed');
        startupFailures.push(warmup.reason || 'screen failed to start');
      }
    }

    if (startupFailures.length > 0) {
      activeSessions = [];
      resetCameraHealth();
      return {
        success: false,
        error: `Recording did not start because required source failed: ${startupFailures.join('; ')}`,
      };
    }

    // Probe each camera once (10-minute cache) before planning. Probe
    // results can drop formats a camera is known not to support; a probe
    // failure keeps the full plan (a probe never blocks recording).
    const probeResults: CameraProbeResults = {};
    for (const cam of cameras) {
      const probed = await probeCameraCached(cam.name);
      probeResults[cam.name] = probed ? {} : { probeFailed: true };
    }

    // USB bandwidth budget (see studio-policy.ts): cameras 1-2 keep
    // raw-default-first (NexiGo raw YUV proven stable 760s+; MJPEG 720p
    // dies at 60-160s on USB 2.0), cameras 3+ get MJPEG first, never raw.
    const plans = planCameraFormats(cameras, probeResults);
    const failedCameras: string[] = [];

    console.log(`[studio] Starting ${cameras.length} cameras sequentially (staggered)...`);
    for (let i = 0; i < cameras.length; i++) {
      const cam = cameras[i];
      const formatsToTry = plans[i].formats;

      // Staggered start: never open two dshow captures at the same instant.
      // Simultaneous opens are the main USB controller overload trigger.
      const waitMs = startStagger(i) - (Date.now() - recordingStartedAtMs);
      if (waitMs > 0) await sleep(waitMs);

      console.log(`[studio] Starting camera: "${cam.name}" (${cam.position})`);
      const outputFile = path.join(recDir, `${cam.position}.mkv`);
      setCameraHealth(cam.position, 'starting');

      let started = false;
      for (const fmt of formatsToTry) {
        const fmtLabel = fmt ? `${fmt.vcodec} ${fmt.videoSize}` : 'default';
        console.log(`[studio] Spawning ffmpeg for "${cam.name}" with ${fmtLabel}...`);
        const args = buildCameraArgs(cam.name, cam.audioDevice, outputFile, config.useNvenc, fmt);
        console.log(`[studio] ffmpeg args: ${args.join(' ')}`);
        const session = spawnFFmpeg(args, cam.position, outputFile);
        const spawnedAtMs = Date.now();
        console.log(`[studio] ffmpeg spawned for "${cam.name}", pid=${session.process.pid}`);

        const warmup = await waitForSourceWarmup(session, cam.name);

        if (warmup.ok) {
          console.log(`[studio] Camera "${cam.name}" started with: ${fmtLabel}`);
          activeSessions.push(session);
          files[cam.position] = outputFile;
          syncAnchors[cam.position] = spawnedAtMs;
          setCameraHealth(cam.position, 'recording');
          attachDeathMonitor(session, cam.position, cam.name);
          started = true;
          break;
        }
        console.warn(
          `[studio] Camera "${cam.name}" failed: ${fmtLabel}, ${warmup.reason || 'no usable startup signal'}, trying next...`,
        );
        await stopFFmpegSession(session, 1000);
      }

      if (!started) {
        console.error(`[studio] Camera "${cam.name}" failed all formats`);
        setCameraHealth(cam.position, 'failed');
        failedCameras.push(cam.name);
      }
    }

    let warnings: string | undefined;
    if (failedCameras.length > 0) {
      warnings = `${failedCameras.length} camera(s) failed: ${failedCameras.join(', ')}`;
      console.warn(`[studio] ${warnings}`);
    }

    if (failedCameras.length > 0) {
      await Promise.all(activeSessions.map((session) => stopFFmpegSession(session, 1000)));
      activeSessions = [];
      resetCameraHealth();
      return {
        success: false,
        error: `${warnings}. Recording requires every selected camera to produce usable video before it starts.`,
      };
    }

    // If nothing is recording at all, report error
    if (activeSessions.length === 0) {
      return {
        success: false,
        error: `All sources failed to start: ${failedCameras.join(', ')}. They may be in use by another app.`,
      };
    }

    activeRecording = {
      id,
      startedAt: new Date().toISOString(),
      cameras,
      files,
      screenFile,
      syncAnchors,
      status: 'recording',
      warnings: warnings ? [warnings] : undefined,
      markers: [],
    };

    saveRecording(activeRecording);
    return { success: true, recordingId: id, warnings };
  } catch (err: any) {
    await Promise.all(activeSessions.map((session) => stopFFmpegSession(session, 1000)));
    activeSessions = [];
    resetCameraHealth();
    return { success: false, error: err.message };
  }
}

export async function stopRecording(): Promise<{
  success: boolean;
  recording?: StudioRecording;
  error?: string;
}> {
  if (!activeRecording) {
    return { success: false, error: 'No active recording' };
  }

  try {
    // Stop all FFmpeg processes gracefully
    const stoppedSessions = [...activeSessions];
    await Promise.all(stoppedSessions.map((session) => stopFFmpegSession(session)));
    activeSessions = [];
    resetCameraHealth();

    activeRecording.stoppedAt = new Date().toISOString();

    const start = new Date(activeRecording.startedAt).getTime();
    const stop = new Date(activeRecording.stoppedAt).getTime();
    activeRecording.durationSeconds = Math.round((stop - start) / 1000);

    const sourceIssues = await validateStoppedRecording(activeRecording, stoppedSessions);
    if (sourceIssues.length > 0) {
      activeRecording.status = 'error';
      activeRecording.sourceIssues = sourceIssues;
      activeRecording.error = `Recording source failure: ${sourceIssues.join('; ')}`;
    } else {
      activeRecording.status = 'stopped';
    }

    // Remux surviving MKV files to MP4 (cameras + screen)
    const allMkvPaths = [
      ...Object.values(activeRecording.files),
      activeRecording.screenFile,
    ].filter(Boolean) as string[];

    for (const mkvPath of allMkvPaths) {
      if (mkvPath.endsWith('.mkv') && fs.existsSync(mkvPath)) {
        try {
          await remuxToMp4(mkvPath);
        } catch {
          // MKV is still usable if remux fails
        }
      }
    }

    saveRecording(activeRecording);
    const recording = { ...activeRecording };
    activeRecording = null;

    if (recording.status === 'stopped') {
      // Auto-process only after every selected source survived validation.
      console.log(`[studio] Auto-processing recording ${recording.id}`);
      processRecording(recording.id)
        .then((result) => {
          if (result.success) {
            console.log(`[studio] Auto-processing complete for ${recording.id}`);
          } else {
            console.error(`[studio] Auto-processing failed for ${recording.id}:`, result.error);
          }
        })
        .catch((err) => {
          console.error(`[studio] Auto-processing error for ${recording.id}:`, err);
        });
    } else {
      console.error(`[studio] Skipping auto-processing for ${recording.id}: ${recording.error}`);
    }

    return { success: true, recording };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export function addMarker(
  type: StudioMarker['type'],
  label?: string,
): { success: boolean; marker?: StudioMarker } {
  if (!activeRecording) return { success: false };

  const start = new Date(activeRecording.startedAt).getTime();
  const timestamp = (Date.now() - start) / 1000;
  const marker: StudioMarker = { timestamp, type, label };
  activeRecording.markers.push(marker);
  saveRecording(activeRecording);
  return { success: true, marker };
}

export function getActiveRecording(): StudioRecording | null {
  return activeRecording;
}

// ─── Recording Persistence ──────────────────────────────────────────────

function saveRecording(recording: StudioRecording): void {
  const recDir = recordingPath(recording.id);
  ensureDir(recDir);
  fs.writeFileSync(path.join(recDir, 'recording.json'), JSON.stringify(recording, null, 2));
}

export function loadRecording(id: string): StudioRecording | null {
  const recFile = path.join(recordingPath(id), 'recording.json');
  try {
    if (fs.existsSync(recFile)) {
      return JSON.parse(fs.readFileSync(recFile, 'utf-8'));
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function listRecordings(): StudioRecording[] {
  const dir = recordingsDir();
  ensureDir(dir);

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const recordings: StudioRecording[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const rec = loadRecording(entry.name);
    if (rec) recordings.push(rec);
  }

  recordings.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return recordings;
}

export async function deleteRecording(id: string): Promise<{ success: boolean; error?: string }> {
  const recDir = recordingPath(id);
  try {
    if (fs.existsSync(recDir)) {
      fs.rmSync(recDir, { recursive: true, force: true });
    }
    // Verify deletion actually worked (Windows can silently fail with locked files)
    if (fs.existsSync(recDir)) {
      return {
        success: false,
        error:
          'Directory still exists — files may be locked by video players. Try collapsing the recording first.',
      };
    }
    return { success: true };
  } catch (err: any) {
    console.error(`[studio] deleteRecording(${id}) failed:`, err.message);
    return { success: false, error: err.message };
  }
}

// ─── Pipeline Orchestration ─────────────────────────────────────────────

export async function processRecording(
  id: string,
  onProgress?: (stage: string, pct: number) => void,
): Promise<{ success: boolean; recording?: StudioRecording; error?: string }> {
  const recording = loadRecording(id);
  if (!recording) return { success: false, error: 'Recording not found' };

  try {
    // Clear any previous error from failed attempts
    delete recording.error;
    recording.status = 'transcribing';
    saveRecording(recording);
    onProgress?.('transcribing', 0);

    const { transcribeRecording } = await import('./studio-director');
    const transcript = await transcribeRecording(recording);
    recording.transcript = transcript;
    saveRecording(recording);
    onProgress?.('transcribing', 100);

    recording.status = 'analyzing';
    saveRecording(recording);
    onProgress?.('analyzing', 0);

    const { generateEDL } = await import('./studio-director');
    const edl = await generateEDL(recording, transcript);
    recording.edl = edl;
    saveRecording(recording);
    onProgress?.('analyzing', 100);

    recording.status = 'rendering';
    saveRecording(recording);
    onProgress?.('rendering', 0);

    const { renderFromEDL } = await import('./studio-render');
    const outputs = await renderFromEDL(recording, edl, (pct) => onProgress?.('rendering', pct));
    recording.outputFiles = outputs;
    recording.status = 'complete';
    saveRecording(recording);
    onProgress?.('rendering', 100);

    return { success: true, recording };
  } catch (err: any) {
    recording.status = 'error';
    recording.error = err.message;
    saveRecording(recording);
    return { success: false, error: err.message };
  }
}
