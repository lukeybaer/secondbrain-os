// memory-archival-recommender.ts
//
// Recommend Tier 2 to Tier 3 archive moves for memory keys that have gone cold
// and stayed cold. Extends memory-temperature.ts (which classifies hot/warm/cold
// per access frequency) with a *persistence* dimension: a key briefly cold is
// noise, a key cold for 60+ days with under N total accesses is dead weight.
//
// Why this matters for Amy: MEMORY.md is already over its 24.4 KB budget. The
// rate-of-growth is faster than the rate-of-prune. Hot/cold tiering tells you
// which memories matter right now; this module tells you which ones to actually
// move off-tier so the index stays scannable.
//
// Pattern source: Ebbinghaus forgetting curve as applied in mem0 / Letta core
// memory cleanup, plus the cadence-aware staleness pattern shipped in run 72's
// skill-registry.overdueCapabilities (a "cold for too long" threshold rather
// than a single read of state).
//
// This module is pure: it takes a MemoryTemperature[] (the output of
// computeTemperatures from memory-temperature.ts) and a clock, and returns
// recommendations. It does NOT touch the filesystem on its own. The caller
// decides what to do with the recommendations (briefing card, Telegram, an
// approval-inbox entry, an actual mv into memory/archive/).

import type { MemoryTemperature } from './memory-temperature';

// Types

export type ArchivalReason =
  | 'never-accessed-and-old'
  | 'cold-tier-persistent'
  | 'single-access-stale';

export interface ArchivalRecommendation {
  memoryKey: string;
  reason: ArchivalReason;
  temperature: number;
  accessCount: number;
  lastAccessedAt: string;
  daysSinceLastAccess: number;
  confidence: number; // 0..1, higher means safer to archive
  rationale: string;
}

export interface RecommendOptions {
  // A key must have been cold AND untouched for this many days to be flagged.
  // Default 60 days mirrors the mem0 / Letta forget-after-2-months convention.
  coldDaysThreshold?: number;

  // Single-access keys can be archived sooner, they were probably one-off
  // lookups that never became part of working memory.
  singleAccessDaysThreshold?: number;

  // Skip keys that have been accessed at least this many times in their life,
  // even if currently cold, they are recurring memories on a slow cadence.
  minAccessCountToProtect?: number;

  // Optional whitelist of keys that should never be recommended for archive
  // (e.g. user_profile, AMY_REQUIREMENTS, MEMORY.md). Compared case-sensitively.
  protectedKeys?: string[];

  // Clock injection for tests.
  now?: Date;
}

// Defaults

const DEFAULT_COLD_DAYS = 60;
const DEFAULT_SINGLE_ACCESS_DAYS = 30;
const DEFAULT_MIN_ACCESS_PROTECT = 8;
const MS_PER_DAY = 86_400_000;

// Core: classify one MemoryTemperature row

