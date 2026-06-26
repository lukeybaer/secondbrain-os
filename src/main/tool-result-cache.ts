// tool-result-cache.ts
//
// Run 44 of the nightly enhancement cycle (2026-05-07).
//
// TTL + LRU cache for read-only tool results. The briefing pipeline calls the
// same tools many times in a single run (gmail search by date, otter list,
// contact lookup, video manifest read). When the run retries on a transient
// failure, every tool re-executes. This cache lets a tool short-circuit when
// its inputs match a recent successful result.
//
// Inspired by:
//   - CrewAI Tool.cache_function(args, result) -> bool, an opt-in predicate
//     that decides whether THIS specific result is cacheable. Reference:
//     https://docs.crewai.com/concepts/tools (cache_function section).
//   - tkem/cachetools TTLCache: LRU eviction by access order, time-based
//     expiry on read. Pattern: check expiry first, then LRU bump.
//   - Letta tool_result_caching (letta-ai/letta v0.7+): keyed by
//     (tool_name, kwargs_hash); used to skip identical tool invocations
//     inside one agent step.
//   - Composio "context management" (Composio docs welcome page, 2026-04):
//     read-only tool responses are deduped within a run.
//
// Why SecondBrain needs this:
//   - briefing pipeline calls 11 read-only data sources for each section
//     (gmail-amy-scan, otter-query, contact-event-sourcing, etc.). On retry,
//     all of them re-run. A 30-second cache cuts the second pass to ~0.
//   - Vapi inbound flow asks the same agent the same question multiple times
//     during a call ("what is ExampleCo's wife's name?"). Same tool call, same
//     answer, but each costs an LLM round-trip without a cache.
//   - The auto-regen video pipeline reads the same manifest before every
//     decision. A 60-second cache eliminates redundant FS reads.
//
// Design:
//   - In-memory Map for hot path. Optional JSON file persistence for
//     cross-process use (the briefing spawns child processes for some
//     sections; without persistence each child has a cold cache).
//   - Per-entry TTL (the briefing run is ~10 minutes; gmail data should not
//     stay cached past 5 minutes; otter transcripts can stay 24h since the
//     full transcript is immutable once the recording stops).
//   - Pluggable cacheable predicate, the CrewAI pattern: predicate(args, result)
//     decides whether to store the result. Default: always cache. Use cases:
//     do not cache empty results so a flaky tool gets a real retry; do not
//     cache error sentinels.
//   - LRU eviction: drop the least recently used entry when size exceeds
//     maxEntries. Pure in-process bookkeeping, no LRU on the disk file
//     (the disk file is an optimization, not the source of truth).

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Types

export type CacheableFn = (args: ExampleCo, result: ExampleCo) => boolean;

export interface CacheEntry<T = ExampleCo> {
  result: T;
  cached_at: number;     // ms epoch
  ttl_ms: number;
  hit_count: number;     // for stats / future LRU tuning
  args_hash: string;     // for collision diagnostics
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
}

export interface ToolResultCacheOptions {
  maxEntries?: number;       // default 256
  defaultTtlMs?: number;     // default 60_000
  persistPath?: string;      // optional JSON file for cross-process use
  cacheable?: CacheableFn;   // default: always cache
  now?: () => number;        // injectable clock for tests
}

// Helpers

function hashArgs(toolName: string, args: ExampleCo): string {
  // Stable hash: sort top-level keys so {a,b} and {b,a} collide.
  const normalized =
    args && typeof args === 'object' && !Array.isArray(args)
      ? JSON.stringify(args, Object.keys(args as object).sort())
      : JSON.stringify(args);
  const seed = `${toolName}::${normalized}`;
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 20);
}

// Cache

export class ToolResultCache {
  private store: Map<string, CacheEntry>;
  private maxEntries: number;
  private defaultTtlMs: number;
  private cacheable: CacheableFn;
  private persistPath?: string;
  private now: () => number;
  private stats_: CacheStats = {
    size: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
    expirations: 0,
  };

  constructor(opts: ToolResultCacheOptions = {}) {
    this.store = new Map();
    this.maxEntries = opts.maxEntries ?? 256;
    this.defaultTtlMs = opts.defaultTtlMs ?? 60_000;
    this.cacheable = opts.cacheable ?? (() => true);
    this.persistPath = opts.persistPath;
    this.now = opts.now ?? Date.now;

    if (this.persistPath) {
      this.loadFromDisk();
    }
  }

  /**
   * Look up a cached result. Returns undefined on miss / expiry.
   * Bumps LRU order on hit by re-inserting the entry.
   */
  get<T = ExampleCo>(toolName: string, args: ExampleCo): T | undefined {
    const k = hashArgs(toolName, args);
    const entry = this.store.get(k);
    if (!entry) {
      this.stats_.misses += 1;
      return undefined;
    }
    if (this.now() - entry.cached_at >= entry.ttl_ms) {
      this.store.delete(k);
      this.stats_.expirations += 1;
      this.stats_.misses += 1;
      this.stats_.size = this.store.size;
      return undefined;
    }
    // LRU bump: re-insert moves the key to the end of the Map iteration order.
    this.store.delete(k);
    entry.hit_count += 1;
    this.store.set(k, entry);
    this.stats_.hits += 1;
    return entry.result as T;
  }

