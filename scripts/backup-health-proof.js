#!/usr/bin/env node
const path = require('node:path');
const { writeBackupHealthReceipt } = require('./lib/backup-health.js');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

const dataDir =
  argValue('--data-dir') ||
  process.env.SECONDBRAIN_DATA_DIR ||
  path.join(process.env.APPDATA || '', 'secondbrain', 'data');
const receipt = writeBackupHealthReceipt({ dataDir });
process.stdout.write(`${JSON.stringify(receipt)}\n`);
process.exitCode = receipt.status === 'green' ? 0 : 1;
