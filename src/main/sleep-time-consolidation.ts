// sleep-time-consolidation.ts
//
// Letta-inspired sleep-time compute: a background Claude Haiku pass that runs
// between human interactions to consolidate core memory blocks. When a block
// exceeds 80% of its byte limit, Haiku compresses it to ~60% while preserving
// all unique facts, names, dates, and action items.
//
// Reference: https://www.letta.com/blog/sleep-time-compute
// "The primary agent never slows down for memory management."
//
// Schedule: 2:30 AM CT , after Hebbian decay (2:00 AM) and before the
// Graphiti sync (4:00 AM). The primary agent is never blocked by this.
//
// Run 11 of the nightly enhancement cycle. Previous runs built the
// core-memory-blocks module but left no background consolidation pass.
// This closes the gap.

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import Anthropic from '@anthropic-ai/sdk';
import { readBlock, writeBlock, listBlocks } from './core-memory-blocks';
import { getConfig } from './config';

// ── Path helper ───────────────────────────────────────────────────────────────

export function getCoreBlocksDir(): string {
  return path.join(app.getPath('userData'), 'data', 'agent', 'memory', 'core-blocks');
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BlockConsolidationDetail {
  name: string;
  bytesBefore: number;
  bytesAfter: number;
  usageBefore: number; // fraction 0..1
  usageAfter: number;
  skipped: boolean;
  reason?: string;
}

export interface ConsolidationResult {
  blocksChecked: number;
  blocksConsolidated: number;
  bytesBeforeTotal: number;
  bytesAfterTotal: number;
  bytesSaved: number;
  details: BlockConsolidationDetail[];
  errors: string[];
}

// ── Consolidation threshold ───────────────────────────────────────────────────

const CONSOLIDATE_THRESHOLD = 0.8; // trigger when block is 80%+ full
const TARGET_USAGE = 0.6; // compress to ~60%

// ── Core block consolidation ──────────────────────────────────────────────────

async function consolidateBlock(
  dir: string,
  blockName: string,
  anthropic: Anthropic,
): Promise<BlockConsolidationDetail> {
  const block = readBlock(dir, blockName);
  if (!block) {
    return {
      name: blockName,
      bytesBefore: 0,
      bytesAfter: 0,
      usageBefore: 0,
      usageAfter: 0,
      skipped: true,
      reason: 'block not found',
    };
  }

  const bytesBefore = block.content.length;
  const usageBefore = bytesBefore / block.limit;

  if (usageBefore < CONSOLIDATE_THRESHOLD) {
    return {
      name: blockName,
      bytesBefore,
      bytesAfter: bytesBefore,
      usageBefore,
      usageAfter: usageBefore,
      skipped: true,
      reason: `usage ${(usageBefore * 100).toFixed(0)}% below ${CONSOLIDATE_THRESHOLD * 100}% threshold`,
    };
  }

  const targetLength = Math.floor(block.limit * TARGET_USAGE);

  // Rough token estimate: ~4 chars/token for English prose
  const maxOutputTokens = Math.max(256, Math.ceil(targetLength / 3));

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: maxOutputTokens,
    messages: [
      {
        role: 'user',
        content: `You are a memory compressor for an AI executive assistant. Compress the memory block below by removing redundant facts, merging duplicate entries, and trimming verbose phrasing. Preserve all unique facts, names, dates, phone numbers, and action items. Keep the same section headers and structure. Target: under ${targetLength} characters.

BLOCK NAME: ${blockName}

CONTENT:
${block.content}

Return ONLY the compressed content , no preamble, no explanation, no meta-commentary.`,
      },
    ],
  });

  const compressed = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : null;

  if (!compressed) {
    return {
      name: blockName,
      bytesBefore,
      bytesAfter: bytesBefore,
      usageBefore,
      usageAfter: usageBefore,
      skipped: true,
      reason: 'compression produced no improvement',
    };
  }

  if (compressed.length > block.limit) {
    return {
      name: blockName,
      bytesBefore,
      bytesAfter: bytesBefore,
      usageBefore,
      usageAfter: usageBefore,
      skipped: true,
      reason: `compressed result (${compressed.length}b) still exceeds block limit (${block.limit}b)`,
    };
  }

  if (compressed.length >= bytesBefore) {
    return {
      name: blockName,
      bytesBefore,
      bytesAfter: bytesBefore,
      usageBefore,
      usageAfter: usageBefore,
      skipped: true,
      reason: 'compression produced no improvement',
    };
  }

  writeBlock(dir, blockName, compressed, block.limit);

  const bytesAfter = compressed.length;
  return {
    name: blockName,
    bytesBefore,
    bytesAfter,
    usageBefore,
    usageAfter: bytesAfter / block.limit,
    skipped: false,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the sleep-time consolidation pass over all core memory blocks.
 * Pass `blocksDir` explicitly (or omit to use the Electron userData default).
 * Designed to be called from the nightly scheduler , never blocks the primary agent.
 */
export async function runSleepTimeConsolidation(
  blocksDir?: string,
): Promise<ConsolidationResult> {
  const dir = blocksDir ?? getCoreBlocksDir();
  const result: ConsolidationResult = {
    blocksChecked: 0,
    blocksConsolidated: 0,
    bytesBeforeTotal: 0,
    bytesAfterTotal: 0,
    bytesSaved: 0,
    details: [],
    errors: [],
  };

  if (!fs.existsSync(dir)) {
    // No blocks yet , not an error, just nothing to do
    result.errors.push(`core-blocks dir not found: ${dir} , no blocks to consolidate`);
    return result;
  }

  const apiKey = getConfig().anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    result.errors.push('anthropicApiKey not configured , skipping sleep-time consolidation');
    return result;
  }

  const anthropic = new Anthropic({ apiKey });
  const names = listBlocks(dir);
  result.blocksChecked = names.length;

  for (const name of names) {
    try {
      const detail = await consolidateBlock(dir, name, anthropic);
      result.details.push(detail);
      result.bytesBeforeTotal += detail.bytesBefore;
      result.bytesAfterTotal += detail.bytesAfter;
      if (!detail.skipped) result.blocksConsolidated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${name}: ${msg}`);
      result.details.push({
        name,
        bytesBefore: 0,
        bytesAfter: 0,
        usageBefore: 0,
        usageAfter: 0,
        skipped: true,
        reason: `error: ${msg}`,
      });
    }
  }

  result.bytesSaved = result.bytesBeforeTotal - result.bytesAfterTotal;
  return result;
}
