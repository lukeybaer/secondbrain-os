#!/usr/bin/env node
'use strict';

// Reports whether delegation is performing, from the sampled comparisons.
//
// ExampleCo asked for the metric alongside the routing, because routing without a
// measurement is just hoping. Run it any time:
//
//   node scripts/delegation-performance.js
//   node scripts/delegation-performance.js --json
//
// It reads the append-only ledger written by recordDelegationComparison and
// refuses to report a rate until there is enough evidence for one to mean
// anything.

const fs = require('node:fs');
const path = require('node:path');
const { delegationPerformance } = require('./lib/delegation-policy.js');

function dataDir() {
  if (process.env.SECONDBRAIN_DATA_DIR) return process.env.SECONDBRAIN_DATA_DIR;
  if (process.platform !== 'win32' && fs.existsSync('/opt/secondbrain/data')) {
    return '/opt/secondbrain/data';
  }
  return path.join(__dirname, '..', 'data');
}

const LEDGER = path.join(dataDir(), 'agent', 'delegation-comparisons.jsonl');

function readRows(file = LEDGER) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* a torn final line is normal while a run is appending */
    }
  }
  return rows;
}

function main() {
  const rows = readRows();
  const perf = delegationPerformance(rows);

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ...perf, ledger: LEDGER, rows: rows.length })}\n`);
    return perf.verdict === 'delegation-degraded' ? 1 : 0;
  }

  const lines = [
    `Delegation performance: ${perf.verdict}`,
    `  ledger              ${LEDGER}`,
    `  comparisons logged  ${rows.length}`,
    `  scorable            ${perf.scorableSamples} (need ${perf.minSamples} before a rate means anything)`,
    `  pending judgement   ${perf.pendingAdjudication} (prose, no objective outcome to compare)`,
    `  divergences         ${perf.divergences}`,
  ];
  if (perf.agreementRate !== null) {
    lines.push(`  agreement rate      ${(perf.agreementRate * 100).toFixed(1)}%`);
  }
  lines.push(`  ${perf.detail}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return perf.verdict === 'delegation-degraded' ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { readRows, LEDGER, dataDir };
