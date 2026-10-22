#!/usr/bin/env node
'use strict';

// Work-unit handoffs, 2 KB maximum (agent delivery protocol, 2026-09-27).
//
// One request with several deliverables is split into units that close on
// their own. A thread that continues a unit reads its handoff, never another
// thread's transcript: on 2026-09-26/27 continuation threads pulled 40-48 KB of
// transcript per read, and one thread bundled five unrelated deliverables so a
// single pending item kept it alive for hours.
//
//   node scripts/work-handoff.js write --unit otter-closeout --state working --next "launch cohort 3" [--done "..."] [--risks "..."]
//   node scripts/work-handoff.js read --unit otter-closeout
//   node scripts/work-handoff.js list

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_BYTES = 2048;
const STATES = ['working', 'landed', 'deploy_queued', 'production_verified', 'external_block', 'failed', 'closed'];
const SAFE_UNIT = /^[a-z0-9][a-z0-9._-]{1,79}$/;

function handoffDir(env = process.env) {
  const data = env.SECONDBRAIN_DATA_DIR || path.join(env.APPDATA || path.join(os.homedir(), '.local', 'share'), 'secondbrain', 'data');
  return path.join(data, 'agent', 'handoffs');
}

function render({ unit, state, next, done, risks }, now = new Date()) {
  if (!SAFE_UNIT.test(String(unit || ''))) throw new Error('--unit must be lowercase letters, digits, dot, dash or underscore.');
  if (!STATES.includes(state)) throw new Error(`--state must be one of: ${STATES.join(', ')}`);
  if (!String(next || '').trim() && !['production_verified', 'closed'].includes(state)) throw new Error('--next is required until the unit is verified or closed.');
  const lines = [`# ${unit}`, '', `state: ${state}`, `updated: ${now.toISOString()}`];
  if (next) lines.push('', `next: ${String(next).trim()}`);
  if (done) lines.push('', `done: ${String(done).trim()}`);
  if (risks) lines.push('', `risks: ${String(risks).trim()}`);
  const text = `${lines.join('\n')}\n`;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_BYTES) throw new Error(`Handoff is ${bytes} bytes; the limit is ${MAX_BYTES}. Keep only state, next step and open risks.`);
  return text;
}

function main(argv = process.argv.slice(2), env = process.env) {
  const action = argv[0];
  const get = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = handoffDir(env);
  if (action === 'write') {
    const text = render({ unit: get('unit'), state: get('state'), next: get('next'), done: get('done'), risks: get('risks') });
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${get('unit')}.md`);
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
    return file;
  }
  if (action === 'read') {
    const unit = get('unit');
    if (!SAFE_UNIT.test(String(unit || ''))) throw new Error('--unit is required.');
    return fs.readFileSync(path.join(dir, `${unit}.md`), 'utf8');
  }
  if (action === 'list') {
    if (!fs.existsSync(dir)) return '';
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
      const first = fs.readFileSync(path.join(dir, f), 'utf8').match(/^state: (.+)$/m);
      return `${f.slice(0, -3)}\t${first ? first[1] : '?'}`;
    }).join('\n');
  }
  throw new Error('Usage: work-handoff.js write|read|list ...');
}

if (require.main === module) {
  try {
    process.stdout.write(`${main()}\n`);
  } catch (error) {
    process.stderr.write(`[work-handoff] ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { MAX_BYTES, STATES, handoffDir, main, render };
