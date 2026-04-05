#!/usr/bin/env npx ts-node
// backup-cli.ts
// Standalone backup script for Windows Task Scheduler.
//
// Usage:
//   npx ts-node scripts/backup-cli.ts                  # daily backup + prune
//   npx ts-node scripts/backup-cli.ts --list            # list all snapshots
//   npx ts-node scripts/backup-cli.ts --prune           # prune only (no new snapshot)
//
// This script re-implements the core logic without Electron's `app` module,
// using the known %APPDATA%\secondbrain path directly.

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { execSync } from "child_process";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database: any = require("better-sqlite3");

// ── S3 Configuration ─────────────────────────────────────────────────────────

const S3_BUCKET = "672613094048-secondbrain-backups";
const S3_PREFIX = "snapshots/";  // all archives under snapshots/

// ── Paths (mirror backups.ts but without Electron app module) ────────────────

const USER_DATA = path.join(process.env.APPDATA || "", "secondbrain");
const BACKUPS_ROOT = path.join(USER_DATA, "backups");
const DATA_DIR = path.join(USER_DATA, "data");
const CONFIG_PATH = path.join(USER_DATA, "config.json");
const MANIFEST_PATH = path.join(BACKUPS_ROOT, "manifest.json");

// ── Types (duplicated to avoid Electron imports) ─────────────────────────────

type BackupTier = "daily" | "tri-daily" | "weekly" | "monthly" | "quarterly" | "yearly" | "pre-restore";

interface SnapshotMeta {
  id: string;
  timestamp: string;
  tier: BackupTier;
  fileCount: number;
  dataBytes: number;
  durationMs: number;
  note?: string;
}

