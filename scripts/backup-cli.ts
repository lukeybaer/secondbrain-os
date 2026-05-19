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

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { execSync } from 'child_process';
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

const ENCRYPTION_ALGORITHM: BackupAlgorithm = 'AES-256-GCM';
const ENCRYPTED_PAYLOAD_DIR = 'payload';
const ENCRYPTED_FILE_MAGIC = 'SBENC1';
const BACKUP_KEY_FILE = '.backup-key';
const BACKUP_KEY_ENV = 'SECONDBRAIN_BACKUP_KEY';
const BACKUP_PASSPHRASE_ENV = 'SECONDBRAIN_BACKUP_PASSPHRASE';
const BACKUP_PASSPHRASE_SALT_ENV = 'SECONDBRAIN_BACKUP_PASSPHRASE_SALT';
const PBKDF2_ITERATIONS = 310_000;

interface BackupKeyInfo {
  key: Buffer;
  keyId: string;
}

interface EncryptedFileHeader {
  version: 1;
  algorithm: BackupAlgorithm;
  iv: string;
  authTag: string;
  plaintextSha256: string;
  plaintextBytes: number;
  keyId: string;
}

interface EncryptedFileIntegrity {
  relativePath: string;
  plaintextSha256: string;
  ciphertextSha256: string;
  plaintextBytes: number;
}

// ── Types (duplicated to avoid Electron imports) ─────────────────────────────

type BackupTier =
  | 'daily'
  | 'tri-daily'
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly'
  | 'pre-restore';

type BackupAlgorithm = 'AES-256-GCM';

interface SnapshotIntegrity {
  plaintextTreeSha256: string;
  ciphertextTreeSha256?: string;
  keyId: string;
}

interface SnapshotMeta {
  id: string;
  timestamp: string;
  tier: BackupTier;
  fileCount: number;
  dataBytes: number;
  durationMs: number;
  encrypted: boolean;
  algorithm?: BackupAlgorithm;
  integrity?: SnapshotIntegrity;
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
      return normalizeManifest(JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')));
    }
  } catch {
    /* start fresh */
  }
  return { version: 1, snapshots: [] };
}

function saveManifest(m: BackupManifest): void {
  fs.mkdirSync(BACKUPS_ROOT, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(normalizeManifest(m), null, 2));
}

function redactSecrets(input: string): string {
  return input
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, 'AWS_[REDACTED]')
    .replace(
      /\b(api[_-]?key|token|secret|password|passwd|pwd|authorization|bearer)\b\s*[:=]\s*["']?[^"',\s)]+/gi,
      '$1=[REDACTED]',
    )
    .replace(/secondbrain-backend-key\.pem/gi, '[SSH_KEY]');
}

function redactForManifest(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return redactSecrets(value).slice(0, 500);
}

function redactForLog(value: unknown): string {
  return redactSecrets(String(value ?? ''));
}

function safeLogPath(fullPath: string): string {
  const candidates: Array<[string, string]> = [
    ['data', DATA_DIR],
    ['backups', BACKUPS_ROOT],
    ['userData', USER_DATA],
  ];
  for (const [label, root] of candidates) {
    const rel = path.relative(root, fullPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return `${label}/${rel.replace(/\\/g, '/')}`;
    }
  }
  return path.basename(fullPath);
}

function normalizeSnapshotMeta(raw: any): SnapshotMeta {
  const encrypted = raw?.encrypted === true || raw?.algorithm === ENCRYPTION_ALGORITHM;
  const meta: SnapshotMeta = {
    id: String(raw?.id ?? ''),
    timestamp: String(raw?.timestamp ?? new Date(0).toISOString()),
    tier: (raw?.tier ?? 'daily') as BackupTier,
    fileCount: Number(raw?.fileCount ?? 0),
    dataBytes: Number(raw?.dataBytes ?? 0),
    durationMs: Number(raw?.durationMs ?? 0),
    encrypted,
  };
  if (raw?.algorithm) meta.algorithm = raw.algorithm as BackupAlgorithm;
  if (raw?.integrity && typeof raw.integrity === 'object') {
    meta.integrity = {
      plaintextTreeSha256: String(raw.integrity.plaintextTreeSha256 ?? ''),
      ciphertextTreeSha256: raw.integrity.ciphertextTreeSha256
        ? String(raw.integrity.ciphertextTreeSha256)
        : undefined,
      keyId: String(raw.integrity.keyId ?? ''),
    };
  }
  const note = redactForManifest(raw?.note);
  if (note) meta.note = note;
  return meta;
}

