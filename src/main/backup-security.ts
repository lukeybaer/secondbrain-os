import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

export type BackupSecuritySensitivity = 'none_detected' | 'sensitive' | 'encrypted_sensitive';
export type BackupOffsiteEncryptionStatus = 'encrypted' | 'unknown' | 'not_configured' | 'unavailable';

export interface BackupSecurityReport {
  id: string;
  hasConfig: boolean;
  hasEncryptedPiiVault: boolean;
  sensitivePaths: string[];
  sensitivity: BackupSecuritySensitivity;
  localProtection: 'local_filesystem';
  offsiteEncryption: BackupOffsiteEncryptionStatus;
  warnings: string[];
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function collectSensitivePaths(snapshotRoot: string): Promise<string[]> {
  const candidates = [
    'config.json',
    path.join('data', 'vault'),
    path.join('data', 'sms'),
    path.join('data', 'whatsapp-web'),
    path.join('data', 'conversations'),
    path.join('data', 'contacts'),
  ];
  const found: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(path.join(snapshotRoot, candidate))) {
      found.push(candidate.replace(/\\/g, '/'));
    }
  }
  return found;
}

function getS3EncryptionStatus(id: string): BackupOffsiteEncryptionStatus {
  const bucket = process.env.SECONDBRAIN_BACKUP_BUCKET;
  if (!bucket) return 'not_configured';
  try {
    const raw = execFileSync(
      'aws',
      [
        's3api',
        'head-object',
        '--bucket',
        bucket,
        '--key',
        `snapshots/${id}.zip`,
        '--query',
        'ServerSideEncryption',
        '--output',
        'text',
      ],
      { encoding: 'utf-8', timeout: 15000, maxBuffer: 1024 * 1024 },
    ).trim();
    return raw && raw !== 'None' ? 'encrypted' : 'unknown';
  } catch {
    return 'unavailable';
  }
}

export async function getBackupSecurityReport(snapshotRoot: string, id = path.basename(snapshotRoot)): Promise<BackupSecurityReport> {
  const configPath = path.join(snapshotRoot, 'config.json');
  const encryptedPiiPath = path.join(snapshotRoot, 'data', 'vault', 'pii.encrypted.json');
  const hasConfig = await pathExists(configPath);
  const hasEncryptedPiiVault = await pathExists(encryptedPiiPath);
  const sensitivePaths = await collectSensitivePaths(snapshotRoot);
  const warnings: string[] = [];

  if (hasConfig) {
    warnings.push('config.json is included and may contain secrets.');
  }
  if (sensitivePaths.length > 0 && !hasEncryptedPiiVault) {
    warnings.push('Sensitive-looking paths are present without a recognized encrypted PII vault.');
  }

  const sensitivity: BackupSecuritySensitivity =
    sensitivePaths.length === 0 ? 'none_detected' : hasEncryptedPiiVault ? 'encrypted_sensitive' : 'sensitive';

  const offsiteEncryption = getS3EncryptionStatus(id);
  if (offsiteEncryption === 'unknown') {
    warnings.push('S3 archive encryption could not be confirmed from AWS metadata.');
  }

  return {
    id,
    hasConfig,
    hasEncryptedPiiVault,
    sensitivePaths,
    sensitivity,
    localProtection: 'local_filesystem',
    offsiteEncryption,
    warnings,
  };
}
