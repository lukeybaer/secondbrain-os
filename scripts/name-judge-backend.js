#!/usr/bin/env node
'use strict';

// scripts/name-judge-backend.js
//
// Operator switch for who judges speaker names on this host.
//   node scripts/name-judge-backend.js status
//   node scripts/name-judge-backend.js set jev --by "<who>"
//   node scripts/name-judge-backend.js set ladder --by "<who>"   (rollback)
// 'jev' is the TypeSafe Jev decision lane (auth-jev-speaker-naming, ExampleCo
// 2026-09-18). 'ladder' is the prior Claude/Codex judge.

const {
  readNameJudgeBackend,
  writeNameJudgeBackend,
  switchFile,
} = require('./lib/name-judge-backend.js');

function argValue(flag, fallback = '') {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function main() {
  const [command, backend] = process.argv.slice(2);
  if (command === 'set') {
    const state = writeNameJudgeBackend({ backend, by: argValue('--by', 'unknown') });
    process.stdout.write(`${JSON.stringify({ ...state, file: switchFile() })}\n`);
    return;
  }
  if (!command || command === 'status') {
    process.stdout.write(
      `${JSON.stringify({ backend: readNameJudgeBackend(), file: switchFile() })}\n`,
    );
    return;
  }
  process.stderr.write('usage: name-judge-backend.js status | set <jev|ladder> --by "<who>"\n');
  process.exit(2);
}

main();
