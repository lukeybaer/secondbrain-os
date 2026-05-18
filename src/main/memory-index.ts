// memory-index.ts
// Three-tier Hebbian memory system for the EA agent.
//
// Architecture (Khoj's TextToEntries base + Hebb 1949 reinforcement):
//
//   Tier 1 — Working Memory (MEMORY.md, always in system prompt, ≤50 lines)
//     Pointers only. Zero loading cost.
//
//   Tier 2 — Indexed Memory (memory/*.md + index.json)
//     One file per topic. Loaded on demand. Scored by weight.
//     weight range: 0.0 – 1.0
//     decay: weight *= (1 - decay_rate) ** days_since_access  (multiplicative)
//     promotion: mentions ≥ 3 → weight = 0.8, decay_rate = 0.02 (defaults only;
//                custom weight ≥ 0.5 and custom decay_rate are preserved)
//
//   Tier 3 — Archive (memory/archive/YYYY-MM-DD.md)
//     Daily append-only. Loaded only on explicit recall.
//     Entries with weight < 0.05 are pruned here weekly.
//
// MD5 dedup (Khoj pattern): skip if content hash already in index.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';
// Graphiti cascade: every Tier 2 write also fires addEpisode() so the
// knowledge graph stays in sync with the filesystem. Imported lazily to
// avoid circular deps and because Graphiti may be unavailable (SSH tunnel
// down) — failures are silent by design.
// Reference: AMY_DEEP_RESEARCH.md section 1.
let _graphitiAddEpisode:
  | ((ep: {
      name: string;
      content: string;
      sourceType: string;
      sourceDescription?: string;
      referenceTime?: string;
    }) => Promise<boolean>)
  | null = null;
try {
  const gc = require('./graphiti-client');
  _graphitiAddEpisode = gc.addEpisode;
} catch {
  /* graphiti-client not available in this runtime (e.g. tests) */
}

// ── Constants ─────────────────────────────────────────────────────────────────

const WORKING_MEMORY_MAX_LINES = 50;
const ARCHIVE_THRESHOLD = 0.05;
const PROMOTION_MENTIONS = 3;
const PROMOTION_WEIGHT = 0.8;
const PROMOTION_WEIGHT_CEILING = 0.5; // promotion only fires if weight is below this
const INITIAL_WEIGHT = 0.2;
const INITIAL_DECAY = 0.1;
const PROMOTED_DECAY = 0.02;
const INDEX_SCHEMA_VERSION = 1;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string; // MD5 hash of normalized content
  topic: string; // short label, e.g. "dentist-project"
  file: string; // relative path under memory/ (e.g. "Employer-metis.md")
  weight: number; // 0.0 – 1.0 Hebbian weight
  mentions: number; // total access count
  last_accessed: string; // ISO date
  decay_rate: number; // how fast it fades (0.02 = slow, 0.10 = fast)
  valid_at: string; // when this fact became true
  invalid_at?: string; // when this fact was superseded (never delete, just mark)
  tier: 1 | 2 | 3;
}

export interface MemoryIndex {
  version: number;
  last_updated: string;
  entries: MemoryEntry[];
  hashes: string[]; // MD5 set for dedup
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function memoryRoot(): string {
  return path.join(app.getPath('userData'), 'data', 'agent', 'memory');
}

function archiveDir(): string {
  return path.join(memoryRoot(), 'archive');
}

function indexPath(): string {
  return path.join(memoryRoot(), 'index.json');
}

function workingMemoryPath(): string {
  return path.join(memoryRoot(), 'MEMORY.md');
}

function tier2FilePath(file: string): string {
  return path.join(memoryRoot(), file);
}

function archiveFilePath(date: string): string {
  return path.join(archiveDir(), `${date}.md`);
}

// ── Storage type safety ───────────────────────────────────────────────────────

// Lib-target-agnostic finite check: `n - n === 0` is true for finite numbers
// and false for NaN, Infinity, -Infinity. Stricter than the global `isNaN`,
// works without `lib: es2015+` exposing `Number.isFinite`.
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && v - v === 0;
}

