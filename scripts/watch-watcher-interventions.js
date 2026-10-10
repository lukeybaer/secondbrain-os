#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  watcherInterventionIdentity,
  watcherInterventionsForDate,
} = require('./lib/watcher-interventions.js');

function compact(value, max = 220) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function interventionState(row = {}) {
  const result = String(row.result || '').trim();
  return !result || /\b(in progress|pending|unknown|not yet|still running|unresolved)\b/i.test(result)
    ? 'ACTIVE'
    : 'RECORDED';
}

function formatIntervention(row = {}, label = 'INTERVENTION') {
  const identity = watcherInterventionIdentity(row).split('\u0000').pop() || 'unknown';
  return [
    `${label} | ${interventionState(row)} | ${identity} | ${compact(row.title || row.key, 140)}`,
    `  Trigger: ${compact(row.detail || row.trigger || row.evidence || 'not recorded')}`,
    `  Action: ${compact(row.action || 'not recorded')}`,
    `  Result: ${compact(row.result || 'not recorded')}`,
  ].join('\n');
}

function interventionSnapshot({ dataDir, date, known = new Set() } = {}) {
  const rows = watcherInterventionsForDate({ dataDir, date });
  const current = new Set(rows.map(watcherInterventionIdentity).filter(Boolean));
  const fresh = rows.filter((row) => !known.has(watcherInterventionIdentity(row)));
  return { rows, fresh, current, count: rows.length };
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { follow: true, intervalMs: 5000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--date') opts.date = argv[++index];
    else if (arg === '--data-dir') opts.dataDir = argv[++index];
    else if (arg === '--interval-ms') opts.intervalMs = Number(argv[++index]);
    else if (arg === '--once') opts.follow = false;
    else if (arg === '--follow') opts.follow = true;
    else if (arg === '--help') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(
      'Usage: node scripts/watch-watcher-interventions.js --date YYYY-MM-DD [--data-dir DIR] [--once|--follow] [--interval-ms 5000]\n',
    );
    return;
  }
  const date = String(opts.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date YYYY-MM-DD is required');
  const dataDir = path.resolve(
    opts.dataDir || process.env.SECONDBRAIN_DATA_DIR || '/opt/secondbrain-shared/data',
  );
  const first = interventionSnapshot({ dataDir, date });
  process.stdout.write(
    `[watcher-interventions] ${date}: ${first.count} recorded. Monitoring ${dataDir}.\n`,
  );
  for (const row of first.rows) process.stdout.write(`${formatIntervention(row, 'EXISTING')}\n`);
  if (!opts.follow) return;
  let known = first.current;
  const intervalMs = Number.isFinite(opts.intervalMs) ? Math.max(1000, opts.intervalMs) : 5000;
  const timer = setInterval(() => {
    const snapshot = interventionSnapshot({ dataDir, date, known });
    for (const row of snapshot.fresh) {
      process.stdout.write(`${formatIntervention(row, 'NEW INTERVENTION')}\n`);
    }
    known = snapshot.current;
  }, intervalMs);
  const stop = () => {
    clearInterval(timer);
    process.stdout.write('[watcher-interventions] stopped.\n');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

module.exports = {
  compact,
  interventionState,
  formatIntervention,
  interventionSnapshot,
  parseArgs,
  main,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[watcher-interventions] ${String(error.message || error)}\n`);
    process.stderr.write(
      'Usage: node scripts/watch-watcher-interventions.js --date YYYY-MM-DD [--data-dir DIR] [--once|--follow] [--interval-ms 5000]\n',
    );
    process.exit(1);
  }
}
