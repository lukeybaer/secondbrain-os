#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const {
  hasSshdAncestor,
  mintAttendedActionReceipt,
} = require('./lib/briefing-attended-action.js');

function arg(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? String(argv[index + 1] || '') : '';
}

function main() {
  const sshConnection = String(process.env.SSH_CONNECTION || '').trim();
  if (!sshConnection || !hasSshdAncestor()) {
    throw new Error('attended action mint requires a live SSH operator process ancestry');
  }
  const result = mintAttendedActionReceipt({
    dataDir: arg('data-dir'),
    token: process.env.BRIEFING_HUMAN_ACTION_TOKEN || arg('token'),
    date: arg('date'),
    cardId: arg('card'),
    workUnitId: arg('work-unit'),
    issuer: 'attended-ssh-exact-card',
    issuerProof: `sshd-ancestor:${crypto.createHash('sha256').update(sshConnection).digest('hex')}`,
  });
  process.stdout.write(`${result.file}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[mint-briefing-attended-action] ${error.message || error}\n`);
    process.exit(1);
  }
}

module.exports = { arg, main };
