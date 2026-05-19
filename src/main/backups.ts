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
// encrypted data/config payload files plus cleartext operational metadata.

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
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

export type BackupAlgorithm = 'AES-256-GCM';

export interface SnapshotIntegrity {
  plaintextTreeSha256: string;
  ciphertextTreeSha256?: string;
  keyId: string;
}

export interface SnapshotMeta {
  id: string; // ISO timestamp slug: 2026-04-04T120000
  timestamp: string; // Full ISO string
  tier: BackupTier;
  fileCount: number;
  dataBytes: number;
  durationMs: number;
  encrypted: boolean;
  algorithm?: BackupAlgorithm;
  integrity?: SnapshotIntegrity;
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

// New snapshots store encrypted file contents under payload/. Metadata stays
// outside the payload so retention/listing can work without the data key.
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

// ── Manifest I/O ─────────────────────────────────────────────────────────────

function loadManifest(): BackupManifest {
  try {
    if (fs.existsSync(manifestPath())) {
      return normalizeManifest(JSON.parse(fs.readFileSync(manifestPath(), 'utf-8')));
    }
  } catch {
    /* corrupt manifest — start fresh */
  }
  return { version: 1, snapshots: [] };
}

function saveManifest(m: BackupManifest): void {
  fs.mkdirSync(backupsRoot(), { recursive: true });
  fs.writeFileSync(manifestPath(), JSON.stringify(normalizeManifest(m), null, 2));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Paths we NEVER back up — must stay in sync with COPY_EXCLUDE_PATTERNS in
// scripts/backup-cli.ts. Drift detector lives at
// src/main/__tests__/backup-cli-hardening.test.ts.
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
    ['data', dataDir()],
    ['backups', backupsRoot()],
    ['userData', userDataDir()],
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

  const keyPath = path.join(backupsRoot(), BACKUP_KEY_FILE);
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

  fs.mkdirSync(backupsRoot(), { recursive: true });
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

function normalizeOptionalSubPath(subPath?: string): string {
  if (!subPath) return '';
  return normalizeRelativePath(subPath);
}

function safeJoin(base: string, subPath?: string): string {
  const clean = normalizeOptionalSubPath(subPath);
  const resolvedBase = path.resolve(base);
  const target = path.resolve(base, clean);
  if (target !== resolvedBase && !target.startsWith(`${resolvedBase}${path.sep}`)) {
    throw new Error(`Unsafe snapshot path: ${redactForLog(subPath)}`);
  }
  return target;
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

function parseEncryptedHeaderLine(line: string): EncryptedFileHeader {
  const prefix = `${ENCRYPTED_FILE_MAGIC}:`;
  if (!line.startsWith(prefix)) throw new Error('Encrypted backup file header missing');
  const header = JSON.parse(Buffer.from(line.slice(prefix.length), 'base64').toString('utf-8'));
  if (header.version !== 1 || header.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error(`Unsupported backup encryption algorithm: ${redactForLog(header.algorithm)}`);
  }
  return header as EncryptedFileHeader;
}

async function readEncryptedHeader(
  filePath: string,
): Promise<{ header: EncryptedFileHeader; headerBytes: number }> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(4096);
    let position = 0;
    while (position < 64 * 1024) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, position);
      if (bytesRead === 0) break;
      const chunk = Buffer.from(buf.subarray(0, bytesRead));
      const newline = chunk.indexOf(10);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        return {
          header: parseEncryptedHeaderLine(Buffer.concat(chunks).toString('utf-8')),
          headerBytes: position + newline + 1,
        };
      }
      chunks.push(chunk);
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  throw new Error(`Encrypted backup file header too large: ${safeLogPath(filePath)}`);
}