function isMemoryEntry(raw: unknown): raw is MemoryEntry {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.topic === 'string' &&
    typeof e.file === 'string' &&
    isFiniteNumber(e.weight) &&
    isFiniteNumber(e.mentions) &&
    typeof e.last_accessed === 'string' &&
    isFiniteNumber(e.decay_rate) &&
    typeof e.valid_at === 'string' &&
    (e.tier === 1 || e.tier === 2 || e.tier === 3) &&
    (e.invalid_at === undefined || typeof e.invalid_at === 'string')
  );
}

function validateIndex(raw: unknown): MemoryIndex | null {
  if (!raw || typeof raw !== 'object') return null;
  const i = raw as Record<string, unknown>;
  if (typeof i.version !== 'number') return null;
  if (typeof i.last_updated !== 'string') return null;
  if (!Array.isArray(i.entries) || !i.entries.every(isMemoryEntry)) return null;
  if (!Array.isArray(i.hashes) || !i.hashes.every((h) => typeof h === 'string')) return null;
  return {
    version: i.version,
    last_updated: i.last_updated,
    entries: i.entries as MemoryEntry[],
    hashes: i.hashes as string[],
  };
}

function freshIndex(): MemoryIndex {
  return {
    version: INDEX_SCHEMA_VERSION,
    last_updated: now(),
    entries: [],
    hashes: [],
  };
}

// Renames a corrupt index aside so we never silently overwrite user data.
function backupCorruptIndex(p: string, reason: string): void {
  try {
    const backup = `${p}.corrupt.${Date.now()}`;
    fs.renameSync(p, backup);
    console.warn(
      `[memory-index] index.json invalid (${reason}); backed up to ${path.basename(backup)}`,
    );
  } catch (err) {
    console.warn(`[memory-index] failed to back up corrupt index: ${err}`);
  }
}

// ── Index I/O ─────────────────────────────────────────────────────────────────

// Cache is invalidated by file mtime rather than wall-clock TTL: any external
// write to index.json (other process, manual edit, test setup) will bump mtime
// and force a fresh read. The path is part of the cache key so tests that
// rotate `app.getPath('userData')` between cases get clean state.
interface CacheState {
  path: string;
  mtimeMs: number;
  data: MemoryIndex;
}
let _cache: CacheState | null = null;

/** Clear the in-memory index cache. Tests and external writers can call this
 *  if they need to guarantee a fresh disk read on the next loadIndex. */
export function invalidateIndexCache(): void {
  _cache = null;
}

function readIndexFromDisk(p: string): MemoryIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    backupCorruptIndex(p, `JSON parse failed: ${(err as Error).message}`);
    const fresh = freshIndex();
    writeIndexToDisk(fresh);
    return fresh;
  }
  const validated = validateIndex(raw);
  if (!validated) {
    backupCorruptIndex(p, 'schema validation failed');
    const fresh = freshIndex();
    writeIndexToDisk(fresh);
    return fresh;
  }
  return validated;
}

function writeIndexToDisk(index: MemoryIndex): void {
  const dir = memoryRoot();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(indexPath(), JSON.stringify(index, null, 2), 'utf-8');
}

export function loadIndex(): MemoryIndex {
  const p = indexPath();

  if (!fs.existsSync(p)) {
    const fresh = freshIndex();
    saveIndex(fresh);
    return fresh;
  }

  const stat = fs.statSync(p);
  if (_cache && _cache.path === p && _cache.mtimeMs === stat.mtimeMs) {
    return _cache.data;
  }

  const data = readIndexFromDisk(p);
  // readIndexFromDisk may have rewritten the file (corruption recovery),
  // so re-stat to get the canonical mtime before caching.
  const freshStat = fs.statSync(p);
  _cache = { path: p, mtimeMs: freshStat.mtimeMs, data };
  return data;
}

function saveIndex(index: MemoryIndex): void {
  index.last_updated = now();
  writeIndexToDisk(index);
  const p = indexPath();
  const stat = fs.statSync(p);
  _cache = { path: p, mtimeMs: stat.mtimeMs, data: index };
}

function now(): string {
  return new Date().toISOString().slice(0, 10);
}

function md5(content: string): string {
  return crypto.createHash('md5').update(content.trim()).digest('hex');
}

// ── Working Memory (Tier 1) ───────────────────────────────────────────────────

export function readWorkingMemory(): string {
  const p = workingMemoryPath();
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf-8');
}