interface BackupManifest {
  version: 1;
  snapshots: SnapshotMeta[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadManifest(): BackupManifest {
  try {
    if (fs.existsSync(MANIFEST_PATH)) {
      return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
    }
  } catch { /* start fresh */ }
  return { version: 1, snapshots: [] };
}

function saveManifest(m: BackupManifest): void {
  fs.mkdirSync(BACKUPS_ROOT, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

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

function toSlug(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "_$1");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

// ── S3 Operations ────────────────────────────────────────────────────────────

function s3Upload(localPath: string, s3Key: string): void {
  const winPath = localPath.replace(/\//g, "\\");
  const result = execSync(`aws s3 cp "${winPath}" "s3://${S3_BUCKET}/${s3Key}" --region us-east-1 2>&1`, {
    encoding: "utf-8",
  });
  if (result) console.log(`    S3: ${result.trim()}`);
}

function s3Delete(s3Key: string): void {
  try {
    execSync(`aws s3 rm "s3://${S3_BUCKET}/${s3Key}" --region us-east-1`, {
      stdio: "pipe",
    });
  } catch { /* best-effort — file may already be gone */ }
}

function s3List(): string[] {
  try {
    const out = execSync(`aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}" --region us-east-1`, {
      stdio: "pipe", encoding: "utf-8",
    });
    return out.trim().split("\n").filter(Boolean).map(line => {
      const parts = line.trim().split(/\s+/);
      return parts[parts.length - 1]; // filename
    });
  } catch { return []; }
}

/** Compress a snapshot directory to .zip using .NET ZipFile (fast, no deps). */
function compressSnapshot(snapshotDir: string, archivePath: string): void {
  const src = snapshotDir.replace(/\//g, "\\");
  const dest = archivePath.replace(/\//g, "\\");
  // .NET ZipFile.CreateFromDirectory is 10-50x faster than Compress-Archive
  execSync(
    `powershell.exe -NoProfile -Command "Add-Type -Assembly System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${src}', '${dest}')"`,
    { stdio: "pipe", timeout: 300000 },
  );
}

/** Upload snapshot archive to S3 and sync manifest. */
async function syncToS3(snapshotId: string): Promise<{ archiveSize: number }> {
  const snapshotPath = path.join(BACKUPS_ROOT, snapshotId);
  const archiveName = `${snapshotId}.zip`;
  const archivePath = path.join(BACKUPS_ROOT, archiveName);

  // Compress
  compressSnapshot(snapshotPath, archivePath);
  const archiveSize = fs.statSync(archivePath).size;

  // Upload archive
  s3Upload(archivePath, `${S3_PREFIX}${archiveName}`);

  // Upload manifest
  s3Upload(MANIFEST_PATH, "manifest.json");

  // Clean up local archive (we keep the uncompressed dir for fast local restore)
  fs.unlinkSync(archivePath);

  return { archiveSize };
}

/** Delete a snapshot's archive from S3. */
function deleteFromS3(snapshotId: string): void {
  s3Delete(`${S3_PREFIX}${snapshotId}.zip`);
}

// ── Core ─────────────────────────────────────────────────────────────────────

async function createSnapshot(): Promise<SnapshotMeta> {
  const start = Date.now();
  const now = new Date();
  const id = toSlug(now);
  const dest = path.join(BACKUPS_ROOT, id);

  if (fs.existsSync(dest)) await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(dest, { recursive: true });

  // Copy data directory
  if (fs.existsSync(DATA_DIR)) {
    await copyDir(DATA_DIR, path.join(dest, "data"));
  }

  // SQLite backup
  const dbPath = path.join(DATA_DIR, "secondbrain.db");
  if (fs.existsSync(dbPath)) {
    try {
      const srcDb = new Database(dbPath, { readonly: true });
      srcDb.pragma("journal_mode = WAL");
      await srcDb.backup(path.join(dest, "secondbrain.db"));
      srcDb.close();
      // Clean WAL/SHM from copy, replace with clean backup
      for (const suffix of ["-wal", "-shm"]) {
        const wal = path.join(dest, "data", `secondbrain.db${suffix}`);
        if (fs.existsSync(wal)) fs.unlinkSync(wal);
      }
      const dataCopyDb = path.join(dest, "data", "secondbrain.db");
      if (fs.existsSync(dataCopyDb)) fs.unlinkSync(dataCopyDb);
      fs.copyFileSync(path.join(dest, "secondbrain.db"), dataCopyDb);
      fs.unlinkSync(path.join(dest, "secondbrain.db"));
    } catch (e: any) {
      console.warn(`SQLite backup fallback (file copy used): ${e.message}`);
    }
  }

  // Copy config
  if (fs.existsSync(CONFIG_PATH)) {
    await fsp.copyFile(CONFIG_PATH, path.join(dest, "config.json"));
  }

  const stats = await dirStats(dest);
  const meta: SnapshotMeta = {
    id,
    timestamp: now.toISOString(),
    tier: "daily",
    fileCount: stats.fileCount,
    dataBytes: stats.dataBytes,
    durationMs: Date.now() - start,
  };

  fs.writeFileSync(path.join(dest, "meta.json"), JSON.stringify(meta, null, 2));

  const manifest = loadManifest();
  manifest.snapshots.push(meta);
  saveManifest(manifest);

  return meta;
}

const RETENTION = [
  { maxAgeDays: 30,       intervalDays: 1 },
  { maxAgeDays: 60,       intervalDays: 3 },
  { maxAgeDays: 90,       intervalDays: 7 },
  { maxAgeDays: 365,      intervalDays: 30 },
  { maxAgeDays: 1095,     intervalDays: 91 },
  { maxAgeDays: Infinity, intervalDays: 365 },
];

async function pruneSnapshots(): Promise<string[]> {
  const manifest = loadManifest();
  const now = Date.now();
  const deleted: string[] = [];

  const preRestores = manifest.snapshots
    .filter(s => s.tier === "pre-restore")
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const preRestoreToDelete = preRestores.slice(3);

  const regular = manifest.snapshots
    .filter(s => s.tier !== "pre-restore")
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const keep = new Set<string>();
  let prevMaxAge = 0;

  for (const window of RETENTION) {
    const minMs = prevMaxAge * 86400000;
    const maxMs = window.maxAgeDays === Infinity ? Infinity : window.maxAgeDays * 86400000;
    const intervalMs = window.intervalDays * 86400000;

    const inWindow = regular.filter(s => {
      const age = now - new Date(s.timestamp).getTime();
      return age >= minMs && age < maxMs;
    });

    let lastKeptTime = -Infinity;
    for (const s of inWindow) {
      const t = new Date(s.timestamp).getTime();
      if (t - lastKeptTime >= intervalMs) {
        keep.add(s.id);
        lastKeptTime = t;

        if (window.intervalDays >= 365) s.tier = "yearly";
        else if (window.intervalDays >= 91) s.tier = "quarterly";
        else if (window.intervalDays >= 30) s.tier = "monthly";
        else if (window.intervalDays >= 7) s.tier = "weekly";
        else if (window.intervalDays >= 3) s.tier = "tri-daily";
        else s.tier = "daily";
      }
    }
    prevMaxAge = window.maxAgeDays;
  }

  const toDelete = [
    ...regular.filter(s => !keep.has(s.id)),
    ...preRestoreToDelete,
  ];

  for (const s of toDelete) {
    const dir = path.join(BACKUPS_ROOT, s.id);
    if (fs.existsSync(dir)) await fsp.rm(dir, { recursive: true, force: true });
    deleteFromS3(s.id);
    deleted.push(s.id);
  }

  manifest.snapshots = manifest.snapshots.filter(s => !deleted.includes(s.id));
  saveManifest(manifest);
  return deleted;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--list-s3")) {
    console.log(`\n  S3 archives in s3://${S3_BUCKET}/${S3_PREFIX}:`);
    const files = s3List();
    if (files.length === 0) { console.log("  (none)"); return; }
    for (const f of files) console.log(`    ${f}`);
    console.log(`\n  Total: ${files.length} archives\n`);
    return;
  }

  if (args.includes("--list")) {
    const manifest = loadManifest();
    const snapshots = [...manifest.snapshots].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const s3Files = new Set(s3List());
    if (snapshots.length === 0) {
      console.log("No backups found.");
      return;
    }
    console.log(`\n  ${"ID".padEnd(24)} ${"Tier".padEnd(12)} ${"Size".padEnd(10)} ${"Files".padEnd(8)} ${"S3".padEnd(4)} Timestamp`);
    console.log("  " + "-".repeat(90));
    for (const s of snapshots) {
      const inS3 = s3Files.has(`${s.id}.zip`) ? "Y" : "-";
      console.log(`  ${s.id.padEnd(24)} ${s.tier.padEnd(12)} ${formatBytes(s.dataBytes).padEnd(10)} ${String(s.fileCount).padEnd(8)} ${inS3.padEnd(4)} ${s.timestamp}`);
    }
    console.log(`\n  Total: ${snapshots.length} snapshots (${Array.from(s3Files).length} on S3)\n`);
    return;
  }

  if (args.includes("--prune")) {
    console.log("Pruning old snapshots...");
    const deleted = await pruneSnapshots();
    console.log(`Pruned ${deleted.length} snapshot(s).`);
    if (deleted.length > 0) console.log(`  Deleted: ${deleted.join(", ")}`);
    return;
  }

  // Default: prune old → create new → S3 sync
  // Prune BEFORE creating so the new snapshot can't be accidentally deleted.
  console.log(`SecondBrain backup starting at ${new Date().toISOString()}`);
  console.log(`  Data dir: ${DATA_DIR}`);
  console.log(`  Backups:  ${BACKUPS_ROOT}`);
  console.log(`  S3:       s3://${S3_BUCKET}/${S3_PREFIX}`);

  // 1. Prune old snapshots first
  const pruned = await pruneSnapshots();
  if (pruned.length > 0) {
    console.log(`  Pruned ${pruned.length} old snapshot(s) (local + S3)`);
  }

  // 2. Clean test-restore dirs
  if (fs.existsSync(BACKUPS_ROOT)) {
    const entries = await fsp.readdir(BACKUPS_ROOT);
    for (const entry of entries) {
      if (entry.startsWith("_test-restore-")) {
        await fsp.rm(path.join(BACKUPS_ROOT, entry), { recursive: true, force: true });
      }
    }
  }

  // 3. Create new snapshot
  const meta = await createSnapshot();
  console.log(`  Snapshot created: ${meta.id}`);
  console.log(`    Files: ${meta.fileCount}, Size: ${formatBytes(meta.dataBytes)}, Duration: ${meta.durationMs}ms`);

  // 4. Compress + upload to S3
  try {
    console.log("  Uploading to S3...");
    const { archiveSize } = await syncToS3(meta.id);
    console.log(`    Uploaded: ${formatBytes(archiveSize)} compressed`);
  } catch (e: any) {
    console.error(`  S3 upload failed (local backup still safe): ${e.message}`);
  }

  // 5. Sync manifest to S3
  try {
    s3Upload(MANIFEST_PATH, "manifest.json");
  } catch { /* best-effort */ }

  console.log("Backup complete.");
}

main().catch(err => {
  console.error("Backup failed:", err);
  process.exit(1);
});
