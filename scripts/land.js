#!/usr/bin/env node
'use strict';
//
// land.js -- the `land` command. Phase 2 of session isolation.
//
//   node scripts/land.js            # DRY RUN: print what it WOULD do
//   node scripts/land.js --apply    # actually rebase + test + lock + push
//
// What "landing" means here: take the current session branch (worked in its own
// isolated worktree off origin/master), bring it up to date, prove the change
// is green by running ONLY the affected tests plus the fast core guards, then --
// holding a serialized merge lock so no two sessions push at once -- fast-forward
// the branch onto master and push.
//
// Why scoped tests: the full suite is data-dependent and lives in a shared tree;
// a single unrelated red test there would freeze every lander. We run the tests
// the change actually touches (see scripts/lib/land-gate.js) so an unrelated red
// never blocks an unrelated land.
//
// Safety posture:
//   - Dry run by default. Nothing is pushed without --apply.
//   - Never push on red. A failing scoped test aborts before the lock is taken.
//   - The push is fast-forward only; if master moved under us, we abort rather
//     than force anything.
//   - The merge lock is released in a finally, even on error.

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const landGate = require('./lib/land-gate.js');

const REMOTE = 'origin';
const TARGET = 'master';
const APPLY = process.argv.includes('--apply');

// ---------------------------------------------------------------------------
// Small git helpers (reuse the safe execFileSync pattern from git-hygiene.js:
// argument array, never a shell string, so nothing is shell-interpolated).
// ---------------------------------------------------------------------------

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  }).trim();
}

function gitSafe(args, fallback = '') {
  try {
    return git(args);
  } catch {
    return fallback;
  }
}

function repoRoot() {
  return git(['rev-parse', '--show-toplevel']);
}

function currentBranch() {
  return git(['rev-parse', '--abbrev-ref', 'HEAD']);
}

// The merge lock lives in shared runtime state, NOT in the per-session worktree,
// so all landers contend on the SAME lock file. We anchor it to the repo's
// common git dir (shared across worktrees) under a stable subfolder.
function lockDir(root) {
  const commonDir = gitSafe(['rev-parse', '--git-common-dir'], path.join(root, '.git'));
  const abs = path.isAbsolute(commonDir) ? commonDir : path.join(root, commonDir);
  const dir = path.join(abs, 'land-gate');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function commonMainRoot(root) {
  const commonDir = gitSafe(['rev-parse', '--git-common-dir'], path.join(root, '.git'));
  const abs = path.isAbsolute(commonDir) ? commonDir : path.join(root, commonDir);
  return path.basename(abs).toLowerCase() === '.git' ? path.dirname(abs) : '';
}

function dependencyNodeModules(root) {
  const dirs = [];
  const add = (dir) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (!dirs.includes(resolved)) dirs.push(resolved);
  };
  add(path.join(root, 'node_modules'));
  add(process.env.SB_NODE_MODULES);
  add(process.env.NODE_MODULES);
  const mainRoot = process.env.SB_MAIN_CHECKOUT || commonMainRoot(root);
  add(mainRoot ? path.join(mainRoot, 'node_modules') : '');
  return dirs;
}

function resolveVitestEntry(root, nodeModuleDirs) {
  for (const dir of nodeModuleDirs) {
    const candidate = path.join(dir, 'vitest', 'vitest.mjs');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'cannot find vitest. Install dependencies in this worktree or set SB_NODE_MODULES/SB_MAIN_CHECKOUT.',
  );
}

