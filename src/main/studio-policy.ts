// studio-policy.ts
// Pure planning helpers for Studio multi-camera recording reliability (E4).
// No I/O, no Electron, no child_process: everything here is unit-testable.
//
// Why this exists:
// - USB bandwidth budget: raw (uncompressed) dshow capture from 3+ cameras
//   floods a shared USB controller. Cameras 1-2 keep the proven
//   raw-default-first order (NexiGo raw YUV stable 760s+ while MJPEG 720p
//   died at 60-160s on USB 2.0). Cameras 3+ start at MJPEG 1280x720 and
//   never try raw.
// - Staggered starts: simultaneous dshow opens are the main USB overload
//   trigger. Screen starts at t=0, camera i at screenFirstMs + i*perCameraMs.
// - Sync anchors: each capture process records its spawn wall-clock time so
//   the render path can offset later-started inputs and keep screen audio
//   aligned with the cameras.

export interface CameraFormat {
  vcodec: string;
  videoSize: string;
}

/** undefined = default format (let dshow negotiate, typically raw YUV). */
export type CameraFormatPlan = Array<CameraFormat | undefined>;

export interface CameraLike {
  name: string;
  position: string;
}

export interface CameraProbeResult {
  /** The probe itself failed (spawn error, timeout, device busy): keep the full plan. */
  probeFailed?: boolean;
  /** Format labels verified unsupported for this camera, e.g. 'default', 'mjpeg:1280x720'. */
  unsupported?: string[];
}

/** Keyed by camera name. */
export type CameraProbeResults = Record<string, CameraProbeResult>;

export interface CameraPlan {
  camera: CameraLike;
  formats: CameraFormatPlan;
}

/** Stable label for a format entry, used to match probe results against plans. */
export function formatLabel(fmt: CameraFormat | undefined): string {
  return fmt ? `${fmt.vcodec}:${fmt.videoSize}` : 'default';
}

const MJPEG_720: CameraFormat = { vcodec: 'mjpeg', videoSize: '1280x720' };
const MJPEG_480: CameraFormat = { vcodec: 'mjpeg', videoSize: '640x480' };

/**
 * Build the ordered per-camera format plan implementing the USB bandwidth
 * budget. Cameras at index 0-1 keep today's order (raw default first, then
 * MJPEG 1280x720, then MJPEG 640x480), which preserves the NexiGo
 * default-first regression. Cameras at index 2+ get MJPEG 1280x720 first,
 * then MJPEG 640x480, and never raw.
 *
 * If a probe result marks a format unsupported it is dropped from that
 * camera's plan. A probe failure, or a probe that would empty the plan,
 * leaves the full plan intact: a probe must never block recording.
 */
export function planCameraFormats(
  cameras: CameraLike[],
  probeResults?: CameraProbeResults,
): CameraPlan[] {
  return cameras.map((camera, index) => {
    const fullPlan: CameraFormatPlan =
      index < 2
        ? [undefined, { ...MJPEG_720 }, { ...MJPEG_480 }]
        : [{ ...MJPEG_720 }, { ...MJPEG_480 }];

    const probe = probeResults?.[camera.name];
    if (!probe || probe.probeFailed || !probe.unsupported || probe.unsupported.length === 0) {
      return { camera, formats: fullPlan };
    }

    const filtered = fullPlan.filter((fmt) => !probe.unsupported!.includes(formatLabel(fmt)));
    return { camera, formats: filtered.length > 0 ? filtered : fullPlan };
  });
}

export interface StaggerOptions {
  screenFirstMs?: number;
  perCameraMs?: number;
}

/**
 * Delay (ms from recording start) at which camera `cameraIndex` may spawn.
 * The screen recording starts first at t=0; camera i starts at
 * screenFirstMs + i * perCameraMs.
 */
export function startStagger(cameraIndex: number, opts: StaggerOptions = {}): number {
  const { screenFirstMs = 200, perCameraMs = 500 } = opts;
  return screenFirstMs + cameraIndex * perCameraMs;
}

/**
 * Per-source start offsets in ms relative to the earliest anchor.
 * Input: {position: spawnedAtMs}. Output: {position: offsetMs} where the
 * earliest-started source has offset 0. Missing/empty anchors return {}
 * so old recordings take the legacy (no-offset) path.
 */
export function computeSyncOffsets(
  syncAnchors: Record<string, number> | undefined,
): Record<string, number> {
  if (!syncAnchors) return {};
  const entries = Object.entries(syncAnchors).filter(
    ([, v]) => typeof v === 'number' && Number.isFinite(v),
  );
  if (entries.length === 0) return {};
  const earliest = Math.min(...entries.map(([, v]) => v));
  const offsets: Record<string, number> = {};
  for (const [position, spawnedAtMs] of entries) {
    offsets[position] = spawnedAtMs - earliest;
  }
  return offsets;
}
