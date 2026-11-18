#!/usr/bin/env node
'use strict';

// Cancel stuck scheduled-skill promotion jobs (append-only; nothing is deleted).
// node scripts/cancel-promotion-jobs.js --data-dir <dir> --reason "<text>" --by "<who>" [--apply] <jobId>...
// Dry run unless --apply. Job ids may be unique prefixes of 8+ characters.

const { cancelPromotionJobs } = require('./lib/scheduled-skill-promotion-queue.js');

function parseArgs(argv) {
  const out = { jobIds: [], apply: false, dataDir: '', reason: '', by: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--data-dir') out.dataDir = argv[++i] || '';
    else if (arg === '--reason') out.reason = argv[++i] || '';
    else if (arg === '--by') out.by = argv[++i] || '';
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else out.jobIds.push(arg);
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.dataDir || !args.jobIds.length) {
    console.error('usage: node scripts/cancel-promotion-jobs.js --data-dir <dir> --reason "<text>" --by "<who>" [--apply] <jobId>...');
    return 2;
  }
  if (args.apply && (!args.reason || !args.by)) {
    console.error('--apply requires --reason and --by');
    return 2;
  }
  const result = cancelPromotionJobs({
    dataDir: args.dataDir,
    jobIds: args.jobIds,
    reason: args.reason,
    by: args.by,
    dryRun: !args.apply,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!args.apply) console.log('dry run: nothing written; pass --apply to cancel');
  return result.busy ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 2;
  }
}

module.exports = { parseArgs, main };
