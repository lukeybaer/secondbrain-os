'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function readRegularSnapshot(file, fsApi = fs) {
  const before = fsApi.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) throw new Error('dependency inputs must be private regular files');
  const fd = fsApi.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const actual = fsApi.fstatSync(fd);
    if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino || actual.nlink > 1) throw new Error('dependency input identity changed');
    return fsApi.readFileSync(fd, 'utf8');
  } finally { fsApi.closeSync(fd); }
}

function inspectModules(workspace, fsApi = fs) {
  const modules = path.join(workspace, 'node_modules');
  let stat;
  try { stat = fsApi.lstatSync(modules); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('dependency provisioning refuses linked node_modules');
  const relative = path.relative(fsApi.realpathSync(workspace), fsApi.realpathSync(modules));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('registered app node_modules escaped its workspace');
  return true;
}

function validateCanonicalNpmLock(workspace, fsApi = fs) {
  const packageFile = path.join(workspace, 'package.json');
  const lockFile = path.join(workspace, 'package-lock.json');
  if (!fsApi.existsSync(packageFile) || !fsApi.existsSync(lockFile)) {
    throw new Error('registered app dependency provisioning requires package.json and package-lock.json');
  }
  if (fsApi.existsSync(path.join(workspace, '.npmrc'))) {
    throw new Error('registered app dependency provisioning refuses project-controlled .npmrc');
  }
  const packageText = readRegularSnapshot(packageFile, fsApi);
  const manifest = JSON.parse(packageText);
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, raw] of Object.entries(manifest[section] || {})) {
      const spec = String(raw || '').trim();
      const registrySpec = /^[A-Za-z0-9*^~<>=| ._-]+$/.test(spec);
      const registryAlias = /^npm:(?:@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+)@[A-Za-z0-9*^~<>=| ._-]+$/.test(spec);
      if (!registrySpec && !registryAlias) throw new Error(`registered app dependency ${name} is not registry-bound`);
    }
  }
  const lockText = readRegularSnapshot(lockFile, fsApi);
  const lock = JSON.parse(lockText);
  if (!Number.isInteger(lock.lockfileVersion) || lock.lockfileVersion < 2) {
    throw new Error('registered app dependency provisioning requires a modern lockfile');
  }
  // Funding/homepage URLs are metadata. Only actual resolution/version
  // fields influence package acquisition and must be registry-bound.
  const visit = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    if (entry.link === true || (typeof entry.version === 'string' && /^(?:https?:|git(?:\+[^:]+)?:|ssh:|file:|github:|gitlab:|bitbucket:)/i.test(entry.version))) {
      throw new Error('registered app lockfile contains a noncanonical dependency source');
    }
    if (entry.resolved) {
      if (!/^https:\/\/registry\.npmjs\.org\//i.test(String(entry.resolved))) throw new Error('registered app lockfile contains a noncanonical dependency source');
      if (!/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(String(entry.integrity || ''))) throw new Error('registered app lockfile dependency lacks SRI integrity');
    }
    for (const value of Object.values(entry)) if (value && typeof value === 'object') visit(value);
  };
  visit(lock);
  return { packageFile, lockFile, packageText, lockText, lockSha256: crypto.createHash('sha256').update(lockText).digest('hex') };
}

function sanitizedNpmEnv(baseEnv, tempRoot) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (/^npm_config_/i.test(key) || /(?:TOKEN|SECRET|PASSWORD|PASS|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(key)) continue;
    if (['GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_HTTP_EXTRAHEADER', 'GH_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS'].includes(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: tempRoot,
    USERPROFILE: tempRoot,
    XDG_CONFIG_HOME: tempRoot,
    GIT_TERMINAL_PROMPT: '0',
    npm_config_userconfig: path.join(tempRoot, 'no-user-npmrc'),
    npm_config_globalconfig: path.join(tempRoot, 'no-global-npmrc'),
    npm_config_cache: path.join(tempRoot, 'cache'),
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  });
  return env;
}

