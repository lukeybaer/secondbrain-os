'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isSharedMainCheckout, normalizePath } = require('./git-hook-shared-tree-policy');

function slugify(value) {
  return (
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 44) || 'codex-task'
  );
}

function shortHash(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 10);
}

function git(args, cwd, timeoutMs = 90_000) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    out: [result.stdout, result.stderr].filter(Boolean).join('\n'),
  };
}

function isGitWorkTree(cwd) {
  const r = git(['rev-parse', '--is-inside-work-tree'], cwd, 10_000);
  return r.ok && String(r.stdout).trim() === 'true';
}

function gitCommonDir(cwd) {
  const r = git(['rev-parse', '--git-common-dir'], cwd, 10_000);
  if (!r.ok) return '';
  const raw = String(r.stdout || '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

function isSharedCheckout(cwd) {
  if (!isGitWorkTree(cwd)) return false;
  return isSharedMainCheckout(cwd, gitCommonDir(cwd));
}

function linkNodeModules(repoRoot, worktree) {
  const target = path.join(repoRoot, 'node_modules');
  const link = path.join(worktree, 'node_modules');
  if (fs.existsSync(link) || !fs.existsSync(target)) return;
  try {
    fs.symlinkSync(target, link, 'junction');
  } catch {
    // Best effort; the agent/test run will fail loudly if dependencies matter.
  }
}

function resolveBaseRef(repoRoot, requested) {
  const candidates = [
    requested,
    process.env.SECONDBRAIN_CODEX_BASE,
    'origin/master',
    'origin/main',
    'master',
    'main',
    'HEAD',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const r = git(['rev-parse', '--verify', candidate], repoRoot, 10_000);
    if (r.ok) return candidate;
  }
  return 'HEAD';
}

function ensureCodexWorktree(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..'));
  if (!isGitWorkTree(repoRoot)) {
    throw new Error(`Codex write rung requires a git worktree, got: ${repoRoot}`);
  }
  if (!isSharedCheckout(repoRoot)) {
    return { cwd: repoRoot, repoRoot, created: false, isolated: true };
  }

  const sessionsRoot = path.resolve(
    options.sessionsRoot || process.env.SECONDBRAIN_SESSION_ROOT || path.join(os.homedir(), 'sb-sessions'),
  );
  const purpose = slugify(options.purpose || 'codex-task');
  const suffix = shortHash([
    options.purpose || '',
    process.pid,
    Date.now(),
    Math.random(),
  ].join('|'));
  const branchPrefix = String(options.branchPrefix || 'codex/auto').replace(/\/+$/g, '');
  const branch = `${branchPrefix}/${purpose}-${suffix}`.slice(0, 120);
  const worktree = path.join(sessionsRoot, `${purpose}-${suffix}`);
  const baseRef = resolveBaseRef(repoRoot, options.baseRef);

  fs.mkdirSync(sessionsRoot, { recursive: true });
  git(['fetch', 'origin', 'master'], repoRoot, 120_000);

  const add = git(['worktree', 'add', '-b', branch, worktree, baseRef], repoRoot, 120_000);
  if (!add.ok) {
    throw new Error(`Could not create Codex isolation worktree at ${worktree}: ${add.out}`);
  }
  if (options.linkNodeModules !== false) {
    linkNodeModules(repoRoot, worktree);
  }
  return { cwd: worktree, repoRoot, worktree, branch, baseRef, created: true, isolated: true };
}

module.exports = {
  ensureCodexWorktree,
  gitCommonDir,
  isGitWorkTree,
  isSharedCheckout,
  normalizePath,
  slugify,
};
