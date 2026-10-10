'use strict';

// Minimal SSH transport to the production EC2 host for the agent delivery
// tools (otter-batch-launch, wait-for-receipt, deploy-hold). Same host and key
// defaults as scripts/deploy-ec2-server.sh.

const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function target(env = process.env) {
  return {
    host: env.SB_EC2_HOST || 'ec2-user@ExampleCo',
    key: env.SB_KEY || path.join(os.homedir(), '.ssh', 'sb-key.pem'),
  };
}

function sshArgs(remoteCommand, env = process.env, extra = []) {
  const t = target(env);
  return ['-i', t.key, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=20', ...extra, t.host, remoteCommand];
}

function runRemote(remoteCommand, { input, env = process.env, timeoutMs = 60000 } = {}) {
  const r = spawnSync('ssh', sshArgs(remoteCommand, env), { input, encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? r.error.message : '') };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

module.exports = { runRemote, shellQuote, sshArgs, target };
