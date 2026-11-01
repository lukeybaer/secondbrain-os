'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ARCHIVE_SCHEMA = 'life_archive_otter_full_audio_archive_receipt.v1';
const CANARY_SCHEMA = 'life_archive_otter_full_audio_restore_canary.v1';
const RECEIPT_FILE_MODE = 0o644;
const HASH_RE = /^[a-f0-9]{64}$/;
const SUPPORTED_EXTENSIONS = new Set([
  '.aac',
  '.flac',
  '.m4a',
  '.mp3',
  '.mp4',
  '.ogg',
  '.wav',
  '.webm',
]);

function resolvedDataDir(dataDir) {
  return path.resolve(
    dataDir ||
      process.env.SECONDBRAIN_DATA_DIR ||
      process.env.SECONDBRAIN_DATA ||
      '/opt/secondbrain/data',
  );
}

function callKey(otid) {
  return crypto.createHash('sha256').update(String(otid || '')).digest('hex');
}

function encodedOtid(otid) {
  return encodeURIComponent(String(otid || '').trim()).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function normalizedExtension(value) {
  const extension = path.extname(String(value || '')).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(extension) ? extension : '';
}

function receiptDirectory({ dataDir, otid } = {}) {
  const exactOtid = String(otid || '').trim();
  if (!exactOtid) throw new Error('otid is required');
  return path.join(
    resolvedDataDir(dataDir),
    'life-archive',
    'voiceprints',
    'otter-full-audio-archive-receipts',
    'calls',
    callKey(exactOtid),
  );
}

function fullAudioArchiveReceiptPath({
  dataDir,
  otid,
  contentHash,
  extension,
} = {}) {
  const exactHash = String(contentHash || '').toLowerCase();
  const exactExtension = normalizedExtension(`file${extension || ''}`);
  if (!HASH_RE.test(exactHash)) throw new Error('contentHash must be a SHA-256 hash');
  if (!exactExtension) throw new Error('a supported audio extension is required');
  return path.join(
    receiptDirectory({ dataDir, otid }),
    `${exactHash}${exactExtension}.json`,
  );
}

function archiveKey({ prefix, otid, contentHash, extension } = {}) {
  const exactOtid = String(otid || '').trim();
  const exactHash = String(contentHash || '').toLowerCase();
  const exactExtension = normalizedExtension(`file${extension || ''}`);
  if (!exactOtid) throw new Error('otid is required');
  if (!HASH_RE.test(exactHash)) throw new Error('contentHash must be a SHA-256 hash');
  if (!exactExtension) throw new Error('a supported audio extension is required');
  return [
    String(prefix || 'data-lake/secondbrain/otter/full-audio').replace(/\/+$/, ''),
    encodedOtid(exactOtid),
    `${exactHash}${exactExtension}`,
  ].join('/');
}

function inventoryFullAudio({ dataDir, fsApi = fs } = {}) {
  const root = path.join(resolvedDataDir(dataDir), 'otter', 'audio-full');
  const files = [];
  const skipped = {
    unsupported_extension: 0,
    empty: 0,
    not_file: 0,
  };
  if (!fsApi.existsSync(root)) return { root, files, skipped };
  const entries = fsApi
    .readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isFile()) {
      skipped.not_file += 1;
      continue;
    }
    const extension = normalizedExtension(entry.name);
    if (!extension) {
      skipped.unsupported_extension += 1;
      continue;
    }
    const file = path.join(root, entry.name);
    const stats = fsApi.statSync(file);
    if (Number(stats.size || 0) <= 0) {
      skipped.empty += 1;
      continue;
    }
    files.push({
      otid: path.basename(entry.name, extension),
      file: path.resolve(file),
      extension,
      bytes: Number(stats.size),
      mtime_ms: Number(stats.mtimeMs),
    });
  }
  return { root, files, skipped };
}

