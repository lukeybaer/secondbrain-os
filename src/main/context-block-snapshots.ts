// context-block-snapshots.ts
//
// Git-style snapshot / revert / diff layer on top of core-memory-blocks.ts.
// Every block write captures a content-addressed snapshot under
// memory/core-blocks/.snapshots/<block>/<hash>.md plus an append-only
// manifest.jsonl that records {hash, ts, by, parent_hash, byte_len}.
// Callers can list history, diff any two snapshots, and revert a block
// to a prior hash without touching git or pulling in a libgit2 binding.
//
// Inspired by Letta V1 "Context Repositories" (Apr 2026 blog post and
// rearchitecture) - programmatic, versioned context blocks with rollback,
// replacing free-form core memory. SecondBrain already shipped
// core-memory-blocks.ts (atomic, byte-budgeted persona/human/scratchpad
// blocks) but had no history. If the agent overwrote a block badly, the
// prior content was gone. This module closes that gap.
//
// Pure module. Same dependency-injection pattern as core-memory-blocks.ts:
// callers pass the block dir, tests use tmp dirs.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface SnapshotEntry {
  hash: string;
  ts: string;
  by: string;
  parent_hash: string | null;
  byte_len: number;
  note?: string;
}

export interface DiffResult {
  added: string[];
  removed: string[];
  unchanged_lines: number;
}

const SAFE_NAME = /^[a-z0-9_-]+$/i;

function snapshotsRoot(dir: string): string {
  return path.join(dir, '.snapshots');
}

function blockSnapDir(dir: string, name: string): string {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`invalid block name: ${name}`);
  }
  return path.join(snapshotsRoot(dir), name);
}

function manifestPath(dir: string, name: string): string {
  return path.join(blockSnapDir(dir, name), 'manifest.jsonl');
}

function blockFile(dir: string, name: string): string {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`invalid block name: ${name}`);
  }
  return path.join(dir, `${name}.md`);
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export interface SnapshotOptions {
  by: string;
  note?: string;
  now?: Date;
  /** Max snapshots retained per block. Older snapshots are pruned. Default 50. */
  retain?: number;
}

/**
 * Capture a content-addressed snapshot of `content`. Returns the entry. If
 * the content matches the most recent snapshot's hash, the call is a no-op
 * and the existing entry is returned (no duplicate manifest line). The
 * caller is responsible for writing the live block file - this only manages
 * the history.
 */
export function snapshotBlock(
  dir: string,
  name: string,
  content: string,
  opts: SnapshotOptions,
): SnapshotEntry {
  const snapDir = blockSnapDir(dir, name);
  ensureDir(snapDir);

  const hash = sha256(content);
  const manifest = listSnapshots(dir, name);
  const top = manifest.length > 0 ? manifest[manifest.length - 1] : null;

  if (top && top.hash === hash) return top;

  const entry: SnapshotEntry = {
    hash,
    ts: (opts.now ?? new Date()).toISOString(),
    by: opts.by,
    parent_hash: top ? top.hash : null,
    byte_len: Buffer.byteLength(content, 'utf8'),
    note: opts.note,
  };
  fs.writeFileSync(path.join(snapDir, `${hash}.md`), content, 'utf8');
  fs.appendFileSync(manifestPath(dir, name), JSON.stringify(entry) + '\n', 'utf8');

  const retain = opts.retain ?? 50;
  if (retain > 0) {
    pruneSnapshots(dir, name, retain);
  }
  return entry;
}

