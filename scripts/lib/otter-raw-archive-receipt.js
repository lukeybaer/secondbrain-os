'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  safePathSegment,
  sha256File,
  uploadFile,
} = require('./cloud-archive.js');

const SCHEMA = 'life_archive_otter_raw_archive_receipt.v1';
const HASH_RE = /^[a-f0-9]{64}$/;
// Fargate writes these immutable receipts as root on shared EFS, while the EC2
// launcher reads them as ec2-user. The receipt contains proof metadata, not
// credentials, so it must be readable across that runtime boundary.
const RECEIPT_FILE_MODE = 0o644;

function callKey(otid) {
  return crypto.createHash('sha256').update(String(otid || '')).digest('hex');
}

function resolvedDataDir(dataDir) {
  return path.resolve(
    dataDir ||
      process.env.SECONDBRAIN_DATA_DIR ||
      process.env.SECONDBRAIN_DATA ||
      '/opt/secondbrain/data',
  );
}

function otterRawArchiveReceiptPath({ dataDir, otid, sourceRevision } = {}) {
  const exactOtid = String(otid || '').trim();
  const exactRevision = String(sourceRevision || '').toLowerCase();
  if (!exactOtid) throw new Error('otid is required');
  if (!HASH_RE.test(exactRevision)) throw new Error('sourceRevision must be a SHA-256 hash');
  return path.join(
    resolvedDataDir(dataDir),
    'life-archive',
    'voiceprints',
    'otter-raw-archive-receipts',
    'calls',
    callKey(exactOtid),
    `${exactRevision}.json`,
  );
}

function receiptProblems(receipt, { otid, sourceRevision } = {}) {
  const problems = [];
  const exactOtid = String(otid || '');
  const exactRevision = String(sourceRevision || '').toLowerCase();
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return ['durable raw archive receipt is not an object'];
  }
  if (receipt.schema !== SCHEMA) problems.push('durable raw archive receipt schema is invalid');
  if (String(receipt.otid || '') !== exactOtid) {
    problems.push('durable raw archive receipt is for a different call');
  }
  if (String(receipt.source_revision || '').toLowerCase() !== exactRevision) {
    problems.push('durable raw archive receipt is for a different source revision');
  }
  if (!Number.isFinite(Date.parse(String(receipt.archived_at || '')))) {
    problems.push('durable raw archive receipt lacks an archive timestamp');
  }
  const local = receipt.local_archive || {};
  if (
    !String(local.path || '').trim() ||
    String(local.content_hash || '').toLowerCase() !== exactRevision ||
    !Number.isFinite(Number(local.bytes)) ||
    Number(local.bytes) <= 0
  ) {
    problems.push('durable raw archive receipt lacks matching local proof');
  }
  const durable = receipt.durable_archive || {};
  const expectedChecksum = HASH_RE.test(exactRevision)
    ? Buffer.from(exactRevision, 'hex').toString('base64')
    : '';
  if (
    !/^s3:\/\/[^/]+\/.+/.test(String(durable.uri || '')) ||
    String(durable.content_hash || '').toLowerCase() !== exactRevision ||
    String(durable.checksum_sha256 || '') !== expectedChecksum ||
    !Number.isFinite(Number(durable.bytes)) ||
    Number(durable.bytes) <= 0 ||
    !String(durable.etag || '').trim()
  ) {
    problems.push('durable raw archive receipt lacks verified remote proof');
  }
  if (
    Number(local.bytes || 0) > 0 &&
    Number(durable.bytes || 0) > 0 &&
    Number(local.bytes) !== Number(durable.bytes)
  ) {
    problems.push('durable and local raw archive byte counts disagree');
  }
  return problems;
}

function loadOtterRawArchiveReceipt({ dataDir, otid, sourceRevision, file } = {}) {
  const receiptFile =
    file || otterRawArchiveReceiptPath({ dataDir, otid, sourceRevision });
  let receipt = null;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return {
      ok: false,
      file: receiptFile,
      receipt: null,
      problems: [`durable raw archive receipt is missing or unreadable: ${error.message}`],
    };
  }
  const problems = receiptProblems(receipt, { otid, sourceRevision });
  return { ok: problems.length === 0, file: receiptFile, receipt, problems };
}

