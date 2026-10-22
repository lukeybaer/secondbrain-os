'use strict';
//
// git-janitor.js -- the BACKSTOP reaper for leftover session branches/worktrees.
//
// It is deliberately conservative (Codex review 2026-06-13):
//   - DRY-RUN by default. It prints/writes a manifest and deletes NOTHING unless
//     --apply is passed. First real runs should stay dry-run until the manifest
//     looks right.
//   - CAPPED. --apply reaps at most --cap=N (default 20) per run, never 141 in
//     one pass, so a logic bug has a small blast radius.
//   - SAFE PRIMITIVES ONLY. `git worktree remove` (no --force) refuses a dirty
//     worktree. A final `merge-base --is-ancestor <branch> origin/master` check
//     precedes the local branch delete, so an upstream tracking ref can never
//     make an already-landed branch look unsafe or cause a forced delete of
//     unmerged work. We never rm -rf a directory.
//   - HARD SKIPS: permanent branches (master/main), protected (codex/rescue*),
//     parked (registry), the checked-out branch, unmerged branches, worktrees
//     with a live session lease, dirty worktrees, and all stashes.
//     assertSafeToClean() plus assertNotPermanentBranch() are the last gates.
//
// The dangerous object is the worktree DIRECTORY (it can hold un-saved work),
// not the merged branch ref -- so we only remove a worktree we have confirmed is
// both inactive (no live lease) and clean.
//
// See dev-plans/git-hygiene-clean-branches-2026-06-13.html.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const gh = require('./lib/git-hygiene');
const datedLedger = require('./lib/dated-jsonl-ledger.js');

const PERMANENT_BRANCHES = new Set(['master', 'main']);

function isPermanentBranch(branch) {
  const normalized = String(branch || '')
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, '');
  return PERMANENT_BRANCHES.has(normalized);
}

function assertNotPermanentBranch(branch) {
  if (isPermanentBranch(branch)) {
    throw new Error(`refuse: ${branch} is a permanent integration branch`);
  }
  return true;
}

// Wall-clock bounded like git-hygiene's helper: the janitor runs from the Stop
// hook and health self-heal against the shared .git, so an unbounded call under
// ref/lock contention would hang every stopping session. 120s default (worktree
// remove deletes real directories, slower than the read-only classifier calls);
// same SB_GIT_TIMEOUT_MS override. Every mutating call site is inside a
// per-item try/catch, so a timeout skips that item and the janitor moves on.
function janitorTimeoutMs() {
  const raw = Number.parseInt(process.env.SB_GIT_TIMEOUT_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

// Stop-hook wall-clock budget for the branch-scan loop in buildManifest
// (distinct from janitorTimeoutMs, which bounds each individual `git`
// subprocess call). The Stop hook wires this script with a 15000ms hook
// timeout (scripts/claude-hooks/hook-boundary-manifest.json). classifyGitState
// alone runs ~3s but "starves under concurrent multi-session git/disk load"
// (see git-janitor.test.js); on top of that, isWorktreeClean() below spawns
// one `git status` subprocess per landed-and-otherwise-eligible branch -- the
// 2026-09-24 instruction audit measured 69 such candidates pushing the total
// scan to ~11-12s even on an otherwise idle box, dangerously close to the
// hook ceiling. Losing that race gets the process hard-killed mid-scan, which
// the hook runner reports as a bare "Command failed" with no manifest and no
// progress at all. A self-imposed budget safely under the hook ceiling lets
// the scan stop EARLY instead and exit 0 with an honest partial manifest --
// the untouched branches are simply picked up on the next Stop hook or
// health-self-heal pass, both of which run far more often than once.
const DEFAULT_SCAN_BUDGET_MS = 10_000;
function resolveScanBudgetMs(raw) {
  if (raw === null) return null; // explicit opt-out (e.g. an unattended full sweep)
  if (raw != null) return raw;
  const envRaw = Number.parseInt(process.env.SB_GIT_JANITOR_SCAN_BUDGET_MS || '', 10);
  return Number.isFinite(envRaw) && envRaw > 0 ? envRaw : DEFAULT_SCAN_BUDGET_MS;
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    timeout: janitorTimeoutMs(),
  }).trim();
}