  /**
   * Store a result. Honors the cacheable predicate. Caller-supplied ttlMs
   * overrides the default. Triggers LRU eviction when over maxEntries.
   */
  set<T>(toolName: string, args: ExampleCo, result: T, ttlMs?: number): boolean {
    if (!this.cacheable(args, result)) {
      return false;
    }
    const k = hashArgs(toolName, args);
    const entry: CacheEntry<T> = {
      result,
      cached_at: this.now(),
      ttl_ms: ttlMs ?? this.defaultTtlMs,
      hit_count: 0,
      args_hash: k,
    };
    this.store.delete(k); // ensure LRU order: newest at end
    this.store.set(k, entry);

    while (this.store.size > this.maxEntries) {
      // First key in Map iteration order is the least recently used.
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
      this.stats_.evictions += 1;
    }

    this.stats_.size = this.store.size;
    if (this.persistPath) this.saveToDisk();
    return true;
  }

  /**
   * Run an action under cache protection. Hit returns cached result without
   * invoking the action; miss invokes the action and stores the result.
   * The CrewAI pattern: caching is applied at the call site, not inside the
   * tool, so the cache is reusable across tools.
   */
  async wrap<T>(
    toolName: string,
    args: ExampleCo,
    action: () => Promise<T>,
    ttlMs?: number,
  ): Promise<{ cached: boolean; result: T }> {
    const hit = this.get<T>(toolName, args);
    if (hit !== undefined) {
      return { cached: true, result: hit };
    }
    const result = await action();
    this.set(toolName, args, result, ttlMs);
    return { cached: false, result };
  }

  /**
   * Drop all entries (e.g. between briefing runs).
   */
  clear(): void {
    this.store.clear();
    this.stats_.size = 0;
    if (this.persistPath) this.saveToDisk();
  }

  /**
   * Drop entries whose TTL has expired. Useful as a periodic sweep when the
   * cache is long-lived; on-read expiry already handles hot keys.
   */
  sweep(): number {
    const before = this.store.size;
    const cutoff = this.now();
    for (const [k, entry] of this.store) {
      if (cutoff - entry.cached_at >= entry.ttl_ms) {
        this.store.delete(k);
      }
    }
    const dropped = before - this.store.size;
    this.stats_.expirations += dropped;
    this.stats_.size = this.store.size;
    if (dropped > 0 && this.persistPath) this.saveToDisk();
    return dropped;
  }

  stats(): CacheStats {
    return { ...this.stats_, size: this.store.size };
  }

  /**
   * Hit rate as a fraction in [0, 1]. NaN when no lookups yet.
   */
  hitRate(): number {
    const total = this.stats_.hits + this.stats_.misses;
    if (total === 0) return NaN;
    return this.stats_.hits / total;
  }

  // Persistence (optional)

  private loadFromDisk(): void {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      const raw = fs.readFileSync(this.persistPath, 'utf8');
      const parsed = JSON.parse(raw) as Array<[string, CacheEntry]>;
      for (const [k, entry] of parsed) {
        // Drop expired entries on load.
        if (this.now() - entry.cached_at < entry.ttl_ms) {
          this.store.set(k, entry);
        }
      }
      this.stats_.size = this.store.size;
    } catch {
      // Corrupt cache file is non-fatal. Start cold.
    }
  }

  private saveToDisk(): void {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const data = Array.from(this.store.entries());
      fs.writeFileSync(this.persistPath, JSON.stringify(data));
    } catch {
      // Persist failure should not break the program. Cache stays in-memory.
    }
  }
}

// Convenience factories

/**
 * The default predicate suitable for most read-only tools: cache anything
 * truthy except empty arrays / empty strings / null. Avoids caching a flaky
 * "empty response" so the next call gets a real attempt.
 */
export const cacheNonEmpty: CacheableFn = (_args, result) => {
  if (result == null) return false;
  if (Array.isArray(result) && result.length === 0) return false;
  if (typeof result === 'string' && result.length === 0) return false;
  if (
    typeof result === 'object' &&
    !Array.isArray(result) &&
    Object.keys(result as object).length === 0
  )
    return false;
  return true;
};

/**
 * Module-level singleton for the briefing pipeline. Lazily initialized on
 * first access. Keep persistPath out of tests by passing options explicitly.
 */
let _shared: ToolResultCache | null = null;
export function getSharedToolResultCache(opts?: ToolResultCacheOptions): ToolResultCache {
  if (!_shared) {
    _shared = new ToolResultCache(opts);
  }
  return _shared;
}

export function resetSharedToolResultCache(): void {
  _shared = null;
}
