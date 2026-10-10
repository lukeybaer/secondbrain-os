#!/usr/bin/env node
'use strict';

/**
 * require-scan-check.js -- the deploy-outage prevention gate (ExampleCo 2026-07-06).
 *
 * INCIDENT this fixes: deploying ec2-server.js to /opt/secondbrain crashed the
 * PM2 backend for ~5 minutes with MODULE_NOT_FOUND: './scripts/lib/otter-archive-health'.
 * scripts/deploy-ec2-server.sh copies a hand-curated LIVE_DEPS file list; a
 * land added a new require() to ec2-server.js whose file was never added to
 * that list. `node -c` (the deploy script's only prior check) syntax-checks a
 * file but never resolves its requires, so the missing module was invisible
 * until PM2 actually loaded it and crash-looped in production.
 *
 * This CLI runs the static require-scan (scripts/lib/require-scan.js) against
 * one or more entry files under a root directory and prints every relative
 * require that does not resolve on disk. It is used in two places:
 *   1. scripts/deploy-ec2-server.sh -- run against the LIVE EC2 tree, AFTER
 *      copying files but BEFORE `pm2 restart`. A nonzero exit aborts the
 *      deploy before the old (still-working) process is touched.
 *   2. scripts/verify-unattended-morning.sh -- the nightly canary runs the
 *      same check so an incomplete deploy is caught overnight, not by a
 *      morning crash.
 *
 * Usage: node require-scan-check.js --root <dir> <entryFile> [entryFile...]
 *   entryFile paths may be absolute or relative to --root.
 * Exit 0 = every relative require resolved. Exit 1 = at least one is missing
 * (also printed to stderr, one per line, as "MISSING: <spec> (required from <file>)").
 */

const path = require('node:path');
const { scanRequireClosure } = require('./lib/require-scan.js');

function parseArgs(argv) {
  const args = { root: null, entries: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      args.root = argv[++i];
    } else {
      args.entries.push(argv[i]);
    }
  }
  return args;
}

function main() {
  const { root, entries } = parseArgs(process.argv.slice(2));
  if (!root || entries.length === 0) {
    console.error('Usage: node require-scan-check.js --root <dir> <entryFile> [entryFile...]');
    process.exit(2);
  }

  const entryFiles = entries.map((e) => (path.isAbsolute(e) ? e : path.join(root, e)));
  const result = scanRequireClosure({ entryFiles });

  if (result.ok) {
    console.log(`require-scan: OK (${result.scanned.length} file(s) scanned, 0 missing)`);
    process.exit(0);
  }

  console.error(`require-scan: MISSING ${result.missing.length} module(s):`);
  for (const m of result.missing) {
    const from = path.relative(root, m.from) || m.from;
    console.error(`  MISSING: ${m.spec} (required from ${from})`);
  }
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs };
