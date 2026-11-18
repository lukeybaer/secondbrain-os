#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function summary(file) {
  const payload = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (!payload.total) throw new Error(`${file} has no Istanbul total summary`);
  return payload.total;
}

function compare(before, after, maximumDrop) {
  const metrics = Object.fromEntries(['lines', 'statements', 'functions', 'branches'].map((name) => {
    const change = Number((after[name].pct - before[name].pct).toFixed(2));
    return [name, { before: before[name], after: after[name], percentagePointChange: change, passed: change >= -maximumDrop }];
  }));
  return { maximumPercentagePointDrop: maximumDrop, metrics, passed: Object.values(metrics).every((metric) => metric.passed) };
}

function main() {
  const [beforeFile, afterFile, maximumDropArg = '2'] = process.argv.slice(2);
  if (!beforeFile || !afterFile) throw new Error('Usage: measure-amy-e2e-v8-coverage.js <before-summary.json> <after-summary.json> [maximum-pp-drop]');
  const maximumDrop = Number(maximumDropArg);
  const before = summary(beforeFile);
  const after = summary(afterFile);
  const result = compare(before, after, maximumDrop);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { summary, compare };
