import type { TimeMachineStorageForecast } from './timemachine-types';

export interface ForecastFrameRow {
  file_size: number;
  is_duplicate: number;
  local_path: string | null;
}

export interface ForecastAudioRow {
  local_path: string | null;
  file_size?: number | null;
}

export function computeStorageForecast(input: {
  frames: ForecastFrameRow[];
  audioSegments: ForecastAudioRow[];
  captureIntervalMs: number;
  retentionScreenshotDays: number;
}): TimeMachineStorageForecast {
  const nonDuplicateFrames = input.frames.filter((f) => !f.is_duplicate && f.file_size > 0);
  const totalFrameBytes = nonDuplicateFrames.reduce((sum, f) => sum + f.file_size, 0);
  const averageScreenshotBytes =
    nonDuplicateFrames.length > 0 ? Math.round(totalFrameBytes / nonDuplicateFrames.length) : 0;
  const interval = Math.max(input.captureIntervalMs, 1);
  const screenshotsPerDay = Math.round((24 * 60 * 60 * 1000) / interval);
  const estimatedScreenshotRetentionBytes =
    averageScreenshotBytes * screenshotsPerDay * Math.max(input.retentionScreenshotDays, 0);
  const existingLocalScreenshotBytes = input.frames
    .filter((f) => f.local_path)
    .reduce((sum, f) => sum + Math.max(f.file_size || 0, 0), 0);
  const existingLocalAudioBytes = input.audioSegments
    .filter((a) => a.local_path)
    .reduce((sum, a) => sum + Math.max(a.file_size || 0, 0), 0);

  return {
    averageScreenshotBytes,
    screenshotsPerDay,
    estimatedScreenshotRetentionBytes,
    existingLocalScreenshotBytes,
    existingLocalAudioBytes,
    estimatedRetainedTotalBytes: estimatedScreenshotRetentionBytes + existingLocalAudioBytes,
  };
}

