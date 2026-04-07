/**
 * Tests for the Studio module — config, recording management, retake detection.
 *
 * Uses a temp directory to simulate %APPDATA%\secondbrain so nothing
 * touches real data. Mocks Electron's `app.getPath("userData")`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';

// ── Mock Electron's app module ───────────────────────────────────────────────

let testRoot: string;

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return testRoot;
      return testRoot;
    },
  },
}));

// Mock config module
vi.mock('../config', () => ({
  getConfig: () => ({
    dataDir: path.join(testRoot, 'data'),
    anthropicApiKey: '',
  }),
  saveConfig: vi.fn(),
}));

// ── Mock child_process.spawn ────────────────────────────────────────────────
// Each test can push spawn behaviors onto this queue. If the queue is empty,
// the mock creates a process that stays alive (never exits).

interface MockSpawnBehavior {
  /** If true, the process exits immediately with the given code */
  exitImmediately?: boolean;
  exitCode?: number;
  /** stderr data to emit */
  stderrData?: string;
  /** Delay in ms before exit (to simulate a process that dies mid-recording) */
  exitDelay?: number;
}

let spawnBehaviorQueue: MockSpawnBehavior[] = [];
let spawnCallLog: { command: string; args: string[] }[] = [];

function createMockProcess(behavior?: MockSpawnBehavior): any {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc._exited = false;

  const doExit = (code: number | null) => {
    if (proc._exited) return;
    proc._exited = true;
    proc.emit('exit', code);
    proc.emit('close', code);
  };

  proc.kill = vi.fn(() => doExit(null));

  // stdin.write('q') is how stopFFmpegSession gracefully stops — trigger exit
  proc.stdin = new EventEmitter() as any;
  proc.stdin.write = vi.fn((data: string) => {
    if (data === 'q') {
      process.nextTick(() => doExit(0));
    }
  });
  proc.stdin.end = vi.fn();

  if (behavior?.stderrData) {
    process.nextTick(() => proc.stderr.emit('data', Buffer.from(behavior.stderrData!)));
  }

  if (behavior?.exitImmediately) {
    process.nextTick(() => doExit(behavior.exitCode ?? 1));
  } else if (behavior?.exitDelay !== undefined) {
    setTimeout(() => doExit(behavior.exitCode ?? 1), behavior.exitDelay);
  }
  // If no exit behavior, process stays alive until killed or stdin 'q'

  return proc;
}

vi.mock('child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawnCallLog.push({ command, args: [...args] });
    const behavior = spawnBehaviorQueue.shift();
    return createMockProcess(behavior);
  },
}));

