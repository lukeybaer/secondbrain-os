const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_REGION = 'us-east-1';
const MAX_SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024;

function exactChecksumSinglePutEligible(bytes) {
  return (
    Number.isFinite(Number(bytes)) && Number(bytes) >= 0 && Number(bytes) <= MAX_SINGLE_PUT_BYTES
  );
}

function archiveConfig(env = process.env) {
  const bucket =
    env.SECONDBRAIN_DATA_BUCKET ||
    env.SECONDBRAIN_ARCHIVE_BUCKET ||
    env.SECONDBRAIN_BACKUP_BUCKET ||
    '';
  return {
    bucket,
    prefix: env.SECONDBRAIN_ARCHIVE_PREFIX || 'data-lake',
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || DEFAULT_REGION,
  };
}

function dateParts(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid archive date: ${input}`);
  return d.toISOString().slice(0, 10).split('-');
}

function safeSegment(value) {
  return (
    String(value || 'misc')
      .trim()
      .replace(/\\/g, '/')
      .replace(/[^A-Za-z0-9._/-]+/g, '-')
      .replace(/\/+/g, '/')
      .replace(/^\/|\/$/g, '') || 'misc'
  );
}

function safePathSegment(value) {
  return (
    String(value || 'file')
      .replace(/\\/g, '/')
      .split('/')
      .map((part) => safeSegment(part).replace(/\//g, '-'))
      .filter(Boolean)
      .join('/') || 'file'
  );
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function buildS3Key({
  prefix = 'data-lake',
  domain = 'misc',
  kind = 'raw',
  fileName,
  date = new Date(),
} = {}) {
  if (!fileName) throw new Error('buildS3Key requires fileName');
  const [year, month, day] = dateParts(date);
  const base = safePathSegment(fileName);
  return [safeSegment(prefix), safeSegment(domain), safeSegment(kind), year, month, day, base].join(
    '/',
  );
}

function assertSafeToArchive(filePath, { allowSensitive = false } = {}) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (allowSensitive) return;
  if (/\/youtube-oauth-alert\.json$/.test(normalized)) return;
  const blocked = [
    '/.git/',
    '/node_modules/',
    '/.env',
    '.credentials.json',
    '_token.json',
    'oauth',
    'secret',
  ];
  if (blocked.some((marker) => normalized.includes(marker))) {
    throw new Error(`Refusing to archive likely sensitive or irrelevant local file: ${filePath}`);
  }
}

function runAws(args, { dryRun = false, execFile = execFileSync } = {}) {
  if (dryRun) return '';
  return execFile('aws', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
}

function headObject({ bucket, key, region, checksumMode = false, dryRun = false, execFile }) {
  if (dryRun) return {};
  const args = ['s3api', 'head-object', '--bucket', bucket, '--key', key, '--region', region];
  if (checksumMode) args.push('--checksum-mode', 'ENABLED');
  const text = runAws(args, { execFile });
  return JSON.parse(text || '{}');
}

function uploadFile(localPath, options = {}) {
  const config = { ...archiveConfig(options.env), ...options };
  if (!config.bucket)
    throw new Error(
      'Missing archive bucket. Set SECONDBRAIN_DATA_BUCKET, SECONDBRAIN_ARCHIVE_BUCKET, or SECONDBRAIN_BACKUP_BUCKET.',
    );
  const resolved = path.resolve(localPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Archive source is not a file: ${localPath}`);
  }
  assertSafeToArchive(resolved, config);

  const bytes = fs.statSync(resolved).size;
  const sha256 = sha256File(resolved);
  const sha256Base64 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(resolved))
    .digest('base64');
  const fileNameForKey = config.relativeTo
    ? path.relative(path.resolve(config.relativeTo), resolved)
    : path.basename(resolved);
  const key =
    config.key ||
    buildS3Key({
      prefix: config.prefix,
      domain: config.domain,
      kind: config.kind,
      fileName: fileNameForKey,
      date: config.date || new Date(),
    });
  const s3Uri = `s3://${config.bucket}/${key}`;

  if (config.requireChecksumSha256 && !exactChecksumSinglePutEligible(bytes)) {
    throw new Error(
      `Exact SHA-256 archive proof requires a single object no larger than 5 GB: ${s3Uri}`,
    );
  }
  // `aws s3 cp --checksum-algorithm` returns a COMPOSITE checksum for
  // multipart uploads. Comparing that value with the file's full SHA-256 is
  // invalid and caused large, byte-correct scheduled artifacts to retry
  // forever. Exact-proof uploads use PutObject with the locally computed
  // full checksum, which S3 independently validates and returns as a
  // FULL_OBJECT checksum.
  const uploadArgs = config.requireChecksumSha256
    ? [
        's3api',
        'put-object',
        '--bucket',
        config.bucket,
        '--key',
        key,
        '--body',
        resolved,
        '--region',
        config.region,
        '--server-side-encryption',
        'AES256',
        '--checksum-algorithm',
        'SHA256',
        '--checksum-sha256',
        sha256Base64,
      ]
    : [
        's3',
        'cp',
        resolved,
        s3Uri,
        '--region',
        config.region,
        '--sse',
        'AES256',
        '--only-show-errors',
        '--no-progress',
      ];
  runAws(uploadArgs, { dryRun: config.dryRun, execFile: config.execFile });

  const head = headObject({
    bucket: config.bucket,
    key,
    region: config.region,
    checksumMode: Boolean(config.requireChecksumSha256),
    dryRun: config.dryRun,
    execFile: config.execFile,
  });
  if (!config.dryRun && typeof head.ContentLength === 'number' && head.ContentLength !== bytes) {
    throw new Error(
      `S3 size verification failed for ${s3Uri}: local=${bytes} remote=${head.ContentLength}`,
    );
  }
  if (
    !config.dryRun &&
    config.requireChecksumSha256 &&
    (String(head.ChecksumType || '') !== 'FULL_OBJECT' ||
      String(head.ChecksumSHA256 || '') !== sha256Base64)
  ) {
    throw new Error(`S3 SHA-256 verification failed for ${s3Uri}`);
  }

  return {
    bucket: config.bucket,
    key,
    s3Uri,
    bytes,
    sha256,
    checksumSha256: head.ChecksumSHA256 || null,
    contentLength: head.ContentLength || null,
    etag: head.ETag || null,
    versionId: head.VersionId || null,
    uploadedAt: new Date().toISOString(),
  };
}

function isGitUntracked(filePath, { cwd = process.cwd(), execFile = execFileSync } = {}) {
  const status = execFile('git', ['status', '--porcelain', '--', filePath], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return status.trimStart().startsWith('??');
}

module.exports = {
  archiveConfig,
  assertSafeToArchive,
  buildS3Key,
  dateParts,
  exactChecksumSinglePutEligible,
  headObject,
  isGitUntracked,
  runAws,
  safePathSegment,
  sha256File,
  uploadFile,
};
