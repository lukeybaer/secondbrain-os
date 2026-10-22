#!/usr/bin/env node
'use strict';
//
// git-branch-retire.js -- ARCHIVE-THEN-RETIRE for git work nobody landed.
//
// The janitor (git-janitor.js) reaps only branches already in origin/master.
// Everything with unique commits was left as "stray, needs a human decision",
// so 341 branches, stashes and leftover worktrees piled up on the Uncommitted &
// Parked card (Owner decision: "there's no way I'm reviewing all those
// hundreds... Isn't branch cleanliness supposed to fix it."). This step makes
// that decision mechanically and reversibly:
//
//   1. PLAN. An item is retirable only when 72 hours have passed since its tip
//      commit, and only under every gate: not permanent, protected, parked or
//      checked out; no live session lease; a readable process proof showing no
//      process in or naming the worktree; no coordinator-pending work; no
//      index, HEAD or file write for 72 hours; a lock at least 7 days old; no
//      nested repository; and every ignored file either regenerable (build
//      output, caches, node_modules) or an allowlisted runtime artifact with no
//      credential in its name or content. Anything unproven is skipped.
//   2. ARCHIVE. Each item becomes a git bundle of the tip, a stash commit, or
//      a snapshot commit of the worktree's tracked and untracked edits (built
//      through a temporary index, so the worktree is untouched), plus a tarball
//      of its archivable ignored files. Bundles are thin against origin/master
//      (on GitHub); the ledger records those prerequisite SHAs. Every artifact
//      is SHA-256 hashed, `git bundle verify`ed, copied to S3, downloaded back
//      and re-hashed. Only then is an "archived" ledger row written.
//   3. RETIRE. Immediately before removal, every gate above is re-run on fresh
//      state, parked and protected records are re-read, the tip must be
//      unchanged, and a full content manifest (snapshot tree plus every ignored
//      file's path, size and mtime) must equal the archived one. The ledger gets
//      "retire-start", then "retired" or "retire-failed" with what was removed.
//
// DRY-RUN by default. --apply is CAPPED per day (--cap, default 25 attempts,
// counted from the ledger across all runs that day) and holds an exclusive
// lock. Restore with the ledger row's `restore` arguments.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gh = require('./lib/git-hygiene');
const janitor = require('./git-janitor.js');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const GRACE_DAYS = 3;
const LOCK_STALE_DAYS = 7;
const DEFAULT_CAP = 25;
const RUN_LOCK_STALE_MS = 3 * HOUR_MS;
const S3_BUCKET = 'ExampleCo-secondbrain-backups';
const S3_PREFIX = 'git-archive/branches';
const ARCHIVE_REF_PREFIX = 'refs/retire-archive/';
const CONTENT_SCAN_BYTES = 4 * 1024 * 1024;
const CONTENT_SCAN_OVERLAP = 1024;
// Git Bash's GNU tar reads "C:" as a remote host; Windows' own bsdtar does not.
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

// Ignored paths a removed worktree may lose: regenerable by a build or install,
// the voiceprint model download at its exact path, land's scratch git dirs and
// the hook's per-session context marker. A Python virtualenv is regenerable
// only by structure (its pyvenv.cfg), never by name; see isVirtualenv.
const REGENERABLE_IGNORED =
  /(^|\/)(node_modules|coverage|dist|build|out|\.vitest|\.turbo|\.cache|\.next|\.parcel-cache|__pycache__|\.pytest_cache|tmp|\.tmp|\.land-git|\.land-rescue-git|data\/life-archive\/voiceprints\/model-cache\/speechbrain-ecapa-voxceleb)(\/|$)|\.(tsbuildinfo|pyc|log)$|(^|\/)\.claude\/\.git-context-injected$/;
// Ignored files that may be copied to S3: runtime receipts, logs, rendered
// reports, scratch scripts and media. Anything else (unknown types, dotfiles)
// is unproven.
const ARCHIVABLE_IGNORED = /\.(jsonl|json|html|md|txt|csv|tsv|js|cjs|mjs|yaml|yml|mp3|mp4|wav|m4a|jpg|jpeg|png|gif|webp|svg|pdf)$/i;
// Names that may hold a credential: never copied to S3, never deleted.
const SECRET_IGNORED =
  /(^|\/)\.env($|\.)|(^|\/)\.(npmrc|pypirc|netrc|git-credentials|htpasswd)$|(^|\/)(auth|credentials?|secrets?|cookies?)(\.[a-z]+)?$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)|(^|\/)[^/]*(token|secret|credential|password|cookie|apikey|api-key|private)[^/]*$|\.(pem|key|p12|pfx|keystore|jks|kdbx|sqlite|db)$/i;
