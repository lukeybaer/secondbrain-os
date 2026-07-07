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
//     worktree; `git branch -d` (safe delete) refuses an unmerged branch and a
//     branch checked out in any worktree. We never rm -rf a directory.
//   - HARD SKIPS: protected (codex/rescue*), parked (registry), the checked-out
//     branch, unmerged branches, worktrees with a live session lease, dirty
//     worktrees, and all stashes. assertSafeToClean() is the last gate.
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

// Pure planning. Reads state, returns what WOULD be reaped + why others were
// skipped. No mutation.
function buildManifest(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const state = gh.classifyGitState({ cwd, today: opts.today || '' });
  const live = gh.readLiveWorktrees({ nowMs: opts.nowMs, tasksDir: opts.tasksDir });
  const parked = gh.readParked(state.repoRoot);

  const reap = [];
  const skipped = { live: 0, dirty: 0, protected: 0, parked: 0, notMerged: 0 };

  for (const br of state.branches) {
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
      skipped.notMerged++; // ExampleCos unique commits, needs a human decision
      continue;
    }
    // category 'landed' = commits already in origin/master, candidate to reap
    const wt = br.worktree ? path.resolve(br.worktree) : null;
    if (wt && live.has(wt)) {
      skipped.live++;
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
      gh.assertSafeToClean(manifest.repoRoot, item.branch); // re-check at apply time
      if (item.worktree) {
        stripJunctions(item.worktree); // never let `worktree remove` follow a junction into the main checkout
        git(['worktree', 'remove', item.worktree], manifest.repoRoot); // no --force
      }
      git(['branch', '-d', item.branch], manifest.repoRoot); // safe delete, refuses unmerged
      actions.push({ branch: item.branch, worktree: item.worktree, ok: true });
      done += 1;
    } catch (e) {
      actions.push({
        branch: item.branch,
        ok: false,
        error: ((e && e.message) || 'ExampleCo').split('\n')[0],
      });
    }
  }
  return { mode: 'apply', cap, reaped: done, manifest, actions };
}

function writeManifest(res, today = new Date().toISOString().slice(0, 10)) {
  const outDir = path.join(res.manifest.repoRoot, 'data', 'agent');
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
  const res = runJanitor({ apply, cap, today, nowMs: Date.now() });

  if (res.mode === 'dry-run') {
    const m = res.manifest;
    console.log(
      `[git-janitor] DRY-RUN. ${m.counts.candidates} leftover branches safe to reap; ` +
        `skipped live=${m.counts.live} dirty=${m.counts.dirty} parked=${m.counts.parked} ` +
        `protected=${m.counts.protected} unmerged=${m.counts.notMerged}.`,
    );
    for (const r of m.reap.slice(0, 50)) {
      console.log(`  would reap ${r.branch}${r.worktree ? ' + worktree' : ''}`);
    }
    if (m.reap.length > 50) console.log(`  ... and ${m.reap.length - 50} more`);
    console.log('Run with --apply --cap=N to reap (capped, safe-delete only).');
  } else {
    const failures = res.actions.filter((a) => !a.ok).length;
    console.log(`[git-janitor] APPLIED. reaped ${res.reaped}/${res.cap}. failures: ${failures}.`);
    for (const a of res.actions) {
      console.log(`  ${a.ok ? 'reaped' : 'FAILED'} ${a.branch}${a.error ? ' :: ' + a.error : ''}`);
    }
  }

  // Write the manifest so the briefing/health surfaces can show it.
  try {
    writeManifest(res, today);
  } catch {
    // non-fatal
  }
}

module.exports = { buildManifest, runJanitor, writeManifest, stripJunctions };
