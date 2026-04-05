/**
 * Tests for Studio camera detection — verifies the dshow parsing logic
 * and prevents regressions in built-in camera discovery.
 *
 * Root cause (2026-04-04): FFmpeg v8.0 removed "DirectShow video devices"
 * section headers. The parser relied on these headers to set currentType,
 * so it found 0 devices. Fix: parse (video)/(audio) directly from each line.
 */

import { describe, it, expect } from 'vitest';

// ── dshow output parsing (mirrors detectDevices logic in studio.ts) ─────

interface DetectedDevice {
  name: string;
  type: 'video' | 'audio';
}

function parseDshowOutput(stderr: string): DetectedDevice[] {
  const devices: DetectedDevice[] = [];

  for (const line of stderr.split('\n')) {
    if (line.includes('@device')) continue;
    const match = line.match(/\[dshow[^\]]*\]\s+"(.+?)"\s+\((video|audio)\)/);
    if (match) {
      devices.push({ name: match[1], type: match[2] as 'video' | 'audio' });
    }
  }

  return devices;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Studio — Camera Detection Parser', () => {
  // Real output from ffmpeg v8.0 on Luke's machine
  const FFMPEG_V8_OUTPUT = `[dshow @ 000002805d783600] "Integrated Camera" (video)
[dshow @ 000002805d783600]   Alternative name "@device_pnp_\\\\?\\usb#vid_04ca&pid_7058&mi_00#6&1a3a7abf&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global"
[dshow @ 000002805d783600] "OBS Virtual Camera" (video)
[dshow @ 000002805d783600]   Alternative name "@device_sw_{860BB310-5D01-11D0-BD3B-00A0C911CE86}\\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}"
[dshow @ 000002805d783600] "Microphone Array (Realtek High Definition Audio)" (audio)
[dshow @ 000002805d783600]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{4BCF4C1B-B35F-4E7B-AEDD-F8BD89255F51}"`;

  // Old ffmpeg format with section headers (v6/v7)
  const FFMPEG_OLD_FORMAT = `[dshow @ 0x1] DirectShow video devices (some may be both video and audio devices)
[dshow @ 0x1] "USB Camera" (video)
[dshow @ 0x1]   Alternative name "@device_pnp_foo"
[dshow @ 0x1] DirectShow audio devices
[dshow @ 0x1] "USB Mic" (audio)
[dshow @ 0x1]   Alternative name "@device_cm_bar"`;

  it('parses Integrated Camera from ffmpeg v8 output (no section headers)', () => {
    const devices = parseDshowOutput(FFMPEG_V8_OUTPUT);
    const videoCams = devices.filter((d) => d.type === 'video');
    const audioDevs = devices.filter((d) => d.type === 'audio');

    expect(videoCams.length).toBe(2);
    expect(videoCams[0].name).toBe('Integrated Camera');
    expect(videoCams[1].name).toBe('OBS Virtual Camera');
    expect(audioDevs.length).toBe(1);
    expect(audioDevs[0].name).toContain('Microphone');
  });

  it('also works with old ffmpeg format that has section headers', () => {
    const devices = parseDshowOutput(FFMPEG_OLD_FORMAT);
    expect(devices).toHaveLength(2);
    expect(devices[0]).toEqual({ name: 'USB Camera', type: 'video' });
    expect(devices[1]).toEqual({ name: 'USB Mic', type: 'audio' });
  });

  it('filters out @device alternative name lines', () => {
    const devices = parseDshowOutput(FFMPEG_V8_OUTPUT);
    const names = devices.map((d) => d.name);
    expect(names).not.toContain(expect.stringContaining('@device'));
  });

  it('handles empty output gracefully', () => {
    expect(parseDshowOutput('')).toHaveLength(0);
  });

  it('handles Windows \\r\\n line endings', () => {
    const windowsOutput = FFMPEG_V8_OUTPUT.replace(/\n/g, '\r\n');
    const devices = parseDshowOutput(windowsOutput);
    expect(devices.filter((d) => d.type === 'video').length).toBe(2);
    expect(devices.filter((d) => d.type === 'audio').length).toBe(1);
  });

  it('production code uses close event, not exit', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const source = readFileSync(resolve(__dirname, '..', 'studio.ts'), 'utf8');

    const detectDevicesBlock = source.slice(
      source.indexOf('async function detectDevices'),
      source.indexOf('async function detectCameras'),
    );
    expect(detectDevicesBlock).toContain("ffmpeg.on('close'");
    expect(detectDevicesBlock).not.toContain("ffmpeg.on('exit'");
  });

  it('production regex extracts type from parentheses, not section headers', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const source = readFileSync(resolve(__dirname, '..', 'studio.ts'), 'utf8');

    // Must NOT rely on "DirectShow video devices" section headers (removed in ffmpeg v8)
    const detectDevicesBlock = source.slice(
      source.indexOf('async function detectDevices'),
      source.indexOf('async function detectCameras'),
    );
    expect(detectDevicesBlock).not.toContain('DirectShow video devices');
    // Must extract (video)/(audio) from the device line itself
    expect(detectDevicesBlock).toContain('(video|audio)');
  });
});
