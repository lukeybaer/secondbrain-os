// error-cluster.ts
//
// Issue clustering for tool failures. Inspired by the 2026 agent-observability
// shift (Latitude's survey of 15 platforms named "issue clustering" the one
// capability most platforms still lack): when an agent fails N times for the
// same underlying reason, surfacing N separate failure lines buries the signal.
//
// This module groups failed ToolTraceRecord entries by a *normalized* error
// signature so the briefing can say "connection refused x14" once instead of
// fourteen times. It directly serves ExampleCo's CEO tier-1 brevity rule
// (feedback_ceo_tier_one_brevity.md: "aggregate when N items share a cause").
//
// Design goals mirror tool-trace.ts:
//   - Zero electron coupling (pure data transforms + fs read). Testable raw.
//   - Never throws on malformed input; clustering is best-effort telemetry.
//   - Append-only JSONL input is read, never written.

import { ToolTraceRecord, readRecentFailures } from './tool-trace';

export interface ErrorCluster {
  /** Normalized, deterministic signature shared by every member of the cluster. */
  signature: string;
  /** Number of failures that collapsed into this signature. */
  count: number;
  /** Distinct tool names that produced this error, sorted. */
  tools: string[];
  /** ISO timestamp of the earliest failure in the cluster. */
  first_seen: string;
  /** ISO timestamp of the most recent failure in the cluster. */
  last_seen: string;
  /** One real (un-normalized) error string, kept for tier-3 drilldown. */
  sample_error: string;
}

/**
 * Collapse a raw error message into a stable signature by stripping the
 * volatile parts that would otherwise scatter one root cause across many
 * clusters: digits, UUIDs, hex blobs, file paths, URLs, quoted literals,
 * and hex memory addresses. The result is lowercased and whitespace-collapsed.
 */
export function normalizeErrorSignature(message: string): string {
  if (!message) return '(empty)';
  let s = String(message);
  // URLs first (before path/digit stripping mangles them).
  s = s.replace(/https?:\/\/[^\s'"]+/gi, '<url>');
  // UUIDs.
  s = s.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    '<uuid>',
  );
  // Windows + POSIX absolute paths.
  s = s.replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>');
  s = s.replace(/(?:\/[\w.\-]+){2,}/g, '<path>');
  // Hex addresses / long hex blobs.
  s = s.replace(/0x[0-9a-f]+/gi, '<hex>');
  s = s.replace(/\b[0-9a-f]{12,}\b/gi, '<hex>');
  // Quoted literals (single + double).
  s = s.replace(/"[^"]*"/g, '<str>').replace(/'[^']*'/g, '<str>');
  // Any remaining run of digits.
  s = s.replace(/\d+/g, 'N');
  // Collapse whitespace, lowercase, trim.
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return s || '(empty)';
}

/**
 * Group failed trace records into clusters, sorted by count descending
 * (largest blast radius first), then by most-recent last_seen.
 * Successful records and records without an error are ignored.
 */
export function clusterFailures(records: ToolTraceRecord[]): ErrorCluster[] {
  const bySig = new Map<
    string,
    { count: number; tools: Set<string>; first: string; last: string; sample: string }
  >();

  for (const r of records) {
    if (!r || r.success) continue;
    const raw = r.error ?? '';
    const sig = normalizeErrorSignature(raw);
    const ts = typeof r.timestamp === 'string' ? r.timestamp : '';
    const existing = bySig.get(sig);
    if (existing) {
      existing.count += 1;
      if (r.tool) existing.tools.add(r.tool);
      if (ts && ts < existing.first) existing.first = ts;
      if (ts && ts > existing.last) existing.last = ts;
    } else {
      bySig.set(sig, {
        count: 1,
        tools: new Set(r.tool ? [r.tool] : []),
        first: ts,
        last: ts,
        sample: raw || '(no error message)',
      });
    }
  }

  return [...bySig.entries()]
    .map(([signature, v]) => ({
      signature,
      count: v.count,
      tools: [...v.tools].sort(),
      first_seen: v.first,
      last_seen: v.last,
      sample_error: v.sample,
    }))
    .sort((a, b) => b.count - a.count || b.last_seen.localeCompare(a.last_seen));
}

/**
 * Read recent failures straight from a tool-trace JSONL file and cluster them.
 * `windowHours` bounds how far back to look; `limit` caps raw failures pulled.
 */
export function clusterRecentFailures(
  tracePath: string,
  windowHours = 24,
  limit = 500,
): ErrorCluster[] {
  const failures = readRecentFailures(tracePath, windowHours, limit);
  return clusterFailures(failures);
}

/**
 * One-line tier-1 summary of the cluster set for the briefing health card.
 * Returns a clean "no failures" line when the input is empty so callers never
 * need a null branch.
 */
export function summarizeClusters(clusters: ErrorCluster[]): string {
  if (clusters.length === 0) return 'No tool failures in window.';
  const total = clusters.reduce((sum, c) => sum + c.count, 0);
  const top = clusters[0];
  const topLabel =
    top.signature.length > 60 ? top.signature.slice(0, 57) + '...' : top.signature;
  return `${total} tool failure${total === 1 ? '' : 's'} in ${clusters.length} cluster${
    clusters.length === 1 ? '' : 's'
  }; top: "${topLabel}" x${top.count}.`;
}
