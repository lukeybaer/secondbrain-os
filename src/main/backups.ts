// backups.ts
// Tiered backup system for SecondBrain data.
//
// Retention policy:
//   - Daily:     30 days
//   - Tri-daily: 60 days  (every 3rd day, promoted from daily)
//   - Weekly:    90 days  (one per week)
//   - Monthly:   365 days (one per month)
//   - Quarterly: 3 years  (one per quarter)
//   - Yearly:    forever
//
// Each snapshot is a directory under %APPDATA%\secondbrain\backups\ containing
// a full copy of the data directory, config.json, and a SQLite backup.

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import Database from 'better-sqlite3';

// ── Types ────────────────────────────────────────────────────────────────────

export type BackupTier =
  | 'daily'
  | 'tri-daily'
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly'
  | 'pre-restore';

export interface SnapshotMeta {
  id: string; // ISO timestamp slug: 2026-04-04T120000
  timestamp: string; // Full ISO string
  tier: BackupTier;
  fileCount: number;
  dataBytes: number;
  durationMs: number;
  note?: string; // e.g. "pre-restore safety copy"
}

export interface BackupManifest {
  version: 1;
  snapshots: SnapshotMeta[];
}

// ── Paths ────────────────────────────────────────────────────────────────────

function userDataDir(): string {
  return app.getPath('userData');
}

function backupsRoot(): string {
  return path.join(userDataDir(), 'backups');
}

function dataDir(): string {
  return path.join(userDataDir(), 'data');
}

function configPath(): string {
  return path.join(userDataDir(), 'config.json');
}

function manifestPath(): string {
  return path.join(backupsRoot(), 'manifest.json');
}

function snapshotDir(id: string): string {
  return path.join(backupsRoot(), id);
}

// ── Manifest I/O ─────────────────────────────────────────────────────────────

function loadManifest(): BackupManifest {
  try {
    if (fs.existsSync(manifestPath())) {
      return JSON.parse(fs.readFileSync(manifestPath(), 'utf-8'));
    }
  } catch {
    /* corrupt manifest — start fresh */
  }
  return { version: 1, snapshots: [] };
}

function saveManifest(m: BackupManifest): void {
  fs.mkdirSync(backupsRoot(), { recursive: true });
  fs.writeFileSync(manifestPath(), JSON.stringify(m, null, 2));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Recursively copy a directory. */
async function copyDir(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else {
      await fsp.copyFile(s, d);
    }
  }
}

/** Count files and total bytes in a directory tree. */
async function dirStats(dir: string): Promise<{ fileCount: number; dataBytes: number }> {
  let fileCount = 0;
  let dataBytes = 0;
  if (!fs.existsSync(dir)) return { fileCount, dataBytes };
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await dirStats(p);
      fileCount += sub.fileCount;
      dataBytes += sub.dataBytes;
    } else {
      fileCount++;
      const stat = await fsp.stat(p);
      dataBytes += stat.size;
    }
  }
  return { fileCount, dataBytes };
}

/** Delete directory recursively. */
async function rmDir(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
}

/** ISO timestamp → compact slug for directory name (includes ms for uniqueness). */
function toSlug(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.(\d{3})Z$/, '_$1');
}

// ── Core Operations ──────────────────────────────────────────────────────────

/**
 * Create a full snapshot of the current SecondBrain state.
 */
