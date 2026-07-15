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
} = {}) {
  if (!sharedRoot) throw new Error('fastForwardShared: sharedRoot is required');

  const remoteRef = `${remote}/${target}`;
  const currentBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], sharedRoot);
  if (!currentBranch.ok || currentBranch.stdout.trim() !== target) {
    return { ok: false, reason: 'shared-not-target-branch' };
  }

  const status = runGit(['status', '--porcelain'], sharedRoot);
  if (!status.ok) return { ok: false, reason: 'status-failed' };
  const dirty = parsePorcelain(status.stdout);
  if (dirty.length > 0) {
    return { ok: false, reason: 'dirty-shared-checkout', dirty };
  }

  const fetch = runGit(['fetch', remote, target], sharedRoot);
  if (!fetch.ok) return { ok: false, reason: 'fetch-failed' };

  const counts = runGit(['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`], sharedRoot);
  if (!counts.ok) return { ok: false, reason: 'relation-failed' };
  const [aheadRaw, behindRaw] = counts.stdout.trim().split(/\s+/);
  const ahead = Number.parseInt(aheadRaw || '0', 10) || 0;
  const behind = Number.parseInt(behindRaw || '0', 10) || 0;
  if (ahead > 0 && behind > 0) {
    return { ok: false, reason: 'diverged-not-ff', ahead, behind };
  }
  if (ahead > 0) {
    return { ok: false, reason: 'shared-ahead-of-target', ahead, behind };
  }
  if (behind === 0) {
    return { ok: true, reason: 'already-current', ahead, behind, synced: false };
  }

  const merge = runGit(['merge', '--ff-only', remoteRef], sharedRoot);
  if (!merge.ok) return { ok: false, reason: 'ff-refused', ahead, behind };

  return { ok: true, reason: 'fast-forwarded', ahead, behind, synced: true };
}

module.exports = {
  fastForwardShared,
  parsePorcelain,
  runGitDefault,
};
