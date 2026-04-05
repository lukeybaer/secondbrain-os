// studio.ts
// Direct FFmpeg multi-camera recording for SecondBrain Studio.
// Spawns one FFmpeg process per camera + screen. No OBS dependency.
// Auto-discovers connected cameras, records to MKV, remuxes to MP4.

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import { getConfig } from './config';

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
  lowerThirdName: 'Luke Baer',
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

export async function detectDevices(): Promise<DetectedDevice[]> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);

    let stderr = '';
    ffmpeg.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Use 'close' not 'exit' — 'close' fires after all stdio streams are flushed
    ffmpeg.on('close', () => {
      const devices: DetectedDevice[] = [];

      for (const line of stderr.split('\n')) {
        // Skip @device alternative name lines
        if (line.includes('@device')) continue;
        // Match device lines: [dshow @ 0x...] "Device Name" (video|audio)
        const match = line.match(/\[dshow[^\]]*\]\s+"(.+?)"\s+\((video|audio)\)/);
        if (match) {
          devices.push({ name: match[1], type: match[2] as 'video' | 'audio' });
        }
      }

      console.log(
        `[studio] detectDevices found ${devices.length} devices: ${devices.map((d) => `${d.name} (${d.type})`).join(', ') || 'none'}`,
      );
      resolve(devices);
    });

    ffmpeg.on('error', (err) => {
      console.error('[studio] detectDevices spawn error:', err.message);
      reject(new Error(`FFmpeg not found: ${err.message}`));
    });
  });
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
    const probe = spawn('ffmpeg', [
      '-f',
      'dshow',
      '-i',
      `video=${name}`,
      '-t',
      '0',
      '-f',
      'null',
      '-',
    ]);
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
    const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-encoders']);
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

// ─── FFmpeg Recording Processes ─────────────────────────────────────────

interface FFmpegSession {
  process: ChildProcess;
  outputPath: string;
  source: string;
  startTime: bigint;
}

let activeSessions: FFmpegSession[] = [];
let activeRecording: StudioRecording | null = null;

