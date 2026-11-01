/**
 * rejection-token-must-verify-in-artifact.spec.ts
 *
 * Locks the 2026-05-03 mechanical guard preventing the
 * rebuild_did_not_address_rejection class of regression. The owner rejected
 * example_video_b four times in a row for the same defects
 * (numbered overlays missing, no music bed, no scene variety) and the
 * auto-regen kept marking it rubric_passed because the rubric ran its
 * own checks but nothing tied them to the actual rejection note.
 *
 * The verify-rejection-tokens-in-artifact.js script is the bridge: it
 * extracts actionable tokens from the latest rejection note, looks up
 * the rebuilt artifact's rubric_scores, and refuses to let the manifest
 * promote to pending_approval unless the rebuild actually addressed
 * what the owner said.
 *
 * Test contract:
 *   1. Stub a manifest where the video has rubric_scores.music_presence=10
 *      (no music) plus a rejection.jsonl entry citing "no music".
 *   2. Run verify-rejection-tokens-in-artifact.js --id <id> as a child.
 *   3. Assert manifest.regen_status is flipped to
 *      'rebuild_did_not_address_rejection'.
 *   4. Assert exit code 1.
 *   5. Assert idempotent (a second run produces the same final state).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';

const REPO = path.resolve(__dirname, '..');
const STUB_ID = 'spec_stub_no_music_video';

// The script resolves content-review/ from its own location, so the spec runs a copy
// of it (plus its two self-contained lib helpers) inside a throwaway mirror under the
// OS temp dir. It used to back up and overwrite the repo's real manifest.json and
// rejections.jsonl in place (Oct 23 audit M3: tests write only under temp).
const MIRROR_FILES = [
  'scripts/verify-rejection-tokens-in-artifact.js',
  'scripts/lib/regen-feedback-directives.js',
  'scripts/lib/rejected-video-feedback.js',
];
let MIRROR = '';
let SCRIPT = '';
let MANIFEST_PATH = '';
let REJECTIONS_PATH = '';

describe('verify-rejection-tokens-in-artifact -- rebuild must address rejection', () => {
  beforeEach(() => {
    MIRROR = fs.mkdtempSync(path.join(os.tmpdir(), 'rejection-token-spec-'));
    for (const rel of MIRROR_FILES) {
      fs.mkdirSync(path.dirname(path.join(MIRROR, rel)), { recursive: true });
      fs.copyFileSync(path.join(REPO, rel), path.join(MIRROR, rel));
    }
    SCRIPT = path.join(MIRROR, MIRROR_FILES[0]);
    MANIFEST_PATH = path.join(MIRROR, 'content-review', 'pending', 'manifest.json');
    REJECTIONS_PATH = path.join(MIRROR, 'content-review', 'rejections.jsonl');
    fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(MIRROR, { recursive: true, force: true });
  });

  it('flips manifest.regen_status to rebuild_did_not_address_rejection when music_presence is too low', () => {
    // Stub manifest: video flagged rubric_passed but with music_presence=10
    const manifest = {
      videos: [
        {
          id: STUB_ID,
          title: 'Stub Video for Spec',
          channel: 'Examplechannel',
          status: 'pending_approval',
          regen_status: 'rubric_passed',
          rubric_overall_score: 80,
          rubric_scores: {
            music_presence: 10,
            numbered_overlays: 100,
            thumbnail_first_frame: 100,
            scene_variety: 65,
            volume_levels: 80,
          },
        },
      ],
    };
    fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');

    // Stub rejections: a rejection citing "no music" for this video
    const rejection = {
      id: STUB_ID,
      title: 'Stub Video for Spec',
      channel: 'Examplechannel',
      target: 'video',
      note: 'no music in this rebuild, where is the background track?',
      rejectedAt: '2026-05-03T00:00:00.000Z',
    };
    fs.writeFileSync(REJECTIONS_PATH, JSON.stringify(rejection) + '\n', 'utf8');

    const result = spawnSync('node', [SCRIPT, '--id', STUB_ID], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);

    const after = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const v = after.videos.find((x: any) => x.id === STUB_ID);
    expect(v).toBeTruthy();
    expect(v.regen_status).toBe('rebuild_did_not_address_rejection');
    expect(v.regen_unaddressed_rejection).toMatch(/music_presence/);
    expect(v.regen_unaddressed_rejection_details).toBeTruthy();
    expect(Array.isArray(v.regen_unaddressed_rejection_details)).toBe(true);
    expect(v.video_needs_regen).toBe(true);
  });

  it('passes when rubric_scores meet every required floor for the rejection tokens', () => {
    const manifest = {
      videos: [
        {
          id: STUB_ID,
          title: 'Stub Video for Spec',
          channel: 'Examplechannel',
          status: 'pending_approval',
          regen_status: 'rubric_passed',
          rubric_overall_score: 90,
          rubric_scores: {
            music_presence: 88,
            numbered_overlays: 100,
            thumbnail_first_frame: 100,
            scene_variety: 75,
          },
        },
      ],
    };
    fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');

    const rejection = {
      id: STUB_ID,
      title: 'Stub Video for Spec',
      channel: 'Examplechannel',
      target: 'video',
      note: 'add music background track to this',
      rejectedAt: '2026-05-03T00:00:00.000Z',
    };
    fs.writeFileSync(REJECTIONS_PATH, JSON.stringify(rejection) + '\n', 'utf8');

    const result = spawnSync('node', [SCRIPT, '--id', STUB_ID], { encoding: 'utf8' });
    expect(result.status).toBe(0);

    const after = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const v = after.videos.find((x: any) => x.id === STUB_ID);
    expect(v.regen_status).toBe('rubric_passed');
    expect(v.regen_unaddressed_rejection).toBeUndefined();
  });

  it('is idempotent: second run produces the same final state', () => {
    const manifest = {
      videos: [
        {
          id: STUB_ID,
          title: 'Stub',
          status: 'pending_approval',
          regen_status: 'rubric_passed',
          rubric_scores: { music_presence: 5 },
        },
      ],
    };
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(
      REJECTIONS_PATH,
      JSON.stringify({
        id: STUB_ID,
        target: 'video',
        note: 'no music background',
        rejectedAt: '2026-05-03T00:00:00.000Z',
      }) + '\n',
      'utf8',
    );

    const r1 = spawnSync('node', [SCRIPT, '--id', STUB_ID], { encoding: 'utf8' });
    expect(r1.status).toBe(1);
    const after1 = fs.readFileSync(MANIFEST_PATH, 'utf8');

    const r2 = spawnSync('node', [SCRIPT, '--id', STUB_ID], { encoding: 'utf8' });
    expect(r2.status).toBe(1);
    const after2 = fs.readFileSync(MANIFEST_PATH, 'utf8');

    // Idempotency: same regen_status, same flag, same details list
    const m1 = JSON.parse(after1).videos.find((x: any) => x.id === STUB_ID);
    const m2 = JSON.parse(after2).videos.find((x: any) => x.id === STUB_ID);
    expect(m1.regen_status).toBe(m2.regen_status);
    expect(m1.regen_unaddressed_rejection).toBe(m2.regen_unaddressed_rejection);
    expect(m1.video_needs_regen).toBe(m2.video_needs_regen);
  });

  // E6 (2026-06-13, commit 08ccbf0e): a vague rejection note that matches no
  // specific TOKEN_RULE must NOT be a silent no-op. The pre-E6 gate fired zero
  // rules on notes like "Boring footage" and promoted the unchanged video.
  // evaluate() now maps an unmapped note onto ALL rubric criteria and fails
  // closed on any criterion the rebuilt artifact was not scored on.
  it('fails closed (flags all criteria) when the note maps to no specific token rule', () => {
    const manifest = {
      videos: [
        {
          id: STUB_ID,
          title: 'Stub',
          status: 'pending_approval',
          regen_status: 'rubric_passed',
          rubric_scores: { music_presence: 5 },
        },
      ],
    };
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(
      REJECTIONS_PATH,
      JSON.stringify({
        id: STUB_ID,
        target: 'video',
        note: 'just feels off, please redo',
        rejectedAt: '2026-05-03T00:00:00.000Z',
      }) + '\n',
      'utf8',
    );

    const result = spawnSync('node', [SCRIPT, '--id', STUB_ID], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    const after = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const v = after.videos.find((x: any) => x.id === STUB_ID);
    expect(v.regen_status).toBe('rebuild_did_not_address_rejection');
    expect(v.video_needs_regen).toBe(true);
  });
});