function archiveReceiptProblems(receipt, expected = {}) {
  const problems = [];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return ['full-audio archive receipt is not an object'];
  }
  if (receipt.schema !== ARCHIVE_SCHEMA) {
    problems.push('full-audio archive receipt schema is invalid');
  }
  if (!String(receipt.otid || '').trim()) {
    problems.push('full-audio archive receipt lacks an otid');
  }
  if (!HASH_RE.test(String(receipt.content_hash || '').toLowerCase())) {
    problems.push('full-audio archive receipt lacks a SHA-256 content hash');
  }
  if (!Number.isFinite(Date.parse(String(receipt.archived_at || '')))) {
    problems.push('full-audio archive receipt lacks an archive timestamp');
  }
  const local = receipt.local_source || {};
  if (
    !String(local.path || '').trim() ||
    String(local.content_hash || '').toLowerCase() !==
      String(receipt.content_hash || '').toLowerCase() ||
    !normalizedExtension(`file${local.extension || ''}`) ||
    !Number.isFinite(Number(local.bytes)) ||
    Number(local.bytes) <= 0 ||
    !Number.isFinite(Number(local.mtime_ms))
  ) {
    problems.push('full-audio archive receipt lacks matching local proof');
  }
  const durable = receipt.durable_archive || {};
  const expectedChecksum = HASH_RE.test(String(receipt.content_hash || '').toLowerCase())
    ? Buffer.from(String(receipt.content_hash).toLowerCase(), 'hex').toString('base64')
    : '';
  if (
    !/^s3:\/\/[^/]+\/.+/.test(String(durable.uri || '')) ||
    !String(durable.bucket || '').trim() ||
    !String(durable.key || '').trim() ||
    String(durable.content_hash || '').toLowerCase() !==
      String(receipt.content_hash || '').toLowerCase() ||
    String(durable.checksum_sha256 || '') !== expectedChecksum ||
    !Number.isFinite(Number(durable.bytes)) ||
    Number(durable.bytes) <= 0 ||
    !String(durable.etag || '').trim() ||
    !String(durable.version_id || '').trim()
  ) {
    problems.push('full-audio archive receipt lacks verified remote proof');
  }
  if (
    String(durable.uri || '') !==
    `s3://${String(durable.bucket || '')}/${String(durable.key || '')}`
  ) {
    problems.push('full-audio archive URI disagrees with its bucket and key');
  }
  if (
    Number(local.bytes || 0) > 0 &&
    Number(durable.bytes || 0) > 0 &&
    Number(local.bytes) !== Number(durable.bytes)
  ) {
    problems.push('local and durable full-audio byte counts disagree');
  }
  if (expected.otid && String(receipt.otid) !== String(expected.otid)) {
    problems.push('full-audio archive receipt is for a different call');
  }
  if (
    expected.contentHash &&
    String(receipt.content_hash).toLowerCase() !==
      String(expected.contentHash).toLowerCase()
  ) {
    problems.push('full-audio archive receipt is for different bytes');
  }
  if (
    expected.extension &&
    String(local.extension).toLowerCase() !==
      String(expected.extension).toLowerCase()
  ) {
    problems.push('full-audio archive receipt is for a different file type');
  }
  return problems;
}

function loadFullAudioArchiveReceipt({
  dataDir,
  otid,
  contentHash,
  extension,
  file,
} = {}) {
  const receiptFile =
    file ||
    fullAudioArchiveReceiptPath({
      dataDir,
      otid,
      contentHash,
      extension,
    });
  try {
    const receipt = JSON.parse(
      fs.readFileSync(receiptFile, 'utf8').replace(/^\uFEFF/, ''),
    );
    const problems = archiveReceiptProblems(receipt, {
      otid,
      contentHash,
      extension,
    });
    return {
      ok: problems.length === 0,
      file: receiptFile,
      receipt,
      problems,
    };
  } catch (error) {
    return {
      ok: false,
      file: receiptFile,
      receipt: null,
      problems: [`full-audio archive receipt is missing or unreadable: ${error.message}`],
    };
  }
}

function writeImmutableJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temp, 'wx', RECEIPT_FILE_MODE);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(temp, file);
    return { created: true, idempotent: false, path: file, receipt: value };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (JSON.stringify(existing) !== JSON.stringify(value)) {
      throw new Error(`immutable full-audio proof conflict: ${file}`);
    }
    return { created: false, idempotent: true, path: file, receipt: existing };
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function isMissingObjectError(error) {
  const detail = String(error?.stderr || error?.stdout || error?.message || error);
  return /(?:NotFound|NoSuchKey|\b404\b)/i.test(detail);
}

function exactRemoteProof(head, { bytes, sha256 } = {}) {
  const checksum = Buffer.from(sha256, 'hex').toString('base64');
  return (
    Number(head?.ContentLength) === Number(bytes) &&
    String(head?.Metadata?.sha256 || '').toLowerCase() === sha256 &&
    String(head?.ChecksumSHA256 || '') === checksum &&
    Boolean(String(head?.ETag || '').trim()) &&
    Boolean(String(head?.VersionId || '').trim())
  );
}

