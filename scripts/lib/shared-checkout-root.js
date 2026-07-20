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

const WORKTREE_SEGMENT = /^(.*)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+/;

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
