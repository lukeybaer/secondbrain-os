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

// ---- Shell parsing -------------------------------------------------------
//
// 2026-07-20. The classifiers below used to run as substring regexes over the
// WHOLE command string, so `echo "ready to commit"` and
// `grep -rn "git reset --hard" scripts/` were classified as destructive. That
// fired four times in one day. A guard with false positives is worse than no
// guard: it reads as noise and trains agents to route around it, which is how
// the real destructive op eventually lands. So we parse instead of grep, and
// only ever classify a segment that actually STARTS a git command.
// Companion test: scripts/__tests__/shared-tree-guard-command-parsing.test.js

/**
 * Drop heredoc bodies. Text piped into a file is data, not commands, and a
 * prompt that quotes `git reset --hard` must not be classified as running it.
 */
function stripHeredocBodies(command) {
  const lines = String(command || '').split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    out.push(line);
    i += 1;
    const m = line.match(/<<-?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))/);
    if (!m) continue;
    const term = m[1] || m[2] || m[3];
    while (i < lines.length && lines[i].trim() !== term) i += 1;
    if (i < lines.length) i += 1; // consume the terminator line itself
  }
  return out.join('\n');
}

/**
 * Split a shell command into command segments on UNQUOTED separators, so a
 * verb inside a quoted string stays inside its own segment's arguments.
 * Command substitutions open a new segment because `$(git clean -fdx)` really
 * does run git.
 */
function splitSegments(command) {
  const src = stripHeredocBodies(command);
  const segments = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        cur += ch + (src[i + 1] || '');
        i += 1;
        continue;
      }
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      cur += ch + (src[i + 1] || '');
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    // `#` starts a comment only at a token boundary.
    if (ch === '#' && (cur === '' || /\s$/.test(cur))) {
      while (i < src.length && src[i] !== '\n') i += 1;
      segments.push(cur);
      cur = '';
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '$(') {
      segments.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    if (';|&\n()`{}'.includes(ch)) {
      segments.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  segments.push(cur);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** Tokenize one segment into argv, honoring quotes and stripping them. */
function tokenize(segment) {
  const tokens = [];
  let cur = '';
  let started = false;
  let quote = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        cur += segment[i + 1] || '';
        i += 1;
        started = true;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      started = true;
      continue;
    }
    if (ch === '\\') {
      cur += segment[i + 1] || '';
      i += 1;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) tokens.push(cur);
  return tokens;
}

// Prefixes that precede the real command without changing what it is.
const COMMAND_WRAPPERS = new Set([
  'sudo',
  'env',
  'command',
  'nohup',
  'time',
  'nice',
  'winpty',
  'exec',
  '!',
]);

/**
 * If this segment actually invokes git, return the argv AFTER the `git` token.
 * Returns null for anything else, which is what keeps `echo`, `grep`, and `rg`
 * out of the classifiers no matter what their arguments say.
 */
function gitInvocation(segment) {
  const tokens = tokenize(segment);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || COMMAND_WRAPPERS.has(t)) {
      i += 1;
      continue;
    }
    break;
  }
  const head = tokens[i];
  if (!head) return null;
  const base = head
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (base !== 'git') return null;
  return tokens.slice(i + 1);
}

// git global options that consume the following token as their value.
const GIT_GLOBAL_OPTS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--exec-path',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
]);

/** Split git argv into its global options, the subcommand, and its args. */
function splitGitArgs(argv) {
  const globals = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (GIT_GLOBAL_OPTS_WITH_VALUE.has(a)) {
      globals.push(a, argv[i + 1]);
      i += 2;
      continue;
    }
    if (a.startsWith('-')) {
      globals.push(a);
      i += 1;
      continue;
    }
    break;
  }
  return { globals, sub: argv[i] || null, args: argv.slice(i + 1) };
}

/**
 * Pull an explicit `git -C <path>` target out of the command, if present.
 * Returns the path string or null. Quoted forms are handled by the tokenizer.
 */
