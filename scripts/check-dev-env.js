/**
 * check-dev-env.js
 *
 * Pre-flight guard that runs before `electron-vite dev`.
 *
 * Purpose:
 *   Prevent accidental `npm run dev` from inside a Claude worktree directory.
 *   Worktrees are ephemeral sandboxes; launching Electron from one causes
 *   path confusion, stale lock files, and IPC errors.  The main repo must
 *   always be the working directory.
 *
 * Node.js v24+ compatible — no shell escaping, no inline -e hacks.
 */

'use strict';

/**
 * Normalise the current working directory to forward-slash separators so the
 * check works identically on Windows (backslashes) and macOS/Linux (already
 * forward slashes).
 *
 * @returns {string} CWD with all backslashes replaced by forward slashes.
 */
function normaliseCwd() {
  return process.cwd().replace(/\\/g, '/');
}

/**
 * Verify that we are NOT running from inside a `.claude/worktrees` path.
 * If we are, print a clear fatal message and exit with code 1 so the
 * `&&` chain in the npm script halts before Electron starts.
 *
 * @param {string} cwd - Normalised working directory path.
 */
function assertNotWorktree(cwd) {
  if (cwd.includes('.claude/worktrees')) {
    const line = '='.repeat(60);
    const root = process.env.SECONDBRAIN_ROOT || '/path/to/secondbrain';
    console.error(
      `\n${line}\n` +
      `FATAL: npm run dev must be run from the MAIN REPO\n` +
      `You are in: ${cwd}\n` +
      `Run from:   ${root}\n` +
      `${line}`
    );
    process.exit(1);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────
const cwd = normaliseCwd();
assertNotWorktree(cwd);
// All checks passed — electron-vite dev will launch next in the npm script.
