// sleep-time-consolidation.test.ts
//
// Tests for the sleep-time consolidation module.
// The Anthropic SDK call is mocked so no real API calls are made.
// We only test the routing logic (skip below threshold, consolidate above,
// handle errors gracefully) and the path helper.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeBlock, readBlock } from '../core-memory-blocks';

// ── Mock Anthropic ────────────────────────────────────────────────────────────

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
      constructor(_opts?: { apiKey?: string }) {}
    },
  };
});

// ── Mock electron (app.getPath) ───────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/mock/userData') },
}));

// ── Mock config ───────────────────────────────────────────────────────────────

vi.mock('../config', () => ({
  getConfig: vi.fn().mockReturnValue({ anthropicApiKey: 'test-key' }),
}));

// ── Import after mocks are set up ─────────────────────────────────────────────

import { runSleepTimeConsolidation } from '../sleep-time-consolidation';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-consolidation-'));
}

function cleanup(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('sleep-time-consolidation', () => {
  let dir: string;
  let oldCodexDown: string | undefined;
  let oldApprovedUntil: string | undefined;

  beforeEach(() => {
    dir = makeTmpDir();
    mockCreate.mockReset();
    oldCodexDown = process.env.AMY_CODEX_DOWN_PROVEN;
    oldApprovedUntil = process.env.AMY_CHARGED_LLM_API_APPROVED_UNTIL;
    process.env.AMY_CODEX_DOWN_PROVEN = '1';
    process.env.AMY_CHARGED_LLM_API_APPROVED_UNTIL = new Date(Date.now() + 60_000).toISOString();
  });

  afterEach(() => {
    cleanup(dir);
    if (oldCodexDown == null) delete process.env.AMY_CODEX_DOWN_PROVEN;
    else process.env.AMY_CODEX_DOWN_PROVEN = oldCodexDown;
    if (oldApprovedUntil == null) delete process.env.AMY_CHARGED_LLM_API_APPROVED_UNTIL;
    else process.env.AMY_CHARGED_LLM_API_APPROVED_UNTIL = oldApprovedUntil;
  });

  it('returns no-blocks result when dir has no blocks', async () => {
    const result = await runSleepTimeConsolidation(dir);
    expect(result.blocksChecked).toBe(0);
    expect(result.blocksConsolidated).toBe(0);
  });

  it('skips blocks below 80% usage threshold', async () => {
    // Write a block that is well under the 2000-byte limit (< 80%)
    const content = 'Short content.'; // well under 1600 bytes
    writeBlock(dir, 'persona', content, 2000);

    const result = await runSleepTimeConsolidation(dir);
    expect(result.blocksChecked).toBe(1);
    expect(result.blocksConsolidated).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.details[0].skipped).toBe(true);
    expect(result.details[0].reason).toContain('below');
  });

  it('consolidates blocks over 80% usage', async () => {
    const limit = 500;
    // Content that fills > 80% of the 500-byte limit
    const content = 'A'.repeat(420); // 84% usage
    writeBlock(dir, 'human', content, limit);

    const compressed = 'B'.repeat(200); // smaller
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: compressed }],
    });

    const result = await runSleepTimeConsolidation(dir);
    expect(result.blocksChecked).toBe(1);
    expect(result.blocksConsolidated).toBe(1);
    expect(result.bytesSaved).toBe(420 - 200);

    // Verify the block was actually rewritten
    const updated = readBlock(dir, 'human');
    expect(updated?.content).toBe(compressed);
  });

  it('skips consolidation when compressed result is not smaller', async () => {
    const limit = 500;
    const content = 'A'.repeat(420);
    writeBlock(dir, 'scratchpad', content, limit);

    // Model returns same size content
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: content }],
    });

    const result = await runSleepTimeConsolidation(dir);
    expect(result.blocksConsolidated).toBe(0);
    expect(result.details[0].skipped).toBe(true);
    expect(result.details[0].reason).toContain('no improvement');
  });

  it('skips consolidation when compressed result exceeds block limit', async () => {
    const limit = 300;
    const content = 'A'.repeat(260); // 87%
    writeBlock(dir, 'overflow', content, limit);

    // Model returns content that is still over the limit
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'X'.repeat(400) }],
    });

    const result = await runSleepTimeConsolidation(dir);
    expect(result.blocksConsolidated).toBe(0);
    expect(result.details[0].skipped).toBe(true);
    expect(result.details[0].reason).toContain('exceeds block limit');
  });

  it('collects errors per block and continues processing', async () => {
    const limit = 500;
    writeBlock(dir, 'block-a', 'A'.repeat(420), limit);
    writeBlock(dir, 'block-b', 'B'.repeat(420), limit);

    // First call throws, second succeeds
    mockCreate.mockRejectedValueOnce(new Error('API timeout'));
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'C'.repeat(200) }],
    });

    const result = await runSleepTimeConsolidation(dir);
    expect(result.blocksChecked).toBe(2);
    expect(result.blocksConsolidated).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('API timeout');
  });

  it('returns error and zero counts when anthropicApiKey is missing', async () => {
    const { getConfig } = await import('../config');
    vi.mocked(getConfig).mockReturnValueOnce({ anthropicApiKey: '' } as any);
    writeBlock(dir, 'persona', 'A'.repeat(420), 500);

    const result = await runSleepTimeConsolidation(dir);
    expect(result.blocksConsolidated).toBe(0);
    expect(result.errors[0]).toContain('anthropicApiKey not configured');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('handles missing blocks dir gracefully', async () => {
    const result = await runSleepTimeConsolidation('/nonexistent/path/blocks');
    expect(result.blocksConsolidated).toBe(0);
    expect(result.errors[0]).toContain('not found');
  });
});
