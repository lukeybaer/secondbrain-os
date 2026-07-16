#!/usr/bin/env node
'use strict';

const { ensureNeo4jCpuCap } = require('./lib/neo4j-resource-cap.js');

function parseArgs(argv) {
  const out = { apply: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--data-dir') out.dataDir = argv[++i];
    else if (arg === '--container') out.container = argv[++i];
    else if (arg === '--cpus') out.cpus = Number(argv[++i]);
    else throw new Error(`ExampleCo argument: ${arg}`);
  }
  return out;
}

function main(argv = process.argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[neo4j-resource-cap] ${error.message}`);
    return 2;
  }
  const receipt = ensureNeo4jCpuCap(options);
  console.log(JSON.stringify(receipt, null, 2));
  return receipt.status === 'clean' ? 0 : 1;
}

if (require.main === module) process.exit(main());

module.exports = { parseArgs, main };