function normalizeManifest(raw: any): BackupManifest {
  return {
    version: 1,
    snapshots: Array.isArray(raw?.snapshots)
      ? raw.snapshots.map(normalizeSnapshotMeta).filter((s) => s.id)
      : [],
  };
}

function backupKeyId(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function decodeBackupKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const base64 = Buffer.from(trimmed, 'base64');
  if (base64.length === 32) return base64;
  return crypto.createHash('sha256').update(trimmed, 'utf8').digest();
}

function loadBackupKey(opts?: { createIfMissing?: boolean }): BackupKeyInfo {
  const envKey = process.env[BACKUP_KEY_ENV];
  if (envKey) {
    const key = decodeBackupKey(envKey);
    return { key, keyId: backupKeyId(key) };
  }

  const passphrase = process.env[BACKUP_PASSPHRASE_ENV];
  if (passphrase) {
    const salt = process.env[BACKUP_PASSPHRASE_SALT_ENV] ?? 'secondbrain-backup-v1';
    const key = crypto.pbkdf2Sync(
      passphrase,
      salt,
      PBKDF2_ITERATIONS,
      32,
      'sha256',
    );
    return { key, keyId: backupKeyId(key) };
  }

  const keyPath = path.join(BACKUPS_ROOT, BACKUP_KEY_FILE);
  if (fs.existsSync(keyPath)) {
    const key = decodeBackupKey(fs.readFileSync(keyPath, 'utf-8'));
    if (key.length !== 32) throw new Error('Backup encryption key is invalid');
    return { key, keyId: backupKeyId(key) };
  }

  if (!opts?.createIfMissing) {
    throw new Error(
      `Backup encryption key missing. Restore requires ${BACKUP_KEY_ENV}, ${BACKUP_PASSPHRASE_ENV}, or ${safeLogPath(keyPath)}.`,
    );
  }

  fs.mkdirSync(BACKUPS_ROOT, { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, `${key.toString('base64')}\n`, { mode: 0o600 });
  return { key, keyId: backupKeyId(key) };
}

function normalizeRelativePath(relativePath: string): string {
  const clean = relativePath.replace(/\\/g, '/');
  if (
    clean.length === 0 ||
    clean.includes('\0') ||
    clean.startsWith('/') ||
    /^[a-zA-Z]:/.test(clean) ||
    clean.split('/').some((part) => part === '..')
  ) {
    throw new Error(`Unsafe snapshot path: ${redactForLog(relativePath)}`);
  }
  return clean
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');
}

function payloadRelative(root: string, fullPath: string): string {
  return normalizeRelativePath(path.relative(root, fullPath).replace(/\\/g, '/'));
}

function fileAad(snapshotId: string, relativePath: string): Buffer {
  return Buffer.from(
    `secondbrain-backup-file:v1:${snapshotId}:${normalizeRelativePath(relativePath)}`,
    'utf-8',
  );
}

function hashTransform(hash: crypto.Hash, counter?: { bytes: number }): Transform {
  return new Transform({
    transform(chunk, _encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buf);
      if (counter) counter.bytes += buf.length;
      callback(null, chunk);
    },
  });
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function encryptFile(
  src: string,
  dest: string,
  relativePath: string,
  snapshotId: string,
  keyInfo: BackupKeyInfo,
): Promise<EncryptedFileIntegrity> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const bodyPath = `${dest}.cipher-${process.pid}-${Date.now()}`;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyInfo.key, iv);
  cipher.setAAD(fileAad(snapshotId, relativePath));

  const plaintextHash = crypto.createHash('sha256');
  const counter = { bytes: 0 };
  try {
    await pipeline(
      fs.createReadStream(src),
      hashTransform(plaintextHash, counter),
      cipher,
      fs.createWriteStream(bodyPath, { mode: 0o600 }),
    );

    const header: EncryptedFileHeader = {
      version: 1,
      algorithm: ENCRYPTION_ALGORITHM,
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      plaintextSha256: plaintextHash.digest('hex'),
      plaintextBytes: counter.bytes,
      keyId: keyInfo.keyId,
    };
    await fsp.writeFile(
      dest,
      `${ENCRYPTED_FILE_MAGIC}:${Buffer.from(JSON.stringify(header)).toString('base64')}\n`,
      { mode: 0o600 },
    );
    await pipeline(fs.createReadStream(bodyPath), fs.createWriteStream(dest, { flags: 'a' }));
    return {
      relativePath,
      plaintextSha256: header.plaintextSha256,
      ciphertextSha256: await sha256File(dest),
      plaintextBytes: header.plaintextBytes,
    };
  } finally {
    if (fs.existsSync(bodyPath)) await fsp.rm(bodyPath, { force: true });
  }
}

