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
// hard-excluded-persons rule holds at persistence, matching the already-wired
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

function desktopGraphitiEnrichmentAllowed(nowMs = Date.now()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour12: false,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(nowMs));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const minuteOfDay = Number(value.hour) * 60 + Number(value.minute);
  // Desktop does not own the cloud delivery receipt, so it uses the fixed
  // bounded release. Raw Tier 2 memory and the durable retry spool continue
  // locally; only Graphiti semantic enrichment waits during 23:00-05:30 CT.
  return minuteOfDay >= 5 * 60 + 30 && minuteOfDay < 23 * 60;
}

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

/**
 * Thrown when data/agent/memory/index.json exists but cannot be parsed into a
 * usable index. Loud on purpose (Gravity g14): the previous behaviour returned
 * a FRESH EMPTY index with no error, no log and no exception, so every read
 * reported success while remembering nothing, and the next write then saved
 * that empty index over the real file, destroying every weight, mention count
 * and decay record (Gravity g9). Reproduced 2026-08-24: 3 entries -> corrupt
 * -> 1 entry, 3 orphaned .md files.
 *
 * Recovery is `rebuildIndexFromDisk()`: the .md corpus survives corruption, so
 * an unreadable index is a recoverable failure, not a permanent loss.
 */
export class CorruptMemoryIndexError extends Error {
  readonly indexFile: string;
  readonly reason: string;
  readonly quarantineFile: string | null;
  constructor(indexFile: string, reason: string, quarantineFile: string | null) {
    super(
      `Memory index at ${indexFile} is unreadable (${reason}). Refusing to read it as ` +
        `empty or to overwrite it, because either would silently destroy every ` +
        `weight, mention count and decay record. ` +
        (quarantineFile ? `A verbatim copy is preserved at ${quarantineFile}. ` : '') +
        `The Tier 2 .md files are intact: call rebuildIndexFromDisk() to recover.`,
    );
    this.name = 'CorruptMemoryIndexError';
    this.indexFile = indexFile;
    this.reason = reason;
    this.quarantineFile = quarantineFile;
  }
}

type IndexRead =
  { ok: true; index: MemoryIndex } | { ok: false; reason: string; raw: string | null };

/**
 * Read and STRUCTURALLY validate the index file. Anything that cannot become a
 * usable index is a failure with a named reason, never a silent empty result.
 * A missing `hashes` array is repaired rather than rejected: it loses no
 * entries, so treating an older file as corrupt would be its own data hazard.
 */
function readIndexFile(p: string): IndexRead {
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err) {
    return { ok: false, reason: `unreadable file: ${String(err)}`, raw: null };
  }
  if (!raw.trim()) return { ok: false, reason: 'file is empty', raw };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `invalid JSON: ${(err as Error).message}`, raw };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'root is not a JSON object', raw };
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.entries)) {
    return { ok: false, reason: 'no "entries" array', raw };
  }
  // Codex review 1b9c085d8fb6 [high]: "is an object" is not validation. An
  // entry with no id/file passes that test, then vanishes from every lookup or
  // throws inside path.join() much later, far from the cause. Require the two
  // fields every code path dereferences; leave the numeric fields tolerant so a
  // genuinely older index is not condemned as corrupt (that would be its own
  // data hazard).
  const badEntry = (obj.entries as unknown[]).findIndex(
    (e) =>
      e === null ||
      typeof e !== 'object' ||
      Array.isArray(e) ||
      typeof (e as MemoryEntry).id !== 'string' ||
      !(e as MemoryEntry).id ||
      typeof (e as MemoryEntry).file !== 'string' ||
      !(e as MemoryEntry).file,
  );
  if (badEntry !== -1) {
    return { ok: false, reason: `entries[${badEntry}] is not a usable memory entry`, raw };
  }
  const index: MemoryIndex = {
    version: typeof obj.version === 'number' ? obj.version : 1,
    last_updated: typeof obj.last_updated === 'string' ? obj.last_updated : now(),
    entries: obj.entries as MemoryEntry[],
    hashes: Array.isArray(obj.hashes) ? (obj.hashes as string[]) : [],
  };
  return { ok: true, index };
}

/**
 * Preserve the corrupt bytes verbatim before anyone touches them (g9). Named
 * by content hash so repeated reads of the same corruption reuse one file
 * instead of spamming the directory. Never throws: quarantine is a best-effort
 * courtesy, and failing to copy must not suppress the loud error itself.
 */
function quarantineCorruptIndex(p: string): string | null {
  try {
    const dir = memoryRoot();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Codex review 1b9c085d8fb6 [medium]: hash and copy the BYTES. Decoding to
    // UTF-8 first would mangle invalid sequences, and md5() trims, so two
    // different whitespace corruptions would collide on one filename and the
    // second would be silently discarded.
    const bytes = fs.readFileSync(p);
    const digest = crypto.createHash('md5').update(bytes).digest('hex').slice(0, 12);
    const target = path.join(dir, `index.corrupt-${digest}.json`);
    if (!fs.existsSync(target)) fs.writeFileSync(target, bytes);
    // Only claim quarantine when the bytes really landed, byte for byte.
    if (!fs.readFileSync(target).equals(bytes)) return null;
    return target;
  } catch {
    return null;
  }
}

