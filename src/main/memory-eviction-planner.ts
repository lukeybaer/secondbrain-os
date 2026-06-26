// memory-eviction-planner.ts
//
// Decide WHICH lines to evict from a core memory block when it exceeds its
// byte budget, so the block can be brought back under limit without losing
// the most valuable content.
//
// Why this matters for Amy: core-memory-blocks.ts gives each block a hard
// byte `limit` and core-block-health.ts reports occupancy (ok / watch /
// full), but nothing decides what to do when a block is full. Today an
// append that overflows either silently exceeds the limit or is rejected
// wholesale - there is no graceful eviction. Letta's whole premise is that
// core memory is RAM-sized and overflow is normal: the agent (or a sleep-
// time job) evicts the coldest content to archival and keeps the hot,
// pinned, recently-referenced lines in context. This module is the missing
// planner: given a block's lines and a budget, it returns the exact set of
// lines to move to archival and the set to keep, never touching pinned
// lines, oldest/least-referenced first.
//
// It writes nothing. The caller (core-memory-blocks.writeBlock, a sleep-
// time consolidation job, or an approval-inbox entry) takes the plan and
// performs the move - appending evicted lines to recall/archival and
// rewriting the block with the kept lines. Keeping it pure means the
// eviction policy is unit-testable in isolation and the same plan can be
// previewed in the briefing before it is applied.
//
// Pattern source: Letta core-memory eviction + sleep-time consolidation
// (letta-ai/letta v0.7), MemGPT's "main context overflow -> recursive
// summarization to external context" (arXiv:2310.08560). The recency +
// pin policy mirrors a least-recently-used cache with pinned entries.
//
// Distinct from:
//   - memory-archival-recommender.ts: recommends Tier 2 -> Tier 3 moves for
//     whole memory KEYS gone cold over 60 days. This operates at the LINE
//     level inside a single core block under acute byte pressure.
//   - memory-confidence-decay.ts: scores facts; does not enforce a byte
//     budget or pick an eviction set.
//
// Pure module: no fs, no electron, no network.

// Types

export interface EvictionLine {
  // The raw text of one line in the block (without trailing newline).
  text: string;
  // ISO timestamp of when this line was last referenced/read. Omitted or
  // empty means "never referenced", which makes it a prime eviction target.
  lastReferencedAt?: string;
  // Pinned lines are never evicted regardless of byte pressure (e.g. the
  // owner's name, immigration filing facts, an active project invariant).
  pinned?: boolean;
}

export interface EvictionPlanOptions {
  // Leave this fraction of the limit free after eviction so the next append
  // does not immediately overflow again. Default 0.1 (target 90% of limit).
  headroomRatio?: number;
  // Clock injection for deterministic tests. Defaults to now.
  now?: Date;
}

export interface EvictionPlan {
  blockBytes: number;
  limit: number;
  // Bytes over the limit before eviction (0 if already under).
  overBy: number;
  needsEviction: boolean;
  // Lines to move to archival, in their original block order.
  evict: EvictionLine[];
  // Lines to keep, in their original block order.
  keep: EvictionLine[];
  reclaimedBytes: number;
  resultingBytes: number;
  // True when, even after evicting every non-pinned line, the block is still
  // over budget (pinned content alone exceeds the limit). The caller must
  // escalate: the pins themselves need review, eviction cannot fix it.
  blockedByPins: boolean;
}

// One line costs its utf8 byte length plus one newline separator.
function lineBytes(line: EvictionLine): number {
  return Buffer.byteLength(line.text, 'utf8') + 1;
}

function refTime(line: EvictionLine): number {
  if (!line.lastReferencedAt) return 0; // never referenced => oldest possible
  const t = new Date(line.lastReferencedAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// Core planner

export function planEviction(
  lines: EvictionLine[],
  limit: number,
  opts: EvictionPlanOptions = {},
): EvictionPlan {
  const headroomRatio = opts.headroomRatio ?? 0.1;
  const target = Math.floor(limit * (1 - headroomRatio));

  const totalBytes = lines.reduce((s, l) => s + lineBytes(l), 0);
  const overBy = Math.max(0, totalBytes - limit);

  if (totalBytes <= limit) {
    return {
      blockBytes: totalBytes,
      limit,
      overBy: 0,
      needsEviction: false,
      evict: [],
      keep: lines.slice(),
      reclaimedBytes: 0,
      resultingBytes: totalBytes,
      blockedByPins: false,
    };
  }

  // Candidates for eviction: non-pinned lines, ordered coldest-first
  // (oldest reference time first; ties broken by original order so the
  // result is stable). Pinned lines are never candidates.
  const candidates = lines
    .map((line, idx) => ({ line, idx }))
    .filter(({ line }) => !line.pinned)
    .sort((a, b) => {
      const dt = refTime(a.line) - refTime(b.line);
      return dt !== 0 ? dt : a.idx - b.idx;
    });

  const evictIdx = new Set<number>();
  let remaining = totalBytes;

  // Evict coldest lines until we are at or below the target (limit minus
  // headroom), or until we run out of non-pinned candidates.
  for (const { line, idx } of candidates) {
    if (remaining <= target) break;
    evictIdx.add(idx);
    remaining -= lineBytes(line);
  }

  const evict: EvictionLine[] = [];
  const keep: EvictionLine[] = [];
  lines.forEach((line, idx) => {
    if (evictIdx.has(idx)) evict.push(line);
    else keep.push(line);
  });

  const reclaimedBytes = totalBytes - remaining;
  // After evicting everything non-pinned, are we still over the hard limit?
  const blockedByPins = remaining > limit;

  return {
    blockBytes: totalBytes,
    limit,
    overBy,
    needsEviction: true,
    evict,
    keep,
    reclaimedBytes,
    resultingBytes: remaining,
    blockedByPins,
  };
}

// Convenience: split a block's raw content string into EvictionLine[].
// Lines may carry an inline pin marker; the caller decides reference times.
export function linesFromContent(
  content: string,
  refTimes: Record<number, string> = {},
  pinned: ReadonlySet<number> = new Set(),
): EvictionLine[] {
  return content
    .split('\n')
    .filter((l, i, arr) => !(i === arr.length - 1 && l === '')) // drop trailing empty
    .map((text, i) => ({
      text,
      lastReferencedAt: refTimes[i],
      pinned: pinned.has(i),
    }));
}

// Re-assemble kept lines into a block body.
export function contentFromKept(plan: EvictionPlan): string {
  return plan.keep.map((l) => l.text).join('\n');
}
