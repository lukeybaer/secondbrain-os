#!/usr/bin/env node
'use strict';

/**
 * spine-reconcile.js -- close the rows in the Task store that are not work.
 *
 *   node scripts/spine-reconcile.js --dry-run [--tasks-dir D] [--data-dir D] [--json]
 *   node scripts/spine-reconcile.js --apply   [--tasks-dir D] [--data-dir D]
 *
 * Dry run is the default and never writes. Apply changes status only (via the
 * ingress writer); no record is deleted. See scripts/lib/spine-reconcile.js.
 */

const path = require('node:path');
const { defaultDataDir, resolveTasksDir } = require('./lib/spine-ingress.js');
const { planReconcile, applyReconcile } = require('./lib/spine-reconcile.js');

function parse(argv) {
  const out = { apply: false, json: false, tasksDir: '', dataDir: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--json') out.json = true;
    else if (a === '--tasks-dir') out.tasksDir = argv[(i += 1)];
    else if (a === '--data-dir') out.dataDir = argv[(i += 1)];
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const args = parse(argv);
  const dataDir = args.dataDir || defaultDataDir();
  const opts = { dataDir, tasksDir: args.tasksDir || resolveTasksDir({}) || path.join(dataDir, 'tasks') };
  if (args.apply) {
    const { plan, result } = applyReconcile(opts);
    const summary = { mode: 'apply', counts: plan.counts, result };
    console.log(JSON.stringify(summary, null, args.json ? 2 : 0));
    return result.errors.length ? 1 : 0;
  }
  const plan = planReconcile(opts);
  const summary = { mode: 'dry-run', tasksDir: opts.tasksDir, counts: plan.counts };
  if (args.json) summary.sample = {
    passiveIntake: plan.passiveIntake.slice(0, 3),
    orphans: plan.orphans.slice(0, 20),
    ownedElsewhere: plan.ownedElsewhere.slice(0, 20),
  };
  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { main, parse };
