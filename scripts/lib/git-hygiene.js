'use strict';
//
// git-hygiene.js -- the single contract every git-cleanliness consumer reads.
//
// Implements the three-state model from
// dev-plans/git-hygiene-clean-branches-2026-06-13.html:
//   LANDED   = commits are in origin/master, by ancestry or by patch content
//              (`git cherry origin/master <branch>` shows no `+` line, which is
//              how a land.js rebase or squash looks to git). A branch is safe
//              to reap only when its attached worktree is also clean,
//              unlocked, and inactive.
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
const { registryDirForOptions } = require('./desktop-session-registry.js');
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

function normalizeWorktreePath(cwd) {
  const resolved = path.resolve(cwd);
  if (process.platform !== 'win32') return resolved;
  // Codex records Windows cwd values with the extended-length prefix while
  // `git worktree list --porcelain` emits an ordinary drive path. Normalize
  // both spellings before the janitor compares its live-worktree Set.
  const ordinary = resolved.startsWith('\\\\?\\UNC\\')
    ? `\\\\${resolved.slice('\\\\?\\UNC\\'.length)}`
    : resolved.startsWith('\\\\?\\') ? resolved.slice('\\\\?\\'.length) : resolved;
  return ordinary.toLowerCase();
}

function isLiveWorktree(liveWorktrees, worktreePath) {
  if (!worktreePath || !liveWorktrees) return false;
  const expected = normalizeWorktreePath(worktreePath);
  // Callers may supply a pre-existing Set (for example, the apply-time
  // recheck). Normalize both sides so Windows spelling/case cannot weaken a
  // lease, while normalizeWorktreePath remains case-sensitive on Linux.
  return [...liveWorktrees].some((claimed) => normalizeWorktreePath(claimed) === expected);
}

