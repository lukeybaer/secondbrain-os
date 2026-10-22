// studio-policy.ts
// Pure planning helpers for Studio multi-camera recording reliability (E4).
// No I/O, no Electron, no child_process: everything here is unit-testable.
//
// Why this exists:
// - USB bandwidth budget: raw (uncompressed) dshow capture from 3+ cameras
//   floods a shared USB controller. Cameras 1-2 keep the proven
//   raw-default-first order (ExampleCam raw YUV stable 760s+ while MJPEG 720p
//   died at 60-160s on USB 2.0). Cameras 3+ start at MJPEG 1280x720 and
//   normally never try raw. A built-in camera that commonly exposes only raw
//   formats gets one explicit 640x480 raw fallback rather than unrestricted
//   default negotiation.
// - Front (hero) camera asks for MJPEG 1920x1080 first. "Default" dshow
//   negotiation picked the ExampleCam's 640x480 4:3 mode, which center-crops
//   the 16:9 sensor (narrower than a video call) and forced a 2x upscale in
//   the final edit (soft, blurry presenter). The old order follows as fallback.
// - Staggered starts: simultaneous dshow opens are the main USB overload
//   trigger. Screen starts at t=0, camera i at screenFirstMs + i*perCameraMs.
// - Sync anchors: each capture process records its spawn wall-clock time so
//   the render path can offset later-started inputs and keep screen audio
//   aligned with the cameras.

export interface CameraFormat {
  vcodec: string;
  videoSize: string;
  pixelFormat?: string;
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

const MJPEG_1080: CameraFormat = { vcodec: 'mjpeg', videoSize: '1920x1080' };
const MJPEG_720: CameraFormat = { vcodec: 'mjpeg', videoSize: '1280x720' };
const MJPEG_480: CameraFormat = { vcodec: 'mjpeg', videoSize: '640x480' };
const RAW_480: CameraFormat = {
  vcodec: 'rawvideo',
  videoSize: '640x480',
  pixelFormat: 'nv12',
};

function isBuiltInCameraName(name: string): boolean {
  return /\bintegrated\b|\bbuilt[- ]?in\b/i.test(name);
}

function isExampleCamN60(name: string): boolean {
  return /\bnexigo n60\b/i.test(name);
}

/**
 * Build the ordered per-camera format plan implementing the USB bandwidth
 * budget. A non-built-in camera at position 'front' asks for full-width
 * MJPEG 1920x1080 first, then falls back to the order below. Other cameras
 * at index 0-1 keep the raw-default-first order (then MJPEG 1280x720, then
 * MJPEG 640x480). Cameras at index 2+ get MJPEG 1280x720 first,
 * then MJPEG 640x480. Integrated/built-in cameras use constrained rawvideo
 * 640x480 first because many laptop cameras advertise no MJPEG.
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
    const isBuiltInCamera = isBuiltInCameraName(camera.name);
    const fullPlan: CameraFormatPlan = isBuiltInCamera
      ? [{ ...RAW_480 }, { ...MJPEG_720 }, { ...MJPEG_480 }]
      : cameras.length >= 3 && isExampleCamN60(camera.name)
        ? [{ ...MJPEG_480 }]
        : camera.position === 'front'
        ? [{ ...MJPEG_1080 }, undefined, { ...MJPEG_720 }, { ...MJPEG_480 }]
        : index < 2
        ? [undefined, { ...MJPEG_720 }, { ...MJPEG_480 }]
        : [
          { ...MJPEG_720 },
          { ...MJPEG_480 },
        ];

    const probe = probeResults?.[camera.name];
    if (!probe || probe.probeFailed || !probe.unsupported || probe.unsupported.length === 0) {
      return { camera, formats: fullPlan };
    }

    const filtered = fullPlan.filter((fmt) => !probe.unsupported!.includes(formatLabel(fmt)));
    return { camera, formats: filtered.length > 0 ? filtered : fullPlan };
  });
}

/** The front camera standard: full-width 16:9 1080p. Anything less is a regression. */
export const FRONT_CAMERA_STANDARD = '1920x1080';

const POSITIONS = ['front', 'side', 'overhead', 'extra'] as const;
export type CameraPosition = (typeof POSITIONS)[number];

/**
 * Assign Studio positions to detected cameras. The camera named
 * `frontCameraName` (case-insensitive) is always 'front', so a USB port or
 * enumeration-order change can never demote it to a low-resolution cutaway.
 * Other cameras fill side, overhead, extra in detection order. With no match
 * the legacy detection-order assignment applies.
 */
export function assignCameraPositions(
  names: string[],
  frontCameraName?: string,
): CameraPosition[] {
  const want = (frontCameraName || '').trim().toLowerCase();
  const frontIdx = want ? names.findIndex((n) => n.trim().toLowerCase() === want) : -1;
  if (frontIdx < 0) return names.map((_, i) => POSITIONS[i] || 'extra');
  let next = 1;
  return names.map((_, i) => (i === frontIdx ? 'front' : POSITIONS[next++] || 'extra'));
}

/**
 * Warning text when the front camera did not start at or above the 1080p
 * standard, else null. Default negotiation is reported as unpinned, not as a
 * known low size (on the ExampleCam it is 640x480).
 */
export function frontCameraFormatWarning(
  position: string,
  fmt: CameraFormat | undefined,
): string | null {
  if (position !== 'front') return null;
  if (!fmt) {
    return `Front camera started on its default mode, not the ${FRONT_CAMERA_STANDARD} standard; most webcams default to a cropped, soft 640x480.`;
  }
  const size = /^(\d+)x(\d+)$/.exec(fmt.videoSize);
  if (!size) {
    return `Front camera started with an unrecognized size (${fmt.vcodec} ${fmt.videoSize}); expected ${FRONT_CAMERA_STANDARD}.`;
  }
  if (Number(size[1]) >= 1920 && Number(size[2]) >= 1080) return null;
  return `Front camera is recording below the ${FRONT_CAMERA_STANDARD} standard (${fmt.vcodec} ${fmt.videoSize}); the picture will be cropped and soft.`;
}

/**
 * Open the built-in camera first, then the low-bandwidth N60 mode, before the
 * remaining external cameras consume the shared USB controller budget.
 */
export function orderCameraPlansForStartup(plans: CameraPlan[]): CameraPlan[] {
  const prioritizeN60 = plans.length >= 3;
  return plans
    .map((plan, index) => ({ plan, index }))
    .sort((a, b) => {
      const priority = (name: string) =>
        isBuiltInCameraName(name) ? 0 : prioritizeN60 && isExampleCamN60(name) ? 1 : 2;
      return priority(a.plan.camera.name) - priority(b.plan.camera.name) || a.index - b.index;
    })
    .map(({ plan }) => plan);
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
