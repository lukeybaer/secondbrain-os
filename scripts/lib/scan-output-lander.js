'use strict';

// scan-output-lander.js
//
// THE structural fix for the repeating "shared checkout is dirty again" class
// of failures (ExampleCo, 2026-07-12: "how many times are we going to encounter
// more shared checkout issues"). Scheduled jobs that produce git-worthy
// outputs (contact scans, LESSONS.md appends, curated ledgers) used to write
// into whatever tree they ran in and STOP. When that tree was the shared
// checkout, the outputs sat as uncommitted dirt forever; when it was an
// isolated worktree, the outputs rotted in the worktree and never reached
// master. Both endings violate "durable + versioned".
//
// This module gives every writer one call to make at the end of its run:
//
//   const { landScanOutputs } = require('./lib/scan-output-lander.js');
//   landScanOutputs({ repoRoot, pathspecs: ['memory/contacts'], message: '...' });
//
// Behavior is a property of the tree the writer ran in:
//   - Isolated worktree: add + commit the scoped pathspecs on the worktree's
//     own branch, then run `node scripts/land.js --apply` there (rebase +
//     scoped tests + fast-forward push). The normal landing gate, no bypass.
//   - Shared checkout: NEVER commit here. Create a disposable isolation
//     worktree off origin/master (scripts/lib/codex-worktree.js), copy the
//     dirty files into it, commit + land THERE, then remove the worktree and
//     best-effort fast-forward the shared checkout so the landed content
//     stops reading as dirt. The shared index is never touched.
//
// Failure posture: fail loud, never silent, never fatal to the writer. A
// landing failure returns { ok: false, reason } for the caller to ledger/log;
// it must not convert a successful scan into a failed one.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ensureCodexWorktree, isSharedCheckout } = require('./codex-worktree.js');

const GIT_TIMEOUT_MS = 120_000;

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

// `git status --porcelain -- <pathspecs>` entries as { code, rel } rows.
// Handles the rename form "R  old -> new" by keeping the NEW path.
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

function dirtyOwnedPaths({ repoRoot, pathspecs = [], runGit = runGitDefault } = {}) {
  const args = ['status', '--porcelain'];
  if (pathspecs.length) args.push('--', ...pathspecs);
  const r = runGit(args, repoRoot);
  if (!r.ok) throw new Error(`git status failed in ${repoRoot}: ${r.stderr || r.status}`);
  return parsePorcelain(r.stdout);
}

