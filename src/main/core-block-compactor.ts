/**
 * Core Block Compactor (run 105)
 *
 * `core-memory-blocks.ts:writeBlock` HARD-THROWS when content exceeds a block's
 * character limit, and `appendBlock` calls straight into it, so appending one
 * line too many aborts the whole agent run and loses the new fact just because
 * a 2000-char block filled up. Letta/MemGPT treats a full block as memory
 * pressure to be relieved (consolidate, evict to archival), not a crash.
 *
 * This module is the graceful-degradation path. Given a block's current value,
 * the incoming text, and the limit, it returns a compacted value that ALWAYS
 * fits and ALWAYS preserves the newest text, plus the lines it had to evict so
 * the caller can route them to archival memory. Compaction order:
 *
 *   1. Dedup: drop earlier duplicate lines (keep the most recent occurrence).
 *   2. Evict oldest: remove lines from the top (FIFO) until it fits.
 *   3. Last resort: if the incoming text alone exceeds the limit, keep its tail.
 *
 * Pure, dependency-free, deterministic. Complements `appendBlock` rather than
 * replacing it: callers try the strict append, and on overflow fall back here.
 */

export interface CompactionResult {
  /** The new block value, guaranteed to be <= limit characters. */
  value: string;
  /** Lines removed during compaction, oldest first, candidates for archival. */
  evicted: string[];
  /** Number of duplicate lines collapsed. */
  dedupedCount: number;
  /** True if the incoming text itself had to be truncated to fit. */
  truncatedIncoming: boolean;
}

/** Join lines back into a block value. */
function join(lines: string[]): string {
  return lines.join("\n");
}

/**
 * Collapse duplicate lines, keeping the LAST occurrence of each so the most
 * recent context wins. Order of the surviving lines is preserved.
 */
function dedupeKeepLast(lines: string[]): { kept: string[]; removed: string[] } {
  const lastIndex = new Map<string, number>();
  lines.forEach((line, i) => {
    const k = line.trim();
    if (k) lastIndex.set(k, i);
  });
  const kept: string[] = [];
  const removed: string[] = [];
  lines.forEach((line, i) => {
    const k = line.trim();
    // Blank lines and lines that are the last occurrence are kept.
    if (!k || lastIndex.get(k) === i) {
      kept.push(line);
    } else {
      removed.push(line);
    }
  });
  return { kept, removed };
}

/**
 * Compact `currentValue` + `incomingText` so the result fits within `limit`.
 * The incoming text is always appended last and never dropped (only truncated
 * as an absolute last resort when it alone exceeds the limit).
 */
export function compactBlockToFit(
  currentValue: string,
  incomingText: string,
  limit: number,
): CompactionResult {
  const incoming = incomingText.trim();

  // Degenerate: the new text alone does not fit. Keep its tail, the most
  // recent characters are the ones the agent just decided mattered.
  if (incoming.length >= limit) {
    return {
      value: incoming.slice(incoming.length - limit),
      evicted: currentValue.trim() ? currentValue.split("\n") : [],
      dedupedCount: 0,
      truncatedIncoming: true,
    };
  }

  const existingLines = currentValue ? currentValue.split("\n") : [];

  // Step 1: dedup the existing lines (the incoming line may already be present).
  const allLines = incoming ? [...existingLines, incoming] : existingLines;
  const { kept, removed } = dedupeKeepLast(allLines);
  const evicted = [...removed];
  let working = kept;

  // Step 2: evict oldest until it fits, but never evict the final (incoming) line.
  const protectedCount = incoming ? 1 : 0;
  while (join(working).length > limit && working.length > protectedCount) {
    evicted.push(working.shift() as string);
  }

  return {
    value: join(working),
    evicted,
    dedupedCount: removed.length,
    truncatedIncoming: false,
  };
}

/**
 * Convenience wrapper mirroring `appendBlock`'s intent but never throwing.
 * Returns the compacted value plus whatever was evicted for archival.
 */
export function safeAppendToBlock(
  currentValue: string,
  text: string,
  limit: number,
): CompactionResult {
  const next = currentValue ? `${currentValue}\n${text.trim()}` : text.trim();
  if (next.length <= limit) {
    return { value: next, evicted: [], dedupedCount: 0, truncatedIncoming: false };
  }
  return compactBlockToFit(currentValue, text, limit);
}