function isWorktreeClean(wtPath) {
  try {
    return git(['status', '--porcelain'], wtPath) === '';
  } catch {
    return false; // cannot tell -> treat as not clean, skip
  }
}

// A clean worktree can still be owned by a live process whose cwd is inside
// it. Linux exposes that ownership in /proc. The ordinary janitor preserves
// its cross-platform behavior, while storage-pressure maintenance enables the
// strict proof and refuses cleanup if same-user process ownership is unreadable.
function readSameUserProcessCwds({
  procRoot = '/proc',
  fsApi = fs,
  uid = typeof process.getuid === 'function' && process.getuid() !== 0 ? process.getuid() : null,
} = {}) {
  if (process.platform !== 'linux') return { known: false, cwds: new Set(), scope: 'unavailable' };
  let pids;
  try {
    pids = fsApi.readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch {
    return { known: false, cwds: new Set() };
  }
  const cwds = new Set();
  for (const pid of pids) {
    let status;
    try {
      status = fsApi.readFileSync(path.join(procRoot, pid, 'status'), 'utf8');
    } catch {
      continue; // exited or belongs to a kernel thread
    }
    const uidMatch = String(status).match(/^Uid:\s+(\d+)/m);
    if (!uidMatch || (uid != null && Number(uidMatch[1]) !== Number(uid))) continue;
    try {
      cwds.add(path.resolve(fsApi.readlinkSync(path.join(procRoot, pid, 'cwd'))));
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      return { known: false, cwds };
    }
  }
  return { known: true, cwds, scope: uid == null ? 'all-processes' : `uid:${uid}` };
}

function processOwnsWorktree(worktree, cwdProof) {
  if (!worktree || !cwdProof || !cwdProof.known) return false;
  const root = path.resolve(worktree);
  const prefix = `${root}${path.sep}`;
  return [...cwdProof.cwds].some((cwd) => cwd === root || cwd.startsWith(prefix));
}

// PACKET C (item 2, 2026-09-01): the receipts ledger this proof reads split
// into a per-briefing-date directory (scripts/lib/dated-jsonl-ledger.js).
// COORDINATOR_PROOF_LOOKBACK_DAYS bounds how many dated files a directory
// target unions -- generous enough to span a multi-day resumable repair (the
// same class of gap findResumableLandedRepair's tests exercise, 07-22 to
// 07-26) while staying far short of a true unbounded scan.
const COORDINATOR_PROOF_LOOKBACK_DAYS = 14;
const COORDINATOR_PROOF_MAX_BYTES = 32 * 1024 * 1024;

function readBoundedTailText(file, maxBytes = COORDINATOR_PROOF_MAX_BYTES) {
  const stat = fs.statSync(file); // throws on missing/unreadable; caller decides how to treat that
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(stat.size - start);
  fs.readSync(fd, buffer, 0, buffer.length, start);
  fs.closeSync(fd);
  let text = buffer.toString('utf8');
  if (start > 0) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
  return text;
}

// Folds every JSONL row in `text` into `pending` IN PLACE, in file order
// (oldest line first), exactly the single-file scan this replaces: a
// pending row adds the worktree, an explicitly-settled row removes it,
// anything unresolved or unrecognized fails closed by adding it. Returns
// {ok:false} the instant a line fails to parse, mirroring the original
// "one corrupt line makes the WHOLE proof unknown" behavior -- a receipts
// stream we can no longer interpret must never let a worktree quietly look
// not-pending.
function foldCoordinatorReceiptText(text, pending) {
  let sawContent = false;
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    sawContent = true;
    let row;
    try {
      row = JSON.parse(line.replace(/^\uFEFF/, ''));
    } catch {
      return { ok: false, sawContent };
    }
    const candidates = [
      row?.worktree?.cwd,
      ...(Array.isArray(row?.worktrees) ? row.worktrees.map((worktree) => worktree?.cwd) : []),
    ]
      .filter(Boolean)
      .map((cwd) => path.resolve(cwd));
    const encoded = JSON.stringify({
      verdict: row?.verdict,
      repairState: row?.repairState,
      outcomes: row?.outcomes,
      perDefect: row?.perDefect,
    });
    const isPending = /integration_blocked|repaired_pending_land|repaired_pending_deploy/.test(
      encoded,
    );
    const terminalVerdicts = new Set(['clean', 'cleared', 'partial', 'blocked', 'escalated']);
    const recognizedTerminal = terminalVerdicts.has(String(row?.verdict || ''));
    const terminalOutcomes =
      !Array.isArray(row?.perDefect) ||
      row.perDefect.every(
        (outcome) =>
          !['repaired_pending_land', 'repaired_pending_deploy'].includes(outcome?.outcome),
      );
    const explicitlySettled = recognizedTerminal && terminalOutcomes;
    for (const cwd of candidates) {
      if (isPending) pending.add(cwd);
      else if (explicitlySettled) pending.delete(cwd);
      else pending.add(cwd); // unresolved or unrecognized ownership fails closed
    }
  }
  return { ok: true, sawContent };
}

