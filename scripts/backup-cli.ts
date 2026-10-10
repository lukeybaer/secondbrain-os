#!/usr/bin/env npx ts-node
// backup-cli.ts
// Standalone backup script for Windows Task Scheduler.
//
// Usage:
//   npx ts-node scripts/backup-cli.ts                  # daily backup + prune
//   npx ts-node scripts/backup-cli.ts --list            # list all snapshots
//   npx ts-node scripts/backup-cli.ts --prune           # prune only (no new snapshot)
//   npx ts-node scripts/backup-cli.ts --reconcile-s3    # read-only: list snapshots/ objects not in the manifest
//
// This script re-implements the core logic without Electron's `app` module,
// using the known %APPDATA%\secondbrain path directly.

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database: any = require('better-sqlite3');

// ── S3 Configuration ─────────────────────────────────────────────────────────

const S3_BUCKET = process.env.SECONDBRAIN_BACKUP_BUCKET || (() => { throw new Error('SECONDBRAIN_BACKUP_BUCKET env var not set'); })();
const S3_PREFIX = 'snapshots/'; // all archives under snapshots/

// ── Paths (mirror backups.ts but without Electron app module) ────────────────

const USER_DATA = path.join(process.env.APPDATA || '', 'secondbrain');
const BACKUPS_ROOT = path.join(USER_DATA, 'backups');
const DATA_DIR = path.join(USER_DATA, 'data');
const CONFIG_PATH = path.join(USER_DATA, 'config.json');
const MANIFEST_PATH = path.join(BACKUPS_ROOT, 'manifest.json');

// ── Types (duplicated to avoid Electron imports) ─────────────────────────────

type BackupTier =
  | 'daily'
  | 'tri-daily'
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly'
  | 'pre-restore';

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

/** Windows tools (PowerShell's Set-Content) prepend a UTF-8 BOM that JSON.parse rejects. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Read the snapshot manifest.
 *
 * A MISSING manifest legitimately means "start fresh". A manifest that exists
 * but cannot be read does not, and the old catch-all treated them the same.
 * That is a data-integrity hazard, not a convenience: an unreadable manifest
 * became an empty one, so --sync-orphaned reported "S3 parity OK" while a
 * snapshot was missing from S3, and the next createSnapshot would have saved a
 * manifest containing only its own entry, erasing the record of every prior
 * snapshot. Hit for real on 2026-09-16, when a manifest rewritten by Windows
 * PowerShell carried a UTF-8 BOM (ef bb bf) that JSON.parse rejects.
 *
 * So: strip a BOM, and refuse to guess when the file is there but unusable.
 */
function loadManifest(): BackupManifest {
  if (!fs.existsSync(MANIFEST_PATH)) return { version: 1, snapshots: [] };
  let parsed: any;
  try {
    parsed = JSON.parse(stripBom(fs.readFileSync(MANIFEST_PATH, 'utf-8')));
  } catch (err: any) {
    throw new Error(
      `backup manifest at ${MANIFEST_PATH} exists but could not be parsed (${err && err.message}). ` +
        'Refusing to continue with an empty manifest, which would drop the record of every existing snapshot.',
    );
  }
  if (!parsed || !Array.isArray(parsed.snapshots)) {
    throw new Error(
      `backup manifest at ${MANIFEST_PATH} has no snapshots array. ` +
        'Refusing to continue with an empty manifest, which would drop the record of every existing snapshot.',
    );
  }
  return parsed as BackupManifest;
}

