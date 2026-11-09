#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { decideStrategicOption } = require('./lib/jev-control-plane.js');

async function main() {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const result = await decideStrategicOption(payload);
  process.stdout.write(`${JSON.stringify({ accepted: result.accepted, choice: result.choice || null, confidence: result.minProbability || 0, threshold: result.threshold || 0.9, reason: result.reason || null })}\n`);
  if (!result.accepted) process.exitCode = 3;
}

main().catch((error) => {
  process.stderr.write(`Jev strategic decision failed closed: ${error.message || error}\n`);
  process.exitCode = 3;
});
