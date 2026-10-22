#!/usr/bin/env node
'use strict';
// session-archive-redrive.js
//
// Re-drives data/agent/session-archive/pending.jsonl, the backlog written by
// markArchivePending() when a Stop-hook upload could not be checksum-verified.
// Nothing consumed this queue before 2026-08-02; entries accumulated since
// 2026-07-26 because the hook raced its own checksums against a live,
// still-appending transcript.
//
// Each queued session is re-archived from its final on-disk transcript with
// the same snapshot discipline as the fixed Stop hook: copy once, hash the
// copy, prepare the receipt from the copy, upload the copy, HEAD-verify,
// complete. Afterwards the backlog is compacted to one line per session that
// is still not replicated.
//
// Usage:
//   node scripts/session-archive-redrive.js               # re-drive everything
//   node scripts/session-archive-redrive.js --limit 50    # bounded run
//   node scripts/session-archive-redrive.js --dry-run     # report only

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  archivePaths,
  completeArchiveReceipt,
  markArchivePending,
  prepareArchiveReceipt,
  readArchiveReceipt,
} = require('./lib/session-archive-receipt.js');

const REGION = process.env.SECONDBRAIN_AWS_REGION || 'us-east-1';

function aws(args, timeoutMs) {
  const r = spawnSync('aws', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs || 120000,
  });
  return { ok: r.status === 0, stdout: (r.stdout || '').trim() };
}

function headProof(bucket, key) {
  const r = aws([
    's3api', 'head-object', '--bucket', bucket, '--key', key, '--region', REGION,
    '--query', '[Metadata.sha256,ContentLength]', '--output', 'text',
  ]);
  if (!r.ok) return null;
  const [sha256, bytes] = r.stdout.split(/\s+/);
  return { sha256, bytes: Number(bytes) };
}

function upload(src, bucket, key, sha256, sessionId, contentType) {
  const args = [
    's3', 'cp', src, `s3://${bucket}/${key}`, '--region', REGION,
    '--only-show-errors', '--sse', 'AES256',
    '--metadata', `sha256=${sha256},session-id=${sessionId}`,
  ];
  if (contentType) args.push('--content-type', contentType);
  return aws(args, 300000).ok;
}

// The receipt's metadata.path is a mktemp file the Stop hook deletes after
// running; the hook also copies the same payload to
// ~/.secondbrain/meta-cache/<repo>/<date>/<session>.json, which mirrors the
// S3 metadata_key minus its meta/ prefix.
function resolveMetaFile(receipt, cacheRoot) {
  const root = cacheRoot || path.join(os.homedir(), '.secondbrain', 'meta-cache');
  const recorded = receipt && receipt.metadata && receipt.metadata.path;
  if (recorded && fs.existsSync(recorded)) return recorded;
  const key = String((receipt && receipt.s3 && receipt.s3.metadata_key) || '');
  if (key.startsWith('meta/')) {
    const cached = path.join(root, key.slice('meta/'.length));
    if (fs.existsSync(cached)) return cached;
  }
  return null;
}

function redriveOne(sessionId, receipt) {
  const transcriptPath = receipt.transcript && receipt.transcript.path;
  const bucket = receipt.s3 && receipt.s3.bucket;
  const metaFile = resolveMetaFile(receipt);
  if (!bucket || !receipt.s3.transcript_key || !receipt.s3.metadata_key) {
    return 'skipped: incomplete s3 target';
  }
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return 'skipped: transcript missing on disk';
  }
  if (!metaFile) return 'skipped: meta payload missing on disk';
  const snapshot = path.join(os.tmpdir(), `sb-redrive-${process.pid}-${sessionId}.jsonl`);
  fs.copyFileSync(transcriptPath, snapshot);
  try {
    const { receipt: fresh } = prepareArchiveReceipt({
      sessionId,
      operationId: receipt.operation_id,
      transcriptPath,
      transcriptSnapshotPath: snapshot,
      metaPath: metaFile,
      repo: receipt.repo,
      bucket,
      transcriptKey: receipt.s3.transcript_key,
      metaKey: receipt.s3.metadata_key,
    });
    if (!upload(snapshot, bucket, fresh.s3.transcript_key, fresh.transcript.sha256, sessionId)) {
      throw new Error('transcript upload failed');
    }
    if (
      !upload(metaFile, bucket, fresh.s3.metadata_key, fresh.metadata.sha256, sessionId, 'application/json')
    ) {
      throw new Error('meta upload failed');
    }
    const heads = {
      transcript: headProof(bucket, fresh.s3.transcript_key),
      metadata: headProof(bucket, fresh.s3.metadata_key),
    };
    if (!heads.transcript || !heads.metadata) throw new Error('S3 HEAD unavailable after upload');
    completeArchiveReceipt(sessionId, heads);
    return 'replicated';
  } catch (err) {
    markArchivePending(sessionId, `redrive failed: ${err.message}`);
    return `failed: ${err.message}`;
  } finally {
    fs.rmSync(snapshot, { force: true });
  }
}

function main() {
  const limitIdx = process.argv.indexOf('--limit');
  const limit = limitIdx > -1 ? Number(process.argv[limitIdx + 1]) : Infinity;
  const dryRun = process.argv.includes('--dry-run');
  const backlogPath = archivePaths('redrive').backlog;
  let lines = [];
  try {
    lines = fs.readFileSync(backlogPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    console.log('no pending backlog');
    return;
  }
  const sessionIds = [];
  const seen = new Set();
  for (const line of lines) {
    try {
      const id = JSON.parse(line).session_id;
      if (id && !seen.has(id)) {
        seen.add(id);
        sessionIds.push(id);
      }
    } catch {
      // malformed journal line; compaction below drops it
    }
  }
  const counts = { alreadyReplicated: 0, replicated: 0, skipped: 0, failed: 0 };
  let attempts = 0;
  for (const sessionId of sessionIds) {
    const receipt = readArchiveReceipt(sessionId);
    if (!receipt) {
      counts.skipped++;
      continue;
    }
    if (receipt.status === 'replicated') {
      counts.alreadyReplicated++;
      continue;
    }
    if (attempts >= limit) continue;
    attempts++;
    if (dryRun) {
      console.log(`[dry-run] would re-drive ${sessionId} (${receipt.pending_reason})`);
      continue;
    }
    const outcome = redriveOne(sessionId, receipt);
    if (outcome === 'replicated') counts.replicated++;
    else if (outcome.startsWith('skipped')) counts.skipped++;
    else counts.failed++;
    console.log(`${sessionId} ${outcome}`);
  }
  if (!dryRun) {
    // Compact the append-only journal: keep one line per session that is
    // still not replicated so the backlog reflects real remaining work.
    const keep = [];
    const kept = new Set();
    for (const line of fs.readFileSync(backlogPath, 'utf8').split('\n').filter(Boolean)) {
      try {
        const id = JSON.parse(line).session_id;
        if (!id || kept.has(id)) continue;
        const current = readArchiveReceipt(id);
        if (current && current.status === 'replicated') continue;
        kept.add(id);
        keep.push(line);
      } catch {
        // drop malformed lines
      }
    }
    fs.writeFileSync(backlogPath, keep.length ? `${keep.join('\n')}\n` : '');
    console.log(`backlog compacted to ${keep.length} session(s)`);
  }
  console.log(JSON.stringify(counts));
}

if (require.main === module) main();

module.exports = { resolveMetaFile };
