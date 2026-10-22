#!/usr/bin/env node
'use strict';

// Operator control for the self-test dispatch lease. Run on the host that owns
// the voice webhook (EC2):
//   node scripts/voice-selftest-dispatch-lease.js grant --minutes 30 --max 2 --purpose "phone dispatch e2e"
//   node scripts/voice-selftest-dispatch-lease.js status
//   node scripts/voice-selftest-dispatch-lease.js revoke

const lease = require('./lib/voice-selftest-dispatch-lease.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const command = process.argv[2] || 'status';
if (command === 'grant') {
  console.log(
    JSON.stringify(
      lease.grantLease({
        minutes: Number(arg('--minutes', 30)),
        maxDispatches: Number(arg('--max', 2)),
        grantedBy: arg('--by', process.env.USER || 'operator'),
        purpose: arg('--purpose', ''),
      }),
      null,
      2,
    ),
  );
} else if (command === 'revoke') {
  console.log(JSON.stringify({ revoked: lease.revokeLease() }));
} else {
  console.log(JSON.stringify({ live: lease.leaseLive(), lease: lease.readLease() }, null, 2));
}
