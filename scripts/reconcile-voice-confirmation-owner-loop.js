#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  readVoiceConfirmationOwnerTask,
  startVoiceConfirmationOwnerTask,
} = require('./lib/voice-confirmation-owner-loop.js');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(ROOT, 'data'));

function valuesAfter(name, argv = process.argv.slice(2)) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) values.push(String(argv[++index]));
  }
  return values;
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}

function main(argv = process.argv.slice(2)) {
  const requestIds = valuesAfter('--request-id', argv);
  if (!requestIds.length) throw new Error('at least one --request-id is required');
  const actions = readJsonl(path.join(
    DATA_DIR,
    'life-archive',
    'people',
    'voice-confirmation-actions.jsonl',
  ));
  const byRequest = new Map(actions.map((row) => [row.gitPeopleSyncRequestId, row]));
  const tasksDir = path.join(DATA_DIR, 'tasks');
  const results = [];
  for (const requestId of requestIds) {
    const action = byRequest.get(requestId);
    if (!action) throw new Error(`voice confirmation action not found: ${requestId}`);
    const existing = readVoiceConfirmationOwnerTask(requestId, { tasksDir });
    const task = existing || startVoiceConfirmationOwnerTask(action, requestId, { tasksDir });
    let dispatch = null;
    if (argv.includes('--dispatch')) {
      const child = spawnSync(
        process.execPath,
        [
          path.join(ROOT, 'scripts', 'voice-confirmation-backprop.js'),
          '--job-request-id',
          requestId,
          '--force-exact-replay',
        ],
        { cwd: ROOT, encoding: 'utf8', env: process.env, timeout: 10 * 60 * 1000 },
      );
      dispatch = {
        status: child.status,
        stdout: String(child.stdout || '').slice(-2000),
        stderr: String(child.stderr || '').slice(-2000),
      };
    }
    results.push({ requestId, taskId: task.id, created: !existing, dispatch });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
  return results;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  }
}

module.exports = { main, valuesAfter };