function classify(
  row: MemoryTemperature,
  now: Date,
  opts: Required<Pick<RecommendOptions, 'coldDaysThreshold' | 'singleAccessDaysThreshold' | 'minAccessCountToProtect'>>,
): ArchivalRecommendation | null {
  if (row.accessCount >= opts.minAccessCountToProtect) return null;

  const lastMs = new Date(row.lastAccessedAt).getTime();
  if (Number.isNaN(lastMs)) return null;

  const daysSinceLastAccess = (now.getTime() - lastMs) / MS_PER_DAY;
  if (daysSinceLastAccess < 0) return null;

  // Never-accessed-but-registered edge case: if a key shows up with accessCount 0
  // (caller seeded it without ever hitting it), recommend immediately when older
  // than singleAccessDaysThreshold.
  if (row.accessCount === 0 && daysSinceLastAccess >= opts.singleAccessDaysThreshold) {
    return {
      memoryKey: row.memoryKey,
      reason: 'never-accessed-and-old',
      temperature: row.temperature,
      accessCount: row.accessCount,
      lastAccessedAt: row.lastAccessedAt,
      daysSinceLastAccess: Math.round(daysSinceLastAccess * 10) / 10,
      confidence: Math.min(
        1,
        0.7 + (daysSinceLastAccess - opts.singleAccessDaysThreshold) / 120,
      ),
      rationale: `seeded but never accessed; idle ${Math.round(daysSinceLastAccess)} days`,
    };
  }

  if (
    row.accessCount === 1 &&
    daysSinceLastAccess >= opts.singleAccessDaysThreshold
  ) {
    return {
      memoryKey: row.memoryKey,
      reason: 'single-access-stale',
      temperature: row.temperature,
      accessCount: row.accessCount,
      lastAccessedAt: row.lastAccessedAt,
      daysSinceLastAccess: Math.round(daysSinceLastAccess * 10) / 10,
      confidence: Math.min(
        1,
        0.5 + (daysSinceLastAccess - opts.singleAccessDaysThreshold) / 90,
      ),
      rationale: `accessed once ${Math.round(daysSinceLastAccess)} days ago; never revisited`,
    };
  }

  if (row.tier === 'cold' && daysSinceLastAccess >= opts.coldDaysThreshold) {
    // Confidence scales with how far past the threshold we are AND how few
    // total accesses there were. A key with 5 accesses but cold for 90 days
    // is still a candidate, just lower confidence than a 2-access one.
    const overshoot = daysSinceLastAccess - opts.coldDaysThreshold;
    const accessPenalty = Math.min(0.3, (row.accessCount - 2) * 0.05);
    return {
      memoryKey: row.memoryKey,
      reason: 'cold-tier-persistent',
      temperature: row.temperature,
      accessCount: row.accessCount,
      lastAccessedAt: row.lastAccessedAt,
      daysSinceLastAccess: Math.round(daysSinceLastAccess * 10) / 10,
      confidence: Math.max(0.3, Math.min(1, 0.6 + overshoot / 180 - accessPenalty)),
      rationale: `cold tier (temp=${row.temperature}); last touched ${Math.round(daysSinceLastAccess)} days ago across ${row.accessCount} accesses`,
    };
  }

  return null;
}

// Public API

export function recommendArchives(
  temps: MemoryTemperature[],
  opts: RecommendOptions = {},
): ArchivalRecommendation[] {
  const filled = {
    coldDaysThreshold: opts.coldDaysThreshold ?? DEFAULT_COLD_DAYS,
    singleAccessDaysThreshold:
      opts.singleAccessDaysThreshold ?? DEFAULT_SINGLE_ACCESS_DAYS,
    minAccessCountToProtect:
      opts.minAccessCountToProtect ?? DEFAULT_MIN_ACCESS_PROTECT,
  };
  const protectedSet = new Set(opts.protectedKeys ?? []);
  const now = opts.now ?? new Date();

  const out: ArchivalRecommendation[] = [];
  for (const row of temps) {
    if (protectedSet.has(row.memoryKey)) continue;
    const rec = classify(row, now, filled);
    if (rec) out.push(rec);
  }

  // Highest confidence first; ties broken by oldest-touched.
  out.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.daysSinceLastAccess - a.daysSinceLastAccess;
  });

  return out;
}

// Briefing line. Same tier-1 shape as approval-inbox / overdueCapabilities.

export function formatArchivalForBriefing(
  recs: ArchivalRecommendation[],
  opts: { topN?: number } = {},
): string {
  if (recs.length === 0) return 'Memory archive: 0 recommendations.';

  const top = recs.slice(0, opts.topN ?? 3).map((r) => r.memoryKey);
  const more = recs.length > (opts.topN ?? 3) ? ` +${recs.length - (opts.topN ?? 3)} more` : '';
  return `Memory archive: ${recs.length} candidates (${top.join(', ')}${more}).`;
}

// Stats for briefing card expansion.

export interface ArchivalStats {
  total: number;
  byReason: Record<ArchivalReason, number>;
  meanConfidence: number;
  oldestDays: number;
}

export function getArchivalStats(recs: ArchivalRecommendation[]): ArchivalStats {
  const stats: ArchivalStats = {
    total: recs.length,
    byReason: {
      'never-accessed-and-old': 0,
      'cold-tier-persistent': 0,
      'single-access-stale': 0,
    },
    meanConfidence: 0,
    oldestDays: 0,
  };

  if (recs.length === 0) return stats;

  let confSum = 0;
  for (const r of recs) {
    stats.byReason[r.reason]++;
    confSum += r.confidence;
    if (r.daysSinceLastAccess > stats.oldestDays) {
      stats.oldestDays = r.daysSinceLastAccess;
    }
  }
  stats.meanConfidence = Math.round((confSum / recs.length) * 100) / 100;
  stats.oldestDays = Math.round(stats.oldestDays * 10) / 10;
  return stats;
}
