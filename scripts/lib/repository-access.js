'use strict';

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GITHUB_HOST = 'github.com';
const DEFAULT_OWNER_LOGIN = 'owner';
const DEFAULT_CLOUD_CREDENTIAL_FILE = '/var/lib/agent/credentials/github/owner-token';
const DEFAULT_CLOUD_TRUSTED_RUNTIME_ROOT = '/var/lib/agent/credentials/github/runtime';
const TRUSTED_REPOSITORY_RELEASE_GATE = Symbol('trusted-repository-release-gate');

function canonicalOwnerLogin(env = process.env) {
  return String(env.AMY_GITHUB_OWNER_LOGIN || DEFAULT_OWNER_LOGIN).trim().toLowerCase();
}

function protectedCredentialFile(env = process.env) {
  return env.AMY_GITHUB_CREDENTIAL_FILE || DEFAULT_CLOUD_CREDENTIAL_FILE;
}

function trustedCredentialRuntimeRoot(env = process.env) {
  if (env.AMY_GITHUB_TRUSTED_RUNTIME_DIR) {
    return path.resolve(env.AMY_GITHUB_TRUSTED_RUNTIME_DIR);
  }
  if (process.platform !== 'win32') return DEFAULT_CLOUD_TRUSTED_RUNTIME_ROOT;
  const local = env.LOCALAPPDATA || env.APPDATA;
  if (!local) throw new Error('trusted GitHub runtime root is unavailable');
  return path.resolve(local, 'secondbrain', 'trusted-github-runtime');
}

function readProtectedToken(file, fsApi = fs) {
  const stat = fsApi.statSync(file);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('GitHub credential file permissions are not private');
  }
  const token = String(fsApi.readFileSync(file, 'utf8')).trim();
  if (!token) throw new Error('GitHub credential file is empty');
  return token;
}

function tokenFromCredentialHelper(spawnSyncFn = spawnSync) {
  const result = spawnSyncFn('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=${GITHUB_HOST}\n\n`,
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) return '';
  const password = String(result.stdout || '')
    .split(/\r?\n/)
    .find((line) => line.startsWith('password='));
  return password ? password.slice('password='.length).trim() : '';
}

function resolveGithubToken({ env = process.env, fsApi = fs, spawnSyncFn = spawnSync } = {}) {
  const fromHelper = tokenFromCredentialHelper(spawnSyncFn);
  if (fromHelper) return fromHelper;
  const file = protectedCredentialFile(env);
  if (!file || !fsApi.existsSync(file)) throw new Error('trusted GitHub credential is unavailable');
  return readProtectedToken(file, fsApi);
}

function githubRequestJson(url, token, { httpsApi = https } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsApi.request(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'SecondBrain-Amy-Repository-Broker',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`GitHub API request failed with status ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error('GitHub API returned invalid JSON'));
          }
        });
      },
    );
    request.on('error', () => reject(new Error('GitHub API request failed')));
    request.end();
  });
}

function safeRepository(repo) {
  const fullName = String(repo?.full_name || '');
  const cloneUrl = String(repo?.clone_url || '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) return null;
  const expected = `https://${GITHUB_HOST}/${fullName}.git`;
  if (cloneUrl !== expected) return null;
  const defaultBranch = String(repo.default_branch || 'main');
  if (!/^[A-Za-z0-9._/-]+$/.test(defaultBranch) || defaultBranch.includes('..') || defaultBranch.startsWith('-')) {
    return null;
  }
  return {
    full_name: fullName,
    private: repo.private === true,
    default_branch: defaultBranch,
    clone_url: expected,
  };
}

async function discoverAccessibleRepositories({
  token,
  env = process.env,
  requestJson = githubRequestJson,
} = {}) {
  const credential = token || resolveGithubToken({ env });
  const user = await requestJson('https://api.github.com/user', credential);
  const expectedLogin = canonicalOwnerLogin(env);
  const actualLogin = String(user?.login || '').toLowerCase();
  if (!actualLogin || actualLogin !== expectedLogin) {
    throw new Error('authenticated GitHub identity does not match the canonical owner');
  }
  const repositories = [];
  for (let page = 1; page <= 100; page += 1) {
    const rows = await requestJson(
      `https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&visibility=all&per_page=100&page=${page}&sort=full_name`,
      credential,
    );
    if (!Array.isArray(rows)) throw new Error('GitHub repository discovery returned an invalid page');
    repositories.push(...rows.map(safeRepository).filter(Boolean));
    if (rows.length < 100) break;
  }
  return { owner_login: actualLogin, repositories, token: credential };
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function pathsOverlap(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return a === b || inside(a, b) || inside(b, a);
}

const HOST_GIT_CONFIG = Object.freeze([
  '-c', 'credential.helper=',
  '-c', 'credential.useHttpPath=true',
  '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
  '-c', 'core.fsmonitor=false',
  '-c', 'core.sshCommand=',
  '-c', 'diff.external=',
  '-c', 'filter.lfs.smudge=',
  '-c', 'filter.lfs.clean=',
  '-c', 'filter.lfs.required=false',
  '-c', 'commit.gpgSign=false',
  '-c', 'tag.gpgSign=false',
  '-c', 'core.pager=cat',
  '-c', 'submodule.recurse=false',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
]);

function sanitizedGitEnv(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (
      upper.startsWith('GIT_CONFIG_') ||
      ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_EXTERNAL_DIFF',
        'GIT_DIFF_OPTS', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_HTTP_EXTRAHEADER',
        'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_PROXY_COMMAND',
        'GH_TOKEN', 'GITHUB_TOKEN', 'AMY_GITHUB_CREDENTIAL_FILE', 'AMY_GIT_TOKEN_FILE'].includes(upper)
    ) delete env[key];
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_EXTERNAL_DIFF: '',
  });
  return env;
}