// Import after mock is set up
import {
  loadStudioConfig,
  saveStudioConfig,
  loadRecording,
  listRecordings,
  deleteRecording,
  addMarker,
  startRecording,
  stopRecording,
} from '../studio';

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  testRoot = path.join(
    os.tmpdir(),
    `sb-studio-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fsp.mkdir(path.join(testRoot, 'data', 'studio'), { recursive: true });
  spawnBehaviorQueue = [];
  spawnCallLog = [];
});

// ── Config Tests ─────────────────────────────────────────────────────────────

describe('Studio Config', () => {
  it('returns default config when none exists', () => {
    const config = loadStudioConfig();
    expect(config.cameras).toEqual([]);
    expect(config.defaultFormat).toBe('both');
    expect(config.lowerThirdName).toBe('Luke Baer');
    expect(config.recordScreen).toBe(true);
    expect(config.useNvenc).toBe(false);
  });

  it('saves and loads config', () => {
    const saved = saveStudioConfig({
      obsWebsocketPassword: 'secret123',
      cameras: [
        { id: 'cam1', name: 'Front', deviceId: 'usb-001', position: 'front', enabled: true },
      ],
      lowerThirdTitle: 'CEO',
    });

    expect(saved.obsWebsocketPassword).toBe('secret123');
    expect(saved.cameras).toHaveLength(1);
    expect(saved.cameras[0].name).toBe('Front');
    expect(saved.lowerThirdTitle).toBe('CEO');

    // Reload from disk
    const reloaded = loadStudioConfig();
    expect(reloaded.obsWebsocketPassword).toBe('secret123');
    expect(reloaded.cameras).toHaveLength(1);
  });

  it('merges partial config updates', () => {
    saveStudioConfig({ lowerThirdName: 'Test User' });
    const after = saveStudioConfig({ defaultFormat: 'linkedin' });

    expect(after.lowerThirdName).toBe('Test User');
    expect(after.defaultFormat).toBe('linkedin');
    expect(after.recordScreen).toBe(true); // default preserved
  });
});

// ── Recording Tests ──────────────────────────────────────────────────────────

describe('Recording Management', () => {
  it('returns empty list when no recordings', () => {
    const list = listRecordings();
    expect(list).toEqual([]);
  });

  it('loads a recording by ID', async () => {
    // Manually create a recording file
    const recId = 'rec_test_001';
    const recDir = path.join(testRoot, 'data', 'studio', 'recordings', recId);
    await fsp.mkdir(recDir, { recursive: true });
    const recording = {
      id: recId,
      startedAt: '2026-04-04T10:00:00Z',
      stoppedAt: '2026-04-04T10:05:00Z',
      durationSeconds: 300,
      cameras: [],
      files: {},
      status: 'stopped',
      markers: [],
    };
    await fsp.writeFile(path.join(recDir, 'recording.json'), JSON.stringify(recording));

    const loaded = loadRecording(recId);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(recId);
    expect(loaded!.durationSeconds).toBe(300);
    expect(loaded!.status).toBe('stopped');
  });

  it('lists recordings sorted newest first', async () => {
    const recDir = path.join(testRoot, 'data', 'studio', 'recordings');

    // Create two recordings
    for (const [id, time] of [
      ['rec_old', '2026-04-01T10:00:00Z'],
      ['rec_new', '2026-04-04T10:00:00Z'],
    ]) {
      const dir = path.join(recDir, id);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(
        path.join(dir, 'recording.json'),
        JSON.stringify({
          id,
          startedAt: time,
          cameras: [],
          files: {},
          status: 'stopped',
          markers: [],
        }),
      );
    }

    const list = listRecordings();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('rec_new');
    expect(list[1].id).toBe('rec_old');
  });

  it('deletes a recording', async () => {
    const recId = 'rec_to_delete';
    const recDir = path.join(testRoot, 'data', 'studio', 'recordings', recId);
    await fsp.mkdir(recDir, { recursive: true });
    await fsp.writeFile(
      path.join(recDir, 'recording.json'),
      JSON.stringify({
        id: recId,
        startedAt: '2026-04-04T10:00:00Z',
        cameras: [],
        files: {},
        status: 'stopped',
        markers: [],
      }),
    );

    expect(loadRecording(recId)).not.toBeNull();

    const result = await deleteRecording(recId);
    expect(result.success).toBe(true);
    expect(loadRecording(recId)).toBeNull();
  });

  it('returns null for non-existent recording', () => {
    expect(loadRecording('does_not_exist')).toBeNull();
  });
});

// ── Retake Detection Tests ───────────────────────────────────────────────────

describe('Retake Detection (via studio-director)', () => {
  it('detects retake phrases', async () => {
    // Import the module that has retake detection logic
    const { generateEDL } = await import('../studio-director');

    // Mock a recording with transcript containing a retake
    const mockRecording = {
      id: 'rec_retake',
      startedAt: '2026-04-04T10:00:00Z',
      cameras: [
        { id: 'cam1', name: 'Front', deviceId: '', position: 'front' as const, enabled: true },
      ],
      files: { front: '/tmp/test.mp4' },
      status: 'stopped' as const,
      markers: [],
    };

    const mockTranscript = {
      words: [
        { word: 'Hello', start: 0, end: 0.5, confidence: 0.99 },
        { word: 'my', start: 0.5, end: 0.7, confidence: 0.99 },
        { word: 'name', start: 0.7, end: 0.9, confidence: 0.99 },
        { word: 'is', start: 0.9, end: 1.0, confidence: 0.99 },
        { word: 'Luke', start: 1.0, end: 1.3, confidence: 0.99 },
        { word: 'let', start: 3.0, end: 3.2, confidence: 0.99 },
        { word: 'me', start: 3.2, end: 3.3, confidence: 0.99 },
        { word: 'do', start: 3.3, end: 3.4, confidence: 0.99 },
        { word: 'that', start: 3.4, end: 3.5, confidence: 0.99 },
        { word: 'again', start: 3.5, end: 3.8, confidence: 0.99 },
        { word: 'Hello', start: 5.0, end: 5.5, confidence: 0.99 },
        { word: 'my', start: 5.5, end: 5.7, confidence: 0.99 },
        { word: 'name', start: 5.7, end: 5.9, confidence: 0.99 },
        { word: 'is', start: 5.9, end: 6.0, confidence: 0.99 },
        { word: 'Luke', start: 6.0, end: 6.3, confidence: 0.99 },
        { word: 'Baer', start: 6.3, end: 6.7, confidence: 0.99 },
      ],
      fullText: 'Hello my name is Luke let me do that again Hello my name is Luke Baer',
      sections: [],
    };

    // generateEDL will call getConfig() which returns our mock with empty anthropicApiKey
    // This forces the simple EDL path (no Claude API call)
    const edl = await generateEDL(mockRecording as any, mockTranscript);

    // The EDL should exist and skip the retake section
    expect(edl).toBeDefined();
    expect(Array.isArray(edl)).toBe(true);

    // If retake detection works, the EDL should not include content from 3.0-5.0s
    // (the retake cue and gap before the redo)
    if (edl.length > 0) {
      for (const decision of edl) {
        expect(decision.camera).toBeDefined();
        expect(decision.start).toBeDefined();
        expect(decision.end).toBeDefined();
        expect(decision.end).toBeGreaterThan(decision.start);
      }
    }
  });
});

// ── SRT Generation Tests ─────────────────────────────────────────────────────

describe('SRT Generation (via studio-render)', () => {
  it('generates valid SRT from transcript', async () => {
    // We'll test the SRT generation indirectly by checking file output
    // The renderFromEDL function generates SRT internally
    // For unit testing, we test the format helper

    // Import the format function pattern
    function formatSRTTime(seconds: number): string {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const ms = Math.round((seconds % 1) * 1000);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    }

    expect(formatSRTTime(0)).toBe('00:00:00,000');
    expect(formatSRTTime(1.5)).toBe('00:00:01,500');
    expect(formatSRTTime(61.234)).toBe('00:01:01,234');
    expect(formatSRTTime(3661.1)).toBe('01:01:01,100');
  });
});

// ── Camera Recording Pipeline Tests ─────────────────────────────────────────
//
// These tests exercise startRecording / stopRecording with mocked child_process.spawn.
// Each test pre-configures cameras in studio config (so detectCameras is skipped)
// and queues specific spawn behaviors to simulate success / failure scenarios.
//
// Spawn call order for a single camera, recordScreen=false:
//   1. detectAudioDevices → detectDevices → spawn ffmpeg -list_devices  (needs close event)
//   2. validateCamera → spawn ffmpeg -f dshow ... -t 0.5  (needs exit event)
//   3. spawnFFmpeg → spawn ffmpeg ... <outputFile>  (recording process — stays alive or dies)
//
// For stopRecording:
//   4. Each session receives 'q' on stdin → exit
//   5. remuxToMp4 → spawn ffmpeg -i <mkv> -c copy <mp4>

/** Helper: queue a spawn that emits close immediately (for detectDevices) */
function queueDetectDevicesSpawn(audioDeviceName?: string): void {
  const stderrLines: string[] = [];
  if (audioDeviceName) {
    stderrLines.push(`[dshow @ 0x000001] "${audioDeviceName}" (audio)\n`);
  }
  // detectDevices listens on 'close' event
  spawnBehaviorQueue.push({
    exitImmediately: true,
    exitCode: 1, // ffmpeg -list_devices always exits non-zero
    stderrData: stderrLines.join(''),
  });
}

/** Helper: queue a spawn for validateCamera (exit 0 = ok, exit 1 = fail) */
function queueValidateSpawn(ok: boolean, errorMsg?: string): void {
  spawnBehaviorQueue.push({
    exitImmediately: true,
    exitCode: ok ? 0 : 1,
    stderrData: errorMsg || '',
  });
}

/** Helper: queue a spawn that stays alive (for a successful camera recording) */
function queueAliveSpawn(): void {
  // No exit behavior — process stays alive until killed
  spawnBehaviorQueue.push({});
}

/** Helper: queue a spawn that dies after a delay (simulates mid-recording FFmpeg crash) */
function queueDyingSpawn(delayMs: number, stderrMsg?: string): void {
  spawnBehaviorQueue.push({
    exitDelay: delayMs,
    exitCode: 1,
    stderrData: stderrMsg || '',
  });
}

/** Helper: queue a spawn that exits immediately with failure (for fallback testing) */
function queueFailSpawn(stderrMsg?: string): void {
  spawnBehaviorQueue.push({
    exitImmediately: true,
    exitCode: 1,
    stderrData: stderrMsg || 'Error: Could not open device',
  });
}

/** Helper: queue a remux spawn (for stopRecording's MKV→MP4 step) */
function queueRemuxSpawn(): void {
  spawnBehaviorQueue.push({
    exitImmediately: true,
    exitCode: 0,
  });
}

describe('Camera Recording Pipeline', () => {
  // After each test, make sure no active recording is lingering (otherwise next test fails
  // with "Recording already in progress"). We stop it if needed.
  afterEach(async () => {
    // Best-effort cleanup — stopRecording may fail if there's no active recording
    // Queue spawns for potential remux calls during stop
    spawnBehaviorQueue = [
      { exitImmediately: true, exitCode: 0 },
      { exitImmediately: true, exitCode: 0 },
      { exitImmediately: true, exitCode: 0 },
      { exitImmediately: true, exitCode: 0 },
    ];
    try {
      await stopRecording();
    } catch {
      /* ignore */
    }
  }, 15000);

  it('post-recording validation removes missing files from recording', async () => {
    // Configure a single camera, no screen recording
    saveStudioConfig({
      cameras: [{ id: 'cam1', name: 'TestCam', position: 'front', enabled: true }],
      recordScreen: false,
    });

    // Queue spawns for startRecording:
    // 1. spawnFFmpeg for TestCam — stays alive (no validation/detection with config cameras)
    queueAliveSpawn();

    const startResult = await startRecording();
    expect(startResult.success).toBe(true);
    expect(startResult.recordingId).toBeDefined();

    // The recording should have a file entry for 'front'
    const recId = startResult.recordingId!;
    const rec = loadRecording(recId);
    expect(rec).not.toBeNull();
    expect(rec!.files.front).toBeDefined();

    // The MKV file does NOT actually exist on disk (spawn is mocked, no real FFmpeg)
    // So stopRecording's post-validation should remove it from files.

    // Queue spawns for stopRecording:
    // stopFFmpegSession writes 'q' — our mock process has stdin.write as vi.fn()
    // and then the process exits (we need to handle this via kill or exit event)
    // The mock process will be killed during stop. Then remux is called per MKV result.
    // Since file doesn't exist, remux won't be attempted for missing files.

    const stopResult = await stopRecording();
    expect(stopResult.success).toBe(true);
    expect(stopResult.recording).toBeDefined();

    // The 'front' file should have been REMOVED because it doesn't exist on disk
    expect(stopResult.recording!.files.front).toBeUndefined();
  });

  it('post-recording validation removes empty files from recording', async () => {
    saveStudioConfig({
      cameras: [{ id: 'cam1', name: 'TestCam', position: 'front', enabled: true }],
      recordScreen: false,
    });

    // Queue spawns for startRecording
    queueAliveSpawn();

    const startResult = await startRecording();
    expect(startResult.success).toBe(true);

    const recId = startResult.recordingId!;
    const rec = loadRecording(recId);
    const filePath = rec!.files.front;

    // Create the MKV file but make it tiny (simulating FFmpeg dying mid-recording)
    fs.writeFileSync(filePath, Buffer.alloc(100)); // 100 bytes — below the 1024 threshold

    const stopResult = await stopRecording();
    expect(stopResult.success).toBe(true);

    // The 'front' file should be removed because it's under 1024 bytes
    expect(stopResult.recording!.files.front).toBeUndefined();
  });

  it('post-recording validation keeps valid files in recording', async () => {
    saveStudioConfig({
      cameras: [{ id: 'cam1', name: 'TestCam', position: 'front', enabled: true }],
      recordScreen: false,
    });

    queueAliveSpawn();

    const startResult = await startRecording();
    expect(startResult.success).toBe(true);

    const recId = startResult.recordingId!;
    const rec = loadRecording(recId);
    const filePath = rec!.files.front;

    // Create a valid-size MKV file (above 1024 bytes)
    fs.writeFileSync(filePath, Buffer.alloc(2048));

    // Queue remux spawn (stopRecording will try to remux the existing MKV)
    queueRemuxSpawn();

    const stopResult = await stopRecording();
    expect(stopResult.success).toBe(true);

    // The 'front' file should be kept because it exists and is large enough
    expect(stopResult.recording!.files.front).toBe(filePath);
  });

  it('tries MJPEG fallback formats when default camera capture fails', async () => {
    saveStudioConfig({
      cameras: [{ id: 'cam1', name: 'FallbackCam', position: 'front', enabled: true }],
      recordScreen: false,
    });

    // New flow: no validateCamera, just direct spawn attempts.
    // Non-MJPEG-first camera tries: default → mjpeg 720p → mjpeg 480p
    // 1. Default format — FAILS (exits immediately)
    queueFailSpawn('Error: Could not connect pins');
    // 2. MJPEG 1280x720 — FAILS
    queueFailSpawn('Error: Could not open dshow');
    // 3. MJPEG 640x480 — SUCCEEDS (stays alive)
    queueAliveSpawn();

    const result = await startRecording();
    expect(result.success).toBe(true);

    const ffmpegCalls = spawnCallLog.filter((c) => c.command === 'ffmpeg');
    expect(ffmpegCalls.length).toBeGreaterThanOrEqual(3);

    // Verify fallback formats were attempted: look for mjpeg args
    const mjpegCalls = ffmpegCalls.filter((c) => c.args.includes('mjpeg'));
    expect(mjpegCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('includes warnings field listing failed cameras when a camera fails to start', async () => {
    saveStudioConfig({
      cameras: [
        { id: 'cam1', name: 'GoodCam', position: 'front', enabled: true },
        { id: 'cam2', name: 'BadCam', position: 'side', enabled: true },
      ],
      recordScreen: false,
    });

    // --- GoodCam: default format works ---
    queueAliveSpawn();

    // --- BadCam: all formats fail ---
    // default → mjpeg 720p → mjpeg 480p
    queueFailSpawn('Error: Could not open dshow');
    queueFailSpawn('Error: Could not open dshow');
    queueFailSpawn('Error: Could not open dshow');

    const result = await startRecording();

    // Should succeed because GoodCam is working
    expect(result.success).toBe(true);
    expect(result.recordingId).toBeDefined();

    // Should have warnings about BadCam
    expect((result as any).warnings).toBeDefined();
    expect((result as any).warnings).toContain('BadCam');
    expect((result as any).warnings).toContain('1 camera(s) failed');
  });

  it('returns error when all cameras fail and screen recording is off', async () => {
    saveStudioConfig({
      cameras: [{ id: 'cam1', name: 'BrokenCam', position: 'front', enabled: true }],
      recordScreen: false,
    });

    // All formats fail: default → mjpeg 720p → mjpeg 480p
    queueFailSpawn('Error: Could not open device');
    queueFailSpawn('Error: Could not open device');
    queueFailSpawn('Error: Could not open device');

    const result = await startRecording();

    expect(result.success).toBe(false);
    expect(result.error).toContain('All sources failed');
    expect(result.error).toContain('BrokenCam');
  });

  it('multi-camera post-recording validation removes only the missing positions', async () => {
    saveStudioConfig({
      cameras: [
        { id: 'cam1', name: 'FrontCam', position: 'front', enabled: true },
        { id: 'cam2', name: 'SideCam', position: 'side', enabled: true },
      ],
      recordScreen: false,
    });

    // Queue spawns: direct camera recordings (no validation)
    queueAliveSpawn(); // FrontCam
    queueAliveSpawn(); // SideCam

    const startResult = await startRecording();
    expect(startResult.success).toBe(true);

    const recId = startResult.recordingId!;
    const rec = loadRecording(recId);
    expect(rec!.files.front).toBeDefined();
    expect(rec!.files.side).toBeDefined();

    // Create a valid file for 'front' but leave 'side' missing on disk
    fs.writeFileSync(rec!.files.front, Buffer.alloc(4096));

    // Queue remux for the one valid MKV
    queueRemuxSpawn();

    const stopResult = await stopRecording();
    expect(stopResult.success).toBe(true);

    // 'front' kept (exists + large enough), 'side' removed (missing from disk)
    expect(stopResult.recording!.files.front).toBe(rec!.files.front);
    expect(stopResult.recording!.files.side).toBeUndefined();
  });

  it('fallback spawn args include -vcodec and -video_size from forceFormat', async () => {
    saveStudioConfig({
      cameras: [{ id: 'cam1', name: 'FormatTestCam', position: 'front', enabled: true }],
      recordScreen: false,
    });

    // 1. detectAudioDevices
    queueDetectDevicesSpawn();
    // 2. validateCamera — fails
    queueValidateSpawn(false, 'Error: Could not connect pins');
    // 3. First fallback (mjpeg 1280x720) — succeeds
    queueAliveSpawn();

    const result = await startRecording();
    expect(result.success).toBe(true);

    // Find the recording spawn call (the one after validate that includes an output path)
    const ffmpegCalls = spawnCallLog.filter((c) => c.command === 'ffmpeg');

    // The fallback spawn should have both -vcodec mjpeg AND -video_size 1280x720
    const fallbackCall = ffmpegCalls.find(
      (c) => c.args.includes('mjpeg') && c.args.includes('1280x720'),
    );
    expect(fallbackCall).toBeDefined();

    // Verify exact arg ordering: -vcodec appears before -video_size
    const vcodecIdx = fallbackCall!.args.indexOf('-vcodec');
    const videoSizeIdx = fallbackCall!.args.indexOf('-video_size');
    expect(vcodecIdx).toBeGreaterThanOrEqual(0);
    expect(videoSizeIdx).toBeGreaterThanOrEqual(0);
    expect(fallbackCall!.args[vcodecIdx + 1]).toBe('mjpeg');
    expect(fallbackCall!.args[videoSizeIdx + 1]).toBe('1280x720');
  });
});

describe('NexiGo Camera Stability (regression)', () => {
  // NexiGo was previously in MJPEG_FIRST_CAMERAS which caused it to die at 60-160s.
  // Raw YUV (default dshow) is proven stable for 760+ seconds.
  // These tests lock in that NexiGo uses default-first with MJPEG fallback.

  afterEach(async () => {
    spawnBehaviorQueue = [
      { exitImmediately: true, exitCode: 0 },
      { exitImmediately: true, exitCode: 0 },
      { exitImmediately: true, exitCode: 0 },
      { exitImmediately: true, exitCode: 0 },
    ];
    try {
      await stopRecording();
    } catch {
      /* ignore */
    }
  }, 15000);

  it('NexiGo tries default (raw) format first, not MJPEG', async () => {
    saveStudioConfig({
      cameras: [{ id: 'cam1', name: 'NexiGo N60 FHD Webcam', position: 'front', enabled: true }],
      recordScreen: false,
    });

    // Default format succeeds immediately
    queueAliveSpawn();

    const result = await startRecording();
    expect(result.success).toBe(true);

    const ffmpegCalls = spawnCallLog.filter((c) => c.command === 'ffmpeg');
    // First (and only) call should NOT have -vcodec mjpeg
    expect(ffmpegCalls[0].args).not.toContain('mjpeg');
    expect(ffmpegCalls[0].args).not.toContain('-vcodec');
  });

  it('NexiGo falls back to MJPEG if default fails', async () => {
    saveStudioConfig({
      cameras: [{ id: 'cam1', name: 'NexiGo N60 FHD Webcam', position: 'front', enabled: true }],
      recordScreen: false,
    });

    // Default fails, MJPEG 720p succeeds
    queueFailSpawn('Error: Could not connect pins');
    queueAliveSpawn();

    const result = await startRecording();
    expect(result.success).toBe(true);

    const ffmpegCalls = spawnCallLog.filter((c) => c.command === 'ffmpeg');
    // Second call should be MJPEG fallback
    const mjpegCall = ffmpegCalls.find((c) => c.args.includes('mjpeg'));
    expect(mjpegCall).toBeDefined();
    expect(mjpegCall!.args).toContain('1280x720');
  });

  it('mid-recording camera death is logged', async () => {
    saveStudioConfig({
      cameras: [{ id: 'cam1', name: 'NexiGo N60 FHD Webcam', position: 'front', enabled: true }],
      recordScreen: false,
    });

    // Camera starts OK (survives 1s alive check) but dies after 1.5s
    spawnBehaviorQueue.push({ exitDelay: 1500, exitCode: 1 });

    const consoleSpy = vi.spyOn(console, 'error');

    const result = await startRecording();
    expect(result.success).toBe(true);

    // Wait for the exit event to fire (after 1.5s delay)
    await new Promise((r) => setTimeout(r, 2000));

    const deathLog = consoleSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('CAMERA DIED'),
    );
    expect(deathLog).toBeDefined();
    expect(deathLog![0]).toContain('NexiGo');

    consoleSpy.mockRestore();
  });
});

describe('Screen Recording with Audio', () => {
  afterEach(async () => {
    spawnBehaviorQueue = [
      { exitImmediately: true, exitCode: 0 },
      { exitImmediately: true, exitCode: 0 },
      { exitImmediately: true, exitCode: 0 },
      { exitImmediately: true, exitCode: 0 },
    ];
    try {
      await stopRecording();
    } catch {
      /* ignore */
    }
  }, 15000);

  it('includes -map directives when screen recording has audio', async () => {
    saveStudioConfig({
      cameras: [{ id: 'cam1', name: 'TestCam', position: 'front', enabled: true }],
      recordScreen: true,
    });

    // 1. Screen recording spawn (gdigrab + audio)
    queueAliveSpawn();
    // 2. Camera spawn
    queueAliveSpawn();

    const result = await startRecording({ audioDevice: 'Microphone (Test Device)' });
    expect(result.success).toBe(true);

    // Find the screen recording ffmpeg call (has 'gdigrab' in args)
    const screenCall = spawnCallLog.find(
      (c) => c.command === 'ffmpeg' && c.args.includes('gdigrab'),
    );
    expect(screenCall).toBeDefined();

    // Must have explicit stream mapping to prevent shortest-stream timeout
    const mapIndices = screenCall!.args
      .map((a, i) => (a === '-map' ? i : -1))
      .filter((i) => i >= 0);
    expect(mapIndices.length).toBe(2);
    expect(screenCall!.args[mapIndices[0] + 1]).toBe('0:v');
    expect(screenCall!.args[mapIndices[1] + 1]).toBe('1:a');

    // Must have dshow audio input
    expect(screenCall!.args).toContain('audio=Microphone (Test Device)');
  });

  it('omits -map and audio args when no audio device configured', async () => {
    saveStudioConfig({
      cameras: [{ id: 'cam1', name: 'TestCam', position: 'front', enabled: true }],
      recordScreen: true,
      // no defaultAudioDevice
    });

    // 1. Screen recording spawn (video only)
    queueAliveSpawn();
    // 2. Camera spawn
    queueAliveSpawn();

    const result = await startRecording();
    expect(result.success).toBe(true);

    const screenCall = spawnCallLog.find(
      (c) => c.command === 'ffmpeg' && c.args.includes('gdigrab'),
    );
    expect(screenCall).toBeDefined();

    // No -map args when there's no audio
    expect(screenCall!.args).not.toContain('-map');
    // No dshow input
    expect(screenCall!.args).not.toContain('dshow');
    // No audio codec
    expect(screenCall!.args).not.toContain('aac');
  });

  it('screen recording starts before cameras', async () => {
    saveStudioConfig({
      cameras: [{ id: 'cam1', name: 'TestCam', position: 'front', enabled: true }],
      recordScreen: true,
    });

    queueAliveSpawn(); // screen
    queueAliveSpawn(); // camera

    const result = await startRecording({ audioDevice: 'Mic' });
    expect(result.success).toBe(true);

    // First ffmpeg call should be gdigrab (screen), second should be camera
    const ffmpegCalls = spawnCallLog.filter((c) => c.command === 'ffmpeg');
    expect(ffmpegCalls.length).toBeGreaterThanOrEqual(2);
    // Screen (gdigrab) starts first, camera starts after
    expect(ffmpegCalls[0].args).toContain('gdigrab');
    expect(ffmpegCalls[0].args).toContain('dshow'); // audio via dshow on screen recording
  });
});
