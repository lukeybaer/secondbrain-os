'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RECEIPT_SCHEMA = 'amy.signal.flow-cycle.v1';
const MAX_CONSUMED_CYCLES = 8;

function appendCycleReceipt(file, receipt) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const row = {
    schema: RECEIPT_SCHEMA,
    at: new Date().toISOString(),
    consumed: false,
    ...receipt,
  };
  const payload = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    const written = fs.writeSync(fd, payload);
    if (written !== payload.length) {
      throw new Error(`Short Signal cycle receipt append: ${written}/${payload.length}`);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return row;
}

function readCycleReceipts(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const row = JSON.parse(line);
        return row && row.schema === RECEIPT_SCHEMA ? [row] : [];
      } catch {
        return [];
      }
    });
}

function stageReceipts(file, { eventId, stage } = {}) {
  return readCycleReceipts(file).filter(
    (row) =>
      (!eventId || String(row.eventId || '') === String(eventId)) &&
      (!stage || String(row.stage || '') === String(stage)),
  );
}

function stageAdmissionDecision(file, { eventId, stage, tactic, fingerprint } = {}) {
  const rows = stageReceipts(file, { eventId, stage });
  const consumedCycles = rows.filter((row) => row.consumed === true).length;
  if (consumedCycles >= MAX_CONSUMED_CYCLES) {
    return { allowed: false, reason: 'cycle-cap-exhausted', consumedCycles };
  }
  const repeated = rows.some(
    (row) =>
      row.consumed === true &&
      String(row.tactic || '') === String(tactic || '') &&
      String(row.fingerprint || '') === String(fingerprint || '') &&
      row.outcome !== 'progressed' &&
      row.outcome !== 'complete',
  );
  if (repeated) {
    return { allowed: false, reason: 'repeated-tactic-unchanged', consumedCycles };
  }
  return { allowed: true, reason: 'admitted', consumedCycles };
}

function attemptHistoryFile(stateRoot, eventId) {
  return path.join(stateRoot, 'attempts', `${eventId}.jsonl`);
}

function leaseFile(eventDir) {
  return path.join(eventDir, '.flow.lease');
}

async function withEventLease(eventDir, fn, options = {}) {
  const file = leaseFile(eventDir);
  const staleMs = Number(options.staleMs || 15 * 60 * 1000);
  fs.mkdirSync(eventDir, { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs <= staleMs) {
      return { acquired: false, reason: 'active-event-lease' };
    }
    fs.unlinkSync(file);
    fd = fs.openSync(file, 'wx', 0o600);
  }
  try {
    fs.writeFileSync(
      fd,
      `${JSON.stringify({ schema: 'amy.signal.flow-lease.v1', pid: process.pid, at: new Date().toISOString() })}\n`,
    );
    fs.fsyncSync(fd);
    return { acquired: true, value: await fn() };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // The lease path is still removed below.
    }
    try {
      fs.unlinkSync(file);
    } catch {
      // A missing lease after successful work is harmless.
    }
  }
}

module.exports = {
  MAX_CONSUMED_CYCLES,
  RECEIPT_SCHEMA,
  appendCycleReceipt,
  attemptHistoryFile,
  readCycleReceipts,
  stageAdmissionDecision,
  stageReceipts,
  withEventLease,
};
