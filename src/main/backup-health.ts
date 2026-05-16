import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { SnapshotMeta } from './backups';

export type BackupIntegrityStatus = 'ok' | 'warning' | 'failed';

export interface BackupIntegrityReport {
  id: string;
  status: BackupIntegrityStatus;
  checks: {
    snapshotDirectory: boolean;
    metaJson: boolean;
    dataDirectory: boolean;
    configJson: boolean;
    sqliteDatabase: boolean;
    fileCountMatches: boolean;
    dataBytesMatches: boolean;
  };
  fileCount: number;
  dataBytes: number;
  expectedFileCount: number;
  expectedDataBytes: number;
  warnings: string[];
  errors: string[];
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function dirStats(dir: string, excludeNames = new Set<string>()): Promise<{ fileCount: number; dataBytes: number }> {
  let fileCount = 0;
  let dataBytes = 0;
  if (!(await pathExists(dir))) return { fileCount, dataBytes };
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (excludeNames.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await dirStats(full);
      fileCount += sub.fileCount;
      dataBytes += sub.dataBytes;
    } else {
      fileCount++;
      const stat = await fsp.stat(full);
      dataBytes += stat.size;
    }
  }
  return { fileCount, dataBytes };
}

function readSnapshotMeta(metaPath: string): SnapshotMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    if (!parsed?.id || typeof parsed.fileCount !== 'number' || typeof parsed.dataBytes !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function canReadSqlite(dbPath: string): boolean {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").all();
    return true;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

export async function verifyBackupIntegrity(
  snapshotRoot: string,
  manifestMeta?: SnapshotMeta | null,
): Promise<BackupIntegrityReport> {
  const id = manifestMeta?.id ?? path.basename(snapshotRoot);
  const warnings: string[] = [];
  const errors: string[] = [];
  const metaPath = path.join(snapshotRoot, 'meta.json');
  const dataPath = path.join(snapshotRoot, 'data');
  const configPath = path.join(snapshotRoot, 'config.json');
  const dbPath = path.join(dataPath, 'secondbrain.db');

  const snapshotDirectory = await pathExists(snapshotRoot);
  if (!snapshotDirectory) {
    errors.push('Snapshot directory is missing.');
  }

  const diskMeta = snapshotDirectory ? readSnapshotMeta(metaPath) : null;
  const metaJson = !!diskMeta;
  if (!metaJson) {
    errors.push('meta.json is missing or unreadable.');
  }

  const dataDirectory = snapshotDirectory && (await pathExists(dataPath));
  if (!dataDirectory) {
    errors.push('data/ directory is missing.');
  }

  const configJson = snapshotDirectory && (await pathExists(configPath));
  if (!configJson) {
    warnings.push('config.json is not included in this snapshot.');
  } else {
    try {
      JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      errors.push('config.json is present but unreadable.');
    }
  }

  const sqliteExists = dataDirectory && (await pathExists(dbPath));
  const sqliteDatabase = sqliteExists ? canReadSqlite(dbPath) : false;
  if (sqliteExists && !sqliteDatabase) {
    errors.push('data/secondbrain.db is present but unreadable or corrupt.');
  } else if (!sqliteExists) {
    warnings.push('data/secondbrain.db is not included in this snapshot.');
  }

  const expected = manifestMeta ?? diskMeta;
  const stats = snapshotDirectory
    ? await dirStats(snapshotRoot, new Set(['meta.json']))
    : { fileCount: 0, dataBytes: 0 };
  const expectedFileCount = expected?.fileCount ?? 0;
  const expectedDataBytes = expected?.dataBytes ?? 0;
  const fileCountMatches = !!expected && stats.fileCount === expectedFileCount;
  const dataBytesMatches = !!expected && stats.dataBytes === expectedDataBytes;

  if (expected && !fileCountMatches) {
    errors.push(`Snapshot file count drifted: expected ${expectedFileCount}, found ${stats.fileCount}.`);
  }
  if (expected && !dataBytesMatches) {
    errors.push(`Snapshot byte total drifted: expected ${expectedDataBytes}, found ${stats.dataBytes}.`);
  }

  const status: BackupIntegrityStatus = errors.length > 0 ? 'failed' : warnings.length > 0 ? 'warning' : 'ok';

  return {
    id,
    status,
    checks: {
      snapshotDirectory,
      metaJson,
      dataDirectory,
      configJson,
      sqliteDatabase,
      fileCountMatches,
      dataBytesMatches,
    },
    fileCount: stats.fileCount,
    dataBytes: stats.dataBytes,
    expectedFileCount,
    expectedDataBytes,
    warnings,
    errors,
  };
}