export function listSnapshots(dir: string, name: string): SnapshotEntry[] {
  const p = manifestPath(dir, name);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  const out: SnapshotEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (
        typeof obj.hash === 'string' &&
        typeof obj.ts === 'string' &&
        typeof obj.by === 'string' &&
        typeof obj.byte_len === 'number'
      ) {
        out.push({
          hash: obj.hash,
          ts: obj.ts,
          by: obj.by,
          parent_hash: typeof obj.parent_hash === 'string' ? obj.parent_hash : null,
          byte_len: obj.byte_len,
          note: typeof obj.note === 'string' ? obj.note : undefined,
        });
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

export function readSnapshotContent(
  dir: string,
  name: string,
  hash: string,
): string | null {
  if (!/^[a-f0-9]{64}$/i.test(hash)) return null;
  const p = path.join(blockSnapDir(dir, name), `${hash}.md`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

/**
 * Restore the block to a previously snapshotted hash. Returns the restored
 * content (which the caller should write back to the live block file).
 * Also records a new snapshot entry so the revert is itself audited.
 */
export function revertBlock(
  dir: string,
  name: string,
  hash: string,
  opts: SnapshotOptions,
): { content: string; entry: SnapshotEntry } {
  const content = readSnapshotContent(dir, name, hash);
  if (content === null) {
    throw new Error(`snapshot not found: ${name}/${hash}`);
  }
  const entry = snapshotBlock(dir, name, content, {
    ...opts,
    note: opts.note ?? `revert to ${hash.slice(0, 12)}`,
  });
  return { content, entry };
}

/**
 * Line-level diff between two snapshots. Added = lines in `b` not in `a`,
 * removed = lines in `a` not in `b`. unchanged_lines counts pairwise
 * preserved lines (multiset intersection). Sufficient for human review;
 * a full LCS diff is not needed.
 */
export function diffSnapshots(
  dir: string,
  name: string,
  hashA: string,
  hashB: string,
): DiffResult {
  const a = readSnapshotContent(dir, name, hashA);
  const b = readSnapshotContent(dir, name, hashB);
  if (a === null) throw new Error(`snapshot not found: ${name}/${hashA}`);
  if (b === null) throw new Error(`snapshot not found: ${name}/${hashB}`);
  return diffStrings(a, b);
}

export function diffStrings(a: string, b: string): DiffResult {
  const aLines = a.split(/\r?\n/);
  const bLines = b.split(/\r?\n/);
  const aCount = new Map<string, number>();
  const bCount = new Map<string, number>();
  for (const l of aLines) aCount.set(l, (aCount.get(l) ?? 0) + 1);
  for (const l of bLines) bCount.set(l, (bCount.get(l) ?? 0) + 1);
  const added: string[] = [];
  const removed: string[] = [];
  let unchanged = 0;
  const keys = new Set<string>([...aCount.keys(), ...bCount.keys()]);
  for (const key of keys) {
    const ac = aCount.get(key) ?? 0;
    const bc = bCount.get(key) ?? 0;
    unchanged += Math.min(ac, bc);
    if (bc > ac) for (let i = 0; i < bc - ac; i++) added.push(key);
    if (ac > bc) for (let i = 0; i < ac - bc; i++) removed.push(key);
  }
  return { added, removed, unchanged_lines: unchanged };
}

function pruneSnapshots(dir: string, name: string, retain: number): void {
  const snaps = listSnapshots(dir, name);
  if (snaps.length <= retain) return;
  const toRemove = snaps.slice(0, snaps.length - retain);
  const keep = snaps.slice(snaps.length - retain);
  for (const s of toRemove) {
    const p = path.join(blockSnapDir(dir, name), `${s.hash}.md`);
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // best-effort prune
      }
    }
  }
  // Rewrite manifest with kept entries.
  const lines = keep.map((s) => JSON.stringify(s)).join('\n') + (keep.length > 0 ? '\n' : '');
  fs.writeFileSync(manifestPath(dir, name), lines, 'utf8');
}

/**
 * Convenience: write `content` to the live block file AND record a
 * snapshot atomically (snapshot first; if it succeeds, the live write
 * runs and any failure surfaces to the caller).
 */
export function writeBlockWithSnapshot(
  dir: string,
  name: string,
  content: string,
  opts: SnapshotOptions,
): SnapshotEntry {
  ensureDir(dir);
  const entry = snapshotBlock(dir, name, content, opts);
  fs.writeFileSync(blockFile(dir, name), content, 'utf8');
  return entry;
}
