// graphiti-retry-queue.ts
//
// Durable spool for Graphiti addEpisode() failures (E5, plan rank 22).
//
// Problem: upsertMemory() fires the Graphiti cascade fire-and-forget. When
// the SSH tunnel to EC2 (http://127.0.0.1:8000) is down, every episode was
// silently lost (.catch(() => {})), so the knowledge graph drifted from the
// filesystem with no trace. That violates "fail loud, never silent" and the
// raw-archival principle.
//
// Fix: a one-file JSONL spool. On add failure the episode is appended as one
// JSON line. On the next successful Graphiti interaction (or module init with
// a healthy Graphiti), drainSpool() replays each spooled episode exactly once
// per drain pass, removing an episode from the spool the moment Graphiti
// accepts it so a crash mid-drain can never duplicate an accepted episode.
//
// Default spool location follows the memory-index dataDir pattern:
//   %APPDATA%/secondbrain/data/agent/graphiti-spool.jsonl
// All functions accept an injectable spoolDir for tests.

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export interface SpooledEpisode {
  name: string;
  episode_body: string;
  source_description: string;
  reference_time?: string;
  group_id?: string;
}

export interface DrainResult {
  attempted: number; // episodes handed to addEpisodeFn this pass
  sent: number; // episodes Graphiti accepted (removed from the spool)
  remaining: number; // lines left in the spool after the pass
}

const SPOOL_FILE_NAME = 'graphiti-spool.jsonl';

function defaultSpoolDir(): string {
  return path.join(app.getPath('userData'), 'data', 'agent');
}

export function spoolFilePath(spoolDir?: string): string {
  return path.join(spoolDir ?? defaultSpoolDir(), SPOOL_FILE_NAME);
}

function readSpoolLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  try {
    return fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeSpoolLines(file: string, lines: string[]): void {
  fs.writeFileSync(file, lines.length ? lines.join('\n') + '\n' : '', 'utf-8');
}

/** Remove one occurrence of a line from the spool (first match). */
function removeSpoolLine(file: string, line: string): void {
  const lines = readSpoolLines(file);
  const idx = lines.indexOf(line);
  if (idx === -1) return;
  lines.splice(idx, 1);
  writeSpoolLines(file, lines);
}

/**
 * Append one failed episode to the spool as a single JSON line.
 * Synchronous and cheap; callers wrap it so a spool I/O error can never
 * break the memory write path that triggered the cascade.
 */
export function enqueueFailedEpisode(episode: SpooledEpisode, spoolDir?: string): void {
  const file = spoolFilePath(spoolDir);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(episode) + '\n', 'utf-8');
}

/** Number of episodes currently waiting in the spool. */
export function spoolCount(spoolDir?: string): number {
  return readSpoolLines(spoolFilePath(spoolDir)).length;
}

// Re-entrancy guard: one drain per spool file at a time. A second concurrent
// drain would re-read lines the first pass is mid-way through attempting and
// could double-send an episode.
const _draining = new Set<string>();

/**
 * Replay spooled episodes through addEpisodeFn.
 *
 * Exactly-once-per-drain semantics: each snapshot line is attempted at most
 * once, and an accepted episode is removed from the spool BEFORE the loop
 * moves on, so neither a crash mid-drain nor a concurrent caller can send it
 * again. Failures (fn returns false or throws) stay in the spool for the
 * next drain. Malformed lines are dropped: they can never be sent.
 */
export async function drainSpool(
  addEpisodeFn: (episode: SpooledEpisode) => Promise<boolean>,
  spoolDir?: string,
): Promise<DrainResult> {
  const file = spoolFilePath(spoolDir);
  const result: DrainResult = { attempted: 0, sent: 0, remaining: 0 };

  if (_draining.has(file)) {
    result.remaining = readSpoolLines(file).length;
    return result;
  }
  _draining.add(file);
  try {
    const snapshot = readSpoolLines(file);
    for (const line of snapshot) {
      let episode: SpooledEpisode;
      try {
        episode = JSON.parse(line) as SpooledEpisode;
      } catch {
        removeSpoolLine(file, line); // unparseable: drop, it can never send
        continue;
      }
      result.attempted++;
      let accepted = false;
      try {
        accepted = await addEpisodeFn(episode);
      } catch {
        accepted = false;
      }
      if (accepted) {
        result.sent++;
        // Mark/remove before moving on: this line must never be re-sent.
        removeSpoolLine(file, line);
      }
    }
    result.remaining = readSpoolLines(file).length;
    return result;
  } finally {
    _draining.delete(file);
  }
}