function buildCameraArgs(
  cameraName: string,
  audioDevice: string | undefined,
  outputPath: string,
  useNvenc: boolean,
): string[] {
  // Don't force mjpeg/resolution — let dshow negotiate with built-in cameras
  const args: string[] = [
    '-f',
    'dshow',
    '-rtbufsize',
    '512M',
    '-i',
    audioDevice ? `video=${cameraName}:audio=${audioDevice}` : `video=${cameraName}`,
  ];

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

function buildScreenArgs(outputPath: string, useNvenc: boolean, audioDevice?: string): string[] {
  const args: string[] = [];

  if (useNvenc) {
    args.push('-f', 'lavfi', '-i', 'ddagrab=framerate=30');
  } else {
    // CPU fallback: gdigrab
    args.push('-f', 'gdigrab', '-framerate', '30', '-i', 'desktop');
  }

  // Capture audio from microphone alongside screen
  if (audioDevice) {
    args.push('-f', 'dshow', '-i', `audio=${audioDevice}`);
  }

  if (useNvenc) {
    args.push('-c:v', 'h264_nvenc', '-cq', '18');
  } else {
    args.push('-c:v', 'libx264', '-crf', '18', '-preset', 'ultrafast');
  }

  if (audioDevice) {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  }

  args.push('-y', outputPath);
  return args;
}

function spawnFFmpeg(args: string[], source: string, outputPath: string): FFmpegSession {
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

  proc.stderr?.on('data', (data: Buffer) => {
    const line = data.toString();
    if (line.includes('Error') || line.includes('error')) {
      console.error(`[studio:${source}] ${line.trim()}`);
    }
  });

  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[studio:${source}] FFmpeg exited with code ${code}`);
    }
  });

  return {
    process: proc,
    outputPath,
    source,
    startTime: process.hrtime.bigint(),
  };
}

function stopFFmpegSession(session: FFmpegSession): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      session.process.kill();
      resolve(session.outputPath); // MKV is still usable even on forced kill
    }, 10000);

    session.process.on('exit', () => {
      clearTimeout(timeout);
      resolve(session.outputPath);
    });

    // Graceful stop: send 'q' to stdin
    if (session.process.stdin) {
      session.process.stdin.write('q');
      session.process.stdin.end();
    }
  });
}

// ─── Remux MKV → MP4 ───────────────────────────────────────────────────

async function remuxToMp4(mkvPath: string): Promise<string> {
  const mp4Path = mkvPath.replace(/\.mkv$/, '.mp4');
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-i', mkvPath, '-c', 'copy', '-y', mp4Path]);
    proc.on('exit', (code) => {
      if (code === 0) resolve(mp4Path);
      else reject(new Error(`Remux failed for ${mkvPath}`));
    });
    proc.on('error', reject);
  });
}

// ─── Recording Management ───────────────────────────────────────────────

export async function startRecording(): Promise<{
  success: boolean;
  recordingId?: string;
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

    // Get enabled cameras (auto-detected or configured)
    let cameras = config.cameras.filter((c) => c.enabled);

    // If no cameras configured, auto-detect all connected cameras
    if (cameras.length === 0) {
      const detected = await detectCameras();
      cameras = detected.map((d, i) => ({
        id: `cam_${i}`,
        name: d.name,
        position: (['front', 'side', 'overhead', 'extra'] as const)[i] || 'extra',
        enabled: true,
      }));
    }

    if (cameras.length === 0) {
      return {
        success: false,
        error:
          'No cameras detected (including built-in). Check that no other app is using the camera.',
      };
    }

    // Auto-detect audio device (microphone) BEFORE starting any recordings
    let defaultAudioDevice: string | undefined;
    try {
      const audioDevs = await detectAudioDevices();
      if (audioDevs.length > 0) {
        defaultAudioDevice = audioDevs[0].name;
        console.log(`[studio] Using audio device: "${defaultAudioDevice}"`);
      }
    } catch {
      /* best-effort */
    }

    // Attach microphone to the real camera (not OBS Virtual Camera)
    if (defaultAudioDevice) {
      const realCam =
        cameras.find(
          (c) =>
            !c.audioDevice &&
            !c.name.toLowerCase().includes('obs') &&
            !c.name.toLowerCase().includes('virtual'),
        ) || cameras.find((c) => !c.audioDevice);
      if (realCam) {
        realCam.audioDevice = defaultAudioDevice;
        console.log(`[studio] Attached mic to camera: "${realCam.name}" (${realCam.position})`);
      }
    }

    activeSessions = [];
    const files: Record<string, string> = {};

    // Start all camera FFmpeg processes in parallel
    const cameraResults = await Promise.all(
      cameras.map(async (cam) => {
        const outputFile = path.join(recDir, `${cam.position}.mkv`);
        const args = buildCameraArgs(cam.name, cam.audioDevice, outputFile, config.useNvenc);
        const session = spawnFFmpeg(args, cam.position, outputFile);

        // Wait briefly to see if FFmpeg dies immediately (camera locked / I/O error)
        const alive = await new Promise<boolean>((resolve) => {
          const check = setTimeout(() => resolve(true), 1000);
          session.process.on('exit', (code) => {
            clearTimeout(check);
            if (code !== 0) {
              console.error(`[studio] Camera "${cam.name}" failed to start (code ${code})`);
            }
            resolve(code === 0);
          });
        });

        return { cam, session, outputFile, alive };
      }),
    );

    const failedCameras: string[] = [];
    for (const r of cameraResults) {
      if (r.alive) {
        activeSessions.push(r.session);
        files[r.cam.position] = r.outputFile;
      } else {
        failedCameras.push(r.cam.name);
      }
    }

    if (failedCameras.length > 0) {
      console.warn(
        `[studio] ${failedCameras.length} camera(s) failed: ${failedCameras.join(', ')}`,
      );
    }

    // If ALL cameras failed, report the error
    if (activeSessions.length === 0 && !config.recordScreen) {
      return {
        success: false,
        error: `All cameras failed to start: ${failedCameras.join(', ')}. They may be in use by another app.`,
      };
    }

    // Start screen recording if enabled
    let screenFile: string | undefined;
    if (config.recordScreen) {
      const screenOutput = path.join(recDir, 'screen.mkv');
      const args = buildScreenArgs(screenOutput, config.useNvenc, defaultAudioDevice);
      const session = spawnFFmpeg(args, 'screen', screenOutput);
      activeSessions.push(session);
      screenFile = screenOutput;
    }

    activeRecording = {
      id,
      startedAt: new Date().toISOString(),
      cameras,
      files,
      screenFile,
      status: 'recording',
      markers: [],
    };

    saveRecording(activeRecording);
    return { success: true, recordingId: id };
  } catch (err: any) {
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
    const results = await Promise.all(activeSessions.map(stopFFmpegSession));
    activeSessions = [];

    activeRecording.stoppedAt = new Date().toISOString();
    activeRecording.status = 'stopped';

    const start = new Date(activeRecording.startedAt).getTime();
    const stop = new Date(activeRecording.stoppedAt).getTime();
    activeRecording.durationSeconds = Math.round((stop - start) / 1000);

    // Remux all MKV files to MP4
    for (const mkvPath of results) {
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

    // Auto-process: kick off transcription + EDL + render in the background
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