// `target` is either:
//   - a single flat receipts file (the pre-split legacy layout, or a test
//     fixture): read exactly as before.
//   - a per-briefing-date ledger DIRECTORY (the split layout): union the
//     legacy sibling flat file (`${target}.jsonl`, oldest history, if it
//     still exists) with every dated file across the lookback window,
//     oldest-first, so a later "cleared" row always overrides an earlier
//     "pending" one -- the same chronological fold as the single-file scan,
//     now spread across files. This is what keeps the proof correct across
//     a midnight boundary: a receipt written just before midnight lands in
//     yesterday's dated file and is still folded in when the janitor runs
//     after midnight and reads today's (possibly still-empty) file plus
//     yesterday's.
function pendingCoordinatorWorktrees(
  target = process.env.SB_GIT_JANITOR_COORDINATOR_RECEIPTS || '',
  opts = {},
) {
  if (!target) return { known: false, worktrees: new Set() };
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(target).isDirectory();
  } catch {
    isDirectory = false;
  }

  const sources = [];
  if (isDirectory) {
    const legacy = `${target}.jsonl`;
    if (fs.existsSync(legacy)) sources.push(legacy);
    const lookbackDays = Math.max(1, Number(opts.lookbackDays) || COORDINATOR_PROOF_LOOKBACK_DAYS);
    const today = opts.today || new Date().toISOString().slice(0, 10);
    const oldestFirst = datedLedger.datesBack(today, lookbackDays).reverse();
    for (const date of oldestFirst) sources.push(path.join(target, `${date}.jsonl`));
  } else {
    if (!fs.existsSync(target)) return { known: false, worktrees: new Set() };
    sources.push(target);
  }

  const pending = new Set();
  let sawContent = false;
  for (const file of sources) {
    let text;
    try {
      text = readBoundedTailText(file);
    } catch {
      continue; // a missing per-date file just means no runs that day, not corruption
    }
    const result = foldCoordinatorReceiptText(text, pending);
    if (result.sawContent) sawContent = true;
    if (!result.ok) return { known: false, worktrees: pending };
  }
  if (!sawContent) return { known: false, worktrees: pending };
  return { known: true, worktrees: pending };
}

function isStillLanded(repoRoot, branch) {
  try {
    git(['merge-base', '--is-ancestor', branch, 'origin/master'], repoRoot);
    return true;
  } catch {
    return false;
  }
}

// Grace period (incident: the janitor reaped a just-created worktree
// mid-setup). A brand-new session has not registered a spine-session lease
// yet -- the lease write happens after the worktree exists -- and the
// worktree can still look "clean" for the window between `git worktree add`
// and the session's first file write. A worktree younger than this window is
// treated as still-being-set-up regardless of lease or dirty state. Age is
// the directory's birthtime, which exists the instant `git worktree add`
// creates it, before any lease or file write can land.
const WORKTREE_GRACE_MS = 30 * 60 * 1000; // 30 minutes

