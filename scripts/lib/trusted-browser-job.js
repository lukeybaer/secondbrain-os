'use strict';

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const npmProvisioner = require('./trusted-npm-provisioner.js');
const repositoryAccess = require('./repository-access.js');

const DOCKER_HOST = 'unix:///var/run/docker.sock';
const DOCKER_BIN = '/usr/bin/docker';
const SUDO_BIN = '/usr/bin/sudo';
const SYSTEMD_RUN_BIN = '/usr/bin/systemd-run';
const SYSTEMCTL_BIN = '/usr/bin/systemctl';
const PLAYWRIGHT_IMAGES = Object.freeze({
  '1.62.1': Object.freeze({
    tag: 'v1.62.1-noble',
    digest: 'sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac',
    platform: 'linux/amd64',
  }),
});

function writeJsonAtomic(file, value, fsApi = fs) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fsApi.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fsApi.renameSync(tmp, file);
}

function safeName(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 90);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function jobIdentity(job) {
  return sha256(JSON.stringify([String(job?.taskId || ''), String(job?.id || '')]));
}

function assertContainerId(value) {
  const cid = String(value || '').trim();
  if (!/^[a-f0-9]{64}$/.test(cid)) throw new Error('trusted browser container ID is malformed');
  return cid;
}

function dockerEnv(baseEnv = process.env, home = os.tmpdir()) {
  return {
    PATH: String(baseEnv.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'),
    HOME: home,
    DOCKER_CONFIG: path.join(home, 'docker-config-empty'),
  };
}

function dockerArgs(args) {
  return ['-H', DOCKER_HOST, ...args];
}

function relativeProtectedPaths(sourceRoot, protectedPaths = []) {
  const source = path.resolve(sourceRoot);
  const rows = [];
  for (const value of protectedPaths) {
    if (!value) continue;
    const relative = path.relative(source, path.resolve(String(value)));
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
      rows.push(relative.split(path.sep).join('/'));
    }
  }
  return rows;
}

function excludedSourcePath(relative, protectedRelatives = []) {
  const normalized = String(relative || '').split(path.sep).join('/').replace(/^\.\//, '');
  const parts = normalized.split('/').filter(Boolean);
  const base = parts.at(-1) || '';
  if (parts.includes('.git') || parts.includes('node_modules')) return true;
  if (['.npmrc', '.gitconfig', '.netrc', '.aws', '.ssh', '.gnupg'].includes(base)) return true;
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\..*)?$/i.test(base)) return true;
  if (/\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(base)) return true;
  if (/^(?:credentials?|secrets?)(?:\.[^.]+)?$/i.test(base)) return true;
  return protectedRelatives.some((protectedRelative) =>
    normalized === protectedRelative || normalized.startsWith(protectedRelative + '/'));
}

function assertInternalRelativeLink(relative, target, protectedRelatives = []) {
  if (!target || path.isAbsolute(target)) throw new Error(`source symlink must be relative and internal: ${relative}`);
  const resolved = path.normalize(path.join(path.dirname(relative), target));
  if (resolved === '..' || resolved.startsWith('..' + path.sep) || path.isAbsolute(resolved)) {
    throw new Error(`source symlink escapes the registered workspace: ${relative}`);
  }
  if (excludedSourcePath(resolved, protectedRelatives)) {
    throw new Error(`source symlink targets an excluded path: ${relative}`);
  }
  return resolved;
}

function copyDescriptorToNewFile(sourceFd, destination, mode, fsApi = fs) {
  const outputFd = fsApi.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode & 0o777);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  try {
    while (true) {
      const read = fsApi.readSync(sourceFd, buffer, 0, buffer.length, position);
      if (!read) break;
      let written = 0;
      while (written < read) written += fsApi.writeSync(outputFd, buffer, written, read - written);
      position += read;
    }
  } finally {
    fsApi.closeSync(outputFd);
  }
}

function safeTrackedPath(value) {
  const text = String(value || '');
  if (
    !text || text.length > 1000 || text.includes('\0') || text.includes('\\') || text.includes('\uFFFD') ||
    path.isAbsolute(text) || text.split('/').some((part) => !part || part === '.' || part === '..') ||
    text === '.git' || text.startsWith('.git/')
  ) throw new Error('committed browser source contains an unsafe tracked path');
  return text;
}

