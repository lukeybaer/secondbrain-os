#!/usr/bin/env node
'use strict';

/*
 * EC2 disk janitor (The owner approved C6, 2026-10-23).
 *
 * Reclaims four kinds of regenerable disk on the Amy EC2 host and nothing else:
 *   1. backup-restore-temp : leftover scratch directories of the nightly
 *      backup-restore proof (killed runs). The ONLY path under the protected
 *      data directory this script may touch, and only the exact
 *      <data>/tmp/backup-restore/secondbrain-backup-restore-XXXXXX children.
 *   2. hf-cache            : the Hugging Face download cache. Production
 *      transcription reads its own model root with HF offline, so this cache
 *      only re-downloads if something asks for it.
 *   3. releases            : atomic release directories beyond the newest N
 *      (default 5). Selection is delegated to prune-atomic-releases.js
 *      (live target and process-owned releases are kept) and additionally
 *      keeps any release still named by the crontab, a systemd unit, the
 *      PM2 dump or the live PM2 list. If any of those cannot be read (and is
 *      not proven absent), no release is removed.
 *   4. worktrees           : git worktrees under the sb-sessions root whose
 *      HEAD is an ancestor of origin/master. Clean ones are removed. Dirty
 *      ones hold uncommitted edits (agentic-heal attempts that never landed),
 *      so they are removed only with --salvage-dirty, which first writes the
 *      diff and untracked files to the salvage root, verifies the archive,
 *      and keeps any worktree whose salvage cannot be completed and verified.
 *
 * It NEVER touches /opt/secondbrain/data (apart from item 1), raw archives,
 * S3, .codex, or any AWS resource. It never runs git fetch. Dry-run is the
 * default; --apply acts. When disk use is above the alert threshold after an
 * --apply (or with --alert-only) it sends ONE chat line through the
 * existing notifyWithFallback helper, deduped per Central day.
 *
 * Weekly cron line (Sunday 03:30 CT; the crontab already sets CRON_TZ):
 *   30 3 * * 0 cd /opt/secondbrain && flock -n /tmp/secondbrain-ec2-disk-janitor.lock timeout --kill-after=30s 90m /usr/bin/node scripts/ec2-disk-janitor.js --apply >> /opt/secondbrain/logs/ec2-disk-janitor.log 2>&1
 *
 * Usage:
 *   node scripts/ec2-disk-janitor.js                 # dry-run plan
 *   node scripts/ec2-disk-janitor.js --apply         # act
 *   node scripts/ec2-disk-janitor.js --apply --salvage-dirty
 *   node scripts/ec2-disk-janitor.js --alert-only    # threshold check only
 *   flags: --json --only a,b --keep-releases N --min-age-hours N
 *          --alert-threshold PCT --no-alert
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const CATEGORIES = ['backup-restore-temp', 'hf-cache', 'releases', 'worktrees'];
const BACKUP_RESTORE_NAME = /^secondbrain-backup-restore-[A-Za-z0-9]{6}$/;
const RELEASE_REF = /[0-9a-f]{40}(?:\.reland-\d+-\d+)?/;
const GIB = 1024 ** 3;
const DEFAULT_KEEP_RELEASES = 5;
const DEFAULT_ALERT_PCT = 70;
const SALVAGE_UNTRACKED_FILE_MAX = 1024 * 1024;
const SALVAGE_UNTRACKED_TOTAL_MAX = 50 * 1024 * 1024;

function scriptsDir() {
  return path.resolve(process.env.SB_JANITOR_SCRIPTS_DIR || __dirname);
}

function defaultOptions(env = process.env) {
  const home = env.HOME || os.homedir();
  return {
    apply: false,
    json: false,
    alertOnly: false,
    noAlert: false,
    salvageDirty: false,
    only: [...CATEGORIES],
    keepReleases: Number(env.SB_JANITOR_KEEP_RELEASES || DEFAULT_KEEP_RELEASES),
    minAgeHours: Number(env.SB_JANITOR_MIN_AGE_HOURS || 24),
    alertThresholdPct: Number(env.SB_JANITOR_ALERT_PCT || DEFAULT_ALERT_PCT),
    dataDir: env.SB_JANITOR_DATA_DIR || '/opt/secondbrain/data',
    releasesRoot: env.SB_RELEASES_ROOT || '/opt/secondbrain-releases',
    liveLink: env.SB_OPT_LINK || '/opt/secondbrain',
    sessionsRoot: env.SB_SESSIONS_ROOT || path.join(home, 'sb-sessions'),
    repo: env.SB_JANITOR_REPO || path.join(home, 'secondbrain-current'),
    baseRef: env.SB_JANITOR_BASE_REF || 'origin/master',
    salvageRoot: env.SB_SALVAGE_ROOT || path.join(home, 'sb-sessions-salvage'),
    hfRoot: env.HF_HOME || path.join(home, '.cache', 'huggingface'),
    pm2Home: env.PM2_HOME || null, // null: <home>/.pm2
    systemdUnitDir: '/etc/systemd/system',
    diskPath: env.SB_JANITOR_DISK_PATH || '/',
    home,
  };
}

function parseArgs(argv, env = process.env) {
  const opts = defaultOptions(env);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--dry-run') opts.apply = false;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--alert-only') opts.alertOnly = true;
    else if (arg === '--no-alert') opts.noAlert = true;
    else if (arg === '--salvage-dirty') opts.salvageDirty = true;
    else if (arg === '--only') opts.only = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--keep-releases') opts.keepReleases = Number(argv[++i]);
    else if (arg === '--min-age-hours') opts.minAgeHours = Number(argv[++i]);
    else if (arg === '--alert-threshold') opts.alertThresholdPct = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const c of opts.only) {
    if (!CATEGORIES.includes(c)) throw new Error(`unknown category: ${c}`);
  }
  if (!Number.isSafeInteger(opts.keepReleases) || opts.keepReleases < 2) {
    throw new Error('--keep-releases must be an integer of at least 2');
  }
  if (!Number.isFinite(opts.minAgeHours) || opts.minAgeHours < 0) throw new Error('--min-age-hours must be >= 0');
  if (!Number.isFinite(opts.alertThresholdPct) || opts.alertThresholdPct <= 0 || opts.alertThresholdPct > 100) {
    throw new Error('--alert-threshold must be between 1 and 100');
  }
  return opts;
}

// ---------------------------------------------------------------- utilities

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isInside(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(`${p}${path.sep}`);
}

function walkBytes(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let names = [];
  try {
    names = fs.readdirSync(p);
  } catch {
    return 0;
  }
  for (const n of names) total += walkBytes(path.join(p, n));
  return total;
}

function dirBytes(target, { useDu = process.platform !== 'win32' } = {}) {
  if (useDu) {
    try {
      const out = execFileSync('du', ['-sk', '--', target], {
        encoding: 'utf8',
        timeout: 10 * 60 * 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const kb = Number(String(out).split(/\s/)[0]);
      if (Number.isFinite(kb)) return kb * 1024;
    } catch (error) {
      const kb = Number(String(error?.stdout || '').split(/\s/)[0]);
      if (Number.isFinite(kb) && kb > 0) return kb * 1024;
    }
  }
  return walkBytes(target);
}

function diskUsage(target) {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const s = fs.statfsSync(target, { bigint: true });
    const bsize = Number(s.bsize);
    const total = Number(s.blocks) * bsize;
    const avail = Number(s.bavail) * bsize;
    const used = total - Number(s.bfree) * bsize;
    const pct = used + avail > 0 ? (used / (used + avail)) * 100 : 0;
    return { totalBytes: total, usedBytes: used, availBytes: avail, pct: Math.round(pct * 10) / 10 };
  } catch {
    return null;
  }
}

function fmtGb(bytes) {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

// Paths held open (cwd or file descriptor) by any process we can inspect.
// Anything we cannot enumerate makes proof unknown, which blocks deletion of
// every category that needs it.
function readProcessPaths({ procRoot = '/proc', fsApi = fs, platform = process.platform } = {}) {
  const paths = new Set();
  if (platform !== 'linux') return { known: false, paths };
  let pids = [];
  try {
    pids = fsApi.readdirSync(procRoot).filter((n) => /^\d+$/.test(n));
  } catch {
    return { known: false, paths };
  }
  const benign = new Set(['ENOENT', 'EACCES', 'EPERM', 'ESRCH', 'ENOTDIR']);
  for (const pid of pids) {
    try {
      paths.add(path.resolve(fsApi.readlinkSync(path.join(procRoot, pid, 'cwd'))));
    } catch (error) {
      if (!benign.has(error?.code)) return { known: false, paths };
    }
    let fds = [];
    try {
      fds = fsApi.readdirSync(path.join(procRoot, pid, 'fd'));
    } catch (error) {
      if (!benign.has(error?.code)) return { known: false, paths };
      continue;
    }
    for (const fd of fds) {
      try {
        const target = fsApi.readlinkSync(path.join(procRoot, pid, 'fd', fd));
        if (target.startsWith('/')) paths.add(path.resolve(target));
      } catch (error) {
        if (!benign.has(error?.code)) return { known: false, paths };
      }
    }
  }
  return { known: true, paths };
}

function pathInUse(target, proof) {
  const root = path.resolve(target);
  const prefix = `${root}${path.sep}`;
  for (const p of proof.paths || []) {
    if (p === root || p.startsWith(prefix)) return true;
  }
  return false;
}

// Central deletion guard. Every removal in this file goes through it.
function guardTarget(category, target, ctx) {
  const resolved = path.resolve(target);
  const segments = resolved.split(/[\\/]+/);
  if (segments.includes('.codex')) throw new Error(`janitor guard: refusing .codex path ${resolved}`);
  const dataReal = realpathOrNull(ctx.dataDir);
  const inData = (p) => [ctx.dataDir, dataReal].filter(Boolean).some((d) => isInside(p, d));
  if (category === 'backup-restore-temp') {
    const parent = dataReal && path.join(dataReal, 'tmp', 'backup-restore');
    if (!parent || path.dirname(resolved) !== parent || !BACKUP_RESTORE_NAME.test(path.basename(resolved))) {
      throw new Error(`janitor guard: ${resolved} is not a backup-restore scratch directory`);
    }
    return resolved;
  }
  if (inData(resolved)) throw new Error(`janitor guard: refusing data path ${resolved} for ${category}`);
  if (path.parse(resolved).root === resolved) throw new Error('janitor guard: refusing filesystem root');
  return resolved;
}

function removeTree(category, target, ctx) {
  const safe = guardTarget(category, target, ctx);
  fs.rmSync(safe, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
}

// ------------------------------------------------------- backup-restore-temp

function planBackupRestoreTemp(ctx) {
  const out = { category: 'backup-restore-temp', status: 'ok', items: [], skipped: [], note: '' };
  const dataReal = realpathOrNull(ctx.dataDir);
  const parent = dataReal && path.join(dataReal, 'tmp', 'backup-restore');
  if (!parent || !fs.existsSync(parent)) return { ...out, status: 'absent', note: 'no backup-restore scratch directory' };
  if (!ctx.processProof.known) return { ...out, status: 'blocked', note: 'process proof unavailable' };
  const minAgeMs = ctx.minAgeHours * 3600 * 1000;
  for (const name of fs.readdirSync(parent)) {
    const full = path.join(parent, name);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (!BACKUP_RESTORE_NAME.test(name) || !st.isDirectory() || st.isSymbolicLink()) {
      out.skipped.push({ path: full, reason: 'name-or-type-mismatch' });
      continue;
    }
    if (realpathOrNull(full) !== full) {
      out.skipped.push({ path: full, reason: 'not-a-real-child' });
      continue;
    }
    if (ctx.now - st.mtimeMs < minAgeMs) {
      out.skipped.push({ path: full, reason: 'recent' });
      continue;
    }
    if (pathInUse(full, ctx.processProof)) {
      out.skipped.push({ path: full, reason: 'in-use' });
      continue;
    }
    out.items.push({ path: full, bytes: ctx.sizeOf(full), reason: 'abandoned restore scratch' });
  }
  return out;
}

// ------------------------------------------------------------------ hf-cache

function planHfCache(ctx) {
  const out = { category: 'hf-cache', status: 'ok', items: [], skipped: [], note: '' };
  const root = ctx.hfRoot;
  if (!fs.existsSync(root)) return { ...out, status: 'absent', note: 'no Hugging Face cache' };
  if (path.basename(path.resolve(root)) !== 'huggingface') {
    return { ...out, status: 'blocked', note: 'cache root is not a huggingface directory' };
  }
  const real = realpathOrNull(root);
  if (!real || real !== path.resolve(root)) return { ...out, status: 'blocked', note: 'cache root is a link or moved' };
  if (!ctx.processProof.known) return { ...out, status: 'blocked', note: 'process proof unavailable' };
  for (const name of fs.readdirSync(real)) {
    const full = path.join(real, name);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      out.skipped.push({ path: full, reason: 'symlink' });
      continue;
    }
    if (pathInUse(full, ctx.processProof)) {
      out.skipped.push({ path: full, reason: 'in-use' });
      continue;
    }
    out.items.push({ path: full, bytes: st.isDirectory() ? ctx.sizeOf(full) : st.size, reason: 'regenerable download cache' });
  }
  return out;
}

// ------------------------------------------------------------------ releases

// Default runner for reference discovery. Never throws: each caller decides
// which outcomes prove state.
function runCommand(cmd, args, { timeout = 15000 } = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: res.status,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
    error: res.error ? res.error.code || res.error.message : null,
  };
}

function describeRun(res) {
  return res.error || String(res.stderr || '').trim().split(/\r?\n/)[0] || `exit ${res.status}`;
}

// pm2 can print daemon notices before the JSON array; parse from the first
// line that opens it. Anything that is not an array is unproven.
function parsePm2Jlist(text) {
  const raw = String(text || '');
  const start = raw.startsWith('[') ? 0 : raw.indexOf('\n[') + 1;
  if (raw[start] !== '[') return null;
  try {
    const list = JSON.parse(raw.slice(start));
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

// Releases a future invocation still names. Fails closed: every source must
// be read, or proven absent by a specific signal. Anything else lands in
// unproven, and planReleases then deletes no release.
//   crontab : exit 0, or exit 1 with "no crontab for" (proven empty)
//   pm2     : no PM2 home (pm2 never ran), else dump.pm2 AND live jlist
//   systemd : unit dir ENOENT (proven empty), else every unit file read
function referencedReleaseNames(ctx) {
  const run = ctx.runCommand || runCommand;
  const pm2Home = ctx.pm2Home || path.join(ctx.home, '.pm2');
  const unitDir = ctx.systemdUnitDir || '/etc/systemd/system';
  const names = new Set();
  const unproven = [];
  const rootPattern = ctx.releasesRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${rootPattern}/(${RELEASE_REF.source})`, 'g');
  const scan = (text) => {
    for (const m of String(text || '').matchAll(re)) names.add(m[1]);
  };

  // crontab
  const cron = run('crontab', ['-l'], { timeout: 15000 });
  const cronEmpty = cron.status === 1 && !cron.error && /no crontab for/i.test(cron.stderr);
  if (cron.status === 0 && !cron.error) scan(cron.stdout);
  else if (!cronEmpty) unproven.push(`crontab: ${describeRun(cron)}`);

  // pm2: ENOENT on the home is the only proven-absent signal.
  let pm2HomeStat = null;
  try {
    pm2HomeStat = fs.statSync(pm2Home);
  } catch (error) {
    if (error.code !== 'ENOENT') unproven.push(`pm2 home: ${error.code || error.message}`);
  }
  if (pm2HomeStat && !pm2HomeStat.isDirectory()) unproven.push('pm2 home: not a directory');
  if (pm2HomeStat && pm2HomeStat.isDirectory()) {
    try {
      scan(fs.readFileSync(path.join(pm2Home, 'dump.pm2'), 'utf8'));
    } catch (error) {
      unproven.push(`pm2 dump: ${error.code || error.message}`);
    }
    const live = run('pm2', ['jlist'], { timeout: 15000 });
    const ran = live.status === 0 && !live.error;
    const list = ran ? parsePm2Jlist(live.stdout) : null;
    if (!list) unproven.push(`pm2 jlist: ${ran ? 'unparseable output' : describeRun(live)}`);
    for (const proc of list || []) {
      const env = (proc && proc.pm2_env) || {};
      for (const v of [env.pm_cwd, env.pm_exec_path, env.args, env.cwd]) scan(typeof v === 'string' ? v : JSON.stringify(v ?? ''));
    }
  }

  // systemd: ENOENT on the unit dir is the only proven-absent signal.
  let units = [];
  try {
    units = fs.readdirSync(unitDir);
  } catch (error) {
    if (error.code !== 'ENOENT') unproven.push(`systemd dir: ${error.code || error.message}`);
  }
  for (const f of units) {
    if (!/\.(service|timer)$/.test(f)) continue;
    try {
      scan(fs.readFileSync(path.join(unitDir, f), 'utf8'));
    } catch (error) {
      unproven.push(`systemd ${f}: ${error.code || error.message}`);
    }
  }
  return { names, proven: unproven.length === 0, unproven };
}

function planReleases(ctx) {
  const out = { category: 'releases', status: 'ok', items: [], skipped: [], note: '' };
  if (!fs.existsSync(ctx.releasesRoot) || !fs.existsSync(ctx.liveLink)) {
    return { ...out, status: 'absent', note: 'no release layout on this host' };
  }
  const { buildPlan } = require(path.join(scriptsDir(), 'prune-atomic-releases.js'));
  const plan = buildPlan({
    releasesRoot: ctx.releasesRoot,
    liveLink: ctx.liveLink,
    keep: ctx.keepReleases,
    processCwdProof: { known: ctx.processProof.known, cwds: ctx.processProof.paths },
  });
  if (!plan.processCwdProofKnown) return { ...out, status: 'blocked', note: 'process proof unavailable' };
  const refs = ctx.referencedReleases();
  // Unproven references block the whole category: status is not 'ok', so the
  // apply loop in run() removes no release.
  if (!refs || refs.proven !== true || !(refs.names instanceof Set)) {
    const why = `release-references-unproven: ${(refs && Array.isArray(refs.unproven) && refs.unproven.join('; ')) || 'no proof returned'}`;
    return {
      ...out,
      status: 'blocked',
      items: [],
      skipped: plan.remove.map((row) => ({ path: row.path, reason: why })),
      note: why,
    };
  }
  for (const row of plan.remove) {
    if (refs.names.has(row.name)) {
      out.skipped.push({ path: row.path, reason: 'referenced-by-crontab-systemd-or-pm2' });
      continue;
    }
    out.items.push({ path: row.path, bytes: ctx.sizeOf(row.path), reason: `beyond newest ${ctx.keepReleases}` });
  }
  for (const p of plan.protectedByProcess) out.skipped.push({ path: p, reason: 'process-owned' });
  out.note = `live=${path.basename(plan.live)} candidates=${plan.candidateCount}`;
  return out;
}

// ----------------------------------------------------------------- worktrees

function gitIn(cwd, args, { allowFail = false, raw = false } = {}) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: raw ? 'buffer' : 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch (error) {
    if (allowFail) return null;
    throw error;
  }
}

function parseWorktreeList(text) {
  return String(text || '')
    .trim()
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((block) => {
      const row = { locked: false, prunable: false, detached: false, branch: '' };
      for (const line of block.split(/\r?\n/)) {
        const [key, ...rest] = line.split(' ');
        const val = rest.join(' ');
        if (key === 'worktree') row.path = val;
        else if (key === 'HEAD') row.head = val;
        else if (key === 'branch') row.branch = val;
        else if (key === 'detached') row.detached = true;
        else if (key === 'locked') row.locked = true;
        else if (key === 'prunable') row.prunable = true;
      }
      return row;
    })
    .filter((r) => r.path);
}

function worktreeActivityMs(wt) {
  let latest = 0;
  const bump = (p) => {
    try {
      latest = Math.max(latest, fs.statSync(p).mtimeMs);
    } catch {
      /* missing */
    }
  };
  bump(wt);
  const gitdir = gitIn(wt, ['rev-parse', '--absolute-git-dir'], { allowFail: true });
  if (gitdir) {
    bump(path.join(gitdir.trim(), 'HEAD'));
    bump(path.join(gitdir.trim(), 'index'));
  }
  return latest;
}

