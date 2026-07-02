'use strict';
//
// land-gate.js -- Phase 2 of session isolation.
//
// Two jobs, both aimed at the same failure mode ("one unrelated red test
// freezes everyone, two sessions race master"):
//
//   1. affectedTestScope(changedFiles) -- pick the SMALL set of tests that the
//      changed files actually touch, plus a fast deterministic CORE guard set.
//      Never "run everything" (no '**/*'), because the full suite is
//      data-dependent and a single unrelated red test would block every land.
//
//   2. acquireLandLock / releaseLandLock -- a rename-based, TTL'd merge lock so
//      only one session pushes master at a time. A crashed holder cannot
//      deadlock the world: once its lock is older than the TTL, the next lander
//      steals it (recording itself as the new owner).
//
// Pure, dependency-free, clock-injectable so the spec is deterministic.

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 1. Affected-test selection
// ---------------------------------------------------------------------------

// The fast deterministic core: cheap, data-independent guards that must run on
// EVERY land regardless of what changed. These never touch the network or the
// live briefing data, so they can't be the flaky "unrelated red" that freezes
// everyone -- yet they still catch structural regressions (dead probes, etc).
const CORE_GUARDS = [
  'scripts/__tests__/no-dead-probes.test.js',
  'scripts/__tests__/core.test.js',
  // Tier-1 byte cap: memory/MEMORY.md maps to no sibling test, so without this
  // entry every land of a memory-index edit skipped the cap entirely (that is
  // how the index grew 22.7KB -> 27.2KB across 17 lands, 2026-06-20..06-30).
  'scripts/__tests__/memory-md-size.test.js',
];
const DEVOPS_RELEASE_TEST = 'scripts/__tests__/devops-release-core.test.js';
const PII_SCREEN_TEST = 'tests/pii-screen.spec.ts';

const DEVOPS_RELEASE_FILES = new Set([
  '.github/workflows/sync-to-public.yml',
  'dev-plans/core/devops-release.md',
  'dev-plans/core/devops-release.LESSONS.md',
  'memory/feedback_pii_screen_failure_is_mine_to_scrub.md',
  'scripts/render-core-components-html.js',
]);

const PUBLIC_SYNC_GATE_FILES = new Set([
  '.github/workflows/sync-to-public.yml',
  'data/agent/pii-allowlist.json',
  'data/agent/pii-denylist.json',
  'scripts/build-pii-denylist.js',
  'scripts/pii-llm-gate.js',
  'scripts/pii-ner-scan.py',
  'scripts/pii-screen.js',
  'scripts/simulate-public-sync.js',
  'tests/pii-screen.spec.ts',
]);

// Map a changed SOURCE file to the test file that exercises it.
// Returns null when the changed file is itself a test, a non-source file
// (docs, json, config), or has no derivable sibling test.
function siblingTestFor(file) {
  const f = file.replace(/\\/g, '/');

  // A changed test file IS its own scope.
  if (/(^|\/)__tests__\//.test(f) || /\.test\.[cm]?[jt]sx?$/.test(f)) {
    return f;
  }

  // scripts/lib/foo.js            -> scripts/__tests__/foo.test.js
  // scripts/foo.js                -> scripts/__tests__/foo.test.js
  let m = f.match(/^scripts\/(?:lib\/)?(.+)\.[cm]?js$/);
  if (m) {
    return `scripts/__tests__/${m[1]}.test.js`;
  }

  // src/<area>/foo.ts             -> src/<area>/__tests__/foo.test.ts
  // src/main/foo.ts               -> src/main/__tests__/foo.test.ts
  m = f.match(/^(src\/.*?)\/([^/]+)\.[cm]?tsx?$/);
  if (m) {
    const dir = m[1];
    const base = m[2];
    const ext = /\.tsx$/.test(f) ? 'tsx' : 'ts';
    return `${dir}/__tests__/${base}.test.${ext}`;
  }

  return null;
}

function isDevopsReleaseFile(file) {
  const f = String(file || '').replace(/\\/g, '/');
  return DEVOPS_RELEASE_FILES.has(f) || PUBLIC_SYNC_GATE_FILES.has(f);
}

function isPublicSyncGateFile(file) {
  const f = String(file || '').replace(/\\/g, '/');
  return PUBLIC_SYNC_GATE_FILES.has(f);
}

