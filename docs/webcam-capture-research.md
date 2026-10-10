# USB Webcam Video Capture in Node.js/Electron (Without OBS)

## Technical Research Report — April 2026

---

## Executive Summary

The simplest, most reliable approach for studio-quality multi-camera recording from Node.js/Electron is: **spawn FFmpeg processes per camera using dshow input, record to MKV (Matroska) for crash resilience, use NVENC if available for low CPU usage, and remux to MP4 when recording stops.** Screen capture should use **FFmpeg ddagrab** (GPU-native) rather than Electron's desktopCapturer.

---

## 1. FFmpeg DirectShow (dshow) on Windows

### 1.1 Listing All Connected Cameras

```bash
ffmpeg -list_devices true -f dshow -i dummy
```

This prints to **stderr** (not stdout). Output looks like:

```
[dshow] DirectShow video devices:
[dshow]  "USB Camera"
[dshow]  "Logitech C920"
[dshow] DirectShow audio devices:
[dshow]  "Microphone (USB Camera)"
[dshow]  "Microphone (Realtek Audio)"
```

To list supported formats/resolutions for a specific camera:

```bash
ffmpeg -f dshow -list_options true -i video="Logitech C920"
```

### 1.2 Recording from a Specific Device

Basic recording with video only:

```bash
ffmpeg -f dshow -i video="Logitech C920" -c:v libx264 -crf 18 output.mkv
```

Recording with video + audio from paired device:

```bash
ffmpeg -f dshow -i video="Logitech C920":audio="Microphone (Logitech C920)" ^
  -c:v libx264 -crf 18 -preset fast ^
  -c:a aac -b:a 192k ^
  output.mkv
```

### 1.3 MJPEG vs Raw Format Selection

Webcams typically expose two input formats: raw YUV (yuyv422) and MJPEG. MJPEG is essential for high resolutions because USB 2.0 bandwidth cannot carry raw 1080p at 30fps.

**Use MJPEG input (recommended for 1080p+):**

```bash
ffmpeg -f dshow -vcodec mjpeg -video_size 1920x1080 -framerate 30 ^
  -i video="Logitech C920" ^
  -c:v libx264 -crf 18 output.mkv
```

**Use raw YUV (only for 720p or lower):**

```bash
ffmpeg -f dshow -pixel_format yuyv422 -video_size 1280x720 -framerate 30 ^
  -i video="Logitech C920" ^
  -c:v libx264 -crf 18 output.mkv
```

**Rule of thumb:** Always use `-vcodec mjpeg` for 1080p and above. Raw YUV at 1080p30 requires ~250 MB/s, which exceeds USB 2.0 bandwidth (480 Mbps theoretical, ~35 MB/s real).

### 1.4 Resolution and Framerate Control

```bash
ffmpeg -f dshow -vcodec mjpeg -video_size 1920x1080 -framerate 30 ^
  -i video="Camera Name" ^
  -c:v libx264 -crf 18 -preset fast ^
  output.mkv
```

Key input options:

- `-video_size 1920x1080` — must match a mode the camera supports
- `-framerate 30` — must match a mode the camera supports
- `-vcodec mjpeg` — request compressed input from camera
- `-rtbufsize 512M` — increase real-time buffer to prevent drops

### 1.5 Recording Multiple Cameras Simultaneously

**Approach A — Separate FFmpeg processes (RECOMMENDED):**

Spawn one FFmpeg process per camera. This is more reliable because:

- Each process has independent error handling
- One camera failure doesn't kill the other recordings
- Simpler to start/stop cameras independently
- No complex filter_complex graphs

**Approach B — Single FFmpeg process with multiple inputs:**

```bash
ffmpeg ^
  -f dshow -vcodec mjpeg -video_size 1920x1080 -framerate 30 -rtbufsize 512M -i video="Camera A":audio="Mic A" ^
  -f dshow -vcodec mjpeg -video_size 1920x1080 -framerate 30 -rtbufsize 512M -i video="Camera B":audio="Mic B" ^
  -map 0:v -map 0:a -c:v libx264 -crf 18 -c:a aac -b:a 192k camera_a.mkv ^
  -map 1:v -map 1:a -c:v libx264 -crf 18 -c:a aac -b:a 192k camera_b.mkv
```

