#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ec2SshTarget } = require('./lib/ec2-endpoint.js');
const { sourceSha, fileHash } = require('./lib/runtime-source-sha.js');

const DEFAULT_EC2_ENV_FILE = '/opt/secondbrain-durable/.env';

const DESKTOP_RUNTIME_FILES = Object.freeze([
  'scripts/desktop-capability-worker.js',
  'scripts/desktop-snapshot-maintenance.js',
  'scripts/lib/runtime-source-sha.js',
  'scripts/lib/briefing-card-producers.js',
  'scripts/publish-git-hygiene-snapshot.js',
  'scripts/verify-shared-checkout-clean.js',
  'scripts/lib/git-hygiene.js',
  'scripts/lib/devops-health.js',
  'scripts/lib/core-component-registry.js',
  'scripts/lib/shared-dirt-tripwire.js',
  'scripts/lib/shared-tree-guard.js',
  'scripts/lib/shared-tree-write-guard.js',
  'scripts/lib/mutation-surface-matrix.js',
  'scripts/lib/public-mirror-health.js',
  'scripts/lib/public-payload-projection.js',
  'scripts/lib/forbidden-people.js',
  'scripts/lib/hook-delivery.js',
  'scripts/simulate-public-sync.js',
  'scripts/pii-screen.js',
  'scripts/build-pii-denylist.js',
  'scripts/register-desktop-capability-worker.ps1',
  'scripts/silent-node-launcher.vbs',
  'scripts/lib/cli-output-guard.js',
  'scripts/lib/desktop-capability-http-auth.js',
  'scripts/lib/desktop-capability-relay.js',
  'scripts/lib/desktop-dev-sessions.js',
  'scripts/lib/desktop-session-registry.js',
  'scripts/lib/controller-conflict-leases.js',
  'scripts/lib/write-json-atomic-retry.js',
  'scripts/lib/ec2-endpoint.js',
  'scripts/lib/model-router.js',
]);

function envValue(file, key) {
  if (!fs.existsSync(file)) return '';
  const prefix = `${key}=`;
  const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((row) => row.startsWith(prefix));
  return line ? line.slice(prefix.length).trim().replace(/^(['"])(.*)\1$/, '$2') : '';
}

function upsertEnv(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const keys = new Set(Object.keys(values));
  const kept = existing.filter((line) => ![...keys].some((key) => line.startsWith(`${key}=`)));
  const rows = [...kept.filter(Boolean), ...Object.entries(values).map(([key, value]) => `${key}=${value}`)];
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${rows.join('\n')}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows ACL is set by the owner profile. */ }
  return file;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function assertSecret(secret) {
  if (String(secret || '').length < 32) throw new Error('desktop relay secret must be at least 32 characters');
  return secret;
}

function installDesktopRuntime(sourceRoot, runtimeRoot) {
  const source = path.resolve(sourceRoot);
  const target = path.resolve(runtimeRoot);
  const sha = sourceSha(source);
  if (process.env.SB_DEPLOY_SHA && process.env.SB_DEPLOY_SHA !== sha) throw new Error('requested deployment SHA differs from the source provenance');
  if (source === target) return { root: target, files: DESKTOP_RUNTIME_FILES.length, reused: true };
  for (const relative of DESKTOP_RUNTIME_FILES) {
    const from = path.join(source, relative);
    const to = path.join(target, relative);
    if (!fs.existsSync(from)) throw new Error(`desktop runtime source file is missing: ${relative}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const temp = `${to}.${process.pid}.tmp`;
    fs.copyFileSync(from, temp);
    const fd = fs.openSync(temp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, to);
  }
  const manifest = {
    schema: 'amy.desktop-capability-runtime.v1',
    installed_at: new Date().toISOString(),
    source_commit: sha,
    files: DESKTOP_RUNTIME_FILES,
    file_hashes: Object.fromEntries(DESKTOP_RUNTIME_FILES.map(relative => [relative, fileHash(path.join(target, relative))])),
  };
  const manifestFile = path.join(target, 'runtime-manifest.json');
  const manifestTemp = `${manifestFile}.${process.pid}.tmp`;
  const manifestFd = fs.openSync(manifestTemp, 'w', 0o600);
  try {
    fs.writeFileSync(manifestFd, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.fsyncSync(manifestFd);
  } finally {
    fs.closeSync(manifestFd);
  }
  fs.renameSync(manifestTemp, manifestFile);
  return { root: target, files: DESKTOP_RUNTIME_FILES.length, reused: false };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--ec2-stdin')) {
    const secret = assertSecret(await readStdin());
    // Atomic upsert uses rename. Writing through /opt/secondbrain/.env would
    // replace the current release's durable symlink with a release-local file,
    // so the secret would disappear at the next atomic deployment.
    const file = process.env.AMY_EC2_ENV_FILE || DEFAULT_EC2_ENV_FILE;
    upsertEnv(file, { AMY_DESKTOP_RELAY_SECRET: secret });
    return { ok: true, target: 'ec2', secret_printed: false };
  }

  const sourceRoot = path.resolve(__dirname, '..');
  const stableRoot =
    process.env.AMY_DESKTOP_RUNTIME_ROOT ||
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'secondbrain', 'desktop-capability-runtime');
  const localFile =
    process.env.AMY_DESKTOP_WORKER_ENV_FILE ||
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'secondbrain', 'desktop-capability-worker.env');
  const secret = assertSecret(envValue(localFile, 'AMY_DESKTOP_RELAY_SECRET') || crypto.randomBytes(32).toString('hex'));
  const sshTarget = ec2SshTarget();
  upsertEnv(localFile, {
    AMY_DESKTOP_RELAY_SECRET: secret,
    AMY_DESKTOP_RELAY_URL: 'http://127.0.0.1:3301',
    AMY_DESKTOP_RELAY_SSH_TARGET: sshTarget,
    AMY_DESKTOP_RELAY_SSH_KEY: path.join(os.homedir(), '.ssh', 'sb-key.pem'),
  });

  const ssh = spawnSync(
    'ssh',
    [
      '-i', path.join(os.homedir(), '.ssh', 'sb-key.pem'),
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=no',
      sshTarget,
      'cd /opt/secondbrain && node scripts/provision-desktop-capability-relay.js --ec2-stdin && pm2 restart secondbrain-backend --update-env',
    ],
    { input: `${secret}\n`, encoding: 'utf8', timeout: 60_000, windowsHide: true },
  );
  if (ssh.status !== 0) throw new Error(`EC2 relay provisioning failed: ${String(ssh.stderr || ssh.stdout).slice(0, 500)}`);

  const runtime = installDesktopRuntime(sourceRoot, stableRoot);

  const register = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(stableRoot, 'scripts', 'register-desktop-capability-worker.ps1'), '-RepoRoot', stableRoot],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true },
  );
  if (register.status !== 0) throw new Error(`desktop worker registration failed: ${String(register.stderr || register.stdout).slice(0, 500)}`);
  return { ok: true, target: 'desktop-and-ec2', local_env_file: localFile, runtime, secret_printed: false };
}

if (require.main === module) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_EC2_ENV_FILE,
  DESKTOP_RUNTIME_FILES,
  assertSecret,
  envValue,
  installDesktopRuntime,
  main,
  upsertEnv,
};
