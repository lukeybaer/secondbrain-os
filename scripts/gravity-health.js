#!/usr/bin/env node
'use strict';

const { formatGravityHealthRow, probeGravityHealth } = require('./lib/gravity-health.js');

const dateArg = process.argv.find((arg) => arg.startsWith('--date='));
const result = probeGravityHealth({
  date: dateArg ? dateArg.slice('--date='.length) : undefined,
});
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else process.stdout.write(`${formatGravityHealthRow(result)}\n`);
