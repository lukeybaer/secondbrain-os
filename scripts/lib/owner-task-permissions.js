'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROFILE_NAME = 'amy-owner-task';
const REVIEW_PROFILE_NAME = 'amy-review';
const DEFAULT_GITHUB_CREDENTIAL_ROOT = '/var/lib/agent/credentials/github';
const DEFAULT_SOURCE_ROOT = '/home/ec2-user/secondbrain-current';
const DEFAULT_LIVE_ROOT = '/opt/secondbrain';

function tomlString(value) {
  return JSON.stringify(String(value));
}

function absolutePath(value) {
  const text = String(value || '').trim();
  if (!text || !path.isAbsolute(text)) return '';
  return path.normalize(text);
}

function canonicalDenyPath(value) {
  let current = value;
  const missing = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Protected path has no existing ancestor');
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...missing);
}

function addPath(target, value) {
  const resolved = absolutePath(value);
  if (resolved) target.add(canonicalDenyPath(resolved));
}

function addConfiguredPath(target, value) {
  const text = String(value || '').trim();
  if (text) addPath(target, path.resolve(text));
}

function gitCommonConfigPath(workspace, spawnSyncFn = spawnSync) {
  const cwd = absolutePath(workspace);
  if (!cwd) return '';
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('GIT_CONFIG_') || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_ASKPASS', 'SSH_ASKPASS'].includes(upper)) {
      delete env[key];
    }
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  });
  const result = spawnSyncFn(
    'git',
    [
      '--no-pager', '--no-optional-locks',
      '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
      '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'filter.lfs.smudge=',
      '-c', 'filter.lfs.clean=', '-c', 'protocol.allow=never', '-c', `core.worktree=${cwd}`,
      '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir',
    ],
    { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], env },
  );
  if (result.status !== 0) return '';
  const common = absolutePath(String(result.stdout || '').trim());
  return common ? path.join(common, 'config') : '';
}

function protectedCredentialPaths({
  env = process.env,
  workspace = '',
  repoRoot = '',
  sourceRoot = '',
  liveRoot = '',
  homeDir = os.homedir(),
  spawnSyncFn = spawnSync,
  extraPaths = [],
  denyWorkspaceGitConfig = true,
} = {}) {
  const denied = new Set();
  if (process.platform !== 'win32') {
    addPath(denied, DEFAULT_GITHUB_CREDENTIAL_ROOT);
    // Canonical legacy credential copies remain sensitive even when a caller
    // selects another authority/source checkout (notably app reviewers).
    addPath(denied, path.join(DEFAULT_SOURCE_ROOT, '.git', 'config'));
    addPath(denied, path.join(DEFAULT_SOURCE_ROOT, '.env'));
    addPath(denied, path.join(DEFAULT_LIVE_ROOT, '.env'));
  }
  addConfiguredPath(denied, env.AMY_GITHUB_CREDENTIAL_FILE && path.dirname(path.resolve(env.AMY_GITHUB_CREDENTIAL_FILE)));
  addConfiguredPath(denied, env.AMY_GITHUB_TRUSTED_RUNTIME_DIR);
  addConfiguredPath(denied, env.AMY_BROKER_ENV_FILE);
  addConfiguredPath(denied, env.GMAIL_SECRETS_DIR);
  addConfiguredPath(denied, env.GMAIL_OAUTH_CREDENTIALS_FILE);
  addConfiguredPath(denied, env.GMAIL_OAUTH_TOKEN_FILE);
  if (env.CODEX_HOME) addConfiguredPath(denied, path.join(env.CODEX_HOME, 'auth.json'));
  if (env.CLAUDE_CONFIG_DIR) addConfiguredPath(denied, path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json'));

  const resolvedSource = absolutePath(path.resolve(sourceRoot || env.SECONDBRAIN_SOURCE_ROOT || DEFAULT_SOURCE_ROOT));
  const resolvedLive = absolutePath(path.resolve(liveRoot || env.SECONDBRAIN_LIVE_ROOT || DEFAULT_LIVE_ROOT));
  if (resolvedSource) {
    addPath(denied, path.join(resolvedSource, '.git', 'config'));
    addPath(denied, path.join(resolvedSource, '.env'));
  }
  if (resolvedLive) addPath(denied, path.join(resolvedLive, '.env'));
  if (repoRoot) addPath(denied, path.join(repoRoot, '.env'));

  if (denyWorkspaceGitConfig) {
    const actualGitConfig = gitCommonConfigPath(workspace, spawnSyncFn);
    if (actualGitConfig) addPath(denied, actualGitConfig);
  }

  const resolvedHome = absolutePath(homeDir);
  if (resolvedHome) {
    addPath(denied, path.join(resolvedHome, '.codex', 'auth.json'));
    addPath(denied, path.join(resolvedHome, '.claude', '.credentials.json'));
    addPath(denied, path.join(resolvedHome, '.aws'));
    addPath(denied, path.join(resolvedHome, '.azure'));
    addPath(denied, path.join(resolvedHome, '.config', 'gh'));
    addPath(denied, path.join(resolvedHome, '.config', 'gcloud'));
    addPath(denied, path.join(resolvedHome, '.docker'));
    addPath(denied, path.join(resolvedHome, '.netrc'));
    addPath(denied, path.join(resolvedHome, '.npmrc'));
    addPath(denied, path.join(resolvedHome, '.secrets'));
    addPath(denied, path.join(resolvedHome, '.ssh'));
  }
  for (const candidate of extraPaths) addPath(denied, candidate);
  return [...denied].sort((a, b) => a.localeCompare(b));
}

function inlineDenyTable(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('owner task permission profile requires at least one protected path');
  }
  return `{${paths.map((entry) => `${tomlString(entry)}="deny"`).join(',')}}`;
}