function extractGitCPath(command) {
  for (const segment of splitSegments(command)) {
    const argv = gitInvocation(segment);
    if (!argv) continue;
    const idx = argv.indexOf('-C');
    if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  }
  return null;
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

// ---- Destructive-op classifiers (run on parsed git argv) ----

function isResetHard(args) {
  return args.includes('--hard');
}

function isCleanForce(args) {
  // git clean with a force flag: -f, -fd, -fdx, --force, -xdf, etc.
  return args.some((a) => a === '--force' || (/^-[a-zA-Z]+$/.test(a) && a.includes('f')));
}

function isCheckoutDiscard(args) {
  // git checkout -- .  /  git checkout .  /  git restore .  discard worktree
  // changes. A pathspec of `.` is the whole-tree form we care about.
  const dashDash = args.indexOf('--');
  if (dashDash !== -1 && args[dashDash + 1] === '.') return true;
  return args.length > 0 && args[0] === '.';
}

function isDestructiveStash(args) {
  // `git stash`, `git stash push`, `git stash -u`, `git stash save` hide (and
  // can discard) worktree state. list/show/pop/apply/branch/clear/drop are not
  // destructive intake.
  const firstPositional = args.find((a) => !a.startsWith('-'));
  if (
    firstPositional &&
    ['list', 'show', 'pop', 'apply', 'branch', 'clear', 'drop'].includes(firstPositional)
  ) {
    return false;
  }
  return true;
}

function isMasterPush(args) {
  // Push that names master/main as the target ref, or a bare push (whose
  // upstream in the main checkout is origin/master).
  const positional = args.filter((a) => !a.startsWith('-'));
  if (positional.some((a) => a === 'master' || a === 'main')) return true;
  if (positional.some((a) => /^HEAD:(refs\/heads\/)?(master|main)$/.test(a))) return true;
  // `git push origin some-branch` names an explicit non-mainline ref.
  if (positional.length >= 2) return false;
  // Bare `git push` / `git push origin` / `git push --force`: mainline upstream.
  return true;
}

/**
 * Classify ONE parsed git invocation. Returns a reason string or null.
 */
function classifySegment(sub, args, opts) {
  switch (sub) {
    case 'reset':
      return isResetHard(args) ? 'git reset --hard discards all worktree and index changes' : null;
    case 'clean':
      return isCleanForce(args) ? 'git clean -f deletes untracked files' : null;
    case 'checkout':
    case 'restore':
      return isCheckoutDiscard(args) ? 'git checkout -- . discards worktree changes' : null;
    case 'stash':
      return isDestructiveStash(args)
        ? 'destructive git stash hides or discards worktree state'
        : null;
    // Obstruction, as distinct from destruction. Staging in the shared checkout
    // destroys nothing, but it leaves index residue that makes the tree dirty,
    // and dirt that COLLIDES with incoming changes makes
    // shared-checkout-reconciler.js (the SOLE promoter, devops-release
    // Invariant 6) refuse to fast-forward. One session's leftovers therefore
    // hold every other session's landed work off the live tree, which is
    // exactly what g10 ("the shared checkout is read-only to agents") exists to
    // prevent. Found 2026-07-19 when a peer's staged 3-file dev-plan retirement
    // kept the injection-channel fix from reaching the live hook path for hours.
    case 'add':
    case 'rm':
    case 'mv':
      return "staging in the shared checkout leaves index residue that blocks the reconciler, holding every other session's landed work off the live tree";
    // Mainline mutation (direct commit/push to master in the shared tree) is
    // the breaking half of the policy: it forces sessions onto worktrees + the
    // land gate. --amend on shared history is just as destructive as a new
    // commit, so `commit` is classified whatever its flags.
    case 'commit':
      return opts.includeMainlineMutation ? 'direct git commit mutates the shared mainline' : null;
    case 'push':
      return opts.includeMainlineMutation && isMasterPush(args)
        ? 'git push to master/origin master mutates the shared mainline'
        : null;
    default:
      return null;
  }
}

/**
 * Walk the command's segments and return the first destructive git invocation
 * as { reason, segment }, or null. Returning the SEGMENT matters: ownership
 * (`git -C <path>`) must be resolved against the invocation that was actually
 * classified, not against unrelated text elsewhere in the command line.
 */
function classifyDestructiveDetailed(command, opts = {}) {
  for (const segment of splitSegments(command)) {
    const argv = gitInvocation(segment);
    if (!argv) continue;
    const { sub, args } = splitGitArgs(argv);
    if (!sub) continue;
    const reason = classifySegment(sub, args, opts);
    if (reason) return { reason, segment };
  }
  return null;
}

function classifyDestructive(command, opts = {}) {
  const detail = classifyDestructiveDetailed(command, opts);
  return detail ? detail.reason : null;
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
  const detail = classifyDestructiveDetailed(command, { includeMainlineMutation: fullMode });
  if (!detail) {
    return { blocked: false, reason: 'op is not in the destructive class' };
  }
  const destructiveReason = detail.reason;

  // Ownership is resolved against the SEGMENT that was classified, so a
  // `git -C <path>` elsewhere in the command line cannot launder or falsely
  // condemn an unrelated invocation.
  if (!operatesOnMainCheckout(detail.segment, cwd, mainRoot)) {
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
  classifyDestructiveDetailed,
  splitSegments,
  tokenize,
  gitInvocation,
  splitGitArgs,
};
