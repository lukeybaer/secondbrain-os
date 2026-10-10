'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  DEFAULT_BUCKET,
  RESTORE_PROOF_SCHEMA,
  latestBackupHealthLine,
  snapshotKeyFromHealth,
} = require('./backup-health.js');

const HEALTH_LOG_RELATIVE = path.join('agent', 'health-heal.jsonl');
const OUTPUT_RELATIVE = path.join('agent', 'backup-restore-proof-latest.json');

function atomicWriteJson(file, value, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fsApi.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fsApi.renameSync(temp, file);
}

// Hash in fixed-size chunks, never in one buffer. readFileSync materialises
// the whole file, and Node refuses any buffer over 2 GiB, so hashing the
// snapshot archive threw
//   File size (20970468811) is greater than 2 GiB
// on 2026-09-16 AFTER a 19.5 GB download and a full CRC walk had already
// succeeded, discarding all of that work and writing a red receipt whose
// detail described a Node buffer limit rather than the backup. Archives only
// grow, so this could never have worked once a snapshot passed 2 GiB.
const SHA256_CHUNK_BYTES = 8 * 1024 * 1024;

function sha256File(file, fsApi = fs) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(SHA256_CHUNK_BYTES);
  const fd = fsApi.openSync(file, 'r');
  try {
    for (;;) {
      const read = fsApi.readSync(fd, buffer, 0, SHA256_CHUNK_BYTES, null);
      if (!read) break;
      hash.update(read === SHA256_CHUNK_BYTES ? buffer : buffer.subarray(0, read));
    }
  } finally {
    fsApi.closeSync(fd);
  }
  return hash.digest('hex');
}

function sameInstant(left, right) {
  const leftMs = Date.parse(String(left || ''));
  const rightMs = Date.parse(String(right || ''));
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && Math.abs(leftMs - rightMs) <= 1000;
}

function defaultExec(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', timeout: options.timeout || 20 * 60_000 });
}

/**
 * Prove the snapshot archive is restorable.
 *
 * `testzip()` walks EVERY entry, decompresses it and checks its CRC32, so it
 * already proves the archive is complete and every byte reads back correctly.
 * The path loop proves no entry escapes the target. What `extractall` added on
 * top of that was a filesystem write of the entire uncompressed tree, which is
 * a property of the disk rather than of the backup.
 *
 * That cost made the proof impossible to run. The 2026-09-16 snapshot is a
 * 19.5 GB archive of 36.3 GB of files, and the EC2 host it verifies on has
 * 26 GB free, so a full extraction could only ever fail with ENOSPC. A check
 * that cannot pass is worse than one that verifies integrity without
 * materialising the tree.
 *
 * So: CRC-verify everything, path-check everything, and extract a BOUNDED
 * sample to keep a real write round-trip in the proof. The receipt records how
 * much was extracted so the sample is never mistaken for a full restore.
 */
const DEFAULT_EXTRACT_SAMPLE_BYTES = 512 * 1024 * 1024;
// EC2 runs this and has python3. On Windows `python3` resolves to the
// WindowsApps shim, which exits without running anything, so an override keeps
// the same code exercisable off the cloud host.
const DEFAULT_PYTHON_BIN = process.env.SECONDBRAIN_PYTHON_BIN || 'python3';

function verifyZipWithPython({
  archive,
  restoreDir,
  execFileSyncFn = defaultExec,
  extractSampleBytes = DEFAULT_EXTRACT_SAMPLE_BYTES,
  pythonBin = DEFAULT_PYTHON_BIN,
}) {
  const program = [
    'import json, pathlib, sys, zipfile',
    'archive = pathlib.Path(sys.argv[1])',
    'target = pathlib.Path(sys.argv[2]).resolve()',
    'sample_budget = int(sys.argv[3])',
    'with zipfile.ZipFile(archive) as z:',
    '  bad = z.testzip()',
    '  if bad: raise RuntimeError("zip CRC failed: " + bad)',
    '  files = [i for i in z.infolist() if not i.is_dir()]',
    '  if not files: raise RuntimeError("snapshot archive contains no files")',
    '  for info in files:',
    '    resolved = (target / info.filename).resolve()',
    '    if target != resolved and target not in resolved.parents: raise RuntimeError("unsafe archive path: " + info.filename)',
    '  extracted_files = 0',
    '  extracted_bytes = 0',
    '  for info in files:',
    '    if extracted_bytes + info.file_size > sample_budget: continue',
    '    z.extract(info, target)',
    '    extracted_files += 1',
    '    extracted_bytes += info.file_size',
    '  if extracted_files == 0 and files: raise RuntimeError("no archive member fit the extraction sample budget")',
    '  print(json.dumps({"checkedFiles": len(files), "checkedBytes": sum(i.file_size for i in files), "extractedFiles": extracted_files, "extractedBytes": extracted_bytes}))',
  ].join(String.fromCharCode(10));
  return JSON.parse(
    execFileSyncFn(pythonBin, ['-c', program, archive, restoreDir, String(extractSampleBytes)], {
      timeout: 20 * 60_000,
    }),
  );
}