**Caveat from real-world testing:** When using multiple dshow inputs in a single FFmpeg process, cumulative timing drift occurs — the delay can be entire seconds, and it gets worse with more devices. The `-rtbufsize` flag helps but doesn't eliminate the issue. Separate processes avoid this.

---

## 2. Node.js child_process.spawn with FFmpeg

### 2.1 Spawning FFmpeg for Recording

```typescript
import { spawn, ChildProcess } from 'child_process';
import path from 'path';

interface RecordingSession {
  process: ChildProcess;
  outputPath: string;
  cameraName: string;
  startTime: number;
}

function startRecording(
  cameraName: string,
  audioDevice: string | null,
  outputDir: string,
): RecordingSession {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(outputDir, `${cameraName.replace(/\s+/g, '_')}_${timestamp}.mkv`);

  const args: string[] = [
    // Input configuration
    '-f',
    'dshow',
    '-vcodec',
    'mjpeg',
    '-video_size',
    '1920x1080',
    '-framerate',
    '30',
    '-rtbufsize',
    '512M',
    '-i',
    audioDevice ? `video=${cameraName}:audio=${audioDevice}` : `video=${cameraName}`,

    // Video encoding
    '-c:v',
    'libx264',
    '-crf',
    '18',
    '-preset',
    'fast',
    '-tune',
    'film',

    // Audio encoding (if audio device provided)
    ...(audioDevice ? ['-c:a', 'aac', '-b:a', '192k'] : []),

    // Output
    '-y',
    outputPath,
  ];

  const ffmpeg = spawn('ffmpeg', args, {
    stdio: ['pipe', 'pipe', 'pipe'], // stdin, stdout, stderr all piped
  });

  ffmpeg.stderr?.on('data', (data: Buffer) => {
    const line = data.toString();
    // FFmpeg writes all progress/info to stderr
    // Parse for frame count, fps, bitrate, time, etc.
    if (line.includes('frame=')) {
      // Progress update — extract stats
    }
    if (line.includes('Error') || line.includes('error')) {
      console.error(`[${cameraName}] FFmpeg error: ${line}`);
    }
  });

  ffmpeg.on('exit', (code, signal) => {
    console.log(`[${cameraName}] FFmpeg exited: code=${code}, signal=${signal}`);
  });

  return {
    process: ffmpeg,
    outputPath,
    cameraName,
    startTime: Date.now(),
  };
}
```

### 2.2 Gracefully Stopping Recording

The correct way to stop FFmpeg is to write `q` to its stdin. This lets FFmpeg finalize the container (write headers, close the moov atom for MP4, etc.).

```typescript
function stopRecording(session: RecordingSession): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      // If FFmpeg doesn't exit within 10 seconds, force kill
      session.process.kill('SIGKILL');
      reject(new Error(`FFmpeg did not exit gracefully for ${session.cameraName}`));
    }, 10000);

    session.process.on('exit', () => {
      clearTimeout(timeout);
      resolve(session.outputPath);
    });

    // Send 'q' to stdin — this is the graceful shutdown command
    if (session.process.stdin) {
      session.process.stdin.write('q');
      session.process.stdin.end();
    }
  });
}
```

**Important:** Do NOT use `process.kill('SIGINT')` on Windows — it doesn't work the same as on Unix. The stdin `q` approach is cross-platform and reliable.

### 2.3 Monitoring Recording Health

```typescript
function monitorHealth(session: RecordingSession): NodeJS.Timeout {
  let lastFrameCount = 0;
  let stallCount = 0;

  return setInterval(() => {
    // Check if process is still running
    if (session.process.killed || session.process.exitCode !== null) {
      console.error(`[${session.cameraName}] Recording process died unexpectedly`);
      // Trigger restart logic here
      return;
    }

    // Parse stderr for frame count (FFmpeg writes progress to stderr)
    // If frame count hasn't increased in 2 intervals, recording may be stalled
  }, 5000);
}
```

