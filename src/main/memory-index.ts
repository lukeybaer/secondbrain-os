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
//     decay: weight -= decay_rate per day (reset on access)
//     promotion: mentions ≥ 3 → weight = 0.8
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
// Zero-tolerance privacy backstop. RULE_NO_FORBIDDEN_PEOPLE is the same
// word-boundary matcher the output critics use; importing it here wires that
// (previously output-only) guard into the durable-memory write boundary so the
// "no ex-wife tracking" rule holds at persistence, matching the already-wired
// EC2 scripts/lib/graphiti-source-policy.js. Pure module, no cycle.
import { RULE_NO_FORBIDDEN_PEOPLE } from './output-critic-rules';
// Graphiti cascade: every Tier 2 write also fires addEpisode() so the
// knowledge graph stays in sync with the filesystem. Statically imported:
// the previous lazy require('./graphiti-client') did not survive bundling
// (no ./graphiti-client chunk exists next to out/main/index.js), which left
// the cascade silently dead in the built app. Add failures are no longer
// dropped either: they spool to graphiti-spool.jsonl and replay on the next
// successful Graphiti interaction (see graphiti-retry-queue.ts).
// Reference: AMY_DEEP_RESEARCH.md section 1.
import {
  addEpisode as graphitiAddEpisode,
  isGraphitiAvailable,
  type GraphitiEpisode,
} from './graphiti-client';
import { drainSpool, enqueueFailedEpisode, spoolCount } from './graphiti-retry-queue';

// Under vitest the cascade is opt-in: unit tests that do not mock
// ./graphiti-client must never fire real network calls at the live knowledge
// graph. Tests that DO mock it set SECONDBRAIN_GRAPHITI_CASCADE_UNDER_TEST=1.
function graphitiCascadeEnabled(): boolean {
  if (!process.env.VITEST) return true;
  return process.env.SECONDBRAIN_GRAPHITI_CASCADE_UNDER_TEST === '1';
}

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

// ── Index I/O ─────────────────────────────────────────────────────────────────

let _indexCache: MemoryIndex | null = null;
let _indexCachedAt = 0;
const INDEX_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

export function loadIndex(): MemoryIndex {
  if (_indexCache && Date.now() - _indexCachedAt < INDEX_CACHE_TTL) {
    return _indexCache;
  }

  const p = indexPath();
  if (!fs.existsSync(p)) {
    const fresh: MemoryIndex = { version: 1, last_updated: now(), entries: [], hashes: [] };
    saveIndex(fresh);
    return fresh;
  }

  try {
    _indexCache = JSON.parse(fs.readFileSync(p, 'utf-8')) as MemoryIndex;
    _indexCachedAt = Date.now();
    return _indexCache;
  } catch {
    const fresh: MemoryIndex = { version: 1, last_updated: now(), entries: [], hashes: [] };
    return fresh;
  }
}

function saveIndex(index: MemoryIndex): void {
  const dir = memoryRoot();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  index.last_updated = now();
  fs.writeFileSync(indexPath(), JSON.stringify(index, null, 2), 'utf-8');
  _indexCache = index;
  _indexCachedAt = Date.now();
}

function now(): string {
  return new Date().toISOString().slice(0, 10);
}

function md5(content: string): string {
  return crypto.createHash('md5').update(content.trim()).digest('hex');
}

// ── Working Memory (Tier 1) ───────────────────────────────────────────────────

const WORKING_MEMORY_MAX_LINES = 50;

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
  assertNoForbiddenPeople(line);
  const existing = readWorkingMemory();
  const dated = `[${now()}] ${line}`;
  writeWorkingMemory(existing + '\n' + dated);
}

// ── Privacy backstop ──────────────────────────────────────────────────────────

/**
 * Thrown when content destined for durable memory ExampleCos a name under the
 * zero-tolerance privacy rule (Andrea, Julia, Marie-Louise). The write and the
 * Graphiti cascade are both aborted before any side effect.
 */
