#!/usr/bin/env node
'use strict';

/**
 * Drain the desktop capability queue. REQUIRED before rolling back to a release
 * older than 2026-08-25.
 *
 * Why this exists (deploy-gate review 5982f14e5658): the request signature now
 * covers `expires_at` and `origin_channel`. The previous release signs only
 * through `invocation_key`, and its `claimDesktopCapability` verifies the
 * signature BEFORE it looks at status, then THROWS on mismatch. So a single
 * new-format request left in the queue makes the rolled-back claimant refuse
 * every request behind it, including ones it could otherwise serve. The change
 * is therefore not "additive and reversible", which the deploy brief wrongly
 * claimed.
 *
 * Draining is safe: a queued request lives at most its TTL, and this expires
 * anything still live first, so its owner is told it will not run rather than
 * having it vanish. Nothing is deleted; pairs move to `archive/`.
 *
 *   node scripts/drain-desktop-capability-queue.js            # report only
 *   node scripts/drain-desktop-capability-queue.js --apply    # drain
 */

const path = require('path');
const {
  drainDesktopCapabilityQueue,
  pendingTerminalNotices,
} = require('./lib/desktop-capability-relay.js');

function defaultDataDir(env = process.env) {
  if (env.SECONDBRAIN_DATA_DIR) return env.SECONDBRAIN_DATA_DIR;
  if (process.platform === 'linux') return '/opt/secondbrain/data';
  return path.join(env.APPDATA || process.cwd(), 'secondbrain', 'data');
}

function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const index = argv.indexOf('--data-dir');
  const dataDir = index >= 0 && argv[index + 1] ? argv[index + 1] : defaultDataDir();

  if (!apply) {
    // Report what a drain would touch, and warn about notices still owed: those
    // are outcomes a human has not been told about yet.
    let owed = [];
    try {
      owed = pendingTerminalNotices({ dataDir });
    } catch {
      owed = [];
    }
    return {
      ok: true,
      dryRun: true,
      dataDir,
      notices_still_owed: owed.length,
      hint: 'Deliver owed notices first if possible, then re-run with --apply.',
    };
  }
  const result = { ...drainDesktopCapabilityQueue({ dataDir }), dataDir, dryRun: false };
  if (!result.ok) {
    // Fail closed and say why. Exiting 0 with new-format records still in the
    // queue is how a rollback walks into the exact signature failure this
    // command exists to prevent (deploy-gate review 93b4b1a1a608).
    result.blocker = result.held.length
      ? `the desktop is still holding ${result.held.length} request(s) under a live lease`
      : result.owed.length
        ? `${result.owed.length} terminal outcome(s) still owe their owner a notice`
        : `${result.remaining} request(s) could not be archived`;
    result.hint = 'Wait for in-flight work and notice delivery, then re-run. Do NOT roll back while this reports ok:false.';
  }
  return result;
}

if (require.main === module) {
  try {
    const result = main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.ok === false) process.exitCode = 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}

module.exports = { defaultDataDir, main };
