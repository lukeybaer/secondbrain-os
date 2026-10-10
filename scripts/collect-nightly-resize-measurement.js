#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { productionBriefingDate, collectNightlyResizeMeasurement, threeNightReadiness } = require('./lib/nightly-resize-measurement.js');
function value(name, fallback) { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; }
try {
  const now = new Date();
  const dataDir = path.resolve(value('--data-dir', process.env.SECONDBRAIN_DATA_DIR || '/opt/secondbrain/data'));
  const result = collectNightlyResizeMeasurement({ dataDir, date: value('--date', productionBriefingDate(now)), now, reconcileExisting: process.argv.includes('--reconcile-existing') });
  console.log(JSON.stringify({ measurement: result.file, readiness: threeNightReadiness({ dataDir }) }));
} catch (error) { console.error(`[nightly-resize-measurement] ${error.message}`); process.exitCode = 1; }