// True when wtPath was created less than graceMs ago relative to nowMs.
// Returns false (no grace -- safe to consider for reaping) when age cannot be
// determined (missing dir, no nowMs, unsupported birthtime), so a stat
// failure never silently blocks legitimate reaping -- the live/dirty checks
// remain the real safety net for those cases.
function isWorktreeYoungerThan(wtPath, nowMs, graceMs = WORKTREE_GRACE_MS) {
  if (!wtPath || !nowMs) return false;
  try {
    const st = fs.statSync(wtPath);
    const birth = st.birthtimeMs || st.ctimeMs;
    if (!birth || !Number.isFinite(birth)) return false;
    return nowMs - birth < graceMs;
  } catch {
    return false;
  }
}

// Pure planning. Reads state, returns what WOULD be reaped + why others were
// skipped. No mutation.
function buildManifest(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const state = gh.classifyGitState({ cwd, today: opts.today || '' });
  const live = gh.readLiveWorktrees({ nowMs: opts.nowMs, tasksDir: opts.tasksDir });
  const parked = gh.readParked(state.repoRoot);
  const nowMs = opts.nowMs || Date.now();
  const requireProcessCwdProof = opts.requireProcessCwdProof === true;
  const processCwdProof = opts.processCwdProof || readSameUserProcessCwds();
  const requireCoordinatorProof = opts.requireCoordinatorProof === true;
  const coordinatorProof = opts.coordinatorProof || pendingCoordinatorWorktrees();
  const scanBudgetMs = resolveScanBudgetMs(opts.scanBudgetMs);
  const scanClockFn = opts.scanClockFn || Date.now;
  const scanStart = scanBudgetMs != null ? scanClockFn() : 0; // never consult the clock when opted out

  const reap = [];
  const skipped = {
    live: 0,
    dirty: 0,
    locked: 0,
    permanent: 0,
    protected: 0,
    parked: 0,
    notMerged: 0,
    young: 0,
    process: 0,
    processProofUnavailable: 0,
    coordinatorPending: 0,
    coordinatorProofUnavailable: 0,
    budgetExceeded: 0,
  };

  for (const br of state.branches) {
    // Give the scan an early, honest exit instead of letting an external
    // caller (the Stop hook) hard-kill it mid-loop once its own timeout wins
    // the race. Every remaining branch is simply left for the next pass.
    if (scanBudgetMs != null && scanClockFn() - scanStart >= scanBudgetMs) {
      skipped.budgetExceeded += 1;
      continue;
    }
    // The janitor often runs from the detached immutable runtime worktree. In
    // that shape no local branch is "active", so ancestry alone makes master
    // look like a landed leftover. Branch identity outranks caller cwd.
    if (isPermanentBranch(br.name)) {
      skipped.permanent++;
      continue;
    }
    if (br.category === 'protected') {
      skipped.protected++;
      continue;
    }
    if (br.category === 'parked') {
      skipped.parked++;
      continue;
    }
    if (br.category === 'active') continue; // the checked-out branch
    if (br.category === 'stray') {
      skipped.notMerged++; // carries unique commits, needs a human decision
      continue;
    }
    // category 'landed' = commits already in origin/master, candidate to reap
    const wt = br.worktree ? path.resolve(br.worktree) : null;
    if (br.worktreeLocked) {
      skipped.locked++;
      continue;
    }
    if (gh.isLiveWorktree(live, wt)) {
      skipped.live++;
      continue;
    }
    if (wt && requireProcessCwdProof && !processCwdProof.known) {
      skipped.processProofUnavailable++;
      continue;
    }
    if (wt && processOwnsWorktree(wt, processCwdProof)) {
      skipped.process++;
      continue;
    }
    if (wt && requireCoordinatorProof && !coordinatorProof.known) {
      skipped.coordinatorProofUnavailable++;
      continue;
    }
    if (wt && coordinatorProof.worktrees.has(path.resolve(wt))) {
      skipped.coordinatorPending++;
      continue;
    }
    // Grace period FIRST, before the dirty check: a worktree mid-setup can
    // still look clean (no files written yet) in the window between
    // `git worktree add` and the session's first commit/lease -- exactly how
    // a prior incident reaped a just-created worktree.
    if (wt && isWorktreeYoungerThan(wt, nowMs)) {
      skipped.young++;
      continue;
    }
    if (wt && !isWorktreeClean(wt)) {
      skipped.dirty++;
      continue;
    }
    try {
      gh.assertSafeToClean(state.repoRoot, br.name, parked); // defense in depth
    } catch {
      skipped.protected++;
      continue;
    }
    reap.push({ branch: br.name, worktree: wt, tip: br.tip, subject: br.subject, date: br.date });
  }

  return {
    repoRoot: state.repoRoot,
    generatedFor: opts.today || '',
    counts: { candidates: reap.length, ...skipped, stashes: state.stashes.length },
    reap,
    truncated: skipped.budgetExceeded > 0,
    processCwdProofKnown: processCwdProof.known,
    processCwdProofScope: processCwdProof.scope || 'unknown',
    coordinatorProofKnown: coordinatorProof.known,
  };
}

