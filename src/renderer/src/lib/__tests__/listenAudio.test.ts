/**
 * Tests for listenAudio — catches broken listen-in implementations.
 *
 * History of broken approaches:
 *  - WebSocket + μ-law decode: garbage noise (wrong format)
 *  - LiveKit Room.connect(): "did not receive join response" (wrong protocol)
 *  - WebSocket + PCM S16LE 8 kHz: slow/pitched-down audio (wrong sample rate)
 *
 * Correct: WebSocket + PCM S16LE at 16 kHz (per Vapi support docs).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebSocketServer } from "ws";
import { decodePcmS16le, startListening, VAPI_SAMPLE_RATE } from "../listenAudio";

// ---------------------------------------------------------------------------
// PCM decoding unit tests
// ---------------------------------------------------------------------------

describe("decodePcmS16le", () => {
  it("averages L+R channels: max L + silent R → ~0.5", () => {
    const buf = new ArrayBuffer(4); // one stereo frame
    const int16 = new Int16Array(buf);
    int16[0] = 32767; // left = max
    int16[1] = 0;     // right = silent
    const out = decodePcmS16le(buf);
    expect(out[0]).toBeCloseTo(0.5, 2);
  });

  it("averages L+R channels: silent L + max R → ~0.5", () => {
    const buf = new ArrayBuffer(4);
    const int16 = new Int16Array(buf);
    int16[0] = 0;     // left = silent (Vapi pattern)
    int16[1] = 32767; // right = audio
    const out = decodePcmS16le(buf);
    expect(out[0]).toBeCloseTo(0.5, 2);
  });

  it("converts stereo silence to 0.0", () => {
    const buf = new ArrayBuffer(8); // two stereo frames of silence
    const out = decodePcmS16le(buf);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
  });

  it("output length is byteLength/4 (stereo frames, not raw samples)", () => {
    const buf = new ArrayBuffer(320); // 80 stereo frames @ 4 bytes each
    const out = decodePcmS16le(buf);
    expect(out.length).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// Sample-rate constant
// ---------------------------------------------------------------------------

describe("VAPI_SAMPLE_RATE", () => {
  it("is 16000 Hz (Vapi PCM S16LE rate)", () => {
    expect(VAPI_SAMPLE_RATE).toBe(16000);
  });

  it("is NOT 8000 Hz (would cause slow/pitched-down audio)", () => {
    expect(VAPI_SAMPLE_RATE).not.toBe(8000);
  });
});

// ---------------------------------------------------------------------------
// startListening integration — mock WebSocket server
// ---------------------------------------------------------------------------

/** Build a minimal mock AudioContext factory that vitest can use (no real Web Audio). */
function makeMockAudioContext() {
  const gainNode = {
    connect: vi.fn(),
    gain: { value: 1 },
  };
  const createBuffer = vi.fn((ch: number, len: number, sr: number) => ({
    duration: len / sr,
    copyToChannel: vi.fn(),
  }));
  const instance = {
    sampleRate: VAPI_SAMPLE_RATE,
    currentTime: 0,
    destination: {},
    createGain: vi.fn(() => gainNode),
    createBuffer,
    createBufferSource: vi.fn(() => ({ buffer: null, connect: vi.fn(), start: vi.fn() })),
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  // Factory function (not constructor) — avoids arrow-function-as-constructor issues
  const factory = vi.fn(() => instance as unknown as AudioContext);
  return { factory, instance };
}

describe("startListening (WebSocket integration)", () => {
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on("listening", r));
    port = (wss.address() as any).port;
  });

  it("resolves when WebSocket server accepts the connection", async () => {
    const { factory: Ctor } = makeMockAudioContext();
    const conn = await startListening(`ws://localhost:${port}`, Ctor);
    expect(conn).toBeDefined();
    expect(conn.cleanup).toBeTypeOf("function");
    expect(conn.setMuted).toBeTypeOf("function");
    expect(conn.getDebugInfo).toBeTypeOf("function");
    conn.cleanup();
    wss.close();
  });

  it("getDebugInfo identifies PCM protocol (not LiveKit or mulaw)", async () => {
    const { factory: Ctor } = makeMockAudioContext();
    const conn = await startListening(`ws://localhost:${port}`, Ctor);
    const info = conn.getDebugInfo();
    expect(info).toContain("PCM");
    expect(info).toContain("16000");
    expect(info).not.toContain("LiveKit");
    expect(info).not.toContain("mulaw");
    conn.cleanup();
    wss.close();
  });

  it("rejects when no server is listening (wrong port)", async () => {
    const { factory: Ctor } = makeMockAudioContext();
    await expect(
      startListening("ws://localhost:1", Ctor)
    ).rejects.toThrow();
  });

  it("decodes a PCM frame without error when server sends binary data", async () => {
    // Send a 20ms stereo frame: 80 stereo frames × 4 bytes = 320 bytes → 80 mono output samples
    wss.on("connection", (sock) => {
      const frame = new ArrayBuffer(320);
      sock.send(frame);
    });

    const { factory, instance } = makeMockAudioContext();
    const conn = await startListening(`ws://localhost:${port}`, factory);

    // Give the onmessage handler a tick to fire
    await new Promise((r) => setTimeout(r, 50));

    // createBuffer should have been called with 80 mono samples (stereo decoded)
    expect(instance.createBuffer).toHaveBeenCalledWith(1, 80, VAPI_SAMPLE_RATE);
    conn.cleanup();
    wss.close();
  });

  it("ignores JSON string messages (Vapi sends control events as text)", async () => {
    wss.on("connection", (sock) => {
      sock.send(JSON.stringify({ type: "call-started" }));
    });

    const { factory, instance } = makeMockAudioContext();
    const conn = await startListening(`ws://localhost:${port}`, factory);
    await new Promise((r) => setTimeout(r, 50));

    // createBuffer must NOT be called for text frames
    expect(instance.createBuffer).not.toHaveBeenCalled();
    conn.cleanup();
    wss.close();
  });
});
