'use strict';

const { spawnSync } = require('node:child_process');

const GIT_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.SB_SHARED_SYNC_GIT_TIMEOUT_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
})();

function runGitDefault(args, cwd) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
  };
}

// `git status --porcelain` entries as { code, rel } rows. Handles rename
// output by keeping the destination path.
function parsePorcelain(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2);
      let rel = line.slice(3);
      const arrow = rel.indexOf(' -> ');
      if (arrow !== -1) rel = rel.slice(arrow + 4);
      if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
      return { code, rel };
    });
}

function fastForwardShared({
  sharedRoot,
  remote = 'origin',
  target = 'master',
  runGit = runGitDefault,
  log = () => {},
} = {}) {
  if (!sharedRoot) throw new Error('fastForwardShared: sharedRoot is required');

  const remoteRef = `${remote}/${target}`;
  const currentBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], sharedRoot);
  if (!currentBranch.ok || currentBranch.stdout.trim() !== target) {
    return { ok: false, reason: 'shared-not-target-branch' };
  }

  const fetch = runGit(['fetch', remote, target], sharedRoot);
  if (!fetch.ok) return { ok: false, reason: 'fetch-failed' };

  const ancestor = runGit(['merge-base', '--is-ancestor', 'HEAD', remoteRef], sharedRoot);
  if (!ancestor.ok) return { ok: false, reason: 'diverged-not-ff' };

  let merge = runGit(['merge', '--ff-only', remoteRef], sharedRoot);
  if (!merge.ok) {
    // Git refuses a fast-forward over locally modified tracked files even when
    // their bytes already match the incoming blob. Reconcile only those
    // content-identical files, then retry once. Real peer differences still
    // refuse and stay untouched.
    const status = runGit(['status', '--porcelain'], sharedRoot);
    const dirty = status.ok ? parsePorcelain(status.stdout) : [];
    let reconciled = 0;
    for (const entry of dirty) {
      if (entry.code.includes('?')) continue;
      const targetBlob = runGit(['rev-parse', `${remoteRef}:${entry.rel}`], sharedRoot);
      if (!targetBlob.ok) continue;
      const workingHash = runGit(['hash-object', '--', entry.rel], sharedRoot);
      if (!workingHash.ok) continue;
      if (targetBlob.stdout.trim() !== workingHash.stdout.trim()) continue;
      const checkout = runGit(['checkout', remoteRef, '--', entry.rel], sharedRoot);
      if (checkout.ok) reconciled += 1;
    }

    if (reconciled > 0) {
      merge = runGit(['merge', '--ff-only', remoteRef], sharedRoot);
    }
    if (!merge.ok) {
      log('[shared-sync] shared checkout fast-forward refused; leaving it as-is.');
      return { ok: false, reason: 'ff-refused' };
    }
  }

  return { ok: true };
}

module.exports = {
  fastForwardShared,
  parsePorcelain,
  runGitDefault,
};
