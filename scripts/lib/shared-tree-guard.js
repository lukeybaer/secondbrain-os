/**
 * shared-tree-guard.js (Phase 0, session isolation)
 *
 * Stop-the-bleeding guard: block destructive git ops when the effective git
 * tree is the SHARED main checkout, but allow them inside an isolated worktree.
 *
 * The class of ops we block (category, not literal trigger):
 *   - git reset --hard        (discards worktree + index)
 *   - git clean -f / -fd / -fdx (deletes untracked files)
 *   - git checkout -- .  / git checkout .  (discards worktree changes)
 *   - destructive git stash (stash / stash push / stash -u that hides worktree state)
 *   - direct git commit / git push to master / origin master (mainline mutation)
 *
 * The class of SAFE location: any tree that is NOT the shared main checkout.
 * A tree is "the main checkout" if cwd is mainRoot or a subdirectory of it, OR
 * the command uses `git -C <path>` where that path resolves under mainRoot. A
 * path that lives inside an isolated worktree (/.claude/worktrees/, sb-sessions/,
 * sb-isolation, sb-hygiene) is never the main checkout.
 *
 * CommonJS so the hook can require() it via createRequire.
 */

'use strict';

const path = require('node:path');
const { validateIntegrationSession } = require('./integration-session.js');

// Markers that positively identify an isolated worktree path. If a path matches
// any of these it is NOT the shared main checkout, regardless of mainRoot.
const ISOLATED_WORKTREE_MARKERS = [
  '/.claude/worktrees/',
  'sb-sessions/',
  'sb-isolation',
  'sb-hygiene',
];

function normalize(p) {
  if (typeof p !== 'string' || p.length === 0) return '';
  // Unify slashes.
  let out = p.replace(/\\/g, '/');
  // MSYS / git-bash drive form: "/c/Users/x" -> "c:/Users/x" so it compares
  // equal to the Windows "C:/Users/x" form git itself returns. Without this the
  // guard silently no-ops when the shell passes a /c/ cwd.
  const msys = out.match(/^\/([a-zA-Z])\/(.*)$/);
  if (msys) out = msys[1] + ':/' + msys[2];
  // Lowercase the drive letter, drop trailing slash.
  if (/^[a-zA-Z]:/.test(out)) {
    out = out[0].toLowerCase() + out.slice(1);
  }
  out = out.replace(/\/+$/, '');
  return out;
}

function isIsolatedPath(p) {
  const n = normalize(p);
  if (!n) return false;
  return ISOLATED_WORKTREE_MARKERS.some((m) => n.includes(m));
}

/**
 * Is `candidate` the main checkout root, or a subdirectory of it?
 * Returns false if candidate is clearly an isolated worktree path.
 */
function isUnderMainRoot(candidate, mainRoot) {
  const c = normalize(candidate);
  const root = normalize(mainRoot);
  if (!c || !root) return false;
  if (isIsolatedPath(c)) return false;
  if (c === root) return true;
  return c.startsWith(root + '/');
}

/**
 * Pull an explicit `git -C <path>` target out of the command, if present.
 * Returns the path string or null. Handles quoted and unquoted forms.
 */
function extractGitCPath(command) {
  if (typeof command !== 'string') return null;
  // git -C <path>  (path may be quoted with single or double quotes)
  const m = command.match(/\bgit\s+-C\s+("([^"]+)"|'([^']+)'|(\S+))/);
  if (!m) return null;
  return m[2] || m[3] || m[4] || null;
}

/**
 * Decide whether the command, given cwd / mainRoot, operates on the shared
 * main checkout. `git -C <path>` overrides cwd for ownership purposes.
 */
function operatesOnMainCheckout(command, cwd, mainRoot) {
  const cPath = extractGitCPath(command);
  if (cPath) {
    // An explicit -C target that points into an isolated worktree is safe even
    // if cwd is the main checkout, and vice-versa: the -C path is authoritative.
    if (isIsolatedPath(cPath)) return false;
    // Resolve relative -C paths against cwd so subdir targets are caught.
    const resolved = path.isAbsolute(cPath) ? cPath : path.join(cwd || '', cPath);
    return isUnderMainRoot(resolved, mainRoot);
  }
  return isUnderMainRoot(cwd, mainRoot);
}

// ---- Destructive-op classifiers (run on the command string) ----

function isResetHard(cmd) {
  return /\bgit\b[^\n]*\breset\b[^\n]*--hard\b/.test(cmd);
}

function isCleanForce(cmd) {
  // git clean with a force flag: -f, -fd, -fdx, --force, -xdf, etc.
  // Match a clean subcommand followed by an option bundle containing 'f',
  // or the long --force flag.
  if (!/\bgit\b[^\n]*\bclean\b/.test(cmd)) return false;
  if (/\bclean\b[^\n]*--force\b/.test(cmd)) return true;
  // Any short-option token after clean that contains an 'f'.
  return (
    /\bclean\b[^\n]*\s-[a-eg-wyz]*f[a-z]*\b/i.test(cmd) ||
    /\bclean\b[^\n]*\s-[a-z]*f[a-z]*/i.test(cmd)
  );
}

