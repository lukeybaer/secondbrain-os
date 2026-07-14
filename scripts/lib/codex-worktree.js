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
  // spawnSync sets `error` (ETIMEDOUT) + `signal` (SIGTERM) on timeout, and
  // ENOENT if git/cwd are missing. `status` is null in those cases, so the
  // ok check must not conflate "the command ran and said no" with "the command
  // never produced a verdict".
  const timedOut =
    result.error?.code === 'ETIMEDOUT' ||
    result.signal === 'SIGTERM' ||
    (result.status === null && Boolean(result.error));
  return {
    ok: result.status === 0,
    status: result.status,
    timedOut,
    error: result.error || null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    out: [result.stdout, result.stderr].filter(Boolean).join('\n'),
  };
}

// Synchronous backoff between probe retries (no extra deps; keeps these
// helpers callable from plain sync code paths like ensureCodexWorktree).
function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(ms, 10_000));
  } catch {
    // SharedArrayBuffer disabled: fall back to a bounded busy wait.
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

// A definitive "this is not a git repository" verdict. We only trust these to
// mean proven-not-a-worktree; every other failure (timeout, transient lock,
// empty output) is UNPROVEN and must be retried, then failed closed.
const NOT_A_REPO_RE =
  /not a git repository|outside repository|does not exist|no such file or directory/i;

// Tri-state git worktree probe. Returns exactly one of:
//   'worktree'      -- proven: `git rev-parse --is-inside-work-tree` said true
//   'not-worktree'  -- proven: git ran and said false, or definitively "not a repo"
//   'unproven'      -- the probe errored/timed out; we CANNOT tell. Never guess.
// Bounded retry with linear backoff absorbs transient .git-bloat timeouts
// before concluding UNPROVEN. Callers must treat 'unproven' as fail-closed.
function probeWorkTree(cwd, options = {}) {
  const {
    runGit = git,
    attempts = 3,
    backoffMs = 250,
    timeoutMs = 10_000,
    sleep = sleepSync,
  } = options;
  const total = Math.max(1, attempts);
  for (let i = 0; i < total; i += 1) {
    const r = runGit(['rev-parse', '--is-inside-work-tree'], cwd, timeoutMs);
    if (r.ok) {
      return String(r.stdout).trim() === 'true' ? 'worktree' : 'not-worktree';
    }
    // A ran-and-refused verdict (not timed out) that clearly says "not a repo"
    // is a PROVEN negative -- retrying will not change it.
    if (!r.timedOut && NOT_A_REPO_RE.test(String(r.stderr || r.out || ''))) {
      return 'not-worktree';
    }
    if (i < total - 1) sleep(backoffMs * (i + 1));
  }
  return 'unproven';
}

function isGitWorkTree(cwd, options = {}) {
  return probeWorkTree(cwd, options) === 'worktree';
}

function gitCommonDir(cwd, options = {}) {
  const { runGit = git } = options;
  const r = runGit(['rev-parse', '--git-common-dir'], cwd, 10_000);
  if (!r.ok) return '';
  const raw = String(r.stdout || '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

// Fail-CLOSED shared-checkout detection. Returns TRUE (assume we are in the
// shared checkout, so callers refuse to write here) whenever we cannot PROVE
// otherwise. The only way to get FALSE is a proven isolated worktree.
//   proven worktree + not the shared main root -> false (safe: isolated)
//   proven worktree + IS the shared main root  -> true
//   proven NOT a worktree                       -> false (not any checkout at all;
//                                                  ensureCodexWorktree's own guard
//                                                  handles the "not a repo" case)
//   UNPROVEN (timeout/error)                    -> true (fail closed)
function isSharedCheckout(cwd, options = {}) {
  const state = probeWorkTree(cwd, options);
  if (state === 'not-worktree') return false;
  if (state === 'unproven') return true; // fail closed: cannot prove isolation
  const common = gitCommonDir(cwd, options);
  if (!common) return true; // proven worktree but common dir unresolved -> fail closed
  return isSharedMainCheckout(cwd, common);
}

// Positive isolation proof for a cwd that is about to receive git writes.
// Returns { proven, state, reason }. `proven` is TRUE only when the cwd is a
// verified git worktree whose common dir is NOT the shared main checkout.
// Any UNPROVEN probe, unresolved common dir, or shared-root match yields
// proven:false so callers can refuse loudly instead of writing to the shared tree.
function proveWorktreeIsolation(cwd, options = {}) {
  const state = probeWorkTree(cwd, options);
  if (state !== 'worktree') {
    return {
      proven: false,
      state,
      reason:
        state === 'unproven'
          ? 'git worktree probe timed out/errored -- isolation UNPROVEN'
          : `${cwd} is not a git worktree`,
    };
  }
  const common = gitCommonDir(cwd, options);
  if (!common) {
    return { proven: false, state, reason: 'could not resolve git common dir -- isolation UNPROVEN' };
  }
  if (isSharedMainCheckout(cwd, common)) {
    return { proven: false, state, reason: `${cwd} IS the shared main checkout` };
  }
  return { proven: true, state, reason: 'verified isolated worktree' };
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

function resolveBaseRef(repoRoot, requested, runGit = git) {
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
    const r = runGit(['rev-parse', '--verify', candidate], repoRoot, 10_000);
    if (r.ok) return candidate;
  }
  return 'HEAD';
}

function ensureCodexWorktree(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..'));
  // Thread an injectable git runner + probe tuning through every probe so the
  // whole decision is deterministic under test and consistently retried in prod.
  const probeOpts = {};
  if (options.runGit) probeOpts.runGit = options.runGit;
  if (options.probeAttempts != null) probeOpts.attempts = options.probeAttempts;
  if (options.probeBackoffMs != null) probeOpts.backoffMs = options.probeBackoffMs;

  const rootState = probeWorkTree(repoRoot, probeOpts);
  if (rootState === 'not-worktree') {
    // Proven NOT a git repo -- there is nothing to isolate from. Loud + original.
    throw new Error(`Codex write rung requires a git worktree, got: ${repoRoot}`);
  }
  // rootState is 'worktree' or 'unproven' here.
  // Only a PROVEN isolated worktree may be handed back as-is. isSharedCheckout
  // returns false ONLY for a proven-worktree that is not the shared main root;
  // an UNPROVEN probe returns true (fail closed) and falls through to create a
  // real, separately-proven worktree below -- never the shared cwd.
  if (rootState === 'worktree' && !isSharedCheckout(repoRoot, probeOpts)) {
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
  const runGit = options.runGit || git;
  const baseRef = resolveBaseRef(repoRoot, options.baseRef, runGit);

  fs.mkdirSync(sessionsRoot, { recursive: true });
  runGit(['fetch', 'origin', 'master'], repoRoot, 120_000);

  const add = runGit(['worktree', 'add', '-b', branch, worktree, baseRef], repoRoot, 120_000);
  if (!add.ok) {
    throw new Error(`Could not create Codex isolation worktree at ${worktree}: ${add.out}`);
  }
  if (options.linkNodeModules !== false) {
    linkNodeModules(repoRoot, worktree);
  }
  // Correct-by-construction: never hand back a worktree we cannot PROVE is
  // isolated. If the freshly-created worktree still can't be verified (probe
  // times out again, or somehow resolves to the shared root), THROW rather than
  // return a cwd the lander would then commit into.
  const proof = proveWorktreeIsolation(worktree, probeOpts);
  if (!proof.proven) {
    throw new Error(
      `Codex isolation worktree at ${worktree} could not be PROVEN isolated ` +
        `(${proof.reason}); refusing to hand back an unproven-isolation cwd.`,
    );
  }
  return { cwd: worktree, repoRoot, worktree, branch, baseRef, created: true, isolated: true };
}

module.exports = {
  ensureCodexWorktree,
  gitCommonDir,
  isGitWorkTree,
  isSharedCheckout,
  probeWorkTree,
  proveWorktreeIsolation,
  normalizePath,
  slugify,
};
