#!/usr/bin/env node
'use strict';

const { parseCardList, runCardController } = require('./lib/briefing-card-controller.js');

function parseArgs(argv = process.argv.slice(2)) {
  const options = { mode: 'midday', cards: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode') options.mode = String(argv[++i] || '').trim().toLowerCase();
    else if (arg === '--cards') options.cards = parseCardList(argv[++i]);
    else if (arg === '--date') options.date = String(argv[++i] || '').trim();
    else if (arg === '--data-dir') options.dataDir = String(argv[++i] || '').trim();
    else if (arg === '--shadow') options.shadow = true;
    else if (arg === '--supervised') options.supervised = true;
    else if (arg === '--bootstrap') options.bootstrap = true;
    else if (arg === '--notify') options.notify = true;
    else if (arg === '--human-action') options.humanActionToken = String(argv[++i] || '').trim();
    else if (arg === '--max-seconds') {
      const seconds = Number(argv[++i]);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--max-seconds must be a positive number');
      options.maxRunMs = Math.round(seconds * 1000);
    }
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`ExampleCo argument '${arg}'`);
  }
  if (!['overnight', 'midday', 'button'].includes(options.mode)) {
    throw new Error(`invalid mode '${options.mode}', expected overnight, midday, or button`);
  }
  return options;
}

function help() {
  return [
    'Usage: node scripts/card-controller.js --mode overnight|midday|button [--cards all|card_a,card_b] [--date YYYY-MM-DD] [--bootstrap] [--notify] [--human-action token] [--max-seconds N] [--shadow] [--supervised]',
    '',
    'The controller runs data-only source refreshes first, then one scoped card refresh plus scoped live QC at a time.',
    'No whole-page recheck is used after an individual card. A write that regresses an unrelated green card is rolled back and freezes the run.',
  ].join('\n');
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(help());
    return;
  }
  const receipt = await runCardController(options);
  console.log(JSON.stringify(receipt, null, 2));
  if (!['clean', 'shadow-planned'].includes(receipt.outcome)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[card-controller] failed: ${(error && error.stack) || error}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, help, main };
