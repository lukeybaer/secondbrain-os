'use strict';

const path = require('node:path');
const { validateIntegrationSession } = require('./integration-session.js');

function normalizePath(p) {
  if (typeof p !== 'string' || p.length === 0) return '';
  let s = p.replace(/\\/g, '/');
  s = s.replace(/\/{2,}/g, '/');
  s = s.replace(/^([a-zA-Z]):/, (_m, d) => d.toLowerCase() + ':');
  if (s.length > 1 && s.endsWith('/') && !/^[a-z]:\/$/.test(s)) s = s.slice(0, -1);
  return s;
}

function commonGitDirToMainRoot(commonGitDir, fallbackRoot = '') {
  const common = normalizePath(path.resolve(commonGitDir || ''));
  if (!common) return normalizePath(fallbackRoot);
  if (common.toLowerCase().endsWith('/.git')) return normalizePath(path.dirname(common));
  return normalizePath(fallbackRoot || path.dirname(common));
}

function isSharedMainCheckout(repoRoot, commonGitDir) {
  const root = normalizePath(path.resolve(repoRoot || ''));
  const main = commonGitDirToMainRoot(commonGitDir, root);
  return Boolean(root && main && root === main);
}

function shouldBlockSharedMainHook({ hookName, repoRoot, commonGitDir, env = {} } = {}) {
  const integration = validateIntegrationSession({ env, mainRoot: commonGitDirToMainRoot(commonGitDir, repoRoot) });
  if (integration.valid) {
    return { blocked: false, reason: integration.reason };
  }
  if (!['pre-commit', 'pre-push'].includes(hookName)) {
    return { blocked: false, reason: 'hook not guarded' };
  }
  if (!isSharedMainCheckout(repoRoot, commonGitDir)) {
    return { blocked: false, reason: 'isolated worktree' };
  }
  const isolatedWorktreeHint = path.join('%USERPROFILE%', 'sb-sessions').replace(/\\/g, '/');
  return {
    blocked: true,
    reason:
      `${hookName} from the shared checkout is blocked. ` +
      `Create/use an isolated worktree under ${isolatedWorktreeHint} and land through scripts/land.js.`,
  };
}

module.exports = {
  normalizePath,
  commonGitDirToMainRoot,
  isSharedMainCheckout,
  shouldBlockSharedMainHook,
};