async function encryptPayloadDir(
  srcRoot: string,
  destRoot: string,
  snapshotId: string,
): Promise<{ fileCount: number; dataBytes: number; integrity: SnapshotIntegrity }> {
  const keyInfo = loadBackupKey({ createIfMissing: true });
  const plaintextTree = crypto.createHash('sha256');
  const ciphertextTree = crypto.createHash('sha256');
  let fileCount = 0;
  let dataBytes = 0;

  async function walk(srcDir: string): Promise<void> {
    const relDir = path.relative(srcRoot, srcDir).replace(/\\/g, '/');
    const destDir = relDir ? path.join(destRoot, relDir) : destRoot;
    await fsp.mkdir(destDir, { recursive: true });
    if (relDir) plaintextTree.update(`dir:${normalizeRelativePath(relDir)}\n`);

    const entries = (await fsp.readdir(srcDir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const src = path.join(srcDir, entry.name);
      const rel = payloadRelative(srcRoot, src);
      const dest = path.join(destRoot, rel);
      if (entry.isDirectory()) {
        await walk(src);
      } else {
        const result = await encryptFile(src, dest, rel, snapshotId, keyInfo);
        fileCount++;
        dataBytes += result.plaintextBytes;
        plaintextTree.update(
          `file:${result.relativePath}:${result.plaintextBytes}:${result.plaintextSha256}\n`,
        );
        ciphertextTree.update(`file:${result.relativePath}:${result.ciphertextSha256}\n`);
      }
    }
  }

  await walk(srcRoot);
  return {
    fileCount,
    dataBytes,
    integrity: {
      plaintextTreeSha256: plaintextTree.digest('hex'),
      ciphertextTreeSha256: ciphertextTree.digest('hex'),
      keyId: keyInfo.keyId,
    },
  };
}

// Paths we NEVER back up — transient, large, rebuildable browser cache that
// Chromium (whatsapp-web.js, puppeteer) keeps locked while the app is running.
// Backing these up is both pointless (regenerated on next launch) and fatal
// (EBUSY on sqldb0 killed nightly backups Apr 8-11 2026 until excluded).
//
// Also excludes data/studio/recordings/ — large media files (5 GB+) that are
// the original raw assets, not derived state. Excluded per Luke's 2026-04-16
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
async function copyDir(src: string, dest: string): Promise<void> {
  if (shouldExcludeFromBackup(src)) return;
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (shouldExcludeFromBackup(s)) continue;
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else {
      try {
        await fsp.copyFile(s, d);
      } catch (err: any) {
        const code = err && err.code;
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
          copySkipCount++;
          console.warn(`  skip-locked: ${safeLogPath(s)} (${code})`);
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
        console.warn(`    S3 upload attempt ${attempt} failed - retrying in ${waitSec}s: ${redactForLog((e as Error).message).slice(0, 120)}`);
        execSync(`ping -n ${waitSec + 1} 127.0.0.1 > nul`, { stdio: 'ignore' });
      }
    }
  }
  throw lastErr;
}

function s3Delete(s3Key: string): void {
  try {
    execSync(`aws s3 rm "s3://${S3_BUCKET}/${s3Key}" --region us-east-1`, {
      stdio: 'pipe',
    });
  } catch {
    /* best-effort — file may already be gone */
  }
}

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

