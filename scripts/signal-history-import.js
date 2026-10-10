#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  archiveSignalExport,
  archiveSignalDerivatives,
  archiveSignalRecovery,
  graphitiHistoryCoverage,
  inspectSignalExport,
  prepareSignalHistory,
  prepareGraphitiHistory,
  enrichSignalHistoryLinks,
  signalHistoryOverallCoverage,
  publicInspection,
} = require('./lib/signal-history-import.js');

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function defaultRunRoot(exportRoot) {
  const appData = process.env.APPDATA || path.join(require('node:os').homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'secondbrain', 'data', 'signal', 'history', 'runs', path.basename(exportRoot));
}

async function main() {
  const command = process.argv[2] || 'inspect';
  const exportRoot = arg('source');
  if (!exportRoot) throw new Error('--source is required');
  const runRoot = path.resolve(arg('run-root') || defaultRunRoot(exportRoot));
  let result;
  if (command === 'inspect') {
    result = publicInspection(inspectSignalExport(exportRoot));
  } else if (command === 'prepare') {
    result = await prepareSignalHistory(exportRoot, runRoot, {
      recoveryRoot: arg('recovery-root') || undefined,
    });
  } else if (command === 'archive') {
    result = archiveSignalExport(exportRoot, runRoot, {
      bucket: arg('bucket') || process.env.SECONDBRAIN_DATA_BUCKET || process.env.SECONDBRAIN_BACKUP_BUCKET,
      region: arg('region', 'us-east-1'),
      onProgress: ({ position, total }) => {
        if (position === 1 || position % 25 === 0 || position === total) {
          process.stderr.write(`[signal-history-import] raw archive ${position}/${total}\n`);
        }
      },
    });
  } else if (command === 'archive-derivatives') {
    result = await archiveSignalDerivatives(runRoot, {
      bucket: arg('bucket') || process.env.SECONDBRAIN_DATA_BUCKET || process.env.SECONDBRAIN_BACKUP_BUCKET,
      region: arg('region', 'us-east-1'),
      concurrency: Number(arg('concurrency', '8')),
      onProgress: ({ position, total }) => {
        if (position === 1 || position % 25 === 0 || position === total) {
          process.stderr.write(`[signal-history-import] derivative archive ${position}/${total}\n`);
        }
      },
    });
  } else if (command === 'archive-recovery') {
    result = archiveSignalRecovery(runRoot, {
      bucket: arg('bucket') || process.env.SECONDBRAIN_DATA_BUCKET || process.env.SECONDBRAIN_BACKUP_BUCKET,
      region: arg('region', 'us-east-1'),
      onProgress: ({ position, total }) => {
        if (position === 1 || position % 25 === 0 || position === total) {
          process.stderr.write(`[signal-history-import] recovery archive ${position}/${total}\n`);
        }
      },
    });
  } else if (command === 'graphiti-prepare') {
    result = await prepareGraphitiHistory(runRoot, {
      graphitiRoot: arg('graphiti-root') || undefined,
    });
  } else if (command === 'graphiti-coverage') {
    result = graphitiHistoryCoverage(runRoot, {
      graphitiRoot: arg('graphiti-root') || undefined,
    });
  } else if (command === 'links') {
    result = await enrichSignalHistoryLinks(runRoot, {
      concurrency: Number(arg('concurrency', '6')),
      onProgress: ({ position, total }) => {
        if (position === 1 || position % 25 === 0 || position === total) {
          process.stderr.write(`[signal-history-import] link context ${position}/${total}\n`);
        }
      },
    });
  } else if (command === 'coverage') {
    result = signalHistoryOverallCoverage(runRoot);
  } else {
    throw new Error(`Unsupported command: ${command}`);
  }
  const receipt = arg('receipt');
  if (receipt) writeJson(path.resolve(receipt), result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`signal-history-import: ${error.message}\n`);
  process.exitCode = 1;
});