function saveManifest(m: BackupManifest): void {
  fs.mkdirSync(BACKUPS_ROOT, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

// Paths we NEVER back up — transient, large, rebuildable browser cache that
// Chromium (whatsapp-web.js, puppeteer) keeps locked while the app is running.
// Backing these up is both pointless (regenerated on next launch) and fatal
// (EBUSY on sqldb0 killed nightly backups Apr 8-11 2026 until excluded).
//
// Also excludes data/studio/recordings/ — large media files (5 GB+) that are
// the original raw assets, not derived state. Excluded per ExampleCo's 2026-04-16
// directive: not backed up locally, not uploaded to S3. Daily storage was
// growing ~10 GB/day from the recordings dir alone.
const COPY_EXCLUDE_PATTERNS: RegExp[] = [
  /[\\/]whatsapp-web[\\/][^\\/]+[\\/]Default[\\/]Cache([\\/]|$)/i,
  /[\\/]whatsapp-web[\\/][^\\/]+[\\/]Default[\\/]Code Cache([\\/]|$)/i,
  /[\\/]whatsapp-web[\\/][^\\/]+[\\/]Default[\\/]GPUCache([\\/]|$)/i,
  /[\\/]whatsapp-web[\\/][^\\/]+[\\/]Default[\\/]Service Worker[\\/]CacheStorage([\\/]|$)/i,
  /[\\/]whatsapp-web[\\/][^\\/]+[\\/]Default[\\/]DawnCache([\\/]|$)/i,
  /[\\/]whatsapp-web[\\/][^\\/]+[\\/]ShaderCache([\\/]|$)/i,
  /[\\/]whatsapp-web[\\/][^\\/]+[\\/]GrShaderCache([\\/]|$)/i,
  /[\\/]studio[\\/]recordings([\\/]|$)/i,
  /[\\/]sms[\\/]raw([\\/]|$)/i,
];

function shouldExcludeFromBackup(fullPath: string): boolean {
  return COPY_EXCLUDE_PATTERNS.some((re) => re.test(fullPath));
}

// Skip-on-lock copy. If a file is held by another process (EBUSY/EPERM/EACCES),
// log a warning and continue so a single locked cache file cannot kill the
// whole backup. Real user data lives outside the excluded browser cache dirs.
let copySkipCount = 0;

// The data directory is LIVE while the backup walks it. Amy's own sessions
// write data/agent/desktop-session-registry/spine-session-<id>.json and its
// sibling .update-lock entries continuously, so any entry named by readdir can
// be gone microseconds later when we recurse or copy it. Treat that as a
// vanished entry to skip, exactly like a locked file, never as a fatal error:
// on 2026-09-16 a single `.update-lock` directory that disappeared mid-walk
// aborted the whole backup with ENOENT from scandir, after the prune step had
// already deleted five S3 snapshots.
const VANISHED_OR_LOCKED = new Set(['ENOENT', 'EBUSY', 'EPERM', 'EACCES']);

function skippableCopyError(err: any): string {
  const code = err && err.code;
  return typeof code === 'string' && VANISHED_OR_LOCKED.has(code) ? code : '';
}

async function copyDir(src: string, dest: string, fsApi: typeof fsp = fsp): Promise<void> {
  if (shouldExcludeFromBackup(src)) return;
  let entries;
  try {
    entries = await fsApi.readdir(src, { withFileTypes: true });
  } catch (err: any) {
    const code = skippableCopyError(err);
    if (!code) throw err;
    copySkipCount++;
    console.warn(`  skip-vanished-dir: ${src} (${code})`);
    return;
  }
  await fsApi.mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (shouldExcludeFromBackup(s)) continue;
    if (entry.isDirectory()) {
      await copyDir(s, d, fsApi);
    } else {
      try {
        await fsApi.copyFile(s, d);
      } catch (err: any) {
        const code = skippableCopyError(err);
        if (code) {
          copySkipCount++;
          console.warn(`  skip-locked: ${s} (${code})`);
          continue;
        }
        throw err;
      }
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
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.(\d{3})Z$/, '_$1');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

// ── S3 Operations ────────────────────────────────────────────────────────────

function s3Upload(localPath: string, s3Key: string): void {
  const winPath = localPath.replace(/\//g, '\\');
  // --no-progress suppresses per-MiB progress lines that flooded execSync's
  // 1 MB default maxBuffer on 11 GB archives (Apr 11 2026 postmortem).
  // maxBuffer set to 10 MB as a defensive ceiling; timeout 90 min per attempt.
  // Retry up to 3 times for SSL EOF drops mid-multipart-upload (seen Apr 2026).
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = execSync(
        `aws s3 cp "${winPath}" "s3://${S3_BUCKET}/${s3Key}" --region us-east-1 --no-progress`,
        {
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          timeout: 90 * 60 * 1000, // 90 minutes
        },
      );
      if (result) console.log(`    S3: ${result.trim()}`);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS) {
        const waitSec = attempt * 30; // 30s, 60s
        console.warn(`    S3 upload attempt ${attempt} failed — retrying in ${waitSec}s: ${(e as Error).message?.slice(0, 120)}`);
        execSync(`ping -n ${waitSec + 1} 127.0.0.1 > nul`, { stdio: 'ignore' });
      }
    }
  }
  throw lastErr;
}

function s3Delete(s3Key: string): void {
  // Failures propagate: pruneSnapshots keeps the manifest entry for retry.
  // `aws s3 rm` on an already-absent key exits 0, so "already gone" is not an error.
  execSync(`aws s3 rm "s3://${S3_BUCKET}/${s3Key}" --region us-east-1`, {
    stdio: 'pipe',
  });
}

/** Strict listing for reconcile: throws instead of returning [] so an outage is never read as "no objects". */
function s3ListStrict(): string[] {
  const out = execSync(`aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}" --region us-east-1`, {
    stdio: 'pipe',
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    // capLocalSnapshots lists S3 before every snapshot; a stalled AWS CLI must
    // fail the list (which skips the cap) rather than hang the whole backup.
    timeout: 2 * 60 * 1000,
  });
  return out
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/).pop() as string);
}

