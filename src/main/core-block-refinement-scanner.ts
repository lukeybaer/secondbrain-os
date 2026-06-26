// core-block-refinement-scanner.ts
//
// Letta "sleep-time agent" proactive memory refinement, the trigger half.
//
// Letta's 2026 sleep-time agents reorganize memory blocks during idle periods
// *before* they overflow, rather than doing lazy in-conversation edits
// (letta.com/blog/agent-memory, 2026). SecondBrain already has both halves of
// the machinery:
//   - core-memory-blocks.ts now reports per-block occupancy (blockOccupancy)
//   - sleep-time-trigger-queue.ts accepts 'memory-block-recompress' triggers
//     that sleep-time-consolidation.ts drains on the nightly pass
// but nothing connected them: no code watched the fill ratio and *requested*
// recompression. A block could silently sit at 99% until the next write threw.
//
// This scanner is that connection. Run it on the nightly pass (or after a heavy
// foreground write burst): it reads occupancy for every core block and enqueues
// a recompression trigger for each writable block over the threshold. Read-only
// blocks (persona-class) are skipped because the consolidation path cannot
// mutate them, so enqueuing would only produce repeated failed drains.
//
// Pure, dependency-free, regression-tested. Caller wires the two dirs in.

import { allBlockOccupancy, BlockOccupancy } from './core-memory-blocks';
import { enqueueSleepTrigger } from './sleep-time-trigger-queue';

export interface RefinementScanOptions {
  // Occupancy ratio at/above which a block is enqueued for refinement.
  threshold?: number;
  // Dedupe window passed to the trigger queue so repeated scans within the
  // window collapse to one pending trigger per block.
  dedupeWindowMinutes?: number;
  now?: Date;
}

export interface RefinementScanResult {
  scanned: number;
  enqueued: { name: string; ratio: number }[];
  skippedReadOnly: string[];
  belowThreshold: string[];
}

export const DEFAULT_REFINEMENT_THRESHOLD = 0.8;
const DEFAULT_DEDUPE_WINDOW_MINUTES = 720; // 12h: at most one refine request per block per half-day

export function scanAndEnqueueBlockRefinement(
  blocksDir: string,
  queueDir: string,
  options: RefinementScanOptions = {},
): RefinementScanResult {
  const threshold = options.threshold ?? DEFAULT_REFINEMENT_THRESHOLD;
  const dedupeWindowMinutes = options.dedupeWindowMinutes ?? DEFAULT_DEDUPE_WINDOW_MINUTES;

  const occupancies: BlockOccupancy[] = allBlockOccupancy(blocksDir);
  const enqueued: { name: string; ratio: number }[] = [];
  const skippedReadOnly: string[] = [];
  const belowThreshold: string[] = [];

  for (const occ of occupancies) {
    if (occ.ratio < threshold) {
      belowThreshold.push(occ.name);
      continue;
    }
    if (occ.read_only) {
      // Refinement would mutate content, which the read-only guard forbids on
      // the agent path. Recording it as skipped keeps the signal visible
      // without spawning doomed drain attempts.
      skippedReadOnly.push(occ.name);
      continue;
    }
    enqueueSleepTrigger(queueDir, {
      type: 'memory-block-recompress',
      key: `block:${occ.name}`,
      source: 'core-block-refinement-scanner',
      payload: { ratio: occ.ratio, used: occ.used, limit: occ.limit },
      dedupeWindowMinutes,
      now: options.now,
    });
    enqueued.push({ name: occ.name, ratio: occ.ratio });
  }

  return {
    scanned: occupancies.length,
    enqueued,
    skippedReadOnly,
    belowThreshold,
  };
}
