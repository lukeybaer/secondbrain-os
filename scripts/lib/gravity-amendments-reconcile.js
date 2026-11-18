'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 5000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function canonicalRow(row) {
  return JSON.stringify(stableValue(row));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// identity 'content' is for append-only ledgers whose rows have no immutable
// event key. big-decisions.jsonl batch writers (memory consolidation) stamp
// several distinct decisions with one ts, and its undated 2026-07 rows share
// date/category, so only the whole row identifies a decision there.
function rowIdentity(row, canonical, mode = 'event') {
  if (mode === 'content') return `content:${sha256(canonical)}`;
  const explicit = row.id || row.event_id || row.amendment_id;
  if (explicit) return `explicit:${String(explicit)}`;
  const timestamp = row.ts || row.recorded_at || row.authorization_issued_at || '';
  if (timestamp) return `timestamp:${String(timestamp)}`;
  const identity = {
    date: row.date || '',
    approvedBy: row.approvedBy || '',
    file: row.file || '',
    // A timestamp is the immutable event key. For older undated rows, scope
    // distinguishes same-day approvals without making mutable content such as
    // reason/amendedRows part of the identity and hiding a rewrite conflict.
    scope: row.scope || '',
    session: row.session || '',
  };
  if (Object.values(identity).some(Boolean)) {
    return `fields:${sha256(JSON.stringify(identity))}`;
  }
  return `content:${sha256(canonical)}`;
}

function parseLedger(raw, label, identity = 'event') {
  const rows = [];
  for (const [index, original] of String(raw || '').split(/\r?\n/).entries()) {
    if (!original.trim()) continue;
    let row;
    try { row = JSON.parse(original); } catch { throw new Error(`${label} line ${index + 1} is not valid JSON`); }
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`${label} line ${index + 1} is not a JSON object`);
    }
    const canonical = canonicalRow(row);
    rows.push({ original, value: row, canonical, identity: rowIdentity(row, canonical, identity) });
  }
  return rows;
}

function indexLedger(rows, label) {
  const indexed = new Map();
  rows.forEach((row, index) => {
    const prior = indexed.get(row.identity);
    if (prior && prior.row.canonical !== row.canonical) {
      throw new Error(`${label} contains conflicting immutable Gravity rows (${row.identity})`);
    }
    if (!prior) indexed.set(row.identity, { row, index });
  });
  return indexed;
}

function reconcileContent(sourceRaw, durableRaw, { identity = 'event' } = {}) {
  const sourceRows = parseLedger(sourceRaw, 'tracked Gravity ledger', identity);
  const durableRows = parseLedger(durableRaw, 'durable Gravity ledger', identity);
  indexLedger(sourceRows, 'tracked Gravity ledger');
  const durableIndex = indexLedger(durableRows, 'durable Gravity ledger');
  let lastExistingIndex = -1;
  let sawMissingTrackedRow = false;
  const missing = [];
  for (const sourceRow of sourceRows) {
    const durable = durableIndex.get(sourceRow.identity);
    if (!durable) {
      sawMissingTrackedRow = true;
      missing.push(sourceRow.original);
      continue;
    }
    if (durable.row.canonical !== sourceRow.canonical) {
      throw new Error(`durable Gravity ledger conflicts with tracked immutable row (${sourceRow.identity})`);
    }
    if (durable.index < lastExistingIndex) {
      throw new Error('durable Gravity ledger contains tracked rows out of canonical order');
    }
    if (sawMissingTrackedRow) {
      throw new Error('durable Gravity ledger is not a compatible tracked-row prefix');
    }
    lastExistingIndex = durable.index;
  }
  // Ensure a durable-only row cannot silently claim the identity of a later
  // tracked amendment. indexLedger plus the comparison above owns conflicts;
  // unrelated runtime rows remain byte-for-byte intact.
  if (identity === 'content' && missing.length) {
    // Content identity alone sees an in-place rewrite of the final tracked row
    // as a new row and would append it beside the stale one (Codex review
    // 573e887666aa). A durable row that matches no tracked row but shares the
    // event key of a missing tracked row is that rewrite: fail closed.
    const sourceContent = new Set(sourceRows.map((row) => row.identity));
    const unmatchedEventKeys = new Set(durableRows
      .filter((row) => !sourceContent.has(row.identity))
      .map((row) => rowIdentity(row.value, row.canonical, 'event')));
    for (const row of sourceRows) {
      if (durableIndex.has(row.identity)) continue;
      const eventKey = rowIdentity(row.value, row.canonical, 'event');
      if (unmatchedEventKeys.has(eventKey)) {
        throw new Error(`durable Gravity ledger rewrote a tracked row in place (${eventKey})`);
      }
    }
  }
  if (!missing.length) return { changed: false, content: durableRaw, appended: 0 };
  const separator = durableRaw && !durableRaw.endsWith('\n') ? '\n' : '';
  return {
    changed: true,
    content: `${durableRaw}${separator}${missing.join('\n')}\n`,
    appended: missing.length,
  };
}

