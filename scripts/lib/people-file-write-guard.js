'use strict';

const os = require('node:os');
const path = require('node:path');
const { evaluateSharedTreeWrite } = require('./shared-tree-write-guard.js');

// Path math follows the platform being checked, so a Windows checkout is
// judged as one even from a Linux host (the land gate runs there on EC2).
function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path;
}

function resolveSharedMainRoot(env = process.env, platform = process.platform) {
  // MAIN_ROOT names the protected checkout boundary. SECONDBRAIN_ROOT names the
  // caller's intended repository target and may legitimately be an isolated
  // worktree, so it must not redefine the boundary being protected.
  if (env.SECONDBRAIN_MAIN_ROOT) return path.resolve(env.SECONDBRAIN_MAIN_ROOT);
  if (platform !== 'win32') return '';
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return home ? pathFor(platform).resolve(home, 'secondbrain') : '';
}

function assertPeopleFileWriteAllowed(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const paths = pathFor(platform);
  const repo = paths.resolve(options.repo || process.env.SECONDBRAIN_ROOT || process.cwd());
  const mainRoot = options.mainRoot || resolveSharedMainRoot(env, platform);
  if (!mainRoot) {
    return { blocked: false, reason: 'shared Windows checkout is not present on this host' };
  }

  const verdict = evaluateSharedTreeWrite({
    filePath: options.target || paths.join(repo, 'memory', 'contacts'),
    cwd: options.cwd || process.cwd(),
    mainRoot,
    env,
    resolveRealPath: options.resolveRealPath,
  });
  if (verdict.blocked) {
    throw new Error(`Refusing people-file write: ${verdict.reason}`);
  }
  return verdict;
}

module.exports = {
  assertPeopleFileWriteAllowed,
  resolveSharedMainRoot,
};