function permissionProfileConfigArgs(options = {}) {
  const paths = options.protectedPaths || protectedCredentialPaths(options);
  return [
    '-c',
    `permissions.${PROFILE_NAME}.extends=":workspace"`,
    '-c',
    `permissions.${PROFILE_NAME}.filesystem=${inlineDenyTable(paths)}`,
    '-c',
    `permissions.${PROFILE_NAME}.network.enabled=false`,
  ];
}

// Model pins own --ignore-user-config; permissions compose only their profile.
function codexExecPermissionArgs(options = {}) {
  return [
    ...permissionProfileConfigArgs(options),
    '-c',
    `default_permissions=${tomlString(PROFILE_NAME)}`,
  ];
}

function reviewPermissionProfileConfigArgs(options = {}) {
  const paths = options.protectedPaths || protectedCredentialPaths({
    ...options,
    // The trusted repository broker already rejected credential-bearing Git
    // configuration. Keep that source metadata readable for review commands;
    // provider credentials and canonical authority secrets remain denied.
    denyWorkspaceGitConfig: false,
  });
  return [
    '-c',
    `permissions.${REVIEW_PROFILE_NAME}.extends=":read-only"`,
    '-c',
    `permissions.${REVIEW_PROFILE_NAME}.filesystem=${inlineDenyTable(paths)}`,
    '-c',
    `permissions.${REVIEW_PROFILE_NAME}.network.enabled=false`,
  ];
}

function reviewCodexExecPermissionArgs(options = {}) {
  return [
    ...reviewPermissionProfileConfigArgs(options),
    '-c',
    `default_permissions=${tomlString(REVIEW_PROFILE_NAME)}`,
  ];
}

function sandboxedPayload(command, args = [], options = {}) {
  const cwd = absolutePath(options.cwd);
  if (!cwd) throw new Error('sandboxed owner task payload requires an absolute cwd');
  if (!String(command || '')) throw new Error('sandboxed owner task payload requires a command');
  return {
    command: options.codexCommand || 'codex',
    args: [
      'sandbox',
      '-P',
      PROFILE_NAME,
      ...permissionProfileConfigArgs({ ...options, workspace: options.workspace || cwd }),
      '-C',
      cwd,
      '--',
      String(command),
      ...args.map(String),
    ],
  };
}

module.exports = {
  DEFAULT_GITHUB_CREDENTIAL_ROOT,
  DEFAULT_LIVE_ROOT,
  DEFAULT_SOURCE_ROOT,
  PROFILE_NAME,
  REVIEW_PROFILE_NAME,
  codexExecPermissionArgs,
  gitCommonConfigPath,
  inlineDenyTable,
  permissionProfileConfigArgs,
  protectedCredentialPaths,
  reviewCodexExecPermissionArgs,
  reviewPermissionProfileConfigArgs,
  sandboxedPayload,
  tomlString,
};
