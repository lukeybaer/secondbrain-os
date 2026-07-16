#!/usr/bin/env node
'use strict';

// scripts/self-heal/card-blocker-lessons-fallback-capture.js
//
// STRUCTURED LESSON CAPTURE, coverage fix (Codex review 2026-07-12): the
// primary chokepoint (scripts/agentic-healer-driver.js feedSelfHealHealth)
// only fires when the agentic healer actually runs. `BRIEFING_SKIP_AGENTIC_HEALER=1`
// makes the whole driver never start, which would silently mean "no lesson
// captured" on exactly the days an operator most needs the loop working.
//
// This script is the fallback: it reads the live board artifact this run's
// OWN build/publish just wrote (never a stale or missing one -- that would be
// fabrication, not a lesson) and records one lesson row per still-defective
// card directly, via cardBlockerLessons.recordFromLiveBoardArtifact. Invoked
// from scripts/ec2-morning-briefing-run.sh ONLY in the
// BRIEFING_SKIP_AGENTIC_HEALER=1 branches, on both runner paths. Never fails
// the runner: a bad read or write here degrades to zero rows, not a crash.
//
// CLI: node scripts/self-heal/card-blocker-lessons-fallback-capture.js [--date YYYY-MM-DD] [--data-dir DIR] [--reason TEXT]

const cardBlockerLessons = require('./card-blocker-lessons.js');
const { readLiveBoardArtifact } = require('../lib/live-board-truth.js');
const agenticHealer = require('../agentic-healer-driver.js');

function parseCliArgs(argv) {
  const opts = {};
  let date;
  let reason = 'agentic healer did not run this cycle (BRIEFING_SKIP_AGENTIC_HEALER=1)';
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--date') date = argv[++i];
    else if (argv[i] === '--data-dir') opts.dataDir = argv[++i];
    else if (argv[i] === '--reason') reason = argv[++i];
  }
  return { opts, date, reason };
}

function run({ opts = {}, date, reason } = {}) {
  const envelope = readLiveBoardArtifact({ dataDir: opts.dataDir, repo: opts.repo });
  const artifact = envelope && envelope.artifact;
  if (!artifact) {
    return { written: 0, skipped: 'no-artifact' };
  }
  if (envelope.stale) {
    return { written: 0, skipped: 'stale-artifact' };
  }
  const tacticRows = agenticHealer.readTacticRows(opts);
  const written = cardBlockerLessons.recordFromLiveBoardArtifact({
    date: date || artifact.date,
    artifact,
    tacticRows,
    reasonNote: reason,
    opts,
  });
  return { written: written.length, skipped: null };
}

function main() {
  const { opts, date, reason } = parseCliArgs(process.argv);
  const result = run({ opts, date, reason });
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = { parseCliArgs, run };

if (require.main === module) main();
