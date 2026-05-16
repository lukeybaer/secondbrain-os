import { execFileSync } from 'child_process';
import type { SnapshotMeta } from './backups';

export type BackupS3Availability = 'available' | 'unavailable' | 'not_configured';
export type BackupS3ArchiveStatus = 'synced' | 'missing' | 'unknown';

export interface BackupS3SnapshotStatus {
  id: string;
  archiveKey: string;
  status: BackupS3ArchiveStatus;
}

export interface BackupS3StatusReport {
  availability: BackupS3Availability;
  bucket?: string;
  prefix: string;
  snapshots: BackupS3SnapshotStatus[];
  summary: {
    localSnapshots: number;
    s3Archives: number;
    missingFromS3: number;
    s3Unreachable: boolean;
  };
  error?: string;
}

function listArchiveKeys(bucket: string, prefix: string): string[] {
  const raw = execFileSync(
    'aws',
    ['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix, '--query', 'Contents[].Key', '--output', 'json'],
    { encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw || '[]');
  return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : [];
}

export function getBackupS3Status(snapshots: SnapshotMeta[]): BackupS3StatusReport {
  const bucket = process.env.SECONDBRAIN_BACKUP_BUCKET;
  const prefix = 'snapshots/';
  if (!bucket) {
    return {
      availability: 'not_configured',
      prefix,
      snapshots: snapshots.map((snapshot) => ({
        id: snapshot.id,
        archiveKey: `${prefix}${snapshot.id}.zip`,
        status: 'unknown',
      })),
      summary: {
        localSnapshots: snapshots.length,
        s3Archives: 0,
        missingFromS3: 0,
        s3Unreachable: false,
      },
    };
  }

  try {
    const archiveKeys = new Set(listArchiveKeys(bucket, prefix));
    const perSnapshot = snapshots.map((snapshot) => {
      const archiveKey = `${prefix}${snapshot.id}.zip`;
      return {
        id: snapshot.id,
        archiveKey,
        status: archiveKeys.has(archiveKey) ? 'synced' : 'missing',
      } satisfies BackupS3SnapshotStatus;
    });
    return {
      availability: 'available',
      bucket,
      prefix,
      snapshots: perSnapshot,
      summary: {
        localSnapshots: snapshots.length,
        s3Archives: archiveKeys.size,
        missingFromS3: perSnapshot.filter((snapshot) => snapshot.status === 'missing').length,
        s3Unreachable: false,
      },
    };
  } catch (error: any) {
    return {
      availability: 'unavailable',
      bucket,
      prefix,
      snapshots: snapshots.map((snapshot) => ({
        id: snapshot.id,
        archiveKey: `${prefix}${snapshot.id}.zip`,
        status: 'unknown',
      })),
      summary: {
        localSnapshots: snapshots.length,
        s3Archives: 0,
        missingFromS3: 0,
        s3Unreachable: true,
      },
      error: error?.message ?? String(error),
    };
  }
}