function readLiveWorktrees(opts = {}) {
  const dir = opts.tasksDir || defaultTasksDir();
  // Pass only explicit options through. Supplying the resolved default legacy
  // directory would bypass SECONDBRAIN_SESSION_REGISTRY_DIR and diverge from
  // the desktop-session writer's canonical resolution. An explicit tasksDir
  // deliberately carries its paired registry for isolated callers and tests.
  const registryOptions = {};
  if (opts.registryDir) registryOptions.registryDir = opts.registryDir;
  if (opts.tasksDir) registryOptions.tasksDir = opts.tasksDir;
  const registryDir = registryDirForOptions(registryOptions);
  const nowMs = opts.nowMs;
  const maxAgeMs = (opts.maxAgeHours || 6) * 3600 * 1000;
  const live = new Set();
  for (const recordDir of [dir, registryDir]) {
    let files;
    try { files = fs.readdirSync(recordDir).filter((f) => f.startsWith('spine-session-') && f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
    try {
      // Desktop task stores may serialize UTF-8 JSON with a BOM. It is still a
      // valid task record, not a reason to silently drop its live-worktree lease.
      const raw = fs.readFileSync(path.join(recordDir, f), 'utf8').replace(/^\uFEFF/, '');
      const t = JSON.parse(raw);
      if (t.status !== 'running') continue;
      if (nowMs && t.updatedAt) {
        const age = nowMs - Date.parse(t.updatedAt);
        if (Number.isFinite(age) && age > maxAgeMs) continue; // stale -> crashed, not live
      }
      const cwd = t.execution && t.execution.cwd;
      if (cwd) live.add(normalizeWorktreePath(cwd));
    } catch {
      // ignore malformed task file
    }
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
  return 'stray'; // carries unique commits, needs a decision
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
    if (!String(raw).trim()) return { state: 'clean', clean: true, known: true };
    // Porcelain v1 unmerged codes: DD AU UD UA DU AA UU.
    const conflicted = String(raw)
      .split('\n')
      .some((line) => /^(DD|AU|UD|UA|DU|AA|UU) /.test(line));
    return { state: conflicted ? 'conflicted' : 'dirty', clean: false, known: true };
  } catch {
    return { state: 'unverified', clean: false, known: false };
  }
}

// A session lease is an ownership proof, not cleanup metadata. A branch may
// already be landed and its worktree may currently be clean, but it is still
// active until the owning session finishes. Keep it visible without offering it
// to the janitor or presenting it as safe cleanup.
function classifyLandedWorktreeSafety(landedBranches, opts = {}) {
  const liveWorktrees = opts.liveWorktrees || new Set();
  const isLive = (worktreePath) =>
    isLiveWorktree(liveWorktrees, worktreePath);
  const withLeaseState = landedBranches.map((branch) => ({
    ...branch,
    worktreeLive: isLive(branch.worktree),
  }));
  const lockedLandedBranches = withLeaseState.filter((branch) => branch.worktreeLocked);
  const liveLandedBranches = withLeaseState.filter(
    (branch) => !branch.worktreeLocked && branch.worktreeLive,
  );
  const inspectedLandedBranches = withLeaseState
    .filter((branch) => !branch.worktreeLocked && !branch.worktreeLive)
    .map((branch) => {
      const inspection = inspectWorktreeCleanliness(branch.worktree, {
        cwd: opts.cwd,
        probeWorktreeStatus: opts.probeWorktreeStatus,
      });
      return { ...branch, worktreeState: inspection.state, worktreeClean: inspection.clean };
    });
  return {
    lockedLandedBranches,
    liveLandedBranches,
    reapableLandedBranches: inspectedLandedBranches.filter((branch) => branch.worktreeClean),
    dirtyLandedBranches: inspectedLandedBranches.filter(
      (branch) => branch.worktreeState === 'dirty' || branch.worktreeState === 'conflicted',
    ),
    unverifiedLandedBranches: inspectedLandedBranches.filter(
      (branch) => branch.worktreeState === 'unverified',
    ),
  };
}

// ---------------------------------------------------------------------------
// Patch-content landed detection. land.js rebases or squashes a session branch
// before the fast-forward push, so the branch's own commits are never ancestors
// of origin/master and `branch --merged` calls them unmerged forever.
// `git cherry origin/master <ref>` marks a commit `-` when an equivalent patch
// is already upstream and `+` when it is not; no `+` line means every change
// reached master. A merge commit the branch carries that master does not is
// never equivalent: its conflict resolution has no single upstream patch to
// match, so cherry can report clean while the merged tree differs (Codex
// review 2026-10-24). Returns true/false, or null when git could not answer
// (timeout, missing ref), so an unknown is never treated as landed.
// ---------------------------------------------------------------------------

function isPatchEquivalentToMaster(repoRoot, ref, opts = {}) {
  try {
    const merges =
      typeof opts.merges === 'function'
        ? opts.merges(ref)
        : git(['rev-list', '--merges', `origin/master..${ref}`], repoRoot);
    if (String(merges || '').trim()) return false;
    const out =
      typeof opts.cherry === 'function'
        ? opts.cherry(ref)
        : git(['cherry', 'origin/master', ref], repoRoot);
    return !String(out || '')
      .split('\n')
      .some((line) => line.startsWith('+'));
  } catch (err) {
    if (opts.onError) opts.onError(err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Retire ledger reader. scripts/git-branch-retire.js owns the writes. The
// snapshot carries what the briefing card needs (last run time, which gate held
// each skipped item, what was archived where) because the card renders on a
// host with no working git tree.
// ---------------------------------------------------------------------------

const RETIRE_S3_BUCKET = 'ExampleCo-secondbrain-backups';
const RETIRE_S3_PREFIX = 'git-archive/branches';

function defaultRetireDataDir() {
  if (process.env.SECONDBRAIN_DATA_DIR) return path.resolve(process.env.SECONDBRAIN_DATA_DIR);
  if (process.platform !== 'win32') return '/opt/secondbrain/data';
  // The PC capability worker runs without APPDATA. Fall back to the same
  // Roaming folder the card producers write to, or the snapshot reads no
  // ledger and paints the retire as never run (#b 2026-10-25).
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'secondbrain', 'data');
}

function readRetireStatus(opts = {}) {
  const dataDir = opts.dataDir || defaultRetireDataDir();
  const ledger = path.join(dataDir, 'git-archive', 'retire-ledger.jsonl');
  const nowMs = opts.nowMs || Date.now();
  const location = {
    s3: `s3://${RETIRE_S3_BUCKET}/${RETIRE_S3_PREFIX}`,
    disk: 'git-archive/branches under the data directory',
  };
  let text;
  try {
    text = fs.readFileSync(ledger, 'utf8');
  } catch {
    return {
      ledgerPresent: false,
      lastRunAt: null,
      lastRun: null,
      heldBy: {},
      archivedByBranch: {},
      retiredTotal: 0,
      retiredLast7Days: 0,
      location,
    };
  }
  const rows = text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  let lastRun = null;
  let newestAny = 0;
  const retiredAt = new Map();
  const archivedRows = [];
  for (const r of rows) {
    const at = Date.parse(r.at);
    if (Number.isFinite(at)) newestAny = Math.max(newestAny, at);
    if (r.stage === 'run' && Number.isFinite(at) && (!lastRun || at >= Date.parse(lastRun.at))) lastRun = r;
    else if (r.stage === 'retired') retiredAt.set(r.id, at);
    else if (r.stage === 'archived') archivedRows.push(r);
  }
  // Ledgers written before run rows existed: the newest row of any stage is the
  // best evidence that retire ran at all.
  const lastRunAt = lastRun ? lastRun.at : newestAny ? new Date(newestAny).toISOString() : null;
  const heldBy = {};
  if (lastRun && lastRun.skipped) {
    for (const [gate, refs] of Object.entries(lastRun.skipped)) {
      for (const ref of Array.isArray(refs) ? refs : []) heldBy[ref] = gate;
    }
  }
  // Archives of work that still exists (archived, not yet removed).
  const archivedByBranch = {};
  for (const r of archivedRows) {
    if (!r.branch || retiredAt.has(r.id)) continue;
    archivedByBranch[r.branch] = {
      id: r.id,
      at: r.at,
      tip: r.tip,
      worktree: r.worktree || null,
      hasUncommittedSnapshot: Boolean(r.uncommittedSnapshot),
      s3: (r.bundle && r.bundle.s3) || (r.tarball && r.tarball.s3) || null,
    };
  }
  const retiredTimes = [...retiredAt.values()].filter(Number.isFinite);
  return {
    ledgerPresent: true,
    lastRunAt,
    lastRun: lastRun
      ? {
          at: lastRun.at,
          retirable: lastRun.retirable ?? null,
          attempts: lastRun.attempts ?? null,
          retired: lastRun.retired ?? null,
          skipped: lastRun.skipped || {},
        }
      : null,
    heldBy,
    archivedByBranch,
    retiredTotal: retiredAt.size,
    retiredLast7Days: retiredTimes.filter((t) => nowMs - t < 7 * 24 * 3600 * 1000).length,
    location,
  };
}

// An archive covers a branch only while it still sits at the archived tip (and,
// for edits in a worktree, in that same worktree).
function archiveFor(branch, retireStatus) {
  const rec = retireStatus && retireStatus.archivedByBranch && retireStatus.archivedByBranch[branch.name];
  if (!rec || !rec.tip || !String(rec.tip).startsWith(branch.tip || '\0')) return null;
  if (
    branch.worktree &&
    rec.worktree &&
    normalizeWorktreePath(rec.worktree) !== normalizeWorktreePath(branch.worktree)
  ) {
    return null;
  }
  return rec;
}

// ---------------------------------------------------------------------------
// classifyGitState -- the full snapshot. Core metadata is a handful of Git
// calls; attached landed worktrees are checked so "safe to clear" remains honest.
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
  // something asks for them by name. masterAhead above already carries the
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

  // Patch-equivalent branches (landed through a land.js rebase or squash) are
  // landed too. Checked only for refs `--merged` did not settle; a timeout is
  // recorded as degradation and leaves the branch unmerged.
  const patchLanded = new Set();
  if (!opts.skipPatchEquivalence) {
    const unsettled = safe(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], '')
      .split('\n')
      .map((n) => n.trim())
      .filter(
        (n) =>
          n && !mergedSet.has(n) && !isProtectedRef(n) && !parkedRefs.has(n) && n !== currentBranch,
      );
    for (const name of unsettled) {
      const eq = isPatchEquivalentToMaster(repoRoot, name, {
        cherry: opts.cherry,
        onError: (err) => {
          if (err && err.code === 'ETIMEDOUT') degraded.push(`git cherry origin/master ${name}`);
        },
      });
      if (eq === true) patchLanded.add(name);
    }
  }
  const retire = opts.retireStatus || readRetireStatus({ dataDir: opts.dataDir, nowMs: opts.nowMs });

  // worktree map: branch -> worktree path
  const wtRaw = safe(['worktree', 'list', '--porcelain'], '');
  const { worktrees, branchToWorktree } = parseWorktreeList(wtRaw);
  const liveWorktrees =
    opts.liveWorktrees ||
    readLiveWorktrees({
      tasksDir: opts.tasksDir,
      nowMs: opts.nowMs || Date.now(),
      maxAgeHours: opts.maxAgeHours,
    });

  // all local branches
  const branchRaw = safe(
    [
      'for-each-ref',
      '--format=%(refname:short)\t%(objectname:short)\t%(committerdate:short)\t%(committerdate:iso-strict)\t%(contents:subject)',
      'refs/heads',
    ],
    '',
  );
  const branches = [];
  for (const line of branchRaw.split('\n').filter(Boolean)) {
    const [name, tip, date, committedAt, ...rest] = line.split('\t');
    const subject = rest.join('\t');
    const parkedHit = parkedRefs.has(name);
    const merged = mergedSet.has(name) || patchLanded.has(name);
    const landedBy = mergedSet.has(name) ? 'ancestor' : patchLanded.has(name) ? 'patch-equivalent' : null;
    const isCurrent = name === currentBranch;
    const worktreeInfo = branchToWorktree.get(name) || null;
    branches.push({
      name,
      tip,
      date,
      committedAt,
      subject,
      merged,
      landedBy,
      isCurrent,
      parked: parkedHit,
      worktree: worktreeInfo ? worktreeInfo.path : null,
      worktreeLocked: Boolean(worktreeInfo && worktreeInfo.locked),
      worktreeLockReason: (worktreeInfo && worktreeInfo.lockReason) || '',
      category: categorizeBranch({ name, merged, isCurrent, parked: parkedHit }),
    });
  }

  // Per-branch evidence the card needs: the retire gate that last held it, a
  // verified archive of its current tip, and (stray work only; landed work is
  // inspected below) whether its worktree carries edits.
  for (const b of branches) {
    if (retire.heldBy && retire.heldBy[b.name]) b.heldBy = retire.heldBy[b.name];
    const archive = archiveFor(b, retire);
    if (archive) b.archive = archive;
    if (b.category === 'stray' && b.worktree) {
      b.worktreeLive = isLiveWorktree(liveWorktrees, b.worktree);
      b.worktreeState = inspectWorktreeCleanliness(b.worktree, {
        cwd: repoRoot,
        probeWorktreeStatus: opts.probeWorktreeStatus,
      }).state;
    }
  }

  // stashes (identify by SHA, not stash@{n})
  const stashRaw = safe(['stash', 'list', '--format=%H\t%gd\t%cs\t%cI\t%gs'], '');
  const stashes = stashRaw
    ? stashRaw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, slot, date, committedAt, ...rest] = line.split('\t');
          return {
            sha,
            slot, // stash@{n} -- display only, do not act on it
            date,
            committedAt,
            message: rest.join('\t'),
            parked: parkedRefs.has(sha),
          };
        })
    : [];

  // buckets for the card
  const protectedBranches = branches.filter((b) => b.category === 'protected');
  const parkedBranches = branches.filter((b) => b.category === 'parked');
  const landedBranches = branches.filter((b) => b.category === 'landed');
  const {
    lockedLandedBranches,
    liveLandedBranches,
    reapableLandedBranches,
    dirtyLandedBranches,
    unverifiedLandedBranches,
  } = classifyLandedWorktreeSafety(landedBranches, {
    liveWorktrees,
    cwd: repoRoot,
    probeWorktreeStatus: opts.probeWorktreeStatus,
  });
  const strayBranches = branches.filter((b) => b.category === 'stray');

  const parkedStashes = stashes.filter((s) => s.parked);
  const strayStashes = stashes.filter((s) => !s.parked);

  return {
    repoRoot,
    currentBranch,
    today,
    generatedAt: new Date(opts.nowMs || Date.now()).toISOString(),
    retire,
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
      landedLive: liveLandedBranches.length,
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
      // A live session owns this landed worktree. It is informational, not a
      // cleanup candidate, until the session completes or its lease expires.
      activeLanded: { branches: liveLandedBranches },
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
  normalizeWorktreePath,
  isLiveWorktree,
  classifyLandedWorktreeSafety,
  classifyGitState,
  isPatchEquivalentToMaster,
  readRetireStatus,
  defaultRetireDataDir,
  archiveFor,
  RETIRE_S3_BUCKET,
  RETIRE_S3_PREFIX,
  readLiveWorktrees,
  PROTECTED_PATTERNS,
};
