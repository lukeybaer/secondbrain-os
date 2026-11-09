#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.SECONDBRAIN_DATA_DIR || '/opt/secondbrain/data';

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--night') out.night = argv[++index];
    else if (arg === '--resource') out.resource = argv[++index];
    else if (arg === '--evidence') out.evidence = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.night || '')) throw new Error('--night requires YYYY-MM-DD');
  if (!['cpu', 'memory'].includes(out.resource)) throw new Error('--resource requires cpu or memory');
  if (String(out.evidence || '').trim().length < 20) throw new Error('--evidence requires a specific causal receipt');
  return out;
}

function writeAttribution(options) {
  const row = {
    schema: 'secondbrain.overnight-capacity-attribution.v1',
    status: 'verified',
    night_id: options.night,
    capacity_attribution: options.resource,
    evidence: String(options.evidence).trim(),
    recorded_at: new Date().toISOString(),
    owner: 'attended-amy-capacity-diagnosis',
  };
  const file = path.join(DATA_DIR, 'agent', 'overnight-capacity', 'attributions', `${options.night}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(row, null, 2)}\n`);
  fs.renameSync(temp, file);
  return { row, file };
}

if (require.main === module) {
  try { console.log(JSON.stringify(writeAttribution(parseArgs(process.argv.slice(2))))); }
  catch (error) { console.error(`[overnight-capacity-attribution] ${error.message || error}`); process.exitCode = 2; }
}

module.exports = { parseArgs, writeAttribution };
