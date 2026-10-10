#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { verifyLatestBackupRestore } = require('./lib/backup-restore-verifier.js');
const { writeBackupHealthReceipt } = require('./lib/backup-health.js');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

const dataDir =
  argValue('--data-dir') ||
  process.env.SECONDBRAIN_DATA_DIR ||
  path.join(process.env.APPDATA || '', 'secondbrain', 'data');
const restore = verifyLatestBackupRestore({ dataDir });
const health = writeBackupHealthReceipt({ dataDir });
process.stdout.write(`${JSON.stringify({ restore, health })}\n`);
process.exitCode = health.status === 'green' ? 0 : 1;