// Remove directory junctions/reparse points at the top level of a worktree
// BEFORE `git worktree remove`, so the recursive removal can never follow a
// junction (e.g. a node_modules junction into the main checkout) and delete the
// TARGET. `rmdir` on a junction removes the LINK only, never the target.
// 2026-06-15 incident: a worktree's node_modules junction caused a worktree
// removal to wipe the main checkout's node_modules. This is the mechanical guard
// so the reaper can never repeat it. Mirrors scripts/safe-worktree-remove.sh.
function stripJunctions(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const stripped = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    // Junctions and directory symlinks both report isSymbolicLink() on Windows.
    if (st.isSymbolicLink()) {
      try {
        // cmd rmdir removes the link, never the target (proven in safe-worktree-remove.sh).
        // Removing a junction is metadata-only; 15s is generous, and the catch
        // below already falls back to fs.rmdirSync then skip-and-refuse.
        execFileSync('cmd', ['/c', 'rmdir', p.replace(/\//g, '\\')], {
          stdio: 'ignore',
          timeout: 15_000,
        });
        stripped.push(p);
      } catch {
        try {
          fs.rmdirSync(p);
          stripped.push(p);
        } catch {
          /* leave it; git worktree remove will then refuse rather than follow it */
        }
      }
    }
  }
  return stripped;
}

