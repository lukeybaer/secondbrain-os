const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function repoRoot() {
  if (process.env.SECONDBRAIN_ROOT) return process.env.SECONDBRAIN_ROOT;
  if (fs.existsSync('/opt/secondbrain')) return '/opt/secondbrain';
  return path.resolve(__dirname, '..', '..');
}

function pythonCandidates() {
  return [process.env.PYTHON, 'python', 'python3'].filter(Boolean);
}

function runPython(args, opts = {}) {
  const root = opts.root || repoRoot();
  const script = path.join(root, 'scripts', 'graphiti-life-archive-db-export.py');
  let last = null;
  for (const py of pythonCandidates()) {
    const r = spawnSync(py, [script, ...args], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: opts.maxBuffer || 512 * 1024 * 1024,
      timeout: opts.timeoutMs || 180000,
      windowsHide: true,
    });
    if (!r.error && r.status === 0) return r.stdout || '';
    last = r.error ? r.error.message : `${py} exited ${r.status}: ${(r.stderr || '').slice(0, 500)}`;
  }
  throw new Error(last || 'python unavailable');
}

function lifeArchiveDbPath(root = repoRoot()) {
  return process.env.LIFE_ARCHIVE_DB || path.join(root, 'data', 'life-archive', 'life-archive.db');
}

function archiveLifetimeEvents(root, since, until, opts = {}) {
  const db = opts.db || lifeArchiveDbPath(root);
  if (!fs.existsSync(db)) return [];
  const args = ['--db', db, '--since', since, '--until', until || new Date().toISOString()];
  if (opts.max) args.push('--max', String(opts.max));
  const stdout = runPython(args, { root, timeoutMs: opts.timeoutMs, maxBuffer: opts.maxBuffer });
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function archiveLifetimeCounts(root, since, until, opts = {}) {
  const db = opts.db || lifeArchiveDbPath(root);
  if (!fs.existsSync(db)) {
    return {
      total: 0,
      eligible: 0,
      by_archive_source: {},
      min_reference_time: null,
      max_reference_time: null,
    };
  }
  const stdout = runPython(
    ['--db', db, '--since', since, '--until', until || new Date().toISOString(), '--count-only'],
    { root, timeoutMs: opts.timeoutMs, maxBuffer: 32 * 1024 * 1024 },
  );
  const line = stdout.split(/\r?\n/).filter(Boolean).pop();
  return line ? JSON.parse(line) : {
    total: 0,
    eligible: 0,
    by_archive_source: {},
    min_reference_time: null,
    max_reference_time: null,
  };
}

module.exports = {
  archiveLifetimeCounts,
  archiveLifetimeEvents,
  lifeArchiveDbPath,
};
