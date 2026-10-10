'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const DEFAULT_URL = process.env.GRAPHITI_URL || 'http://127.0.0.1:8000';
const DEFAULT_SSH_TARGET = process.env.GRAPHITI_SSH_TARGET || 'ec2-user@ExampleCo';
const DEFAULT_REMOTE_PORT = Number(process.env.GRAPHITI_REMOTE_PORT || 8000);
const DEFAULT_POLICY_PATH = path.resolve(__dirname, '..', '..', 'config', 'graphiti-runtime-policy.json');
const DEFAULT_DEPLOY_SENTINEL = '/opt/secondbrain-durable/graphiti/deploying.json';
const DEFAULT_LEASE_ROOT =
  process.platform === 'win32'
    ? path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'SecondBrain', 'graphiti-tunnel-leases')
    : path.join(os.tmpdir(), 'secondbrain-graphiti-tunnel-leases');
const DEFAULT_MAX_LEASE_AGE_MS = 24 * 60 * 60 * 1000;
const activeTunnelAttempts = new Map();
const activeTunnelProcesses = new Map();

function normalizeRuntimeState(value) {
  return value === 'enabled' || value === 'disabled' ? value : 'unknown';
}

function testOverridesAllowed(options = {}) {
  return process.env.NODE_ENV === 'test' && options.testPolicyOverride === true;
}

function loadGraphitiRuntimePolicy(options = {}) {
  const allowTestOverride = testOverridesAllowed(options);
  if (allowTestOverride && Object.prototype.hasOwnProperty.call(options, 'runtimeState')) {
    return {
      state: normalizeRuntimeState(options.runtimeState),
      reason: options.runtimeReason || 'explicit caller policy',
      source: 'caller',
    };
  }

  const policyPath = allowTestOverride && options.policyPath ? options.policyPath : DEFAULT_POLICY_PATH;
  const readFileSync = allowTestOverride && options.readFileSync ? options.readFileSync : fs.readFileSync;
  try {
    const parsed = JSON.parse(readFileSync(policyPath, 'utf8'));
    const state = normalizeRuntimeState(parsed?.state);
    return {
      state,
      reason:
        state === 'unknown'
          ? 'Graphiti runtime policy has an invalid state'
          : String(parsed.reason || 'tracked owner policy'),
      source: policyPath,
    };
  } catch (error) {
    return {
      state: 'unknown',
      reason: `Graphiti runtime policy unavailable: ${error.code || error.message}`,
      source: policyPath,
    };
  }
}

function policyBlockResult(policy) {
  const label = policy.state === 'disabled' ? 'disabled' : 'unknown';
  return {
    reachable: false,
    started: false,
    reason: `Graphiti runtime policy is ${label}; tunnel start refused (${policy.reason})`,
  };
}

function isLocalGraphitiUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

function isGraphitiRuntimeHost(options = {}) {
  if (testOverridesAllowed(options) && typeof options.runtimeHost === 'boolean') {
    return options.runtimeHost;
  }
  if (process.env.GRAPHITI_RUNTIME_HOST === '1') return true;
  return (
    process.platform === 'linux' &&
    fs.existsSync('/opt/secondbrain') &&
    fs.existsSync('/home/ec2-user/secondbrain-current')
  );
}

function findGraphitiSshKey({ homeDir = os.homedir(), env = process.env, existsSync = fs.existsSync } = {}) {
  const homePath = (...parts) =>
    String(homeDir).startsWith('/')
      ? path.posix.join(homeDir, ...parts)
      : path.join(homeDir, ...parts);
  const candidates = [
    env.GRAPHITI_SSH_KEY,
    env.SECONDBRAIN_SSH_KEY,
    env.EC2_SSH_KEY,
    env.SB_KEY,
    homePath('.ssh', 'secondbrain-backend-key.pem'),
    homePath('.ssh', 'sb-key.pem'),
    homePath('.ssh', 'sb-deploy'),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function probeGraphiti(baseUrl, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let healthUrl;
    try {
      healthUrl = new URL('/health', baseUrl);
    } catch {
      resolve(false);
      return;
    }

    const client = healthUrl.protocol === 'https:' ? https : http;
    const request = client.get(healthUrl, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode === 200));
    });
    request.once('error', () => resolve(false));
    request.setTimeout(timeoutMs, () => request.destroy());
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tunnelLeaseIdentity({ baseUrl, localPort, remotePort, sshTarget }) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ baseUrl, localPort, remotePort, sshTarget }))
    .digest('hex');
}

