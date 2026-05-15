// Prevents `npm run dev` from running inside a Claude Code worktree copy.
// The Electron singleton + APPDATA paths assume the main checkout; running
// from a worktree silently corrupts state. Fail loudly instead.

const cwd = process.cwd().replace(/\\/g, '/');

if (cwd.includes('.claude/worktrees')) {
  const bar = '='.repeat(60);
  const root = process.env.SECONDBRAIN_ROOT || '/path/to/secondbrain';
  console.error(
    `\n${bar}\n` +
    `FATAL: npm run dev must be run from the MAIN REPO\n` +
    `You are in: ${cwd}\n` +
    `Run from: ${root}\n` +
    `${bar}`,
  );
  process.exit(1);
}