function runLandDefault(worktreeCwd, log) {
  const landScript = path.join(worktreeCwd, 'scripts', 'land.js');
  const r = spawnSync(process.execPath, [landScript, '--apply'], {
    cwd: worktreeCwd,
    encoding: 'utf8',
    timeout: 20 * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = [r.stdout, r.stderr].filter(Boolean).join('\n');
  log(`[scan-lander] land.js exit=${r.status}`);
  if (out) log(out.slice(-2000));
  return { ok: r.status === 0, output: out };
}

// Copy one dirty entry from the source tree into the landing worktree.
// Deletions (working file gone) become `git rm` in the worktree.
function mirrorEntry({ entry, fromRoot, toRoot, runGit, log }) {
  const src = path.join(fromRoot, entry.rel);
  const dst = path.join(toRoot, entry.rel);
  if (!fs.existsSync(src)) {
    const rm = runGit(['rm', '--ignore-unmatch', '--quiet', '--', entry.rel], toRoot);
    if (!rm.ok) log(`[scan-lander] WARN: could not mirror deletion of ${entry.rel}`);
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// Best-effort fast-forward of the shared checkout after a land, so content
// that just reached origin/master stops reading as local dirt. STRICTLY
// fast-forward and strictly guarded: only when local HEAD is an ancestor of
// origin/master, and git itself refuses if any peer's uncommitted work would
// be clobbered. Failure here is expected and non-fatal (the shared-dirt
// tripwire treats content-equal-to-origin dirt as landed-awaiting-sync).
function fastForwardShared({ sharedRoot, runGit = runGitDefault, log = () => {} } = {}) {
  const fetch = runGit(['fetch', 'origin', 'master'], sharedRoot);
  if (!fetch.ok) return { ok: false, reason: 'fetch-failed' };
  const anc = runGit(['merge-base', '--is-ancestor', 'HEAD', 'origin/master'], sharedRoot);
  if (!anc.ok) return { ok: false, reason: 'diverged-not-ff' };
  let merge = runGit(['merge', '--ff-only', 'origin/master'], sharedRoot);
  if (!merge.ok) {
    // Git refuses an ff merge over a locally-modified file even when its
    // working bytes are IDENTICAL to the incoming blob (it compares against
    // old HEAD, not the target). That is exactly the state a just-landed scan
    // leaves behind. Reconcile only those provably content-equal paths (a
    // byte-identical checkout, safe under peers), then retry once. Any path
    // with REAL peer differences still refuses, and we leave it alone.
    const dirty = parsePorcelain(runGit(['status', '--porcelain'], sharedRoot).stdout);
    let reconciled = 0;
    for (const entry of dirty) {
      if (entry.code.includes('?')) continue; // untracked never blocks ff
      const originBlob = runGit(['rev-parse', `origin/master:${entry.rel}`], sharedRoot);
      if (!originBlob.ok) continue;
      const workingHash = runGit(['hash-object', '--', entry.rel], sharedRoot);
      if (!workingHash.ok) continue;
      if (originBlob.stdout.trim() !== workingHash.stdout.trim()) continue;
      const co = runGit(['checkout', 'origin/master', '--', entry.rel], sharedRoot);
      if (co.ok) reconciled += 1;
    }
    if (reconciled > 0) {
      merge = runGit(['merge', '--ff-only', 'origin/master'], sharedRoot);
    }
    if (!merge.ok) {
      log('[scan-lander] shared ff-sync refused (peer dirt in the way); leaving as-is.');
      return { ok: false, reason: 'ff-refused' };
    }
  }
  return { ok: true };
}

// Land the writer's outputs through the normal gate. Returns
//   { ok, landed, reason?, files, branch?, worktree? }
// and NEVER throws for operational failures (throws only on caller misuse).
function landScanOutputs({
  repoRoot,
  pathspecs,
  message,
  purpose = 'scan-outputs',
  log = (line) => console.log(line),
  runGit = runGitDefault,
  runLand = runLandDefault,
  ensureWorktree = ensureCodexWorktree,
  sharedCheckoutCheck = isSharedCheckout,
  syncShared = true,
} = {}) {
  if (!repoRoot) throw new Error('landScanOutputs: repoRoot is required');
  if (!Array.isArray(pathspecs) || pathspecs.length === 0) {
    throw new Error('landScanOutputs: pathspecs (non-empty array) is required');
  }
  if (!message) throw new Error('landScanOutputs: message is required');

  let entries;
  try {
    entries = dirtyOwnedPaths({ repoRoot, pathspecs, runGit });
  } catch (e) {
    return { ok: false, landed: false, reason: `status-failed: ${e.message}`, files: [] };
  }
  if (entries.length === 0) {
    return { ok: true, landed: false, reason: 'clean', files: [] };
  }
  const files = entries.map((e) => e.rel);
  log(`[scan-lander] ${files.length} owned dirty path(s): ${files.join(', ')}`);

  const onShared = sharedCheckoutCheck(repoRoot);

  // Where the commit happens: the writer's own worktree when isolated, a
  // disposable landing worktree when the writer ran against the shared tree.
  let landRoot = repoRoot;
  let disposable = null;
  if (onShared) {
    try {
      disposable = ensureWorktree({
        repoRoot,
        purpose: `${purpose}`,
        branchPrefix: 'codex/scan-outputs',
        linkNodeModules: false,
      });
    } catch (e) {
      return { ok: false, landed: false, reason: `worktree-failed: ${e.message}`, files };
    }
    landRoot = disposable.cwd;
    for (const entry of entries) {
      try {
        mirrorEntry({ entry, fromRoot: repoRoot, toRoot: landRoot, runGit, log });
      } catch (e) {
        return {
          ok: false,
          landed: false,
          reason: `mirror-failed (${entry.rel}): ${e.message}`,
          files,
        };
      }
    }
  }

  const add = runGit(['add', '--', ...pathspecs], landRoot);
  if (!add.ok) {
    return { ok: false, landed: false, reason: `add-failed: ${add.stderr}`, files };
  }
  const staged = runGit(['diff', '--cached', '--name-only'], landRoot);
  if (!String(staged.stdout || '').trim()) {
    // Everything owned was already at origin content (e.g. a peer landed it).
    return { ok: true, landed: false, reason: 'nothing-staged', files };
  }
  const commit = runGit(
    [
      'commit',
      '-m',
      `${message}\n\nno-test-justification: scheduled scan outputs (data/memory), no production code`,
    ],
    landRoot,
  );
  if (!commit.ok) {
    return { ok: false, landed: false, reason: `commit-failed: ${commit.stderr}`, files };
  }

  const land = runLand(landRoot, log);
  if (!land.ok) {
    return {
      ok: false,
      landed: false,
      reason: 'land-failed (worktree left in place for forensics)',
      files,
      worktree: disposable ? disposable.cwd : landRoot,
      branch: disposable ? disposable.branch : undefined,
    };
  }

  if (disposable) {
    // Landed: reap the disposable worktree + branch so scheduled runs never
    // leak orphans (feedback_codex_orphan_leak_thrashes_briefing.md).
    runGit(['worktree', 'remove', '--force', disposable.cwd], repoRoot);
    if (disposable.branch) runGit(['branch', '-D', disposable.branch], repoRoot);
    if (syncShared) fastForwardShared({ sharedRoot: repoRoot, runGit, log });
  }

  return {
    ok: true,
    landed: true,
    files,
    branch: disposable ? disposable.branch : undefined,
  };
}

module.exports = {
  landScanOutputs,
  dirtyOwnedPaths,
  parsePorcelain,
  fastForwardShared,
};
