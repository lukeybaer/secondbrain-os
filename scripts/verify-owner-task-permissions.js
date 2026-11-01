#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const permissions = require('./lib/owner-task-permissions.js');

function value(argv, name, fallback = '') {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] != null ? argv[at + 1] : fallback;
}

function probeSource() {
  return String.raw`
const fs = require('fs');
const net = require('net');
const protectedPath = process.argv[1];
const marker = process.argv[2];
let credentialReadable = true;
let workspaceWritable = false;
try { fs.accessSync(protectedPath, fs.constants.R_OK); } catch { credentialReadable = false; }
try { fs.writeFileSync(marker, 'permission-profile-probe'); workspaceWritable = true; fs.rmSync(marker, { force: true }); } catch {}
let settled = false;
const finish = (networkReachable) => {
  if (settled) return;
  settled = true;
  fs.writeSync(1, JSON.stringify({ credential_readable: credentialReadable, workspace_writable: workspaceWritable, network_reachable: networkReachable }) + '\n');
  process.exit(!credentialReadable && workspaceWritable && !networkReachable ? 0 : 1);
};
const socket = net.connect({ host: '169.254.169.254', port: 80 });
socket.setTimeout(1000);
socket.once('connect', () => { socket.destroy(); finish(true); });
socket.once('timeout', () => { socket.destroy(); finish(false); });
socket.once('error', () => finish(false));
setTimeout(() => finish(false), 1500).unref();
`;
}

function run(argv = process.argv.slice(2), options = {}) {
  const credentialDir = path.resolve(value(argv, '--credential-dir', permissions.DEFAULT_GITHUB_CREDENTIAL_ROOT));
  const requestedWorkspace = value(argv, '--workspace');
  const createdWorkspace = !requestedWorkspace;
  const workspace = requestedWorkspace
    ? path.resolve(requestedWorkspace)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'amy-owner-permission-probe-'));
  const marker = path.join(workspace, `.amy-owner-permission-probe-${process.pid}`);
  const launch = permissions.sandboxedPayload(
    process.execPath,
    ['-e', probeSource(), credentialDir, marker],
    {
      cwd: workspace,
      workspace,
      sourceRoot: value(argv, '--source-root') || undefined,
      liveRoot: value(argv, '--live-root') || undefined,
      extraPaths: [credentialDir],
    },
  );
  if (argv.includes('--print-args')) {
    process.stdout.write(`${JSON.stringify(launch, null, 2)}\n`);
    if (createdWorkspace) fs.rmSync(workspace, { recursive: true, force: true });
    return { status: 0, launch };
  }
  const result = (options.spawnSyncFn || spawnSync)(launch.command, launch.args, {
    cwd: workspace,
    env: process.env,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (createdWorkspace) fs.rmSync(workspace, { recursive: true, force: true });
  if (result.status !== 0) {
    const error = new Error(`owner task permission probe failed (${result.status}): ${String(result.stderr || '').trim()}`);
    error.result = result;
    throw error;
  }
  const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  const receipt = JSON.parse(lines.at(-1));
  if (
    receipt.credential_readable !== false ||
    receipt.workspace_writable !== true ||
    receipt.network_reachable !== false
  ) {
    throw new Error('owner task permission probe did not prove the required boundary');
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  return { status: 0, receipt, launch };
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { probeSource, run };
