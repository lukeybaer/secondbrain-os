#!/usr/bin/env node
'use strict';

// Report-accuracy defects (ExampleCo, 2026-10-10). Every #b retrospective compares
// its findings with that night's overnight report; each disagreement on a
// cause, count, time, or recommendation is a defect against the overnight
// report and is recorded here, one durable row per disagreement, so the
// disagreement survives the chat and the #b page.
//
//   node scripts/report-accuracy-defects.js record --date 2026-10-10 --file disagreements.json
//   node scripts/report-accuracy-defects.js list --date 2026-10-10
//
// The file is a JSON array of { topic, overnightClaim, finding, settlingReceipt }.
// Rows are keyed by date + topic + overnightClaim, so recording twice is a no-op.
// Ledger: <data>/agent/report-accuracy-defects.jsonl (EC2 owns the overnight
// report, so #b records there through its one remote session).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { dataDirPath } = require('./lib/data-root.js');

const LEDGER_REL = path.join('agent', 'report-accuracy-defects.jsonl');
const REQUIRED = ['topic', 'overnightClaim', 'finding', 'settlingReceipt'];

function ledgerPath(dataDir) {
  return dataDir ? path.join(dataDir, LEDGER_REL) : dataDirPath(LEDGER_REL);
}

function readRows(dataDir) {
  const file = ledgerPath(dataDir);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function defectId(date, item) {
  return crypto
    .createHash('sha256')
    .update(`${date}\n${item.topic}\n${item.overnightClaim}`)
    .digest('hex')
    .slice(0, 16);
}

function recordDisagreements({ date, items, dataDir, source = '#b', now = new Date() }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('date must be YYYY-MM-DD');
  if (!Array.isArray(items)) throw new Error('disagreements must be a JSON array');
  for (const [index, item] of items.entries()) {
    for (const key of REQUIRED) {
      if (!item || !String(item[key] || '').trim()) {
        throw new Error(`disagreement ${index + 1} is missing ${key}`);
      }
    }
  }
  const known = new Set(readRows(dataDir).map((row) => row.id));
  const file = ledgerPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const written = [];
  for (const item of items) {
    const id = defectId(date, item);
    if (known.has(id)) continue;
    const row = {
      id,
      date,
      recordedAt: now.toISOString(),
      source,
      kind: 'report-accuracy',
      status: 'open',
      report: `briefings/watch-report-${date}.html`,
      ...Object.fromEntries(REQUIRED.map((key) => [key, String(item[key]).trim()])),
    };
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
    known.add(id);
    written.push(row);
  }
  return { file, written, skipped: items.length - written.length };
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  const date = argValue(argv, '--date');
  const dataDir = argValue(argv, '--data-dir');
  if (command === 'record') {
    const file = argValue(argv, '--file');
    if (!file) throw new Error('record needs --file <disagreements.json>');
    const items = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = recordDisagreements({ date, items, dataDir });
    console.log(JSON.stringify({ ledger: result.file, recorded: result.written.map((row) => row.id), skipped: result.skipped }));
    return 0;
  }
  if (command === 'list') {
    const rows = readRows(dataDir).filter((row) => !date || row.date === date);
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  console.error('usage: report-accuracy-defects.js record --date YYYY-MM-DD --file <json> | list [--date YYYY-MM-DD]');
  return 2;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[report-accuracy-defects] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { recordDisagreements, readRows, ledgerPath, defectId };
