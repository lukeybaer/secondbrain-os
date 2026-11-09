'use strict';

const { rankCyberCabSources } = require('./lib/cybercab-jev-ranker.js');

async function runCyberCabJevRankInput(input, deps = {}) {
  const ranker = deps.ranker || rankCyberCabSources;
  const parsed = JSON.parse(input || '{}');
  return ranker(parsed.candidates || []);
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', async () => {
    try {
      const result = await runCyberCabJevRankInput(input);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      process.stderr.write(`[cybercab-jev-rank] ${error.stack || error.message || error}\n`);
      process.exitCode = 1;
    }
  });
}

module.exports = { runCyberCabJevRankInput };