function acquireLock(lockDir, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      return () => fs.rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) {
        throw new Error(`Gravity ledger reconciliation lock unavailable: ${error.message}`);
      }
      sleepSync(LOCK_WAIT_MS);
    }
  }
}

function fsyncDirectory(directory) {
  // Linux requires the containing directory to be synced after link/rename
  // before the new directory entry is crash-durable. Some development
  // filesystems (notably Windows) reject directory handles; production is
  // Linux, so ignore only those platform-specific unsupported cases.
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    const unsupportedOnWindows = process.platform === 'win32' &&
      ['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code);
    if (!unsupportedOnWindows) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeTemp(file, content) {
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return temp;
}

function reconcileGravityAmendments({
  sourceFile,
  targetFile,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
  beforePublish,
  identity = 'event',
} = {}) {
  if (!['event', 'content'].includes(identity)) throw new Error(`unknown identity mode: ${identity}`);
  if (!sourceFile || !targetFile) throw new Error('sourceFile and targetFile are required');
  const sourceRaw = fs.readFileSync(sourceFile, 'utf8');
  // Validate the canonical source before touching durable state.
  const sourceRows = parseLedger(sourceRaw, 'tracked Gravity ledger', identity);
  indexLedger(sourceRows, 'tracked Gravity ledger');
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  const release = acquireLock(`${targetFile}.reconcile.lock`, { timeoutMs: lockTimeoutMs });
  let temp = '';
  try {
    if (!fs.existsSync(targetFile)) {
      const seeded = sourceRows.map((row) => row.original).join('\n');
      temp = writeTemp(targetFile, seeded ? `${seeded}\n` : '');
      try {
        // Hard-link publication is atomic and fails rather than clobbering a
        // target another first-run creator published concurrently.
        fs.linkSync(temp, targetFile);
        fsyncDirectory(path.dirname(targetFile));
        return { changed: true, seeded: true, appended: sourceRows.length };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      } finally {
        fs.rmSync(temp, { force: true });
        temp = '';
      }
    }
    const before = fs.readFileSync(targetFile, 'utf8');
    const result = reconcileContent(sourceRaw, before, { identity });
    if (!result.changed) return { changed: false, seeded: false, appended: 0 };
    temp = writeTemp(targetFile, result.content);
    if (fs.readFileSync(targetFile, 'utf8') !== before) {
      throw new Error('durable Gravity ledger changed during reconciliation');
    }
    if (typeof beforePublish === 'function') beforePublish();
    fs.renameSync(temp, targetFile);
    temp = '';
    fsyncDirectory(path.dirname(targetFile));
    return { changed: true, seeded: false, appended: result.appended };
  } finally {
    if (temp) fs.rmSync(temp, { force: true });
    release();
  }
}

function appendGravityAmendment({
  targetFile,
  row,
  idempotencyDate = '',
  lockTimeoutMs = LOCK_TIMEOUT_MS,
} = {}) {
  if (!targetFile || !row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('targetFile and an amendment row object are required');
  }
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  const release = acquireLock(`${targetFile}.reconcile.lock`, { timeoutMs: lockTimeoutMs });
  try {
    const before = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8') : '';
    const existingRows = parseLedger(before, 'durable Gravity ledger');
    indexLedger(existingRows, 'durable Gravity ledger');
    if (idempotencyDate && existingRows.some((entry) => entry.value.date === idempotencyDate)) {
      return false;
    }
    const separator = before && !before.endsWith('\n') ? '\n' : '';
    const fd = fs.openSync(targetFile, 'a', 0o600);
    try {
      fs.writeFileSync(fd, `${separator}${JSON.stringify(row)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fsyncDirectory(path.dirname(targetFile));
    return true;
  } finally {
    release();
  }
}

// g24 needs the principal approval file next to the ledger in shared data, but
// the release replaces its tracked data/ with the shared symlink, so a landed
// approval never reached EC2 (2026-10-21 g24 false VIOLATED). The latest file
// alone cannot prove a prior-day grade once a newer approval replaces it, so
// every approval is also kept as an immutable date-keyed receipt
// (gravity-amendment-approval-YYYY-MM-DD.json) that g24 reads by graded date.
// The latest file is replaced only when it is invalid or older; a newer
// runtime approval (for example a chat approval) is never downgraded.
function validGravityApproval(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const date = String(value.date || '');
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    !Number.isNaN(Date.parse(`${date}T12:00:00Z`)) &&
    new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date &&
    ['owner', 'PRIVATE_NAME'].includes(String(value.approvedBy || '').toLowerCase()) &&
    String(value.reason || '').trim().length > 0
  );
}

function datedApprovalPath(targetFile, date) {
  return path.join(path.dirname(targetFile), `gravity-amendment-approval-${date}.json`);
}

function readJsonOrNull(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function publishGravityApproval({ sourceFile, targetFile } = {}) {
  if (!sourceFile || !targetFile) throw new Error('sourceFile and targetFile are required');
  const sourceRaw = fs.readFileSync(sourceFile, 'utf8');
  const source = JSON.parse(sourceRaw);
  if (!validGravityApproval(source)) {
    throw new Error('tracked Gravity approval needs approvedBy owner|PRIVATE_NAME, a valid YYYY-MM-DD date, and a reason');
  }
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  const release = acquireLock(`${targetFile}.reconcile.lock`);
  let temp = '';
  try {
    let datedWritten = false;
    const dated = datedApprovalPath(targetFile, source.date);
    if (!validGravityApproval(readJsonOrNull(dated))) {
      temp = writeTemp(dated, sourceRaw);
      fs.renameSync(temp, dated);
      temp = '';
      datedWritten = true;
    }
    const current = readJsonOrNull(targetFile);
    const latestWritten = !validGravityApproval(current) || String(current.date) < source.date;
    if (latestWritten) {
      temp = writeTemp(targetFile, sourceRaw);
      fs.renameSync(temp, targetFile);
      temp = '';
    }
    if (datedWritten || latestWritten) fsyncDirectory(path.dirname(targetFile));
    return { changed: datedWritten || latestWritten, datedWritten, latestWritten, date: source.date };
  } finally {
    if (temp) fs.rmSync(temp, { force: true });
    release();
  }
}

function main(argv = process.argv.slice(2)) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : '';
  };
  if (argv.includes('--approval')) {
    const published = publishGravityApproval({ sourceFile: value('--source'), targetFile: value('--target') });
    console.log(JSON.stringify(published));
    return published;
  }
  const result = reconcileGravityAmendments({
    sourceFile: value('--source'),
    targetFile: value('--target'),
    identity: value('--identity') || 'event',
  });
  console.log(JSON.stringify(result));
  return result;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = {
  acquireLock,
  appendGravityAmendment,
  canonicalRow,
  fsyncDirectory,
  datedApprovalPath,
  parseLedger,
  publishGravityApproval,
  validGravityApproval,
  reconcileContent,
  reconcileGravityAmendments,
  rowIdentity,
};
