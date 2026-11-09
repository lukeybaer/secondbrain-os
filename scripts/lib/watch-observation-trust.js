'use strict';

const fs = require('node:fs');
const path = require('node:path');

function watcherObservationPath(dataDir) {
  return path.join(dataDir, 'agent', 'overnight-watch-observations.jsonl');
}

function watcherObservationQuarantinePath(dataDir) {
  return path.join(dataDir, 'agent', 'watcher-observation-quarantine.jsonl');
}

function readJsonlRows(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
    } catch {
      // A torn line is absent evidence, never authority.
    }
  }
  return rows;
}

function readQuarantineRows(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw new Error(`watcher observation quarantine is unreadable: ${error.message}`);
  }
  const rows = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`watcher observation quarantine is malformed at line ${index + 1}`);
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`watcher observation quarantine is invalid at line ${index + 1}`);
    }
    if (
      row.schema !== 'watcher-observation-quarantine@1' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(row.date || '')) ||
      !Number.isFinite(Date.parse(String(row.ts || ''))) ||
      !Number.isFinite(Date.parse(String(row.observationTs || ''))) ||
      String(row.observationIdentity || '').split('\u0000').length !== 4 ||
      !String(row.observationKind || '').trim() ||
      !String(row.observationKey || '').trim() ||
      !String(row.reason || '').trim() ||
      row.quarantinedBy !== 'attended-supervisor'
    ) {
      throw new Error(`watcher observation quarantine is invalid at line ${index + 1}`);
    }
    const expectedIdentity = `${String(row.date).slice(0, 10)}\u0000${String(
      row.observationTs,
    ).trim()}\u0000${String(row.observationKind).trim().toLowerCase()}\u0000${String(
      row.observationKey,
    )
      .trim()
      .toLowerCase()}`;
    if (row.observationIdentity !== expectedIdentity) {
      throw new Error(`watcher observation quarantine identity mismatch at line ${index + 1}`);
    }
    rows.push(row);
  }
  return rows;
}

function writeQuarantineRowsAtomic(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function watcherObservationIdentity(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return '';
  const date = String(row.date || '').slice(0, 10);
  const ts = String(row.ts || '').trim();
  const kind = String(row.kind || '').trim().toLowerCase();
  const key = String(row.key || '').trim().toLowerCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(ts)) || !kind || !key) {
    return '';
  }
  return `${date}\u0000${ts}\u0000${kind}\u0000${key}`;
}

function observationQuarantinesForDate({ dataDir, date } = {}) {
  const day = String(date || '').slice(0, 10);
  if (!dataDir || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  return readQuarantineRows(watcherObservationQuarantinePath(dataDir)).filter(
    (row) => String(row.date || '').slice(0, 10) === day,
  );
}

function filterQuarantinedObservations(rows, { dataDir, date } = {}) {
  const dates = new Set(
    [date, ...(Array.isArray(rows) ? rows.map((row) => String(row?.date || '').slice(0, 10)) : [])]
      .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))),
  );
  const quarantines = [...dates].flatMap((day) =>
    observationQuarantinesForDate({ dataDir, date: day }),
  );
  const identities = new Set(quarantines.map((row) => row.observationIdentity));
  const trusted = [];
  const quarantined = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (identities.has(watcherObservationIdentity(row))) quarantined.push(row);
    else trusted.push(row);
  }
  return { rows: trusted, quarantined, quarantines };
}

function quarantineWatchObservation({
  dataDir,
  date,
  key,
  observationTs,
  reason,
  nowMs = Date.now(),
} = {}) {
  const day = String(date || '').slice(0, 10);
  const exactKey = String(key || '').trim();
  const exactTs = String(observationTs || '').trim();
  const explanation = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 800);
  if (!dataDir) throw new Error('dataDir is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('date must be YYYY-MM-DD');
  if (!exactKey || !exactTs || !Number.isFinite(Date.parse(exactTs)) || !explanation) {
    throw new Error('quarantine requires key, exact observation timestamp, and reason');
  }
  const matches = readJsonlRows(watcherObservationPath(dataDir)).filter(
    (row) =>
      String(row.date || '').slice(0, 10) === day &&
      String(row.key || '').trim() === exactKey &&
      String(row.ts || '').trim() === exactTs,
  );
  if (matches.length !== 1) {
    throw new Error(`quarantine expected one exact observation but found ${matches.length}`);
  }
  const target = matches[0];
  const observationIdentity = watcherObservationIdentity(target);
  const existing = observationQuarantinesForDate({ dataDir, date: day });
  const duplicate = existing.some((row) => row.observationIdentity === observationIdentity);
  const row = {
    schema: 'watcher-observation-quarantine@1',
    ts: new Date(nowMs).toISOString(),
    date: day,
    observationIdentity,
    observationTs: exactTs,
    observationKind: String(target.kind || ''),
    observationKey: exactKey,
    reason: explanation,
    quarantinedBy: 'attended-supervisor',
  };
  if (!duplicate) {
    const file = watcherObservationQuarantinePath(dataDir);
    const allRows = readQuarantineRows(file);
    writeQuarantineRowsAtomic(file, [...allRows, row]);
  }
  return { duplicate, row, target };
}

module.exports = {
  filterQuarantinedObservations,
  observationQuarantinesForDate,
  quarantineWatchObservation,
  watcherObservationIdentity,
  watcherObservationPath,
  watcherObservationQuarantinePath,
};
