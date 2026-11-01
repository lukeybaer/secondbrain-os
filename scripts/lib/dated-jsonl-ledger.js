'use strict';

// scripts/lib/dated-jsonl-ledger.js
//
// PACKET C (item 2): shared bounded ledger helper, modeled on the already-
// working scripts/lib/overnight-report-event-ledger.js per-date pattern.
// overnight-agentic-healer-runs.jsonl grew to 29MB / 3,257 lines / 345KB max
// single line, read whole-file on every single-defect healer invocation
// (scripts/agentic-healer-driver.js) with no rotation anywhere in
// scripts/install-ec2-storage-pressure-maintenance.sh. This module gives any
// ledger of that shape a per-briefing-date directory (mirroring
// overnight-report-events/<date>.jsonl) plus two bounded read modes instead
// of one growing flat file:
//   - readWindow: every row across an explicit [startDate, endDate] window
//     (the overnight-watch-report two-day-window shape).
//   - readLatestMatch: a newest-first scan across at most maxDatesBack dated
//     files, calling visit(row) per row and stopping the instant visit
//     returns {stop:true}. maxDatesBack caps a bug from ever turning this
//     into a true unbounded scan (findResumableLandedRepair's resume lookback
//     needs a real unbounded-feeling walk across dates, not a fixed 1-2 day
//     window -- see scripts/agentic-healer-driver.js).
//
// Migration: a ledger split this way keeps its pre-split flat file in place
// (data/agent/<ledgerName>.jsonl) as a bounded legacy fallback both read
// modes also consult, oldest-first, after the dated files are exhausted --
// production history stays reachable without a risky one-time re-split.

const fs = require('node:fs');
const path = require('node:path');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_DATES_BACK = 30;
const DEFAULT_RETENTION_DAYS = 14;

function safeDate(value) {
  const date = String(value || '').slice(0, 10);
  if (!DATE_RE.test(date)) throw new Error('dated ledger date must be YYYY-MM-DD');
  return date;
}

function requireNonEmpty(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`dated ledger ${label} is required`);
  return text;
}

function ledgerDir(dataDir, ledgerName) {
  return path.join(
    requireNonEmpty(dataDir, 'dataDir'),
    'agent',
    requireNonEmpty(ledgerName, 'ledgerName'),
  );
}

function ledgerDatePath(dataDir, ledgerName, date) {
  return path.join(ledgerDir(dataDir, ledgerName), `${safeDate(date)}.jsonl`);
}

// The pre-split flat file this ledger used to be, e.g.
// data/agent/overnight-agentic-healer-runs.jsonl. Read-only from this
// module's point of view: nothing here ever appends to it again.
function legacyLedgerPath(dataDir, ledgerName) {
  return path.join(
    requireNonEmpty(dataDir, 'dataDir'),
    'agent',
    `${requireNonEmpty(ledgerName, 'ledgerName')}.jsonl`,
  );
}

// Newest-first list of `count` YYYY-MM-DD strings ending at endDate
// (inclusive).
function datesBack(endDate, count) {
  const out = [];
  const cursor = new Date(`${safeDate(endDate)}T00:00:00.000Z`);
  const n = Math.max(1, Number(count) || 1);
  for (let i = 0; i < n; i += 1) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return out;
}

// Oldest-first list of every YYYY-MM-DD between startDate and endDate
// inclusive (an explicit small window, e.g. the two-night union pattern
// scripts/overnight-watch-report.js already uses for card-controller
// receipts).
function datesBetween(startDate, endDate) {
  const start = safeDate(startDate);
  const end = safeDate(endDate);
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const stop = new Date(`${end}T00:00:00.000Z`);
  const out = [];
  // A window is always small (days, not years); this loop is bounded by the
  // caller's own dates, never by ledger size.
  while (cursor <= stop) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function appendRow(dataDir, ledgerName, date, row) {
  const file = ledgerDatePath(dataDir, ledgerName, date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return file;
}

// Bounded tail read: at most maxBytes from the end of the file. A read that
// starts mid-line drops that partial first line (matches the tail-read
// pattern already used by overnight-self-heal-orchestrator.js's
// readRecentJsonlRows and scripts/git-janitor.js's coordinator-receipts
// reader). A corrupt line is skipped, never fatal -- a ledger must never
// wedge its readers.
function readJsonlFileBounded(file, maxBytes = DEFAULT_MAX_READ_BYTES) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.size === 0) return [];
  const bytes = Math.min(stat.size, Math.max(1, Number(maxBytes) || DEFAULT_MAX_READ_BYTES));
  const start = Math.max(0, stat.size - bytes);
  const fd = fs.openSync(file, 'r');
  let text;
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    text = buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  if (start > 0) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed.replace(/^﻿/, '')));
    } catch {
      // corrupt line: skip, never fatal
    }
  }
  return rows;
}

