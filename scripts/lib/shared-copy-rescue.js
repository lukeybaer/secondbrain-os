'use strict';

// shared-copy-rescue.js (owner decision)
//
// Any file left changed in the shared checkout turns the Dev Ops and Laws of
// Amy Gravity rows red overnight. The write guards miss script-driven writes,
// Codex outside its wrapper, and PC scheduled jobs, so strays still happen.
// Owner decision: do not page him for them. Copy each stray into a new rescue
// worktree and branch, commit it there, verify the commit, and only then
// restore the shared checkout to clean for exactly those paths. The branch
// then stays as its own branch until it lands or the nightly retire archives it.
//
// Never lose a byte: every step before the restore leaves the shared checkout
// untouched on failure. A file edited in the last 30 minutes is a live session
// mid-edit and is never touched. A path that changes between the copy and the
// restore is kept in place (it is still preserved on the branch).
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MIN_AGE_MS = 30 * 60 * 1000;
const LEDGER_REL = path.join('agent', 'shared-copy-rescue.json');
const TARGET_BRANCH = 'master';

function defaultSessionsDir() {
  return process.env.SB_SESSIONS_DIR || path.join(os.homedir(), 'Documents', 'GitHub', 'sb-sessions');
}

function git(cwd, args, input) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120000, input, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function ledgerPath(dataDir) {
  return path.join(dataDir, LEDGER_REL);
}

function readLedger(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(dataDir), 'utf8'));
    if (parsed && Array.isArray(parsed.entries)) return parsed;
  } catch { /* absent or unreadable ledger is an empty ledger */ }
  return { entries: [], lastRun: null };
}

function writeLedger(dataDir, ledger) {
  const file = ledgerPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, file);
}

function isPrimaryCheckout(root) {
  try { return fs.statSync(path.join(root, '.git')).isDirectory(); } catch { return false; }
}

// porcelain v1 -z: "XY path\0", and for renames "XY new\0old\0".
function parseStatusZ(raw) {
  const parts = String(raw || '').split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const rel = entry.slice(3);
    if (code[0] === 'R' || code[0] === 'C') { out.push({ code, rel, from: parts[i + 1] || '' }); i += 1; } else out.push({ code, rel });
  }
  return out;
}

function gitStateBlocked(root) {
  const dir = path.join(root, '.git');
  return ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'index.lock']
    .find((name) => fs.existsSync(path.join(dir, name))) || null;
}

function stamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').toLowerCase();
}

function record(dataDir, ledger, patch) {
  ledger.lastRun = { at: new Date().toISOString(), ...patch };
  try { writeLedger(dataDir, ledger); } catch { /* the ledger is advisory; the branch is the proof */ }
}

