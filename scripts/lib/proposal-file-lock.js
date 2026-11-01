'use strict';

// One writer at a time for a day's viral-tech-clips/<date>.json. The nightly
// scanner and an owner video request both read-modify-write that file; without
// this lock one silently drops the other's proposals (Codex ec2-deploy review,
// 2026-10-16).

const fs = require('fs');
const path = require('path');

const STALE_MS = 60_000;
const WAIT_MS = 15_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withProposalFileLock(file, fn, { waitMs = WAIT_MS, staleMs = STALE_MS, nowMs = Date.now } = {}) {
  const lockFile = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = nowMs() + waitMs;
  let fd = null;
  while (fd == null) {
    try {
      fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid}\n`);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (nowMs() - fs.statSync(lockFile).mtimeMs > staleMs) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {
        continue;
      }
      if (nowMs() >= deadline) {
        const busy = new Error(`proposal file busy: ${path.basename(file)}`);
        busy.code = 'PROPOSAL_FILE_BUSY';
        throw busy;
      }
      sleepSync(100);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(lockFile);
    } catch {
      /* a stale-lock recovery already removed it */
    }
  }
}

function readProposalState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    // A corrupt or half-written file is never treated as empty: rewriting it
    // would delete every proposal in it.
    throw new Error(`proposal file unreadable, refusing to rewrite: ${path.basename(file)}: ${error.message}`);
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// Write one proposal into the CURRENT file under the lock, so a writer that
// read the file earlier never drops proposals another writer added since.
function writeProposalById(file, proposal, fallbackState) {
  return withProposalFileLock(file, () => {
    const state = readProposalState(file) || fallbackState || { proposals: [] };
    if (!Array.isArray(state.proposals)) state.proposals = [];
    const ix = state.proposals.findIndex((p) => p && p.id === proposal.id);
    if (ix === -1) state.proposals.push(proposal);
    else state.proposals[ix] = proposal;
    writeJsonAtomic(file, state);
    return state;
  });
}

module.exports = { readProposalState, withProposalFileLock, writeJsonAtomic, writeProposalById };
