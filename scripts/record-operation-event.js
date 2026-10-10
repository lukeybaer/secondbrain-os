#!/usr/bin/env node
'use strict';

const { recordOperationEvent } = require('./lib/operation-provenance.js');

function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

try {
  const result = recordOperationEvent({
    operationId: arg('operation-id'),
    eventType: arg('event-type') || 'operation.observed',
    surface: arg('surface') || 'cli',
    sessionId: arg('session-id'),
    status: arg('status') || 'observed',
    commit: arg('commit'),
    baseSha: arg('base-sha'),
    receiptPath: arg('receipt-path'),
    receiptSha256: arg('receipt-sha256'),
    cwd: arg('cwd') || process.cwd(),
  });
  process.stdout.write(`${result.event.operation_id}\n`);
} catch (err) {
  process.stderr.write(`[record-operation-event] ${err.message}\n`);
  process.exit(1);
}