function rescueSharedStrays({ mainRoot, dataDir, sessionsDir = defaultSessionsDir(), now = new Date(), minAgeMs = MIN_AGE_MS } = {}) {
  if (!mainRoot || !dataDir) return { ok: false, action: 'skipped', reason: 'mainRoot and dataDir are required' };
  if (!isPrimaryCheckout(mainRoot)) return { ok: true, action: 'skipped', reason: 'not a primary git checkout' };
  const ledger = readLedger(dataDir);
  const blocked = gitStateBlocked(mainRoot);
  if (blocked) return { ok: true, action: 'skipped', reason: `git operation in progress (${blocked})` };
  const head = git(mainRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!head.ok || head.stdout.trim() !== TARGET_BRANCH) {
    return { ok: true, action: 'skipped', reason: `shared checkout is not on ${TARGET_BRANCH}` };
  }
  const status = git(mainRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!status.ok) {
    record(dataDir, ledger, { outcome: 'failed', error: `git status failed: ${status.stderr.slice(0, 200)}` });
    return { ok: false, action: 'failed', reason: 'git status failed' };
  }
  const entries = parseStatusZ(status.stdout);
  if (!entries.length) {
    record(dataDir, ledger, { outcome: 'clean' });
    return { ok: true, action: 'clean' };
  }

  // A deleted file has no mtime, and git refreshes the index on every status, so
  // a deletion's age is the first time this job saw it missing.
  const seenBefore = ledger.seenDeleted && typeof ledger.seenDeleted === 'object' ? ledger.seenDeleted : {};
  const seenNow = {};
  const eligible = [];
  const deferred = [];
  const problems = [];
  for (const entry of entries) {
    if (entry.code.includes('U') || entry.code === 'AA' || entry.code === 'DD') { problems.push(`${entry.rel}: conflicted`); continue; }
    if (entry.from) { problems.push(`${entry.rel}: renamed (left for a person)`); continue; }
    const abs = path.join(mainRoot, entry.rel);
    const deleted = entry.code.includes('D') && !fs.existsSync(abs);
    let st = null;
    try { st = fs.lstatSync(abs); } catch { /* deleted */ }
    if (!deleted && (!st || !st.isFile())) { problems.push(`${entry.rel}: not a regular file`); continue; }
    if (deleted) seenNow[entry.rel] = seenBefore[entry.rel] || now.toISOString();
    const mtime = deleted ? Date.parse(seenNow[entry.rel]) : st.mtimeMs;
    if (now.getTime() - mtime < minAgeMs) { deferred.push(entry.rel); continue; }
    eligible.push({ ...entry, deleted, abs, mtimeMs: mtime, sha256: deleted ? null : sha256File(abs) });
  }
  ledger.seenDeleted = seenNow;
  if (!eligible.length) {
    record(dataDir, ledger, { outcome: deferred.length ? 'deferred' : 'unrescuable', deferred: deferred.length, problems: problems.slice(0, 5) });
    return { ok: !problems.length, action: deferred.length ? 'deferred' : 'unrescuable', deferred, problems };
  }

  const id = stamp(now);
  const branch = `session/rescue-shared-${id}`;
  const worktree = path.join(sessionsDir, `rescue-shared-${id}`);
  const abort = (error) => {
    // Nothing in the shared checkout has been touched yet; drop our own scaffolding.
    git(mainRoot, ['worktree', 'remove', '--force', worktree]);
    git(mainRoot, ['branch', '-D', branch]);
    try { fs.rmSync(worktree, { recursive: true, force: true }); } catch { /* best effort */ }
    record(dataDir, ledger, { outcome: 'failed', error: String(error).slice(0, 300) });
    return { ok: false, action: 'failed', reason: String(error), sharedTouched: false };
  };

  try { fs.mkdirSync(sessionsDir, { recursive: true }); } catch (error) { return abort(error.message); }
  const baseHead = git(mainRoot, ['rev-parse', 'HEAD']).stdout.trim();
  const add = git(mainRoot, ['worktree', 'add', '-b', branch, worktree, baseHead]);
  if (!add.ok) return abort(`worktree add failed: ${add.stderr.slice(0, 200)}`);

  for (const f of eligible) {
    if (f.deleted) {
      const rm = git(worktree, ['rm', '-q', '--', f.rel]);
      if (!rm.ok) return abort(`could not stage deletion of ${f.rel}: ${rm.stderr.slice(0, 120)}`);
      continue;
    }
    const dest = path.join(worktree, f.rel);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f.abs, dest);
      if (sha256File(dest) !== f.sha256) return abort(`copy of ${f.rel} did not match the source bytes`);
    } catch (error) { return abort(`copy of ${f.rel} failed: ${error.message}`); }
    const staged = git(worktree, ['add', '-f', '--', f.rel]);
    if (!staged.ok) return abort(`could not stage ${f.rel}: ${staged.stderr.slice(0, 120)}`);
  }
  const message = `rescue: ${eligible.length} stray file(s) from the shared checkout at ${now.toISOString()}\n\n${eligible.map((f) => `- ${f.deleted ? 'deleted' : 'changed'}: ${f.rel}`).join('\n')}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  const commit = git(worktree, ['-c', 'user.name=Amy', '-c', 'user.email=amy@secondbrain.local', 'commit', '--no-verify', '-q', '-F', '-'], message);
  if (!commit.ok) return abort(`commit failed: ${commit.stderr.slice(0, 200)}`);
  const commitSha = git(worktree, ['rev-parse', 'HEAD']).stdout.trim();

  // Verify the commit holds the exact bytes before anything is restored.
  for (const f of eligible) {
    if (f.deleted) {
      if (git(worktree, ['cat-file', '-e', `${commitSha}:${f.rel}`]).ok) return abort(`commit still contains deleted ${f.rel}`);
      continue;
    }
    const blob = git(mainRoot, ['rev-parse', `${commitSha}:${f.rel}`]);
    const expect = git(mainRoot, ['hash-object', '--', f.abs]);
    if (!blob.ok || !expect.ok || blob.stdout.trim() !== expect.stdout.trim()) return abort(`commit does not hold the source bytes of ${f.rel}`);
  }

  const files = eligible.map((f) => ({ path: f.rel, deleted: f.deleted, sha256: f.sha256 }));
  const entry = { branch, worktree, commit: commitSha, rescuedAt: now.toISOString(), status: 'committed', files, deferred, problems };
  ledger.entries.push(entry);
  record(dataDir, ledger, { outcome: 'committed', branch });

  // Restore exactly the rescued paths, each only if it is still the bytes we saved.
  const restored = [];
  const kept = [];
  for (const f of eligible) {
    const unchanged = f.deleted ? !fs.existsSync(f.abs) : (fs.existsSync(f.abs) && sha256File(f.abs) === f.sha256);
    if (!unchanged) { kept.push(`${f.rel}: changed during rescue, left in place`); continue; }
    const tracked = git(mainRoot, ['cat-file', '-e', `HEAD:${f.rel}`]).ok;
    let done;
    if (tracked) {
      done = git(mainRoot, ['restore', '--source=HEAD', '--staged', '--worktree', '--', f.rel]).ok;
    } else {
      done = git(mainRoot, ['rm', '-f', '-q', '--cached', '--ignore-unmatch', '--', f.rel]).ok;
      try { fs.rmSync(f.abs, { force: true }); } catch { done = false; }
    }
    (done ? restored : kept).push(done ? f.rel : `${f.rel}: restore failed`);
  }
  entry.restored = restored;
  entry.kept = kept;
  entry.status = kept.length ? 'restore-failed' : 'rescued';
  record(dataDir, ledger, { outcome: entry.status, branch });
  return { ok: !kept.length, action: entry.status, branch, worktree, commit: commitSha, restored, kept, deferred, problems };
}

// Rescue branches that still hold unfinished work: the branch exists and has
// not reached origin/master. Failures stay listed so nothing is hidden.
function activeRescues({ mainRoot, dataDir }) {
  const ledger = readLedger(dataDir);
  const active = [];
  for (const entry of ledger.entries) {
    if (!entry || !entry.branch) continue;
    if (mainRoot && isPrimaryCheckout(mainRoot)) {
      if (!git(mainRoot, ['rev-parse', '--verify', '-q', `refs/heads/${entry.branch}`]).ok) continue;
      if (git(mainRoot, ['merge-base', '--is-ancestor', entry.branch, `origin/${TARGET_BRANCH}`]).ok) continue;
    }
    active.push({ branch: entry.branch, rescuedAt: entry.rescuedAt, status: entry.status, files: (entry.files || []).length, kept: entry.kept || [] });
  }
  return { active, lastRun: ledger.lastRun || null };
}

module.exports = { MIN_AGE_MS, LEDGER_REL, rescueSharedStrays, activeRescues, readLedger, parseStatusZ };
