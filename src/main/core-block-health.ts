// core-block-health.ts
//
// Observability for Amy's core memory. The briefing system-health section
// reports on EC2, Otter, Gmail, dispatch, etc., but the core memory blocks
// (persona, human, scratchpad) were a blind spot: nothing surfaced how full
// they were, which were locked, or which were already queued for refinement.
//
// This module is the render half of the Letta core-memory subsystem. It reads
// two existing state sources, occupancy (core-memory-blocks) and pending
// refinement triggers (sleep-time-trigger-queue), and folds them into one
// executive-readable digest. It writes nothing, so it is safe to call from any
// surface (briefing, health self-heal, chat) without side effects.
//
// Pure, dependency-free, regression-tested.

import { allBlockOccupancy } from './core-memory-blocks';
import { listPendingTriggers } from './sleep-time-trigger-queue';

export type CoreBlockStatus = 'ok' | 'watch' | 'full' | 'locked';

export interface CoreBlockHealthRow {
  name: string;
  used: number;
  limit: number;
  ratio: number;
  read_only: boolean;
  refinementPending: boolean;
  status: CoreBlockStatus;
}

const WATCH_RATIO = 0.8;
const FULL_RATIO = 0.9;

function statusFor(ratio: number, readOnly: boolean): CoreBlockStatus {
  if (readOnly) return 'locked';
  if (ratio >= FULL_RATIO) return 'full';
  if (ratio >= WATCH_RATIO) return 'watch';
  return 'ok';
}

export function getCoreBlockHealth(blocksDir: string, queueDir: string): CoreBlockHealthRow[] {
  const pendingKeys = new Set(
    listPendingTriggers(queueDir)
      .filter((t) => t.type === 'memory-block-recompress')
      .map((t) => t.key),
  );

  return allBlockOccupancy(blocksDir).map((occ) => ({
    name: occ.name,
    used: occ.used,
    limit: occ.limit,
    ratio: occ.ratio,
    read_only: occ.read_only,
    refinementPending: pendingKeys.has(`block:${occ.name}`),
    status: statusFor(occ.ratio, occ.read_only),
  }));
}

// One-line-per-block digest for the briefing system-health section. Aggregates
// to a single clean line when every block is healthy, per the briefing
// "clean or blocked" contract.
export function formatCoreBlockHealthForBriefing(blocksDir: string, queueDir: string): string {
  const rows = getCoreBlockHealth(blocksDir, queueDir);
  if (rows.length === 0) return 'Core memory: no blocks';

  const needsAttention = rows.filter((r) => r.status === 'full' || r.status === 'watch');
  if (needsAttention.length === 0) {
    return `Core memory: ${rows.length} block${rows.length === 1 ? '' : 's'} healthy (all under ${Math.round(WATCH_RATIO * 100)}%)`;
  }

  const lines = needsAttention.map((r) => {
    const pct = Math.round(r.ratio * 100);
    const flag = r.status === 'full' ? 'FULL' : 'watch';
    const refine = r.refinementPending ? ', refinement queued' : '';
    return `  - ${r.name}: ${pct}% (${flag}${refine})`;
  });
  return `Core memory: ${needsAttention.length} block(s) need attention\n${lines.join('\n')}`;
}