function mergeNodePath(nodeModuleDirs) {
  const parts = [...nodeModuleDirs];
  if (process.env.NODE_PATH) parts.push(...process.env.NODE_PATH.split(path.delimiter));
  return Array.from(new Set(parts.filter(Boolean))).join(path.delimiter);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function log(...args) {
  console.log('[land]', ...args);
}

function fetchTarget() {
  log(`fetching ${REMOTE}/${TARGET} ...`);
  git(['fetch', REMOTE, TARGET], { stdio: ['ignore', 'pipe', 'inherit'] });
}

function rebaseOntoTarget(branch) {
  log(`rebasing ${branch} onto ${REMOTE}/${TARGET} ...`);
  if (!APPLY) {
    log(`  (dry run) would: git rebase ${REMOTE}/${TARGET}`);
    return;
  }
  try {
    git(['rebase', `${REMOTE}/${TARGET}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (err) {
    // Leave the working tree clean for the human: abort the half-done rebase.
    gitSafe(['rebase', '--abort']);
    throw new Error(
      `rebase onto ${REMOTE}/${TARGET} failed (conflicts?). Resolve manually, then re-run land.`,
    );
  }
}

// Changed files of THIS branch vs the merge base with origin/master, so we scope
// to what this session actually changed (not what master changed underneath us).
function changedFiles() {
  const base = gitSafe(['merge-base', 'HEAD', `${REMOTE}/${TARGET}`]) || `${REMOTE}/${TARGET}`;
  const out = gitSafe(['diff', '--name-only', `${base}...HEAD`]);
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Run the scoped tests. Returns true on green, false on red.
function runScopedTests(scope) {
  if (scope.length === 0) {
    log('no scoped tests resolved; running core guards only is already in scope, continuing.');
    return true;
  }
  log('running scoped tests:');
  for (const f of scope) log('  -', f);

  const root = repoRoot();

  // Only pass test paths that actually exist on disk to vitest; a non-existent
  // sibling (source has no test yet) should not be a hard "no tests found" red.
  // Resolve against the repo root, not cwd: vitest runs with cwd=root below,
  // and a lander invoked from a subdirectory must not silently filter out the
  // core guards as "nonexistent".
  const existing = scope.filter((f) => fs.existsSync(path.join(root, f)));
  if (existing.length === 0) {
    log('none of the scoped test files exist on disk; nothing to run, treating as green.');
    return true;
  }

  const nodeModuleDirs = dependencyNodeModules(root);
  const vitestEntry = resolveVitestEntry(root, nodeModuleDirs);
  const res = spawnSync(process.execPath, [vitestEntry, 'run', ...existing], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_PATH: mergeNodePath(nodeModuleDirs),
    },
  });
  return res.status === 0;
}

function pushFastForward(branch) {
  if (!APPLY) {
    log(`  (dry run) would: git push ${REMOTE} HEAD:${TARGET}  (fast-forward only)`);
    return;
  }
  // No --force anywhere. A plain push to master is rejected if it isn't a
  // fast-forward, which is exactly the protection we want: if master moved
  // after our rebase, we abort instead of clobbering.
  log(`pushing ${branch} -> ${REMOTE}/${TARGET} (fast-forward) ...`);
  git(['push', REMOTE, `HEAD:${TARGET}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  log('pushed.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const root = repoRoot();
  const branch = currentBranch();
  const sessionId = process.env.SB_SESSION_ID || `${branch}-${process.pid}`;

  log(`mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to push)'}`);
  log(`branch: ${branch}`);
  log(`repo: ${root}`);

  if (branch === TARGET) {
    throw new Error(`refusing to land: you are on ${TARGET} itself. Land from a session branch.`);
  }

  fetchTarget();
  rebaseOntoTarget(branch);

  const files = changedFiles();
  log(`changed files vs ${REMOTE}/${TARGET} (${files.length}):`);
  for (const f of files) log('  *', f);

  const scope = landGate.affectedTestScope(files);
  const green = runScopedTests(scope);

  if (!green) {
    // Never push on red, and never even take the lock -- a red change has no
    // business serializing everyone behind it.
    log('SCOPED TESTS RED. Not landing. Fix the change and re-run.');
    process.exitCode = 1;
    return;
  }
  log('scoped tests GREEN.');

  // Serialize the actual master push. Acquire the cross-session merge lock so
  // two landers never push master at the same instant.
  const dir = lockDir(root);
  const lock = landGate.acquireLandLock(dir, sessionId);
  if (!lock.acquired) {
    log('another session holds the land lock right now. Try again shortly.');
    process.exitCode = 1;
    return;
  }
  log(`land lock acquired (${sessionId}).`);

  try {
    pushFastForward(branch);
  } finally {
    landGate.releaseLandLock(dir, lock.token);
    log('land lock released.');
  }

  log(APPLY ? 'LANDED.' : 'dry run complete -- re-run with --apply to land for real.');
}

try {
  main();
} catch (err) {
  console.error('[land] ERROR:', err.message);
  process.exitCode = 1;
}
