'use strict';
//
// git-hygiene.js -- the single contract every git-cleanliness consumer reads.
//
// Implements the three-state model from
// dev-plans/git-hygiene-clean-branches-2026-06-13.html:
//   LANDED   = commits are in origin/master. A branch is safe to reap only when
//              its attached worktree is also clean, unlocked, and inactive.
//   PARKED   = intentional WIP, registered in the PARKED registry with a reason
//              and an expiry. Protected from all cleanup.
//   STRAY    = uncommitted/unmerged with no PARKED record. A defect. Needs a
//              decision (land / park / drop). The only thing cleanup acts on.
//   PROTECTED = codex/rescue* snapshots. Immutable evidence, never touched.
//
// Pure classification + a small atomic one-file-per-artifact registry + the
// cleanup guard. NOTHING here mutates branches or worktrees -- the janitor and
// the reap hook are the only writers, and they call assertSafeToClean() first.
//
// Registry lives under .claude/state/parked/ (gitignored runtime state, one JSON
// file per parked artifact so concurrent sessions never stomp a shared list).

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// codex/rescue-* snapshots are immutable evidence (feedback_rescue_snapshots_are_immutable.md).
const PROTECTED_PATTERNS = [/^codex\/rescue/i, /rescue-snapshot/i];

function isProtectedRef(ref) {
  return PROTECTED_PATTERNS.some((re) => re.test(ref));
}

// Every git call is wall-clock bounded. Dozens of concurrent sessions share
// this repo's one .git directory; under ref/lock contention a single read-only
// call (e.g. `branch --merged` in classifyGitState) has stalled for minutes
// while execFileSync blocked the event loop, turning seconds-long briefing
// builds and scoped test runs into 30+ minute apparent hangs. 45s is far above
// any healthy call. Override: SB_GIT_TIMEOUT_MS.
const DEFAULT_GIT_TIMEOUT_MS = 45_000;

function gitTimeoutMs() {
  const raw = Number.parseInt(process.env.SB_GIT_TIMEOUT_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GIT_TIMEOUT_MS;
}

function git(args, cwd) {
  const timeout = gitTimeoutMs();
  try {
    return execFileSync('git', args, {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      timeout,
    }).trim();
  } catch (err) {
    if (err && err.code === 'ETIMEDOUT') {
      const e = new Error(
        `git ${args.join(' ')} exceeded ${timeout}ms and was killed. ` +
          'Likely shared-.git lock/ref contention from concurrent sessions; ' +
          'retry, or raise SB_GIT_TIMEOUT_MS.',
      );
      e.code = 'ETIMEDOUT';
      e.cause = err;
      throw e;
    }
    throw err;
  }
}

// onTimeout: called (with the error) ONLY when the failure was a timeout kill,
// so callers can degrade to the fallback without silently fabricating a clean
// state from empty data (Codex review 2026-07-06). Non-timeout errors keep the
// original silent-fallback semantics (e.g. no origin/master in a bare test repo).
function gitSafe(args, cwd, fallback = '', onTimeout) {
  try {
    return git(args, cwd);
  } catch (err) {
    if (onTimeout && err && err.code === 'ETIMEDOUT') onTimeout(err);
    return fallback;
  }
}

function getRepoRoot(cwd) {
  return git(['rev-parse', '--show-toplevel'], cwd);
}

// ---------------------------------------------------------------------------
// PARKED registry: one atomic JSON file per artifact under .claude/state/parked/
// ---------------------------------------------------------------------------

function parkedDir(repoRoot) {
  return path.join(repoRoot, '.claude', 'state', 'parked');
}

function slugifyRef(ref) {
  return String(ref)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

// A parked record. `ref` is the durable handle: a branch name, a stash COMMIT
// SHA (never stash@{n} -- those indices shift), or the literal "working-tree".
function readParked(repoRoot) {
  const dir = parkedDir(repoRoot);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      rec._file = path.join(dir, f);
      out.push(rec);
    } catch {
      // skip malformed record, do not let one bad file blind the whole registry
    }
  }
  return out;
}

function isParkedRef(records, ref) {
  if (!ref) return false;
  return records.some((r) => r.ref === ref);
}

