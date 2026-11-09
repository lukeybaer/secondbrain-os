#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  linuxProcessStartTime,
  rolloutMode: conflictLeaseRolloutMode,
  verifyScopeToken,
} = require('./lib/controller-conflict-leases.js');

function processAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return !!(error && error.code === 'EPERM');
  }
}

function linuxParentPid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${Number(pid)}/stat`, 'utf8');
    const match = stat.match(/^\d+\s+\(.+\)\s+\S+\s+(\d+)\s+/);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function verifyControllerDeployAuthority({
  dataDir,
  env = process.env,
  hostname = os.hostname(),
  readFileSync = fs.readFileSync,
  alive = processAlive,
  parentPid = linuxParentPid,
} = {}) {
  const requestedRunId = String(env.CARD_CONTROLLER_PARENT_RUN_ID || '').trim();
  const scopeToken = String(env.CARD_CONTROLLER_SCOPE_TOKEN || '').trim();
  const scopeKeys = String(env.CARD_CONTROLLER_SCOPE_KEYS || '').split(',').filter(Boolean);
  if (
    requestedRunId &&
    conflictLeaseRolloutMode({ dataDir, env }).effective === 'enforce' &&
    !scopeToken
  ) {
    return { ok: false, reason: 'enforced controller deploy requires an exact scope token' };
  }
  if (scopeToken) {
    const scoped = verifyScopeToken({ dataDir, token: scopeToken, keys: scopeKeys });
    if (!scoped.ok) return { ok: false, reason: `controller scope is not current: ${scoped.reason}` };
    if (!requestedRunId || scoped.lease.runId !== requestedRunId) {
      return { ok: false, reason: 'controller scope run does not match the live lease' };
    }
    if (String(scoped.lease.hostname || '') !== String(hostname || '') || !alive(scoped.lease.pid)) {
      return { ok: false, reason: 'controller scope owner is not live on this host' };
    }
    const actualStart = linuxProcessStartTime(scoped.lease.pid);
    if (scoped.lease.processStartTime && actualStart !== scoped.lease.processStartTime) {
      return { ok: false, reason: 'controller scope owner PID start time changed' };
    }
    return { ok: true, allowedActiveRunner: 'ec2-card-controller-run.sh', mode: 'scoped' };
  }
  const leasePath = path.join(
    String(dataDir || ''),
    'agent',
    'card-controller',
    'active-lease.json',
  );
  let lease;
  try {
    lease = JSON.parse(readFileSync(leasePath, 'utf8'));
  } catch {
    return { ok: false, reason: 'active controller lease is missing or unreadable' };
  }

  if (!lease || String(lease.hostname || '') !== String(hostname || '')) {
    return { ok: false, reason: 'active controller lease belongs to a different host' };
  }
  if (!alive(lease.pid)) return { ok: false, reason: 'active controller PID is not alive' };

  const requestedToken = String(env.CARD_CONTROLLER_LEASE_TOKEN || '').trim();
  if (requestedRunId || requestedToken) {
    if (!requestedRunId || !requestedToken) {
      return { ok: false, reason: 'partial controller run/token delegation' };
    }
    if (lease.runId !== requestedRunId || lease.delegationToken !== requestedToken) {
      return { ok: false, reason: 'controller run/token delegation does not match the live lease' };
    }
  }

  const direct = env.CARD_CONTROLLER_DIRECT_DELEGATION === '1';
  if (direct) {
    if (!requestedRunId || !requestedToken || lease.directController !== true) {
      return { ok: false, reason: 'direct controller delegation is not proven by the live lease' };
    }
    if (lease.supervisorLockPath) {
      return { ok: false, reason: 'direct controller lease unexpectedly names a supervisor lock' };
    }
    return { ok: true, allowedActiveRunner: 'ec2-card-controller-run.sh', mode: 'direct' };
  }

  const lockPath = String(env.CARD_CONTROLLER_SUPERVISOR_LOCK_PATH || '').trim();
  const lockToken = String(env.CARD_CONTROLLER_SUPERVISOR_LOCK_TOKEN || '').trim();
  const supervisorPid = Number(env.CARD_CONTROLLER_SUPERVISOR_PID || 0);
  if (!lockPath || !lockToken || !Number.isInteger(supervisorPid) || supervisorPid <= 0) {
    return { ok: false, reason: 'wrapped controller supervisor proof is incomplete' };
  }
  let liveToken = '';
  try {
    liveToken = String(readFileSync(`${path.resolve(lockPath)}.owner-token`, 'utf8')).trim();
  } catch {
    return { ok: false, reason: 'wrapped controller owner-token sidecar is missing' };
  }
  const wrappedProofMatches =
    lease.directController !== true &&
    path.resolve(String(lease.supervisorLockPath || '')) === path.resolve(lockPath) &&
    lease.supervisorLockToken === lockToken &&
    liveToken === lockToken &&
    Number(lease.supervisorPid) === supervisorPid &&
    alive(supervisorPid) &&
    Number(parentPid(lease.pid)) === supervisorPid;
  if (!wrappedProofMatches) {
    return { ok: false, reason: 'wrapped controller lease, flock owner, and process ancestry disagree' };
  }
  return { ok: true, allowedActiveRunner: 'ec2-card-controller-run.sh', mode: 'wrapped' };
}

function main(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--data-dir');
  const dataDir = index >= 0 ? argv[index + 1] : process.env.SECONDBRAIN_DATA_DIR;
  const verdict = verifyControllerDeployAuthority({ dataDir });
  if (!verdict.ok) {
    console.error(`[controller-deploy-authority] REFUSE: ${verdict.reason}`);
    return 1;
  }
  console.log(
    `[controller-deploy-authority] PASS: ${verdict.mode} controller owns the live lease and supervisor proof`,
  );
  return 0;
}

module.exports = { processAlive, linuxParentPid, verifyControllerDeployAuthority };

if (require.main === module) process.exit(main());
