import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '',
  },
}));

vi.mock('better-sqlite3', () => ({
  default: vi.fn(),
}));

import { generateActivityClusters } from '../timemachine-db';
import type { TmFrame } from '../timemachine-db';

function frame(id: number, timestamp: string, ocr_text = ''): TmFrame {
  return {
    id,
    timestamp,
    ocr_text,
    s3_key: null,
    local_path: null,
    file_size: 100,
    is_duplicate: 0,
    created_at: timestamp,
  };
}

describe('Time Machine clustering', () => {
  it('groups frames within gap and splits beyond gap', () => {
    const clusters = generateActivityClusters(
      [
        frame(1, '2026-05-16T10:00:00.000Z'),
        frame(2, '2026-05-16T10:04:00.000Z'),
        frame(3, '2026-05-16T10:20:00.000Z'),
      ],
      5,
    );
    expect(clusters).toHaveLength(2);
    expect(clusters[0].frameCount).toBe(2);
    expect(clusters[1].frameCount).toBe(1);
  });

  it('picks a representative frame and top OCR terms', () => {
    const clusters = generateActivityClusters(
      [
        frame(1, '2026-05-16T10:00:00.000Z', 'alpha beta beta project'),
        frame(2, '2026-05-16T10:01:00.000Z', 'beta project gamma'),
        frame(3, '2026-05-16T10:02:00.000Z', 'gamma gamma beta'),
      ],
      5,
      2,
    );
    expect(clusters[0].representativeFrame?.id).toBe(2);
    expect(clusters[0].topOcrTerms).toEqual(['beta', 'gamma']);
  });
});