function provisionLockedDependencies(workspace, options = {}) {
  const fsApi = options.fsApi || fs;
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  const realWorkspace = fsApi.realpathSync(workspace);
  const before = fsApi.lstatSync(workspace);
  if (!before.isDirectory() || before.isSymbolicLink() || path.resolve(workspace) !== realWorkspace) throw new Error('dependency workspace identity is not canonical');
  // Production installs run on EC2. A directory handle prevents an ancestor
  // rename or junction swap from redirecting the host's eventual handoff.
  if (process.platform !== 'linux' && !options.spawnSyncFn) throw new Error('trusted dependency provisioning requires a Linux directory handle');
  let directoryFd = null;
  let tempRoot = null;
  try {
    let pinned = realWorkspace;
    if (process.platform === 'linux') {
      directoryFd = fsApi.openSync(realWorkspace, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      const actual = fsApi.fstatSync(directoryFd);
      if (actual.dev !== before.dev || actual.ino !== before.ino) throw new Error('dependency workspace changed before pinning');
      pinned = '/proc/self/fd/' + directoryFd;
    }
    inspectModules(pinned, fsApi);
    const validated = validateCanonicalNpmLock(pinned, fsApi);
    tempRoot = fsApi.mkdtempSync(path.join(options.tempRoot || os.tmpdir(), 'amy-npm-provision-'));
    if (fsApi.statSync(tempRoot).dev !== before.dev) throw new Error('dependency handoff requires task temp on the workspace filesystem');
    fsApi.writeFileSync(path.join(tempRoot, 'package.json'), validated.packageText, { mode: 0o600 });
    fsApi.writeFileSync(path.join(tempRoot, 'package-lock.json'), validated.lockText, { mode: 0o600 });
    fsApi.writeFileSync(path.join(tempRoot, 'no-user-npmrc'), '', { mode: 0o600 });
    fsApi.writeFileSync(path.join(tempRoot, 'no-global-npmrc'), '', { mode: 0o600 });
    const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSyncFn(executable, [
      'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/',
    ], {
      cwd: tempRoot,
      env: sanitizedNpmEnv(options.env || process.env, tempRoot),
      encoding: 'utf8', timeout: options.timeoutMs || 20 * 60 * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) throw new Error('registered app lockfile dependency provisioning failed');
    if (!inspectModules(tempRoot, fsApi)) throw new Error('dependency provisioning did not produce node_modules');
    const current = validateCanonicalNpmLock(pinned, fsApi);
    if (current.packageText !== validated.packageText || current.lockText !== validated.lockText) throw new Error('dependency source changed during provisioning');
    const modules = path.join(pinned, 'node_modules');
    const backup = path.join(tempRoot, 'previous-node_modules');
    const hadModules = inspectModules(pinned, fsApi);
    if (hadModules) fsApi.renameSync(modules, backup);
    try { fsApi.renameSync(path.join(tempRoot, 'node_modules'), modules); }
    catch (error) {
      if (hadModules && !fsApi.existsSync(modules)) fsApi.renameSync(backup, modules);
      throw error;
    }
    return { ok: true, lock_sha256: validated.lockSha256, lifecycle_scripts: false, frozen_inputs: true, registry: 'https://registry.npmjs.org/' };
  } finally {
    if (tempRoot) fsApi.rmSync(tempRoot, { recursive: true, force: true });
    if (directoryFd !== null) fsApi.closeSync(directoryFd);
  }
}

function runTrustedNpmJob(jobFile) {
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  if (job.dependencyProvisioning?.type !== 'npm-ci' || !job.sandboxProfile || !job.tmpDir) throw new Error('trusted npm job requires its registered sandbox and temp boundary');
  const proofFile = jobFile + '.dependencies.proof';
  const saveProof = (proof) => {
    const temp = proofFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(proof), { mode: 0o600 });
    fs.renameSync(temp, proofFile);
  };
  let proof;
  try {
    const remaining = Date.parse(job.deadlineAt) - Date.now();
    if (!(remaining > 0)) throw new Error('dependency job deadline expired');
    proof = provisionLockedDependencies(job.cwd, { env: process.env, tempRoot: job.tmpDir, timeoutMs: remaining });
    saveProof(proof);
  } catch (error) {
    saveProof({ ok: false, lifecycle_scripts: false, error: String(error.message || error).slice(0,500) });
    throw error;
  }
  const remaining = Date.parse(job.deadlineAt) - Date.now();
  if (!(remaining > 0)) throw new Error('dependency job deadline expired before payload');
  const permissions = require('./owner-task-permissions.js');
  const launch = permissions.sandboxedPayload(job.command, job.args, { cwd: job.cwd, workspace: job.cwd, protectedPaths: job.sandboxProfile.protectedPaths });
  const result = spawnSync(launch.command, launch.args, { cwd: job.cwd, env: process.env, stdio: 'inherit', timeout: remaining });
  return result.status === 0 ? 0 : 1;
}

if (require.main === module) {
  try {
    if (process.argv[2] !== 'run-job' || !process.argv[3]) throw new Error('registered run-job required');
    process.exitCode = runTrustedNpmJob(process.argv[3]);
  } catch (error) {
    process.stderr.write('trusted dependency job failed: ' + String(error.message || error).slice(0,500) + '\n');
    process.exitCode = 1;
  }
}

module.exports = { provisionLockedDependencies, sanitizedNpmEnv, validateCanonicalNpmLock, runTrustedNpmJob };
