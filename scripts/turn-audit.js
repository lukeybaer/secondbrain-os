#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { collect } = require('./lib/turn-audit');
const { render } = require('./lib/turn-audit-render');
async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i=0;i<args.length;i+=2) { if (!['--manifest','--annotations','--baseline','--metrics','--summary','--out'].includes(args[i]) || !args[i+1]) throw Error('Use --manifest file --out stem [--annotations file] [--baseline audit.json] [--metrics file] [--summary file]'); options[args[i]] = args[i+1]; }
  const read = key => options[key] ? JSON.parse(fs.readFileSync(options[key], 'utf8')) : undefined;
  if (!options['--manifest'] || !options['--out']) throw Error('--manifest and --out required');
  const audit = await collect(read('--manifest'), read('--annotations'));
  const stem = path.resolve(options['--out']); fs.mkdirSync(path.dirname(stem), { recursive: true });
  fs.writeFileSync(stem + '.json', JSON.stringify(audit, null, 2));
  fs.writeFileSync(stem + '.html', render(audit, read('--baseline'), read('--metrics'), read('--summary')));
  console.log(JSON.stringify({ json: stem+'.json', html: stem+'.html', totals: audit.totals, missing: audit.missing }));
}
main().catch(e => { console.error(e.message); process.exitCode=1; });