function committedTreeEntries(source, expectedCommitSha, spawnSyncFn = spawnSync) {
  const expected = String(expectedCommitSha || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expected)) throw new Error('committed browser source SHA is malformed');
  const commit = repositoryAccess.runSafeGit(spawnSyncFn, source, ['rev-parse', '--verify', `${expected}^{commit}`], 30_000);
  if (!commit.ok || commit.stdout.trim().toLowerCase() !== expected) {
    throw new Error('committed browser source does not resolve to the exact expected commit');
  }
  const tree = repositoryAccess.runSafeGit(
    spawnSyncFn, source, ['ls-tree', '-r', '-z', '--full-tree', expected, '--'], 60_000,
  );
  if (!tree.ok) throw new Error('committed browser source tree could not be enumerated');
  const rows = tree.stdout.split('\0');
  if (rows.at(-1) === '') rows.pop();
  if (!rows.length) throw new Error('committed browser source tree is empty');
  const entries = rows.map((row) => {
    const match = row.match(/^([0-7]{6}) ([a-z]+) ([0-9a-f]{40})\t([\s\S]+)$/);
    if (!match) throw new Error('committed browser source tree entry is malformed');
    const [, mode, type, oid, rawPath] = match;
    const relative = safeTrackedPath(rawPath);
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
      throw new Error(`committed browser source refuses symlink, gitlink, or unsupported mode: ${relative}`);
    }
    return { mode, type, oid, path: relative };
  });
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new Error('committed browser source tree contains duplicate paths');
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function copyCommittedDescriptor(sourceFd, destination, mode, stat, expectedOid, fsApi = fs) {
  const outputFd = fsApi.openSync(
    destination,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    Number.parseInt(mode, 8) & 0o777,
  );
  const digest = crypto.createHash('sha1');
  digest.update(`blob ${stat.size}\0`);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  try {
    while (true) {
      const read = fsApi.readSync(sourceFd, buffer, 0, buffer.length, position);
      if (!read) break;
      digest.update(buffer.subarray(0, read));
      let written = 0;
      while (written < read) written += fsApi.writeSync(outputFd, buffer, written, read - written);
      position += read;
    }
  } finally {
    fsApi.closeSync(outputFd);
  }
  if (position !== stat.size || digest.digest('hex') !== expectedOid) {
    throw new Error('committed browser source bytes do not match the expected Git blob');
  }
  return position;
}

