import { describe, it, expect } from 'vitest';
import { computeStorageForecast } from '../timemachine-analytics';

describe('Time Machine analytics', () => {
  it('computes daily estimate from interval and average frame size', () => {
    const forecast = computeStorageForecast({
      frames: [
        { file_size: 1000, is_duplicate: 0, local_path: 'a' },
        { file_size: 3000, is_duplicate: 0, local_path: null },
        { file_size: 9000, is_duplicate: 1, local_path: 'dup' },
      ],
      audioSegments: [{ local_path: 'audio', file_size: 500 }],
      captureIntervalMs: 3000,
      retentionScreenshotDays: 7,
    });

    expect(forecast.averageScreenshotBytes).toBe(2000);
    expect(forecast.screenshotsPerDay).toBe(28800);
    expect(forecast.estimatedScreenshotRetentionBytes).toBe(403200000);
    expect(forecast.existingLocalScreenshotBytes).toBe(10000);
    expect(forecast.existingLocalAudioBytes).toBe(500);
  });

  it('handles empty DB rows safely', () => {
    const forecast = computeStorageForecast({
      frames: [],
      audioSegments: [],
      captureIntervalMs: 3000,
      retentionScreenshotDays: 7,
    });
    expect(forecast.averageScreenshotBytes).toBe(0);
    expect(forecast.estimatedRetainedTotalBytes).toBe(0);
  });
});

