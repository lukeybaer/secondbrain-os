'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordOperationEvent } = require('./operation-provenance.js');
const { existingSessionRecordFile, withSessionRecordLock, writeSessionRecord } = require('./desktop-session-registry.js');

const SCHEMA = 'amy.session_archive_receipt.v1';

function runtimeDataDir(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.SECONDBRAIN_DATA_DIR) return path.resolve(process.env.SECONDBRAIN_DATA_DIR);
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'secondbrain', 'data');
  }
  if (fs.existsSync('/opt/secondbrain')) return '/opt/secondbrain/data';
  return path.join(os.homedir(), '.secondbrain', 'data');
}

function archivePaths(sessionId, dataDir) {
  const root = path.join(runtimeDataDir(dataDir), 'agent', 'session-archive');
  return {
    root,
    receipt: path.join(root, 'receipts', `${sessionId}.json`),
    backlog: path.join(root, 'pending.jsonl'),
  };
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function fileProof(file) {
  const stat = fs.statSync(file);
  return {
    path: path.resolve(file),
    sha256: sha256File(file),
    bytes: stat.size,
  };
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readArchiveReceipt(sessionId, { dataDir } = {}) {
  try {
    return JSON.parse(fs.readFileSync(archivePaths(sessionId, dataDir).receipt, 'utf8'));
  } catch {
    return null;
  }
}

function prepareArchiveReceipt(input = {}, options = {}) {
  if (!input.sessionId) throw new Error('session id is required');
  const now = options.now || new Date();
  const transcript = input.transcriptSnapshotPath
    ? { ...fileProof(input.transcriptSnapshotPath), path: path.resolve(input.transcriptPath) }
    : fileProof(input.transcriptPath);
  const metadata = fileProof(input.metaPath);
  const operationId = String(input.operationId || process.env.SB_OPERATION_ID || '');
  const receipt = {
    schema: SCHEMA,
    session_id: String(input.sessionId),
    operation_id: operationId,
    repo: String(input.repo || ''),
    status: 'local_durable',
    prepared_at: now.toISOString(),
    updated_at: now.toISOString(),
    transcript,
    metadata,
    s3: {
      bucket: String(input.bucket || ''),
      transcript_key: String(input.transcriptKey || ''),
      metadata_key: String(input.metaKey || ''),
      transcript_verified: false,
      metadata_verified: false,
    },
    pending_reason: '',
  };
  const paths = archivePaths(receipt.session_id, options.dataDir);
  atomicWriteJson(paths.receipt, receipt);
  reconcileSpineTaskArchivePending(receipt, options);
  try {
    recordOperationEvent(
      {
        operationId: receipt.operation_id || undefined,
        eventType: 'session.archive.prepared',
        surface: 'session-archive',
        sessionId: receipt.session_id,
        status: 'amber',
        receiptPath: paths.receipt,
        receiptSha256: sha256File(paths.receipt),
        details: {
          transcript_sha256: receipt.transcript.sha256,
          metadata_sha256: receipt.metadata.sha256,
          pending: 's3-verification',
        },
      },
      { dataDir: options.dataDir, now },
    );
  } catch {
    // The local durable receipt and archive-pending task state remain canonical.
  }
  return { receipt, receiptPath: paths.receipt };
}

function normalizeHead(head = {}) {
  return {
    sha256: String(head.sha256 || '').toLowerCase(),
    bytes: Number(head.bytes),
  };
}

function completeArchiveReceipt(sessionId, heads = {}, options = {}) {
  const current = readArchiveReceipt(sessionId, options);
  if (!current || current.schema !== SCHEMA) throw new Error('prepared archive receipt not found');
  const transcriptHead = normalizeHead(heads.transcript);
  const metadataHead = normalizeHead(heads.metadata);
  const transcriptVerified =
    transcriptHead.sha256 === current.transcript.sha256 &&
    transcriptHead.bytes === current.transcript.bytes;
  const metadataVerified =
    metadataHead.sha256 === current.metadata.sha256 &&
    metadataHead.bytes === current.metadata.bytes;
  if (!transcriptVerified || !metadataVerified) {
    throw new Error(
      `S3 head verification failed (transcript=${transcriptVerified}, metadata=${metadataVerified})`,
    );
  }
  const now = options.now || new Date();
  const next = {
    ...current,
    status: 'replicated',
    updated_at: now.toISOString(),
    replicated_at: now.toISOString(),
    pending_reason: '',
    s3: {
      ...current.s3,
      transcript_verified: true,
      metadata_verified: true,
      transcript_head: transcriptHead,
      metadata_head: metadataHead,
    },
  };
  atomicWriteJson(archivePaths(sessionId, options.dataDir).receipt, next);
  reconcileSpineTask(next, options);
  try {
    recordOperationEvent(
      {
        operationId: next.operation_id || undefined,
        eventType: 'session.archive.replicated',
        surface: 'session-archive',
        sessionId,
        status: 'green',
        receiptPath: archivePaths(sessionId, options.dataDir).receipt,
        receiptSha256: sha256File(archivePaths(sessionId, options.dataDir).receipt),
        details: {
          transcript_sha256: next.transcript.sha256,
          metadata_sha256: next.metadata.sha256,
          bucket: next.s3.bucket,
          transcript_key: next.s3.transcript_key,
        },
      },
      { dataDir: options.dataDir, now },
    );
  } catch {
    // The receipt remains canonical; Gravity health will expose missing linkage.
  }
  return next;
}

function markArchivePending(sessionId, reason, options = {}) {
  const current = readArchiveReceipt(sessionId, options);
  if (!current || current.schema !== SCHEMA) throw new Error('prepared archive receipt not found');
  const now = options.now || new Date();
  const next = {
    ...current,
    status: 'pending',
    updated_at: now.toISOString(),
    pending_reason: String(reason || 'replication-unverified').slice(0, 1000),
  };
  const paths = archivePaths(sessionId, options.dataDir);
  atomicWriteJson(paths.receipt, next);
  fs.mkdirSync(path.dirname(paths.backlog), { recursive: true });
  fs.appendFileSync(
    paths.backlog,
    `${JSON.stringify({
      schema: SCHEMA,
      session_id: sessionId,
      operation_id: next.operation_id,
      queued_at: now.toISOString(),
      reason: next.pending_reason,
      receipt_path: paths.receipt,
    })}\n`,
    { mode: 0o600 },
  );
  try {
    recordOperationEvent(
      {
        operationId: next.operation_id || undefined,
        eventType: 'session.archive.pending',
        surface: 'session-archive',
        sessionId,
        status: 'amber',
        receiptPath: paths.receipt,
        details: { reason: next.pending_reason },
      },
      { dataDir: options.dataDir, now },
    );
  } catch {
    // Pending receipt and backlog are already durable.
  }
  return next;
}

function isSessionArchiveComplete(sessionId, { dataDir, transcriptPath } = {}) {
  const receipt = readArchiveReceipt(sessionId, { dataDir });
  if (!receipt || receipt.schema !== SCHEMA || receipt.status !== 'replicated') return false;
  if (!receipt.s3?.transcript_verified || !receipt.s3?.metadata_verified) return false;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    return (
      path.resolve(transcriptPath) === path.resolve(receipt.transcript.path) &&
      sha256File(transcriptPath) === receipt.transcript.sha256
    );
  }
  return true;
}

function tasksDir(options = {}) {
  if (options.tasksDir) return options.tasksDir;
  if (process.env.SECONDBRAIN_TASKS_DIR) return process.env.SECONDBRAIN_TASKS_DIR;
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'secondbrain',
    'data',
    'tasks',
  );
}

