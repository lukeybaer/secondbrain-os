'use strict';

// Append-only run log for the PC session sweep. The sweep is killed silently by the Task
// Scheduler time limit and used to leave no trace of what a run delivered (Oct 26 2026).
// One JSON line per start, per delivered batch, and per end or error. Capped: when the file
// passes maxBytes it is rotated to <file>.1 (replacing the previous rotation), so the log
// never exceeds about twice maxBytes. Logging must never break a sweep.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 1024 * 1024;

function appendRunLog(file, entry, { maxBytes = DEFAULT_MAX_BYTES, now = new Date() } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size >= maxBytes) fs.renameSync(file, `${file}.1`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    fs.appendFileSync(file, `${JSON.stringify({ at: now.toISOString(), pid: process.pid, ...entry })}\n`);
    return true;
  } catch {
    return false;
  }
}

module.exports = { appendRunLog, DEFAULT_MAX_BYTES };
