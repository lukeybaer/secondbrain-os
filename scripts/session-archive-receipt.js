#!/usr/bin/env node
'use strict';

const {
  completeArchiveReceipt,
  markArchivePending,
  prepareArchiveReceipt,
} = require('./lib/session-archive-receipt.js');

function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

const command = process.argv[2] || '';
const sessionId = arg('session-id');

try {
  if (command === 'prepare') {
    const result = prepareArchiveReceipt({
      sessionId,
      operationId: arg('operation-id'),
      transcriptPath: arg('transcript'),
      transcriptSnapshotPath: arg('transcript-snapshot'),
      metaPath: arg('meta'),
      repo: arg('repo'),
      bucket: arg('bucket'),
      transcriptKey: arg('transcript-key'),
      metaKey: arg('meta-key'),
    });
    process.stdout.write(`${result.receiptPath}\n`);
  } else if (command === 'complete') {
    completeArchiveReceipt(sessionId, {
      transcript: {
        sha256: arg('transcript-sha256'),
        bytes: arg('transcript-bytes'),
      },
      metadata: {
        sha256: arg('meta-sha256'),
        bytes: arg('meta-bytes'),
      },
    });
  } else if (command === 'pending') {
    markArchivePending(sessionId, arg('reason'));
  } else {
    throw new Error('usage: session-archive-receipt.js prepare|complete|pending ...');
  }
} catch (err) {
  process.stderr.write(`[session-archive-receipt] ${err.message}\n`);
  process.exit(1);
}