export function writeWorkingMemory(content: string): void {
  const dir = memoryRoot();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Enforce ≤50 lines — trim oldest entries if needed
  const lines = content.split('\n');
  const trimmed =
    lines.length > WORKING_MEMORY_MAX_LINES
      ? lines.slice(lines.length - WORKING_MEMORY_MAX_LINES).join('\n')
      : content;

  fs.writeFileSync(workingMemoryPath(), trimmed, 'utf-8');
}

export function appendWorkingMemory(line: string): void {
  const existing = readWorkingMemory();
  const dated = `[${now()}] ${line}`;
  writeWorkingMemory(existing + '\n' + dated);
}

// ── Tier 2: Indexed Memory ────────────────────────────────────────────────────

/**
 * Add or update a memory entry. MD5 dedup — if content is identical, just
 * bumps the mention count and resets the decay clock. The decay_rate is
 * switched to PROMOTED_DECAY only at the exact promotion transition and only
 * if the entry was using the default INITIAL_DECAY; custom rates are
 * preserved across re-access.
 */
export function upsertMemory(
  topic: string,
  content: string,
  opts?: { decayRate?: number; file?: string },
): MemoryEntry {
  const index = loadIndex();
  const hash = md5(content);

  // Dedup check (active entries only — invalidated entries with the same hash
  // are skipped so a re-upsert after invalidation creates a fresh row).
  const existingEntry = index.entries.find((e) => e.id === hash && !e.invalid_at);
  if (existingEntry) {
    const wasPromoted = existingEntry.mentions >= PROMOTION_MENTIONS;
    existingEntry.mentions++;
    existingEntry.last_accessed = now();
    const isNowPromoted = existingEntry.mentions >= PROMOTION_MENTIONS;

    // Only act at the actual promotion transition, and only on defaults.
    // A caller-supplied decay rate or a manually-bumped weight is left alone.
    if (!wasPromoted && isNowPromoted) {
      if (existingEntry.weight < PROMOTION_WEIGHT_CEILING) {
        existingEntry.weight = PROMOTION_WEIGHT;
      }
      if (existingEntry.decay_rate === INITIAL_DECAY) {
        existingEntry.decay_rate = PROMOTED_DECAY;
      }
    }
    existingEntry.weight = Math.min(1.0, existingEntry.weight);
    saveIndex(index);
    return existingEntry;
  }

  // New entry
  const fileName = opts?.file ?? slugify(topic) + '.md';
  const entry: MemoryEntry = {
    id: hash,
    topic,
    file: fileName,
    weight: INITIAL_WEIGHT,
    mentions: 1,
    last_accessed: now(),
    decay_rate: opts?.decayRate ?? INITIAL_DECAY,
    valid_at: now(),
    tier: 2,
  };

  // Write content to tier 2 file
  const filePath = tier2FilePath(fileName);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const header = `# ${topic}\n*weight: ${entry.weight} | mentions: ${entry.mentions} | valid_from: ${entry.valid_at}*\n\n`;
  fs.writeFileSync(filePath, header + content, 'utf-8');

  index.entries.push(entry);
  index.hashes.push(hash);
  saveIndex(index);

  // Graphiti cascade — fire and forget, failures silent
  if (_graphitiAddEpisode) {
    _graphitiAddEpisode({
      name: `tier2:${topic}`,
      content,
      sourceType: 'memory_upsert',
      sourceDescription: `Tier 2 memory: ${topic}`,
      referenceTime: entry.valid_at,
    }).catch(() => {
      /* silent — graphiti may be unavailable */
    });
  }

  return entry;
}

/**
 * Mark an existing memory entry as superseded (never deleted, just flagged).
 * Optionally provide the replacement entry.
 */
export function invalidateMemory(id: string, replacementContent?: string): void {
  const index = loadIndex();
  const entry = index.entries.find((e) => e.id === id);
  if (entry) {
    entry.invalid_at = now();
    entry.weight = 0;
  }
  saveIndex(index);

  if (replacementContent && entry) {
    upsertMemory(entry.topic, replacementContent);
  }
}

/**
 * Load all Tier 2 entries with weight ≥ threshold (default 0.3).
 * Returns their full content for system prompt injection.
 */
