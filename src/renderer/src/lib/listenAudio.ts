/**
 * listenAudio — connects to a Vapi monitor.listenUrl WebSocket and plays audio.
 *
 * Vapi streams raw PCM S16LE (signed 16-bit little-endian), mono.
 * VAPI_SAMPLE_RATE must match what Vapi actually sends — open DevTools (F12)
 * during a live call and look for the "[vapi-audio]" diagnostic log which
 * prints the measured bytes/second and the inferred Hz so you can set it
 * correctly without guessing.
 */

export const VAPI_SAMPLE_RATE = 16000; // Hz — update based on [vapi-audio] log
const CONNECT_TIMEOUT_MS = 30_000;
const BUFFER_LEAD_S = 0.1; // start this far ahead of now to avoid underruns
const MAX_BUFFER_AHEAD_S = 0.4; // don't let the queue grow beyond this

// Diagnostic: measure actual bytes received per second for the first window,
// then log the inferred sample rate so we can hard-code the right value.
const DIAG_WINDOW_MS = 2000;

export interface ListenConnection {
  cleanup: () => void;
  setMuted: (muted: boolean) => void;
  getDebugInfo: () => string;
}

/**
 * Decode stereo S16LE PCM to mono Float32.
 * Vapi sends 2-channel interleaved S16LE at 16kHz where one channel is silent.
 * We average both channels so we get audio regardless of which side carries it.
 * Output length = buffer.byteLength / 4  (4 bytes per stereo sample pair).
 */
export function decodePcmS16le(buffer: ArrayBuffer): Float32Array {
  const int16 = new Int16Array(buffer);
  const numFrames = Math.floor(int16.length / 2);
  const float32 = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    // Average L+R so we capture whichever channel carries audio
    float32[i] = (int16[i * 2] + int16[i * 2 + 1]) / 2 / 32768.0;
  }
  return float32;
}

type AudioContextFactory = (options: AudioContextOptions) => AudioContext;

function defaultAudioContextFactory(options: AudioContextOptions): AudioContext {
  const Ctor: typeof AudioContext = window.AudioContext ?? (window as any).webkitAudioContext;
  return new Ctor(options);
}

/**
 * Connect to a Vapi listenUrl and play the audio.
 *
 * Resolves as soon as the WebSocket opens (before audio arrives).
 * Rejects if the connection times out or the WebSocket errors immediately.
 *
 * Pass `createAudioContext` to inject a mock in tests.
 */
export function startListening(
  listenUrl: string,
  createAudioContext: AudioContextFactory = defaultAudioContextFactory,
): Promise<ListenConnection> {
  return new Promise((resolve, reject) => {
    const ctx = createAudioContext({ sampleRate: VAPI_SAMPLE_RATE });
    const gainNode = ctx.createGain();
    gainNode.connect(ctx.destination);
    let nextTime = 0;

    // Diagnostic counters — reset once we log
    let diagBytesReceived = 0;
    let diagFrames = 0;
    let diagStartMs = 0;
    let diagLogged = false;
    let firstFrameHex: string | undefined;

    const ws = new WebSocket(listenUrl);
    ws.binaryType = "arraybuffer";

    const timeout = setTimeout(() => {
      ws.close();
      ctx.close();
      reject(new Error(`Listen connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s`));
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(timeout);
      ctx.resume().catch(() => {});
      nextTime = ctx.currentTime + BUFFER_LEAD_S;
      resolve({
        cleanup: () => { ws.close(); ctx.close(); },
        setMuted: (muted) => { gainNode.gain.value = muted ? 0 : 1; },
        getDebugInfo: () => {
          if (!diagLogged && diagBytesReceived > 0) {
            const elapsed = Date.now() - diagStartMs;
            const inferred = Math.round((diagBytesReceived / elapsed) * 1000 / 2);
            return `PCM S16LE @ ${VAPI_SAMPLE_RATE}Hz | measuring… inferred=${inferred}Hz`;
          }
          return `PCM S16LE @ ${VAPI_SAMPLE_RATE}Hz (ws state=${ws.readyState})`;
        },
      });
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      ctx.close();
      reject(new Error("WebSocket connection failed"));
    };

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") return; // skip JSON control frames
      if (!(event.data instanceof ArrayBuffer) || event.data.byteLength === 0) return;

      // Diagnostic: measure bytes/sec during first DIAG_WINDOW_MS of audio
      if (!diagLogged) {
        const now = Date.now();
        if (diagStartMs === 0) diagStartMs = now;
        diagBytesReceived += event.data.byteLength;
        diagFrames++;

        // Capture first 32 bytes as hex so we can inspect the raw format
        if (!firstFrameHex) {
          const bytes = new Uint8Array(event.data, 0, Math.min(32, event.data.byteLength));
          firstFrameHex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(" ");
        }

        const elapsed = now - diagStartMs;
        if (elapsed >= DIAG_WINDOW_MS) {
          diagLogged = true;
          const bytesPerSec = Math.round((diagBytesReceived / elapsed) * 1000);
          const inferredHz = Math.round(bytesPerSec / 4); // stereo S16LE: 4 bytes/frame
          const line =
            `[vapi-audio] ${diagFrames} frames in ${elapsed}ms` +
            ` | ${diagBytesReceived} bytes | ${bytesPerSec} bytes/s` +
            ` | avg frame=${Math.round(diagBytesReceived / diagFrames)}B` +
            ` | INFERRED HZ (mono S16LE) = ${inferredHz}` +
            ` | playing at ${VAPI_SAMPLE_RATE}` +
            (inferredHz !== VAPI_SAMPLE_RATE ? ` ← MISMATCH` : ` ← ok`);
          // Write to file automatically — no DevTools needed
          (window as any).api?.diag?.writeAudio(line, firstFrameHex);
        }
      }

      const float32 = decodePcmS16le(event.data);
      const audioBuf = ctx.createBuffer(1, float32.length, VAPI_SAMPLE_RATE);
      audioBuf.copyToChannel(float32, 0);

      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(gainNode);

      const now = ctx.currentTime;
      if (nextTime < now) nextTime = now + 0.02; // fell behind — recover gracefully
      if (nextTime > now + MAX_BUFFER_AHEAD_S) nextTime = now + MAX_BUFFER_AHEAD_S; // cap queue
      src.start(nextTime);
      nextTime += audioBuf.duration;
    };
  });
}