function planWorktrees(ctx) {
  const out = {
    category: 'worktrees',
    status: 'ok',
    items: [],
    skipped: [],
    note: '',
    counts: { registered: 0, merged: 0, mergedClean: 0, mergedDirty: 0, unmerged: 0, prunable: 0 },
  };
  const root = realpathOrNull(ctx.sessionsRoot);
  if (!root || !fs.existsSync(ctx.repo)) return { ...out, status: 'absent', note: 'no sb-sessions worktrees on this host' };
  if (!ctx.processProof.known) return { ...out, status: 'blocked', note: 'process proof unavailable' };
  if (gitIn(ctx.repo, ['rev-parse', '--verify', '--quiet', `${ctx.baseRef}^{commit}`], { allowFail: true }) === null) {
    return { ...out, status: 'blocked', note: `base ref ${ctx.baseRef} not found (janitor never fetches)` };
  }
  const rows = parseWorktreeList(gitIn(ctx.repo, ['worktree', 'list', '--porcelain']));
  const minAgeMs = ctx.minAgeHours * 3600 * 1000;
  for (const row of rows) {
    const wtPath = path.resolve(row.path);
    const real = realpathOrNull(wtPath);
    if (!real) {
      out.counts.prunable += 1;
      continue;
    }
    if (path.dirname(real) !== root) continue; // main worktree and anything outside the sessions root
    out.counts.registered += 1;
    if (row.locked) {
      out.skipped.push({ path: real, reason: 'locked' });
      continue;
    }
    const merged = gitIn(ctx.repo, ['merge-base', '--is-ancestor', row.head, ctx.baseRef], { allowFail: true }) !== null;
    if (!merged) {
      out.counts.unmerged += 1;
      continue;
    }
    out.counts.merged += 1;
    if (pathInUse(real, ctx.processProof)) {
      out.skipped.push({ path: real, reason: 'in-use' });
      continue;
    }
    if (ctx.now - worktreeActivityMs(real) < minAgeMs) {
      out.skipped.push({ path: real, reason: 'recent' });
      continue;
    }
    const status = gitIn(real, ['status', '--porcelain'], { allowFail: true });
    if (status === null) {
      out.skipped.push({ path: real, reason: 'status-failed' });
      continue;
    }
    const dirty = realStatusLines(real, status).length > 0;
    if (dirty) out.counts.mergedDirty += 1;
    else out.counts.mergedClean += 1;
    if (dirty && !ctx.salvageDirty) {
      out.skipped.push({ path: real, reason: 'dirty-needs-salvage-dirty' });
      continue;
    }
    out.items.push({
      path: real,
      bytes: ctx.sizeOf(real),
      dirty,
      reason: dirty ? 'merged, uncommitted edits salvaged first' : 'merged and clean',
    });
  }
  return out;
}

