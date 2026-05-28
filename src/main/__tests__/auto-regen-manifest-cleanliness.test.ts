/**
 * Regression test: content-review manifest cannot carry the legacy
 * "rejection is not defined" failure marker, and the regen loop must
 * refuse to promote a video that still has blank frames in the
 * content_gate sample.
 *
 * Background (2026-05-23): three videos were stuck in
 * content-review/pending/manifest.json, two with the obsolete
 * `regen_error: "rejection is not defined"` from a fixed bug, one
 * (short009_hggs) with `regen_status: "rubric_passed"` but a blank
 * frame in its content_gate sample. The briefing's blocker card lit
 * up because of these. After Amy clears the stale errors and the
 * blank-frame promotion gate is wired in, this test locks the
 * invariants so a future regression cannot resurface them.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..', '..', '..');
const MANIFEST_PATH = path.join(REPO, 'content-review', 'pending', 'manifest.json');

interface Video {
  id: string;
  status?: string;
  regen_status?: string;
  regen_error?: string;
  video_needs_regen?: boolean;
  thumbnail_needs_regen?: boolean;
  regen_video_metrics?: {
    content_gate?: {
      samples_taken?: number;
      samples_blank?: number;
    };
  };
}

interface Manifest {
  videos: Video[];
}

function loadManifest(): Manifest | null {
  try {
    if (!fs.existsSync(MANIFEST_PATH)) return null;
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

describe('content-review manifest cleanliness', () => {
  it('does not carry the legacy "rejection is not defined" failure marker', () => {
    const m = loadManifest();
    if (!m) return; // No manifest in CI is fine; this guards local state.
    const offenders = (m.videos || []).filter((v) => v && v.regen_error === 'rejection is not defined');
    expect(offenders.map((v) => v.id)).toEqual([]);
  });

  it('no video is simultaneously promoted (rubric_passed) AND carries a blank-frame content_gate finding', () => {
    const m = loadManifest();
    if (!m) return;
    const offenders: string[] = [];
    for (const v of m.videos || []) {
      const gate = v && v.regen_video_metrics && v.regen_video_metrics.content_gate;
      const blank = gate && Number(gate.samples_blank || 0) > 0;
      if (v && v.regen_status === 'rubric_passed' && blank) {
        offenders.push(v.id);
      }
    }
    expect(offenders, `blank-frame promotion guard violated for: ${offenders.join(', ')}`).toEqual([]);
  });
});