function processExists(pid, killFn = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    killFn(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function graphitiDeployInProgress(options = {}) {
  const sentinelPath = testOverridesAllowed(options) && options.deploySentinelPath
    ? options.deploySentinelPath
    : DEFAULT_DEPLOY_SENTINEL;
  const readFileSync = testOverridesAllowed(options) && options.readFileSync
    ? options.readFileSync
    : fs.readFileSync;
  const pidIsLive = testOverridesAllowed(options) && options.processExists
    ? options.processExists
    : processExists;
  try {
    const sentinel = JSON.parse(readFileSync(sentinelPath, 'utf8'));
    return Number.isInteger(sentinel?.pid) && sentinel.pid > 0 && pidIsLive(sentinel.pid);
  } catch {
    return false;
  }
}

function readLeaseMetadata(lockDir, readFileSync = fs.readFileSync) {
  try {
    return JSON.parse(readFileSync(path.join(lockDir, 'lease.json'), 'utf8'));
  } catch {
    return null;
  }
}

function releaseTunnelLease(lease, options = {}) {
  if (!lease?.acquired) return false;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const rmSync = options.rmSync || fs.rmSync;
  const metadata = readLeaseMetadata(lease.lockDir, readFileSync);
  if (
    !metadata ||
    metadata.token !== lease.token ||
    metadata.ownerPid !== process.pid ||
    Number.isInteger(metadata.childPid)
  ) return false;
  try {
    rmSync(lease.lockDir, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

function acquireTunnelLease(identity, options = {}) {
  const leaseRoot = testOverridesAllowed(options) && options.leaseRoot
    ? options.leaseRoot
    : DEFAULT_LEASE_ROOT;
  const mkdirSync = options.mkdirSync || fs.mkdirSync;
  const renameSync = options.renameSync || fs.renameSync;
  const rmSync = options.rmSync || fs.rmSync;
  const writeFileSync = options.writeFileSync || fs.writeFileSync;
  const pidIsLive = options.processExists || processExists;
  const statSync = options.statSync || fs.statSync;
  const now = options.now || (() => Date.now());
  const maxLeaseAgeMs = options.maxLeaseAgeMs ?? DEFAULT_MAX_LEASE_AGE_MS;
  const lockDir = path.join(leaseRoot, `${identity}.lock`);

  mkdirSync(leaseRoot, { recursive: true });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = crypto.randomUUID();
    const claimDir = path.join(leaseRoot, `.${identity}.claim-${process.pid}-${token}`);
    try {
      mkdirSync(claimDir);
      const metadata = {
        schema: 'secondbrain.graphiti-tunnel-lease.v1',
        token,
        ownerPid: process.pid,
        childPid: null,
        createdAt: new Date().toISOString(),
      };
      writeFileSync(path.join(claimDir, 'lease.json'), `${JSON.stringify(metadata)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      renameSync(claimDir, lockDir);
      return { acquired: true, lockDir, token, metadata };
    } catch (error) {
      try {
        rmSync(claimDir, { recursive: true, force: true });
      } catch {
        // The claim may already have been renamed into the lock path.
      }
      if (!['EEXIST', 'EACCES', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
    }

    const existing = readLeaseMetadata(lockDir, options.readFileSync || fs.readFileSync);
    if (!existing) {
      // New claims are fully populated before their atomic rename. An unreadable
      // directory is therefore a legacy/in-progress foreign claim, never safe
      // to delete from this observation alone.
      return { acquired: false, lockDir, metadata: null, initializing: true };
    }
    const livePid = existing?.childPid || existing?.ownerPid;
    let leaseAgeMs = 0;
    try {
      leaseAgeMs = Math.max(0, now() - statSync(lockDir).mtimeMs);
    } catch {
      leaseAgeMs = 0;
    }
    if (pidIsLive(livePid) && leaseAgeMs <= maxLeaseAgeMs) {
      return { acquired: false, lockDir, metadata: existing };
    }

    const staleDir = `${lockDir}.stale-${process.pid}-${crypto.randomUUID()}`;
    try {
      renameSync(lockDir, staleDir);
      const quarantined = readLeaseMetadata(staleDir, options.readFileSync || fs.readFileSync);
      const quarantinedPid = quarantined?.childPid || quarantined?.ownerPid;
      let quarantinedAgeMs = leaseAgeMs;
      try {
        quarantinedAgeMs = Math.max(0, now() - statSync(staleDir).mtimeMs);
      } catch {
        // Retain the pre-rename observation.
      }
      if (quarantined && pidIsLive(quarantinedPid) && quarantinedAgeMs <= maxLeaseAgeMs) {
        try {
          renameSync(staleDir, lockDir);
        } catch {
          // Another complete claim won while this lease was quarantined. Keep
          // the live quarantine intact rather than deleting either owner.
        }
        return { acquired: false, lockDir, metadata: quarantined };
      }
      rmSync(staleDir, { recursive: true, force: true });
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(error?.code)) throw error;
    }
  }

  return { acquired: false, lockDir, metadata: readLeaseMetadata(lockDir) };
}

function updateLeaseChild(lease, childPid, options = {}) {
  if (!lease?.acquired || !Number.isInteger(childPid)) return false;
  const writeFileSync = options.writeFileSync || fs.writeFileSync;
  const metadata = { ...lease.metadata, childPid };
  try {
    writeFileSync(path.join(lease.lockDir, 'lease.json'), `${JSON.stringify(metadata)}\n`, 'utf8');
    lease.metadata = metadata;
    return true;
  } catch {
    return false;
  }
}

async function waitForGraphitiHealth(options, baseUrl, probe) {
  const attempts = options.attempts ?? 12;
  const delayMs = options.delayMs ?? 250;
  const sleep = options.sleep || wait;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await probe(baseUrl)) return true;
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return false;
}

async function startGraphitiTunnel(options, baseUrl, probe, lease) {
  const key = findGraphitiSshKey(options);
  if (!key) {
    releaseTunnelLease(lease, options);
    return { reachable: false, started: false, reason: 'Graphiti SSH key not found' };
  }

  const endpoint = new URL(baseUrl);
  const localPort = endpoint.port || '8000';
  const remotePort = String(options.remotePort ?? DEFAULT_REMOTE_PORT);
  const sshTarget = options.sshTarget || DEFAULT_SSH_TARGET;
  const spawnFn = options.spawn || spawn;
  let spawnError = null;
  let childPid = null;

  try {
    const child = spawnFn(
      options.sshBinary || 'ssh',
      [
        '-i',
        key,
        '-N',
        '-L',
        `127.0.0.1:${localPort}:localhost:${remotePort}`,
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ServerAliveInterval=60',
        '-o',
        'ServerAliveCountMax=3',
        sshTarget,
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child?.once?.('error', (error) => {
      spawnError = error;
    });
    if (Number.isInteger(child?.pid)) {
      childPid = child.pid;
      updateLeaseChild(lease, child.pid, options);
      const record = { child, startedAt: Date.now(), lease };
      activeTunnelProcesses.set(baseUrl, record);
      child.once?.('exit', () => {
        if (activeTunnelProcesses.get(baseUrl) === record) activeTunnelProcesses.delete(baseUrl);
        // Leave the child-owned lease for the next health-failing caller to
        // reclaim atomically. Deleting here can race a successor claim.
      });
    }
    child?.unref?.();
  } catch (error) {
    releaseTunnelLease(lease, options);
    return { reachable: false, started: false, reason: `Graphiti SSH tunnel failed: ${error.message}` };
  }

  if (await waitForGraphitiHealth(options, baseUrl, probe)) {
    if (childPid === null) releaseTunnelLease(lease, options);
    return { reachable: true, started: true, reason: null };
  }

  if (childPid === null) releaseTunnelLease(lease, options);
  const detail = spawnError ? `: ${spawnError.message}` : '';
  return { reachable: false, started: true, reason: `Graphiti SSH tunnel did not become healthy${detail}` };
}

async function ensureGraphitiTunnel(options = {}) {
  const policy = loadGraphitiRuntimePolicy(options);
  if (policy.state !== 'enabled') return policyBlockResult(policy);

  const baseUrl = options.baseUrl || DEFAULT_URL;
  const probe = options.probe || probeGraphiti;
  if (await probe(baseUrl)) {
    return { reachable: true, started: false, reason: null };
  }

  if (graphitiDeployInProgress(options)) {
    return {
      reachable: false,
      started: false,
      reason: 'Graphiti deployment is in progress; tunnel start suppressed',
    };
  }

  if (!isLocalGraphitiUrl(baseUrl)) {
    return { reachable: false, started: false, reason: 'Graphiti endpoint is not local' };
  }

  if (isGraphitiRuntimeHost(options)) {
    return {
      reachable: false,
      started: false,
      reason: 'Graphiti is unavailable on its runtime host; self-tunnel refused',
    };
  }

  const tracked = activeTunnelProcesses.get(baseUrl);
  if (tracked && tracked.child && tracked.child.exitCode === null && tracked.child.killed !== true) {
    if (await waitForGraphitiHealth(options, baseUrl, probe)) {
      return { reachable: true, started: false, reason: null };
    }
    return {
      reachable: false,
      started: false,
      reason: 'Graphiti SSH tunnel is already starting; duplicate spawn suppressed',
    };
  }
  if (tracked) activeTunnelProcesses.delete(baseUrl);

  const inFlight = activeTunnelAttempts.get(baseUrl);
  if (inFlight) return inFlight;

  const endpoint = new URL(baseUrl);
  const leaseIdentity = tunnelLeaseIdentity({
    baseUrl,
    localPort: endpoint.port || '8000',
    remotePort: String(options.remotePort ?? DEFAULT_REMOTE_PORT),
    sshTarget: options.sshTarget || DEFAULT_SSH_TARGET,
  });

  const attempt = (async () => {
    let lease;
    try {
      lease = acquireTunnelLease(leaseIdentity, options);
    } catch (error) {
      return {
        reachable: false,
        started: false,
        reason: `Graphiti tunnel lease unavailable; fail-closed (${error.code || error.message})`,
      };
    }

    if (!lease.acquired) {
      if (await waitForGraphitiHealth(options, baseUrl, probe)) {
        return { reachable: true, started: false, reason: null };
      }
      return {
        reachable: false,
        started: false,
        reason: 'Graphiti SSH tunnel lease is held by another process; duplicate spawn suppressed',
      };
    }
    return startGraphitiTunnel(options, baseUrl, probe, lease);
  })();

  activeTunnelAttempts.set(baseUrl, attempt);
  try {
    return await attempt;
  } finally {
    activeTunnelAttempts.delete(baseUrl);
  }
}

module.exports = {
  DEFAULT_DEPLOY_SENTINEL,
  DEFAULT_POLICY_PATH,
  acquireTunnelLease,
  ensureGraphitiTunnel,
  findGraphitiSshKey,
  graphitiDeployInProgress,
  isGraphitiRuntimeHost,
  isLocalGraphitiUrl,
  loadGraphitiRuntimePolicy,
  probeGraphiti,
  processExists,
  releaseTunnelLease,
  tunnelLeaseIdentity,
};
