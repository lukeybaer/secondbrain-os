#!/usr/bin/env node
'use strict';

/**
 * spine-scorecard.js -- weekly Amy scorecard from the clean Task store.
 *
 *   node scripts/spine-scorecard.js [--data-dir D] [--tasks-dir D] [--days 7] [--no-write]
 *
 * Writes <data-dir>/agent/spine-scorecard/<YYYY-MM-DD>.json and latest.json and
 * prints the plain-text scorecard. Runs in the Monday daytime scheduled fleet.
 */

const fs = require('node:fs');
const path = require('node:path');
const { defaultDataDir } = require('./lib/spine-ingress.js');
const { buildScorecard, formatScorecard } = require('./lib/spine-scorecard.js');

function main(argv = process.argv.slice(2)) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : '';
  };
  const dataDir = get('--data-dir') || defaultDataDir();
  const days = Number(get('--days')) || undefined;
  const card = buildScorecard({ dataDir, tasksDir: get('--tasks-dir') || undefined, days });
  if (!argv.includes('--no-write')) {
    const dir = path.join(dataDir, 'agent', 'spine-scorecard');
    fs.mkdirSync(dir, { recursive: true });
    const body = `${JSON.stringify(card, null, 2)}\n`;
    fs.writeFileSync(path.join(dir, `${card.generatedAt.slice(0, 10)}.json`), body, 'utf8');
    fs.writeFileSync(path.join(dir, 'latest.json'), body, 'utf8');
  }
  console.log(formatScorecard(card));
  return card;
}

if (require.main === module) main();

module.exports = { main };
