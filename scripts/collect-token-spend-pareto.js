#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  collectTokenSpendPareto,
  defaultOutputPath,
  assertCanonicalWindow,
} = require('./lib/token-spend-pareto.js');

function argValue(name, fallback = '') {
  const direct = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function main() {
  const weekly = process.argv.includes('--weekly');
  const defaultWeeklyOutput = path.join(path.dirname(defaultOutputPath()), 'token-spend-pareto-weekly-latest.json');
  const hours = Math.max(1, Math.min(24 * 14, Number(argValue('--hours', weekly ? '168' : '24')) || 24));
  const outputPath = path.resolve(argValue('--out', weekly ? defaultWeeklyOutput : defaultOutputPath()));
  assertCanonicalWindow({ windowMs: hours * 60 * 60 * 1000, outputPath });
  const report = collectTokenSpendPareto({
    windowMs: hours * 60 * 60 * 1000,
    outputPath,
    force: process.argv.includes('--force'),
  });
  const codex = report.platforms.codex;
  const claude = report.platforms.claude;
  console.log(
    `[token-spend-pareto] ${report.cacheHit ? 'reused' : 'wrote'} ${outputPath}; ` +
      `${report.combinedTokens} processed tokens; ` +
      `Codex ${codex.totalTokens}/${codex.turns} turns; ` +
      `Claude ${claude.totalTokens}/${claude.turns} turns; ` +
      `${report.avoidableTokenClassification.candidateAvoidableTokens} candidate avoidable tokens.`,
  );
}

if (require.main === module) main();

module.exports = { argValue, assertCanonicalWindow, main };
