#!/usr/bin/env node
'use strict';

// Appends the People File relay's job completion rows on EC2, but only for a
// Save whose identity apply already ran (it reached awaiting_git_relay).
//
// The Save endpoint queues its People File relay at click time, so the relay
// can land before the backprop worker ever applies the voice decision. Closing
// the job on that landing dropped the decision for good (PRIVATE_NAME, 2026-09-24).
// An unapplied Save stays open for the scheduler; the backprop worker's own
// landed-receipt reconcile closes it after its apply runs.
//
// usage: <jsonl rows on stdin> | node voice-confirmation-relay-completion.js <jobs.jsonl>

const fs = require('fs');
const { readVoiceConfirmationJobEvents } = require('./lib/voice-confirmation-jobs.js');

// Relay requests that are not owner Saves (exact-call People projections)
// have no apply step and no accepted row; they close on landing as before.
function relayCompletionRowsToAppend(rows, events) {
  const saves = new Set();
  const projected = new Set();
  const completed = new Set();
  for (const row of Array.isArray(events) ? events : []) {
    if (row?.job_status === 'accepted') saves.add(row.request_id);
    if (row?.job_status === 'awaiting_git_relay') projected.add(row.request_id);
  }
  for (const row of Array.isArray(events) ? events : []) {
    if (row?.request_id) {
      if (row.job_status === 'completed') completed.add(row.request_id);
      else completed.delete(row.request_id);
    }
  }
  return (Array.isArray(rows) ? rows : []).filter(
    (row) =>
      row?.request_id &&
      !completed.has(row.request_id) &&
      (!saves.has(row.request_id) || projected.has(row.request_id)),
  );
}

function main() {
  const jobsPath = process.argv[2];
  if (!jobsPath) {
    process.stderr.write('usage: voice-confirmation-relay-completion.js <jobs.jsonl>\n');
    process.exit(2);
  }
  const rows = fs
    .readFileSync(0, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const keep = relayCompletionRowsToAppend(rows, readVoiceConfirmationJobEvents(jobsPath));
  if (keep.length) fs.appendFileSync(jobsPath, keep.map((row) => `${JSON.stringify(row)}\n`).join(''));
  process.stdout.write(
    `${JSON.stringify({ appended: keep.length, held_unapplied: rows.length - keep.length })}\n`,
  );
}

if (require.main === module) main();

module.exports = { relayCompletionRowsToAppend };
