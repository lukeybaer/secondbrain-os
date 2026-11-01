'use strict';

// Log a polling job's status only when it changes, plus a slow heartbeat.
//
// Why: a task that wakes every few minutes and prints the same "nothing to do"
// or the same stack trace each time turns its log into a flood of identical
// lines where a real change is impossible to find. The state lives in a small JSON file so
// each short-lived process can compare against the previous run.

const fs = require('fs');
const path = require('path');

const DEFAULT_HEARTBEAT_MS = 24 * 60 * 60 * 1000;

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeStateAtomic(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * @param {string} key        independent status channel (one state entry per key)
 * @param {string} message    text to print when the status changes
 * @param {object} opts
 * @param {string} opts.stateFile      JSON file holding the previous status per key (required)
 * @param {string} [opts.signature]    what "same status" means; defaults to message. Pass the
 *                                     first line of an error so a changing stack does not defeat it.
 * @param {number} [opts.now]          epoch ms (tests)
 * @param {number} [opts.heartbeatMs]  re-emit an unchanged status this often (default 24h)
 * @param {(line: string) => void} [opts.emit]  sink, default console.log
 * @returns {{ emitted: boolean, repeats: number, lines: string[] }}
 */
function logOnChange(key, message, opts = {}) {
  if (!opts.stateFile) throw new Error('logOnChange requires opts.stateFile');
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const heartbeatMs = Number.isFinite(opts.heartbeatMs) ? opts.heartbeatMs : DEFAULT_HEARTBEAT_MS;
  const emit = opts.emit || ((line) => console.log(line));
  const text = String(message);
  const signature = String(opts.signature === undefined ? text : opts.signature);
  const stamp = new Date(now).toISOString();
  const state = readState(opts.stateFile);
  const prev = state[key];
  const lines = [];

  if (!prev || prev.signature !== signature) {
    if (prev && prev.repeats > 0) {
      lines.push(`[${stamp}] previous status repeated ${prev.repeats} more time(s) since ${prev.since}`);
    }
    lines.push(`[${stamp}] ${text}`);
    state[key] = { signature, since: stamp, lastEmittedAtMs: now, repeats: 0 };
  } else {
    prev.repeats = (Number(prev.repeats) || 0) + 1;
    if (now - (Number(prev.lastEmittedAtMs) || 0) >= heartbeatMs) {
      lines.push(`[${stamp}] still: ${text.split('\n')[0]} (${prev.repeats} repeats since ${prev.since})`);
      prev.lastEmittedAtMs = now;
    }
  }

  try {
    writeStateAtomic(opts.stateFile, state);
  } catch {
    // State is a convenience. If it cannot be saved, say the status again rather
    // than risk hiding it (a failed write must never silence a real problem).
    if (!lines.length) lines.push(`[${stamp}] ${text}`);
  }

  for (const line of lines) emit(line);
  return { emitted: lines.length > 0, repeats: state[key].repeats, lines };
}

module.exports = { logOnChange, DEFAULT_HEARTBEAT_MS };
