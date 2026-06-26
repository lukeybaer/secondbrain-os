// session-isolation.js
//
// Phase 1 of the session-isolation plan. Tells a session whether it is running
// in the shared MAIN checkout (forbidden for work, because peers can destroy
// uncommitted work in a shared working copy) or in an ISOLATED worktree
// (required for work).
//
// The shared main checkout is a single working copy that every surface and peer
// session shares. Two sessions editing it at once stomp each other. The fix is
// per-session git worktrees: each session works in its own checkout off
// origin/master, so uncommitted work is private until pushed.
//
// This module is intentionally pure path logic with no filesystem or git
// access, so it is cheap to call from a SessionStart hook and trivial to test.
//
// CommonJS so the .js test (via createRequire) and the .mjs hook (via a small
// re-export shim, if ever needed) can both consume it.

'use strict';

/**
 * Normalize a path for comparison across shells and platforms:
 *   - backslash -> forward slash
 *   - collapse duplicate slashes
 *   - lowercase a leading Windows drive letter (C: -> c:)
 *   - strip a single trailing slash (but keep a bare root like c:/)
 *
 * We deliberately lowercase ONLY the drive letter, not the whole path, so we
 * stay correct on case-sensitive filesystems while still treating C: and c:
 * (and the case-insensitive Windows segments) as equal for the drive prefix.
 * The folder-name checks below use case-insensitive matching where it matters.
 */
function normalizePath(p) {
  if (typeof p !== 'string' || p.length === 0) return '';
  let s = p.replace(/\\/g, '/');
  // Collapse repeated slashes (but leave a leading // alone is unnecessary here).
  s = s.replace(/\/{2,}/g, '/');
  // Lowercase a leading drive letter: "C:/..." -> "c:/...".
  s = s.replace(/^([a-zA-Z]):/, (_m, d) => d.toLowerCase() + ':');
  // Strip a single trailing slash unless the whole thing is a root like "c:/".
  if (s.length > 1 && s.endsWith('/') && !/^[a-z]:\/$/.test(s)) {
    s = s.slice(0, -1);
  }
  return s;
}

// Sibling-worktree directory markers. Any normalized path that contains one of
// these segments is treated as an isolated worktree. These are the conventional
// homes for per-session and special-purpose worktrees in this repo.
const SIBLING_WORKTREE_MARKERS = [
  '/sb-sessions/', // per-session worktrees: C:/Users/USER/sb-sessions/<id>
  'sb-isolation', // this isolation worktree
  'sb-hygiene', // the hygiene worktree
];

// Claude Code native worktrees live under <repo>/.claude/worktrees/<name>.
const CLAUDE_NATIVE_WORKTREE_MARKER = '/.claude/worktrees/';

/**
 * True iff `cwd` resolves to the MAIN checkout root exactly.
 *
 * Same path as repoRoot -> true. A worktree path (sibling dir or
 * .claude/worktrees/*) -> false, even if it happens to be nested under the
 * repo root (Claude native worktrees are).
 */
function isMainCheckout(cwd, repoRoot) {
  const c = normalizePath(cwd);
  const r = normalizePath(repoRoot);
  if (!c || !r) return false;
  // A Claude-native worktree is physically nested under the repo root but is
  // NOT the main checkout. Exclude it before the exact-match compare.
  if (c.includes(CLAUDE_NATIVE_WORKTREE_MARKER)) return false;
  return c === r;
}

/**
 * True iff `cwd` is a non-main (isolated) worktree.
 *
 * Isolated means any of:
 *   - path contains /.claude/worktrees/  (Claude Code native worktree)
 *   - path contains a sibling-worktree marker (sb-sessions/, sb-isolation,
 *     sb-hygiene)
 * The main checkout root itself is never isolated.
 */
function isIsolatedWorktree(cwd, repoRoot) {
  const c = normalizePath(cwd);
  if (!c) return false;
  if (isMainCheckout(c, repoRoot)) return false;
  if (c.includes(CLAUDE_NATIVE_WORKTREE_MARKER)) return true;
  for (const marker of SIBLING_WORKTREE_MARKERS) {
    if (c.includes(marker)) return true;
  }
  return false;
}

/**
 * Throws if the session is running in the main checkout; otherwise returns true.
 * Error message mentions "main checkout" so callers (and tests) can match it.
 */
function assertSessionIsolated(cwd, repoRoot) {
  if (isMainCheckout(cwd, repoRoot)) {
    throw new Error(
      'Session is running in the shared main checkout (' +
        normalizePath(cwd) +
        '). Work must run in an isolated worktree. Move to one before editing.',
    );
  }
  return true;
}

module.exports = {
  normalizePath,
  isMainCheckout,
  isIsolatedWorktree,
  assertSessionIsolated,
};
