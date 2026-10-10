#!/usr/bin/env node
'use strict';

const os = require('node:os');
const path = require('node:path');
const { migrateLegacySessionTelemetry, defaultDesktopSessionRegistryDir } = require('./lib/operational-session-registry.js');

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function defaultDataDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return process.env.SECONDBRAIN_DATA_DIR || path.join(appData, 'secondbrain', 'data');
}

function main() {
  const dataDir = path.resolve(argValue('--data-dir', defaultDataDir()));
  const tasksDir = path.resolve(argValue('--tasks-dir', process.env.SECONDBRAIN_TASKS_DIR || path.join(dataDir, 'tasks')));
  const registryDir = path.resolve(argValue('--registry-dir', defaultDesktopSessionRegistryDir({ ...process.env, SECONDBRAIN_DATA_DIR: dataDir })));
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check');
  const result = migrateLegacySessionTelemetry({ tasksDir, registryDir, write });
  console.log(JSON.stringify({
    mode: result.mode,
    candidates: result.candidates.length,
    migrated: result.migrated || 0,
    skipped: result.skipped,
    planned: result.planned,
    registry_dir: result.registry_dir,
  }, null, 2));
  if (check && result.candidates.length) process.exitCode = 2;
}

try { main(); } catch (error) {
  console.error(`[migrate-legacy-session-telemetry] ${error.message}`);
  process.exitCode = 1;
}
