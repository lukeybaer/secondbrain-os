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

/**
 * Does a dirty worktree entry stand in the way of an incoming file?
 * Porcelain reports an untracked DIRECTORY as `dir/`, which blocks every
 * incoming file beneath it, so directory entries match by prefix.
 */
function dirtyEntryCollides(rel, incoming) {
  if (rel.endsWith('/')) return incoming.some((f) => f.startsWith(rel));
  return incoming.includes(rel);
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
    // Nothing to promote. Dirt is somebody else's business: freshness is the
    // only thing this function owns.
    const current = { ok: true, reason: 'already-current', ahead, behind, synced: false };
    if (dirty.length > 0) current.dirty = dirty;
    return current;
  }

  // 2026-07-20. This used to refuse on ANY dirt, before even fetching. Git can
  // fast-forward a dirty tree fine when the dirty paths do not collide with the
  // incoming changes, so a single unrelated stray file (a runtime JSONL, an
  // editor scratch file) held every landed commit off the live hook path until
  // a human noticed. Refusing is correct only when the paths ACTUALLY collide.
  // Safety is unchanged: nothing is discarded, nothing is forced, and
  // `merge --ff-only` remains the backstop that refuses on its own if git
  // disagrees with our intersection.
  let dirtyNonColliding;
  if (dirty.length > 0) {
    const changed = runGit(['diff', '--name-only', `HEAD..${remoteRef}`], sharedRoot);
    if (!changed.ok) {
      // Cannot prove non-collision, so refuse. Fail closed on ExampleCos.
      return { ok: false, reason: 'dirty-shared-checkout', dirty, ahead, behind };
    }
    const incoming = String(changed.stdout || '')
      .split(/\r?\n/)
      .filter(Boolean);
    const collisions = dirty.filter((d) => dirtyEntryCollides(d.rel, incoming)).map((d) => d.rel);
    if (collisions.length > 0) {
      return { ok: false, reason: 'dirty-shared-checkout', dirty, collisions, ahead, behind };
    }
    dirtyNonColliding = dirty.map((d) => d.rel);
  }

  const merge = runGit(['merge', '--ff-only', remoteRef], sharedRoot);
  if (!merge.ok) return { ok: false, reason: 'ff-refused', ahead, behind };

  const result = { ok: true, reason: 'fast-forwarded', ahead, behind, synced: true };
  if (dirtyNonColliding) result.dirtyNonColliding = dirtyNonColliding;
  return result;
}

module.exports = {
  fastForwardShared,
  parsePorcelain,
  runGitDefault,
};