function freezeCommittedSourceSnapshot(sourceRoot, destination, options = {}) {
  const fsApi = options.fsApi || fs;
  const platform = options.platform || process.platform;
  if (platform !== 'linux') throw new Error('trusted committed source freezing requires Linux directory descriptors');
  if (!fs.constants.O_DIRECTORY || !fs.constants.O_NOFOLLOW) {
    throw new Error('trusted committed source freezing requires O_DIRECTORY and O_NOFOLLOW');
  }
  const source = fsApi.realpathSync(sourceRoot);
  if (path.resolve(sourceRoot) !== source) throw new Error('browser source workspace must be a canonical real path');
  const dest = path.resolve(destination);
  const relativeDest = path.relative(source, dest);
  if (!relativeDest || (!relativeDest.startsWith('..' + path.sep) && relativeDest !== '..' && !path.isAbsolute(relativeDest))) {
    throw new Error('browser source snapshot must be outside the model-writable workspace');
  }
  if (fsApi.existsSync(dest)) throw new Error('browser source snapshot already exists');
  const expectedCommitSha = String(options.expectedCommitSha || '').toLowerCase();
  const entries = committedTreeEntries(source, expectedCommitSha, options.spawnSyncFn || spawnSync);
  const protectedRelatives = relativeProtectedPaths(source, options.protectedPaths || []);
  if (protectedRelatives.includes('')) throw new Error('browser source workspace is itself a protected credential path');
  const allowed = entries.filter((entry) => !excludedSourcePath(entry.path, protectedRelatives));
  const excluded = entries.length - allowed.length;
  if (!allowed.length) throw new Error('committed browser source has no allowed tracked files');
  const rootFd = fsApi.openSync(source, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const rootStat = fsApi.fstatSync(rootFd);
  if (!rootStat.isDirectory()) {
    fsApi.closeSync(rootFd);
    throw new Error('browser source root is not a directory');
  }
  fsApi.mkdirSync(dest, { recursive: false, mode: 0o700 });
  const proof = {
    binding: 'git-commit-v1',
    commit_sha: expectedCommitSha,
    source_digest_sha256: crypto.createHash('sha256').update(JSON.stringify({
      commit_sha: expectedCommitSha,
      tree: entries.map((entry) => [entry.mode, entry.oid, entry.path]),
    })).digest('hex'),
    tracked_files: entries.length,
    files: 0,
    directories: 1,
    excluded,
    bytes: 0,
  };

  const openDirectory = (parentFd, name, relative) => {
    const candidate = path.join(`/proc/self/fd/${parentFd}`, name);
    const before = fsApi.lstatSync(candidate);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error(`committed browser source parent is not a regular directory: ${relative}`);
    }
    const fd = fsApi.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const actual = fsApi.fstatSync(fd);
    if (!actual.isDirectory() || actual.dev !== before.dev || actual.ino !== before.ino || actual.dev !== rootStat.dev) {
      fsApi.closeSync(fd);
      throw new Error(`committed browser source directory identity changed or crossed a mount: ${relative}`);
    }
    return { fd, stat: actual };
  };

  try {
    for (const entry of allowed) {
      const parts = entry.path.split('/');
      let directoryFd = rootFd;
      const opened = [];
      let output = dest;
      try {
        for (const part of parts.slice(0, -1)) {
          const relative = parts.slice(0, opened.length + 1).join('/');
          const next = openDirectory(directoryFd, part, relative);
          opened.push(next.fd);
          directoryFd = next.fd;
          output = path.join(output, part);
          if (!fsApi.existsSync(output)) {
            fsApi.mkdirSync(output, { mode: 0o755 });
            proof.directories += 1;
          } else if (!fsApi.lstatSync(output).isDirectory()) {
            throw new Error(`committed browser snapshot path collides with a file: ${relative}`);
          }
        }
        const leaf = parts.at(-1);
        const sourcePath = path.join(`/proc/self/fd/${directoryFd}`, leaf);
        const before = fsApi.lstatSync(sourcePath);
        if (before.isSymbolicLink() || !before.isFile() || before.dev !== rootStat.dev || before.nlink !== 1) {
          throw new Error(`committed browser source file is unsafe or shared: ${entry.path}`);
        }
        const fileFd = fsApi.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const actual = fsApi.fstatSync(fileFd);
          if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino || actual.dev !== rootStat.dev || actual.nlink !== 1) {
            throw new Error(`committed browser source file identity changed or is shared: ${entry.path}`);
          }
          const bytes = copyCommittedDescriptor(fileFd, path.join(output, leaf), entry.mode, actual, entry.oid, fsApi);
          const after = fsApi.fstatSync(fileFd);
          if (
            after.dev !== actual.dev || after.ino !== actual.ino || after.size !== actual.size ||
            after.mtimeMs !== actual.mtimeMs || after.ctimeMs !== actual.ctimeMs
          ) throw new Error(`committed browser source file changed during read: ${entry.path}`);
          proof.files += 1;
          proof.bytes += bytes;
        } finally {
          fsApi.closeSync(fileFd);
        }
      } finally {
        for (const fd of opened.reverse()) fsApi.closeSync(fd);
      }
    }
  } catch (error) {
    fsApi.rmSync(dest, { recursive: true, force: true });
    throw error;
  } finally {
    fsApi.closeSync(rootFd);
  }
  return proof;
}