// Executes the manifest only when apply=true, capped. Dry-run by default.
function runJanitor(opts = {}) {
  const manifest = buildManifest(opts);
  if (!opts.apply) return { mode: 'dry-run', manifest, actions: [] };

  const cap = opts.cap || 20;
  const actions = [];
  let done = 0;
  for (const item of manifest.reap) {
    if (done >= cap) break;
    try {
      assertNotPermanentBranch(item.branch);
      gh.assertSafeToClean(manifest.repoRoot, item.branch); // re-check at apply time
      const liveAtApply = (opts.readLiveWorktrees || gh.readLiveWorktrees)({
        nowMs: opts.nowMs || Date.now(),
        tasksDir: opts.tasksDir,
      });
      if (gh.isLiveWorktree(liveAtApply, item.worktree)) {
        actions.push({
          branch: item.branch,
          worktree: item.worktree,
          ok: false,
          skipped: 'live',
          error: `refuse: ${item.branch} acquired a live session lease after planning`,
        });
        continue;
      }
      const processCwdProof = (opts.readProcessCwds || readSameUserProcessCwds)();
      if (item.worktree && opts.requireProcessCwdProof === true && !processCwdProof.known) {
        actions.push({
          branch: item.branch,
          worktree: item.worktree,
          ok: false,
          skipped: 'process-proof-unavailable',
          error: `refuse: cannot prove no same-user process owns ${item.worktree}`,
        });
        continue;
      }
      if (item.worktree && processOwnsWorktree(item.worktree, processCwdProof)) {
        actions.push({
          branch: item.branch,
          worktree: item.worktree,
          ok: false,
          skipped: 'process-cwd',
          error: `refuse: a live process cwd is inside ${item.worktree}`,
        });
        continue;
      }
      const coordinatorProof = (opts.readCoordinatorWorktrees || pendingCoordinatorWorktrees)();
      if (item.worktree && opts.requireCoordinatorProof === true && !coordinatorProof.known) {
        actions.push({
          branch: item.branch,
          worktree: item.worktree,
          ok: false,
          skipped: 'coordinator-proof-unavailable',
          error: 'refuse: coordinator receipt proof is unavailable',
        });
        continue;
      }
      if (item.worktree && coordinatorProof.worktrees.has(path.resolve(item.worktree))) {
        actions.push({
          branch: item.branch,
          worktree: item.worktree,
          ok: false,
          skipped: 'coordinator-pending',
          error: `refuse: coordinator still owns pending work in ${item.worktree}`,
        });
        continue;
      }
      if (!isStillLanded(manifest.repoRoot, item.branch)) {
        throw new Error(`refuse: ${item.branch} is no longer an ancestor of origin/master`);
      }
      if (item.worktree) {
        stripJunctions(item.worktree); // never let `worktree remove` follow a junction into the main checkout
        git(['worktree', 'remove', item.worktree], manifest.repoRoot); // no --force
      }
      // Git's `branch -d` also consults a branch's configured upstream, which
      // can differ from master and falsely refuse a branch already landed in
      // origin/master. The just-run ancestry check is the safety condition.
      git(['branch', '-D', item.branch], manifest.repoRoot);
      actions.push({ branch: item.branch, worktree: item.worktree, ok: true });
      done += 1;
    } catch (e) {
      actions.push({
        branch: item.branch,
        ok: false,
        error: ((e && e.message) || 'unknown').split('\n')[0],
      });
    }
  }
  const result = { mode: 'apply', cap, reaped: done, manifest, actions };
  result.cleanupBaseline = cleanupBaselineVerdict(result, {
    requireProcessCwdProof: opts.requireProcessCwdProof === true,
    requireCoordinatorProof: opts.requireCoordinatorProof === true,
  });
  return result;
}

function cleanupBaselineVerdict(
  res,
  { requireProcessCwdProof = false, requireCoordinatorProof = false } = {},
) {
  const manifest = res?.manifest || {};
  if (res?.mode !== 'apply') return { ready: false, reason: 'not-apply-mode' };
  if (requireProcessCwdProof && manifest.processCwdProofKnown !== true) {
    return { ready: false, reason: 'process-cwd-proof-unavailable' };
  }
  if (requireCoordinatorProof && manifest.coordinatorProofKnown !== true) {
    return { ready: false, reason: 'coordinator-proof-unavailable' };
  }
  const failures = (res.actions || []).filter((row) => row?.ok !== true);
  if (failures.length)
    return { ready: false, reason: 'cleanup-action-failed', failures: failures.length };
  const candidates = Number(manifest.counts?.candidates || 0);
  if (candidates > Number(res.cap || 0)) {
    return {
      ready: false,
      reason: 'bounded-cleanup-remains',
      candidates,
      cap: Number(res.cap || 0),
    };
  }
  if (Number(res.reaped || 0) !== candidates) {
    return {
      ready: false,
      reason: 'eligible-cleanup-incomplete',
      candidates,
      reaped: Number(res.reaped || 0),
    };
  }
  return {
    ready: true,
    reason: candidates > 0 ? 'all-eligible-worktrees-reaped' : 'nothing-eligible-proof-green',
    candidates,
    reaped: Number(res.reaped || 0),
  };
}