async function archiveFullAudioCandidate({
  dataDir,
  candidate,
  bucket,
  prefix = 'data-lake/secondbrain/otter/full-audio',
  region = 'us-east-1',
  runAwsFn,
  sha256FileFn = sha256File,
  now = new Date(),
} = {}) {
  if (typeof runAwsFn !== 'function') throw new Error('runAwsFn is required');
  const exactBucket = String(bucket || '').trim();
  if (!exactBucket) throw new Error('bucket is required');
  const localPath = path.resolve(String(candidate?.file || ''));
  if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
    throw new Error(`full-audio source is missing: ${localPath}`);
  }
  const before = fs.statSync(localPath);
  if (
    Number(before.size) !== Number(candidate?.bytes) ||
    normalizedExtension(localPath) !== candidate?.extension
  ) {
    throw new Error('full-audio source changed after inventory');
  }
  const contentHash = String(await sha256FileFn(localPath)).toLowerCase();
  if (!HASH_RE.test(contentHash)) throw new Error('local full-audio SHA-256 is invalid');
  const after = fs.statSync(localPath);
  if (
    Number(after.size) !== Number(before.size) ||
    Number(after.mtimeMs) !== Number(before.mtimeMs)
  ) {
    throw new Error('full-audio source changed while hashing');
  }
  const key = archiveKey({
    prefix,
    otid: candidate.otid,
    contentHash,
    extension: candidate.extension,
  });
  const receiptFile = fullAudioArchiveReceiptPath({
    dataDir,
    otid: candidate.otid,
    contentHash,
    extension: candidate.extension,
  });
  if (fs.existsSync(receiptFile)) {
    const loaded = loadFullAudioArchiveReceipt({
      dataDir,
      otid: candidate.otid,
      contentHash,
      extension: candidate.extension,
      file: receiptFile,
    });
    if (!loaded.ok) {
      throw new Error(`full-audio archive receipt is invalid: ${loaded.problems.join('; ')}`);
    }
    if (
      Number(loaded.receipt.local_source.bytes) !== Number(after.size) ||
      loaded.receipt.local_source.content_hash !== contentHash ||
      loaded.receipt.durable_archive.bucket !== exactBucket ||
      loaded.receipt.durable_archive.key !== key
    ) {
      throw new Error('full-audio archive receipt conflicts with the requested archive target');
    }
    return {
      disposition: 'reused_receipt',
      receipt: loaded.receipt,
      receipt_file: receiptFile,
    };
  }

  const checksumSha256 = Buffer.from(contentHash, 'hex').toString('base64');
  const headArgs = [
    's3api',
    'head-object',
    '--region',
    region,
    '--bucket',
    exactBucket,
    '--key',
    key,
    '--checksum-mode',
    'ENABLED',
    '--output',
    'json',
  ];
  let head = null;
  let disposition = 'reused_remote';
  try {
    head = JSON.parse(await runAwsFn(headArgs));
    if (!exactRemoteProof(head, { bytes: after.size, sha256: contentHash })) {
      throw new Error(
        `S3_ARCHIVE_STATE_DIVERGENCE: existing object does not match local bytes for s3://${exactBucket}/${key}`,
      );
    }
  } catch (error) {
    if (!isMissingObjectError(error)) throw error;
    disposition = 'uploaded';
    await runAwsFn([
      's3api',
      'put-object',
      '--region',
      region,
      '--bucket',
      exactBucket,
      '--key',
      key,
      '--body',
      localPath,
      '--metadata',
      `sha256=${contentHash}`,
      '--checksum-algorithm',
      'SHA256',
      '--checksum-sha256',
      checksumSha256,
      '--server-side-encryption',
      'AES256',
      '--output',
      'json',
    ]);
    head = JSON.parse(await runAwsFn(headArgs));
    if (!exactRemoteProof(head, { bytes: after.size, sha256: contentHash })) {
      throw new Error(`S3 verification failed for s3://${exactBucket}/${key}`);
    }
  }

  const receipt = {
    schema: ARCHIVE_SCHEMA,
    otid: String(candidate.otid),
    content_hash: contentHash,
    archived_at: now.toISOString(),
    local_source: {
      path: localPath,
      extension: candidate.extension,
      content_hash: contentHash,
      bytes: Number(after.size),
      mtime_ms: Number(after.mtimeMs),
    },
    durable_archive: {
      uri: `s3://${exactBucket}/${key}`,
      bucket: exactBucket,
      key,
      content_hash: contentHash,
      checksum_sha256: checksumSha256,
      bytes: Number(head.ContentLength),
      etag: String(head.ETag),
      version_id: String(head.VersionId),
    },
  };
  const problems = archiveReceiptProblems(receipt, {
    otid: candidate.otid,
    contentHash,
    extension: candidate.extension,
  });
  if (problems.length) {
    throw new Error(`full-audio archive receipt validation failed: ${problems.join('; ')}`);
  }
  const written = writeImmutableJson(receiptFile, receipt);
  return {
    disposition,
    receipt: written.receipt,
    receipt_file: written.path,
  };
}

