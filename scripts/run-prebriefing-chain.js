'use strict';

// run-prebriefing-chain.js
//
// Resumable runner for the pre-briefing self-heal chain (scheduled 2:45am CT by
// scripts/pre-briefing-diagnostic.bat). It runs the same 5 Graphiti/diagnostic
// steps the bat used to call sequentially, but through a per-day step cursor so a
// mid-chain crash/reboot resumes at the failed step on the next fire instead of
// restarting -- which previously re-ran the 30-day backfill and 1000-event drain
// every time and risked overrunning the 5:30 briefing.
//
// Behavior:
//   - One cursor per calendar day. Same-day re-run resumes at the first
//     non-completed step; a new day starts a fresh full run.
//   - On a step failure the cursor records it and the process exits non-zero, so
//     the next scheduled fire (or a manual re-run) resumes at that step.
//   - The chain steps are idempotent (Graphiti dedups by event id), so skipping
//     completed steps on resume is safe.
//
// Run:  node scripts/run-prebriefing-chain.js

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cursor = require('./lib/chain-cursor');

// The chain, in order. Each entry: [stepKey, [scriptRelToScriptsDir, ...args]].
// Same scripts + args the old bat invoked; the runner just gates them on the cursor.
const STEPS = [
  ['graphitiProviderHealth', ['graphiti-provider-health.js']],
  ['graphitiBackfill30', ['graphiti-backfill-last-30-days.js', '--days', '30']],
  ['graphitiEventDrain', ['graphiti-event-drain.js', '--max', '1000']],
  ['graphitiCoverage', ['graphiti-coverage-health.js', '--days', '30']],
  ['preBriefingDiagnostic', ['pre-briefing-diagnostic.js']],
];

// Local calendar date (the briefing day). Chain is daily, so the day is the
// natural cursor scope -- a new day means run everything again.
function todayDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Cursor lives next to the other agent state. SECONDBRAIN_DATA_DIR lets the
// runtime (desktop %APPDATA% / EC2 /opt) point at the live store; default to the
// repo's data/agent for local + test runs.
function cursorPath() {
  const base = process.env.SECONDBRAIN_DATA_DIR || path.join(__dirname, '..', 'data', 'agent');
  return path.join(base, 'prebriefing-chain-cursor.json');
}

function runStep(argv) {
  const scriptPath = path.join(__dirname, argv[0]);
  const result = spawnSync(process.execPath, [scriptPath, ...argv.slice(1)], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
  });
  return result.status === 0;
}

function main() {
  const chainDate = todayDate();
  const cPath = cursorPath();
  const stepNames = STEPS.map(([key]) => key);

  let c = cursor.loadCursor(cPath, chainDate);
  if (!c) {
    c = cursor.newCursor(chainDate, `prebrief-${chainDate}-${process.pid}`, stepNames);
    cursor.saveCursor(cPath, c);
  }

  const start = cursor.nextStepIndex(c);
  if (start >= STEPS.length) {
    console.log(`[prebriefing-chain] ${chainDate}: already complete, nothing to do.`);
    return 0;
  }
  if (start > 0) {
    console.log(
      `[prebriefing-chain] ${chainDate}: resuming at step ${start} (${stepNames[start]}).`,
    );
  }

  for (let i = start; i < STEPS.length; i += 1) {
    const [key, argv] = STEPS[i];
    console.log(`[prebriefing-chain] step ${i} ${key}: ${argv.join(' ')}`);
    cursor.markRunning(c, i);
    cursor.saveCursor(cPath, c);

    const ok = runStep(argv);
    if (!ok) {
      cursor.markFailed(c, i);
      cursor.saveCursor(cPath, c);
      console.error(`[prebriefing-chain] step ${i} ${key} FAILED; next run resumes here.`);
      process.exit(1);
    }
    cursor.markCompleted(c, i);
    cursor.saveCursor(cPath, c);
  }

  console.log(`[prebriefing-chain] ${chainDate}: chain complete.`);
  return 0;
}

// Only run when invoked directly (so the test can require the module for source
// inspection without executing the chain). spawnSync above is the real work.
if (require.main === module) {
  process.exit(main());
}

module.exports = { STEPS, todayDate, cursorPath, main };