### 2.4 NVENC Hardware Encoding Variant

If the machine has an NVIDIA GPU, use h264_nvenc instead of libx264 to offload encoding from CPU:

```typescript
const args: string[] = [
  '-f',
  'dshow',
  '-vcodec',
  'mjpeg',
  '-video_size',
  '1920x1080',
  '-framerate',
  '30',
  '-rtbufsize',
  '512M',
  '-i',
  `video=${cameraName}:audio=${audioDevice}`,

  // NVENC hardware encoding
  '-c:v',
  'h264_nvenc',
  '-preset',
  'p4', // balanced quality/speed (p1=fastest, p7=best quality)
  '-cq',
  '18', // constant quality mode (similar to CRF)
  '-b:v',
  '0', // let CQ mode control bitrate

  '-c:a',
  'aac',
  '-b:a',
  '192k',
  '-y',
  outputPath,
];
```

NVENC is roughly 5x faster than libx264 and uses near-zero CPU. Quality is slightly lower than libx264 at the same CRF/CQ value, but at CQ 18 with a talking head, the difference is imperceptible. NVENC is ideal for multi-camera setups where CPU is the bottleneck.

---

## 3. Auto-Detecting USB Cameras on Windows

### 3.1 Parsing FFmpeg Device List (Simplest, Most Reliable)

```typescript
import { spawn } from 'child_process';

interface MediaDevice {
  name: string;
  type: 'video' | 'audio';
  alternativeName?: string;
}

function listDevices(): Promise<MediaDevice[]> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);

    let stderr = '';
    ffmpeg.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    ffmpeg.on('exit', () => {
      const devices: MediaDevice[] = [];
      let currentType: 'video' | 'audio' | null = null;

      for (const line of stderr.split('\n')) {
        if (line.includes('DirectShow video devices')) {
          currentType = 'video';
        } else if (line.includes('DirectShow audio devices')) {
          currentType = 'audio';
        } else if (currentType) {
          // Match device names in quotes: [dshow]  "Device Name"
          const match = line.match(/\[dshow\]\s+"(.+?)"/);
          if (match) {
            // Skip "alternative name" lines
            if (line.includes('@device')) continue;
            devices.push({ name: match[1], type: currentType });
          }
        }
      }

      resolve(devices);
    });

    ffmpeg.on('error', reject);
  });
}
```

**This is the recommended approach** because:

- No native modules needed (no node-gyp, no Electron rebuild headaches)
- Works on any system with FFmpeg installed
- Returns the exact device names FFmpeg expects

### 3.2 USB Hotplug Detection with `usb` Package

The `usb` npm package (successor to the now-deprecated `usb-detection`) provides hotplug events:

```typescript
import { usb } from 'usb';

// Listen for new USB devices
usb.on('attach', (device) => {
  console.log('USB device attached:', device.deviceDescriptor);
  // Re-enumerate cameras after a short delay (driver initialization)
  setTimeout(() => listDevices(), 2000);
});

usb.on('detach', (device) => {
  console.log('USB device detached:', device.deviceDescriptor);
  // Update camera list
  setTimeout(() => listDevices(), 500);
});

// If you don't want USB monitoring to keep the process alive:
usb.unrefHotplugEvents();
```

**Caveat:** The `usb` package detects ANY USB device, not just cameras. You would use it purely as a trigger to re-run the FFmpeg device listing. The USB Vendor/Product IDs can help filter (UVC class = 0x0E), but the simplest approach is just to re-list FFmpeg devices on any USB change.

### 3.3 Electron desktopCapturer (Screen Only)

`desktopCapturer.getSources()` lists capturable screens and windows — it does NOT enumerate webcams. It's for screen recording only.

### 3.4 WMI Queries (Windows-Specific)

You can query Win32_PnPEntity for video devices via PowerShell:

```typescript
import { exec } from 'child_process';

function listCamerasWMI(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    exec(
      "powershell -Command \"Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPClass -eq 'Camera' -or $_.PNPClass -eq 'Image' } | Select-Object -ExpandProperty Name\"",
      (error, stdout) => {
        if (error) return reject(error);
        resolve(stdout.trim().split('\n').filter(Boolean));
      },
    );
  });
}
```

