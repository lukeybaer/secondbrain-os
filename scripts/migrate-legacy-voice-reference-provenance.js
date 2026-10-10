#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  MIGRATION_AUTHORITY,
  migrateLegacyTrustedReferences,
} = require('./lib/voice-reference-provenance.js');

function parseArgs(argv) {
  const out = {
    write: false,
    requireCurrent: false,
    aliasDataRoots: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') out.write = true;
    else if (arg === '--require-current') out.requireCurrent = true;
    else if (arg === '--data-dir') out.dataDir = argv[++index];
    else if (arg === '--registry') out.registryPath = argv[++index];
    else if (arg === '--alias-data-root') out.aliasDataRoots.push(argv[++index]);
    else if (arg === '--migrated-at') out.migratedAt = argv[++index];
    else if (arg === '--help') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/migrate-legacy-voice-reference-provenance.js [--write] [--require-current] [--data-dir DIR] [--alias-data-root DIR] [--registry FILE]\n',
    );
    return;
  }
  const repo = path.resolve(__dirname, '..');
  const dataDir = path.resolve(
    args.dataDir ||
      process.env.SECONDBRAIN_DATA_DIR ||
      path.join(repo, 'data'),
  );
  const registryPath = path.resolve(
    args.registryPath ||
      path.join(dataDir, 'life-archive', 'voice-identity-registry.json'),
  );
  const result = migrateLegacyTrustedReferences({
    registryPath,
    dataDir,
    authority: MIGRATION_AUTHORITY,
    migratedAt: args.migratedAt,
    aliasDataRoots: args.aliasDataRoots.map((root) => path.resolve(root)),
    write: args.write,
  });
  process.stdout.write(`${JSON.stringify(result.audit, null, 2)}\n`);
  if (!result.ok) process.exitCode = 2;
  else if (args.requireCurrent && result.audit.stamped > 0) {
    process.stderr.write(
      `legacy voice reference provenance preflight failed: ${result.audit.stamped} trusted enrollment(s) still require an immutable stamp\n`,
    );
    process.exitCode = 3;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `legacy voice reference migration failed: ${error?.message || error}\n`,
  );
  process.exitCode = 1;
}
