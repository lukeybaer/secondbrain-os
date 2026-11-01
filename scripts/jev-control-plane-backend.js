#!/usr/bin/env node
'use strict';

const { readJevControlPlaneBackend, writeJevControlPlaneBackend, switchFile } = require('./lib/jev-control-plane-backend.js');

function argValue(flag, fallback = '') {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const [command, backend] = process.argv.slice(2);
if (!command || command === 'status') {
  process.stdout.write(`${JSON.stringify({ ...readJevControlPlaneBackend(), file: switchFile() })}\n`);
} else if (command === 'set') {
  const disabledSurfaces = argValue('--disable-surfaces').split(',').map((value) => value.trim()).filter(Boolean);
  const state = writeJevControlPlaneBackend({ backend, disabledSurfaces, by: argValue('--by') });
  process.stdout.write(`${JSON.stringify({ ...state, file: switchFile() })}\n`);
} else {
  process.stderr.write('usage: jev-control-plane-backend.js status | set <jev|off> --by "<who>" [--disable-surfaces a,b]\n');
  process.exitCode = 2;
}