function readEncryptedHeaderSync(
  filePath: string,
): { header: EncryptedFileHeader; headerBytes: number } {
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(4096);
    let position = 0;
    while (position < 64 * 1024) {
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, position);
      if (bytesRead === 0) break;
      const chunk = Buffer.from(buf.subarray(0, bytesRead));
      const newline = chunk.indexOf(10);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        return {
          header: parseEncryptedHeaderLine(Buffer.concat(chunks).toString('utf-8')),
          headerBytes: position + newline + 1,
        };
      }
      chunks.push(chunk);
      position += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  throw new Error(`Encrypted backup file header too large: ${safeLogPath(filePath)}`);
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

async function decryptFile(
  src: string,
  dest: string,
  relativePath: string,
  snapshotId: string,
  keyInfo: BackupKeyInfo,
): Promise<void> {
  const { header, headerBytes } = await readEncryptedHeader(src);
  if (header.keyId && header.keyId !== keyInfo.keyId) {
    throw new Error('Backup encryption key does not match this snapshot');
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const decipher = crypto.createDecipheriv(
    ENCRYPTION_ALGORITHM.toLowerCase(),
    keyInfo.key,
    Buffer.from(header.iv, 'base64'),
  );
  decipher.setAAD(fileAad(snapshotId, relativePath));
  decipher.setAuthTag(Buffer.from(header.authTag, 'base64'));

  const plaintextHash = crypto.createHash('sha256');
  const counter = { bytes: 0 };
  await pipeline(
    fs.createReadStream(src, { start: headerBytes }),
    decipher,
    hashTransform(plaintextHash, counter),
    fs.createWriteStream(dest, { mode: 0o600 }),
  );

  if (counter.bytes !== header.plaintextBytes || plaintextHash.digest('hex') !== header.plaintextSha256) {
    throw new Error(`Backup integrity check failed for ${safeLogPath(dest)}`);
  }
}

function decryptFileSync(
  src: string,
  dest: string,
  relativePath: string,
  snapshotId: string,
  keyInfo: BackupKeyInfo,
): void {
  const { header, headerBytes } = readEncryptedHeaderSync(src);
  if (header.keyId && header.keyId !== keyInfo.keyId) {
    throw new Error('Backup encryption key does not match this snapshot');
  }
  const encrypted = fs.readFileSync(src).subarray(headerBytes);
  const decipher = crypto.createDecipheriv(
    ENCRYPTION_ALGORITHM.toLowerCase(),
    keyInfo.key,
    Buffer.from(header.iv, 'base64'),
  );
  decipher.setAAD(fileAad(snapshotId, relativePath));
  decipher.setAuthTag(Buffer.from(header.authTag, 'base64'));
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const hash = crypto.createHash('sha256').update(plain).digest('hex');
  if (plain.length !== header.plaintextBytes || hash !== header.plaintextSha256) {
    throw new Error(`Backup integrity check failed for ${safeLogPath(dest)}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, plain, { mode: 0o600 });
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

async function decryptPayloadDir(snapshotId: string, destRoot: string): Promise<void> {
  const srcRoot = path.join(snapshotDir(snapshotId), ENCRYPTED_PAYLOAD_DIR);
  const keyInfo = loadBackupKey({ createIfMissing: false });

  async function walk(srcDir: string): Promise<void> {
    const relDir = path.relative(srcRoot, srcDir).replace(/\\/g, '/');
    const destDir = relDir ? path.join(destRoot, relDir) : destRoot;
    await fsp.mkdir(destDir, { recursive: true });
    const entries = await fsp.readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const src = path.join(srcDir, entry.name);
      const rel = payloadRelative(srcRoot, src);
      const dest = path.join(destRoot, rel);
      if (entry.isDirectory()) await walk(src);
      else await decryptFile(src, dest, rel, snapshotId, keyInfo);
    }
  }

  await walk(srcRoot);
}

async function copyDirAll(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDirAll(s, d);
    else await fsp.copyFile(s, d);
  }
}

/** Recursively copy a directory. Skips files locked by another process (EBUSY/EPERM). */
async function copyDir(src: string, dest: string, skipped?: string[]): Promise<void> {
  if (shouldExcludeFromBackup(src)) return;
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (shouldExcludeFromBackup(s)) continue;
    if (entry.isDirectory()) {
      await copyDir(s, d, skipped);
    } else {
      try {
        await fsp.copyFile(s, d);
      } catch (err: any) {
        if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') {
          console.warn(`[backup] Skipping locked file: ${safeLogPath(s)} (${err.code})`);
          skipped?.push(s);
        } else {
          throw err;
        }
      }
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
  const staging = path.join(backupsRoot(), `_staging-${id}`);

  // Ensure target doesn't already exist (e.g. two backups in same second)
  if (fs.existsSync(dest)) {
    await rmDir(dest);
  }
  if (fs.existsSync(staging)) {
    await rmDir(staging);
  }
  await fsp.mkdir(dest, { recursive: true });
  await fsp.mkdir(staging, { recursive: true });

  try {
  // 1. Copy data directory
  const srcData = dataDir();
  const skippedFiles: string[] = [];
  if (fs.existsSync(srcData)) {
    await copyDir(srcData, path.join(staging, 'data'), skippedFiles);
    if (skippedFiles.length > 0) {
      console.warn(
        `[backup] Skipped ${skippedFiles.length} locked file(s) — backup is still valid`,
      );
    }
  }

  // 2. SQLite backup (consistent point-in-time copy via .backup API)
  const dbPath = path.join(srcData, 'secondbrain.db');
  if (fs.existsSync(dbPath)) {
    try {
      const srcDb = new Database(dbPath, { readonly: true });
      srcDb.pragma('journal_mode = WAL');
      await srcDb.backup(path.join(staging, 'secondbrain.db'));
      srcDb.close();
      // Remove the copied WAL/SHM from the data copy since we have a clean backup
      for (const suffix of ['-wal', '-shm']) {
        const walCopy = path.join(staging, 'data', `secondbrain.db${suffix}`);
        if (fs.existsSync(walCopy)) fs.unlinkSync(walCopy);
      }
      // Replace the raw data copy's DB with the clean backup
      const dataCopyDb = path.join(staging, 'data', 'secondbrain.db');
      if (fs.existsSync(dataCopyDb)) fs.unlinkSync(dataCopyDb);
      fs.copyFileSync(path.join(staging, 'secondbrain.db'), dataCopyDb);
      fs.unlinkSync(path.join(staging, 'secondbrain.db'));
    } catch {
      // Fallback: the file copy from copyDir is still there
    }
  }

  // 3. Copy config
  if (fs.existsSync(configPath())) {
    await fsp.copyFile(configPath(), path.join(staging, 'config.json'));
  }

  // 4. Neo4j/Graphiti dump (SSH to EC2, dump graph, copy back)
  try {
    const { execSync } = require('child_process');
    const sshKey = path.join(app.getPath('home'), '.ssh', 'secondbrain-backend-key.pem');
    if (fs.existsSync(sshKey)) {
      const graphitiDest = path.join(staging, 'graphiti');
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
    console.warn(`[backup] Neo4j dump skipped: ${redactForLog(e.message).slice(0, 100)}`);
  }

  // 5. Encrypt staged payload. The plaintext staging dir is removed in finally.
  const encryptedPayload = await encryptPayloadDir(
    staging,
    path.join(dest, ENCRYPTED_PAYLOAD_DIR),
    id,
  );

  const meta: SnapshotMeta = normalizeSnapshotMeta({
    id,
    timestamp: now.toISOString(),
    tier,
    fileCount: encryptedPayload.fileCount,
    dataBytes: encryptedPayload.dataBytes,
    durationMs: Date.now() - start,
    encrypted: true,
    algorithm: ENCRYPTION_ALGORITHM,
    integrity: encryptedPayload.integrity,
    note: opts?.note,
  });

  // 5. Write per-snapshot meta
  fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify(meta, null, 2));

  // 6. Update manifest
  const manifest = loadManifest();
  manifest.snapshots.push(meta);
  saveManifest(manifest);

  return meta;
  } catch (err) {
    await rmDir(dest);
    throw err;
  } finally {
    await rmDir(staging);
  }
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

function readSnapshotMeta(id: string): SnapshotMeta | null {
  const fromManifest = getSnapshot(id);
  if (fromManifest) return fromManifest;
  const metaFile = path.join(snapshotDir(id), 'meta.json');
  if (!fs.existsSync(metaFile)) return null;
  try {
    return normalizeSnapshotMeta(JSON.parse(fs.readFileSync(metaFile, 'utf-8')));
  } catch {
    return null;
  }
}

function isEncryptedSnapshot(id: string): boolean {
  const meta = readSnapshotMeta(id);
  return (
    meta?.encrypted === true ||
    fs.existsSync(path.join(snapshotDir(id), ENCRYPTED_PAYLOAD_DIR))
  );
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
  const encrypted = isEncryptedSnapshot(id);
  const root = encrypted
    ? path.join(snapshotDir(id), ENCRYPTED_PAYLOAD_DIR, 'data')
    : path.join(snapshotDir(id), 'data');
  const base = safeJoin(root, subPath);
  if (!fs.existsSync(base)) return null;

  const entries = await fsp.readdir(base, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(base, entry.name);
      let size = 0;
      if (!entry.isDirectory()) {
        if (encrypted) {
          size = (await readEncryptedHeader(full)).header.plaintextBytes;
        } else {
          size = (await fsp.stat(full)).size;
        }
      }
      return { name: entry.name, isDir: entry.isDirectory(), size };
    }),
  );
  return { files };
}

/**
 * Read a specific file from a snapshot (for querying historical state).
 */
export async function readSnapshotFile(id: string, relativePath: string): Promise<string | null> {
  const safeRel = normalizeRelativePath(relativePath);
  const encrypted = isEncryptedSnapshot(id);
  const filePath = encrypted
    ? path.join(snapshotDir(id), ENCRYPTED_PAYLOAD_DIR, 'data', safeRel)
    : safeJoin(path.join(snapshotDir(id), 'data'), safeRel);
  if (!fs.existsSync(filePath)) return null;
  if (!encrypted) return fsp.readFile(filePath, 'utf-8');

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-backup-read-'));
  const tempFile = path.join(tempDir, path.basename(safeRel));
  try {
    await decryptFile(
      filePath,
      tempFile,
      normalizeRelativePath(`data/${safeRel}`),
      id,
      loadBackupKey({ createIfMissing: false }),
    );
    return await fsp.readFile(tempFile, 'utf-8');
  } finally {
    await rmDir(tempDir);
  }
}

/**
 * Query a snapshot's SQLite database.
 */
export function querySnapshotDb(id: string, sql: string): unknown[] | null {
  const encrypted = isEncryptedSnapshot(id);
  let tempDir: string | null = null;
  let dbPath = encrypted
    ? path.join(snapshotDir(id), ENCRYPTED_PAYLOAD_DIR, 'data', 'secondbrain.db')
    : path.join(snapshotDir(id), 'data', 'secondbrain.db');
  if (!fs.existsSync(dbPath)) return null;
  try {
    if (encrypted) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-backup-db-'));
      const tempDb = path.join(tempDir, 'secondbrain.db');
      decryptFileSync(
        dbPath,
        tempDb,
        'data/secondbrain.db',
        id,
        loadBackupKey({ createIfMissing: false }),
      );
      dbPath = tempDb;
    }
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(sql).all();
    db.close();
    return rows;
  } catch (e: any) {
    throw new Error(`Query failed on snapshot ${id}: ${e.message}`);
  } finally {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

// ── Restore ──────────────────────────────────────────────────────────────────

async function extractSnapshotToTemp(snapshotId: string, tempDir: string): Promise<void> {
  const src = snapshotDir(snapshotId);
  if (!fs.existsSync(src)) throw new Error(`Snapshot ${snapshotId} not found`);

  if (isEncryptedSnapshot(snapshotId)) {
    await decryptPayloadDir(snapshotId, tempDir);
    return;
  }

  if (fs.existsSync(path.join(src, 'data'))) {
    await copyDirAll(path.join(src, 'data'), path.join(tempDir, 'data'));
  }
  if (fs.existsSync(path.join(src, 'config.json'))) {
    await fsp.copyFile(path.join(src, 'config.json'), path.join(tempDir, 'config.json'));
  }
  if (fs.existsSync(path.join(src, 'graphiti'))) {
    await copyDirAll(path.join(src, 'graphiti'), path.join(tempDir, 'graphiti'));
  }
}

function assertSafetySnapshotExists(snapshotId: string): void {
  const meta = readSnapshotMeta(snapshotId);
  if (!meta || meta.tier !== 'pre-restore' || !fs.existsSync(snapshotDir(snapshotId))) {
    throw new Error('Pre-restore safety snapshot was not created; aborting restore');
  }
}

/**
 * Test-restore: extracts a snapshot to a temp directory for inspection.
 * Does NOT touch the live data. Returns the temp path.
 */
export async function testRestore(snapshotId: string): Promise<string> {
  const src = snapshotDir(snapshotId);
  if (!fs.existsSync(src)) throw new Error(`Snapshot ${snapshotId} not found`);

  const tempDir = path.join(backupsRoot(), `_test-restore-${snapshotId}`);
  if (fs.existsSync(tempDir)) await rmDir(tempDir);
  await extractSnapshotToTemp(snapshotId, tempDir);
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
  assertSafetySnapshotExists(preRestore.id);

  const restoreTemp = path.join(backupsRoot(), `_restore-${snapshotId}-${Date.now()}`);
  try {
    // 2. Decrypt/extract to a temp dir before touching live data.
    if (fs.existsSync(restoreTemp)) await rmDir(restoreTemp);
    await extractSnapshotToTemp(snapshotId, restoreTemp);

    // 3. Replace live data dir only after the safety snapshot and extraction succeed.
    const liveData = dataDir();
    const snapshotData = path.join(restoreTemp, 'data');
    if (fs.existsSync(liveData)) {
      await rmDir(liveData);
    }
    if (fs.existsSync(snapshotData)) {
      await copyDirAll(snapshotData, liveData);
    }

    // 4. Replace config if present in snapshot.
    const snapshotConfig = path.join(restoreTemp, 'config.json');
    if (fs.existsSync(snapshotConfig)) {
      await fsp.copyFile(snapshotConfig, configPath());
    }

    return { preRestoreId: preRestore.id };
  } finally {
    if (fs.existsSync(restoreTemp)) await rmDir(restoreTemp);
  }
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
  const safety = await createSnapshot({
    tier: 'pre-restore',
    note: `Safety copy before rolling forward to ${target.id}`,
  });
  assertSafetySnapshotExists(safety.id);
  const restoreTemp = path.join(backupsRoot(), `_restore-${target.id}-${Date.now()}`);

  try {
    await extractSnapshotToTemp(target.id, restoreTemp);

    // Replace live data with the pre-restore copy.
    const liveData = dataDir();
    if (fs.existsSync(liveData)) await rmDir(liveData);
    if (fs.existsSync(path.join(restoreTemp, 'data'))) {
      await copyDirAll(path.join(restoreTemp, 'data'), liveData);
    }

    const snapshotConfig = path.join(restoreTemp, 'config.json');
    if (fs.existsSync(snapshotConfig)) {
      await fsp.copyFile(snapshotConfig, configPath());
    }

    return { restoredFromId: target.id };
  } finally {
    if (fs.existsSync(restoreTemp)) await rmDir(restoreTemp);
  }
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
    if (
      entry.startsWith('_test-restore-') ||
      entry.startsWith('_restore-') ||
      entry.startsWith('_staging-')
    ) {
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
