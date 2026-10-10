#!/usr/bin/env node
'use strict';

const { runPeopleProjection } = require('./lib/signal-people-project.js');

async function main() {
  const result = await runPeopleProjection();
  console.log(JSON.stringify(result));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[signal-people] ${error.stack || error.message}`);
    process.exit(1);
  });
}

module.exports = { main };
