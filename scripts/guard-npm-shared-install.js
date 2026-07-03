#!/usr/bin/env node
'use strict';

// guard-npm-shared-install.js -- W3d item 3, the "npm install would wipe the
// shared checkout through the junction" preflight.
//
// An isolated worktree's node_modules is a Windows junction pointing straight
// back at the SHARED checkout's node_modules
// (feedback_never_npm_install_against_shared_node_modules.md: a plain
// `npm install` from a worktree rebuilds native deps against the wrong
// runtime, the build fails, and node_modules gets stripped for every session
// sharing that tree). Wired as the repo's "preinstall" script so `npm
// install`/`npm ci` refuses to run in the two hazardous cases:
//   1. cwd's node_modules is a junction/symlink whose resolved target lands
//      inside the SHARED checkout's node_modules.
//   2. cwd IS the shared checkout itself (no junction needed to cause harm
//      there -- it's the origin, not a copy) -- unless the explicit escape
//      hatch SB_ALLOW_SHARED_INSTALL=1 is set.
// Zero effect anywhere else: EC2, CI, and a worktree with its own real
// node_modules all have no junction into the shared root, so the guard is a
// silent no-op there.

const fs = require('fs');
const os = require('os');
const path = require('path');

function normalizePath(p) {
  if (typeof p !== 'string' || p.length === 0) return '';
  let out = p.replace(/\\/g, '/');
  // Windows readlinkSync() on a junction can return an extended-length /
  // NT-namespace target (\\?\C:\... or \??\C:\...) even though the caller's
  // sharedRoot is an ordinary drive path. Strip that prefix so the two forms
  // of the SAME path compare equal instead of silently failing isInside().
  out = out.replace(/^\/\/\?\//, '').replace(/^\/\?\?\//, '');
  if (/^[a-zA-Z]:/.test(out)) out = out[0].toLowerCase() + out.slice(1);
  return out.replace(/\/+$/, '');
}

function isInside(child, parent) {
  // Windows paths are case-insensitive but case-preserving (NTFS): a junction
  // target and the shared root can differ only in case (e.g. a drive letter
  // or a segment typed differently) and still be the SAME directory. Compare
  // case-insensitively so that difference never causes a false negative that
  // would let an install slip past the guard.
  const c = normalizePath(child).toLowerCase();
  const p = normalizePath(parent).toLowerCase();
  return c === p || c.startsWith(`${p}/`);
}

function defaultSharedRoot() {
  return process.env.SECONDBRAIN_ROOT || path.join(os.homedir(), 'secondbrain');
}

// Resolve node_modules link target without throwing. Windows junctions and
// POSIX symlinks both report isSymbolicLink() === true via lstat, and
// readlinkSync resolves the stored target for both -- no separate
// reparse-point API is needed on either platform.
function resolveLinkTarget(nodeModulesPath) {
  let stat;
  try {
    stat = fs.lstatSync(nodeModulesPath);
  } catch {
    return null; // does not exist -- nothing to guard against yet
  }
  if (!stat.isSymbolicLink()) return { isLink: false, target: null };
  try {
    const target = fs.readlinkSync(nodeModulesPath);
    return {
      isLink: true,
      target: path.isAbsolute(target)
        ? target
        : path.resolve(path.dirname(nodeModulesPath), target),
    };
  } catch {
    // A link we cannot read is still a link; treat conservatively as ExampleCo
    // target so we do not silently pass a case we can't verify.
    return { isLink: true, target: null };
  }
}

function checkNpmSharedInstall({
  cwd = process.cwd(),
  sharedRoot = defaultSharedRoot(),
  env = process.env,
} = {}) {
  const sharedRootAbs = path.resolve(sharedRoot);
  const sharedNodeModules = path.join(sharedRootAbs, 'node_modules');
  const cwdAbs = path.resolve(cwd);

  // Case 2: running the install FROM the shared checkout itself.
  if (isInside(cwdAbs, sharedRootAbs) && normalizePath(cwdAbs) === normalizePath(sharedRootAbs)) {
    if (env.SB_ALLOW_SHARED_INSTALL === '1') {
      return { blocked: false, reason: 'SB_ALLOW_SHARED_INSTALL=1 escape hatch set' };
    }
    return {
      blocked: true,
      reason:
        'refusing npm install: cwd IS the shared checkout ' +
        `(${sharedRootAbs}). Every Claude/Codex session shares this node_modules; ` +
        'installing here can strip it for everyone. Run installs from an isolated ' +
        'worktree instead, or set SB_ALLOW_SHARED_INSTALL=1 if this is an intentional, ' +
        'supervised maintenance install.',
    };
  }

  // Case 1: a junction/symlink node_modules resolving into the shared root.
  const nodeModulesPath = path.join(cwdAbs, 'node_modules');
  const link = resolveLinkTarget(nodeModulesPath);
  if (link && link.isLink) {
    const target = link.target;
    const targetInShared = target ? isInside(path.resolve(target), sharedNodeModules) : true; // ExampleCo target: fail closed
    if (targetInShared) {
      return {
        blocked: true,
        reason:
          `refusing npm install: node_modules at ${nodeModulesPath} is a junction/symlink ` +
          `into the SHARED checkout's node_modules (${target || sharedNodeModules}). ` +
          'npm install/ci here would mutate the shared store through the junction and can ' +
          'wipe it for every session. Do not run npm install/ci against a junctioned ' +
          'node_modules; restore per feedback_never_npm_install_against_shared_node_modules.md.',
      };
    }
  }

  return { blocked: false, reason: 'no shared-checkout junction detected' };
}

function main() {
  const result = checkNpmSharedInstall({});
  if (result.blocked) {
    console.error(`[guard-npm-shared-install] ${result.reason}`);
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { checkNpmSharedInstall, resolveLinkTarget, normalizePath, isInside };
