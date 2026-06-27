#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { probeDevOpsHealth } = require('./lib/devops-health.js');

function parseArgs(argv) {
  const out = {
    mainRoot: process.env.SECONDBRAIN_ROOT || path.join(require('node:os').homedir(), 'secondbrain'),
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--main-root') out.mainRoot = argv[++i] || out.mainRoot;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/verify-shared-checkout-clean.js [--main-root C:/Users/ExampleCod/secondbrain] [--json]',
  ].join('\n');
}

function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const probe = deps.probeDevOpsHealth || probeDevOpsHealth;
  const result = probe({ mainRoot: args.mainRoot });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Dev Ops: ${result.status.toUpperCase()} - ${result.detail}`);
  }
  return result.status === 'green' ? 0 : 1;
}

if (require.main === module) process.exit(main());

module.exports = {
  main,
  parseArgs,
  usage,
};