/** Compress a snapshot directory to .zip using .NET ZipFile (fast, no deps). */
function compressSnapshot(snapshotDir: string, archivePath: string): void {
  const src = snapshotDir.replace(/\//g, '\\');
  const dest = archivePath.replace(/\//g, '\\');
  // .NET ZipFile.CreateFromDirectory is 10-50x faster than Compress-Archive
  execSync(
    `powershell.exe -NoProfile -Command "Add-Type -Assembly System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${src}', '${dest}')"`,
    { stdio: 'pipe', timeout: 1200000 }, // 20min — large snapshots (5GB+) need more time
  );
}

/** Upload snapshot archive to S3 and sync manifest. */
async function syncToS3(snapshotId: string): Promise<{ archiveSize: number }> {
  const snapshotPath = path.join(BACKUPS_ROOT, snapshotId);
  const archiveName = `${snapshotId}.zip`;
  const archivePath = path.join(BACKUPS_ROOT, archiveName);

  // Compress (skip if zip already exists from a prior interrupted attempt)
  if (!fs.existsSync(archivePath)) {
    compressSnapshot(snapshotPath, archivePath);
  }
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
  s3Delete(`${S3_PREFIX}${snapshotId}.zip`);
}

// ── Core ─────────────────────────────────────────────────────────────────────

async function createSnapshot(): Promise<SnapshotMeta> {
  const start = Date.now();
  const now = new Date();
  const id = toSlug(now);
  const dest = path.join(BACKUPS_ROOT, id);
  const staging = path.join(BACKUPS_ROOT, `_staging-${id}`);

  if (fs.existsSync(dest)) await fsp.rm(dest, { recursive: true, force: true });
  if (fs.existsSync(staging)) await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(dest, { recursive: true });
  await fsp.mkdir(staging, { recursive: true });

  try {
  // Copy data directory
  if (fs.existsSync(DATA_DIR)) {
    await copyDir(DATA_DIR, path.join(staging, 'data'));
  }

  // SQLite backup
  const dbPath = path.join(DATA_DIR, 'secondbrain.db');
  if (fs.existsSync(dbPath)) {
    try {
      const srcDb = new Database(dbPath, { readonly: true });
      srcDb.pragma('journal_mode = WAL');
      await srcDb.backup(path.join(staging, 'secondbrain.db'));
      srcDb.close();
      // Clean WAL/SHM from copy, replace with clean backup
      for (const suffix of ['-wal', '-shm']) {
        const wal = path.join(staging, 'data', `secondbrain.db${suffix}`);
        if (fs.existsSync(wal)) fs.unlinkSync(wal);
      }
      const dataCopyDb = path.join(staging, 'data', 'secondbrain.db');
      if (fs.existsSync(dataCopyDb)) fs.unlinkSync(dataCopyDb);
      fs.copyFileSync(path.join(staging, 'secondbrain.db'), dataCopyDb);
      fs.unlinkSync(path.join(staging, 'secondbrain.db'));
    } catch (e: any) {
      console.warn(`SQLite backup fallback (file copy used): ${redactForLog(e.message)}`);
    }
  }

  // Copy config
  if (fs.existsSync(CONFIG_PATH)) {
    await fsp.copyFile(CONFIG_PATH, path.join(staging, 'config.json'));
  }

  const encryptedPayload = await encryptPayloadDir(
    staging,
    path.join(dest, ENCRYPTED_PAYLOAD_DIR),
    id,
  );
  const meta: SnapshotMeta = normalizeSnapshotMeta({
    id,
    timestamp: now.toISOString(),
    tier: 'daily',
    fileCount: encryptedPayload.fileCount,
    dataBytes: encryptedPayload.dataBytes,
    durationMs: Date.now() - start,
    encrypted: true,
    algorithm: ENCRYPTION_ALGORITHM,
    integrity: encryptedPayload.integrity,
  });

  fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify(meta, null, 2));

  const manifest = loadManifest();
  manifest.snapshots.push(meta);
  saveManifest(manifest);

  return meta;
  } catch (err) {
    await fsp.rm(dest, { recursive: true, force: true });
    throw err;
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
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
      deleteFromS3(s.id);
      deleted.push(s.id);
    }
  }

  manifest.snapshots = manifest.snapshots.filter((s) => !deleted.includes(s.id));
  saveManifest(manifest);
  return deleted;
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
        console.error(`  S3 sync failed for ${snap.id}: ${redactForLog(e.message)}`);
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
      if (
        entry.startsWith('_test-restore-') ||
        entry.startsWith('_restore-') ||
        entry.startsWith('_staging-')
      ) {
        await fsp.rm(path.join(BACKUPS_ROOT, entry), { recursive: true, force: true });
      }
    }
  }

  // 3. Create new snapshot
  const meta = await createSnapshot();
  console.log(`  Snapshot created: ${meta.id}`);
  console.log(
    `    Files: ${meta.fileCount}, Size: ${formatBytes(meta.dataBytes)}, Duration: ${meta.durationMs}ms`,
  );

  // 4. Compress + upload to S3
  try {
    console.log('  Uploading to S3...');
    const { archiveSize } = await syncToS3(meta.id);
    console.log(`    Uploaded: ${formatBytes(archiveSize)} compressed`);
  } catch (e: any) {
    console.error(`  S3 upload failed (local backup still safe): ${redactForLog(e.message)}`);
  }

  // 5. Sync manifest to S3
  try {
    s3Upload(MANIFEST_PATH, 'manifest.json');
  } catch {
    /* best-effort */
  }

  console.log('Backup complete.');
}

main().catch((err) => {
  console.error('Backup failed:', redactForLog(err?.message ?? err));
  process.exit(1);
});