function writeReceiptAtomic(file, receipt) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temp, 'wx', RECEIPT_FILE_MODE);
  try {
    fs.writeFileSync(fd, bytes, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(temp, file);
    return { created: true, idempotent: false, path: file, receipt };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    const problems = receiptProblems(existing, {
      otid: receipt.otid,
      sourceRevision: receipt.source_revision,
    });
    if (problems.length) {
      throw new Error(`immutable durable raw archive receipt conflict: ${problems.join('; ')}`);
    }
    return { created: false, idempotent: true, path: file, receipt: existing };
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function archiveOtterRawRevision({
  dataDir,
  otid,
  rawPath,
  sourceRevision,
  now = new Date(),
  uploadFn = uploadFile,
} = {}) {
  const exactOtid = String(otid || '').trim();
  const exactRevision = String(sourceRevision || '').toLowerCase();
  const localPath = path.resolve(String(rawPath || ''));
  if (!exactOtid) throw new Error('otid is required');
  if (!HASH_RE.test(exactRevision)) throw new Error('sourceRevision must be a SHA-256 hash');
  if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
    throw new Error(`local raw revision is missing: ${localPath}`);
  }
  const localHash = sha256File(localPath);
  const localBytes = fs.statSync(localPath).size;
  if (localHash !== exactRevision) {
    throw new Error('local raw bytes do not match the requested source revision');
  }
  const receiptFile = otterRawArchiveReceiptPath({
    dataDir,
    otid: exactOtid,
    sourceRevision: exactRevision,
  });
  if (fs.existsSync(receiptFile)) {
    const existing = loadOtterRawArchiveReceipt({
      dataDir,
      otid: exactOtid,
      sourceRevision: exactRevision,
      file: receiptFile,
    });
    if (!existing.ok) {
      throw new Error(`durable raw archive receipt is invalid: ${existing.problems.join('; ')}`);
    }
    if (
      Number(existing.receipt.local_archive.bytes) !== localBytes ||
      existing.receipt.local_archive.content_hash !== localHash
    ) {
      throw new Error('durable raw archive receipt conflicts with the current exact local bytes');
    }
    return {
      created: false,
      idempotent: true,
      path: receiptFile,
      receipt: existing.receipt,
    };
  }

  const safeOtid = safePathSegment(exactOtid).replace(/\//g, '-') || callKey(exactOtid);
  const key = `data-lake/secondbrain/otter/raw/${safeOtid}/${exactRevision}.json`;
  const uploaded = uploadFn(localPath, {
    key,
    domain: 'secondbrain/otter',
    kind: 'raw',
    date: now,
    requireChecksumSha256: true,
  });
  const expectedChecksum = crypto
    .createHash('sha256')
    .update(fs.readFileSync(localPath))
    .digest('base64');
  if (
    String(uploaded?.sha256 || '').toLowerCase() !== exactRevision ||
    Number(uploaded?.bytes || 0) !== localBytes ||
    Number(uploaded?.contentLength || 0) !== localBytes ||
    String(uploaded?.checksumSha256 || '') !== expectedChecksum
  ) {
    throw new Error('uploaded raw archive does not match the exact source revision and bytes');
  }
  if (!/^s3:\/\/[^/]+\/.+/.test(String(uploaded?.s3Uri || '')) || !uploaded?.etag) {
    throw new Error('uploaded raw archive lacks verified remote S3 metadata');
  }
  const receipt = {
    schema: SCHEMA,
    otid: exactOtid,
    source_revision: exactRevision,
    archived_at: String(uploaded.uploadedAt || now.toISOString()),
    local_archive: {
      path: localPath,
      content_hash: localHash,
      bytes: localBytes,
    },
    durable_archive: {
      uri: uploaded.s3Uri,
      bucket: uploaded.bucket || '',
      key: uploaded.key || key,
      content_hash: String(uploaded.sha256).toLowerCase(),
      checksum_sha256: uploaded.checksumSha256,
      bytes: Number(uploaded.contentLength),
      etag: uploaded.etag,
      version_id: uploaded.versionId || null,
    },
  };
  const problems = receiptProblems(receipt, {
    otid: exactOtid,
    sourceRevision: exactRevision,
  });
  if (problems.length) {
    throw new Error(`durable raw archive receipt validation failed: ${problems.join('; ')}`);
  }
  return writeReceiptAtomic(receiptFile, receipt);
}

function defaultDownload(uri, destination) {
  execFileSync(
    'aws',
    [
      's3',
      'cp',
      uri,
      destination,
      '--region',
      process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
      '--only-show-errors',
      '--no-progress',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    },
  );
}

function materializeOtterRawRevision({
  dataDir,
  otid,
  sourceRevision,
  localRawPath,
  destination,
  downloadFn = defaultDownload,
} = {}) {
  const exactRevision = String(sourceRevision || '').toLowerCase();
  if (!HASH_RE.test(exactRevision)) throw new Error('sourceRevision must be a SHA-256 hash');
  const resolvedDestination = path.resolve(String(destination || ''));
  fs.mkdirSync(path.dirname(resolvedDestination), { recursive: true });
  const temp = `${resolvedDestination}.${process.pid}.${Date.now()}.tmp`;
  let source = 'local_archive';
  try {
    const loaded = loadOtterRawArchiveReceipt({ dataDir, otid, sourceRevision: exactRevision });
    if (!loaded.ok) {
      throw new Error(loaded.problems.join('; '));
    }
    const local = path.resolve(String(localRawPath || ''));
    if (fs.existsSync(local) && fs.statSync(local).isFile() && sha256File(local) === exactRevision) {
      fs.copyFileSync(local, temp);
    } else {
      source = 'durable_archive';
      downloadFn(loaded.receipt.durable_archive.uri, temp, loaded.receipt);
    }
    if (!fs.existsSync(temp) || sha256File(temp) !== exactRevision) {
      throw new Error('materialized raw bytes do not match the requested source revision');
    }
    fs.renameSync(temp, resolvedDestination);
    return {
      source,
      source_revision: exactRevision,
      path: resolvedDestination,
      bytes: fs.statSync(resolvedDestination).size,
    };
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

module.exports = {
  RECEIPT_FILE_MODE,
  SCHEMA,
  archiveOtterRawRevision,
  loadOtterRawArchiveReceipt,
  materializeOtterRawRevision,
  otterRawArchiveReceiptPath,
  receiptProblems,
};