function runSafeGit(spawnSyncFn, workspace, args, timeout = 10 * 60 * 1000, options = {}) {
  const resolved = path.resolve(workspace);
  const result = spawnSyncFn('git', [
    '--no-pager', '--no-optional-locks',
    ...HOST_GIT_CONFIG,
    '-c', `core.worktree=${resolved}`,
    '-C', resolved,
    ...args,
  ], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sanitizedGitEnv(options.env || process.env),
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function validateGitConfinement(workspace, allowedMetadataRoot, spawnSyncFn = spawnSync, fsApi = fs) {
  const real = fsApi.realpathSync(workspace);
  const invoke = (args) => {
    const result = runSafeGit(spawnSyncFn, real, args, 30_000);
    if (!result.ok) throw new Error('trusted Git confinement probe failed');
    return result.stdout.trim();
  };
  const top = path.resolve(invoke(['rev-parse', '--show-toplevel']));
  if (top !== path.resolve(real)) throw new Error('repository effective worktree escaped its registered workspace');
  const gitDir = path.resolve(real, invoke(['rev-parse', '--absolute-git-dir']));
  const commonDir = path.resolve(real, invoke(['rev-parse', '--git-common-dir']));
  const metadataRoot = fsApi.realpathSync(allowedMetadataRoot || real);
  for (const candidate of [gitDir, commonDir]) {
    const actual = fsApi.realpathSync(candidate);
    if (actual !== metadataRoot && !inside(metadataRoot, actual)) {
      throw new Error('repository Git metadata escaped its trusted boundary');
    }
  }
  const configNames = (scope) => {
    const result = runSafeGit(spawnSyncFn, real, ['config', scope, '--no-includes', '--name-only', '--get-regexp', '.*'], 30_000);
    if (!result.ok && result.status !== 1) throw new Error('trusted Git configuration probe failed');
    return result.stdout.trim();
  };
  const localNames = configNames('--local');
  const worktreeNames = configNames('--worktree');
  const unsafe = `${localNames}\n${worktreeNames}`
    .split(/\r?\n/)
    .map((row) => row.trim().toLowerCase())
    .filter(Boolean)
    .find((name) =>
      /^(?:alias\.|include(?:if)?\.|url\.|http\.|credential\.|diff\.|filter\.|extensions\.worktreeconfig$|core\.(?:worktree|hookspath|fsmonitor|sshcommand)$|remote\..*\.(?:pushurl|proxy)$)/.test(name),
    );
  if (unsafe) throw new Error(`repository Git configuration is unsafe: ${unsafe}`);
  return { workspace: real, top, gitDir, commonDir };
}

function confinedExistingPath(root, candidate) {
  const rootReal = fs.realpathSync(root);
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) throw new Error('repository workspace may not be a symbolic link');
  const candidateReal = fs.realpathSync(candidate);
  if (!inside(rootReal, candidateReal)) throw new Error('repository workspace escaped its task root');
  return candidateReal;
}

function safeIdentity(value, label = 'identity') {
  const text = String(value || '');
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(text)) throw new Error(`${label} is malformed`);
  return text;
}

function repositoryRegistrationFile(context, fullName) {
  const root = String(context.repositoryRegistrationRoot || '');
  const taskId = safeIdentity(context.detachedTaskId, 'repository task identity');
  if (!root) throw new Error('repository registration root is unavailable');
  const name = String(fullName || '').replace('/', '--');
  safeIdentity(name, 'repository registration identity');
  return path.join(path.resolve(root), taskId, `${name}.json`);
}

function writePrivateJson(file, value, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fsApi.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fsApi.renameSync(temp, file);
}

function readRepositoryRegistration(context, fullName, fsApi = fs) {
  const file = repositoryRegistrationFile(context, fullName);
  const stat = fsApi.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error('repository registration may not be a symbolic link');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('repository registration permissions are not private');
  }
  const record = JSON.parse(fsApi.readFileSync(file, 'utf8'));
  if (
    record.schema !== 'amy.prepared-repository.v1' ||
    record.task_id !== String(context.detachedTaskId || '') ||
    record.repository !== fullName ||
    (String(context.detachedInvocationKey || '') &&
      String(record.invocation_key || '') !== String(context.detachedInvocationKey || ''))
  ) {
    throw new Error('repository registration identity mismatch');
  }
  return { file, record };
}

function findRepositoryRegistrationForWorkspace(context, workspace, fsApi = fs) {
  const taskId = safeIdentity(context.detachedTaskId, 'repository task identity');
  const taskRoot = path.join(path.resolve(String(context.repositoryRegistrationRoot || '')), taskId);
  if (!String(context.repositoryRegistrationRoot || '')) {
    throw new Error('repository registration root is unavailable');
  }
  const wanted = path.resolve(workspace);
  let entries;
  try {
    entries = fsApi.readdirSync(taskRoot, { withFileTypes: true });
  } catch {
    throw new Error('repository workspace is not registered to this task');
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(taskRoot, entry.name);
    const stat = fsApi.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('repository registration may not be a symbolic link');
    const record = JSON.parse(fsApi.readFileSync(file, 'utf8'));
    if (
      record.schema === 'amy.prepared-repository.v1' &&
      record.task_id === taskId &&
      (!String(context.detachedInvocationKey || '') ||
        String(record.invocation_key || '') === String(context.detachedInvocationKey || '')) &&
      path.resolve(String(record.workspace_real || '')) === wanted
    ) {
      matches.push({ file, record });
    }
  }
  if (matches.length !== 1) throw new Error('repository workspace registration is missing or ambiguous');
  return matches[0];
}

function probePreparedRepository(workspace, expected, spawnSyncFn = spawnSync) {
  validateGitConfinement(workspace, workspace, spawnSyncFn);
  const origin = runGit(spawnSyncFn, workspace, ['remote', 'get-url', 'origin']);
  const push = runGit(spawnSyncFn, workspace, ['remote', 'get-url', '--push', 'origin']);
  const originUrl = String(origin.stdout || '').trim();
  const pushUrl = String(push.stdout || '').trim();
  if (!origin.ok || !push.ok || originUrl !== expected.clone_url || pushUrl !== expected.clone_url) {
    throw new Error('repository origin or push URL is not the registered canonical GitHub URL');
  }
  const configNames = runGit(spawnSyncFn, workspace, ['config', '--local', '--no-includes', '--name-only', '--get-regexp', '.*']);
  if (configNames.ok) {
    const unsafe = configNames.stdout
      .split(/\r?\n/)
      .map((row) => row.trim().toLowerCase())
      .filter(Boolean)
      .find((name) =>
        /^(?:url\.|http\.|credential\.|include\.|includeif\.|protocol\.|diff\.|filter\.|extensions\.worktreeconfig$|core\.(?:worktree|hookspath|fsmonitor|sshcommand)$|remote\..*\.(?:pushurl|proxy)$)/.test(name),
      );
    if (unsafe) throw new Error(`repository local Git configuration is unsafe: ${unsafe}`);
  }
  const gitDirProbe = runGit(spawnSyncFn, workspace, ['rev-parse', '--git-dir']);
  if (!gitDirProbe.ok) throw new Error('prepared repository Git directory is unavailable');
  const gitDir = path.resolve(workspace, String(gitDirProbe.stdout || '').trim());
  const gitDirStat = fs.lstatSync(gitDir);
  if (gitDirStat.isSymbolicLink() || !inside(workspace, gitDir)) {
    throw new Error('prepared repository Git directory escaped its workspace');
  }
  const hooksDir = path.join(gitDir, 'hooks');
  if (fs.existsSync(hooksDir)) {
    const activeHook = fs.readdirSync(hooksDir).find((name) => !name.endsWith('.sample'));
    if (activeHook) throw new Error('prepared repository contains an active local Git hook');
  }
  return { origin: originUrl, pushUrl, gitDir };
}