// Every row across [startDate, endDate] inclusive, oldest-first, plus the
// legacy flat file's rows (also oldest-first, prepended) unless
// includeLegacy:false. Use for the report/window read shape where the
// caller already knows a small explicit date range.
function readWindow(
  dataDir,
  ledgerName,
  { startDate, endDate, includeLegacy = true, maxBytesPerFile } = {},
) {
  const start = startDate || endDate;
  const end = endDate || startDate;
  if (!start || !end) throw new Error('readWindow requires startDate and/or endDate');
  const rows = [];
  let present = false;
  if (includeLegacy) {
    const legacyRows = readJsonlFileBounded(legacyLedgerPath(dataDir, ledgerName), maxBytesPerFile);
    if (legacyRows.length) present = true;
    rows.push(...legacyRows);
  }
  for (const date of datesBetween(start, end)) {
    const file = ledgerDatePath(dataDir, ledgerName, date);
    const dateRows = readJsonlFileBounded(file, maxBytesPerFile);
    if (fs.existsSync(file)) present = true;
    rows.push(...dateRows);
  }
  return { rows, present };
}

// Newest-first scan across at most maxDatesBack per-date files (default 30:
// generous headroom above the standard 14-day retention window so a bug can
// never turn this into a true unbounded scan), starting at startDate and
// walking backward one day at a time. Within each file rows are visited
// newest-line-first. visit(row) is called per row; return {stop:true,
// result} to end the scan immediately with `result` (a falsy/undefined
// return continues scanning). This early-exit-with-a-result shape (rather
// than a plain boolean predicate) is required by callers like
// findResumableLandedRepair whose correct behavior is "stop scanning with NO
// match" the instant a newer receipt proves resume is unnecessary -- not
// merely "find the first row that matches something". Falls through to the
// legacy flat file (also newest-line-first) once the dated files are
// exhausted, so pre-split history stays resumable.
function readLatestMatch(
  dataDir,
  ledgerName,
  { startDate, maxDatesBack = DEFAULT_MAX_DATES_BACK, visit, includeLegacy = true } = {},
) {
  if (typeof visit !== 'function')
    throw new Error('readLatestMatch requires a visit(row) function');
  const anchor = startDate || new Date().toISOString().slice(0, 10);
  const dates = datesBack(anchor, maxDatesBack);
  for (const date of dates) {
    const rows = readJsonlFileBounded(ledgerDatePath(dataDir, ledgerName, date));
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const outcome = visit(rows[i]);
      if (outcome && outcome.stop) return outcome.result === undefined ? null : outcome.result;
    }
  }
  if (includeLegacy) {
    const legacyRows = readJsonlFileBounded(legacyLedgerPath(dataDir, ledgerName));
    for (let i = legacyRows.length - 1; i >= 0; i -= 1) {
      const outcome = visit(legacyRows[i]);
      if (outcome && outcome.stop) return outcome.result === undefined ? null : outcome.result;
    }
  }
  return null;
}

// Every `<YYYY-MM-DD>.jsonl` file directly under a dated-ledger directory,
// oldest-first. Used by compaction/retention, not by any read/write path
// above.
function listDatedFiles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => DATE_RE.test(name.replace(/\.jsonl$/, '')) && name.endsWith('.jsonl'))
    .map((name) => ({ date: name.replace(/\.jsonl$/, ''), file: path.join(dir, name) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Deletes every dated file older than `retainDays` before `now` from a
// dated-ledger directory (built with ledgerDir, or any directory using the
// same <YYYY-MM-DD>.jsonl convention). Never touches the legacy flat sibling
// file -- that is a frozen, bounded fallback by design, not something this
// prunes. dryRun lists what WOULD be removed without deleting. NEVER call
// this against data/agent/overnight-report-events: that directory is the raw
// overnight evidence trail scripts/lib/storage-pressure-retention.js's
// deny-list refuses to touch under any root, and a caller pruning it through
// this generic helper bypasses that deny-list entirely (the exact bug the
// 2026-09-01 fix round removed from ec2-storage-pressure-maintenance.js).
function pruneLedgerDir(
  dir,
  { retainDays = DEFAULT_RETENTION_DAYS, now = new Date(), dryRun = false } = {},
) {
  const cutoff = new Date(now);
  cutoff.setUTCDate(
    cutoff.getUTCDate() - Math.max(1, Number(retainDays) || DEFAULT_RETENTION_DAYS),
  );
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const removed = [];
  const kept = [];
  for (const entry of listDatedFiles(dir)) {
    if (entry.date < cutoffDate) {
      if (!dryRun) {
        try {
          fs.rmSync(entry.file, { force: true });
        } catch {
          continue; // best-effort: a locked/already-gone file is not fatal to the sweep
        }
      }
      removed.push(entry.file);
    } else {
      kept.push(entry.file);
    }
  }
  return { removed, kept, cutoffDate };
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_MAX_DATES_BACK,
  safeDate,
  ledgerDir,
  ledgerDatePath,
  legacyLedgerPath,
  datesBack,
  datesBetween,
  appendRow,
  readJsonlFileBounded,
  readWindow,
  readLatestMatch,
  listDatedFiles,
  pruneLedgerDir,
};