function freezeSourceSnapshot(sourceRoot, destination, options = {}) {
  const fsApi = options.fsApi || fs;
  const platform = options.platform || process.platform;
  if (platform !== 'linux') throw new Error('trusted browser source freezing requires Linux directory descriptors');
  if (!fs.constants.O_DIRECTORY || !fs.constants.O_NOFOLLOW) {
    throw new Error('trusted browser source freezing requires O_DIRECTORY and O_NOFOLLOW');
  }
  const source = fsApi.realpathSync(sourceRoot);
  if (path.resolve(sourceRoot) !== source) throw new Error('browser source workspace must be a canonical real path');
  const dest = path.resolve(destination);
  const relativeDest = path.relative(source, dest);
  if (!relativeDest || (!relativeDest.startsWith('..' + path.sep) && relativeDest !== '..' && !path.isAbsolute(relativeDest))) {
    throw new Error('browser source snapshot must be outside the model-writable workspace');
  }
  if (fsApi.existsSync(dest)) throw new Error('browser source snapshot already exists');
  const protectedRelatives = relativeProtectedPaths(source, options.protectedPaths || []);
  if (protectedRelatives.includes('')) throw new Error('browser source workspace is itself a protected credential path');
  const rootFd = fsApi.openSync(source, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const rootStat = fsApi.fstatSync(rootFd);
  if (!rootStat.isDirectory()) {
    fsApi.closeSync(rootFd);
    throw new Error('browser source root is not a directory');
  }
  const proof = { files: 0, directories: 1, symlinks: 0, excluded: 0, bytes: 0 };
  fsApi.mkdirSync(dest, { recursive: false, mode: 0o700 });

  const copyDirectory = (directoryFd, relative, output) => {
    const descriptorPath = `/proc/self/fd/${directoryFd}`;
    const names = fsApi.readdirSync(descriptorPath).sort();
    for (const name of names) {
      if (name === '.' || name === '..') continue;
      const childRelative = relative ? path.join(relative, name) : name;
      if (excludedSourcePath(childRelative, protectedRelatives)) {
        proof.excluded += 1;
        continue;
      }
      const childPath = path.join(descriptorPath, name);
      const before = fsApi.lstatSync(childPath);
      const outputPath = path.join(output, name);
      if (before.isSymbolicLink()) {
        const target = fsApi.readlinkSync(childPath);
        assertInternalRelativeLink(childRelative, target, protectedRelatives);
        fsApi.symlinkSync(target, outputPath);
        proof.symlinks += 1;
        continue;
      }
      if (before.isDirectory()) {
        const childFd = fsApi.openSync(childPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try {
          const actual = fsApi.fstatSync(childFd);
          if (!actual.isDirectory() || actual.dev !== before.dev || actual.ino !== before.ino || actual.dev !== rootStat.dev) {
            throw new Error(`browser source directory identity changed or crossed a mount: ${childRelative}`);
          }
          fsApi.mkdirSync(outputPath, { mode: before.mode & 0o777 });
          proof.directories += 1;
          copyDirectory(childFd, childRelative, outputPath);
        } finally {
          fsApi.closeSync(childFd);
        }
        continue;
      }
      if (!before.isFile()) throw new Error(`browser source contains an unsupported file type: ${childRelative}`);
      const fileFd = fsApi.openSync(childPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const actual = fsApi.fstatSync(fileFd);
        if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino || actual.dev !== rootStat.dev || actual.nlink > 1) {
          throw new Error(`browser source file identity changed or is shared: ${childRelative}`);
        }
        copyDescriptorToNewFile(fileFd, outputPath, before.mode, fsApi);
        proof.files += 1;
        proof.bytes += actual.size;
      } finally {
        fsApi.closeSync(fileFd);
      }
    }
  };

  try {
    copyDirectory(rootFd, '', dest);
  } catch (error) {
    fsApi.rmSync(dest, { recursive: true, force: true });
    throw error;
  } finally {
    fsApi.closeSync(rootFd);
  }
  return proof;
}

function resolvePlaywrightImage(workspace, fsApi = fs) {
  const lock = JSON.parse(fsApi.readFileSync(path.join(workspace, 'package-lock.json'), 'utf8'));
  const versions = new Set();
  for (const key of ['node_modules/@playwright/test', 'node_modules/playwright', 'node_modules/playwright-core']) {
    const version = lock.packages?.[key]?.version;
    if (version) versions.add(String(version));
  }
  if (versions.size !== 1) throw new Error('browser job requires one exact locked Playwright version');
  const version = [...versions][0];
  const image = PLAYWRIGHT_IMAGES[version];
  if (!image) throw new Error(`browser job has no trusted official image for Playwright ${version}`);
  return {
    version,
    ...image,
    repository: 'mcr.microsoft.com/playwright',
    reference: `mcr.microsoft.com/playwright:${image.tag}@${image.digest}`,
  };
}

function containerName(job) {
  const readable = safeName(`${job?.taskId || 'task'}-${job?.id || 'job'}`).slice(0, 38) || 'job';
  return `amy-browser-${readable}-${jobIdentity(job)}`;
}

function remainingSeconds(job, nowMs = Date.now()) {
  const ms = Date.parse(job.deadlineAt) - nowMs;
  if (!(ms > 15_000)) throw new Error('browser job deadline expired before container launch');
  return Math.max(1, Math.floor((ms - 10_000) / 1000));
}

function buildDockerCreateArgs({ job, snapshotDir, artifactDir, image, timeoutSeconds, user }) {
  if ([snapshotDir, artifactDir].some((value) => String(value).includes(','))) {
    throw new Error('browser job protected paths may not contain commas');
  }
  const name = containerName(job);
  const identity = jobIdentity(job);
  const containerUser = user || `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  return dockerArgs([
    'create', '--rm', '--pull=never', '--platform', image.platform,
    '--name', name,
    '--user', containerUser,
    '--network', 'none', '--restart', 'no', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '512', '--memory', '6g', '--shm-size', '1g', '--read-only', '--init', '--stop-timeout', '10',
    '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777,size=1073741824',
    '--tmpfs', '/var/tmp:rw,nosuid,nodev,mode=1777,size=536870912',
    '--mount', `type=bind,src=${snapshotDir},dst=/work`,
    '--mount', `type=bind,src=${artifactDir},dst=/artifacts`,
    '--workdir', '/work',
    '--env', 'CI=1', '--env', 'HOME=/tmp/amy-home', '--env', 'XDG_CACHE_HOME=/tmp/amy-cache',
    '--env', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
    '--env', 'PLAYWRIGHT_HTML_OUTPUT_DIR=/artifacts/playwright-report',
    '--env', 'NO_COLOR=1',
    '--label', `amy.browser.identity=${identity}`,
    '--label', `amy.spine-job=${safeName(job.id)}`,
    image.reference,
    'timeout', '--signal=TERM', '--kill-after=10s', `${timeoutSeconds}s`,
    'npm', 'run', 'test:e2e', '--', '--output=/artifacts/test-results',
  ]);
}

function runChecked(command, args, options = {}) {
  const result = (options.spawnSyncFn || spawnSync)(command, args, {
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`${options.label || command} failed`);
  return result;
}

function provisionOfficialImage(image, options = {}) {
  const env = options.env || dockerEnv(process.env, options.home);
  runChecked('docker', dockerArgs(['pull', '--platform', image.platform, image.reference]), {
    ...options, env, label: 'trusted Playwright image pull', timeoutMs: options.timeoutMs || 20 * 60_000,
  });
  const inspected = runChecked('docker', dockerArgs(['image', 'inspect', '--format', '{{json .RepoDigests}}|{{.Architecture}}', image.reference]), {
    ...options, env, label: 'trusted Playwright image inspect', timeoutMs: 60_000,
  });
  const value = String(inspected.stdout || '');
  if (!value.includes(image.digest) || !value.trim().endsWith('|amd64')) {
    throw new Error('trusted Playwright image digest or architecture did not match');
  }
  return { digest: image.digest, architecture: 'amd64' };
}

function verifyContainerOwnership(cid, identity, options = {}) {
  const containerId = assertContainerId(cid);
  if (!/^[a-f0-9]{64}$/.test(String(identity || ''))) throw new Error('trusted browser job identity is malformed');
  const env = options.env || dockerEnv(process.env, options.home);
  const result = (options.spawnSyncFn || spawnSync)('docker', dockerArgs([
    'container', 'inspect', '--format', '{{.Id}}|{{index .Config.Labels "amy.browser.identity"}}', containerId,
  ]), {
    env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || result.error || String(result.stdout || '').trim() !== `${containerId}|${identity}`) {
    throw new Error('trusted browser container ownership could not be verified');
  }
  return { container_id: containerId, job_identity: identity, label_verified: true };
}

function createOwnedContainer(createArgs, identity, options = {}) {
  const env = options.env || dockerEnv(process.env, options.home);
  const created = (options.spawnSyncFn || spawnSync)('docker', createArgs, {
    env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (created.status !== 0 || created.error) throw new Error('trusted browser container create failed');
  const cid = assertContainerId(created.stdout);
  const ownership = verifyContainerOwnership(cid, identity, { ...options, env });
  return { cid, ownership };
}

function rootExpiryUnit(identity, cid) {
  if (!/^[a-f0-9]{64}$/.test(String(identity || ''))) throw new Error('trusted browser job identity is malformed');
  const containerId = assertContainerId(cid);
  return `amy-browser-${identity.slice(0, 32)}-${sha256(containerId).slice(0, 20)}`;
}

function parseSystemctlShow(value) {
  const result = {};
  for (const line of String(value || '').split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) result[line.slice(0, at)] = line.slice(at + 1);
  }
  return result;
}

function verifyRootExpiry(watchdog, options = {}) {
  const env = options.env || dockerEnv(process.env, options.home);
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  const timerName = `${watchdog.unit}.timer`;
  const serviceName = `${watchdog.unit}.service`;
  const show = (unit, properties) => runChecked(SUDO_BIN, [
    '-n', SYSTEMCTL_BIN, 'show', unit, '--no-pager', ...properties.map((property) => `--property=${property}`),
  ], { env, spawnSyncFn, timeoutMs: 30_000, label: `trusted browser ${unit} inspect` });
  const timer = parseSystemctlShow(show(timerName, [
    'Id', 'LoadState', 'ActiveState', 'Unit', 'AccuracyUSec', 'RandomizedDelayUSec', 'TimersMonotonic',
  ]).stdout);
  const service = parseSystemctlShow(show(serviceName, [
    'Id', 'LoadState', 'User', 'Description', 'ExecStart',
  ]).stdout);
  const exactCommand = `${DOCKER_BIN} -H ${DOCKER_HOST} rm --force ${watchdog.cid}`;
  const accuracyOneSecond = /^(?:1s|1000000(?:us)?)$/.test(timer.AccuracyUSec || '');
  const randomizedZero = /^0(?:us|s)?$/.test(timer.RandomizedDelayUSec || '');
  if (timer.Id !== timerName || timer.LoadState !== 'loaded' || timer.ActiveState !== 'active' ||
      timer.Unit !== serviceName || !accuracyOneSecond || !randomizedZero ||
      !String(timer.TimersMonotonic || '').includes('OnBootUSec=') ||
      String(timer.TimersMonotonic || '').includes('OnActiveUSec=') ||
      service.Id !== serviceName || service.LoadState !== 'loaded' ||
      !['', 'root'].includes(service.User || '') || service.Description !== watchdog.description ||
      !String(service.ExecStart || '').includes(`path=${DOCKER_BIN}`) ||
      !String(service.ExecStart || '').includes(`argv[]=${exactCommand}`)) {
    throw new Error('trusted browser root expiry could not be verified');
  }
  return { ...watchdog, verified: true, accuracy_seconds: 1, randomized_delay_seconds: 0 };
}

function armRootExpiry({ identity, cid, timeoutSeconds }, options = {}) {
  const containerId = assertContainerId(cid);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) throw new Error('trusted browser root expiry is malformed');
  // OnActiveSec resets on daemon-reload on the deployed systemd. A fixed
  // boot-relative instant survives reloads and stays outside payload authority.
  const uptime = Number((options.uptimeFn || os.uptime)());
  if (!Number.isFinite(uptime) || uptime < 0) throw new Error('trusted browser boot clock is malformed');
  const bootDeadlineSeconds = Math.floor(uptime + timeoutSeconds);
  const unit = rootExpiryUnit(identity, containerId);
  const description = `Amy trusted browser expiry identity=${identity} cid=${containerId}`;
  const watchdog = {
    authority: 'root-systemd-transient', unit, cid: containerId, job_identity: identity,
    timeout_seconds: timeoutSeconds, boot_deadline_seconds: bootDeadlineSeconds, armed: true, verified: false, description,
  };
  const env = options.env || dockerEnv(process.env, options.home);
  try {
    runChecked(SUDO_BIN, [
      '-n', SYSTEMD_RUN_BIN, `--unit=${unit}`, `--description=${description}`,
      `--on-boot=${bootDeadlineSeconds}s`, '--timer-property=AccuracySec=1s',
      '--timer-property=RandomizedDelaySec=0', '--collect',
      DOCKER_BIN, '-H', DOCKER_HOST, 'rm', '--force', containerId,
    ], { env, spawnSyncFn: options.spawnSyncFn, timeoutMs: 30_000, label: 'trusted browser root expiry arm' });
    return verifyRootExpiry(watchdog, { ...options, env });
  } catch (error) {
    error.watchdog = watchdog;
    throw error;
  }
}

function cancelRootExpiry(watchdog, options = {}) {
  const expectedUnit = rootExpiryUnit(watchdog.job_identity, watchdog.cid);
  if (watchdog.unit !== expectedUnit) throw new Error('trusted browser root expiry identity changed');
  const env = options.env || dockerEnv(process.env, options.home);
  const result = (options.spawnSyncFn || spawnSync)(SUDO_BIN, [
    '-n', SYSTEMCTL_BIN, 'stop', `${expectedUnit}.timer`, `${expectedUnit}.service`,
  ], { env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const explicitlyGone = /(?:not loaded|not found|could not be found)/i.test(`${result.stdout || ''}\n${result.stderr || ''}`);
  if (result.error || (result.status !== 0 && !explicitlyGone)) {
    throw new Error('trusted browser root expiry cancellation failed');
  }
  return { cancelled: result.status === 0, already_absent: result.status !== 0, unit: expectedUnit };
}

function launchOwnedContainer(params, options = {}) {
  const identity = jobIdentity(params.job);
  const createArgs = buildDockerCreateArgs(params);
  let created;
  let watchdog;
  try {
    created = createOwnedContainer(createArgs, identity, options);
    const expirySeconds = params.job.deadlineAt ? remainingSeconds(params.job) : params.timeoutSeconds;
    watchdog = armRootExpiry({ identity, cid: created.cid, timeoutSeconds: expirySeconds }, options);
    const env = options.env || dockerEnv(process.env, options.home);
    const child = (options.spawnFn || spawn)('docker', dockerArgs(['start', '--attach', created.cid]), {
      env, detached: false, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
    });
    return { identity, createArgs, ...created, watchdog, child };
  } catch (error) {
    if (created?.ownership?.label_verified) {
      error.ownedCid = created.cid;
      error.jobIdentity = identity;
      error.watchdog = error.watchdog || watchdog || null;
    }
    throw error;
  }
}

function cleanupContainer(cid, options = {}) {
  const containerId = assertContainerId(cid);
  const env = options.env || dockerEnv(process.env, options.home);
  return (options.spawnSyncFn || spawnSync)('docker', dockerArgs(['rm', '--force', containerId]), {
    env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function ensureContainerAbsent(cid, options = {}) {
  const containerId = assertContainerId(cid);
  const env = options.env || dockerEnv(process.env, options.home);
  const remove = cleanupContainer(containerId, { ...options, env });
  const inspect = (options.spawnSyncFn || spawnSync)('docker', dockerArgs(['container', 'inspect', containerId]), {
    env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const explicitAbsence = inspect.status !== 0 && !inspect.error &&
    /no such (?:object|container)/i.test(`${inspect.stdout || ''}\n${inspect.stderr || ''}`);
  if (!explicitAbsence) {
    throw new Error('trusted browser container cleanup could not prove the payload absent');
  }
  return { absent: true, remove_status: remove.status == null ? null : remove.status };
}

function settleOwnedContainer(cid, watchdog, options = {}) {
  const cleanup = ensureContainerAbsent(cid, options);
  if (!watchdog) return { cleanup };
  try {
    return { cleanup, cancellation: cancelRootExpiry(watchdog, options) };
  } catch (error) {
    error.cleanup = cleanup;
    throw error;
  }
}

async function runTrustedBrowserJob(jobFile, options = {}) {
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  if (job.browserJob?.type !== 'playwright-container' || !job.sandboxProfile || !job.tmpDir) {
    throw new Error('trusted browser job requires its registered sandbox and temp boundary');
  }
  if (process.platform !== 'linux' && !options.platform) throw new Error('trusted browser jobs require Linux and Docker');
  const proofFile = jobFile + '.browser.proof';
  const snapshotDir = path.join(job.tmpDir, 'frozen-source');
  const artifactDir = job.browserJob.artifactDir;
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  const committedSource = job.browserJob.committedSource || null;
  const source = committedSource
    ? freezeCommittedSourceSnapshot(job.cwd, snapshotDir, {
        platform: options.platform || process.platform,
        protectedPaths: job.sandboxProfile.protectedPaths,
        expectedCommitSha: committedSource.commitSha,
        spawnSyncFn: options.spawnSyncFn || spawnSync,
      })
    : freezeSourceSnapshot(job.cwd, snapshotDir, {
        platform: options.platform || process.platform,
        protectedPaths: job.sandboxProfile.protectedPaths,
      });
  const dependencyProof = npmProvisioner.provisionLockedDependencies(snapshotDir, {
    env: process.env,
    tempRoot: job.tmpDir,
    timeoutMs: Math.max(1, Date.parse(job.deadlineAt) - Date.now()),
  });
  const image = resolvePlaywrightImage(snapshotDir);
  const hostHome = path.join(job.tmpDir, 'docker-client-home');
  fs.mkdirSync(hostHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(hostHome, 'docker-config-empty'), { mode: 0o700 });
  const env = dockerEnv(process.env, hostHome);
  const imageProof = provisionOfficialImage(image, { env, home: hostHome });
  const timeoutSeconds = remainingSeconds(job);
  const identity = jobIdentity(job);
  const proof = {
    ok: false,
    type: 'playwright-container',
    frozen_source: source,
    dependencies: dependencyProof,
    playwright_version: image.version,
    image: { repository: image.repository, tag: image.tag, digest: image.digest, platform: image.platform, ...imageProof },
    isolation: {
      network: 'none', host_network: false, docker_socket_mounted: false,
      cap_drop: 'ALL', no_new_privileges: true, source_mount: 'protected-snapshot',
      user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    },
    job_identity: identity,
    container_name: containerName(job),
    payload_timeout_seconds: timeoutSeconds,
    lifecycle: { created: false, ownership_verified: false, watchdog_verified: false, started: false },
    artifact_dir: artifactDir,
  };
  writeJsonAtomic(proofFile, proof);
  let ownedCid = null;
  let watchdog = null;
  let child = null;
  let stopping = false;
  const stop = () => {
    if (stopping || !ownedCid) return;
    stopping = true;
    cleanupContainer(ownedCid, { env, home: hostHome, spawnSyncFn: options.spawnSyncFn });
  };
  const signalHandlers = new Map();
  try {
    let launched;
    try {
      launched = launchOwnedContainer({ job, snapshotDir, artifactDir, image, timeoutSeconds }, {
        env, home: hostHome, spawnFn: options.spawnFn, spawnSyncFn: options.spawnSyncFn,
      });
    } catch (error) {
      if (error.ownedCid) {
        ownedCid = error.ownedCid;
        watchdog = error.watchdog || null;
        proof.container_id = ownedCid;
        proof.lifecycle.created = true;
        proof.lifecycle.ownership_verified = true;
        if (watchdog) proof.deadline_watchdog = watchdog;
      }
      throw error;
    }
    ownedCid = launched.cid;
    watchdog = launched.watchdog;
    child = launched.child;
    proof.container_id = ownedCid;
    proof.lifecycle = { created: true, ownership_verified: true, watchdog_verified: true, started: true };
    proof.deadline_watchdog = watchdog;
    writeJsonAtomic(proofFile, proof);
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      const handler = () => stop();
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    proof.ok = result.code === 0;
    proof.exit_code = result.code == null ? null : result.code;
    proof.signal = result.signal || null;
    proof.finished_at = new Date().toISOString();
    writeJsonAtomic(proofFile, proof);
    return proof.ok ? 0 : 1;
  } catch (error) {
    proof.ok = false;
    proof.error = String(error.message || error).slice(0, 500);
    proof.finished_at = new Date().toISOString();
    writeJsonAtomic(proofFile, proof);
    throw error;
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    if (ownedCid) {
      try {
        const settlement = settleOwnedContainer(ownedCid, watchdog, {
          env, home: hostHome, spawnSyncFn: options.spawnSyncFn,
        });
        proof.cleanup = settlement.cleanup;
        if (watchdog) proof.deadline_watchdog.cancellation = settlement.cancellation;
      } catch (error) {
        proof.ok = false;
        if (error.cleanup?.absent) {
          proof.cleanup = error.cleanup;
          if (watchdog) {
            proof.deadline_watchdog.cancellation = { cancelled: false, ambiguous: true, error: String(error.message || error).slice(0, 500) };
          }
        } else {
          proof.cleanup = { absent: false, ambiguous: true, error: String(error.message || error).slice(0, 500) };
        }
        writeJsonAtomic(proofFile, proof);
        throw error;
      }
    } else {
      proof.cleanup = { absent: null, attempted: false, reason: 'no-verified-owned-container' };
    }
    writeJsonAtomic(proofFile, proof);
  }
}

if (require.main === module) {
  (async () => {
    try {
      if (process.argv[2] !== 'run-job' || !process.argv[3]) throw new Error('registered browser run-job required');
      process.exitCode = await runTrustedBrowserJob(process.argv[3]);
    } catch (error) {
      process.stderr.write(`trusted browser job failed: ${String(error.message || error).slice(0, 500)}\n`);
      process.exitCode = 1;
    }
  })();
}

module.exports = {
  DOCKER_HOST,
  DOCKER_BIN,
  PLAYWRIGHT_IMAGES,
  SUDO_BIN,
  SYSTEMCTL_BIN,
  SYSTEMD_RUN_BIN,
  armRootExpiry,
  assertInternalRelativeLink,
  buildDockerCreateArgs,
  cancelRootExpiry,
  cleanupContainer,
  createOwnedContainer,
  copyDescriptorToNewFile,
  containerName,
  dockerArgs,
  dockerEnv,
  ensureContainerAbsent,
  excludedSourcePath,
  freezeCommittedSourceSnapshot,
  freezeSourceSnapshot,
  committedTreeEntries,
  jobIdentity,
  launchOwnedContainer,
  parseSystemctlShow,
  provisionOfficialImage,
  relativeProtectedPaths,
  remainingSeconds,
  resolvePlaywrightImage,
  rootExpiryUnit,
  runTrustedBrowserJob,
  settleOwnedContainer,
  verifyContainerOwnership,
  verifyRootExpiry,
};
