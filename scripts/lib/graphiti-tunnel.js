'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const DEFAULT_URL = process.env.GRAPHITI_URL || 'http://127.0.0.1:8000';
const DEFAULT_SSH_TARGET = process.env.GRAPHITI_SSH_TARGET || 'ec2-user@ExampleCo';
const DEFAULT_REMOTE_PORT = Number(process.env.GRAPHITI_REMOTE_PORT || 8000);
const activeTunnelAttempts = new Map();

function isLocalGraphitiUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

function findGraphitiSshKey({ homeDir = os.homedir(), env = process.env, existsSync = fs.existsSync } = {}) {
  const candidates = [
    env.GRAPHITI_SSH_KEY,
    path.join(homeDir, '.ssh', 'secondbrain-backend-key.pem'),
    path.join(homeDir, '.ssh', 'sb-key.pem'),
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

async function startGraphitiTunnel(options, baseUrl, probe) {
  const key = findGraphitiSshKey(options);
  if (!key) {
    return { reachable: false, started: false, reason: 'Graphiti SSH key not found' };
  }

  const endpoint = new URL(baseUrl);
  const localPort = endpoint.port || '8000';
  const remotePort = String(options.remotePort ?? DEFAULT_REMOTE_PORT);
  const sshTarget = options.sshTarget || DEFAULT_SSH_TARGET;
  const spawnFn = options.spawn || spawn;
  const sleep = options.sleep || wait;
  const attempts = options.attempts ?? 12;
  const delayMs = options.delayMs ?? 250;
  let spawnError = null;

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
    child?.unref?.();
  } catch (error) {
    return { reachable: false, started: false, reason: `Graphiti SSH tunnel failed: ${error.message}` };
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await probe(baseUrl)) {
      return { reachable: true, started: true, reason: null };
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }

  const detail = spawnError ? `: ${spawnError.message}` : '';
  return { reachable: false, started: true, reason: `Graphiti SSH tunnel did not become healthy${detail}` };
}

async function ensureGraphitiTunnel(options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_URL;
  const probe = options.probe || probeGraphiti;

  if (await probe(baseUrl)) {
    return { reachable: true, started: false, reason: null };
  }

  if (!isLocalGraphitiUrl(baseUrl)) {
    return { reachable: false, started: false, reason: 'Graphiti endpoint is not local' };
  }

  const inFlight = activeTunnelAttempts.get(baseUrl);
  if (inFlight) {
    return inFlight;
  }

  const attempt = startGraphitiTunnel(options, baseUrl, probe);
  activeTunnelAttempts.set(baseUrl, attempt);
  try {
    return await attempt;
  } finally {
    activeTunnelAttempts.delete(baseUrl);
  }
}

module.exports = {
  ensureGraphitiTunnel,
  findGraphitiSshKey,
  isLocalGraphitiUrl,
  probeGraphiti,
};
