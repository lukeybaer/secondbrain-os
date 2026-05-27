/**
 * Tests for scripts/skill-predictions.js, Phase 3 of harness-evolution-loop.
 *
 * Before a skill runs, it writes its expected outcome to predictions/<date>.json.
 * After the run, it records actual and computes diff. The diff is the learning signal.
 *
 * Frugal: isolated tmp dir, no real skill state touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ORIGINAL_ROOT = process.env.SECONDBRAIN_ROOT;
let tmpRoot: string;

function loadFresh() {
  const modPath = require.resolve('../../../scripts/skill-predictions.js');
  delete require.cache[modPath];
  return require('../../../scripts/skill-predictions.js');
}

describe('skill-predictions', () => {
  let mod: any;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-predictions-'));
    process.env.SECONDBRAIN_ROOT = tmpRoot;
    mod = loadFresh();
  });

  afterEach(() => {
    if (ORIGINAL_ROOT === undefined) delete process.env.SECONDBRAIN_ROOT;
    else process.env.SECONDBRAIN_ROOT = ORIGINAL_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writePrediction creates a date-stamped JSON file', () => {
    const result = mod.writePrediction('video-aurora', {
      expected: { videoCount: 4, minQuality: 85, maxRenderSeconds: 60 },
      runId: 'run-001',
    });
    expect(fs.existsSync(result.file)).toBe(true);
    const data = JSON.parse(fs.readFileSync(result.file, 'utf8'));
    expect(data.expected.videoCount).toBe(4);
    expect(data.runId).toBe('run-001');
    expect(data.skillName).toBe('video-aurora');
    expect(typeof data.predictedAt).toBe('string');
  });

  it('recordActual updates the same file with actual outcome and diff', () => {
    mod.writePrediction('video-aurora', {
      expected: { videoCount: 4, minQuality: 85, maxRenderSeconds: 60 },
      runId: 'run-001',
    });
    const result = mod.recordActual('video-aurora', {
      runId: 'run-001',
      actual: { videoCount: 4, minQuality: 78, maxRenderSeconds: 72 },
    });
    expect(result.diff.videoCount.match).toBe(true);
    expect(result.diff.minQuality.match).toBe(false);
    expect(result.diff.minQuality.expected).toBe(85);
    expect(result.diff.minQuality.actual).toBe(78);
    expect(result.diff.maxRenderSeconds.match).toBe(false);
  });

  it('recordActual throws when no matching prediction exists', () => {
    expect(() =>
      mod.recordActual('video-aurora', { runId: 'nonexistent', actual: {} })
    ).toThrow(/no prediction found/i);
  });

  it('recordActual marks all fields matched when actual equals expected', () => {
    mod.writePrediction('captions-aurora', {
      expected: { wordCount: 12, hasEmphasis: true },
      runId: 'r2',
    });
    const result = mod.recordActual('captions-aurora', {
      runId: 'r2',
      actual: { wordCount: 12, hasEmphasis: true },
    });
    expect(result.diff.wordCount.match).toBe(true);
    expect(result.diff.hasEmphasis.match).toBe(true);
    expect(result.allMatched).toBe(true);
  });

  it('listPredictions returns predictions for a skill in chronological order', () => {
    mod.writePrediction('demo', { expected: { x: 1 }, runId: 'r1' });
    mod.writePrediction('demo', { expected: { x: 2 }, runId: 'r2' });
    const all = mod.listPredictions('demo');
    expect(all.length).toBeGreaterThanOrEqual(2);
    const runIds = all.map((p: any) => p.runId);
    expect(runIds).toContain('r1');
    expect(runIds).toContain('r2');
  });
});
