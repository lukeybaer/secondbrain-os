#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  buildRescueCanaryReceipt,
  readRescueCanaryReceipt,
  writeRescueCanaryReceipt,
} = require('./lib/scheduled-skill-rescue-canary.js');

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function failedReceipt({ releaseRoot, sourceRoot, dataDir, releaseSha, sentinel, reason }) {
  return buildRescueCanaryReceipt({
    releaseSha,
    releaseRoot,
    releaseRootState: 'ExampleCo',
    sourceRoot,
    sourceRootState: 'ExampleCo',
    worktreeRoot: '',
    worktreeProof: { proven: false, state: 'unproven', reason },
    runtimeDataDir: dataDir,
    expectedDataDir: dataDir,
    forcedClaudeFailure: true,
    rung: 'none',
    expectedSentinel: sentinel,
    observedOutput: '',
    failureReason: reason,
  });
}

function runPostReleaseCanary(options = {}) {
  const releaseRoot = path.resolve(options.releaseRoot || '/opt/secondbrain');
  const sourceRoot = path.resolve(options.sourceRoot || '/home/ec2-user/secondbrain-current');
  const dataDir = path.resolve(options.dataDir || path.join(releaseRoot, 'data'));
  const releaseSha = String(options.releaseSha || 'ExampleCo');
  const sentinel = `SECOND_BRAIN_SCHEDULED_SKILL_RESCUE_OK:${releaseSha}`;
  const runner = path.join(releaseRoot, 'scripts', 'run-scheduled-skill.js');
  const spawn = options.spawn || spawnSync;
  let result;
  if (!fs.existsSync(runner)) {
    const receipt = failedReceipt({
      releaseRoot,
      sourceRoot,
      dataDir,
      releaseSha,
      sentinel,
      reason: `scheduled-skill runner missing from release: ${runner}`,
    });
    writeRescueCanaryReceipt(dataDir, receipt);
    return { ok: false, receipt, status: 1 };
  }
  try {
    result = spawn(process.execPath, [runner, 'release-rescue-canary'], {
      cwd: releaseRoot,
      env: {
        ...process.env,
        SECONDBRAIN_ROOT: releaseRoot,
        SECONDBRAIN_SOURCE_ROOT: sourceRoot,
        SECONDBRAIN_DATA_DIR: dataDir,
        RUN_SCHEDULED_SKILL_CANARY: '1',
        RUN_SCHEDULED_SKILL_CANARY_RELEASE_ROOT: releaseRoot,
        RUN_SCHEDULED_SKILL_CANARY_SOURCE_ROOT: sourceRoot,
        RUN_SCHEDULED_SKILL_CANARY_EXPECTED_DATA_DIR: dataDir,
        RUN_SCHEDULED_SKILL_CANARY_RELEASE_SHA: releaseSha,
        RUN_SCHEDULED_SKILL_CANARY_SENTINEL: sentinel,
        RUN_SCHEDULED_SKILL_TOTAL_TIMEOUT_MS: '90000',
        RUN_SCHEDULED_SKILL_RUNG_TIMEOUT_MS: '30000',
      },
      encoding: 'utf8',
      timeout: 100000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    result = { status: 1, stdout: '', stderr: error.message };
  }
  let receipt = readRescueCanaryReceipt(dataDir);
  const receiptMatches = receipt && String(receipt.releaseSha || '') === releaseSha;
  if (result.status !== 0 || !receiptMatches || !receipt.ok) {
    if (!receiptMatches || (result.status !== 0 && receipt && receipt.ok)) {
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(-600);
      receipt = failedReceipt({
        releaseRoot,
        sourceRoot,
        dataDir,
        releaseSha,
        sentinel,
        reason: output || `scheduled-skill canary exited ${result.status}`,
      });
      writeRescueCanaryReceipt(dataDir, receipt);
    }
    return { ok: false, receipt, status: Number.isFinite(result.status) ? result.status : 1 };
  }
  return { ok: true, receipt, status: 0 };
}

function main() {
  const result = runPostReleaseCanary({
    releaseRoot: argValue('--release-root', process.env.SECONDBRAIN_ROOT || '/opt/secondbrain'),
    sourceRoot: argValue(
      '--source-root',
      process.env.SECONDBRAIN_SOURCE_ROOT || '/home/ec2-user/secondbrain-current',
    ),
    dataDir: argValue('--data-dir', process.env.SECONDBRAIN_DATA_DIR || '/opt/secondbrain/data'),
    releaseSha: argValue('--release-sha', process.env.SECONDBRAIN_RELEASE_SHA || 'ExampleCo'),
  });
  console.log(JSON.stringify(result.receipt));
  return result.ok ? 0 : 1;
}

if (require.main === module) process.exit(main());

module.exports = { main, runPostReleaseCanary };