function failCorrupt(p: string, reason: string): never {
  _indexCache = null;
  _indexCachedAt = 0;
  const quarantine = quarantineCorruptIndex(p);
  const err = new CorruptMemoryIndexError(p, reason, quarantine);
  console.error(`[memory-index] ${err.message}`);
  throw err;
}

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

  const read = readIndexFile(p);
  if (!read.ok) failCorrupt(p, read.reason);

  _indexCache = read.index;
  _indexCachedAt = Date.now();
  return _indexCache;
}

/**
 * Persist the index. Refuses to clobber an on-disk file that is present but
 * unreadable: that file is the only remaining record of the real weights, and
 * overwriting it converts recoverable corruption into permanent loss. Only the
 * explicit recovery path (`rebuildIndexFromDisk`) may replace it, and only
 * after the bytes have been quarantined.
 */
function saveIndex(index: MemoryIndex, opts?: { replaceCorrupt?: boolean }): void {
  const dir = memoryRoot();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const p = indexPath();
  if (!opts?.replaceCorrupt && fs.existsSync(p)) {
    const read = readIndexFile(p);
    if (!read.ok) failCorrupt(p, read.reason);
  }
  index.last_updated = now();

  // Codex review 1b9c085d8fb6 [high]: write ATOMICALLY. A direct writeFileSync
  // is exactly how index.json became a truncated file in the first place: kill
  // the process mid-write and the only copy is torn. Serialize first (so a
  // serialization failure never truncates anything), write a temp file in the
  // same directory, then rename, which is atomic on one filesystem. A crash
  // now leaves either the old complete index or the new one, never a torn one.
  const payload = JSON.stringify(index, null, 2);
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, payload, 'utf-8');
      fs.fsyncSync(fd); // durable before the rename makes it the live file
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, p);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* the temp file is inert; the live index was never touched */
    }
    throw err;
  }

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
 * Thrown when content destined for durable memory carries a name under the
 * zero-tolerance privacy rule (list retired and empty since 2026-09-24). The write and the
 * Graphiti cascade are both aborted before any side effect.
 */
export class ForbiddenContentError extends Error {
  readonly matches: string[];
  constructor(matches: string[]) {
    super(
      `Refusing to persist memory: forbidden name(s) ${matches.join(', ')} ` +
        `violate the hard-excluded-persons privacy rule. Nothing was written and ` +
        `the Graphiti cascade was skipped.`,
    );
    this.name = 'ForbiddenContentError';
    this.matches = matches;
  }
}

/**
 * Backstop run before any durable-memory write. Throws ForbiddenContentError
 * (loud, never silent) if any part contains a forbidden name. Word-boundary
 * aware via RULE_NO_FORBIDDEN_PEOPLE, so a longer name that merely contains an
 * entry passes clean.
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
  if (!desktopGraphitiEnrichmentAllowed()) {
    try {
      enqueueFailedEpisode(episode);
    } catch {
      /* the Tier 2 write remains canonical even if its outbox is unavailable */
    }
    return;
  }
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
    if (!desktopGraphitiEnrichmentAllowed()) return null;
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

// ── Recovery ──────────────────────────────────────────────────────────────────

/** Collect every Tier 2 .md file under memoryRoot(), skipping the archive. */
function listTier2Files(dir: string, rel = ''): string[] {
  // Codex review 1b9c085d8fb6 [high]: this must FAIL CLOSED. Swallowing a
  // readdir error here would hand rebuildIndexFromDisk a partial corpus, and it
  // would then replace the index with one that silently drops whatever could
  // not be listed. A partial rebuild is a second data loss, so let it throw.
  const names: fs.Dirent[] = fs.readdirSync(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const d of names) {
    if (d.name === 'archive') continue;
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) {
      out.push(...listTier2Files(path.join(dir, d.name), childRel));
    } else if (d.name.endsWith('.md') && d.name !== 'MEMORY.md') {
      out.push(childRel);
    }
  }
  return out;
}

/**
 * Recover the index from the .md corpus. This is what makes an unreadable
 * index a RECOVERABLE failure: `upsertMemory` stamps every Tier 2 file with
 * `# <topic>` and a `*weight | mentions | valid_from*` line, so the topic, the
 * original body (and therefore its dedup hash) and the creation-time weight
 * all read straight back off disk.
 *
 * Honest limits, both of which are why this is NOT automatic:
 *  - The stamped header is written once at creation and never updated, so
 *    reinforcement earned afterwards (promoted weights, mention counts, decay
 *    history) was only ever in the index and does not come back.
 *  - `invalid_at` also lived only in the index, while `invalidateMemory` leaves
 *    the .md file on disk. A rebuild therefore RESURRECTS superseded memories
 *    as active (Codex review 1b9c085d8fb6). Review the result before trusting
 *    it, and re-invalidate anything ExampleCo had retired.
 *
 * Recovery restores tracking of every memory, not its history. The corrupt
 * bytes are quarantined first and quarantine must succeed, so recovering
 * destroys nothing.
 */