export class ForbiddenContentError extends Error {
  readonly matches: string[];
  constructor(matches: string[]) {
    super(
      `Refusing to persist memory: forbidden name(s) ${matches.join(', ')} ` +
        `violate the no-ex-wife-tracking privacy rule. Nothing was written and ` +
        `the Graphiti cascade was skipped.`,
    );
    this.name = 'ForbiddenContentError';
    this.matches = matches;
  }
}

/**
 * Backstop run before any durable-memory write. Throws ForbiddenContentError
 * (loud, never silent) if any part contains a forbidden name. Word-boundary
 * aware via RULE_NO_FORBIDDEN_PEOPLE, so "Andreas"/"Juliana" pass clean.
 */
function assertNoForbiddenPeople(...parts: string[]): void {
  const issues = RULE_NO_FORBIDDEN_PEOPLE.check(parts.join('\n'));
  if (issues && issues.length) {
    const matches = Array.from(new Set(issues.map((i) => i.match).filter((m): m is string => !!m)));
    const found = matches.length ? matches : ['(redacted)'];
    console.error(`[memory-index] ${new ForbiddenContentError(found).message}`);
    throw new ForbiddenContentError(found);
  }
}

// ── Tier 2: Indexed Memory ────────────────────────────────────────────────────

/**
 * Add or update a memory entry. MD5 dedup — if content is identical, just
 * bumps the mention count and resets the decay clock.
 */
export function upsertMemory(
  topic: string,
  content: string,
  opts?: { decayRate?: number; file?: string },
): MemoryEntry {
  assertNoForbiddenPeople(topic, content);
  const index = loadIndex();
  const hash = md5(content);

  // Dedup check
  const existingEntry = index.entries.find((e) => e.id === hash && !e.invalid_at);
  if (existingEntry) {
    existingEntry.mentions++;
    existingEntry.last_accessed = now();
    existingEntry.decay_rate = existingEntry.mentions >= 3 ? 0.02 : 0.1;
    if (existingEntry.mentions >= 3 && existingEntry.weight < 0.5) {
      existingEntry.weight = 0.8; // promotion
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
    weight: 0.2,
    mentions: 1,
    last_accessed: now(),
    decay_rate: opts?.decayRate ?? 0.1,
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

  // Graphiti cascade: non-blocking and never throws into the write path.
  // A failed add is spooled instead of silently lost; a successful add
  // opportunistically drains the spool (the tunnel is evidently up).
  if (graphitiCascadeEnabled()) {
    void fireGraphitiCascade({
      name: `tier2:${topic}`,
      episode_body: content,
      source_description: `memory_upsert:tier2:${topic}`,
      reference_time: entry.valid_at,
      group_id: 'owner-ea',
    });
  }

  return entry;
}

async function fireGraphitiCascade(episode: GraphitiEpisode): Promise<void> {
  let accepted = false;
  try {
    accepted = await graphitiAddEpisode(episode);
  } catch {
    accepted = false;
  }
  try {
    if (accepted) {
      await maybeDrainSpool();
    } else {
      enqueueFailedEpisode(episode);
    }
  } catch {
    /* spool I/O is best-effort; the Tier 2 write itself already succeeded */
  }
}

/**
 * Replay episodes spooled while Graphiti was unreachable. Called after a
 * successful Graphiti add (tunnel known up) and from initMemoryIndex when
 * the spool is non-empty and Graphiti reports healthy. Never throws.
 */
export async function maybeDrainSpool(): Promise<{
  attempted: number;
  sent: number;
  remaining: number;
} | null> {
  try {
    if (spoolCount() === 0) return null;
    return await drainSpool((ep) => graphitiAddEpisode(ep));
  } catch {
    return null;
  }
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
    if (entry.weight < 0.05 && !entry.invalid_at) {
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
  // Replay any Graphiti episodes spooled while the SSH tunnel was down.
  if (graphitiCascadeEnabled()) {
    void (async () => {
      try {
        if (spoolCount() > 0 && (await isGraphitiAvailable())) {
          await maybeDrainSpool();
        }
      } catch {
        /* best-effort replay; the next successful add drains too */
      }
    })();
  }
}
