// core-block-refinement-scanner.test.ts
//
// Verifies the proactive sleep-time refinement scanner: near-full writable
// blocks get a recompression trigger, read-only blocks are skipped, low blocks
// are left alone, and repeated scans dedupe.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeBlock } from '../core-memory-blocks';
import { listPendingTriggers } from '../sleep-time-trigger-queue';
import { scanAndEnqueueBlockRefinement } from '../core-block-refinement-scanner';

describe('core-block-refinement-scanner', () => {
  let blocksDir: string;
  let queueDir: string;
  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refine-scan-'));
    blocksDir = path.join(root, 'blocks');
    queueDir = path.join(root, 'queue');
  });
  afterEach(() => {
    fs.rmSync(path.dirname(blocksDir), { recursive: true, force: true });
  });

  it('enqueues a recompress trigger for a writable near-full block', () => {
    writeBlock(blocksDir, 'scratchpad', 'x'.repeat(90), 100); // 0.9 ratio
    const result = scanAndEnqueueBlockRefinement(blocksDir, queueDir, { threshold: 0.8 });

    expect(result.enqueued.map((e) => e.name)).toEqual(['scratchpad']);
    const pending = listPendingTriggers(queueDir);
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe('memory-block-recompress');
    expect(pending[0].key).toBe('block:scratchpad');
    expect(pending[0].payload?.ratio).toBeCloseTo(0.9, 5);
  });

  it('leaves blocks below threshold alone', () => {
    writeBlock(blocksDir, 'small', 'x'.repeat(10), 100); // 0.1 ratio
    const result = scanAndEnqueueBlockRefinement(blocksDir, queueDir, { threshold: 0.8 });
    expect(result.enqueued).toHaveLength(0);
    expect(result.belowThreshold).toContain('small');
    expect(listPendingTriggers(queueDir)).toHaveLength(0);
  });

  it('skips read-only blocks even when full', () => {
    writeBlock(blocksDir, 'persona', 'x'.repeat(95), 100, { read_only: true });
    const result = scanAndEnqueueBlockRefinement(blocksDir, queueDir, { threshold: 0.8 });
    expect(result.skippedReadOnly).toContain('persona');
    expect(result.enqueued).toHaveLength(0);
    expect(listPendingTriggers(queueDir)).toHaveLength(0);
  });

  it('dedupes repeated scans within the dedupe window', () => {
    writeBlock(blocksDir, 'scratchpad', 'x'.repeat(90), 100);
    const base = new Date('2026-05-30T00:00:00Z');
    scanAndEnqueueBlockRefinement(blocksDir, queueDir, { threshold: 0.8, now: base });
    // second scan 1 minute later, well inside the default 12h dedupe window
    scanAndEnqueueBlockRefinement(blocksDir, queueDir, {
      threshold: 0.8,
      now: new Date(base.getTime() + 60_000),
    });
    expect(listPendingTriggers(queueDir)).toHaveLength(1);
  });

  it('reports scanned count across mixed blocks', () => {
    writeBlock(blocksDir, 'full', 'x'.repeat(90), 100);
    writeBlock(blocksDir, 'low', 'x'.repeat(10), 100);
    writeBlock(blocksDir, 'locked', 'x'.repeat(95), 100, { read_only: true });
    const result = scanAndEnqueueBlockRefinement(blocksDir, queueDir, { threshold: 0.8 });
    expect(result.scanned).toBe(3);
    expect(result.enqueued.map((e) => e.name)).toEqual(['full']);
    expect(result.skippedReadOnly).toEqual(['locked']);
    expect(result.belowThreshold).toEqual(['low']);
  });
});