// A top-level symlink (node_modules) that git lists as untracked is shared
// state, not work: it is unlinked, never salvaged, so it does not make the
// worktree dirty.
function realStatusLines(wt, status) {
  return String(status)
    .split(String.fromCharCode(10))
    .filter((line) => line.trim().length > 0)
    .filter((line) => {
      if (!line.startsWith('?? ')) return true;
      const rel = line.slice(3).replace(/\/$/, '');
      if (rel.includes('/')) return true;
      try {
        return !fs.lstatSync(path.join(wt, rel)).isSymbolicLink();
      } catch {
        return true;
      }
    });
}

// Untracked enumeration for salvage. Throws on a nonzero exit, a spawn error
// or ANY stderr (git only warns when it skips an unreadable directory): an
// incomplete list must never read as "nothing untracked".
function listUntracked(wt, spawn = spawnSync) {
  const res = spawn('git', ['-C', wt, 'ls-files', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  const stderr = String((res && res.stderr) || '').trim();
  if (!res || res.error || res.status !== 0 || stderr) {
    const why = (res && res.error && res.error.message) || stderr || `exit ${res && res.status}`;
    throw new Error(`untracked enumeration failed: ${why}`);
  }
  return String(res.stdout || '').split('\0').filter(Boolean);
}

function sizeOrNull(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

// Re-read the archive against its sources. Returns the manifest, or throws.
function verifySalvage(dest, { head, status, patch, untracked, copied, symlinks }) {
  const fail = (why) => {
    throw new Error(`salvage verification failed: ${why}`);
  };
  let headText = '';
  try {
    headText = fs.readFileSync(path.join(dest, 'HEAD.txt'), 'utf8');
  } catch {
    /* checked below */
  }
  if (!/^[0-9a-f]{40}\n$/.test(headText) || headText.trim() !== head) fail('HEAD.txt does not hold the 40-hex HEAD sha');
  if (sizeOrNull(path.join(dest, 'status.txt')) !== Buffer.byteLength(status)) fail('status.txt not written in full');
  if (sizeOrNull(path.join(dest, 'tracked.patch')) !== patch.length) fail('tracked.patch not written in full');
  if (copied.length + symlinks.length !== untracked.length) fail('untracked entries not all archived');
  let untrackedBytes = 0;
  for (const row of copied) {
    let src;
    try {
      src = fs.lstatSync(row.src);
    } catch (error) {
      fail(`source ${row.rel} vanished during salvage (${error.code || error.message})`);
    }
    if (!src.isFile()) fail(`source ${row.rel} changed type during salvage`);
    const copy = sizeOrNull(row.to);
    if (copy === null) fail(`archive copy of ${row.rel} missing`);
    if (copy !== src.size) fail(`archive copy of ${row.rel} is ${copy} bytes, source is ${src.size}`);
    untrackedBytes += copy;
  }
  return {
    head,
    untrackedListed: untracked.length,
    filesCopied: copied.length,
    symlinksRecorded: symlinks.length,
    untrackedBytes,
    trackedPatchBytes: patch.length,
    statusBytes: Buffer.byteLength(status),
    totalBytes: untrackedBytes + patch.length + Buffer.byteLength(status),
  };
}

// Write everything needed to rebuild a dirty worktree's edits, verify it, and
// only then write SALVAGE_OK. Any enumeration, copy or verification gap
// throws before the marker exists, and removeWorktree then keeps the tree.
function salvageWorktree(wt, ctx) {
  const stamp = new Date(ctx.now).toISOString().slice(0, 10).replace(/-/g, '');
  const dest = path.join(ctx.salvageRoot, stamp, path.basename(wt));
  fs.mkdirSync(dest, { recursive: true });
  fs.rmSync(path.join(dest, 'SALVAGE_OK'), { force: true }); // an earlier attempt's marker must not certify this one
  const head = gitIn(wt, ['rev-parse', 'HEAD']).trim();
  const status = gitIn(wt, ['status', '--porcelain']);
  const patch = gitIn(wt, ['diff', 'HEAD', '--binary'], { raw: true }); // bytes: utf8 decoding mangles non-UTF-8 edits
  fs.writeFileSync(path.join(dest, 'HEAD.txt'), `${head}\n`);
  fs.writeFileSync(path.join(dest, 'status.txt'), status);
  fs.writeFileSync(path.join(dest, 'tracked.patch'), patch);
  const untracked = listUntracked(wt, ctx.spawnGit);
  fs.writeFileSync(path.join(dest, 'untracked-list.txt'), `${untracked.join('\n')}\n`);
  const wtReal = realpathOrNull(wt);
  if (!wtReal) throw new Error(`worktree path unresolvable: ${wt}`);
  const copied = [];
  const symlinks = [];
  let total = 0;
  for (const rel of untracked) {
    const src = path.join(wt, rel);
    let st;
    try {
      st = fs.lstatSync(src);
    } catch (error) {
      throw new Error(`untracked file vanished before salvage: ${rel} (${error.code || error.message})`);
    }
    // A listed path whose parent resolves elsewhere was reached through a
    // linked directory (git for Windows walks junctions): not this tree's work.
    if (realpathOrNull(path.dirname(src)) !== path.join(wtReal, path.dirname(rel))) {
      throw new Error(`untracked path runs through a linked directory: ${rel}`);
    }
    if (st.isSymbolicLink()) {
      let target;
      try {
        target = fs.readlinkSync(src);
      } catch (error) {
        throw new Error(`untracked symlink unreadable: ${rel} (${error.code || error.message})`);
      }
      symlinks.push(`${rel} -> ${target}`); // recorded, never followed
      continue;
    }
    if (!st.isFile()) throw new Error(`untracked entry is not a regular file: ${rel}`);
    if (st.size > SALVAGE_UNTRACKED_FILE_MAX) throw new Error(`untracked file too large to salvage: ${rel}`);
    total += st.size;
    if (total > SALVAGE_UNTRACKED_TOTAL_MAX) throw new Error('untracked files too large to salvage');
    const to = path.join(dest, 'untracked', rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(src, to);
    copied.push({ rel, src, to });
  }
  fs.writeFileSync(path.join(dest, 'symlinks.txt'), symlinks.map((l) => `${l}\n`).join(''));
  const manifest = verifySalvage(dest, { head, status, patch, untracked, copied, symlinks });
  fs.writeFileSync(path.join(dest, 'manifest.json'), `${JSON.stringify({ ...manifest, verifiedAt: new Date(ctx.now).toISOString() }, null, 2)}\n`);
  fs.writeFileSync(path.join(dest, 'SALVAGE_OK'), `${new Date(ctx.now).toISOString()}\n`);
  return dest;
}

// A worktree's top-level symlinks (node_modules) point at shared state. Unlink
// them first so no recursive removal can ever follow them.
function unlinkTopLevelSymlinks(wt) {
  for (const name of fs.readdirSync(wt)) {
    if (name === '.git') continue;
    const full = path.join(wt, name);
    try {
      if (fs.lstatSync(full).isSymbolicLink()) fs.unlinkSync(full);
    } catch {
      /* best effort */
    }
  }
}

function removeWorktree(item, ctx) {
  const safe = guardTarget('worktrees', item.path, ctx);
  if (path.dirname(safe) !== realpathOrNull(ctx.sessionsRoot)) throw new Error(`janitor guard: ${safe} is outside the sessions root`);
  if (item.dirty) {
    try {
      salvageWorktree(safe, ctx);
    } catch (error) {
      // Nothing unlinked, nothing removed; run() records this reason in failed[].
      throw new Error(`salvage incomplete, worktree kept: ${error.message}`);
    }
  }
  unlinkTopLevelSymlinks(safe);
  gitIn(ctx.repo, ['worktree', 'remove', ...(item.dirty ? ['--force'] : []), safe]);
}

// --------------------------------------------------------------------- alert

function centralDate(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function alertText(pct, freedBytes) {
  const freed = freedBytes > 0 ? ` after clearing ${fmtGb(freedBytes)} of old temporary files` : '';
  return `Amy's cloud server disk is ${Math.round(pct)} percent full${freed}. Nothing else is safe to clear automatically, so it needs a decision before it fills.`;
}

async function maybeAlert(ctx, disk, freedBytes) {
  if (ctx.noAlert) return { sent: false, reason: 'disabled' };
  if (!ctx.apply && !ctx.alertOnly) return { sent: false, reason: 'dry-run' };
  if (!disk) return { sent: false, reason: 'disk-unknown' };
  if (disk.pct <= ctx.alertThresholdPct) return { sent: false, reason: 'below-threshold' };
  try {
    const notify = ctx.notify || require(path.join(scriptsDir(), 'lib', 'notify-with-fallback.js')).notifyWithFallback;
    await notify({
      text: alertText(disk.pct, freedBytes),
      source: 'ec2-disk-janitor',
      priority: 'high',
      kind: 'security',
      dedupKey: `disk-pressure-${centralDate(ctx.now)}`,
    });
    return { sent: true, pct: disk.pct };
  } catch (error) {
    return { sent: false, reason: `notify-failed: ${error.message}` };
  }
}

// ----------------------------------------------------------------------- run

const PLANNERS = {
  'backup-restore-temp': planBackupRestoreTemp,
  'hf-cache': planHfCache,
  releases: planReleases,
  worktrees: planWorktrees,
};

async function run(options = {}, deps = {}) {
  const opts = { ...defaultOptions(), ...options };
  const processProof = deps.processProof || readProcessPaths();
  let releaseRefs = null;
  const ctx = {
    ...opts,
    now: deps.now ?? Date.now(),
    processProof,
    sizeOf: deps.sizeOf || ((p) => dirBytes(p)),
    referencedReleases: deps.referencedReleases || (() => (releaseRefs ||= referencedReleaseNames({ ...opts, runCommand: deps.runCommand }))),
    spawnGit: deps.spawnGit,
    notify: deps.notify,
  };
  const report = {
    ts: new Date(ctx.now).toISOString(),
    mode: opts.apply ? 'apply' : opts.alertOnly ? 'alert-only' : 'dry-run',
    salvageDirty: Boolean(opts.salvageDirty),
    diskBefore: diskUsage(opts.diskPath),
    categories: {},
    plannedBytes: 0,
    freedBytes: 0,
    failed: 0,
  };

  if (!opts.alertOnly) {
    for (const category of opts.only) {
      let plan;
      try {
        plan = PLANNERS[category](ctx);
      } catch (error) {
        plan = { category, status: 'error', items: [], skipped: [], note: error.message };
      }
      plan.plannedBytes = plan.items.reduce((sum, it) => sum + (it.bytes || 0), 0);
      plan.removed = [];
      plan.failed = [];
      // Only an 'ok' plan acts. blocked, absent and error plans delete nothing.
      if (opts.apply && plan.status === 'ok') {
        for (const item of plan.items) {
          try {
            if (category === 'worktrees') removeWorktree(item, ctx);
            else removeTree(category, item.path, ctx);
            plan.removed.push(item.path);
            report.freedBytes += item.bytes || 0;
          } catch (error) {
            plan.failed.push({ path: item.path, error: error.message });
          }
        }
        if (category === 'worktrees') gitIn(ctx.repo, ['worktree', 'prune'], { allowFail: true });
      }
      report.plannedBytes += plan.plannedBytes;
      report.failed += plan.failed.length;
      report.categories[category] = plan;
    }
  }

  report.diskAfter = diskUsage(opts.diskPath);
  report.alert = await maybeAlert(ctx, report.diskAfter, report.freedBytes);
  report.ok = report.failed === 0 && Object.values(report.categories).every((c) => c.status !== 'error');
  return report;
}

function formatReport(report) {
  const lines = [];
  const d = report.diskBefore;
  lines.push(`[ec2-disk-janitor] ${report.ts} mode=${report.mode}${d ? ` disk=${d.pct}% (${fmtGb(d.usedBytes)} of ${fmtGb(d.totalBytes)})` : ''}`);
  for (const [name, c] of Object.entries(report.categories)) {
    const verb = report.mode === 'apply' ? `removed ${c.removed.length}` : `would remove ${c.items.length}`;
    lines.push(`  ${name.padEnd(20)} ${c.status.padEnd(8)} ${verb}, ${fmtGb(c.plannedBytes)} planned, ${c.skipped.length} skipped${c.note ? ` | ${c.note}` : ''}`);
    for (const f of c.failed) lines.push(`    FAILED ${f.path}: ${f.error}`);
  }
  if (report.mode === 'apply' && report.diskAfter) lines.push(`  disk after: ${report.diskAfter.pct}% freed ${fmtGb(report.freedBytes)}`);
  else lines.push(`  total planned: ${fmtGb(report.plannedBytes)}`);
  lines.push(`  alert: ${report.alert.sent ? 'sent' : `not sent (${report.alert.reason})`}`);
  return lines.join('\n');
}

if (require.main === module) {
  (async () => {
    try {
      const opts = parseArgs(process.argv.slice(2));
      const report = await run(opts);
      process.stdout.write(`${opts.json ? JSON.stringify(report) : formatReport(report)}\n`);
      if (!report.ok) process.exitCode = 2;
    } catch (error) {
      process.stderr.write(`[ec2-disk-janitor] ERROR: ${error.message}\n`);
      process.exitCode = 1;
    }
  })();
}

module.exports = {
  BACKUP_RESTORE_NAME,
  CATEGORIES,
  alertText,
  defaultOptions,
  diskUsage,
  formatReport,
  guardTarget,
  parseArgs,
  parseWorktreeList,
  pathInUse,
  planBackupRestoreTemp,
  planHfCache,
  planReleases,
  planWorktrees,
  readProcessPaths,
  referencedReleaseNames,
  run,
  salvageWorktree,
  verifySalvage,
};