// affectedTestScope(changedFiles) -> de-duplicated array of test paths/globs.
// ALWAYS includes the core guards. NEVER returns '**/*'.
function affectedTestScope(changedFiles) {
  const scope = new Set(CORE_GUARDS);

  for (const file of changedFiles || []) {
    if (!file) continue;
    const sibling = siblingTestFor(file);
    if (sibling) {
      scope.add(sibling);
    }
    if (isDevopsReleaseFile(file)) {
      scope.add(DEVOPS_RELEASE_TEST);
    }
    if (isPublicSyncGateFile(file)) {
      scope.add(PII_SCREEN_TEST);
    }
  }

  return Array.from(scope);
}

// ---------------------------------------------------------------------------
// 2. Rename-based merge lock
// ---------------------------------------------------------------------------

const LOCK_NAME = 'land.lock';
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes -- generous upper bound on a land.

function lockPath(dir) {
  return path.join(dir, LOCK_NAME);
}

function readLockMeta(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Try to plant the lock by atomically renaming a unique temp file onto the
// canonical lock path. rename() onto an existing path is allowed (it would
// clobber), so we guard the "already held" case with an exclusive-create
// (wx) write of a sentinel first; the rename is the actual commit. The unique
// temp name means two racing acquirers never collide on the temp itself.
function plantLock(dir, payload, token) {
  const file = lockPath(dir);
  // The token can carry a sessionId (e.g. a branch name like "feat/foo") that
  // contains path separators, so sanitize it for use as a filename component.
  // The full, unmodified token still lives inside the JSON payload for matching.
  const safe = `${process.pid}.${token}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  const tmp = path.join(dir, `.land.lock.${safe}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ ...payload, token }, null, 2));
  try {
    // Exclusive create of the canonical path: succeeds only if no lock exists.
    // This is the atomic gate -- the first writer wins, the loser's wx throws.
    const fd = fs.openSync(file, 'wx');
    fs.closeSync(fd);
    // We own it: move our fully-written payload into place.
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    if (err && err.code === 'EEXIST') return false; // someone else holds it
    throw err;
  }
}

// acquireLandLock(dir, sessionId, opts?)
//   opts: { nowMs?, ttlMs? }  -- nowMs makes the clock injectable for tests.
// Returns { acquired, token? }.
//   - No lock present            -> acquire, return acquired:true + token.
//   - Lock present, NOT stale    -> acquired:false.
//   - Lock present, STALE (its acquiredAtMs + ttlMs < nowMs) -> steal it,
//     recording THIS session/pid/timestamp as the new owner, acquired:true.
function acquireLandLock(dir, sessionId, opts = {}) {
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : DEFAULT_TTL_MS;
  const token = `${sessionId}-${nowMs}-${Math.random().toString(36).slice(2, 10)}`;
  const payload = {
    sessionId,
    pid: process.pid,
    acquiredAtMs: nowMs,
    ttlMs,
  };

  if (plantLock(dir, payload, token)) {
    return { acquired: true, token };
  }

  // A lock already exists. Is it stale?
  const existing = readLockMeta(lockPath(dir));
  if (existing && typeof existing.acquiredAtMs === 'number') {
    const existingTtl = typeof existing.ttlMs === 'number' ? existing.ttlMs : ttlMs;
    const expired = existing.acquiredAtMs + existingTtl < nowMs;
    if (expired) {
      // Crashed/abandoned holder. Steal it: overwrite with our metadata so the
      // new owner is recorded (pid + sessionId + timestamp), no deadlock.
      fs.writeFileSync(
        lockPath(dir),
        JSON.stringify({ ...payload, token, stolenFrom: existing.sessionId || null }, null, 2),
      );
      return { acquired: true, token };
    }
  } else if (!existing) {
    // Lock file vanished between the failed plant and this read (the holder
    // released). Retry once -- the path is now free.
    if (plantLock(dir, payload, token)) {
      return { acquired: true, token };
    }
  }

  return { acquired: false };
}

// releaseLandLock(dir, token) -> removes the lock only if the token matches the
// current holder. A mismatched token is a no-op (we don't yank someone else's
// freshly-stolen lock). Returns true if we removed it.
function releaseLandLock(dir, token) {
  const file = lockPath(dir);
  const existing = readLockMeta(file);
  if (existing && existing.token === token) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
    return true;
  }
  return false;
}

module.exports = {
  affectedTestScope,
  acquireLandLock,
  releaseLandLock,
  // exported for reuse/testing
  CORE_GUARDS,
  DEVOPS_RELEASE_TEST,
  PII_SCREEN_TEST,
  siblingTestFor,
  isDevopsReleaseFile,
  isPublicSyncGateFile,
};