export async function createSnapshot(opts?: {
  tier?: BackupTier;
  note?: string;
}): Promise<SnapshotMeta> {
  const start = Date.now();
  const now = new Date();
  const id = toSlug(now);
  const tier = opts?.tier ?? 'daily';
  const dest = snapshotDir(id);

  // Ensure target doesn't already exist (e.g. two backups in same second)
  if (fs.existsSync(dest)) {
    await rmDir(dest);
  }
  await fsp.mkdir(dest, { recursive: true });

  // 1. Copy data directory
  const srcData = dataDir();
  if (fs.existsSync(srcData)) {
    await copyDir(srcData, path.join(dest, 'data'));
  }

  // 2. SQLite backup (consistent point-in-time copy via .backup API)
  const dbPath = path.join(srcData, 'secondbrain.db');
  if (fs.existsSync(dbPath)) {
    try {
      const srcDb = new Database(dbPath, { readonly: true });
      srcDb.pragma('journal_mode = WAL');
      await srcDb.backup(path.join(dest, 'secondbrain.db'));
      srcDb.close();
      // Remove the copied WAL/SHM from the data copy since we have a clean backup
      for (const suffix of ['-wal', '-shm']) {
        const walCopy = path.join(dest, 'data', `secondbrain.db${suffix}`);
        if (fs.existsSync(walCopy)) fs.unlinkSync(walCopy);
      }
      // Replace the raw data copy's DB with the clean backup
      const dataCopyDb = path.join(dest, 'data', 'secondbrain.db');
      if (fs.existsSync(dataCopyDb)) fs.unlinkSync(dataCopyDb);
      fs.copyFileSync(path.join(dest, 'secondbrain.db'), dataCopyDb);
      fs.unlinkSync(path.join(dest, 'secondbrain.db'));
    } catch {
      // Fallback: the file copy from copyDir is still there
    }
  }

  // 3. Copy config
  if (fs.existsSync(configPath())) {
    await fsp.copyFile(configPath(), path.join(dest, 'config.json'));
  }

  // 4. Neo4j/Graphiti dump (SSH to EC2, dump graph, copy back)
  try {
    const { execSync } = require('child_process');
    const sshKey = path.join(app.getPath('home'), '.ssh', 'secondbrain-backend-key.pem');
    if (fs.existsSync(sshKey)) {
      const graphitiDest = path.join(dest, 'graphiti');
      await fsp.mkdir(graphitiDest, { recursive: true });
      // Dump Neo4j data via cypher-shell on EC2
      execSync(
        `ssh -i "${sshKey}" -o ConnectTimeout=10 -o StrictHostKeyChecking=no ec2-user@98.80.164.16 ` +
          `"docker exec secondbrain-neo4j neo4j-admin database dump neo4j --to-stdout 2>/dev/null" > "${path.join(graphitiDest, 'neo4j.dump')}"`,
        { timeout: 60000 },
      );
      console.log('[backup] Neo4j dump captured');
    }
  } catch (e: any) {
    console.warn(`[backup] Neo4j dump skipped: ${e.message?.slice(0, 100)}`);
  }

  // 4. Compute stats
  const stats = await dirStats(dest);

  const meta: SnapshotMeta = {
    id,
    timestamp: now.toISOString(),
    tier,
    fileCount: stats.fileCount,
    dataBytes: stats.dataBytes,
    durationMs: Date.now() - start,
    note: opts?.note,
  };

  // 5. Write per-snapshot meta
  fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify(meta, null, 2));

  // 6. Update manifest
  const manifest = loadManifest();
  manifest.snapshots.push(meta);
  saveManifest(manifest);

  return meta;
}

/**
 * List all snapshots, newest first.
 */
export function listSnapshots(): SnapshotMeta[] {
  const manifest = loadManifest();
  return [...manifest.snapshots].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Get a single snapshot's metadata.
 */
export function getSnapshot(id: string): SnapshotMeta | null {
  const manifest = loadManifest();
  return manifest.snapshots.find((s) => s.id === id) ?? null;
}

/**
 * Browse the file tree of a snapshot. Returns relative paths.
 */
export async function inspectSnapshot(
  id: string,
  subPath?: string,
): Promise<{
  files: { name: string; isDir: boolean; size: number }[];
} | null> {
  const base = path.join(snapshotDir(id), 'data', subPath ?? '');
  if (!fs.existsSync(base)) return null;

  const entries = await fsp.readdir(base, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(base, entry.name);
      const stat = await fsp.stat(full);
      return { name: entry.name, isDir: entry.isDirectory(), size: stat.size };
    }),
  );
  return { files };
}

/**
 * Read a specific file from a snapshot (for querying historical state).
 */
