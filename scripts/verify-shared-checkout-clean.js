#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { probeDevOpsHealth } = require('./lib/devops-health.js');
const { runReconciler } = require('./shared-checkout-reconciler.js');

function parseArgs(argv) {
  const out = {
    mainRoot: process.env.SB_MAIN_CHECKOUT || path.join(require('node:os').homedir(), 'secondbrain'),
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--main-root') out.mainRoot = argv[++i] || out.mainRoot;
    else if (a === '--json') out.json = true;
    else if (a === '--reconcile') out.reconcile = true;
    else if (a === '--write-snapshot') out.snapshotPath = argv[++i] || out.snapshotPath;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/verify-shared-checkout-clean.js [--main-root C:/Users/ExampleCod/secondbrain] [--reconcile] [--json] [--write-snapshot data/agent/devops-health-latest.json]',
  ].join('\n');
}

function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const probe = deps.probeDevOpsHealth || probeDevOpsHealth;
  const writeFileSync = deps.writeFileSync || fs.writeFileSync;
  const mkdirSync = deps.mkdirSync || fs.mkdirSync;
  const nowIso = deps.nowIso || (() => new Date().toISOString());
  const reconcile = deps.runReconciler || runReconciler;
  if (args.reconcile) {
    reconcile({ mainRoot: args.mainRoot }, deps);
  }
  const result = probe({ mainRoot: args.mainRoot });
  if (args.snapshotPath) {
    const snapshotPath = path.resolve(args.snapshotPath);
    mkdirSync(path.dirname(snapshotPath), { recursive: true });
    writeFileSync(
      snapshotPath,
      JSON.stringify({ generated_at: nowIso(), mainRoot: args.mainRoot, result }, null, 2) + '\n',
      'utf8',
    );
  }
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