function reconcileSpineTaskArchivePending(receipt, options = {}) {
  const file = existingSessionRecordFile(receipt.session_id, { ...options, tasksDir: tasksDir(options) });
  if (!file) return false;
  return withSessionRecordLock(file, () => {
  let task;
  try {
    task = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  const now = options.now || new Date();
  const changed = task.status !== 'archive_pending';
  task.status = 'archive_pending';
  delete task.lineageStatus;
  task.updatedAt = now.toISOString();
  delete task.completedAt;
  task.archiveReceipt = archivePaths(receipt.session_id, options.dataDir).receipt;
  task.history = Array.isArray(task.history) ? task.history : [];
  if (changed) {
    task.history.push({
      status: 'archive_pending',
      ts: now.toISOString(),
      note: 'local archive checksum recorded; S3 verification pending',
    });
  }
  writeSessionRecord(file, task);
  return true;
  });
}

function reconcileSpineTask(receipt, options = {}) {
  const file = existingSessionRecordFile(receipt.session_id, { ...options, tasksDir: tasksDir(options) });
  if (!file) return false;
  return withSessionRecordLock(file, () => {
  let task;
  try {
    task = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  const now = options.now || new Date();
  task.status = 'done';
  delete task.lineageStatus;
  task.updatedAt = now.toISOString();
  task.completedAt = now.toISOString();
  task.archiveReceipt = archivePaths(receipt.session_id, options.dataDir).receipt;
  task.archiveChecksum = receipt.transcript.sha256;
  task.history = Array.isArray(task.history) ? task.history : [];
  task.history.push({
    status: 'done',
    ts: now.toISOString(),
    note: 'session archive checksum verified on S3',
  });
  writeSessionRecord(file, task);
  return true;
  });
}

module.exports = {
  SCHEMA,
  archivePaths,
  completeArchiveReceipt,
  fileProof,
  isSessionArchiveComplete,
  markArchivePending,
  prepareArchiveReceipt,
  readArchiveReceipt,
  reconcileSpineTaskArchivePending,
  reconcileSpineTask,
  runtimeDataDir,
  sha256File,
};