export function rebuildIndexFromDisk(): {
  rebuilt: number;
  quarantinePath: string | null;
} {
  const dir = memoryRoot();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const p = indexPath();
  let quarantinePath: string | null = null;
  if (fs.existsSync(p)) {
    const read = readIndexFile(p);
    if (!read.ok) {
      // Codex review 1b9c085d8fb6 [high]: quarantine is a PRECONDITION here,
      // not a courtesy. Replacing an unreadable index whose bytes were not
      // safely copied first is the permanent-loss path this whole change
      // exists to close, so refuse rather than proceed on best effort.
      quarantinePath = quarantineCorruptIndex(p);
      if (!quarantinePath) {
        throw new CorruptMemoryIndexError(
          p,
          `${read.reason}; and the corrupt bytes could NOT be quarantined, so ` +
            `rebuilding would destroy the only remaining copy`,
          null,
        );
      }
    }
  }

  const index: MemoryIndex = { version: 1, last_updated: now(), entries: [], hashes: [] };
  // Any unreadable Tier 2 file aborts the rebuild for the same reason: a
  // silently skipped memory is a memory permanently untracked.
  for (const rel of listTier2Files(dir)) {
    const text: string = fs.readFileSync(path.join(dir, rel), 'utf-8');
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const stamped =
      /^#\s+\S/.test(lines[0] || '') &&
      /^\*weight:\s*[\d.]+\s*\|\s*mentions:\s*\d+\s*\|\s*valid_from:/.test(lines[1] || '');

    const topic = stamped
      ? lines[0].replace(/^#\s+/, '').trim()
      : path.basename(rel, '.md').replace(/-/g, ' ');
    const body = stamped ? lines.slice(3).join('\n') : text;
    const meta = stamped ? lines[1] : '';
    const weight = stamped ? Number(meta.match(/weight:\s*([\d.]+)/)?.[1] ?? 0.2) : 0.2;
    const mentions = stamped ? Number(meta.match(/mentions:\s*(\d+)/)?.[1] ?? 1) : 1;
    const validAt = stamped ? (meta.match(/valid_from:\s*([\d-]+)/)?.[1] ?? now()) : now();

    const hash = md5(body);
    if (index.hashes.includes(hash)) continue; // identical body already recovered
    index.entries.push({
      id: hash,
      topic,
      file: rel,
      weight: Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0.2,
      mentions: Number.isFinite(mentions) && mentions > 0 ? mentions : 1,
      last_accessed: now(),
      decay_rate: mentions >= 3 ? 0.02 : 0.1,
      valid_at: validAt,
      tier: 2,
    });
    index.hashes.push(hash);
  }

  saveIndex(index, { replaceCorrupt: true });
  console.error(
    `[memory-index] Rebuilt the memory index from disk: ${index.entries.length} Tier 2 ` +
      `topic(s) recovered from .md files` +
      (quarantinePath ? `; the unreadable index was preserved at ${quarantinePath}` : '') +
      `. Reinforcement earned after each memory was created (promoted weights, mention ` +
      `counts, decay history) was only ever in the index and is NOT recoverable.`,
  );
  return { rebuilt: index.entries.length, quarantinePath };
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initMemoryIndex(): void {
  const dir = memoryRoot();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const archDir = archiveDir();
  if (!fs.existsSync(archDir)) fs.mkdirSync(archDir, { recursive: true });
  try {
    loadIndex(); // ensures index.json exists
  } catch (err) {
    if (!(err instanceof CorruptMemoryIndexError)) throw err;
    // Report, do NOT auto-recover. Codex review 1b9c085d8fb6 [high]: an
    // automatic rebuild would resurrect superseded memories as active, because
    // `invalid_at` lives only in the index while the .md file stays on disk.
    // Silently reviving a fact ExampleCo retired is its own correctness failure, so
    // recovery stays an explicit, human-triggered call. What init owes is
    // loudness: the state that shipped until 2026-08-24 was silent amnesia
    // followed by permanent loss on the next write, and that is now impossible
    // because every read throws and every write refuses.
    console.error(`[memory-index] ${err.message}`);
    console.error(
      '[memory-index] Tier 2 memory is UNAVAILABLE until this is resolved. Reads throw and ' +
        'writes refuse, so nothing further can be destroyed. Inspect the quarantined copy, ' +
        'then call rebuildIndexFromDisk() to re-track every .md file. Note that rebuilding ' +
        'cannot know which memories were superseded, so review the result.',
    );
  }
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