// Content that marks a credential inside an otherwise archivable file.
const SECRET_CONTENT =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|aws_secret_access_key|\bsk-[A-Za-z0-9_-]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bgh[pousr]_[A-Za-z0-9]{30,}|"(refresh|access|id)_token"\s*:\s*"[^"]{12,}|"(password|client_secret|api_key)"\s*:\s*"[^"]+"/;

function defaultDataDir(env = process.env, platform = process.platform) {
  if (env.SECONDBRAIN_DATA_DIR) return path.resolve(env.SECONDBRAIN_DATA_DIR);
  if (platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'secondbrain', 'data');
  if (platform !== 'win32') return '/opt/secondbrain/data';
  return path.join(os.homedir(), '.secondbrain', 'data');
}

function git(args, cwd, opts = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout || 120_000,
    env: opts.env || process.env,
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function ageMs(item, nowMs) {
  const ms = Date.parse(String((item && (item.committedAt || item.date)) || ''));
  return Number.isFinite(ms) ? nowMs - ms : NaN;
}

function normPath(p) {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

// Process proof. Linux: same-user process cwds from /proc. Windows exposes no
// cwd, so the proof is every process command line; a process that names the
// worktree path (a shell, node, an editor or an agent launched there) owns it.
// An unreadable proof is `known: false`, and the caller fails closed.
function readProcessProof(platform = process.platform, run = execFileSync) {
  if (platform === 'linux') {
    const p = janitor.readSameUserProcessCwds();
    return { known: p.known, owns: (wt) => janitor.processOwnsWorktree(wt, p) };
  }
  if (platform !== 'win32') return { known: false, owns: () => true };
  try {
    const out = run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }'],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const lines = String(out).split(/\r?\n/).filter(Boolean).map((l) => l.replace(/\\/g, '/').toLowerCase());
    if (!lines.length) return { known: false, owns: () => true };
    return { known: true, owns: (wt) => lines.some((l) => l.includes(normPath(wt))) };
  } catch {
    return { known: false, owns: () => true };
  }
}

// Coordinator proof: when the coordinator ledger is configured it must be
// readable; when no coordinator is configured on this host there is nothing to own.
function readCoordinatorProof(env = process.env) {
  const configured = Boolean(env.SB_GIT_JANITOR_COORDINATOR_RECEIPTS);
  const p = janitor.pendingCoordinatorWorktrees();
  return { configured, known: p.known, worktrees: p.worktrees };
}

// The admin dir of a linked worktree lives in the common dir:
// <worktree>/.git is a file "gitdir: <common>/worktrees/<id>".
function worktreeGitDir(worktree) {
  const pointer = fs.readFileSync(path.join(worktree, '.git'), 'utf8');
  const m = pointer.match(/^gitdir:\s*(.+)\s*$/m);
  if (!m) throw new Error(`${worktree}/.git has no gitdir pointer`);
  return path.resolve(worktree, m[1].trim());
}

function worktreeLockAgeMs(worktree, nowMs) {
  try {
    return nowMs - fs.statSync(path.join(worktreeGitDir(worktree), 'locked')).mtimeMs;
  } catch {
    return NaN;
  }
}

function isLockedNow(worktree) {
  try {
    return fs.existsSync(path.join(worktreeGitDir(worktree), 'locked'));
  } catch {
    return false;
  }
}

function statusEntries(worktree, gitFn) {
  return gitFn(['status', '--porcelain=v1', '-uall'], worktree)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).split(' -> ').pop().replace(/^"|"$/g, ''));
}

// Every ignored file a removal would lose that is not regenerable, as
// worktree-relative POSIX paths with size and mtime. Git collapses an ignored
// directory to "dir/", so those are walked (regenerable subtrees and links
// skipped). A nested repository anywhere is reported, never walked.
function isVirtualenv(worktree, rel) {
  return fs.existsSync(path.join(worktree, rel, 'pyvenv.cfg'));
}

