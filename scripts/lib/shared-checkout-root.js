'use strict';

/**
 * shared-checkout-root.js
 *
 * One definition of "which repo roots could hold durable agent state".
 *
 * Agents work in isolated worktrees under <main>/.claude/worktrees/<id>. Any
 * runtime artifact written to <worktree>/data/agent dies when the worktree is
 * reaped. Peer-review receipts are exactly that kind of artifact, and a receipt
 * that evaporates is the same as no receipt: the two-bot gate re-blocks work
 * that was genuinely reviewed, and an auditor can never reconstruct what was
 * reviewed before a deploy.
 *
 * So anything durable is written to EVERY root this returns, and anything
 * looking for durable state reads from EVERY root this returns. The shared
 * checkout is always among them.
 *
 * Consumers: scripts/codex-peer-review.js (write),
 *            scripts/claude-hooks/two-bot-gate.mjs (read).
 */

const path = require('path');
const { execFileSync } = require('child_process');

const WORKTREE_SEGMENT = /^(.*)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+/;

// Codex gate 05a8e5b45303 finding 2: the regex above only recognises worktrees
// NESTED under <main>/.claude/worktrees. scripts/new-session.sh creates them as
// SIBLINGS under sb-sessions/<name>, so the pattern never matched, the shared
// checkout was never added, and sharedCheckoutRoots() returned only the
// disposable session path. codex-peer-review.js then wrote its receipt solely
// into a directory that land.js reaps, so the two-bot gate could pass with no
// durable copy of the review that authorised the deploy.
//
// Adding a second path pattern would just fail again on the next layout, so
// ask git instead. `--git-common-dir` resolves to the MAIN repo's .git from
// inside any worktree regardless of where it sits on disk, and its parent is
// the shared checkout. The regex stays as a fallback for callers that pass a
// path with no git available.
function gitSharedCheckout(fromDir) {
  try {
    const common = execFileSync('git', ['-C', fromDir, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    if (!common) return null;
    const abs = path.isAbsolute(common) ? common : path.resolve(fromDir, common);
    // <root>/.git -> <root>. A bare or unusual layout yields no useful parent.
    if (path.basename(abs).toLowerCase() !== '.git') return null;
    return path.dirname(abs);
  } catch {
    return null;
  }
}

/**
 * Repo roots to search or mirror into, nearest first, shared checkout last.
 * Worktree nesting is unwound in a loop so a worktree spawned from a worktree
 * still resolves to the real shared checkout.
 *
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, extraRoots?: string[]}} [opts]
 * @returns {string[]} absolute, de-duplicated
 */
function sharedCheckoutRoots(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const env = opts.env || process.env;
  const roots = [];

  const add = (p) => {
    if (!p) return;
    const norm = path.resolve(String(p));
    if (!roots.some((r) => r.toLowerCase() === norm.toLowerCase())) roots.push(norm);
  };

  const unwind = (start) => {
    if (!start) return;
    let current = path.resolve(String(start));
    add(current);
    let guard = 0;
    while (guard++ < 10) {
      const m = WORKTREE_SEGMENT.exec(current);
      if (!m || !m[1]) break;
      current = m[1];
      add(current);
    }
    // Git is authoritative about which checkout is the real one, and it works
    // for sibling worktrees (sb-sessions/<name>) that the path pattern above
    // cannot see. Runs after the pattern so nearest-first ordering is kept and
    // the shared checkout still lands last.
    const shared = gitSharedCheckout(path.resolve(String(start)));
    if (shared) add(shared);
  };

  unwind(cwd);
  for (const extra of opts.extraRoots || []) unwind(extra);
  unwind(env.CLAUDE_PROJECT_DIR);
  unwind(env.SECONDBRAIN_ROOT);
  return roots;
}

/** True when the path sits inside a .claude/worktrees/<id> tree. */
function isWorktreePath(p) {
  return WORKTREE_SEGMENT.test(path.resolve(String(p || '')));
}

module.exports = { sharedCheckoutRoots, isWorktreePath, WORKTREE_SEGMENT };