function verifyLatestBackupRestore({
  dataDir,
  now = new Date(),
  bucket = DEFAULT_BUCKET,
  region = 'us-east-1',
  fsApi = fs,
  osApi = os,
  execFileSyncFn = defaultExec,
  scratchRoot = '',
} = {}) {
  const output = path.join(dataDir, OUTPUT_RELATIVE);
  // The verifier downloads the whole snapshot archive and extracts it. On EC2
  // os.tmpdir() is /tmp, a 7.7 GB tmpfs backed by RAM, so a multi-GB snapshot
  // would either fail with ENOSPC or push the box toward an OOM kill. Default
  // the scratch space to the data directory, which is disk-backed on every
  // host, and let a caller override it explicitly.
  const restoreScratchRoot = String(scratchRoot || '').trim()
    ? path.resolve(String(scratchRoot).trim())
    : path.join(dataDir, 'tmp', 'backup-restore');
  const health = latestBackupHealthLine(path.join(dataDir, HEALTH_LOG_RELATIVE), fsApi);
  const snapshotKey = health ? snapshotKeyFromHealth(health.value) : '';
  const healthLastModified = health?.value?.final?.backups?.lastModified || '';
  let tempRoot = null;
  let receipt;
  try {
    if (!health || !snapshotKey || !healthLastModified) {
      throw new Error('current backup completion receipt lacks snapshot key or S3 LastModified evidence');
    }
    const head = JSON.parse(
      execFileSyncFn(
        'aws',
        ['s3api', 'head-object', '--bucket', bucket, '--key', snapshotKey, '--region', region, '--output', 'json'],
        { timeout: 60_000 },
      ),
    );
    if (!head?.ETag || !sameInstant(head.LastModified, healthLastModified)) {
      throw new Error('S3 object identity does not match the backup completion receipt');
    }
    fsApi.mkdirSync(restoreScratchRoot, { recursive: true });
    tempRoot = fsApi.mkdtempSync(path.join(restoreScratchRoot, 'secondbrain-backup-restore-'));
    const archive = path.join(tempRoot, 'snapshot.zip');
    const restoreDir = path.join(tempRoot, 'restored');
    fsApi.mkdirSync(restoreDir, { recursive: true });
    execFileSyncFn(
      'aws',
      ['s3api', 'get-object', '--bucket', bucket, '--key', snapshotKey, '--region', region, archive],
      { timeout: 20 * 60_000 },
    );
    const verified = verifyZipWithPython({ archive, restoreDir, execFileSyncFn });
    if (!Number.isInteger(verified.checkedFiles) || verified.checkedFiles <= 0) {
      throw new Error('restored snapshot contains no verified files');
    }
    receipt = {
      schema: RESTORE_PROOF_SCHEMA,
      checkedAt: now.toISOString(),
      status: 'green',
      restoreVerified: true,
      checkedFiles: verified.checkedFiles,
      checkedBytes: Number(verified.checkedBytes || 0),
      // Every member was decompressed and CRC-checked. These two record how
      // much was additionally written back to disk, so a bounded sample can
      // never be read as a full restore.
      extractedFiles: Number(verified.extractedFiles || 0),
      extractedBytes: Number(verified.extractedBytes || 0),
      source: {
        bucket,
        objectKey: snapshotKey,
        objectEtag: head.ETag,
        objectLastModified: new Date(head.LastModified).toISOString(),
        objectSize: Number(head.ContentLength || 0),
        archiveSha256: sha256File(archive, fsApi),
        healthReceiptSha256: health.sha256,
      },
    };
  } catch (error) {
    receipt = {
      schema: RESTORE_PROOF_SCHEMA,
      checkedAt: now.toISOString(),
      status: 'red',
      restoreVerified: false,
      checkedFiles: 0,
      detail: String(error?.message || error).slice(0, 500),
      source: {
        bucket,
        objectKey: snapshotKey || null,
        healthReceiptSha256: health?.sha256 || null,
      },
    };
  } finally {
    if (tempRoot) {
      const resolved = path.resolve(tempRoot);
      const tempBase = `${path.resolve(restoreScratchRoot)}${path.sep}`;
      if (!resolved.startsWith(tempBase) || !path.basename(resolved).startsWith('secondbrain-backup-restore-')) {
        throw new Error(`refusing unsafe backup restore cleanup target: ${resolved}`);
      }
      fsApi.rmSync(resolved, { recursive: true, force: true });
    }
  }
  atomicWriteJson(output, receipt, fsApi);
  return receipt;
}

module.exports = {
  atomicWriteJson,
  sameInstant,
  sha256File,
  verifyLatestBackupRestore,
  verifyZipWithPython,
};