function findStatMatchingReceipt({
  dataDir,
  candidate,
  bucket,
  prefix = 'data-lake/secondbrain/otter/full-audio',
} = {}) {
  const directory = receiptDirectory({ dataDir, otid: candidate?.otid });
  if (!fs.existsSync(directory)) return null;
  for (const name of fs.readdirSync(directory).sort()) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(directory, name);
    const loaded = loadFullAudioArchiveReceipt({ file });
    if (!loaded.ok) continue;
    const local = loaded.receipt.local_source;
    const expectedKey = archiveKey({
      prefix,
      otid: candidate.otid,
      contentHash: loaded.receipt.content_hash,
      extension: candidate.extension,
    });
    let receiptSourcePath = path.resolve(String(local.path));
    let candidateSourcePath = path.resolve(String(candidate.file));
    try {
      receiptSourcePath = fs.realpathSync(receiptSourcePath);
      candidateSourcePath = fs.realpathSync(candidateSourcePath);
    } catch {
      // Fail closed to the lexical paths when either source no longer resolves.
    }
    if (
      receiptSourcePath === candidateSourcePath &&
      String(local.extension).toLowerCase() === String(candidate.extension).toLowerCase() &&
      Number(local.bytes) === Number(candidate.bytes) &&
      Number(local.mtime_ms) === Number(candidate.mtime_ms) &&
      (!bucket || loaded.receipt.durable_archive.bucket === bucket) &&
      loaded.receipt.durable_archive.key === expectedKey
    ) {
      return { ...loaded, file };
    }
  }
  return null;
}

function canaryReceiptPath({ dataDir, runId } = {}) {
  const safeRunId =
    String(runId || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') ||
    `canary-${Date.now()}`;
  return path.join(
    resolvedDataDir(dataDir),
    'life-archive',
    'voiceprints',
    'otter-full-audio-archive-receipts',
    'restore-canaries',
    `${safeRunId}.json`,
  );
}

async function restoreFullAudioCanary({
  dataDir,
  archiveReceipt,
  archiveReceiptFile,
  tempRoot = os.tmpdir(),
  runId,
  region = 'us-east-1',
  runAwsFn,
  sha256FileFn = sha256File,
  now = new Date(),
} = {}) {
  if (typeof runAwsFn !== 'function') throw new Error('runAwsFn is required');
  const problems = archiveReceiptProblems(archiveReceipt);
  if (problems.length) {
    throw new Error(`cannot restore from invalid full-audio receipt: ${problems.join('; ')}`);
  }
  fs.mkdirSync(tempRoot, { recursive: true });
  const canaryDir = fs.mkdtempSync(path.join(tempRoot, 'otter-full-restore-'));
  const destination = path.join(
    canaryDir,
    `canary${archiveReceipt.local_source.extension}`,
  );
  const durable = archiveReceipt.durable_archive;
  let restored = null;
  try {
    const response = JSON.parse(
      await runAwsFn([
        's3api',
        'get-object',
        '--region',
        region,
        '--bucket',
        durable.bucket,
        '--key',
        durable.key,
        '--version-id',
        durable.version_id,
        '--checksum-mode',
        'ENABLED',
        '--output',
        'json',
        destination,
      ]),
    );
    if (!fs.existsSync(destination) || !fs.statSync(destination).isFile()) {
      throw new Error('full-audio restore canary did not materialize a file');
    }
    const restoredHash = String(await sha256FileFn(destination)).toLowerCase();
    const restoredBytes = fs.statSync(destination).size;
    if (
      restoredHash !== archiveReceipt.content_hash ||
      Number(restoredBytes) !== Number(durable.bytes) ||
      String(response.ChecksumSHA256 || '') !== String(durable.checksum_sha256)
    ) {
      throw new Error('full-audio restore canary hash, checksum, or length mismatch');
    }
    restored = {
      bytes: Number(restoredBytes),
      content_hash: restoredHash,
      checksum_sha256: String(response.ChecksumSHA256),
    };
  } finally {
    fs.rmSync(canaryDir, { recursive: true, force: true });
  }
  const receipt = {
    schema: CANARY_SCHEMA,
    restored_at: now.toISOString(),
    archive_receipt_path: path.resolve(String(archiveReceiptFile || '')),
    otid: archiveReceipt.otid,
    content_hash: archiveReceipt.content_hash,
    durable_archive: {
      uri: durable.uri,
      bucket: durable.bucket,
      key: durable.key,
      version_id: durable.version_id,
    },
    restored: {
      ...restored,
      temporary_bytes_removed: !fs.existsSync(destination),
    },
  };
  const receiptFile = canaryReceiptPath({ dataDir, runId });
  const written = writeImmutableJson(receiptFile, receipt);
  return {
    receipt: written.receipt,
    receipt_file: written.path,
  };
}

module.exports = {
  ARCHIVE_SCHEMA,
  CANARY_SCHEMA,
  RECEIPT_FILE_MODE,
  archiveFullAudioCandidate,
  archiveKey,
  archiveReceiptProblems,
  canaryReceiptPath,
  findStatMatchingReceipt,
  fullAudioArchiveReceiptPath,
  inventoryFullAudio,
  loadFullAudioArchiveReceipt,
  restoreFullAudioCanary,
  sha256File,
};
