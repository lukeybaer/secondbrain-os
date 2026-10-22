#!/usr/bin/env node
'use strict';

// Morning retrospective runner (EC2, after the briefing closes). Model-free.
// Usage: node scripts/morning-retro.js [--date YYYY-MM-DD] [--data-dir DIR] [--no-live] [--print]

const { spawnSync } = require('node:child_process');
const { buildRetro, writeReceipt, collectLiveVitals } = require('./lib/morning-retro.js');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function ctToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) throw new Error(String(r.stderr || `${cmd} exited ${r.status}`));
  return r.stdout;
}

const dataDir = arg('--data-dir') || process.env.SECONDBRAIN_DATA_DIR || '/opt/secondbrain/data';
const date = arg('--date') || ctToday();
const live = process.argv.includes('--no-live') ? {} : collectLiveVitals({ run });
const retro = buildRetro({ dataDir, date, live });
if (process.argv.includes('--print')) {
  console.log(JSON.stringify(retro, null, 2));
} else {
  const file = writeReceipt(dataDir, retro);
  console.log(`[morning-retro] ${date} flags=${retro.flags.join(',') || 'none'} receipt=${file}`);
}
