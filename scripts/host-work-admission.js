#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { withHostWorkAdmission } = require('./lib/host-work-admission.js');

function valueAfter(argv, name, fallback = '') {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function writeDeferredMarker(markerFile, { kind, admission, now = new Date(), fsApi = fs } = {}) {
  if (!markerFile) return '';
  const marker = path.resolve(markerFile);
  fsApi.mkdirSync(path.dirname(marker), { recursive: true });
  const temp = `${marker}.${process.pid}.${Date.now()}.tmp`;
  fsApi.writeFileSync(
    temp,
    `${JSON.stringify(
      {
        schema: 'host-work-admission-deferred@1',
        generated_at: now.toISOString(),
        kind: String(kind || 'scheduled-command'),
        reason: admission?.reason || 'not-admitted',
        admission,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  fsApi.renameSync(temp, marker);
  return marker;
}

async function main(argv = process.argv.slice(2)) {
  const separator = argv.indexOf('--');
  const mode = argv[0] || '';
  if (mode !== 'run' || separator < 0 || !argv[separator + 1]) {
    process.stderr.write(
      'Usage: host-work-admission.js run [--kind NAME] [--priority delivery|controller|critical|normal|background] [--memory-mib N] [--provider NAME] [--session-cost N] [--nightly-ceiling N] [--wait-ms N] [--lease-ms N] [--deferred-marker FILE] -- COMMAND [ARGS...]\n',
    );
    process.exitCode = 64;
    return;
  }
  const command = argv[separator + 1];
  const args = argv.slice(separator + 2);
  const dataDir =
    process.env.SECONDBRAIN_DATA_DIR ||
    path.join(process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..'), 'data');
  const result = await withHostWorkAdmission(
    {
      dataDir,
      kind: valueAfter(argv, '--kind', 'scheduled-command'),
      priority: valueAfter(argv, '--priority', 'normal'),
      waitMs: Number(valueAfter(argv, '--wait-ms', '0')) || 0,
      leaseMs: Number(valueAfter(argv, '--lease-ms', '0')) || undefined,
      memoryBytes: (Number(valueAfter(argv, '--memory-mib', '0')) || 0) * 1024 ** 2 || undefined,
      provider: valueAfter(argv, '--provider', ''),
      sessionCost: Number(valueAfter(argv, '--session-cost', '0')) || 0,
      nightlySessionCeiling:
        Number(valueAfter(argv, '--nightly-ceiling', '0')) || undefined,
      onDeferred: (admission) => ({ deferred: true, admission }),
    },
    () =>
      new Promise((resolve) => {
        const child = spawn(command, args, {
          cwd: process.cwd(),
          env: process.env,
          stdio: 'inherit',
          windowsHide: true,
        });
        child.on('error', (error) => resolve({ status: 1, error: error.message }));
        child.on('close', (status, signal) =>
          resolve({ status: Number.isInteger(status) ? status : 1, signal: signal || null }),
        );
      }),
  );
  if (result && result.deferred) {
    const deferredMarker = valueAfter(argv, '--deferred-marker', '');
    if (deferredMarker) {
      writeDeferredMarker(deferredMarker, {
        kind: valueAfter(argv, '--kind', 'scheduled-command'),
        admission: result.admission,
      });
    }
    process.stderr.write(
      `[host-work-admission] deferred ${valueAfter(argv, '--kind', 'scheduled-command')}: ${result.admission.reason}\n`,
    );
    process.exitCode = 75;
    return;
  }
  process.exitCode = Number(result && result.status) || 0;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, writeDeferredMarker };