export function loadRelevantMemories(
  minWeight = 0.3,
  maxEntries = 8,
): Array<{ topic: string; content: string; weight: number }> {
  const index = loadIndex();
  const relevant = index.entries
    .filter((e) => e.tier === 2 && !e.invalid_at && e.weight >= minWeight)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, maxEntries);

  const results: Array<{ topic: string; content: string; weight: number }> = [];
  for (const entry of relevant) {
    const filePath = tier2FilePath(entry.file);
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      results.push({ topic: entry.topic, content, weight: entry.weight });

      // Bump mention count (access = reinforcement)
      entry.mentions++;
      entry.last_accessed = now();
    } catch {
      /* skip unreadable files */
    }
  }

  if (results.length > 0) saveIndex(index);
  return results;
}

// ── Tier 3: Archive ───────────────────────────────────────────────────────────

/** Append a fact or summary to today's archive file (append-only). */
export function appendToArchive(content: string): void {
  const dir = archiveDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const filePath = archiveFilePath(now());
  const entry = `\n---\n*${new Date().toISOString()}*\n${content}\n`;
  fs.appendFileSync(filePath, entry, 'utf-8');
}

/** Load a specific archive date for explicit recall. */
export function loadArchiveDate(date: string): string {
  const filePath = archiveFilePath(date);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

// ── Nightly decay & pruning ───────────────────────────────────────────────────

/**
 * Apply daily decay to all Tier 2 entries.
 * Entries that decay below 0.05 are moved to archive.
 * Run this once per night (acquireLock before calling).
 */
export function runNightlyDecay(): { decayed: number; archived: number; pruned: number } {
  const index = loadIndex();
  let decayed = 0;
  let archived = 0;
  let pruned = 0;

  for (const entry of index.entries) {
    if (entry.tier !== 2 || entry.invalid_at) continue;

    // Apply decay
    const daysSinceAccess = Math.floor(
      (Date.now() - new Date(entry.last_accessed).getTime()) / (1000 * 60 * 60 * 24),
    );

    if (daysSinceAccess > 0) {
      const oldWeight = entry.weight;
      // Multiplicative decay: weight *= (1 - decay_rate) per day
      // Much gentler than subtractive — a new entry (0.2, rate 0.10)
      // lasts ~15 days vs. 2 days with the old formula.
      entry.weight = Math.max(0, entry.weight * Math.pow(1 - entry.decay_rate, daysSinceAccess));
      if (entry.weight !== oldWeight) decayed++;
    }

    // Archive entries below threshold
    if (entry.weight < ARCHIVE_THRESHOLD && !entry.invalid_at) {
      const filePath = tier2FilePath(entry.file);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        appendToArchive(
          `## ${entry.topic} (archived — weight: ${entry.weight.toFixed(3)})\n${content}`,
        );
        fs.unlinkSync(filePath);
        archived++;
      }
      // Remove from index (it's in archive now)
      index.entries = index.entries.filter((e) => e.id !== entry.id);
      index.hashes = index.hashes.filter((h) => h !== entry.id);
      pruned++;
    }
  }

  saveIndex(index);
  return { decayed, archived, pruned };
}

/**
 * Build a concise memory context string for system prompt injection.
 * Tier 1 (working memory) always included. Tier 2 loaded by weight.
 */
export function buildMemoryContext(opts?: { maxChars?: number; minWeight?: number }): string {
  const maxChars = opts?.maxChars ?? 3000;
  const minWeight = opts?.minWeight ?? 0.3;

  const working = readWorkingMemory();
  const tier2 = loadRelevantMemories(minWeight, 6);

  const parts: string[] = [];

  if (working.trim()) {
    parts.push(`### Working Memory\n${working.trim()}`);
  }

  for (const m of tier2) {
    parts.push(`### ${m.topic} (weight: ${m.weight.toFixed(2)})\n${m.content.slice(0, 500)}`);
  }

  const combined = parts.join('\n\n');
  return combined.length > maxChars
    ? combined.slice(0, maxChars) + '\n\n*(memory truncated)*'
    : combined;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initMemoryIndex(): void {
  const dir = memoryRoot();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const archDir = archiveDir();
  if (!fs.existsSync(archDir)) fs.mkdirSync(archDir, { recursive: true });
  loadIndex(); // ensures index.json exists
  console.log(`[memory-index] Initialized at ${dir}`);
}