/** Indirection so tests can fake S3 without touching AWS. */
const s3Ops = { del: s3Delete, list: s3ListStrict };

function s3List(): string[] {
  try {
    const out = execSync(`aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}" --region us-east-1`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        return parts[parts.length - 1]; // filename
      });
  } catch {
    return [];
  }
}

/** Absolute path to Windows' bundled bsdtar. Never resolve this through PATH. */
function bsdTarPath(): string {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\Windows';
  return path.join(systemRoot, 'System32', 'tar.exe');
}

/**
 * Compress a snapshot directory to .zip.
 *
 * This used .NET ZipFile.CreateFromDirectory through PowerShell. That API is
 * .NET Framework and obeys the legacy 260-character MAX_PATH limit, and this
 * machine has LongPathsEnabled = 0. The briefing card generations tree nests a
 * 64-character sha directory inside a dated directory and then stores a
 * 64-character sha filename inside it, so its paths run past 270 characters.
 * Measured on 2026-09-16: CreateFromDirectory aborted the whole archive with
 *
 *   Could not find a part of the path '...\briefing-card-generations\2026-08-25
 *   \ai_tech_news\<64 hex>\accepted\<64 hex>.json'   (275 characters)
 *
 * That is why no snapshot reached S3 after 2026-08-10, and why the archives
 * that did reach it are partial: a failed CreateFromDirectory leaves the
 * half-written .zip behind, and syncToS3 skips compression when the archive
 * file already exists, so a later run uploaded the truncated leftover.
 *
 * bsdtar ships as C:\Windows\System32\tar.exe on Windows 10 and later, is
 * backed by libarchive, writes a standard zip, and handles long paths.
 * Verified on 2026-09-16 against a deliberately built 306-character path.
 */
function compressSnapshot(snapshotDir: string, archivePath: string): void {
  const src = snapshotDir;
  const dest = archivePath;
  // A leftover partial archive from an earlier failed attempt must never be
  // mistaken for a finished one, here or by syncToS3's existsSync shortcut.
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  const partial = `${dest}.partial`;
  if (fs.existsSync(partial)) fs.unlinkSync(partial);
  try {
    // Resolve the binary absolutely and never through PATH. Git for Windows
    // ships GNU tar at /usr/bin/tar.exe, which wins the PATH inside Git Bash,
    // cannot write zip at all, and reads a drive letter as a remote host
    // ("Cannot connect to C: resolve failed"). The bsdtar that handles both is
    // the one in System32. execFileSync also keeps cmd.exe out of the quoting.
    // --format zip, never -a. With -a bsdtar infers the format from the file
    // EXTENSION, and the work file ends in .partial, so -a silently fell back
    // to plain tar and produced a tar archive named .zip. That would have
    // broken every restore path, including the Python zip verification in
    // backup-restore-verifier.js, while still listing fine under tar -tf.
    execFileSync(bsdTarPath(), ['--format', 'zip', '-c', '-f', partial, '-C', src, '.'], {
      stdio: 'pipe',
      // The data directory is tens of GB across hundreds of thousands of files.
      // One hour was enough on 2026-09-26 (34 GB) and then timed out on every
      // run from 2026-09-28 to 2026-10-03, so nothing reached S3. Three hours
      // still finishes a 3 AM run before the morning.
      timeout: 3 * 60 * 60 * 1000,
    });
  } catch (err: any) {
    if (fs.existsSync(partial)) fs.unlinkSync(partial);
    const stderr = err && err.stderr ? String(err.stderr) : '';
    throw new Error(
      `tar.exe could not archive ${src}: ${(err && err.message) || err}` +
        (stderr ? ` :: ${stderr.slice(0, 300)}` : ''),
    );
  }
  // Promote to the real archive name only after tar finishes successfully, so
  // a crash can never leave behind something that looks complete.
  fs.renameSync(partial, dest);
}