Note: WMI names may not exactly match FFmpeg dshow names. FFmpeg device listing is more reliable for building recording commands.

---

## 4. Recording Quality Settings

### 4.1 Recommended Codec Settings

**For studio-quality talking head video:**

| Setting       | Recommended Value                     | Notes                                                                    |
| ------------- | ------------------------------------- | ------------------------------------------------------------------------ |
| Video codec   | `libx264` (CPU) or `h264_nvenc` (GPU) | NVENC if multi-camera                                                    |
| CRF / CQ      | 18                                    | Visually lossless for talking heads. 21 is "good enough", 15 is overkill |
| Preset        | `fast` (libx264) or `p4` (NVENC)      | Balances CPU usage vs compression                                        |
| Tune          | `film`                                | Optimized for live-action content                                        |
| Audio codec   | AAC                                   | Universal compatibility                                                  |
| Audio bitrate | 192 kbps                              | 256k for music-heavy content                                             |
| Sample rate   | 48000 Hz                              | Standard for video production                                            |
| Container     | MKV (recording) -> MP4 (final)        | MKV for crash resilience                                                 |
| Resolution    | 1920x1080                             | Match camera capability                                                  |
| Frame rate    | 30 fps                                | 60fps only if demonstrating physical movement                            |

### 4.2 CRF Value Guide

- **CRF 0**: Lossless (huge files, unnecessary)
- **CRF 15**: Overkill for talking heads, useful for fast motion
- **CRF 18**: Visually lossless — recommended for studio recording
- **CRF 21**: High quality, noticeably smaller files
- **CRF 23**: Default, good for distribution
- **CRF 28+**: Visible compression artifacts

For talking head content with a static background, CRF 18 gives excellent quality at reasonable file sizes (~2-4 GB/hour at 1080p30).

### 4.3 Container: MKV for Recording, MP4 for Distribution

**Why MKV (Matroska) for recording:**

- If the application crashes, power fails, or disk fills up, MKV files remain playable up to the point of interruption. Only the last few seconds are lost.
- MP4 writes its index (moov atom) only when recording stops. A crash destroys the entire file — all footage is unrecoverable.

**Post-recording remux to MP4 (lossless, instant):**

```bash
ffmpeg -i recording.mkv -c copy output.mp4
```

This copies streams without re-encoding. Takes seconds regardless of file size.

### 4.4 Complete Recommended Recording Command

```bash
ffmpeg -f dshow -vcodec mjpeg -video_size 1920x1080 -framerate 30 -rtbufsize 512M ^
  -i video="Logitech C920":audio="Microphone (Logitech C920)" ^
  -c:v libx264 -crf 18 -preset fast -tune film ^
  -c:a aac -b:a 192k -ar 48000 ^
  -movflags +faststart ^
  output.mkv
```

---

## 5. Multi-Camera Synchronization

### 5.1 The Problem

When you spawn multiple FFmpeg processes, each one starts at a slightly different time. Even millisecond differences are noticeable when cutting between angles. Additional drift accumulates over time due to independent clock sources.

### 5.2 Strategy: Timestamp-Based Sync

**Step 1 — Record with wall-clock timestamps:**

Record a high-precision start timestamp in your Node.js code when each process begins:

```typescript
const sessions: RecordingSession[] = [];

// Start all cameras as close together as possible
for (const camera of cameras) {
  const session = startRecording(camera.name, camera.audio, outputDir);
  session.wallClockStart = process.hrtime.bigint(); // nanosecond precision
  sessions.push(session);
}
```

**Step 2 — Use `-copyts` to preserve timestamps:**

Add `-copyts` to FFmpeg args to preserve source timestamps in the output. Also add `-start_at_zero` so timestamps start from 0 rather than some arbitrary epoch:

```bash
ffmpeg -f dshow ... -i video="Camera" -copyts -start_at_zero -c:v libx264 ... output.mkv
```

