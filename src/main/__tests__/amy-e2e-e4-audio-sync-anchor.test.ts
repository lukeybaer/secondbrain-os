import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSyncOffsets } from '../studio-policy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const studioSource = fs.readFileSync(path.join(REPO, 'src/main/studio.ts'), 'utf8');
const renderSource = fs.readFileSync(path.join(REPO, 'src/main/studio-render.ts'), 'utf8');

describe('E4-K5 audio sync anchors', () => {
  it('computes source offsets relative to the earliest capture', () => {
    expect(
      computeSyncOffsets({
        screen: 1_000,
        front: 1_250,
        side: 1_900,
      }),
    ).toEqual({ screen: 0, front: 250, side: 900 });
  });

  it('returns legacy zero-offset behavior when no anchors are present', () => {
    expect(computeSyncOffsets(undefined)).toEqual({});
    expect(computeSyncOffsets({})).toEqual({});
  });

  it('records spawn wall-clock anchors and applies them during rendering', () => {
    expect(studioSource).toContain('const syncAnchors: Record<string, number> = {}');
    expect(studioSource).toContain("syncAnchors['screen'] = Date.now()");
    expect(studioSource).toContain('syncAnchors[cam.position] = spawnedAtMs');
    expect(studioSource).toContain('syncAnchors,');
    expect(renderSource).toContain('const offsetsMs = computeSyncOffsets(recording.syncAnchors)');
    expect(renderSource).toContain('d.start - videoOffsetSec');
    expect(renderSource).toContain('d.start - audioOffsetSec');
  });
});