function ignoredInventory(worktree, gitFn = git) {
  const out = gitFn(['status', '--porcelain=v1', '--ignored'], worktree);
  const regenerableDir = (rel) => REGENERABLE_IGNORED.test(rel) || isVirtualenv(worktree, rel);
  const files = [];
  let nestedRepo = false;
  const add = (rel) => {
    const st = fs.statSync(path.join(worktree, rel));
    files.push({ path: rel, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
  };
  // A regenerable directory is not archived, but a repository inside one
  // (node_modules/x/.git) would still be lost, so its directories are probed.
  const probe = (rel) => {
    if (nestedRepo) return;
    for (const ent of fs.readdirSync(path.join(worktree, rel), { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
      if (ent.name === '.git') {
        nestedRepo = true;
        return;
      }
      probe(`${rel}/${ent.name}`);
    }
  };
  const walk = (rel) => {
    if (fs.existsSync(path.join(worktree, rel, '.git'))) {
      nestedRepo = true;
      return;
    }
    for (const ent of fs.readdirSync(path.join(worktree, rel), { withFileTypes: true })) {
      const child = `${rel}/${ent.name}`;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory() ? regenerableDir(child) : REGENERABLE_IGNORED.test(child)) {
        if (ent.isDirectory()) probe(child);
        continue;
      }
      if (ent.isDirectory()) walk(child);
      else if (ent.isFile()) add(child);
    }
  };
  for (const line of out.split('\n')) {
    if (!line.startsWith('!! ')) continue;
    const rel = line.slice(3).replace(/^"|"$/g, '');
    if (rel.endsWith('/')) {
      const dir = rel.slice(0, -1);
      if (fs.lstatSync(path.join(worktree, dir)).isSymbolicLink()) continue;
      if (regenerableDir(dir)) probe(dir);
      else walk(dir);
    } else if (!REGENERABLE_IGNORED.test(rel)) add(rel);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, nestedRepo };
}

function classifyIgnored(worktree, files, readFn = fs.readFileSync) {
  for (const f of files) {
    if (SECRET_IGNORED.test(f.path)) return 'secretFiles';
    if (!ARCHIVABLE_IGNORED.test(f.path)) return 'unclassifiedIgnored';
  }
  for (const f of files) {
    if (!/\.(jsonl|json|html|md|txt|csv|tsv|js|cjs|mjs|yaml|yml|svg)$/i.test(f.path)) continue;
    // Whole file, in chunks that overlap so a match cannot straddle a seam.
    const fd = fs.openSync(path.join(worktree, f.path), 'r');
    try {
      const buf = Buffer.alloc(CONTENT_SCAN_BYTES);
      let tail = '';
      for (let pos = 0; ; ) {
        const n = fs.readSync(fd, buf, 0, buf.length, pos);
        if (!n) break;
        pos += n;
        const text = tail + buf.toString('utf8', 0, n);
        if (SECRET_CONTENT.test(text)) return 'secretFiles';
        tail = text.slice(-CONTENT_SCAN_OVERLAP);
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return null;
}

// A tracked gitlink (submodule) with a checkout, or an untracked nested repo
// (`git status -uall` lists it as "dir/"), holds work `git add -A` cannot see.
function hasNestedRepo(worktree, gitFn) {
  const staged = gitFn(['ls-files', '-s'], worktree);
  for (const line of staged.split('\n')) {
    if (!line.startsWith('160000 ')) continue;
    const rel = line.split('\t').pop();
    if (fs.existsSync(path.join(worktree, rel, '.git'))) return true;
  }
  return statusEntries(worktree, gitFn).some((p) => p.endsWith('/'));
}

// Time since the last sign of work: index, HEAD or reflog writes, or any
// edited/untracked (non-ignored) file. Throws when the worktree is unreadable.
function worktreeActivityAgeMs(worktree, nowMs, gitFn = git) {
  const gitDir = worktreeGitDir(worktree);
  const paths = ['index', 'HEAD', path.join('logs', 'HEAD')].map((p) => path.join(gitDir, p));
  for (const file of statusEntries(worktree, gitFn)) paths.push(path.join(worktree, file));
  let newest = 0;
  for (const p of paths) {
    try {
      newest = Math.max(newest, fs.statSync(p).mtimeMs);
    } catch {}
  }
  return nowMs - newest;
}

// A commit holding the worktree's tracked and untracked edits on top of HEAD,
// built in a temporary index so the worktree and its real index never change.
// Returns null when the worktree has no edits.
function snapshotDirtyWorktree(worktree, gitFn = git) {
  if (!gitFn(['status', '--porcelain=v1'], worktree)) return null;
  const tmpIndex = path.join(os.tmpdir(), `retire-index-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    gitFn(['read-tree', 'HEAD'], worktree, { env });
    gitFn(['add', '-A'], worktree, { env });
    const tree = gitFn(['write-tree'], worktree, { env });
    return gitFn(['commit-tree', tree, '-p', 'HEAD', '-m', `retire snapshot of uncommitted edits in ${worktree}`], worktree, { env });
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

// Full content identity: snapshot (or HEAD) tree plus every archivable ignored
// file. Any edit, new file or touched ignored file between archive and removal
// changes it.
function contentManifest(worktree, gitFn = git) {
  const snap = snapshotDirtyWorktree(worktree, gitFn);
  const tree = gitFn(['rev-parse', `${snap || 'HEAD'}^{tree}`], worktree);
  const { files, nestedRepo } = ignoredInventory(worktree, gitFn);
  const digest = crypto.createHash('sha256').update(JSON.stringify({ tree, files, nestedRepo })).digest('hex');
  return { snapshot: snap, tree, ignored: files, nestedRepo, digest };
}

// Every per-worktree gate. Returns { ok: true, ignored } or { ok: false, reason }.
function checkWorktreeGates(wt, ctx) {
  const { nowMs, graceMs, lockStaleMs, live, processProof, coordinatorProof, gitFn, locked } = ctx;
  if (gh.isLiveWorktree(live, wt)) return { ok: false, reason: 'live' };
  if (!processProof.known) return { ok: false, reason: 'processProofUnavailable' };
  if (processProof.owns(wt)) return { ok: false, reason: 'processOwned' };
  if (coordinatorProof.configured && !coordinatorProof.known) return { ok: false, reason: 'coordinatorProofUnavailable' };
  if (coordinatorProof.known && coordinatorProof.worktrees.has(path.resolve(wt))) {
    return { ok: false, reason: 'coordinatorPending' };
  }
  if ((ctx.isWorktreeYoungerThan || janitor.isWorktreeYoungerThan)(wt, nowMs, graceMs)) return { ok: false, reason: 'young' };
  const nowLocked = isLockedNow(wt);
  if (nowLocked !== Boolean(locked)) return { ok: false, reason: 'lockChanged' };
  if (locked && !((ctx.worktreeLockAgeMs || worktreeLockAgeMs)(wt, nowMs) >= lockStaleMs)) {
    return { ok: false, reason: 'lockedRecently' };
  }
  try {
    const quiet = (ctx.worktreeActivityAgeMs || ((w, n) => worktreeActivityAgeMs(w, n, gitFn)))(wt, nowMs);
    if (!(quiet >= graceMs)) return { ok: false, reason: 'recentActivity' };
    if (hasNestedRepo(wt, gitFn)) return { ok: false, reason: 'nestedRepo' };
    const inv = ignoredInventory(wt, gitFn);
    if (inv.nestedRepo) return { ok: false, reason: 'nestedRepo' };
    const bad = classifyIgnored(wt, inv.files);
    if (bad) return { ok: false, reason: bad };
    return { ok: true, ignored: inv.files };
  } catch {
    return { ok: false, reason: 'statusUnreadable' };
  }
}

function itemId(kind, ref, tip, worktree) {
  const slug = String(ref)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const ident = crypto.createHash('sha256').update(`${kind}\0${ref}\0${worktree || ''}`).digest('hex').slice(0, 10);
  return `${slug}-${String(tip).slice(0, 12)}-${ident}`;
}

// Pure planning: reads state, decides, mutates nothing.
function buildRetirePlan(opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const graceMs = (opts.graceDays ?? GRACE_DAYS) * DAY_MS;
  const lockStaleMs = (opts.lockStaleDays ?? LOCK_STALE_DAYS) * DAY_MS;
  const live = opts.liveWorktrees || gh.readLiveWorktrees({ nowMs, tasksDir: opts.tasksDir });
  const state =
    opts.state ||
    gh.classifyGitState({ cwd: opts.cwd || process.cwd(), today: opts.today || '', liveWorktrees: live, nowMs });
  const gitFn = opts.git || git;
  const gateCtx = {
    nowMs,
    graceMs,
    lockStaleMs,
    live,
    gitFn,
    processProof: opts.processProof || readProcessProof(),
    coordinatorProof: opts.coordinatorProof || readCoordinatorProof(),
    isWorktreeYoungerThan: opts.isWorktreeYoungerThan,
    worktreeLockAgeMs: opts.worktreeLockAgeMs,
    worktreeActivityAgeMs: opts.worktreeActivityAgeMs,
  };
  const parked = gh.readParked(state.repoRoot);

  const items = [];
  const skipped = {};
  const skip = (reason, ref) => {
    (skipped[reason] = skipped[reason] || []).push(ref);
  };

  const consider = (br, kind) => {
    if (janitor.isPermanentBranch(br.name) || br.isCurrent) return skip('permanent', br.name);
    if (br.category === 'protected' || br.category === 'parked' || br.parked) return skip('protected', br.name);
    try {
      gh.assertSafeToClean(state.repoRoot, br.name, parked);
    } catch {
      return skip('protected', br.name);
    }
    if (!(ageMs(br, nowMs) >= graceMs)) return skip('inFlight', br.name);
    const wt = br.worktree ? path.resolve(br.worktree) : null;
    let ignored = [];
    if (wt) {
      const gate = checkWorktreeGates(wt, { ...gateCtx, locked: br.worktreeLocked });
      if (!gate.ok) return skip(gate.reason, br.name);
      ignored = gate.ignored;
    }
    items.push({
      kind,
      branch: br.name,
      tip: br.tip,
      committedAt: br.committedAt || br.date,
      subject: br.subject,
      worktree: wt,
      locked: Boolean(br.worktreeLocked),
      ignoredFiles: ignored.map((f) => f.path),
    });
  };

  for (const br of state.branches || []) {
    if (br.category === 'stray') consider(br, 'branch');
  }
  const buckets = state.buckets || {};
  const landedWithWork = [
    ...((buckets.dirtyLanded && buckets.dirtyLanded.branches) || []),
    ...((buckets.locked && buckets.locked.branches) || []),
  ];
  const seen = new Set(items.map((i) => i.branch));
  for (const br of landedWithWork) {
    if (seen.has(br.name)) continue;
    seen.add(br.name);
    consider(br, 'landed-worktree');
  }
  for (const st of (buckets.needsDecision && buckets.needsDecision.stashes) || []) {
    let committedAt = st.committedAt;
    if (!committedAt) {
      try {
        committedAt = (opts.stashDate || ((sha) => gitFn(['log', '-1', '--format=%cI', sha], state.repoRoot)))(st.sha);
      } catch {
        skip('statusUnreadable', st.sha);
        continue;
      }
    }
    if (st.parked || gh.isParkedRef(parked, st.sha)) {
      skip('protected', st.sha);
      continue;
    }
    if (!(ageMs({ committedAt }, nowMs) >= graceMs)) {
      skip('inFlight', st.sha);
      continue;
    }
    items.push({ kind: 'stash', sha: st.sha, committedAt, subject: st.message, ignoredFiles: [] });
  }

  return {
    repoRoot: state.repoRoot,
    graceDays: graceMs / DAY_MS,
    items,
    counts: {
      retirable: items.length,
      ...Object.fromEntries(Object.entries(skipped).map(([k, v]) => [k, v.length])),
    },
    skipped,
  };
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function defaultS3Put(file, key) {
  execFileSync('aws', ['s3', 'cp', file, `s3://${S3_BUCKET}/${key}`, '--only-show-errors'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
  });
}

function defaultS3Get(key, dest) {
  execFileSync('aws', ['s3', 'cp', `s3://${S3_BUCKET}/${key}`, dest, '--only-show-errors'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
  });
}

// Upload, download back to a temp file, compare SHA-256. Throws on mismatch.
function storeVerified(file, key, ctx) {
  const local = sha256File(file);
  (ctx.s3Put || defaultS3Put)(file, key);
  const back = path.join(os.tmpdir(), `retire-verify-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    (ctx.s3Get || defaultS3Get)(key, back);
    const remote = sha256File(back);
    if (remote !== local) throw new Error(`S3 copy of ${path.basename(file)} does not match (sha256 ${remote} vs ${local})`);
  } finally {
    fs.rmSync(back, { force: true });
  }
  return { sha256: local, bytes: fs.statSync(file).size, s3: `s3://${S3_BUCKET}/${key}` };
}

function archiveIgnoredFiles(worktree, files, outFile) {
  const list = `${outFile}.list`;
  fs.writeFileSync(list, `${files.join('\n')}\n`);
  try {
    execFileSync(TAR, ['-czf', outFile, '-C', worktree, '-T', list], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
    const listed = execFileSync(TAR, ['-tzf', outFile], { encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 })
      .split(/\r?\n/)
      .filter((l) => l && !l.endsWith('/'))
      .sort();
    const wanted = [...files].sort();
    if (JSON.stringify(listed) !== JSON.stringify(wanted)) {
      throw new Error(`tarball lists ${listed.length} entries, expected exactly ${wanted.length} ignored files`);
    }
  } finally {
    fs.rmSync(list, { force: true });
  }
}

function isAncestorOfMaster(repoRoot, ref, gitFn = git) {
  try {
    gitFn(['merge-base', '--is-ancestor', ref, 'origin/master'], repoRoot);
    return true;
  } catch {
    return false;
  }
}

// Archive one item. Returns the "archived" ledger row; throws (and removes
// nothing) unless every artifact is verified locally and in S3.
function archiveItem(item, ctx) {
  const { repoRoot, archiveDir, day, gitFn = git } = ctx;
  const tipFull = item.kind === 'stash' ? item.sha : gitFn(['rev-parse', `refs/heads/${item.branch}`], repoRoot);
  const id = itemId(item.kind, item.branch || item.sha, tipFull, item.worktree);
  const bundlePath = path.join(archiveDir, `${id}.bundle`);
  const tarPath = path.join(archiveDir, `${id}-ignored.tgz`);
  for (const p of [bundlePath, tarPath]) {
    if (fs.existsSync(p)) throw new Error(`refuse: archive ${path.basename(p)} already exists`);
  }
  const manifest = item.worktree ? contentManifest(item.worktree, gitFn) : null;
  if (manifest && manifest.nestedRepo) throw new Error(`refuse: ${item.worktree} holds a nested repository`);
  const archiveRef = `${ARCHIVE_REF_PREFIX}${id}`;
  const refs = [[archiveRef, tipFull]];
  if (manifest && manifest.snapshot) refs.push([`${archiveRef}-uncommitted`, manifest.snapshot]);
  for (const [ref, sha] of refs) gitFn(['update-ref', ref, sha], repoRoot);
  const row = {
    schema: 'amy.git-retire.v2',
    stage: 'archived',
    at: new Date().toISOString(),
    id,
    kind: item.kind,
    branch: item.branch || null,
    tip: tipFull,
    committedAt: item.committedAt,
    subject: item.subject || '',
    worktree: item.worktree || null,
    uncommittedSnapshot: manifest ? manifest.snapshot : null,
    manifestDigest: manifest ? manifest.digest : null,
    bundle: null,
    tarball: null,
    prerequisites: [],
    prerequisiteSource: 'origin/master',
  };
  try {
    const pending = refs.filter(([ref]) => !isAncestorOfMaster(repoRoot, ref, gitFn));
    fs.mkdirSync(archiveDir, { recursive: true });
    if (pending.length) {
      gitFn(['bundle', 'create', bundlePath, ...pending.map(([ref]) => ref), '^origin/master'], repoRoot, { timeout: 300_000 });
      const verify = gitFn(['bundle', 'verify', bundlePath], repoRoot);
      const heads = gitFn(['bundle', 'list-heads', bundlePath], repoRoot);
      for (const [ref, sha] of pending) {
        if (!heads.includes(`${sha} ${ref}`)) throw new Error(`bundle ${id} does not name ${sha} ${ref}`);
      }
      // `git bundle verify` lists the refs it contains, then the ones it requires.
      const requires = verify.split(/^The bundle requires/m)[1] || '';
      row.prerequisites = [...requires.matchAll(/^([0-9a-f]{40})\b/gm)].map((m) => m[1]);
      for (const sha of row.prerequisites) {
        if (!isAncestorOfMaster(repoRoot, sha, gitFn)) throw new Error(`bundle ${id} needs ${sha}, which is not in origin/master`);
      }
      row.bundle = { path: bundlePath, refs: pending.map(([ref, sha]) => ({ ref, sha })), ...storeVerified(bundlePath, `${S3_PREFIX}/${day}/${id}.bundle`, ctx) };
    }
    if (manifest && manifest.ignored.length) {
      // Classify what is about to leave the PC, then prove the tar holds
      // exactly that: a file added or edited since planning stops the upload.
      const held = classifyIgnored(item.worktree, manifest.ignored);
      if (held) throw new Error(`refuse: ${item.worktree} now holds ${held}`);
      archiveIgnoredFiles(item.worktree, manifest.ignored.map((f) => f.path), tarPath);
      if (contentManifest(item.worktree, gitFn).digest !== manifest.digest) {
        throw new Error(`refuse: ${item.worktree} changed while archiving`);
      }
      row.tarball = { path: tarPath, files: manifest.ignored.length, ...storeVerified(tarPath, `${S3_PREFIX}/${day}/${id}-ignored.tgz`, ctx) };
    }
  } finally {
    for (const [ref] of refs) {
      try {
        gitFn(['update-ref', '-d', ref], repoRoot);
      } catch {}
    }
  }
  row.restore = {
    note: 'Run in the SecondBrain checkout (prerequisites are in origin/master). Arguments are exact; pass them as an argv array.',
    fetch: row.bundle
      ? ['git', 'fetch', row.bundle.path, ...row.bundle.refs.map(({ ref }) => `${ref}:refs/heads/restored/${ref.slice(ARCHIVE_REF_PREFIX.length)}`)]
      : null,
    stashStore: item.kind === 'stash' && row.bundle ? ['git', 'stash', 'store', '-m', 'restored by git-branch-retire', tipFull] : null,
    untar: row.tarball ? [TAR, '-xzf', row.tarball.path, '-C', '<new worktree>'] : null,
  };
  return row;
}

// Re-run every gate on fresh state immediately before removal. Throws on any
// change; returns a description of what it removed.
function retireItem(item, row, ctx) {
  const { repoRoot, gitFn = git } = ctx;
  const parked = gh.readParked(repoRoot);
  if (item.kind === 'stash') {
    gh.assertSafeToClean(repoRoot, item.sha, parked);
    const list = gitFn(['stash', 'list', '--format=%H'], repoRoot).split('\n');
    const index = list.indexOf(item.sha);
    if (index < 0) throw new Error(`stash ${item.sha} is gone already`);
    const slot = `stash@{${index}}`;
    if (gitFn(['rev-parse', slot], repoRoot) !== item.sha) throw new Error(`${slot} moved before drop`);
    gitFn(['stash', 'drop', slot], repoRoot);
    return { droppedStash: item.sha };
  }
  janitor.assertNotPermanentBranch(item.branch);
  gh.assertSafeToClean(repoRoot, item.branch, parked);
  if (gitFn(['rev-parse', `refs/heads/${item.branch}`], repoRoot) !== row.tip) {
    throw new Error(`refuse: ${item.branch} moved after archiving`);
  }
  const removed = {};
  if (item.worktree) {
    const nowMs = ctx.nowMs || Date.now();
    const gate = checkWorktreeGates(item.worktree, {
      nowMs,
      graceMs: (ctx.graceDays ?? GRACE_DAYS) * DAY_MS,
      lockStaleMs: (ctx.lockStaleDays ?? LOCK_STALE_DAYS) * DAY_MS,
      live: ctx.live(),
      processProof: ctx.processProof(),
      coordinatorProof: ctx.coordinatorProof(),
      gitFn,
      locked: item.locked,
      isWorktreeYoungerThan: ctx.isWorktreeYoungerThan,
      worktreeLockAgeMs: ctx.worktreeLockAgeMs,
      worktreeActivityAgeMs: ctx.worktreeActivityAgeMs,
    });
    if (!gate.ok) throw new Error(`refuse: ${item.worktree} failed the ${gate.reason} gate at removal`);
    if (contentManifest(item.worktree, gitFn).digest !== row.manifestDigest) {
      throw new Error(`refuse: ${item.worktree} changed after archiving`);
    }
    if (item.locked) gitFn(['worktree', 'unlock', item.worktree], repoRoot);
    (ctx.stripJunctions || janitor.stripJunctions)(item.worktree);
    gitFn(['worktree', 'remove', '--force', item.worktree], repoRoot);
    removed.worktree = item.worktree;
  }
  gitFn(['branch', '-D', item.branch], repoRoot);
  removed.branch = item.branch;
  return removed;
}

function readLedger(ledger) {
  try {
    return fs
      .readFileSync(ledger, 'utf8')
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
  } catch {
    return [];
  }
}

// Retire-starts with no outcome row: a crash mid-removal. Reported every run
// until a human (or a later run's reconcile) records the outcome.
function interruptedRetirements(rows) {
  const open = new Map();
  for (const r of rows) {
    if (r.stage === 'retire-start') open.set(r.id, r);
    else if (r.stage === 'retired' || r.stage === 'retire-failed' || r.stage === 'reconciled') open.delete(r.id);
  }
  return [...open.values()];
}

function acquireRunLock(lockFile, nowMs = Date.now()) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  try {
    const held = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (nowMs - Date.parse(held.at) < RUN_LOCK_STALE_MS) return false;
    fs.rmSync(lockFile, { force: true });
  } catch {}
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date(nowMs).toISOString() }), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function runRetire(opts = {}) {
  const dataDir = opts.dataDir || defaultDataDir();
  const ledger = path.join(dataDir, 'git-archive', 'retire-ledger.jsonl');
  const priorRows = readLedger(ledger);
  const interrupted = interruptedRetirements(priorRows);
  if (!opts.apply) {
    return { mode: 'dry-run', plan: buildRetirePlan(opts), actions: [], interrupted };
  }
  const lockFile = path.join(dataDir, 'git-archive', 'retire.lock');
  if (!acquireRunLock(lockFile)) {
    return { mode: 'apply', locked: true, plan: { counts: { retirable: 0 }, items: [] }, actions: [], interrupted };
  }
  try {
    const plan = buildRetirePlan(opts);
    const cap = opts.cap || DEFAULT_CAP;
    // The clock that stamps ledger rows, not the classifier's `today` input.
    const day = new Date().toISOString().slice(0, 10);
    // Counted from the ledger as it stands under the lock, not the pre-lock read.
    const usedToday = readLedger(ledger).filter((r) => r.stage === 'retire-start' && String(r.at).slice(0, 10) === day).length;
    const budget = Math.max(0, cap - usedToday);
    const ctx = {
      repoRoot: plan.repoRoot,
      archiveDir: path.join(dataDir, 'git-archive', 'branches', day),
      day,
      gitFn: opts.git || git,
      nowMs: opts.nowMs,
      s3Put: opts.s3Put,
      s3Get: opts.s3Get,
      stripJunctions: opts.stripJunctions,
      graceDays: opts.graceDays,
      lockStaleDays: opts.lockStaleDays,
      isWorktreeYoungerThan: opts.isWorktreeYoungerThan,
      worktreeLockAgeMs: opts.worktreeLockAgeMs,
      worktreeActivityAgeMs: opts.worktreeActivityAgeMs,
      live: () => (opts.readLiveWorktrees || gh.readLiveWorktrees)({ nowMs: Date.now(), tasksDir: opts.tasksDir }),
      processProof: opts.readProcessProof || readProcessProof,
      coordinatorProof: opts.readCoordinatorProof || readCoordinatorProof,
    };
    const append = (row) => {
      fs.mkdirSync(path.dirname(ledger), { recursive: true });
      fs.appendFileSync(ledger, `${JSON.stringify(row)}\n`);
    };
    const actions = [];
    let attempts = 0;
    let retired = 0;
    for (const item of plan.items) {
      if (attempts >= budget) break;
      const ref = item.branch || item.sha;
      let row;
      try {
        row = archiveItem(item, ctx);
        append(row);
      } catch (e) {
        actions.push({ ref, ok: false, stage: 'archive', error: String((e && e.message) || e).split('\n')[0] });
        continue;
      }
      attempts += 1;
      append({ schema: row.schema, stage: 'retire-start', at: new Date().toISOString(), id: row.id });
      try {
        const removed = retireItem(item, row, ctx);
        append({ schema: row.schema, stage: 'retired', at: new Date().toISOString(), id: row.id, removed });
        actions.push({ ref, ok: true, id: row.id });
        retired += 1;
      } catch (e) {
        const error = String((e && e.message) || e).split('\n')[0];
        const partial = {
          worktreeStillPresent: item.worktree ? fs.existsSync(item.worktree) : null,
          branchStillPresent: item.branch ? Boolean(ctx.gitFn(['branch', '--list', item.branch], ctx.repoRoot)) : null,
        };
        append({ schema: row.schema, stage: 'retire-failed', at: new Date().toISOString(), id: row.id, error, partial });
        actions.push({ ref, ok: false, stage: 'retire', id: row.id, error, partial });
      }
    }
    return { mode: 'apply', cap, budget, attempts, retired, ledger, plan, actions, interrupted };
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

function summarize(result) {
  const { plan } = result;
  return {
    mode: result.mode,
    locked: Boolean(result.locked),
    retirable: plan.counts.retirable,
    skipped: Object.fromEntries(Object.entries(plan.counts).filter(([k]) => k !== 'retirable')),
    attempts: result.attempts || 0,
    retired: result.retired || 0,
    failures: (result.actions || []).filter((a) => !a.ok),
    interrupted: (result.interrupted || []).map((r) => r.id),
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const capArg = args.find((a) => a.startsWith('--cap='));
  const result = runRetire({
    cwd: process.cwd(),
    apply: args.includes('--apply'),
    cap: capArg ? Number(capArg.split('=')[1]) : DEFAULT_CAP,
  });
  const summary = summarize(result);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.failures.length || summary.interrupted.length ? 1 : 0);
}

module.exports = {
  buildRetirePlan,
  runRetire,
  archiveItem,
  retireItem,
  snapshotDirtyWorktree,
  contentManifest,
  ignoredInventory,
  classifyIgnored,
  archiveIgnoredFiles,
  readProcessProof,
  readCoordinatorProof,
  worktreeLockAgeMs,
  worktreeActivityAgeMs,
  interruptedRetirements,
  itemId,
  summarize,
  REGENERABLE_IGNORED,
  ARCHIVABLE_IGNORED,
  SECRET_IGNORED,
  SECRET_CONTENT,
  GRACE_DAYS,
  LOCK_STALE_DAYS,
  S3_BUCKET,
};