**Step 3 — Post-recording alignment:**

Calculate offsets from the recorded wall-clock start times and use `ffprobe` to read each file's actual start_time:

```bash
ffprobe -loglevel quiet -select_streams v -show_entries stream=start_time -of csv=p=0 recording.mkv
```

Then use `-itsoffset` or the `setpts` filter to align during editing/compositing:

```bash
ffmpeg -itsoffset 0.150 -i camera_b.mkv -i camera_a.mkv ...
```

### 5.3 Audio Clap Sync (Backup Method)

The most reliable real-world sync method: play a sharp audio tone through speakers at recording start. In post, use cross-correlation of the audio tracks to find the exact offset. This is the same principle as a film clapperboard.

### 5.4 Practical Advice

For talking-head multi-camera, sub-100ms sync is adequate (you're cutting between angles, not compositing side-by-side). The wall-clock timestamp approach with process.hrtime is sufficient. Perfect frame-level sync only matters for side-by-side or picture-in-picture compositing.

---

## 6. Screen Capture Without OBS

### 6.1 FFmpeg gdigrab (Legacy, Compatible)

```bash
ffmpeg -f gdigrab -framerate 30 -i desktop ^
  -c:v libx264 -crf 18 -preset ultrafast ^
  output.mkv
```

Capture a specific window by title:

```bash
ffmpeg -f gdigrab -framerate 30 -i title="Visual Studio Code" ^
  -c:v libx264 -crf 18 -preset ultrafast ^
  output.mkv
```

**Pros:**

- Works on all Windows versions
- Can capture specific windows by title
- Can capture regions with offset_x/offset_y/video_size
- Can span multiple monitors

**Cons:**

- CPU-based capture (GDI)
- Cannot capture hardware-accelerated fullscreen content (games, some video players)
- Higher CPU usage than ddagrab

### 6.2 FFmpeg ddagrab (Modern, GPU-Native) — RECOMMENDED

ddagrab uses the Windows Desktop Duplication API (DXGI) and returns D3D11 hardware frames directly on the GPU.

**With NVENC (zero-CPU recording):**

```bash
ffmpeg -f lavfi -i ddagrab=framerate=30 -c:v h264_nvenc -cq 18 output.mkv
```

**Capture a specific monitor:**

```bash
ffmpeg -f lavfi -i ddagrab=output_idx=1:framerate=30 -c:v h264_nvenc -cq 18 output.mkv
```

**Capture a region:**

```bash
ffmpeg -f lavfi -i ddagrab=video_size=800x600:offset_x=100:offset_y=100 -c:v h264_nvenc -cq 18 output.mkv
```

**CPU fallback (if no NVIDIA GPU):**

```bash
ffmpeg -f lavfi -i ddagrab=framerate=30,hwdownload,format=bgra -c:v libx264 -crf 18 output.mkv
```

Note: `hwdownload` and `format=bgra` are required to bring frames back to CPU memory for software encoding.

**Key options:**

- `output_idx` — which monitor (0 = primary)
- `framerate` — max capture fps (default 30)
- `draw_mouse` — show/hide cursor (default true)
- `output_fmt` — `8bit` (BGRA) or `10bit` (x2bgr10)
- `dup_frames` — duplicate frames when desktop hasn't changed (default true)

**Pros:**

- Captures directly from GPU — near zero CPU for capture
- Can capture hardware-accelerated content (games, video players)
- Combined with NVENC, entire pipeline stays on GPU
- Supports 10-bit HDR capture

**Cons:**

- Windows 8+ only, 64-bit FFmpeg only
- Cannot capture across multiple monitors in one session
- Cannot capture individual windows (full monitor only)

### 6.3 Recommendation

Use **ddagrab + h264_nvenc** if the machine has an NVIDIA GPU. This keeps the entire capture-encode pipeline on the GPU with near-zero CPU usage. Fall back to **gdigrab + libx264** for compatibility or if you need window-specific capture.

---

## 7. Hot-Plugging Cameras

### 7.1 What Happens When a Camera is Disconnected Mid-Recording

FFmpeg will encounter a read error on the dshow input and exit with a non-zero exit code. The MKV file will be intact up to that point (another reason to use MKV over MP4). Your Node.js process handler catches this via the `exit` event.

### 7.2 Detecting Camera Changes

```typescript
import { usb } from 'usb';

class CameraManager {
  private cameras: MediaDevice[] = [];
  private refreshDebounce: NodeJS.Timeout | null = null;

  constructor() {
    // Initial enumeration
    this.refreshCameras();

    // Watch for USB changes
    usb.on('attach', () => this.scheduleRefresh());
    usb.on('detach', () => this.scheduleRefresh());
  }

  private scheduleRefresh(): void {
    // Debounce: USB events can fire rapidly
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
    this.refreshDebounce = setTimeout(() => this.refreshCameras(), 2000);
  }

  private async refreshCameras(): Promise<void> {
    const newCameras = await listDevices(); // FFmpeg -list_devices
    const videoDevices = newCameras.filter((d) => d.type === 'video');

    // Diff against known cameras
    const added = videoDevices.filter((nc) => !this.cameras.find((c) => c.name === nc.name));
    const removed = this.cameras.filter((c) => !videoDevices.find((nc) => nc.name === c.name));

    if (added.length > 0) {
      console.log(
        'New cameras detected:',
        added.map((c) => c.name),
      );
      // Emit event for UI to offer recording
    }
    if (removed.length > 0) {
      console.log(
        'Cameras removed:',
        removed.map((c) => c.name),
      );
      // Check if any active recordings need cleanup
    }

    this.cameras = videoDevices;
  }

  destroy(): void {
    usb.unrefHotplugEvents();
  }
}
```

### 7.3 Key Considerations

- **Driver initialization delay:** After a USB camera is plugged in, Windows needs 1-3 seconds to install/load the driver. The 2-second debounce in the code above handles this.
- **No hot-resume:** You cannot resume recording to the same file after a disconnect. Start a new recording session.
- **Electron rebuild:** The `usb` package is a native module requiring `electron-rebuild` or `@electron/rebuild`. If you want to avoid native modules entirely, poll `ffmpeg -list_devices` on a timer (every 5-10 seconds) instead.

---

## 8. Electron desktopCapturer vs FFmpeg for Screen Recording

### 8.1 Electron desktopCapturer

**How it works:**

1. `desktopCapturer.getSources()` returns available screens and windows
2. Pass the source ID to `navigator.mediaDevices.getUserMedia()`
3. Pipe the MediaStream to a `MediaRecorder`
4. Collect Blob chunks and write to file

```typescript
// Renderer process
const sources = await (window as any).electron.desktopCapturer.getSources({
  types: ['screen', 'window'],
});

const stream = await navigator.mediaDevices.getUserMedia({
  video: {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sources[0].id,
      maxWidth: 1920,
      maxHeight: 1080,
      maxFrameRate: 30,
    },
  } as any,
  audio: false,
});

const recorder = new MediaRecorder(stream, {
  mimeType: 'video/webm; codecs=vp9',
  videoBitsPerSecond: 8000000, // 8 Mbps
});

const chunks: Blob[] = [];
recorder.ondataavailable = (e) => chunks.push(e.data);
recorder.onstop = async () => {
  const blob = new Blob(chunks, { type: 'video/webm' });
  const buffer = Buffer.from(await blob.arrayBuffer());
  // Send to main process for file writing via IPC
};
recorder.start(1000); // chunk every 1 second
```

**Pros:**

- No external dependencies (built into Electron/Chromium)
- Can capture individual windows
- Works cross-platform

**Cons:**

- Output is WebM only (VP8/VP9) — no H.264 output
- WebM files have no Duration header (Chromium bug, marked WONTFIX) — some players won't show duration or allow seeking
- Quality control is limited (bitrate only, no CRF equivalent)
- High CPU usage for encoding (no GPU acceleration path)
- MediaRecorder stops working when screen is locked (Chromium bug)
- Cannot capture system audio on Windows without workarounds
- Blob-based architecture means you hold all chunks in memory

### 8.2 FFmpeg (gdigrab or ddagrab)

**Pros:**

- Full codec control (H.264, H.265, NVENC, CRF, presets)
- MKV container for crash resilience
- GPU-accelerated capture AND encoding with ddagrab + NVENC
- Low, predictable memory usage (streams to disk)
- Mature, battle-tested, well-documented
- System audio capture possible via dshow audio input

**Cons:**

- Requires FFmpeg binary bundled with app
- gdigrab can't capture hardware-accelerated content
- ddagrab can't capture individual windows (full monitor only)
- No window-by-title capture with ddagrab

### 8.3 Verdict

**Use FFmpeg (ddagrab preferred) for screen recording.** The quality control, crash resilience, GPU acceleration, and codec flexibility make it vastly superior for a production recording application. Electron's desktopCapturer is fine for quick screen grabs or sharing in a video call, but it's not suitable for studio-quality recording.

The one edge case where desktopCapturer wins: if you need to capture a specific application window and ddagrab's full-monitor capture is not acceptable. In that case, use gdigrab with `-i title="Window Name"` rather than desktopCapturer.

---

## 9. Complete Architecture Recommendation

### Recording Manager (Main Process)

```
┌─────────────────────────────────────────────┐
│              RecordingManager               │
│                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Camera 1 │  │ Camera 2 │  │  Screen  │  │
│  │ (FFmpeg) │  │ (FFmpeg) │  │ (FFmpeg) │  │
│  │  dshow   │  │  dshow   │  │ ddagrab  │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       │              │              │        │
│       ▼              ▼              ▼        │
│   cam1.mkv       cam2.mkv      screen.mkv   │
│                                             │
│  USB hotplug watcher (usb or polling)       │
│  Health monitor (check processes alive)     │
│  Graceful stop (stdin 'q' to all)           │
│  Post-recording remux MKV -> MP4            │
└─────────────────────────────────────────────┘
```

### FFmpeg Binary Bundling

Use `ffmpeg-static` npm package or bundle a known-good FFmpeg build. For NVENC support, you need an FFmpeg build compiled with `--enable-nvenc` (the BtbN Windows builds include this).

### Simplified Flow

1. On app start: enumerate cameras via `ffmpeg -list_devices`
2. On USB change: re-enumerate
3. User clicks "Record": spawn one FFmpeg per source (cameras + optional screen)
4. Monitor all processes for health
5. User clicks "Stop": write `q` to all stdin, wait for exit
6. Remux all MKV files to MP4
7. Optionally: align timestamps for multi-camera editing

---

## Sources

- [FFmpeg Devices Documentation](https://ffmpeg.org/ffmpeg-devices.html)
- [Multitrack recording with FFmpeg (Windows) — CN_Blog](https://blog.claranguyen.me/post/2024/12/15/multitrack-recording-win/)
- [ddagrab documentation — FFmpeg 7.1](https://ayosec.github.io/ffmpeg-filters-docs/7.1/Sources/Video/ddagrab.html)
- [CRF Guide — slhck.info](https://slhck.info/video/2017/02/24/crf-guide.html)
- [FFmpeg CRF Examples (2026) — Vibbit](https://vibbit.ai/blog/ffmpeg-crf-examples)
- [Node USB library](https://node-usb.github.io/node-usb/)
- [usb-detection npm package](https://www.npmjs.com/package/usb-detection)
- [Electron desktopCapturer API](https://www.electronjs.org/docs/api/desktop-capturer)
- [NVIDIA FFmpeg Hardware Acceleration](https://docs.nvidia.com/video-technologies/video-codec-sdk/11.1/ffmpeg-with-nvidia-gpu/index.html)
- [MKV vs MP4 crash resilience — OneStream](https://onestream.live/blog/mkv-vs-mp4-for-pre-recorded-streaming/)
- [FFmpeg with NVIDIA Hardware Acceleration — Erich Izdepski](https://eizdepski.medium.com/ffmpeg-with-nvidia-hardware-acceleration-118e12446b13)
- [node-webcam npm package](https://www.npmjs.com/package/node-webcam)