export async function readSnapshotFile(id: string, relativePath: string): Promise<string | null> {
  const filePath = path.join(snapshotDir(id), 'data', relativePath);
  if (!fs.existsSync(filePath)) return null;
  return fsp.readFile(filePath, 'utf-8');
}

/**
 * Query a snapshot's SQLite database.
 */
export function querySnapshotDb(id: string, sql: string): unknown[] | null {
  const dbPath = path.join(snapshotDir(id), 'data', 'secondbrain.db');
  if (!fs.existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(sql).all();
    db.close();
    return rows;
  } catch (e: any) {
    throw new Error(`Query failed on snapshot ${id}: ${e.message}`);
  }
}

// ── Restore ──────────────────────────────────────────────────────────────────

/**
 * Test-restore: extracts a snapshot to a temp directory for inspection.
 * Does NOT touch the live data. Returns the temp path.
 */
export async function testRestore(snapshotId: string): Promise<string> {
  const src = snapshotDir(snapshotId);
  if (!fs.existsSync(src)) throw new Error(`Snapshot ${snapshotId} not found`);

  const tempDir = path.join(backupsRoot(), `_test-restore-${snapshotId}`);
  if (fs.existsSync(tempDir)) await rmDir(tempDir);
  await copyDir(path.join(src, 'data'), path.join(tempDir, 'data'));
  if (fs.existsSync(path.join(src, 'config.json'))) {
    await fsp.copyFile(path.join(src, 'config.json'), path.join(tempDir, 'config.json'));
  }
  return tempDir;
}

/**
 * Commit-restore: first creates a "pre-restore" safety snapshot of current state,
 * then replaces the live data with the chosen snapshot.
 *
 * Returns the pre-restore snapshot ID so you can roll forward.
 */
export async function commitRestore(snapshotId: string): Promise<{ preRestoreId: string }> {
  const src = snapshotDir(snapshotId);
  if (!fs.existsSync(src)) throw new Error(`Snapshot ${snapshotId} not found`);

  // 1. Safety snapshot of current state
  const preRestore = await createSnapshot({
    tier: 'pre-restore',
    note: `Safety copy before restoring to ${snapshotId}`,
  });

  // 2. Replace live data dir
  const liveData = dataDir();
  const snapshotData = path.join(src, 'data');
  if (fs.existsSync(liveData)) {
    await rmDir(liveData);
  }
  if (fs.existsSync(snapshotData)) {
    await copyDir(snapshotData, liveData);
  }

  // 3. Replace config if present in snapshot
  const snapshotConfig = path.join(src, 'config.json');
  if (fs.existsSync(snapshotConfig)) {
    await fsp.copyFile(snapshotConfig, configPath());
  }

  return { preRestoreId: preRestore.id };
}

/**
 * Roll forward: restore from the most recent pre-restore snapshot.
 * This undoes a commitRestore, returning to the state before the restore.
 */
export async function rollForward(): Promise<{ restoredFromId: string }> {
  const manifest = loadManifest();
  const preRestores = manifest.snapshots
    .filter((s) => s.tier === 'pre-restore')
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  if (preRestores.length === 0) {
    throw new Error('No pre-restore snapshot found — nothing to roll forward to');
  }

  const target = preRestores[0];
  const src = snapshotDir(target.id);

  // Replace live data with the pre-restore copy
  const liveData = dataDir();
  if (fs.existsSync(liveData)) await rmDir(liveData);
  if (fs.existsSync(path.join(src, 'data'))) {
    await copyDir(path.join(src, 'data'), liveData);
  }

  const snapshotConfig = path.join(src, 'config.json');
  if (fs.existsSync(snapshotConfig)) {
    await fsp.copyFile(snapshotConfig, configPath());
  }

  return { restoredFromId: target.id };
}

/**
 * Clean up test-restore temp directories.
 */
export async function cleanupTestRestores(): Promise<number> {
  const root = backupsRoot();
  if (!fs.existsSync(root)) return 0;
  const entries = await fsp.readdir(root);
  let cleaned = 0;
  for (const entry of entries) {
    if (entry.startsWith('_test-restore-')) {
      await rmDir(path.join(root, entry));
      cleaned++;
    }
  }
  return cleaned;
}