// Atomic write: temp file in the same dir, then rename. One writer per file id,
// so 5-15 concurrent sessions never collide.
function parkArtifact(repoRoot, record) {
  const dir = parkedDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const id = record.id || slugifyRef(record.ref || `park-${record.artifact || 'item'}`);
  const full = {
    id,
    artifact: record.artifact || 'branch', // branch | stash | working-tree
    ref: record.ref,
    project: record.project || '',
    reason: record.reason || '',
    ownerSession: record.ownerSession || '',
    created: record.created, // ISO date string, supplied by caller (no clock in lib)
    reviewBy: record.reviewBy || '', // expiry; empty = no expiry
  };
  if (!full.ref) throw new Error('parkArtifact requires a ref');
  if (!full.reason) throw new Error('parkArtifact requires a reason (exec summary of why parked)');
  const dest = path.join(dir, `${id}.json`);
  const tmp = path.join(dir, `.${id}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(full, null, 2));
  fs.renameSync(tmp, dest);
  return { ...full, _file: dest };
}

function removeParked(repoRoot, id) {
  const dest = path.join(parkedDir(repoRoot), `${id}.json`);
  try {
    fs.unlinkSync(dest);
    return true;
  } catch {
    return false;
  }
}

// Expired = reviewBy date is in the past. Caller passes `today` (YYYY-MM-DD) so
// the lib stays clock-free and tests are deterministic.
function isExpired(record, today) {
  return !!(record.reviewBy && today && record.reviewBy < today);
}

// ---------------------------------------------------------------------------
// Live-worktree lease. The spine-session-task.mjs hook already writes one
// spine-session-<id>.json per interactive session with status running/done and
// execution.cwd. A worktree with a live session must NEVER be reaped. We reuse
// that signal instead of inventing a second heartbeat system.
//   live = a spine-session task with status 'running' AND (if nowMs supplied)
//   an updatedAt within maxAgeHours -- a stale 'running' is a crashed session,
//   not a live one, so its worktree becomes reapable.
// nowMs is injected so the lib stays clock-free; omitting it is the safe default
// (every 'running' task counts as live).
// ---------------------------------------------------------------------------

function defaultTasksDir() {
  if (process.env.SECONDBRAIN_TASKS_DIR) return process.env.SECONDBRAIN_TASKS_DIR;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'secondbrain', 'data', 'tasks');
}

function readLiveWorktrees(opts = {}) {
  const dir = opts.tasksDir || defaultTasksDir();
  const nowMs = opts.nowMs;
  const maxAgeMs = (opts.maxAgeHours || 6) * 3600 * 1000;
  let files;
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('spine-session-') && f.endsWith('.json'));
  } catch {
    return new Set();
  }
  const live = new Set();
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (t.status !== 'running') continue;
      if (nowMs && t.updatedAt) {
        const age = nowMs - Date.parse(t.updatedAt);
        if (Number.isFinite(age) && age > maxAgeMs) continue; // stale -> crashed, not live
      }
      const cwd = t.execution && t.execution.cwd;
      if (cwd) live.add(path.resolve(cwd));
    } catch {
      // ignore malformed task file
    }
  }
  return live;
}

// ---------------------------------------------------------------------------
// The cleanup guard. The reap hook, the janitor, and any "clean up uncommitted
// stuff" command MUST call this before touching any ref. It refuses protected
// and parked refs. Mechanically enforced so a future "just force it all in"
// cannot blow past it.
// ---------------------------------------------------------------------------

function assertSafeToClean(repoRoot, ref, parkedRecords) {
  if (isProtectedRef(ref)) {
    throw new Error(`refuse: ${ref} is a protected rescue snapshot (immutable evidence)`);
  }
  const recs = parkedRecords || readParked(repoRoot);
  if (isParkedRef(recs, ref)) {
    throw new Error(`refuse: ${ref} is registered PARKED (intentional WIP, not cleanup fodder)`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Pure categorizer -- unit-testable without git.
// ---------------------------------------------------------------------------

function categorizeBranch({ name, merged, isCurrent, parked }) {
  if (isProtectedRef(name)) return 'protected';
  if (parked) return 'parked';
  if (isCurrent) return 'active'; // the checked-out branch, never reap/triage it
  if (merged) return 'landed'; // commits already in origin/master -> safe to reap
  return 'stray'; // ExampleCos unique commits, needs a decision
}

// Parse `git worktree list --porcelain` once so every consumer sees the lock
// state Git itself will enforce. A locked worktree is never "safe to clear"
// until an attended unlock decision is made.
function parseWorktreeList(raw) {
  const worktrees = [];
  const branchToWorktree = new Map();
  let current = null;

  const flush = () => {
    if (!current || !current.path) {
      current = null;
      return;
    }
    const worktree = {
      path: current.path,
      branch: current.branch || null,
      locked: Boolean(current.locked),
      lockReason: current.lockReason || '',
    };
    worktrees.push(worktree);
    if (worktree.branch) branchToWorktree.set(worktree.branch, worktree);
    current = null;
  };

  for (const line of String(raw || '').split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length), locked: false, lockReason: '' };
    } else if (!current) {
      continue;
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '');
    } else if (line === 'locked') {
      current.locked = true;
    } else if (line.startsWith('locked ')) {
      current.locked = true;
      current.lockReason = line.slice('locked '.length);
    } else if (line === '') {
      flush();
    }
  }
  flush();
  return { worktrees, branchToWorktree };
}

// Committed ancestry proves that a branch landed. It does not prove that its
// checked-out worktree has no later edits. Unreadable worktrees are unverified,
// never clean, so the dashboard cannot overstate what the janitor may remove.
function inspectWorktreeCleanliness(worktreePath, opts = {}) {
  if (!worktreePath) return { state: 'no_worktree', clean: true, known: true };
  try {
    const raw =
      typeof opts.probeWorktreeStatus === 'function'
        ? opts.probeWorktreeStatus(worktreePath)
        : git(['-C', worktreePath, 'status', '--porcelain'], opts.cwd);
    if (raw == null) return { state: 'unverified', clean: false, known: false };
    return String(raw).trim()
      ? { state: 'dirty', clean: false, known: true }
      : { state: 'clean', clean: true, known: true };
  } catch {
    return { state: 'unverified', clean: false, known: false };
  }
}

// ---------------------------------------------------------------------------
// classifyGitState -- the full snapshot. Core metadata is a handful of Git
// calls; attached landed worktrees are also checked so "safe to clear" remains honest.
// ---------------------------------------------------------------------------

function classifyGitState(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const today = opts.today || '';
  const repoRoot = getRepoRoot(cwd);
  const parked = readParked(repoRoot);
  const parkedRefs = new Set(parked.map((r) => r.ref));

  // Degradation ledger: every classifier call that TIMED OUT (vs merely
  // errored) is recorded here and returned as `degraded`, so consumers can
  // refuse to render a fabricated "clean" verdict from empty fallbacks.
  const degraded = [];
  const safe = (args, fallback) =>
    gitSafe(args, repoRoot, fallback, () => degraded.push(`git ${args.join(' ')}`));

  const currentBranch = safe(['rev-parse', '--abbrev-ref', 'HEAD'], 'HEAD');

  // master vs origin/master (the clean/synced check)
  let masterAhead = 0;
  let masterBehind = 0;
  const lr = safe(['rev-list', '--left-right', '--count', 'origin/master...master'], '');
  if (lr) {
    const m = lr.split(/\s+/).map((n) => parseInt(n, 10));
    masterBehind = m[0] || 0;
    masterAhead = m[1] || 0;
  }

  // Drift alarm (W3d item 2): commits that landed on the SHARED checkout's
  // local master but never reached origin/master are invisible until
  // something asks for them by name. masterAhead above already ExampleCos the
  // count; sharedMasterAheadOfOrigin additionally names each commit (sha +
  // subject) so the briefing consumer can render "N commits stranded on the
  // shared checkout, never landed: <subjects>" instead of a bare number. This
  // is the detector that let 4 commits sit invisible on the shared checkout
  // since Jun 30 -- the count existed in master.ahead, but nothing surfaced it
  // as a named, actionable defect.
  const strandedRaw = safe(['log', '--format=%h\t%s', 'origin/master..master'], '');
  const sharedMasterAheadCommits = strandedRaw
    ? strandedRaw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, ...rest] = line.split('\t');
          return { sha, subject: rest.join('\t') };
        })
    : [];

  // uncommitted edits in the main working tree
  const statusRaw = safe(['status', '--porcelain'], '');
  const uncommittedEdits = statusRaw
    ? statusRaw
        .split('\n')
        .filter(Boolean)
        .map((line) => ({
          // porcelain v1: cols 0-1 are the status, the path is everything from
          // col 2 onward (slice(2).trim() is robust to the 1 or 2 space gap and
          // to renamed "orig -> new" entries).
          status: line.slice(0, 2).trim(),
          file: line.slice(2).trim(),
        }))
    : [];

  // merged set (commits already in origin/master)
  const mergedRaw = safe(['branch', '--merged', 'origin/master', '--format=%(refname:short)'], '');
  const mergedSet = new Set(
    mergedRaw
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  // worktree map: branch -> worktree path
  const wtRaw = safe(['worktree', 'list', '--porcelain'], '');
  const { worktrees, branchToWorktree } = parseWorktreeList(wtRaw);

  // all local branches
  const branchRaw = safe(
    [
      'for-each-ref',
      '--format=%(refname:short)\t%(objectname:short)\t%(committerdate:short)\t%(contents:subject)',
      'refs/heads',
    ],
    '',
  );
  const branches = [];
  for (const line of branchRaw.split('\n').filter(Boolean)) {
    const [name, tip, date, ...rest] = line.split('\t');
    const subject = rest.join('\t');
    const parkedHit = parkedRefs.has(name);
    const merged = mergedSet.has(name);
    const isCurrent = name === currentBranch;
    const worktreeInfo = branchToWorktree.get(name) || null;
    branches.push({
      name,
      tip,
      date,
      subject,
      merged,
      isCurrent,
      parked: parkedHit,
      worktree: worktreeInfo ? worktreeInfo.path : null,
      worktreeLocked: Boolean(worktreeInfo && worktreeInfo.locked),
      worktreeLockReason: (worktreeInfo && worktreeInfo.lockReason) || '',
      category: categorizeBranch({ name, merged, isCurrent, parked: parkedHit }),
    });
  }

  // stashes (identify by SHA, not stash@{n})
  const stashRaw = safe(['stash', 'list', '--format=%H\t%gd\t%gs'], '');
  const stashes = stashRaw
    ? stashRaw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, slot, ...rest] = line.split('\t');
          return {
            sha,
            slot, // stash@{n} -- display only, do not act on it
            message: rest.join('\t'),
            parked: parkedRefs.has(sha),
          };
        })
    : [];

  // buckets for the card
  const protectedBranches = branches.filter((b) => b.category === 'protected');
  const parkedBranches = branches.filter((b) => b.category === 'parked');
  const landedBranches = branches.filter((b) => b.category === 'landed');
  const lockedLandedBranches = landedBranches.filter((b) => b.worktreeLocked);
  const inspectedLandedBranches = landedBranches
    .filter((b) => !b.worktreeLocked)
    .map((branch) => {
      const inspection = inspectWorktreeCleanliness(branch.worktree, {
        cwd: repoRoot,
        probeWorktreeStatus: opts.probeWorktreeStatus,
      });
      return { ...branch, worktreeState: inspection.state, worktreeClean: inspection.clean };
    });
  const reapableLandedBranches = inspectedLandedBranches.filter((b) => b.worktreeClean);
  const dirtyLandedBranches = inspectedLandedBranches.filter((b) => b.worktreeState === 'dirty');
  const unverifiedLandedBranches = inspectedLandedBranches.filter(
    (b) => b.worktreeState === 'unverified',
  );
  const strayBranches = branches.filter((b) => b.category === 'stray');

  const parkedStashes = stashes.filter((s) => s.parked);
  const strayStashes = stashes.filter((s) => !s.parked);

  return {
    repoRoot,
    currentBranch,
    today,
    degraded,
    master: { ahead: masterAhead, behind: masterBehind, clean: uncommittedEdits.length === 0 },
    sharedMasterAheadOfOrigin: {
      count: sharedMasterAheadCommits.length,
      commits: sharedMasterAheadCommits,
    },
    counts: {
      branches: branches.length,
      worktrees: worktrees.length,
      stashes: stashes.length,
      parkedRecords: parked.length,
      landedReapable: reapableLandedBranches.length,
      landedDirty: dirtyLandedBranches.length,
      landedUnverified: unverifiedLandedBranches.length,
      landedLocked: lockedLandedBranches.length,
      lockedWorktrees: worktrees.filter((w) => w.locked).length,
      stray: strayBranches.length,
      protected: protectedBranches.length,
      uncommittedEdits: uncommittedEdits.length,
    },
    parkedRecords: parked.map((r) => ({ ...r, expired: isExpired(r, today) })),
    buckets: {
      // PARKED: intentional, registered, protected
      parked: {
        records: parked.map((r) => ({ ...r, expired: isExpired(r, today) })),
        branches: parkedBranches,
        stashes: parkedStashes,
      },
      // STRAY needing a decision: unique commits / loose edits, NOT hand-triaged
      needsDecision: {
        branches: strayBranches,
        stashes: strayStashes,
        uncommittedEdits,
      },
      // LANDED leftovers: already in master, safe to reap
      safeToClear: { branches: reapableLandedBranches },
      // LANDED commits with later worktree edits: recover the edits before cleanup.
      dirtyLanded: { branches: dirtyLandedBranches },
      // A timed-out or unreadable worktree is not evidence of cleanliness.
      unverifiedLanded: { branches: unverifiedLandedBranches },
      // LOCKED LANDED: already in master but Git has an explicit lock. This is
      // not safe-cleanup work and must never be presented as auto-reapable.
      locked: { branches: lockedLandedBranches },
      // PROTECTED: rescue snapshots, untouchable
      protected: { branches: protectedBranches },
    },
    worktrees,
    branches,
    stashes,
  };
}

module.exports = {
  isProtectedRef,
  gitSafe,
  getRepoRoot,
  parkedDir,
  slugifyRef,
  readParked,
  isParkedRef,
  parkArtifact,
  removeParked,
  isExpired,
  assertSafeToClean,
  categorizeBranch,
  parseWorktreeList,
  inspectWorktreeCleanliness,
  classifyGitState,
  readLiveWorktrees,
  PROTECTED_PATTERNS,
};
