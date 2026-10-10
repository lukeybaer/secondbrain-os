#!/usr/bin/env node
'use strict';

// Command-line bridge to recordOutboundSend for non-Node senders (the Python
// Gmail SMTP sender). The message body arrives on stdin and is stored only as
// a sha256. Usage:
//   node scripts/record-outbound-send.js --surface <s> --authorization <a>
//        [--recipients a@x.com,b@y.com] [--send-ok amy|ExampleCo-approved] < body

const fs = require('node:fs');
const { recordOutboundSend } = require('./lib/outbound-send-record.js');

function arg(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] || '') : '';
}

function main(argv = process.argv.slice(2), readStdin = () => fs.readFileSync(0, 'utf8')) {
  const surface = arg(argv, '--surface');
  if (!surface) return { recorded: false, reason: 'missing --surface' };
  let content = '';
  try { content = readStdin(); } catch { /* no body on stdin */ }
  const sendOk = arg(argv, '--send-ok');
  return recordOutboundSend({
    surface,
    authorization: arg(argv, '--authorization') || 'none',
    recipients: arg(argv, '--recipients'),
    content,
    details: sendOk ? { send_ok: sendOk } : {},
    dataDir: process.env.SECONDBRAIN_DATA_DIR || undefined,
  });
}

if (require.main === module) {
  const result = main();
  process.stdout.write(`${JSON.stringify({ recorded: Boolean(result?.recorded) })}\n`);
}

module.exports = { main };