function writeManifest(res, today = new Date().toISOString().slice(0, 10)) {
  const outDir =
    process.env.SB_GIT_JANITOR_MANIFEST_DIR || path.join(res.manifest.repoRoot, 'data', 'agent');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `git-janitor-manifest-${today}.json`);
  fs.writeFileSync(out, JSON.stringify(res, null, 2));
  return out;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const capArg = args.find((a) => a.startsWith('--cap='));
  const cap = capArg ? parseInt(capArg.split('=')[1], 10) : 20;
  const today = new Date().toISOString().slice(0, 10);
  const res = runJanitor({
    apply,
    cap,
    today,
    nowMs: Date.now(),
    requireProcessCwdProof: process.env.SB_GIT_JANITOR_REQUIRE_PROCESS_CWD_PROOF === '1',
    requireCoordinatorProof: process.env.SB_GIT_JANITOR_REQUIRE_COORDINATOR_PROOF === '1',
  });
  if (apply && !res.cleanupBaseline) {
    res.cleanupBaseline = cleanupBaselineVerdict(res, {
      requireProcessCwdProof: process.env.SB_GIT_JANITOR_REQUIRE_PROCESS_CWD_PROOF === '1',
      requireCoordinatorProof: process.env.SB_GIT_JANITOR_REQUIRE_COORDINATOR_PROOF === '1',
    });
  }

  if (res.mode === 'dry-run') {
    const m = res.manifest;
    console.log(
      `[git-janitor] DRY-RUN. ${m.counts.candidates} leftover branches safe to reap; ` +
        `skipped live=${m.counts.live} dirty=${m.counts.dirty} locked=${m.counts.locked || 0} young=${m.counts.young || 0} ` +
        `parked=${m.counts.parked} permanent=${m.counts.permanent || 0} ` +
        `protected=${m.counts.protected} unmerged=${m.counts.notMerged}.`,
    );
    for (const r of m.reap.slice(0, 50)) {
      console.log(`  would reap ${r.branch}${r.worktree ? ' + worktree' : ''}`);
    }
    if (m.reap.length > 50) console.log(`  ... and ${m.reap.length - 50} more`);
    if (m.truncated) {
      console.log(
        `[git-janitor] scan budget hit; ${m.counts.budgetExceeded} branch(es) left unscanned this pass (picked up next run).`,
      );
    }
    console.log('Run with --apply --cap=N to reap (capped, safe-delete only).');
  } else {
    const failures = res.actions.filter((a) => !a.ok).length;
    console.log(`[git-janitor] APPLIED. reaped ${res.reaped}/${res.cap}. failures: ${failures}.`);
    for (const a of res.actions) {
      console.log(`  ${a.ok ? 'reaped' : 'FAILED'} ${a.branch}${a.error ? ' :: ' + a.error : ''}`);
    }
    if (res.manifest.truncated) {
      console.log(
        `[git-janitor] scan budget hit; ${res.manifest.counts.budgetExceeded} branch(es) left unscanned this pass (picked up next run).`,
      );
    }
    if (failures > 0) process.exitCode = 1;
    if (
      process.env.SB_GIT_JANITOR_REQUIRE_CLEANUP_BASELINE_PROOF === '1' &&
      res.cleanupBaseline?.ready !== true
    ) {
      console.error(
        `[git-janitor] cleanup baseline refused: ${res.cleanupBaseline?.reason || 'unknown'}`,
      );
      process.exitCode = 1;
    }
  }

  // Write the manifest so the briefing/health surfaces can show it.
  try {
    writeManifest(res, today);
  } catch (error) {
    console.error(
      `[git-janitor] failed to write manifest: ${error && error.message ? error.message : error}`,
    );
    if (apply) process.exitCode = 1;
  }
}

module.exports = {
  buildManifest,
  runJanitor,
  writeManifest,
  stripJunctions,
  isWorktreeYoungerThan,
  isStillLanded,
  isPermanentBranch,
  assertNotPermanentBranch,
  readSameUserProcessCwds,
  processOwnsWorktree,
  pendingCoordinatorWorktrees,
  cleanupBaselineVerdict,
  WORKTREE_GRACE_MS,
  resolveScanBudgetMs,
  DEFAULT_SCAN_BUDGET_MS,
};