// ── Retention / Pruning ──────────────────────────────────────────────────────

interface RetentionWindow {
  maxAgeDays: number;
  intervalDays: number;
}

const RETENTION: RetentionWindow[] = [
  { maxAgeDays: 30, intervalDays: 1 }, // Daily: keep all from last 30 days
  { maxAgeDays: 60, intervalDays: 3 }, // Tri-daily: one per 3 days, 30–60 days
  { maxAgeDays: 90, intervalDays: 7 }, // Weekly: one per week, 60–90 days
  { maxAgeDays: 365, intervalDays: 30 }, // Monthly: one per month, 90–365 days
  { maxAgeDays: 1095, intervalDays: 91 }, // Quarterly: one per quarter, 1–3 years
  { maxAgeDays: Infinity, intervalDays: 365 }, // Yearly: one per year, 3+ years
];

/**
 * Apply retention policy. Returns IDs of deleted snapshots.
 */
export async function pruneSnapshots(): Promise<string[]> {
  const manifest = loadManifest();
  const now = Date.now();
  const deleted: string[] = [];

  // Never prune pre-restore snapshots (safety nets) — keep latest 3 only
  const preRestores = manifest.snapshots
    .filter((s) => s.tier === 'pre-restore')
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const preRestoreToDelete = preRestores.slice(3);

  // Regular snapshots
  const regular = manifest.snapshots
    .filter((s) => s.tier !== 'pre-restore')
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp)); // oldest first

  const keep = new Set<string>();

  // Walk through retention windows from finest to coarsest
  let prevMaxAge = 0;
  for (const window of RETENTION) {
    const minMs = prevMaxAge * 86400000;
    const maxMs = window.maxAgeDays === Infinity ? Infinity : window.maxAgeDays * 86400000;
    const intervalMs = window.intervalDays * 86400000;

    // Get snapshots in this age window
    const inWindow = regular.filter((s) => {
      const age = now - new Date(s.timestamp).getTime();
      return age >= minMs && age < maxMs;
    });

    if (inWindow.length === 0) {
      prevMaxAge = window.maxAgeDays;
      continue;
    }

    // Keep one snapshot per interval — the oldest in each bucket
    let lastKeptTime = -Infinity;
    for (const s of inWindow) {
      const t = new Date(s.timestamp).getTime();
      if (t - lastKeptTime >= intervalMs) {
        keep.add(s.id);
        lastKeptTime = t;

        // Update tier label to reflect promotion
        if (window.intervalDays >= 365) s.tier = 'yearly';
        else if (window.intervalDays >= 91) s.tier = 'quarterly';
        else if (window.intervalDays >= 30) s.tier = 'monthly';
        else if (window.intervalDays >= 7) s.tier = 'weekly';
        else if (window.intervalDays >= 3) s.tier = 'tri-daily';
        else s.tier = 'daily';
      }
    }

    prevMaxAge = window.maxAgeDays;
  }

  // Delete snapshots not in keep set
  const toDelete = [...regular.filter((s) => !keep.has(s.id)), ...preRestoreToDelete];

  for (const s of toDelete) {
    const dir = snapshotDir(s.id);
    if (fs.existsSync(dir)) {
      await rmDir(dir);
    }
    deleted.push(s.id);
  }

  // Update manifest
  manifest.snapshots = manifest.snapshots.filter((s) => !deleted.includes(s.id));
  saveManifest(manifest);

  return deleted;
}

// ── Scheduled Entry Point ────────────────────────────────────────────────────

/**
 * Run a daily backup cycle: create snapshot + prune old ones.
 * This is the function called by the scheduled task / CLI script.
 */
export async function runDailyBackup(): Promise<{ snapshot: SnapshotMeta; pruned: string[] }> {
  // Prune BEFORE creating so the new snapshot can't be accidentally deleted
  const pruned = await pruneSnapshots();
  await cleanupTestRestores();
  const snapshot = await createSnapshot({ tier: 'daily' });
  return { snapshot, pruned };
}
