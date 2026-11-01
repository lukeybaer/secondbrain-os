'use strict';

// chain-cursor.js
//
// A tiny, dependency-free resumable step-cursor for sequential script chains
// (Inngest/Temporal "step memoization" reduced to its essence: a per-step status
// ledger keyed by a deterministic step name). It exists so the pre-briefing
// self-heal chain can resume at the step it died on instead of restarting the
// whole chain -- which previously re-ran the 30-day Graphiti backfill and the
// 1000-event drain on every 3am crash, frequently overrunning the 5:30 briefing.
//
// Design:
//   - Pure functions over a plain cursor object; the runner owns the date + path
//     so this stays trivially unit-testable with no clock/fs coupling.
//   - One cursor per calendar day (chain_date). A new day => caller starts fresh
//     (a full daily run is intended); a same-day reload resumes the saved cursor.
//   - Atomic save (tmp + rename) so a crash mid-write never leaves a torn cursor.
//   - Steps the chain runs are idempotent (Graphiti dedups by event id), so
//     skipping COMPLETED steps on resume is always safe; the only thing we never
//     skip is the step that failed.

const fs = require('node:fs');
const path = require('node:path');

const STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

/**
 * Build a fresh cursor for one chain run on a given calendar day.
 * @param {string} chainDate  YYYY-MM-DD (caller's local/CT date).
 * @param {string} runId      opaque id for this run (for log correlation).
 * @param {string[]} stepNames ordered step names.
 */
function newCursor(chainDate, runId, stepNames) {
  return {
    chain_date: chainDate,
    run_id: runId,
    created_at: new Date().toISOString(),
    steps: stepNames.map((name) => ({
      name,
      status: STATUS.PENDING,
      attempts: 0,
      started_at: null,
      completed_at: null,
    })),
  };
}

/** First step index whose status !== 'completed'. Equals steps.length when done. */
function nextStepIndex(cursor) {
  const idx = cursor.steps.findIndex((s) => s.status !== STATUS.COMPLETED);
  return idx === -1 ? cursor.steps.length : idx;
}

function markRunning(cursor, idx) {
  const step = cursor.steps[idx];
  step.status = STATUS.RUNNING;
  step.attempts += 1;
  step.started_at = new Date().toISOString();
  return cursor;
}

function markCompleted(cursor, idx) {
  const step = cursor.steps[idx];
  step.status = STATUS.COMPLETED;
  step.completed_at = new Date().toISOString();
  return cursor;
}

function markFailed(cursor, idx) {
  cursor.steps[idx].status = STATUS.FAILED;
  return cursor;
}

/**
 * Load the cursor at `cursorPath` only if it belongs to `chainDate`.
 * Returns null when the file is missing, unparseable, or from another day
 * (a stale-day cursor must be ignored so today gets a full fresh run).
 */
function loadCursor(cursorPath, chainDate) {
  try {
    const raw = fs.readFileSync(cursorPath, 'utf8');
    const cursor = JSON.parse(raw);
    if (!cursor || cursor.chain_date !== chainDate || !Array.isArray(cursor.steps)) {
      return null;
    }
    return cursor;
  } catch {
    return null;
  }
}

/** Atomically persist the cursor (write tmp, then rename over the target). */
function saveCursor(cursorPath, cursor) {
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  const tmp = cursorPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cursor, null, 2));
  fs.renameSync(tmp, cursorPath);
  return cursor;
}

module.exports = {
  STATUS,
  newCursor,
  nextStepIndex,
  markRunning,
  markCompleted,
  markFailed,
  loadCursor,
  saveCursor,
};
