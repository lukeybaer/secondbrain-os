#!/usr/bin/env node
'use strict';
//
// refresh-briefing-card-snapshots.js -- the single idempotent producer runner
// for DESKTOP-generated briefing card snapshots that used to go
// stale-red overnight because nothing regenerated them on a cadence:
//
//   * git-hygiene-snapshot.json  (card: UNCOMMITTED & PARKED WORK)
//   * devops-health-latest.json  (card: SYSTEM HEALTH / Dev Ops subsystem)
//   * the life-archive health snapshot (card: FULL-LIFE DATA BACKUP)
//
// It regenerates BOTH against the desktop shared checkout and ships each to EC2,
// reusing the existing writers/transport (publish-git-hygiene-snapshot.js and
// verify-shared-checkout-clean.js) via scripts/lib/briefing-card-producers.js.
//
// CARD INDEPENDENCE (ExampleCo's contract): each snapshot is produced on its OWN
// timeline. There is NO monolithic "block until all fresh" gate. One producer
// failing does NOT abort the other -- each runs in its own try/catch inside
// runAllProducers. Every git subprocess is wall-clock bounded (classifyGitState
// via SB_GIT_TIMEOUT_MS, default 45s; probeDevOpsHealth git status 10s) so the
// runner can never hang; the effective git bound is logged for honesty.
//
// Safe to run every couple of hours (idempotent: each run overwrites with a
// fresh snapshot and ships it). SCHEDULING is an OS concern -- a Windows
// Scheduled Task on the desktop invokes this. This script does not schedule
// itself.
//
// USAGE:
//   node scripts/refresh-briefing-card-snapshots.js [--no-ship]
//        [--data-dir DIR] [--main-root DIR] [--git-timeout-ms N] [--json]
//
// EXIT CODES: 0 = every producer regenerated (and shipped, unless --no-ship).
//             1 = at least one producer failed (loud; the others still ran).
//             2 = usage error.

const {
  runAllProducers,
  runProducer,
  producerById,
  defaultDataDir,
  defaultMainRoot,
} = require('./lib/briefing-card-producers.js');

let ctDayKeyForInstant;
try {
  ({ ctDayKeyForInstant } = require('./lib/ct-day.js'));
} catch {
  ctDayKeyForInstant = () => new Date().toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const opts = { ship: true, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--no-ship') opts.ship = false;
    else if (a === '--data-dir') opts.dataDir = argv[++i];
    else if (a === '--main-root') opts.mainRoot = argv[++i];
    else if (a === '--producer') opts.producerId = argv[++i];
    else if (a === '--git-timeout-ms') opts.gitTimeoutMs = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else {
      console.error(`[refresh-briefing-card-snapshots] ExampleCo flag: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/refresh-briefing-card-snapshots.js [--no-ship] [--data-dir DIR]',
    '       [--main-root DIR] [--producer ID] [--git-timeout-ms N] [--json]',
  ].join('\n');
}

function main(argv = process.argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(usage());
    return 0;
  }

  // Bound every git subprocess (never hang). classifyGitState reads
  // SB_GIT_TIMEOUT_MS; honor an explicit --git-timeout-ms, else keep whatever is
  // set, else fall back to the library default of 45s. Always LOG the effective
  // bound so a scheduled run is honest about how it protects against a wedged git.
  if (opts.gitTimeoutMs) process.env.SB_GIT_TIMEOUT_MS = String(opts.gitTimeoutMs);
  const effectiveGitTimeout = process.env.SB_GIT_TIMEOUT_MS || '45000 (library default)';

  const dataDir = opts.dataDir || defaultDataDir();
  const mainRoot = opts.mainRoot || defaultMainRoot();
  const today = ctDayKeyForInstant();

  console.log(
    `[refresh-briefing-card-snapshots] start dataDir=${dataDir} mainRoot=${mainRoot} ` +
      `ship=${opts.ship} gitTimeoutMs=${effectiveGitTimeout} today=${today}`,
  );

  const runOptions = { dataDir, mainRoot, today, ship: opts.ship, logger: console };
  let results;
  let ok;
  if (opts.producerId) {
    const producer = producerById(opts.producerId);
    if (!producer) {
      console.error(`[refresh-briefing-card-snapshots] ExampleCo producer: ${opts.producerId}`);
      return 2;
    }
    const result = runProducer(producer, runOptions);
    results = [result];
    ok = result.ok;
  } else {
    ({ results, ok } = runAllProducers(runOptions));
  }

  const summary = {
    ok,
    ship: opts.ship,
    dataDir,
    mainRoot,
    producers: results.map((r) => ({
      id: r.id,
      cardIds: r.cardIds,
      ok: r.ok,
      ran: r.ran,
      shipped: r.shipped,
      staleBefore: r.staleBefore,
      wasAgedMs: r.ageBeforeMs,
      verdict: r.verdict,
      error: r.error,
    })),
  };

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    for (const r of summary.producers) {
      const state = r.ok ? 'OK' : 'FAILED';
      const shipState = !opts.ship ? 'ship-skipped' : r.shipped ? 'shipped' : 'not-shipped';
      console.log(
        `[refresh-briefing-card-snapshots] ${r.id}: ${state} (ran=${r.ran}, ${shipState}` +
          `${r.error ? `, error=${r.error}` : ''})`,
      );
    }
    console.log(`[refresh-briefing-card-snapshots] overall: ${ok ? 'OK' : 'FAILED'}`);
  }

  return ok ? 0 : 1;
}

if (require.main === module) process.exit(main());

module.exports = { main, parseArgs, usage };
