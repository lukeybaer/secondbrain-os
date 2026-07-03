'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_TTL_MS = 60 * 60 * 1000;

function normalizePath(p) {
  if (typeof p !== 'string' || p.length === 0) return '';
  let out = p.replace(/\\/g, '/');
  const msys = out.match(/^\/([a-zA-Z])\/(.*)$/);
  if (msys) out = msys[1] + ':/' + msys[2];
  if (/^[a-zA-Z]:/.test(out)) out = out[0].toLowerCase() + out.slice(1);
  return out.replace(/\/+$/, '');
}

function defaultLockPath(mainRoot) {
  const root = normalizePath(
    mainRoot || process.env.SECONDBRAIN_ROOT || path.join(os.homedir(), 'secondbrain'),
  );
  const slug =
    root
      .replace(/^[a-z]:\//i, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'secondbrain';
  return path.join(os.homedir(), '.secondbrain', `integration-session-${slug}.json`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function gitSafe(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

// SHA of local master and origin/master at a point in time. Read-only; used
// both to stamp the lease at open time and to re-read current state at
// close-out time. Returns '' for either ref that cannot be resolved (e.g. a
// synthetic repo with no origin remote yet) so callers degrade gracefully
// instead of throwing.
function readMasterShas(cwd) {
  return {
    localMasterSha: gitSafe(['rev-parse', 'master'], cwd) || '',
    originMasterSha: gitSafe(['rev-parse', 'origin/master'], cwd) || '',
  };
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function validateIntegrationSession({
  env = process.env,
  mainRoot,
  now = Date.now(),
  fsApi = fs,
} = {}) {
  if (env.SB_INTEGRATION_SESSION !== '1') {
    return { valid: false, reason: 'SB_INTEGRATION_SESSION is not set' };
  }
  const lockPath = env.SB_INTEGRATION_SESSION_LOCK || defaultLockPath(mainRoot);
  let lock;
  try {
    lock = JSON.parse(fsApi.readFileSync(lockPath, 'utf8'));
  } catch (e) {
    return { valid: false, reason: `integration lease missing or unreadable at ${lockPath}` };
  }
  const expectedRoot = normalizePath(mainRoot || lock.mainRoot || '');
  const lockRoot = normalizePath(lock.mainRoot || '');
  if (expectedRoot && lockRoot && expectedRoot !== lockRoot) {
    return { valid: false, reason: `integration lease is for ${lock.mainRoot}, not ${mainRoot}` };
  }
  const expiresAtMs = Date.parse(lock.expiresAt || '');
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
    return { valid: false, reason: 'integration lease expired' };
  }
  if (lock.pid && !pidAlive(lock.pid)) {
    return { valid: false, reason: `integration lease owner pid ${lock.pid} is not alive` };
  }
  return {
    valid: true,
    reason: `integration lease active for ${lock.reason || 'unspecified reason'}`,
    lock,
    lockPath,
  };
}

function createIntegrationSession({
  mainRoot,
  reason = 'integration',
  ttlMs = DEFAULT_TTL_MS,
  lockPath,
  cwd = process.cwd(),
  pid = process.pid,
  fsApi = fs,
  now = Date.now(),
} = {}) {
  const root = normalizePath(
    mainRoot || process.env.SECONDBRAIN_ROOT || path.join(os.homedir(), 'secondbrain'),
  );
  const file = lockPath || defaultLockPath(root);
  // Close-out accounting (W3d item 1): stamp the SHAs of local master and
  // origin/master as they stand AT LEASE-OPEN TIME. checkLeaseCloseout() later
  // re-reads current local master and walks the commits reachable from local
  // master but not from the RECORDED originMasterSha, i.e. everything that
  // landed on the shared checkout's local master since (or during) this lease
  // and never made it to origin. Read-only git calls; a repo with no origin
  // remote yet (e.g. a synthetic test repo before its first push) yields ''.
  const { localMasterSha, originMasterSha } = readMasterShas(cwd);
  const lease = {
    version: 1,
    mainRoot: root,
    cwd: normalizePath(cwd),
    pid,
    owner: process.env.USERNAME || process.env.USER || os.userInfo().username,
    reason,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    localMasterSha,
    originMasterSha,
  };
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  fsApi.writeFileSync(file, JSON.stringify(lease, null, 2) + '\n');
  return { lockPath: file, lease };
}

function clearIntegrationSession({ lockPath, mainRoot, fsApi = fs } = {}) {
  const file = lockPath || defaultLockPath(mainRoot);
  try {
    fsApi.unlinkSync(file);
    return { cleared: true, lockPath: file };
  } catch (e) {
    if (e && e.code === 'ENOENT')
      return { cleared: false, lockPath: file, reason: 'already absent' };
    throw e;
  }
}

// checkLeaseCloseout -- DETECTION ONLY, never blocks or mutates anything.
// Reads the lease lock (may already be cleared; caller can pass the lease
// record directly via `lease` if the lock file is gone) and re-checks: are
// there commits reachable from the CURRENT local master that are not
// reachable from the CURRENT origin/master? That is "stranded on the shared
// checkout, never landed" -- exactly the class of defect that sat invisible
// on the shared checkout since Jun 30 (4 commits) until this detector.
//
// Deliberately global, not lease-scoped: this reports EVERY commit currently
// stranded on local master, including ones that predate this lease (e.g. a
// PRIOR lease that never closed out). That is intentional -- the point is
// "is anything stranded right now", not "did THIS lease strand something".
// A lease that inherited pre-existing drift should still surface it so it
// gets landed, rather than being masked by scoping to originMasterSha at
// lease-open time. The recorded localMasterSha/originMasterSha stay on the
// lease record for audit trail (when did this lease open, against what),
// but the live git range is always the ground truth for what remains
// unlanded right now (Codex review finding, 2026-07-02).
function checkLeaseCloseout({ lockPath, mainRoot, lease, cwd, fsApi = fs } = {}) {
  let record = lease;
  if (!record) {
    const file = lockPath || defaultLockPath(mainRoot);
    record = readJson(file);
  }
  // Prefer an EXPLICIT caller-supplied cwd (the caller knows better than the
  // lease record, e.g. testing a moved checkout). Otherwise trust the lease's
  // OWN recorded cwd/mainRoot -- that is the repo the lease was actually
  // opened against. Only fall back to process.cwd() when neither the caller
  // nor the record says anything, so a --closeout invoked from an unrelated
  // directory does not silently check the wrong repo and report a false zero
  // (Codex review finding, 2026-07-02).
  const workCwd = cwd || record.cwd || record.mainRoot || process.cwd();
  // rev-list A..B lists commits reachable from B but not from A. We want
  // commits on the CURRENT local master that never reached origin, so use
  // origin/master..master read fresh (not the stale recorded SHA) -- the
  // recorded originMasterSha is retained on the lease for audit but the
  // closeout check always asks git for ground truth right now.
  const raw = gitSafe(['log', '--format=%H\t%s', 'origin/master..master'], workCwd);
  const strandedCommits = raw
    ? raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, ...rest] = line.split('\t');
          return { sha, subject: rest.join('\t') };
        })
    : [];
  return {
    count: strandedCommits.length,
    strandedCommits,
    lease: record,
  };
}

module.exports = {
  DEFAULT_TTL_MS,
  normalizePath,
  defaultLockPath,
  validateIntegrationSession,
  createIntegrationSession,
  clearIntegrationSession,
  checkLeaseCloseout,
  readMasterShas,
  readJson,
};