function createAskpass(
  token,
  { fsApi = fs, env = process.env, runtimeRoot, sandboxRoots = [] } = {},
) {
  const trustedRoot = path.resolve(runtimeRoot || trustedCredentialRuntimeRoot(env));
  for (const sandboxRoot of sandboxRoots.filter(Boolean)) {
    if (pathsOverlap(trustedRoot, sandboxRoot)) {
      throw new Error('trusted GitHub runtime root overlaps a model-visible sandbox root');
    }
  }
  fsApi.mkdirSync(trustedRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    const stat = fsApi.statSync(trustedRoot);
    if ((stat.mode & 0o077) !== 0) {
      throw new Error('trusted GitHub runtime root permissions are not private');
    }
  }
  const root = fsApi.mkdtempSync(path.join(trustedRoot, 'askpass-'));
  const tokenFile = path.join(root, 'credential');
  const jsFile = path.join(root, 'askpass.js');
  const hooksDir = path.join(root, 'hooks-disabled');
  const homeDir = path.join(root, 'home');
  const globalConfig = path.join(root, 'empty-gitconfig');
  fsApi.mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
  fsApi.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  fsApi.writeFileSync(globalConfig, '', { mode: 0o600 });
  fsApi.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  fsApi.writeFileSync(
    jsFile,
    "'use strict';const fs=require('fs');const q=process.argv.slice(2).join(' ');process.stdout.write(/username/i.test(q)?'x-access-token':fs.readFileSync(process.env.AMY_GIT_TOKEN_FILE,'utf8').trim());\n",
    { mode: 0o700 },
  );
  let executable = jsFile;
  if (process.platform === 'win32') {
    executable = path.join(root, 'askpass.cmd');
    fsApi.writeFileSync(
      executable,
      `@echo off\r\n"${process.execPath}" "${jsFile}" %*\r\n`,
      { mode: 0o700 },
    );
  } else {
    executable = path.join(root, 'askpass.sh');
    fsApi.writeFileSync(
      executable,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(jsFile)} "$@"\n`,
      { mode: 0o700 },
    );
  }
  return {
    root,
    hooksDir,
    env: {
      GIT_ASKPASS: executable,
      GIT_TERMINAL_PROMPT: '0',
      AMY_GIT_TOKEN_FILE: tokenFile,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: globalConfig,
      HOME: homeDir,
      XDG_CONFIG_HOME: homeDir,
    },
    close() {
      fsApi.rmSync(root, { recursive: true, force: true });
    },
  };
}

function trustedGit(args, options = {}) {
  const { cwd, token, spawnSyncFn = spawnSync, env = process.env } = options;
  const askpass = createAskpass(token, {
    env,
    runtimeRoot: options.runtimeRoot,
    sandboxRoots: options.sandboxRoots || [],
  });
  try {
    const childEnv = { ...sanitizedGitEnv(env), ...askpass.env };
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'AMY_GITHUB_CREDENTIAL_FILE']) delete childEnv[key];
    const result = spawnSyncFn(
      'git',
      [
        '--no-pager', '--no-optional-locks',
        ...HOST_GIT_CONFIG,
        '-c', `core.hooksPath=${askpass.hooksDir}`,
        ...args,
      ],
      {
        cwd,
        env: childEnv,
        encoding: 'utf8',
        timeout: 10 * 60 * 1000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
    };
  } finally {
    askpass.close();
  }
}

async function discoverForCapability(args = {}, options = {}) {
  const discovered = await discoverAccessibleRepositories(options);
  const query = String(args.query || '').trim().toLowerCase();
  const rows = query
    ? discovered.repositories.filter((repo) => repo.full_name.toLowerCase().includes(query))
    : discovered.repositories;
  return {
    ok: true,
    owner_login: discovered.owner_login,
    repositories: rows.map(({ clone_url: _secretSafeInternal, ...repo }) => repo),
    count: rows.length,
  };
}

async function prepareRepository(args = {}, context = {}, options = {}) {
  const workspaceRoot = String(context.repositoryWorkspaceRoot || '');
  if (!workspaceRoot) throw new Error('repository preparation requires a task-owned workspace root');
  const requested = String(args.repository || args.full_name || '').toLowerCase();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(requested)) {
    throw new Error('repository preparation requires a canonical owner/name');
  }
  fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  let destination = path.join(workspaceRoot, requested.replace('/', '--'));
  const probeSpawn = options.spawnSyncFn || spawnSync;
  let priorRegistration = null;
  if (fs.existsSync(destination)) {
    destination = confinedExistingPath(workspaceRoot, destination);
    // Registration lives outside the model-writable workspace and is checked
    // before any credential is resolved or contacted. A mutable origin, push
    // URL, hook, or URL rewrite therefore cannot intercept the owner token.
    priorRegistration = findRepositoryRegistrationForWorkspace(
      context,
      destination,
      options.fsApi || fs,
    ).record;
    if (String(priorRegistration.repository || '').toLowerCase() !== requested) {
      throw new Error('repository registration name mismatch');
    }
    if (path.resolve(priorRegistration.workspace_real) !== path.resolve(destination)) {
      throw new Error('repository registration workspace identity mismatch');
    }
    probePreparedRepository(destination, {
      clone_url: priorRegistration.origin,
    }, probeSpawn);
  }
  // Discovery is intentionally fresh on every preparation attempt so a repo
  // created after the parent turn is immediately eligible without setup.
  const discovered = await discoverAccessibleRepositories(options);
  const repo = discovered.repositories.find((row) => row.full_name.toLowerCase() === requested);
  if (!repo) throw new Error('repository is not accessible to the canonical GitHub identity');
  if (!inside(workspaceRoot, destination)) throw new Error('repository workspace escaped its task root');
  let resumedDirty = false;
  if (fs.existsSync(destination)) {
    destination = confinedExistingPath(workspaceRoot, destination);
    const status = runGit(probeSpawn, destination, ['status', '--porcelain']);
    if (!status.ok) throw new Error('existing repository workspace status is unreadable');
    resumedDirty = Boolean(status.stdout.trim());
    if (!resumedDirty) {
      const localHead = runGit(probeSpawn, destination, ['rev-parse', '--verify', 'HEAD']);
      // An unborn clone is resumable before its first commit. Probe the exact
      // remote branch under trusted credentials and fetch only when it exists;
      // an empty successful result is a verified empty remote, while auth and
      // network failures remain hard errors.
      const remoteHead = trustedGit(
        ['ls-remote', '--exit-code', repo.clone_url, `refs/heads/${repo.default_branch}`],
        {
          token: discovered.token,
          ...options,
          sandboxRoots: [workspaceRoot, ...(context.sandboxWritableRoots || [])],
        },
      );
      const remoteExists = remoteHead.ok && String(remoteHead.stdout || '').trim();
      if (!remoteHead.ok && Number(remoteHead.status) !== 2) {
        throw new Error('trusted repository remote-identity probe failed');
      }
      if (remoteExists) {
        const fetched = trustedGit(
          ['-C', destination, 'fetch', '--prune', repo.clone_url, `+refs/heads/${repo.default_branch}:refs/remotes/origin/${repo.default_branch}`],
          {
            token: discovered.token,
            ...options,
            sandboxRoots: [workspaceRoot, ...(context.sandboxWritableRoots || [])],
          },
        );
        if (!fetched.ok) throw new Error('trusted repository fetch failed');
        const remote = runGit(probeSpawn, destination, ['rev-parse', '--verify', `refs/remotes/origin/${repo.default_branch}`]);
        if (!remote.ok) throw new Error('trusted repository fetch did not produce the canonical remote branch');
        const ff = localHead.ok
          ? runGit(probeSpawn, destination, ['merge', '--ff-only', `refs/remotes/origin/${repo.default_branch}`])
          : runGit(probeSpawn, destination, ['checkout', '-B', repo.default_branch, `refs/remotes/origin/${repo.default_branch}`]);
        if (!ff.ok) throw new Error('clean repository workspace could not fast-forward safely');
      }
    }
  } else {
    const cloned = trustedGit(
      ['clone', '--origin', 'origin', '--single-branch', repo.clone_url, destination],
      {
        token: discovered.token,
        ...options,
        sandboxRoots: [workspaceRoot, ...(context.sandboxWritableRoots || [])],
      },
    );
    if (!cloned.ok) throw new Error('trusted repository clone failed');
    destination = confinedExistingPath(workspaceRoot, destination);
    // Register the trusted clone identity before the first host-side inspection.
    // A crash between clone and validation therefore leaves a fail-closed,
    // privately bound workspace rather than an unowned candidate directory.
    writePrivateJson(repositoryRegistrationFile(context, repo.full_name), {
      schema: 'amy.prepared-repository.v1',
      task_id: String(context.detachedTaskId),
      invocation_key: String(context.detachedInvocationKey || ''),
      repository: repo.full_name,
      origin: repo.clone_url,
      default_branch: repo.default_branch,
      workspace_real: fs.realpathSync(destination),
      prepared_at: new Date(options.nowMs || Date.now()).toISOString(),
      last_validated_at: null,
      state: 'validating',
    }, options.fsApi || fs);
    const head = runGit(probeSpawn, destination, ['rev-parse', '--verify', 'HEAD']);
    if (!head.ok) {
      const unborn = runGit(probeSpawn, destination, ['symbolic-ref', 'HEAD', `refs/heads/${repo.default_branch}`]);
      if (!unborn.ok) throw new Error('empty repository could not create its unborn default branch');
    } else {
      const branch = runGit(probeSpawn, destination, ['symbolic-ref', '--short', 'HEAD']);
      if (!branch.ok || String(branch.stdout || '').trim() !== repo.default_branch) {
        const checkout = runGit(probeSpawn, destination, ['checkout', repo.default_branch]);
        if (!checkout.ok) throw new Error('repository clone could not select its canonical default branch');
      }
    }
  }
  const worktreeProbe = runGit(probeSpawn, destination, ['rev-parse', '--is-inside-work-tree']);
  if (!worktreeProbe.ok || worktreeProbe.stdout.trim() !== 'true') {
    throw new Error('repository preparation did not create a Git worktree');
  }
  const originProbe = runGit(probeSpawn, destination, ['remote', 'get-url', 'origin']);
  if (!originProbe.ok || originProbe.stdout.trim() !== repo.clone_url) {
    throw new Error('prepared repository origin is not canonical');
  }
  const branchProbe = runGit(probeSpawn, destination, ['symbolic-ref', '--short', 'HEAD']);
  if (!branchProbe.ok || branchProbe.stdout.trim() !== repo.default_branch) {
    throw new Error('prepared repository is not on its canonical default branch');
  }
  probePreparedRepository(destination, repo, probeSpawn);
  const registrationFile = repositoryRegistrationFile(context, repo.full_name);
  writePrivateJson(
    registrationFile,
    {
      schema: 'amy.prepared-repository.v1',
      task_id: String(context.detachedTaskId),
      invocation_key: String(context.detachedInvocationKey || ''),
      repository: repo.full_name,
      origin: repo.clone_url,
      default_branch: repo.default_branch,
      workspace_real: fs.realpathSync(destination),
      prepared_at: priorRegistration?.prepared_at || new Date(options.nowMs || Date.now()).toISOString(),
      last_validated_at: new Date(options.nowMs || Date.now()).toISOString(),
    },
    options.fsApi || fs,
  );
  return {
    ok: true,
    owner_login: discovered.owner_login,
    repository: {
      full_name: repo.full_name,
      private: repo.private,
      default_branch: repo.default_branch,
    },
    workspace: destination,
    origin: repo.clone_url,
    resumed: Boolean(priorRegistration),
    dirty: resumedDirty,
    registration: path.basename(registrationFile),
  };
}

async function syncRepository(args = {}, context = {}, options = {}) {
  const root = String(context.repositoryWorkspaceRoot || '');
  let workspace = path.resolve(String(args.workspace || ''));
  if (!root || !inside(root, workspace)) throw new Error('repository sync refused a workspace outside this task');
  workspace = confinedExistingPath(root, workspace);
  const { record: registration } = findRepositoryRegistrationForWorkspace(
    context, workspace, options.fsApi || fs,
  );
  if (path.resolve(registration.workspace_real) !== path.resolve(workspace)) {
    throw new Error('repository sync registration workspace mismatch');
  }
  probePreparedRepository(workspace, { clone_url: registration.origin }, options.spawnSyncFn || spawnSync);
  const operation = String(args.operation || 'fetch');
  if (operation === 'fetch') {
    const discovered = await discoverAccessibleRepositories(options);
    const repo = discovered.repositories.find((row) => row.full_name === registration.repository);
    if (!repo || repo.clone_url !== registration.origin || repo.default_branch !== registration.default_branch) {
      throw new Error('registered repository is no longer canonical or accessible');
    }
    const status = runGit(options.spawnSyncFn || spawnSync, workspace, ['status', '--porcelain']);
    if (!status.ok) throw new Error('trusted repository status failed');
    if (status.stdout.trim()) {
      return { ok: true, operation: 'fetch', workspace, fetched: false, dirty: true, preserved: true };
    }
    const result = trustedGit(['-C', workspace, 'fetch', '--prune', registration.origin,
      `+refs/heads/${registration.default_branch}:refs/remotes/origin/${registration.default_branch}`], {
      token: discovered.token,
      ...options,
      sandboxRoots: [root, ...(context.sandboxWritableRoots || [])],
    });
    if (!result.ok) throw new Error('trusted repository fetch failed');
    const remote = runGit(options.spawnSyncFn || spawnSync, workspace, ['rev-parse', '--verify', `refs/remotes/origin/${registration.default_branch}`]);
    if (remote.ok) {
      const ff = runGit(options.spawnSyncFn || spawnSync, workspace, ['merge', '--ff-only', `refs/remotes/origin/${registration.default_branch}`]);
      if (!ff.ok) throw new Error('trusted repository fast-forward failed');
    }
    return { ok: true, operation: 'fetch', workspace, fetched: true, dirty: false };
  }
  if (operation !== 'push') throw new Error('unsupported repository sync operation');
  if (context.trustedRepositoryReleaseGate !== TRUSTED_REPOSITORY_RELEASE_GATE) {
    throw new Error('repository push requires the trusted release coordinator gate');
  }
  const expectedSha = String(args.expected_sha || '');
  const branch = String(args.branch || '');
  if (!/^[0-9a-f]{40}$/.test(expectedSha) || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..')) {
    throw new Error('repository push requires an exact commit and safe branch');
  }
  const head = runGit(options.spawnSyncFn || spawnSync, workspace, ['rev-parse', 'HEAD']);
  if (!head.ok || String(head.stdout || '').trim() !== expectedSha) {
    throw new Error('repository push commit does not match the trusted workspace head');
  }
  if (branch !== registration.default_branch) throw new Error('repository push branch is not the registered default branch');
  const discovered = await discoverAccessibleRepositories(options);
  const repo = discovered.repositories.find((row) => row.full_name === registration.repository);
  if (!repo || repo.clone_url !== registration.origin || repo.default_branch !== branch) {
    throw new Error('registered repository is no longer canonical or accessible');
  }
  const pushed = trustedGit(['-C', workspace, 'push', registration.origin, `${expectedSha}:refs/heads/${branch}`], {
    token: discovered.token,
    ...options,
    sandboxRoots: [root, ...(context.sandboxWritableRoots || [])],
  });
  if (!pushed.ok) throw new Error('trusted repository push failed');
  const track = runGit(options.spawnSyncFn || spawnSync, workspace, [
    'update-ref',
    `refs/remotes/origin/${branch}`,
    expectedSha,
  ]);
  if (!track.ok) throw new Error('trusted repository push succeeded but local remote tracking could not be bound');
  return { ok: true, operation: 'push', workspace, commit_sha: expectedSha, branch };
}

function runGit(spawnSyncFn, workspace, args, timeout = 10 * 60 * 1000) {
  return runSafeGit(spawnSyncFn, workspace, args, timeout);
}

function taskInspectionWorkspace(args = {}, context = {}, fsApi = fs) {
  const raw = String(args.workspace || context.primaryWorkspace || '');
  if (!raw) throw new Error('task Git inspection workspace is unavailable');
  const requested = path.resolve(raw);
  if (!fsApi.existsSync(requested)) {
    throw new Error('task Git inspection workspace is unavailable');
  }
  const stat = fsApi.lstatSync(requested);
  if (stat.isSymbolicLink()) throw new Error('task Git inspection workspace may not be a symbolic link');
  const real = fsApi.realpathSync(requested);
  if (context.primaryWorkspace && path.resolve(fsApi.realpathSync(context.primaryWorkspace)) === path.resolve(real)) {
    return real;
  }
  const registration = findRepositoryRegistrationForWorkspace(context, real, fsApi);
  if (path.resolve(registration.record.workspace_real) !== path.resolve(real)) {
    throw new Error('task Git inspection workspace no longer matches its registration');
  }
  return real;
}

function inspectTaskGit(args = {}, context = {}, options = {}) {
  const workspace = taskInspectionWorkspace(args, context, options.fsApi || fs);
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  const prepared = !context.primaryWorkspace || path.resolve(workspace) !== path.resolve(context.primaryWorkspace);
  validateGitConfinement(
    workspace,
    prepared ? workspace : String(context.primaryRepositoryMetadataRoot || context.primaryWorkspace),
    spawnSyncFn,
    options.fsApi || fs,
  );
  const invoke = (tail) => {
    const result = runSafeGit(spawnSyncFn, workspace, tail, 2 * 60 * 1000, options);
    if (!result.ok) throw new Error('trusted task Git inspection failed');
    return result.stdout;
  };
  const configNames = invoke(['config', '--local', '--no-includes', '--name-only', '--get-regexp', '.*']);
  const unsafeConfig = configNames
    .split(/\r?\n/)
    .map((row) => row.trim().toLowerCase())
    .filter(Boolean)
    .find((name) =>
      /^(?:alias\.|include(?:if)?\.|url\.|http\.|credential\.|diff\.|filter\.|extensions\.worktreeconfig$|core\.(?:worktree|hookspath|fsmonitor|sshcommand)$|remote\..*\.(?:pushurl|proxy)$)/.test(name),
    );
  if (unsafeConfig) throw new Error(`task Git inspection refused unsafe local configuration: ${unsafeConfig}`);
  const status = invoke(['status', '--short', '--branch', '--untracked-files=all']);
  const diffArgs = ['--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--'];
  const unstaged = invoke(['diff', ...diffArgs]);
  const staged = invoke(['diff', '--cached', ...diffArgs]);
  const maxBytes = Math.max(1, Math.min(2 * 1024 * 1024, Number(args.max_bytes || 1024 * 1024)));
  if (Buffer.byteLength(status) + Buffer.byteLength(unstaged) + Buffer.byteLength(staged) > maxBytes) {
    throw new Error('task Git inspection output exceeds its bounded result size');
  }
  return { ok: true, workspace, status, unstaged_diff: unstaged, staged_diff: staged };
}

function releaseRecordFile(releaseStateRoot, taskId, releaseId) {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(String(taskId || ''))) {
    throw new Error('repository release task identity is malformed');
  }
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(String(releaseId || ''))) {
    throw new Error('repository release identity is malformed');
  }
  return path.join(path.resolve(releaseStateRoot), String(taskId), `${releaseId}.json`);
}

function writeReleaseRecord(file, record, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fsApi.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fsApi.renameSync(temp, file);
}

function safeReleaseResult(record) {
  return {
    ok: true,
    release_id: record.release_id,
    task_id: record.task_id,
    repository: record.repository,
    workspace: record.workspace,
    branch: record.branch,
    commit_sha: record.commit_sha,
    status: record.status,
    complete: record.status === 'verified',
    deployment: record.deployment || null,
    review: record.review || null,
  };
}

function releaseHistorySnapshot(record) {
  const { release_history: _history, ...snapshot } = record || {};
  return snapshot;
}

function verifiedReleaseHistory(record) {
  return Array.isArray(record?.release_history)
    ? record.release_history.filter((row) =>
        row?.status === 'verified' &&
        row?.deployment?.status === 'verified' &&
        String(row?.deployment?.commit_sha || '').toLowerCase() === String(row?.commit_sha || '').toLowerCase() &&
        String(row?.deployment?.verification || '').trim())
    : [];
}

function inspectRepositoryForRelease(workspace, repositoryWorkspaceRoot, spawnSyncFn = spawnSync) {
  if (!repositoryWorkspaceRoot || !inside(repositoryWorkspaceRoot, workspace)) {
    throw new Error('repository release workspace is outside the task-owned root');
  }
  const confined = confinedExistingPath(repositoryWorkspaceRoot, workspace);
  const origin = runGit(spawnSyncFn, confined, ['remote', 'get-url', 'origin']);
  const canonicalOrigin = String(origin.stdout || '').trim();
  const match = canonicalOrigin.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\.git$/);
  if (!origin.ok || !match) throw new Error('repository release origin is not canonical or is credential-bearing');
  const branch = runGit(spawnSyncFn, confined, ['symbolic-ref', '--short', 'HEAD']);
  const branchName = String(branch.stdout || '').trim();
  if (!branch.ok || !/^[A-Za-z0-9._/-]+$/.test(branchName) || branchName.includes('..')) {
    throw new Error('repository release branch is unsafe');
  }
  return { workspace: confined, repository: match[1], origin: canonicalOrigin, branch: branchName };
}

function preflightRegisteredReleaseWorkspace(workspace, context, options = {}) {
  const fsApi = options.fsApi || fs;
  const root = String(context.repositoryWorkspaceRoot || '');
  if (!root || !inside(root, workspace)) {
    throw new Error('repository release workspace is outside the task-owned root');
  }
  const confined = confinedExistingPath(root, workspace);
  const { record } = findRepositoryRegistrationForWorkspace(context, confined, fsApi);
  if (path.resolve(record.workspace_real) !== path.resolve(confined)) {
    throw new Error('repository release registration workspace identity changed');
  }
  validateGitConfinement(confined, confined, options.spawnSyncFn || spawnSync, fsApi);
  return { confined, record };
}

function assertRegisteredReleaseWorkspace(inspected, context, options = {}) {
  const { record } = readRepositoryRegistration(context, inspected.repository, options.fsApi || fs);
  if (
    path.resolve(record.workspace_real) !== path.resolve(inspected.workspace) ||
    record.origin !== inspected.origin ||
    record.default_branch !== inspected.branch
  ) {
    throw new Error('repository release does not match its trusted preparation registration');
  }
  probePreparedRepository(
    inspected.workspace,
    { clone_url: record.origin },
    options.spawnSyncFn || spawnSync,
  );
  return record;
}

function validateReleaseCheckpoint(record, context, options = {}) {
  if (
    record.schema !== 'amy.repository-release.v1' ||
    record.task_id !== String(context.detachedTaskId || '') ||
    (String(context.detachedInvocationKey || '') &&
      String(record.invocation_key || '') !== String(context.detachedInvocationKey || ''))
  ) {
    throw new Error('repository release checkpoint authority mismatch');
  }
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  preflightRegisteredReleaseWorkspace(record.workspace, context, options);
  const inspected = inspectRepositoryForRelease(
    record.workspace,
    String(context.repositoryWorkspaceRoot || ''),
    spawnSyncFn,
  );
  assertRegisteredReleaseWorkspace(inspected, context, options);
  if (
    inspected.repository !== record.repository ||
    inspected.branch !== record.branch ||
    inspected.origin !== record.origin
  ) {
    throw new Error('repository release checkpoint workspace identity changed');
  }
  const head = runGit(spawnSyncFn, inspected.workspace, ['rev-parse', 'HEAD']);
  const clean = runGit(spawnSyncFn, inspected.workspace, ['status', '--porcelain']);
  if (
    !head.ok ||
    String(head.stdout || '').trim().toLowerCase() !== String(record.commit_sha || '').toLowerCase() ||
    !clean.ok ||
    clean.stdout.trim()
  ) {
    throw new Error('repository release checkpoint no longer matches its exact clean commit');
  }
  return inspected;
}

function prepareRepositoryRelease(args = {}, context = {}, options = {}) {
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  preflightRegisteredReleaseWorkspace(path.resolve(String(args.workspace || '')), context, options);
  const inspected = inspectRepositoryForRelease(
    path.resolve(String(args.workspace || '')),
    String(context.repositoryWorkspaceRoot || ''),
    spawnSyncFn,
  );
  assertRegisteredReleaseWorkspace(inspected, context, options);
  const releaseId = String(args.release_id || inspected.repository.replace('/', '--'));
  const file = releaseRecordFile(context.repositoryReleaseStateRoot, context.detachedTaskId, releaseId);
  let prior = null;
  let newReleaseCycle = false;
  if ((options.fsApi || fs).existsSync(file)) {
    prior = JSON.parse((options.fsApi || fs).readFileSync(file, 'utf8'));
    if (
      prior.schema !== 'amy.repository-release.v1' ||
      prior.task_id !== String(context.detachedTaskId) ||
      prior.release_id !== releaseId ||
      path.resolve(prior.workspace) !== path.resolve(inspected.workspace)
    ) throw new Error('repository release preparation intent identity mismatch');
  }
  const status = runGit(spawnSyncFn, inspected.workspace, ['status', '--porcelain']);
  if (!status.ok) throw new Error('repository release could not inspect the workspace');
  const beforeHeadProbe = runGit(spawnSyncFn, inspected.workspace, ['rev-parse', '--verify', 'HEAD']);
  const beforeHead = String(beforeHeadProbe.stdout || '').trim().toLowerCase();
  if (prior && prior.status !== 'preparing' && prior.status !== 'changes_required') {
    const unchanged =
      !status.stdout.trim() &&
      beforeHeadProbe.ok &&
      beforeHead === String(prior.commit_sha || '').toLowerCase();
    if (unchanged) {
      validateReleaseCheckpoint(prior, context, options);
      return safeReleaseResult(prior);
    }
    if (prior.status !== 'verified') {
      validateReleaseCheckpoint(prior, context, options);
      throw new Error('repository release checkpoint changed before its current cycle completed');
    }
    if (!beforeHeadProbe.ok || !/^[0-9a-f]{40}$/.test(beforeHead)) {
      throw new Error('repository release could not resolve the follow-up commit');
    }
    if (beforeHead !== String(prior.commit_sha || '').toLowerCase()) {
      const ancestor = runGit(spawnSyncFn, inspected.workspace, [
        'merge-base', '--is-ancestor', String(prior.commit_sha || '').toLowerCase(), beforeHead,
      ]);
      if (!ancestor.ok) throw new Error('repository release follow-up is not a descendant of the verified commit');
    }
    newReleaseCycle = true;
  }
  if (prior?.status === 'changes_required' && prior.owner_steer && !status.stdout.trim()) {
    validateReleaseCheckpoint(prior, context, options);
    const resumed = { ...prior, status: 'awaiting_review' };
    delete resumed.owner_steer;
    resumed.amendment_processed_at = new Date(options.nowMs || Date.now()).toISOString();
    writeReleaseRecord(file, resumed, options.fsApi || fs);
    return safeReleaseResult(resumed);
  }
  let commitSha = '';
  if (prior?.status === 'preparing' && !status.stdout.trim()) {
    const head = runGit(spawnSyncFn, inspected.workspace, ['rev-parse', 'HEAD']);
    commitSha = String(head.stdout || '').trim().toLowerCase();
    const parent = runGit(spawnSyncFn, inspected.workspace, ['rev-parse', 'HEAD^']);
    if (
      !head.ok || !/^[0-9a-f]{40}$/.test(commitSha) ||
      String(parent.stdout || '').trim().toLowerCase() !== String(prior.base_head || '').toLowerCase()
    ) throw new Error('repository release interruption could not reconcile the committed HEAD');
  } else if (newReleaseCycle && !status.stdout.trim()) {
    commitSha = beforeHead;
  } else {
    if (!status.stdout.trim()) throw new Error('repository release has no changes to commit');
    const history = newReleaseCycle
      ? [...verifiedReleaseHistory(prior), releaseHistorySnapshot(prior)]
      : (Array.isArray(prior?.release_history) ? prior.release_history : []);
    const intent = {
      schema: 'amy.repository-release.v1',
      release_id: releaseId,
      task_id: String(context.detachedTaskId),
      invocation_key: String(context.detachedInvocationKey || ''),
      repository: inspected.repository,
      origin: inspected.origin,
      workspace: inspected.workspace,
      branch: inspected.branch,
      commit_sha: '',
      base_head: beforeHeadProbe.ok ? beforeHead : '',
      status: 'preparing',
      created_at: newReleaseCycle ? new Date(options.nowMs || Date.now()).toISOString() : (prior?.created_at || new Date(options.nowMs || Date.now()).toISOString()),
      review_chain: newReleaseCycle ? null : (prior?.review_chain || null),
      review_cycle: newReleaseCycle ? String(prior.commit_sha) : String(prior?.review_cycle || ''),
      deployment: { status: 'pending', verification: null },
      ...(history.length ? { release_history: history } : {}),
    };
    writeReleaseRecord(file, intent, options.fsApi || fs);
    const add = runGit(spawnSyncFn, inspected.workspace, ['add', '--all']);
    if (!add.ok) throw new Error('repository release could not stage the workspace');
    const subject = String(args.subject || 'Complete owner repository task')
      .replace(/[\r\n\0]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 72);
    const commit = runGit(spawnSyncFn, inspected.workspace, ['commit', '-m', `fix: ${subject}`]);
    if (!commit.ok) throw new Error('repository release could not create the guarded commit');
    const head = runGit(spawnSyncFn, inspected.workspace, ['rev-parse', 'HEAD']);
    commitSha = String(head.stdout || '').trim().toLowerCase();
    if (!head.ok || !/^[0-9a-f]{40}$/.test(commitSha)) {
      throw new Error('repository release could not resolve the exact commit');
    }
    if (typeof options.afterCommit === 'function') options.afterCommit({ ...intent, commit_sha: commitSha });
  }
  const clean = runGit(spawnSyncFn, inspected.workspace, ['status', '--porcelain']);
  if (!clean.ok || clean.stdout.trim()) throw new Error('repository release workspace is not clean after commit');
  const record = {
    schema: 'amy.repository-release.v1',
    release_id: releaseId,
    task_id: String(context.detachedTaskId),
    invocation_key: String(context.detachedInvocationKey || ''),
    repository: inspected.repository,
    origin: inspected.origin,
    workspace: inspected.workspace,
    branch: inspected.branch,
    commit_sha: commitSha,
    status: 'awaiting_review',
    created_at: newReleaseCycle ? new Date(options.nowMs || Date.now()).toISOString() : (prior?.created_at || new Date(options.nowMs || Date.now()).toISOString()),
    review_chain: newReleaseCycle ? null : (prior?.review_chain || null),
    review_cycle: newReleaseCycle ? String(prior.commit_sha) : String(prior?.review_cycle || ''),
    deployment: { status: 'pending', verification: null },
    ...((newReleaseCycle || Array.isArray(prior?.release_history))
      ? { release_history: newReleaseCycle
          ? [...verifiedReleaseHistory(prior), releaseHistorySnapshot(prior)]
          : prior.release_history }
      : {}),
  };
  writeReleaseRecord(file, record, options.fsApi || fs);
  return safeReleaseResult(record);
}

async function releasePreparedRepository(args = {}, context = {}, options = {}) {
  const fsApi = options.fsApi || fs;
  const file = releaseRecordFile(
    context.repositoryReleaseStateRoot,
    context.detachedTaskId,
    args.release_id,
  );
  let record;
  try {
    record = JSON.parse(fsApi.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('repository release checkpoint is missing');
  }
  if (
    record.schema !== 'amy.repository-release.v1' ||
    record.task_id !== String(context.detachedTaskId) ||
    record.release_id !== String(args.release_id) ||
    (String(context.detachedInvocationKey || '') &&
      String(record.invocation_key || '') !== String(context.detachedInvocationKey || ''))
  ) {
    throw new Error('repository release checkpoint identity mismatch');
  }
  const expectedSha = String(args.expected_sha || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('repository release expected commit mismatch');
  const historical = verifiedReleaseHistory(record).find(
    (row) => String(row.commit_sha || '').toLowerCase() === expectedSha,
  );
  if (String(record.commit_sha || '').toLowerCase() !== expectedSha && !historical) {
    throw new Error('repository release expected commit mismatch');
  }
  preflightRegisteredReleaseWorkspace(record.workspace, context, options);
  const inspected = inspectRepositoryForRelease(
    record.workspace,
    String(context.repositoryWorkspaceRoot || ''),
    options.spawnSyncFn || spawnSync,
  );
  assertRegisteredReleaseWorkspace(inspected, context, options);
  if (inspected.repository !== record.repository || inspected.branch !== record.branch) {
    throw new Error('repository release workspace identity changed');
  }
  if (historical) return safeReleaseResult(historical);
  const head = runGit(options.spawnSyncFn || spawnSync, record.workspace, ['rev-parse', 'HEAD']);
  const clean = runGit(options.spawnSyncFn || spawnSync, record.workspace, ['status', '--porcelain']);
  if (!head.ok || String(head.stdout || '').trim().toLowerCase() !== expectedSha || !clean.ok || clean.stdout.trim()) {
    throw new Error('repository release workspace no longer matches the exact reviewed commit');
  }
  if (
    record.status === 'verified' &&
    record.deployment?.status === 'verified' &&
    String(record.deployment?.commit_sha || '').toLowerCase() === expectedSha &&
    String(record.deployment?.verification || '').trim()
  ) return safeReleaseResult(record);
  if (typeof options.verifyReview !== 'function') {
    throw new Error('repository release requires a trusted exact-commit review verifier');
  }
  if (typeof options.assertAuthority === 'function') options.assertAuthority('review');
  const review = await options.verifyReview({ ...safeReleaseResult(record), review_receipt: args.review_receipt });
  if (!review || review.approved !== true || String(review.commit_sha || '').toLowerCase() !== expectedSha) {
    throw new Error('repository release review did not approve the exact commit');
  }
  if (!['pushed', 'awaiting_deployment', 'deployment_failed', 'verified'].includes(record.status)) {
    if (typeof options.assertAuthority === 'function') options.assertAuthority('push');
    await syncRepository(
      {
        workspace: record.workspace,
        operation: 'push',
        expected_sha: expectedSha,
        branch: record.branch,
      },
      {
        ...context,
        sandboxWritableRoots: context.sandboxWritableRoots || [],
        trustedRepositoryReleaseGate: TRUSTED_REPOSITORY_RELEASE_GATE,
      },
      options,
    );
    record.status = 'pushed';
    record.review = {
      receipt_id: String(review.receipt_id || ''),
      commit_sha: expectedSha,
      approved_at: new Date(options.nowMs || Date.now()).toISOString(),
      approval_type: String(review.approval_type || 'peer-review'),
      ...(review.policy_authorization ? { policy_authorization: review.policy_authorization } : {}),
      ...(review.original_peer_review ? { original_peer_review: review.original_peer_review } : {}),
      ...(Array.isArray(review.authorized_changes) ? { authorized_changes: review.authorized_changes } : {}),
      ...(Array.isArray(review.test_jobs) ? { test_jobs: review.test_jobs } : {}),
    };
    record.pushed_at = new Date(options.nowMs || Date.now()).toISOString();
    writeReleaseRecord(file, record, fsApi);
  }
  if (typeof options.deployAndVerify !== 'function') {
    record.status = 'awaiting_deployment';
    record.deployment = {
      status: 'pending',
      verification: null,
      handoff: 'Deploy and verify this exact pushed commit through the repository owner release method.',
    };
    writeReleaseRecord(file, record, fsApi);
    return safeReleaseResult(record);
  }
  if (typeof options.assertAuthority === 'function') options.assertAuthority('deploy');
  let deployed;
  try {
    deployed = await options.deployAndVerify(safeReleaseResult(record));
  } catch (error) {
    record.status = 'deployment_failed';
    // Keep the cause on the record; a bare 'failed' made the 2026-10-31 Lesson 7 publish undiagnosable.
    record.deployment = { status: 'failed', verification: null, error: String(error?.message || error).slice(0, 4000) };
    writeReleaseRecord(file, record, fsApi);
    return safeReleaseResult(record);
  }
  if (!deployed || deployed.verified !== true || String(deployed.commit_sha || '').toLowerCase() !== expectedSha) {
    record.status = 'deployment_failed';
    record.deployment = { status: 'failed', verification: null };
    writeReleaseRecord(file, record, fsApi);
    return safeReleaseResult(record);
  }
  record.status = 'verified';
  record.deployment = {
    status: 'verified',
    verification: String(deployed.receipt || deployed.url || 'exact-commit verification passed'),
    commit_sha: expectedSha,
  };
  record.verified_at = new Date(options.nowMs || Date.now()).toISOString();
  writeReleaseRecord(file, record, fsApi);
  return safeReleaseResult(record);
}

module.exports = {
  DEFAULT_CLOUD_CREDENTIAL_FILE,
  DEFAULT_CLOUD_TRUSTED_RUNTIME_ROOT,
  DEFAULT_OWNER_LOGIN,
  canonicalOwnerLogin,
  confinedExistingPath,
  createAskpass,
  discoverAccessibleRepositories,
  discoverForCapability,
  githubRequestJson,
  inspectTaskGit,
  inside,
  findRepositoryRegistrationForWorkspace,
  pathsOverlap,
  prepareRepositoryRelease,
  prepareRepository,
  protectedCredentialFile,
  readProtectedToken,
  resolveGithubToken,
  safeRepository,
  validateReleaseCheckpoint,
  releasePreparedRepository,
  syncRepository,
  tokenFromCredentialHelper,
  trustedGit,
  trustedCredentialRuntimeRoot,
  runSafeGit,
  sanitizedGitEnv,
  validateGitConfinement,
};