/** Upload snapshot archive to S3 and sync manifest. */
async function syncToS3(snapshotId: string): Promise<{ archiveSize: number }> {
  const snapshotPath = path.join(BACKUPS_ROOT, snapshotId);
  const archiveName = `${snapshotId}.zip`;
  const archivePath = path.join(BACKUPS_ROOT, archiveName);

  // Always compress. The old "skip if the zip already exists" shortcut was how
  // truncated archives reached S3: a failed compression leaves a partial .zip
  // behind, and the next run treated that leftover as a finished archive and
  // uploaded it. compressSnapshot now removes any leftover and only renames
  // its work into place once tar has exited cleanly.
  compressSnapshot(snapshotPath, archivePath);
  const archiveSize = fs.statSync(archivePath).size;

  // Upload archive
  s3Upload(archivePath, `${S3_PREFIX}${archiveName}`);

  // Upload manifest
  s3Upload(MANIFEST_PATH, 'manifest.json');

  // Clean up local archive (we keep the uncompressed dir for fast local restore)
  fs.unlinkSync(archivePath);

  return { archiveSize };
}

/** Delete a snapshot's archive from S3. */
function deleteFromS3(snapshotId: string): void {
  s3Ops.del(`${S3_PREFIX}${snapshotId}.zip`);
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
    await copyDir(DATA_DIR, path.join(dest, 'data'));
  }

  // SQLite backup
  const dbPath = path.join(DATA_DIR, 'secondbrain.db');
  if (fs.existsSync(dbPath)) {
    try {
      const srcDb = new Database(dbPath, { readonly: true });
      srcDb.pragma('journal_mode = WAL');
      await srcDb.backup(path.join(dest, 'secondbrain.db'));
      srcDb.close();
      // Clean WAL/SHM from copy, replace with clean backup
      for (const suffix of ['-wal', '-shm']) {
        const wal = path.join(dest, 'data', `secondbrain.db${suffix}`);
        if (fs.existsSync(wal)) fs.unlinkSync(wal);
      }
      const dataCopyDb = path.join(dest, 'data', 'secondbrain.db');
      if (fs.existsSync(dataCopyDb)) fs.unlinkSync(dataCopyDb);
      fs.copyFileSync(path.join(dest, 'secondbrain.db'), dataCopyDb);
      fs.unlinkSync(path.join(dest, 'secondbrain.db'));
    } catch (e: any) {
      console.warn(`SQLite backup fallback (file copy used): ${e.message}`);
    }
  }

  // Copy config
  if (fs.existsSync(CONFIG_PATH)) {
    await fsp.copyFile(CONFIG_PATH, path.join(dest, 'config.json'));
  }

  const stats = await dirStats(dest);
  const meta: SnapshotMeta = {
    id,
    timestamp: now.toISOString(),
    tier: 'daily',
    fileCount: stats.fileCount,
    dataBytes: stats.dataBytes,
    durationMs: Date.now() - start,
  };

  fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify(meta, null, 2));

  const manifest = loadManifest();
  manifest.snapshots.push(meta);
  saveManifest(manifest);

  return meta;
}

