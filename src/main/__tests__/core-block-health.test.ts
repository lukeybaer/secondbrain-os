// core-block-health.test.ts
//
// Verifies the core-memory observability digest: status classification,
// refinement-pending detection, and the briefing formatter's clean/attention
// behavior.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeBlock } from '../core-memory-blocks';
import { enqueueSleepTrigger } from '../sleep-time-trigger-queue';
import {
  getCoreBlockHealth,
  formatCoreBlockHealthForBriefing,
} from '../core-block-health';

describe('core-block-health', () => {
  let blocksDir: string;
  let queueDir: string;
  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'block-health-'));
    blocksDir = path.join(root, 'blocks');
    queueDir = path.join(root, 'queue');
  });
  afterEach(() => {
    fs.rmSync(path.dirname(blocksDir), { recursive: true, force: true });
  });

  it('classifies status by ratio and read-only', () => {
    writeBlock(blocksDir, 'ok', 'x'.repeat(10), 100); // 0.1
    writeBlock(blocksDir, 'watch', 'x'.repeat(85), 100); // 0.85
    writeBlock(blocksDir, 'full', 'x'.repeat(95), 100); // 0.95
    writeBlock(blocksDir, 'locked', 'x'.repeat(99), 100, { read_only: true });

    const rows = getCoreBlockHealth(blocksDir, queueDir);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.status]));
    expect(byName.ok).toBe('ok');
    expect(byName.watch).toBe('watch');
    expect(byName.full).toBe('full');
    expect(byName.locked).toBe('locked'); // read-only wins regardless of ratio
  });

  it('detects a pending refinement trigger for a block', () => {
    writeBlock(blocksDir, 'scratchpad', 'x'.repeat(90), 100);
    enqueueSleepTrigger(queueDir, {
      type: 'memory-block-recompress',
      key: 'block:scratchpad',
      source: 'test',
    });
    const rows = getCoreBlockHealth(blocksDir, queueDir);
    expect(rows.find((r) => r.name === 'scratchpad')?.refinementPending).toBe(true);
  });

  it('formats a clean one-liner when all blocks are healthy', () => {
    writeBlock(blocksDir, 'a', 'x'.repeat(10), 100);
    writeBlock(blocksDir, 'b', 'x'.repeat(20), 100);
    const out = formatCoreBlockHealthForBriefing(blocksDir, queueDir);
    expect(out).toContain('2 blocks healthy');
    expect(out).not.toContain('watch');
  });

  it('lists blocks needing attention with refinement state', () => {
    writeBlock(blocksDir, 'big', 'x'.repeat(92), 100);
    enqueueSleepTrigger(queueDir, {
      type: 'memory-block-recompress',
      key: 'block:big',
      source: 'test',
    });
    const out = formatCoreBlockHealthForBriefing(blocksDir, queueDir);
    expect(out).toContain('need attention');
    expect(out).toContain('big: 92% (FULL, refinement queued)');
  });

  it('handles the empty case', () => {
    expect(formatCoreBlockHealthForBriefing(blocksDir, queueDir)).toBe('Core memory: no blocks');
  });
});
