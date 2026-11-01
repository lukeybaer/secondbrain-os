// memory-index-budget-audit.ts
//
// Audit the Tier-1 memory index (MEMORY.md) against its load-time byte
// budget and per-line length convention, and point at the specific lines
// that need trimming or splitting.
//
// Why this matters for Amy: MEMORY.md is the always-loaded Tier-1 pointer
// file. The session loader enforces a hard byte budget (~24.4 KB) and, when
// the file exceeds it, only PART of the file is injected - the warning Amy
// sees every session reads: "MEMORY.md is 25.3KB (limit 24.4KB), only part
// of it was loaded. Keep index entries to one line under ~200 chars; move
// detail into topic files." That is not cosmetic: it means Amy silently
// boots with a truncated index, losing pointers to her own memory every
// session. memory-archival-recommender.ts recommends archiving cold Tier-2
// KEYS, but nothing audits the Tier-1 INDEX file's own size and the
// over-length lines that bloat it.
//
// This module is the missing auditor. Given the file content, it reports:
// total bytes vs budget, how many bytes over, and the exact index lines
// that exceed the per-line character limit (the ones the warning says to
// shorten), worst offenders first. It writes nothing - the caller (briefing
// system-health card, nightly cleanup, or a consolidate-memory pass) decides
// whether to trim, split, or move detail into topic files.
//
// Pattern source: the same load-time budget the global memory loader already
// enforces (the 24.4 KB ceiling and ~200-char line guidance in the warning),
// surfaced proactively instead of only at the moment of truncation.
//
// Distinct from:
//   - memory-archival-recommender.ts: Tier-2 key staleness over 60 days.
//   - memory-eviction-planner.ts: byte eviction inside a core block.
//   This audits the Tier-1 index FILE's size + line-length hygiene.
//
// Pure module: no fs, no electron, no network. Caller passes content in.

// Types

export interface IndexLineViolation {
  // 1-based line number in the file.
  lineNumber: number;
  // Character length of the line (not bytes; the convention is char-based).
  length: number;
  // Byte length, for budget accounting.
  bytes: number;
  // A short prefix so the offending line is identifiable in a report.
  excerpt: string;
}

export interface IndexBudgetAudit {
  totalBytes: number;
  budgetBytes: number;
  overBudget: boolean;
  // Bytes over the budget (0 if within budget).
  bytesOver: number;
  totalLines: number;
  maxLineLength: number;
  // Every line exceeding maxLineLength, in file order.
  longLines: IndexLineViolation[];
  // The N longest lines (worst offenders), longest first - the highest-
  // leverage trims to get back under budget.
  worstOffenders: IndexLineViolation[];
  // Sum of bytes that would be reclaimed if every long line were trimmed to
  // exactly maxLineLength. A rough "is line-trimming alone enough?" signal.
  reclaimableByTrimming: number;
  // True when trimming all long lines to the limit would get under budget.
  trimmingWouldSuffice: boolean;
}

export interface IndexAuditOptions {
  // Byte ceiling the loader enforces. Default 24.4 KB = 24985 bytes
  // (24.4 * 1024), matching the load-time warning.
  budgetBytes?: number;
  // Per-line character convention. Default 200 (the warning's "~200 chars").
  maxLineLength?: number;
  // How many worst offenders to surface. Default 8.
  worstCount?: number;
}

const DEFAULT_BUDGET_BYTES = Math.round(24.4 * 1024); // 24986
const DEFAULT_MAX_LINE_LENGTH = 200;
const DEFAULT_WORST_COUNT = 8;

function excerptOf(line: string, max = 80): string {
  const trimmed = line.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1) + '…';
}

export function auditIndexBudget(
  content: string,
  opts: IndexAuditOptions = {},
): IndexBudgetAudit {
  const budgetBytes = opts.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  const maxLineLength = opts.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  const worstCount = opts.worstCount ?? DEFAULT_WORST_COUNT;

  const totalBytes = Buffer.byteLength(content, 'utf8');
  const lines = content.split('\n');

  const longLines: IndexLineViolation[] = [];
  let reclaimableByTrimming = 0;

  lines.forEach((line, i) => {
    if (line.length > maxLineLength) {
      const bytes = Buffer.byteLength(line, 'utf8');
      // Bytes saved if trimmed to exactly maxLineLength chars. Approximate the
      // trimmed byte size by the excess char count scaled by this line's
      // bytes-per-char, so multibyte lines are estimated, not assumed ascii.
      const bytesPerChar = line.length > 0 ? bytes / line.length : 1;
      const excessChars = line.length - maxLineLength;
      reclaimableByTrimming += Math.round(excessChars * bytesPerChar);
      longLines.push({
        lineNumber: i + 1,
        length: line.length,
        bytes,
        excerpt: excerptOf(line),
      });
    }
  });

  const worstOffenders = [...longLines]
    .sort((a, b) => b.length - a.length)
    .slice(0, worstCount);

  const bytesOver = Math.max(0, totalBytes - budgetBytes);

  return {
    totalBytes,
    budgetBytes,
    overBudget: totalBytes > budgetBytes,
    bytesOver,
    totalLines: lines.length,
    maxLineLength,
    longLines,
    worstOffenders,
    reclaimableByTrimming,
    trimmingWouldSuffice: bytesOver > 0 && reclaimableByTrimming >= bytesOver,
  };
}

// Render a one-line executive headline for the briefing / nightly log.
export function renderIndexBudgetHeadline(audit: IndexBudgetAudit): string {
  const kb = (n: number) => (n / 1024).toFixed(1);
  if (!audit.overBudget && audit.longLines.length === 0) {
    return `Tier-1 index healthy: ${kb(audit.totalBytes)} KB of ${kb(
      audit.budgetBytes,
    )} KB budget, no over-length lines.`;
  }
  const parts: string[] = [];
  if (audit.overBudget) {
    parts.push(
      `Tier-1 index OVER budget by ${audit.bytesOver} bytes (${kb(
        audit.totalBytes,
      )} KB vs ${kb(audit.budgetBytes)} KB); the loader is truncating it`,
    );
  } else {
    parts.push(
      `Tier-1 index within budget (${kb(audit.totalBytes)} KB of ${kb(
        audit.budgetBytes,
      )} KB)`,
    );
  }
  if (audit.longLines.length > 0) {
    parts.push(
      `${audit.longLines.length} line(s) over ${audit.maxLineLength} chars` +
        (audit.trimmingWouldSuffice
          ? '; trimming them to the limit would get back under budget'
          : audit.overBudget
            ? '; trimming alone is not enough, move detail into topic files'
            : ''),
    );
  }
  return parts.join('. ') + '.';
}