function isCheckoutDiscard(cmd) {
  // git checkout -- .   or   git checkout .   (discard worktree changes)
  if (/\bgit\b[^\n]*\bcheckout\b[^\n]*--\s+\.(\s|$)/.test(cmd)) return true;
  if (/\bgit\b[^\n]*\bcheckout\b\s+\.(\s|$)/.test(cmd)) return true;
  return false;
}

function isDestructiveStash(cmd) {
  // git stash / git stash push / git stash -u  hide (and can discard) worktree
  // state. `git stash list/show/pop/apply/branch` are not destructive intake.
  if (!/\bgit\b[^\n]*\bstash\b/.test(cmd)) return false;
  // Non-destructive stash subcommands: explicitly allow.
  if (/\bstash\s+(list|show|pop|apply|branch|clear|drop)\b/.test(cmd)) return false;
  // bare `git stash`, `git stash push ...`, `git stash -u`, `git stash save`
  return true;
}

function isMasterCommit(cmd) {
  // Direct commit while in the main checkout. We block any `git commit` that is
  // a real new commit (mainline mutation in the shared tree). --amend on shared
  // history is just as destructive, so it is included.
  return /\bgit\b[^\n]*\bcommit\b/.test(cmd);
}

function isMasterPush(cmd) {
  if (!/\bgit\b[^\n]*\bpush\b/.test(cmd)) return false;
  // Push that names master/main as the target ref, or a bare push (whose
  // upstream in the main checkout is origin/master).
  if (/\bpush\b[^\n]*\b(origin\s+)?(master|main)\b/.test(cmd)) return true;
  if (/\bpush\b[^\n]*\bHEAD:(refs\/heads\/)?(master|main)\b/.test(cmd)) return true;
  // Bare `git push` / `git push origin` / `git push --force` with no explicit
  // non-master ref is treated as targeting the mainline.
  const refPart = cmd.replace(/\bgit\b[^\n]*\bpush\b/, '');
  const namesOtherBranch =
    /\b(origin|upstream)\s+([\w.\/-]+)/.test(refPart) &&
    !/\b(origin|upstream)\s+(master|main)\b/.test(refPart);
  if (namesOtherBranch) return false;
  return true;
}

function classifyDestructive(command, opts = {}) {
  const cmd = String(command || '');
  if (isResetHard(cmd)) return 'git reset --hard discards all worktree and index changes';
  if (isCleanForce(cmd)) return 'git clean -f deletes untracked files';
  if (isCheckoutDiscard(cmd)) return 'git checkout -- . discards worktree changes';
  if (isDestructiveStash(cmd)) return 'destructive git stash hides or discards worktree state';
  // Mainline mutation (direct commit/push to master in the shared tree) is the
  // breaking half of the policy: it forces sessions onto worktrees + the land
  // gate. It is included by default now that the worktree launcher and land
  // command exist; SB_GUARD_MODE=destructive-only is the explicit rollback mode.
  if (opts.includeMainlineMutation) {
    if (isMasterCommit(cmd)) return 'direct git commit mutates the shared mainline';
    if (isMasterPush(cmd)) return 'git push to master/origin master mutates the shared mainline';
  }
  return null;
}

/**
 * @param {object} args
 * @param {string} args.command  the shell command being evaluated
 * @param {string} args.cwd      working directory of the command
 * @param {string} args.mainRoot absolute path of the shared main checkout
 * @param {object} [args.env]    environment (for the escape hatch)
 * @returns {{ blocked: boolean, reason: string }}
 */
function evaluateSharedTreeOp({ command, cwd, mainRoot, env } = {}) {
  const e = env || {};

  // Escape hatch: the single sanctioned integration session may do anything,
  // but only when the env var is backed by a live lock file. The env var alone
  // is not authority.
  const integration = validateIntegrationSession({ env: e, mainRoot });
  if (integration.valid) {
    return {
      blocked: false,
      reason: integration.reason,
    };
  }

  // Mode flag for staged rollout. Default 'full' additionally blocks direct
  // commit/push to master in the shared tree. Set SB_GUARD_MODE=destructive-only
  // only as an explicit rollback if a live incident requires it.
  const fullMode = e.SB_GUARD_MODE !== 'destructive-only';
  const destructiveReason = classifyDestructive(command, { includeMainlineMutation: fullMode });
  if (!destructiveReason) {
    return { blocked: false, reason: 'op is not in the destructive class' };
  }

  if (!operatesOnMainCheckout(command, cwd, mainRoot)) {
    return {
      blocked: false,
      reason: 'destructive op runs in an isolated worktree, not the shared main checkout',
    };
  }

  return {
    blocked: true,
    reason:
      'BLOCKED in shared main checkout: ' +
      destructiveReason +
      '. Run this inside an isolated worktree, or use scripts/integration-session.js for the sanctioned integration session.',
  };
}

module.exports = {
  evaluateSharedTreeOp,
  // exported for unit-level reuse / debugging
  isIsolatedPath,
  isUnderMainRoot,
  operatesOnMainCheckout,
  classifyDestructive,
};
