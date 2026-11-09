'use strict';

function normalizePath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
}

function overlaps(left, right) {
  const a = normalizePath(left);
  const b = normalizePath(right);
  return Boolean(a && b && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

function evaluatePathSafety({ remoteChangedPaths = [], dirtyTrackedPaths = [], untrackedPaths = [] } = {}) {
  const values = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
  const remote = [...new Set(values(remoteChangedPaths).map(normalizePath).filter(Boolean))];
  const tracked = [...new Set(values(dirtyTrackedPaths).map(normalizePath).filter(Boolean))];
  const untracked = [...new Set(values(untrackedPaths).map(normalizePath).filter(Boolean))];
  const trackedCollisions = remote.flatMap((remotePath) => tracked
    .filter((localPath) => overlaps(remotePath, localPath))
    .map((localPath) => ({ remote_path: remotePath, local_path: localPath })));
  const untrackedCollisions = remote.flatMap((remotePath) => untracked
    .filter((localPath) => overlaps(remotePath, localPath))
    .map((localPath) => ({ remote_path: remotePath, local_path: localPath })));
  return {
    remote_changed_paths: remote,
    dirty_tracked_paths: tracked,
    untracked_paths: untracked,
    tracked_collisions: trackedCollisions,
    untracked_collisions: untrackedCollisions,
    safe: trackedCollisions.length === 0 && untrackedCollisions.length === 0,
  };
}

// Windows PowerShell 5.1 prefixes piped stdin with a UTF-8 byte-order mark
// when $OutputEncoding is UTF-8, which JSON.parse rejects.
function parseInput(raw) {
  const text = String(raw);
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

if (require.main === module) {
  const input = parseInput(require('node:fs').readFileSync(0, 'utf8'));
  process.stdout.write(`${JSON.stringify(evaluatePathSafety(input))}\n`);
}

module.exports = { normalizePath, overlaps, evaluatePathSafety, parseInput };
