#!/usr/bin/env node
'use strict';
// CLI: node scripts/approval-ledger.js record <type> <approved|edited|rejected|regretted> [note]
//      node scripts/approval-ledger.js status <type> | list
//      node scripts/approval-ledger.js asks <asks.json>  (array of {type,summary,recommendation,default})
const fs = require('node:fs');
const { createApprovalLedger } = require('./lib/approval-ledger.js');

function main(argv = process.argv.slice(2), out = console.log) {
  const [cmd, a, b, ...rest] = argv;
  const ledger = createApprovalLedger();
  if (cmd === 'record') {
    return out(
      JSON.stringify(ledger.record(a, b, { source: 'cli', note: rest.join(' ') }), null, 2),
    );
  }
  if (cmd === 'status') return out(JSON.stringify(ledger.status(a), null, 2));
  if (cmd === 'list') return out(JSON.stringify(ledger.list(), null, 2));
  if (cmd === 'asks') {
    const result = ledger.batchAsks(JSON.parse(fs.readFileSync(a, 'utf8')));
    return out(result.text || '(nothing to ask; proceed and report)');
  }
  out('usage: approval-ledger.js record|status|list|asks ...');
  process.exitCode = 2;
}

if (require.main === module) main();
module.exports = { main };