const RETENTION = [
  { maxAgeDays: 30, intervalDays: 1 },
  { maxAgeDays: 60, intervalDays: 3 },
  { maxAgeDays: 90, intervalDays: 7 },
  { maxAgeDays: 365, intervalDays: 30 },
  { maxAgeDays: 1095, intervalDays: 91 },
  { maxAgeDays: Infinity, intervalDays: 365 },
];

async function pruneSnapshots(): Promise<string[]> {
  const manifest = loadManifest();
  const now = Date.now();
  const deleted: string[] = [];

  const preRestores = manifest.snapshots
    .filter((s) => s.tier === 'pre-restore')
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const preRestoreToDelete = preRestores.slice(3);

  const regular = manifest.snapshots
    .filter((s) => s.tier !== 'pre-restore')
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const keep = new Set<string>();
  let prevMaxAge = 0;

  for (const window of RETENTION) {
    const minMs = prevMaxAge * 86400000;
    const maxMs = window.maxAgeDays === Infinity ? Infinity : window.maxAgeDays * 86400000;
    const intervalMs = window.intervalDays * 86400000;

    const inWindow = regular.filter((s) => {
      const age = now - new Date(s.timestamp).getTime();
      return age >= minMs && age < maxMs;
    });

    let lastKeptTime = -Infinity;
    for (const s of inWindow) {
      const t = new Date(s.timestamp).getTime();
      if (t - lastKeptTime >= intervalMs) {
        keep.add(s.id);
        lastKeptTime = t;

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

  const toDelete = [...regular.filter((s) => !keep.has(s.id)), ...preRestoreToDelete];

  // Prune is skip-on-lock: if Windows Search Indexer / Defender / the live
  // Electron app has a handle on a file inside an old snapshot dir, one stuck
  // directory used to kill the whole run. Now we log and defer — next run will
  // try again. The manifest entry is kept for stuck snapshots so we re-attempt.
  for (const s of toDelete) {
    const dir = path.join(BACKUPS_ROOT, s.id);
    let rmSucceeded = true;
    if (fs.existsSync(dir)) {
      try {
        await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch (err: any) {
        const code = err && err.code;
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
          console.warn(`  skip-prune-locked: ${s.id} (${code}) — will retry next run`);
          rmSucceeded = false;
        } else {
          throw err;
        }
      }
    }
    if (rmSucceeded) {
      try {
        deleteFromS3(s.id);
        deleted.push(s.id);
      } catch (err: any) {
        // A failed remote delete must not drop the manifest entry, or the
        // current S3 version would be untracked forever. Retry next run.
        console.warn(
          `  skip-prune-s3-failed: ${s.id} (${String(err?.message || err).slice(0, 120)}) - kept in manifest, will retry next run`,
        );
      }
    }
  }

  manifest.snapshots = manifest.snapshots.filter((s) => !deleted.includes(s.id));
  saveManifest(manifest);
  return deleted;
}

/**
 * Cap the uncompressed snapshot copies kept on the PC disk.
 *
 * RETENTION above governs which snapshots exist (in S3). It also used to keep
 * every one of them as an uncompressed local directory, which was harmless at
 * 17 MB in April and fatal at 34 GB in September: thirty daily copies is a
 * terabyte. From 2026-09-28 the zip step timed out every night, so nothing
 * reached S3 while each failed run still left a 34 GB directory behind, and on
 * 2026-10-04 the copy itself died with ENOSPC on a full C drive.
 *
 * The S3 zip is the backup. The local directory is only a fast-restore
 * convenience, so only the newest `keep` COMPLETE directories survive. A
 * complete snapshot is one the manifest records and whose meta.json was
 * written; a run that died mid-copy leaves neither, and such a partial must
 * never count toward `keep`, or a newer half-copy would evict the last whole
 * one. Partials are always removed. An older directory whose zip never
 * reached S3 is not recoverable from anywhere else once removed, so its
 * manifest entry goes too (the newer kept snapshot supersedes it). If S3
 * cannot be listed, nothing is touched: without that list we cannot tell a
 * backed-up snapshot from an unbacked one. Callers hold the backup lock.
 */
const LOCAL_SNAPSHOT_DIR_RE = /^\d{8}T\d{6}_\d{3}$/;

async function capLocalSnapshots(keep = 1): Promise<{ removed: string[]; dropped: string[] }> {
  const removed: string[] = [];
  const dropped: string[] = [];
  if (!fs.existsSync(BACKUPS_ROOT)) return { removed, dropped };

  let s3Names: Set<string>;
  try {
    s3Names = new Set(s3Ops.list());
  } catch (err: any) {
    console.warn(`  skip-local-cap: S3 list failed (${String(err?.message || err).slice(0, 120)})`);
    return { removed, dropped };
  }

  const manifest = loadManifest();
  const preRestore = new Set(manifest.snapshots.filter((s) => s.tier === 'pre-restore').map((s) => s.id));
  const recorded = new Set(manifest.snapshots.map((s) => s.id));
  const dirs = fs
    .readdirSync(BACKUPS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && LOCAL_SNAPSHOT_DIR_RE.test(e.name) && !preRestore.has(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  const isComplete = (id: string) => recorded.has(id) && fs.existsSync(path.join(BACKUPS_ROOT, id, 'meta.json'));
  const survivors = new Set(dirs.filter(isComplete).slice(0, keep));

  for (const id of dirs.filter((d) => !survivors.has(d))) {
    try {
      await fsp.rm(path.join(BACKUPS_ROOT, id), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (err: any) {
      console.warn(`  skip-local-cap-locked: ${id} (${err?.code || err}) - will retry next run`);
      continue;
    }
    for (const leftover of [`${id}.zip`, `${id}.zip.partial`]) {
      fs.rmSync(path.join(BACKUPS_ROOT, leftover), { force: true });
    }
    removed.push(id);
    if (recorded.has(id) && !s3Names.has(`${id}.zip`)) dropped.push(id);
  }

  if (dropped.length > 0) {
    manifest.snapshots = manifest.snapshots.filter((s) => !dropped.includes(s.id));
    saveManifest(manifest);
  }
  return { removed, dropped };
}

/**
 * Read-only reconcile: current snapshots/ objects whose id is not in the
 * manifest. Reports only; never deletes.
 */
function reconcileS3(manifestIds: string[], s3Names: string[]): { untracked: string[]; missingFromS3: string[] } {
  const tracked = new Set(manifestIds);
  const present = new Set(s3Names.filter((n) => n.endsWith('.zip')).map((n) => n.slice(0, -4)));
  return {
    untracked: [...present].filter((id) => !tracked.has(id)).sort(),
    missingFromS3: [...tracked].filter((id) => !present.has(id)).sort(),
  };
}

/**
 * Cross-process lock for every mutating backup mode. Exclusive create, so two
 * processes cannot both win. A lock whose owner process is gone, or that is
 * older than any real run could be, is stale and is taken over.
 */
const LOCK_PATH = path.join(BACKUPS_ROOT, '.backup.lock');
const LOCK_STALE_MS = 8 * 60 * 60 * 1000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

function acquireBackupLock(): () => void {
  fs.mkdirSync(BACKUPS_ROOT, { recursive: true });
  const body = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK_PATH, body, { flag: 'wx' });
      return () => {
        try {
          if (fs.readFileSync(LOCK_PATH, 'utf8') === body) fs.unlinkSync(LOCK_PATH);
        } catch {
          /* already gone */
        }
      };
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      let held: { pid?: number; startedAt?: string } = {};
      try {
        held = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
      } catch {
        /* unreadable lock counts as stale */
      }
      const age = Date.now() - new Date(held.startedAt || 0).getTime();
      if (typeof held.pid === 'number' && pidAlive(held.pid) && age < LOCK_STALE_MS) {
        throw new Error(`another backup run (pid ${held.pid}, started ${held.startedAt}) holds ${LOCK_PATH}`);
      }
      // Claim the stale lock by renaming it to a unique name. Rename is atomic,
      // so when two runs both see it stale only one rename succeeds; the loser
      // gets ENOENT and retries, never deleting the winner's fresh lock.
      try {
        fs.renameSync(LOCK_PATH, `${LOCK_PATH}.stale-${process.pid}-${Date.now()}`);
      } catch (renameErr: any) {
        if (renameErr?.code !== 'ENOENT') throw renameErr;
      }
      for (const f of fs.readdirSync(BACKUPS_ROOT)) {
        if (f.startsWith('.backup.lock.stale-')) fs.rmSync(path.join(BACKUPS_ROOT, f), { force: true });
      }
    }
  }
  throw new Error(`could not acquire ${LOCK_PATH}`);
}

function logLocalCap({ removed, dropped }: { removed: string[]; dropped: string[] }): void {
  if (removed.length === 0) return;
  console.log(`  Removed ${removed.length} older local copy/copies: ${removed.join(', ')}`);
  if (dropped.length > 0) console.log(`    Never reached S3, dropped from manifest: ${dropped.join(', ')}`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--list-s3')) {
    console.log(`\n  S3 archives in s3://${S3_BUCKET}/${S3_PREFIX}:`);
    const files = s3List();
    if (files.length === 0) {
      console.log('  (none)');
      return;
    }
    for (const f of files) console.log(`    ${f}`);
    console.log(`\n  Total: ${files.length} archives\n`);
    return;
  }

  if (args.includes('--reconcile-s3')) {
    const manifest = loadManifest();
    const result = reconcileS3(manifest.snapshots.map((x) => x.id), s3Ops.list());
    console.log(JSON.stringify({ readOnly: true, ...result }, null, 2));
    return;
  }

  if (args.includes('--list')) {
    const manifest = loadManifest();
    const snapshots = [...manifest.snapshots].sort((a, b) =>
      b.timestamp.localeCompare(a.timestamp),
    );
    const s3Files = new Set(s3List());
    if (snapshots.length === 0) {
      console.log('No backups found.');
      return;
    }
    console.log(
      `\n  ${'ID'.padEnd(24)} ${'Tier'.padEnd(12)} ${'Size'.padEnd(10)} ${'Files'.padEnd(8)} ${'S3'.padEnd(4)} Timestamp`,
    );
    console.log('  ' + '-'.repeat(90));
    for (const s of snapshots) {
      const inS3 = s3Files.has(`${s.id}.zip`) ? 'Y' : '-';
      console.log(
        `  ${s.id.padEnd(24)} ${s.tier.padEnd(12)} ${formatBytes(s.dataBytes).padEnd(10)} ${String(s.fileCount).padEnd(8)} ${inS3.padEnd(4)} ${s.timestamp}`,
      );
    }
    console.log(`\n  Total: ${snapshots.length} snapshots (${Array.from(s3Files).length} on S3)\n`);
    return;
  }

  // Everything below writes snapshots, the manifest or archives, and the 3 AM
  // run can now last past 4 AM, when health-self-heal starts --sync-orphaned
  // against the same manifest and .zip.partial. One run at a time.
  const releaseLock = acquireBackupLock();
  try {
    await runMutating(args);
  } finally {
    releaseLock();
  }
}

async function runMutating(args: string[]): Promise<void> {
  if (args.includes('--prune')) {
    console.log('Pruning old snapshots...');
    const deleted = await pruneSnapshots();
    console.log(`Pruned ${deleted.length} snapshot(s).`);
    if (deleted.length > 0) console.log(`  Deleted: ${deleted.join(', ')}`);
    return;
  }

  // --sync-orphaned: upload any local snapshots that are missing from S3.
  // Used by health-self-heal.js to retroactively fill S3 gaps after upload
  // failures (e.g. the Apr 9-10 maxBuffer issue). Only syncs the 2 most recent
  // orphans to bound runtime; remaining orphans are low priority.
  if (args.includes('--sync-orphaned')) {
    const manifest = loadManifest();
    const s3Files = new Set(s3List());
    const sorted = [...manifest.snapshots].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const orphans = sorted.filter((s) => !s3Files.has(`${s.id}.zip`));
    if (orphans.length === 0) {
      console.log('S3 parity OK — no orphaned snapshots.');
      return;
    }
    console.log(`Found ${orphans.length} local snapshot(s) missing from S3. Syncing top 2...`);
    let synced = 0;
    let prunedUnrecoverable = 0;
    let skipped = 0;
    const unrecoverableIds: string[] = [];
    for (const snap of orphans.slice(0, 2)) {
      const snapshotDir = path.join(BACKUPS_ROOT, snap.id);
      const snapshotZip = path.join(BACKUPS_ROOT, `${snap.id}.zip`);
      if (!fs.existsSync(snapshotDir) && !fs.existsSync(snapshotZip)) {
        console.warn(`  prune-unrecoverable ${snap.id}: neither dir nor zip found locally (retention-pruned before upload)`);
        unrecoverableIds.push(snap.id);
        prunedUnrecoverable++;
        continue;
      }
      try {
        if (!fs.existsSync(snapshotDir) && fs.existsSync(snapshotZip)) {
          const zipSize = fs.statSync(snapshotZip).size;
          console.log(`  Uploading pre-zipped ${snap.id} (${formatBytes(zipSize)})...`);
          s3Upload(snapshotZip, `${S3_PREFIX}${snap.id}.zip`);
          console.log(`    Done: ${formatBytes(zipSize)} uploaded`);
        } else {
          console.log(`  Syncing ${snap.id} (${formatBytes(snap.dataBytes)})...`);
          const { archiveSize } = await syncToS3(snap.id);
          console.log(`    Done: ${formatBytes(archiveSize)} compressed`);
        }
        synced++;
      } catch (e: any) {
        console.error(`  S3 sync failed for ${snap.id}: ${e.message}`);
        skipped++;
      }
    }
    if (unrecoverableIds.length > 0) {
      const fresh = loadManifest();
      fresh.snapshots = fresh.snapshots.filter((s) => !unrecoverableIds.includes(s.id));
      saveManifest(fresh);
      console.log(`  Removed ${unrecoverableIds.length} unrecoverable entry/entries from manifest: ${unrecoverableIds.join(', ')}`);
    }
    try {
      s3Upload(MANIFEST_PATH, 'manifest.json');
    } catch {
      /* best-effort */
    }
    console.log(`Orphan sync complete: ${synced} uploaded, ${prunedUnrecoverable} pruned unrecoverable, ${skipped} failed.`);
    if (synced === 0 && prunedUnrecoverable === 0) {
      process.exitCode = 2;
    }
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
      if (entry.startsWith('_test-restore-')) {
        await fsp.rm(path.join(BACKUPS_ROOT, entry), { recursive: true, force: true });
      }
    }
  }

  // 2b. Free the disk before copying: at most one older local copy survives
  // while today's is written, so the PC never holds more than two.
  logLocalCap(await capLocalSnapshots(1));

  // 3. Create new snapshot
  const meta = await createSnapshot();
  console.log(`  Snapshot created: ${meta.id}`);
  console.log(
    `    Files: ${meta.fileCount}, Size: ${formatBytes(meta.dataBytes)}, Duration: ${meta.durationMs}ms`,
  );

  // 4. Compress + upload to S3.
  //
  // This used to swallow the failure, log "local backup still safe", and let
  // main() go on to print "Backup complete." and exit 0. That is how the
  // backup stayed dead from 2026-08-10 to 2026-09-16 without anyone noticing:
  // the only thing that ever noticed was the System Health row reading the age
  // of the newest S3 object, weeks later. A snapshot that did not reach S3 is
  // not a backup, so the run now fails loudly and returns a non-zero exit.
  console.log('  Uploading to S3...');
  const { archiveSize } = await syncToS3(meta.id);
  console.log(`    Uploaded: ${formatBytes(archiveSize)} compressed`);

  // 4b. Today's zip is in S3, so the older local copy is no longer needed.
  logLocalCap(await capLocalSnapshots(1));

  // 5. Sync manifest to S3
  try {
    s3Upload(MANIFEST_PATH, 'manifest.json');
  } catch {
    /* best-effort */
  }

  console.log('Backup complete.');
}

// Exported for the regression suite. The CLI behaviour is unchanged: this file
// still runs the backup when it is the entry point, and only skips that when a
// test requires it for the pure copy-walk helpers.
export { copyDir, skippableCopyError, shouldExcludeFromBackup, compressSnapshot, loadManifest, stripBom, pruneSnapshots, reconcileS3, s3Ops, capLocalSnapshots, acquireBackupLock };

if (require.main === module) {
  main().catch((err) => {
    console.error('Backup failed:', err);
    process.exit(1);
  });
}
