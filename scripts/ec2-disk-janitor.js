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
 *      HEAD is an ancestor of origin/master. Clean ones are removed. Ones
 *      holding uncommitted edits, untracked files, or ignored files outside a
 *      fixed rebuildable list (node_modules, out, dist, .vite ...) are removed
 *      only with --salvage-dirty, which writes HEAD, the staged patch (index
 *      vs HEAD), the unstaged patch (worktree vs index) and every such file to
 *      a unique, exclusively created archive under the salvage root, records
 *      a sha256 per saved item, and verifies copies and sources by content.
 *      An ignored file under a data/archive-like path, or anything over the
 *      size caps, keeps the worktree. Immediately before each removal, under
 *      a per-worktree lock, HEAD, merge state, status, both patches, the file
 *      set and content, live processes, session registry records, git locks
 *      and the newest mtime are all re-checked; any change keeps the tree.
 *      restoreSalvage() rebuilds an archive into a checkout at its HEAD.
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
 * An --apply run also takes its own O_EXCL run lock, <lock>.pid beside the
 * flock file (SB_JANITOR_RUN_LOCK overrides), with dead-pid recovery, so a
 * manual run cannot overlap the cron run or another manual run.
 *
 * Usage:
 *   node scripts/ec2-disk-janitor.js                 # dry-run plan
 *   node scripts/ec2-disk-janitor.js --apply         # act
 *   node scripts/ec2-disk-janitor.js --apply --salvage-dirty
 *   node scripts/ec2-disk-janitor.js --alert-only    # threshold check only
 *   flags: --json --only a,b --keep-releases N --min-age-hours N
 *          --alert-threshold PCT --no-alert
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const { watchedLimitMs } = require('./lib/watched-work-limit');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const CATEGORIES = ['backup-restore-temp', 'hf-cache', 'releases', 'worktrees'];
const BACKUP_RESTORE_NAME = /^secondbrain-backup-restore-[A-Za-z0-9]{6}$/;
const RELEASE_REF = /[0-9a-f]{40}(?:\.reland-\d+-\d+)?/;
const GIB = 1024 ** 3;
const table = require('./lib/storage-retention-table.js');
const DEFAULT_KEEP_RELEASES = table.row('releases').pressureKeepNewest;
const DEFAULT_ALERT_PCT = table.threshold('diskUsedPercentAlarm');
const DEFAULT_MIN_AGE_HOURS = table.row('worktrees').localKeepDays * 24;
// Per-file and per-worktree caps on what salvage copies (untracked plus
// ignored files). A file or total over the cap keeps the worktree.
const SALVAGE_FILE_MAX = 1024 * 1024;
const SALVAGE_TOTAL_MAX = 50 * 1024 * 1024;
// The ONLY ignored directory names salvage may skip: build output and
// dependency caches a checkout regenerates. Fixed list, never a pattern.
const REBUILDABLE_DIRS = new Set(['node_modules', 'out', 'dist', '.vite', 'coverage', '__pycache__', '.pytest_cache', 'test-results', 'playwright-report']);
// An ignored path with one of these segments (raw archives, data, backups)
// keeps the whole worktree: salvage never certifies or deletes it.
const PROTECTED_SEGMENT = /^(?:data|archives?|raw|raw[-_]?archives?|backups?)$/i;
// Session registry statuses that mean the session is over. Anything else,
// including a missing status, is live and keeps its worktree.
const TERMINAL_SESSION_STATUSES = new Set(['done', 'archive_pending', 'archived', 'inactive', 'failed', 'cancelled', 'canceled', 'completed', 'error', 'abandoned']);
const WORKTREE_LOCK_NAME = 'ec2-disk-janitor.lock';
const RUN_LOCK_BASE = '/tmp/secondbrain-ec2-disk-janitor.lock';

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
    minAgeHours: Number(env.SB_JANITOR_MIN_AGE_HOURS || DEFAULT_MIN_AGE_HOURS),
    alertThresholdPct: Number(env.SB_JANITOR_ALERT_PCT || DEFAULT_ALERT_PCT),
    dataDir: env.SB_JANITOR_DATA_DIR || '/opt/secondbrain/data',
    releasesRoot: env.SB_RELEASES_ROOT || '/opt/secondbrain-releases',
    liveLink: env.SB_OPT_LINK || '/opt/secondbrain',
    sessionsRoot: env.SB_SESSIONS_ROOT || path.join(home, 'sb-sessions'),
    repo: env.SB_JANITOR_REPO || path.join(home, 'secondbrain-current'),
    baseRef: env.SB_JANITOR_BASE_REF || 'origin/master',
    salvageRoot: env.SB_SALVAGE_ROOT || path.join(home, 'sb-sessions-salvage'),
    sessionRegistryDir: env.SB_JANITOR_SESSION_REGISTRY || null, // null: <dataDir>/agent/desktop-session-registry
    runLock: env.SB_JANITOR_RUN_LOCK || `${RUN_LOCK_BASE}.pid`,
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
        timeout: watchedLimitMs(10 * 60 * 1000),
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
// every category that needs it. A process whose cwd or fds cannot be read
// (EACCES/EPERM) is listed in unreadable[] with its uid (null when even the
// uid cannot be read); processOwnership decides what that means per path.
// ENOENT/ESRCH mean the process exited and are benign.
// '(sd-pam)' is the login manager's helper for the user's systemd instance:
// same uid, not dumpable, always in "/", never a worktree user. It lives as
// long as the user session does, so it kept every worktree on every sweep
// (2026-11-14 sweep: 313 of 313 merged worktrees kept, 0 bytes freed).
const SSHD_SESSION_COMMS = new Set(['sshd', 'sshd-session', '(sd-pam)']);

function readProcessPaths({ procRoot = '/proc', fsApi = fs, platform = process.platform } = {}) {
  const paths = new Set();
  const unreadable = [];
  if (platform !== 'linux') return { known: false, paths, unreadable };
  let pids = [];
  try {
    pids = fsApi.readdirSync(procRoot).filter((n) => /^\d+$/.test(n));
  } catch {
    return { known: false, paths, unreadable };
  }
  const gone = new Set(['ENOENT', 'ESRCH', 'ENOTDIR']);
  const denied = new Set(['EACCES', 'EPERM']);
  for (const pid of pids) {
    let blind = false;
    const note = (error) => {
      if (gone.has(error?.code)) return true;
      if (denied.has(error?.code)) {
        blind = true;
        return true;
      }
      return false;
    };
    try {
      paths.add(path.resolve(fsApi.readlinkSync(path.join(procRoot, pid, 'cwd'))));
    } catch (error) {
      if (!note(error)) return { known: false, paths, unreadable };
    }
    let fds = [];
    try {
      fds = fsApi.readdirSync(path.join(procRoot, pid, 'fd'));
    } catch (error) {
      if (!note(error)) return { known: false, paths, unreadable };
    }
    for (const fd of fds) {
      try {
        const target = fsApi.readlinkSync(path.join(procRoot, pid, 'fd', fd));
        if (target.startsWith('/')) paths.add(path.resolve(target));
      } catch (error) {
        if (!note(error)) return { known: false, paths, unreadable };
      }
    }
    if (blind) {
      // An SSH session's own sshd process runs as the login user but is not
      // dumpable, so its cwd and fds cannot be read; it always sits in "/" and
      // the session's shell is a separate, readable child. Without this, any
      // open SSH connection (the PC connects every minute or two) kept every
      // worktree (2026-11-12 sweep: 308 of 308 kept, 0 bytes freed).
      let comm = '';
      try {
        comm = String(fsApi.readFileSync(path.join(procRoot, pid, 'comm'), 'utf8')).trim();
      } catch {
        /* unreadable comm: treated as any other blind process */
      }
      if (SSHD_SESSION_COMMS.has(comm)) continue;
      let uid = null;
      try {
        uid = fsApi.statSync(path.join(procRoot, pid)).uid;
      } catch (error) {
        if (gone.has(error?.code)) continue; // exited while we looked
      }
      unreadable.push({ pid: Number(pid), uid: Number.isInteger(uid) ? uid : null });
    }
  }
  return { known: true, paths, unreadable };
}

function pathInUse(target, proof) {
  const root = path.resolve(target);
  const prefix = `${root}${path.sep}`;
  for (const p of proof.paths || []) {
    if (p === root || p.startsWith(prefix)) return true;
  }
  return false;
}

// Worktree ownership rule (F4). The janitor runs as ec2-user and can read
// every process of its own uid. A process it cannot read counts as a
// non-owner ONLY when its uid is known and differs from the uid that owns the
// worktree directory; one with the same uid, or whose uid cannot be read,
// makes ownership unknown, and unknown keeps the worktree.
function processOwnership(target, proof, ownerUidValue) {
  if (!proof || !proof.known) return { state: 'unknown', why: 'process proof unavailable' };
  if (pathInUse(target, proof)) return { state: 'in-use', why: 'held by a process' };
  if (!Number.isInteger(ownerUidValue)) return { state: 'unknown', why: 'worktree owner uid unreadable' };
  for (const p of proof.unreadable || []) {
    if (!Number.isInteger(p.uid)) return { state: 'unknown', why: `pid ${p.pid} unreadable and its uid unknown` };
    if (p.uid === ownerUidValue) return { state: 'unknown', why: `pid ${p.pid} of the worktree owner uid ${p.uid} unreadable` };
  }
  return { state: 'free', why: '' };
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
  const cron = run('crontab', ['-l'], { timeout: watchedLimitMs(15000) });
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
    const live = run('pm2', ['jlist'], { timeout: watchedLimitMs(15000) });
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
      timeout: watchedLimitMs(5 * 60 * 1000),
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

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sha256File(p) {
  return sha256(fs.readFileSync(p));
}

// Thrown when a worktree must stay for a reason that is not an error (it is
// still live, it changed, or it holds something salvage must not certify).
// run() records it under skipped[], never failed[].
class KeepWorktree extends Error {
  constructor(reason) {
    super(reason);
    this.code = 'KEEP';
  }
}

function worktreeGitDir(wt) {
  const out = gitIn(wt, ['rev-parse', '--absolute-git-dir'], { allowFail: true });
  return out ? path.resolve(out.trim()) : null;
}

// Newest mtime anywhere in the worktree (rebuildable dirs and links are not
// followed) plus the worktree's own HEAD and index. A live session touches
// at least one file; the --min-age-hours guard applies to all of them.
function newestActivity(wt) {
  let newest = { mtimeMs: 0, rel: '.' };
  const bump = (p, rel) => {
    try {
      const st = fs.lstatSync(p);
      if (st.mtimeMs > newest.mtimeMs) newest = { mtimeMs: st.mtimeMs, rel };
      return st;
    } catch {
      return null;
    }
  };
  const walk = (dir, rel) => {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (rel === '' && name === '.git') continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const st = bump(path.join(dir, name), childRel);
      if (st && st.isDirectory() && !st.isSymbolicLink() && !REBUILDABLE_DIRS.has(name)) walk(path.join(dir, name), childRel);
    }
  };
  bump(wt, '.');
  walk(wt, '');
  const gitdir = worktreeGitDir(wt);
  if (gitdir) {
    bump(path.join(gitdir, 'HEAD'), '.git/HEAD');
    bump(path.join(gitdir, 'index'), '.git/index');
  }
  return newest;
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

// One ls-files listing. Throws on a nonzero exit, a spawn error or ANY stderr
// (git only warns when it skips an unreadable directory): an incomplete list
// must never read as "nothing there".
function lsFilesZ(wt, args, label, spawn = spawnSync) {
  const res = spawn('git', ['-C', wt, 'ls-files', ...args, '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: watchedLimitMs(5 * 60 * 1000),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  const stderr = String((res && res.stderr) || '').trim();
  if (!res || res.error || res.status !== 0 || stderr) {
    const why = (res && res.error && res.error.message) || stderr || `exit ${res && res.status}`;
    throw new Error(`${label} enumeration failed: ${why}`);
  }
  return String(res.stdout || '').split('\0').filter(Boolean);
}

function listUntracked(wt, spawn) {
  return lsFilesZ(wt, ['--others', '--exclude-standard'], 'untracked', spawn);
}

// Ignored files are deleted by a forced removal just like untracked ones, so
// they are inventoried too. --directory collapses a wholly ignored directory
// to one "dir/" entry; inventoryWorktree walks it unless it is rebuildable.
function listIgnored(wt, spawn) {
  return lsFilesZ(wt, ['--others', '--ignored', '--exclude-standard', '--directory'], 'ignored', spawn);
}

// First path segment that decides an ignored entry: a rebuildable name skips
// it, a data or archive-like name keeps the whole worktree.
function ignoredPathClass(rel) {
  for (const seg of rel.split('/').filter(Boolean)) {
    if (PROTECTED_SEGMENT.test(seg)) return 'protected';
    if (REBUILDABLE_DIRS.has(seg)) return 'rebuildable';
  }
  return 'save';
}

// Everything a forced removal would delete beyond tracked edits, or a keep
// reason. Throws when the listing itself is incomplete or unsafe.
// A paused merge, rebase, cherry-pick, revert or bisect, or any unmerged index
// entry, cannot be represented by the saved patches (Codex review 06ce55a4c306).
const GIT_OPERATION_MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG', 'sequencer'];
function gitOperationInProgress(wt) {
  const gitdir = worktreeGitDir(wt);
  if (!gitdir) return 'gitdir-unresolvable';
  const marker = GIT_OPERATION_MARKERS.find((n) => fs.existsSync(path.join(gitdir, n)));
  if (marker) return `kept-git-operation-paused: ${marker}`;
  const unmerged = gitIn(wt, ['ls-files', '-u'], { allowFail: true });
  if (unmerged === null) return 'kept-unmerged-check-failed';
  if (String(unmerged).trim()) return 'kept-unmerged-index-entries';
  return null;
}

function inventoryWorktree(wt, ctx = {}) {
  const spawn = ctx.spawnGit;
  const paused = gitOperationInProgress(wt);
  if (paused) return { untracked: [], ignored: [], rebuildableSkipped: [], keepReason: paused, bytes: 0 };
  const untrackedList = listUntracked(wt, spawn);
  const ignoredList = listIgnored(wt, spawn);
  const wtReal = realpathOrNull(wt);
  if (!wtReal) throw new Error(`worktree path unresolvable: ${wt}`);
  const inv = { untracked: [], ignored: [], rebuildableSkipped: [], keepReason: null, bytes: 0 };
  const sharedLinks = new Set();
  const keep = (why) => {
    if (!inv.keepReason) inv.keepReason = why;
  };

  const addFile = (kind, rel, st) => {
    if (st.size > SALVAGE_FILE_MAX) return keep(`kept-too-large-to-salvage: ${kind} ${rel} is ${st.size} bytes`);
    inv.bytes += st.size;
    if (inv.bytes > SALVAGE_TOTAL_MAX) return keep(`kept-too-large-to-salvage: untracked and ignored files exceed ${SALVAGE_TOTAL_MAX} bytes`);
    inv[kind].push({ type: 'file', rel, size: st.size, mode: st.mode & 0o777 });
    return null;
  };

  const visit = (kind, rel) => {
    const src = path.join(wt, rel);
    let st;
    try {
      st = fs.lstatSync(src);
    } catch (error) {
      throw new Error(`${kind} file vanished before salvage: ${rel} (${error.code || error.message})`);
    }
    // A listed path whose parent resolves elsewhere was reached through a
    // linked directory (git for Windows walks junctions): not this tree's work.
    if (realpathOrNull(path.dirname(src)) !== path.join(wtReal, path.dirname(rel))) {
      throw new Error(`${kind} path runs through a linked directory: ${rel}`);
    }
    if (st.isSymbolicLink()) {
      let target;
      try {
        target = fs.readlinkSync(src);
      } catch (error) {
        throw new Error(`${kind} symlink unreadable: ${rel} (${error.code || error.message})`);
      }
      inv[kind].push({ type: 'symlink', rel, target }); // recorded, never followed
      return;
    }
    if (kind === 'ignored' && st.isDirectory()) {
      for (const name of fs.readdirSync(src)) {
        const childRel = `${rel}/${name}`;
        const cls = ignoredPathClass(childRel);
        if (cls === 'rebuildable') inv.rebuildableSkipped.push(childRel);
        else if (cls === 'protected') keep(`kept-ignored-protected-path: ${childRel}`);
        else visit(kind, childRel);
        if (inv.keepReason) return;
      }
      return;
    }
    if (!st.isFile()) throw new Error(`${kind} entry is not a regular file: ${rel}`);
    addFile(kind, rel, st);
  };

  for (const listed of untrackedList) {
    const rel = listed.replace(/\/$/, '');
    const top = rel.split('/')[0];
    // A path under a top-level link (git for Windows walks junctions) is the
    // shared node_modules-style link removal unlinks first: one record, never
    // followed, never copied.
    let topIsLink = false;
    try {
      topIsLink = fs.lstatSync(path.join(wt, top)).isSymbolicLink();
    } catch {
      /* vanished: visit() reports it */
    }
    if (topIsLink) {
      if (!sharedLinks.has(top)) {
        sharedLinks.add(top);
        visit('untracked', top);
      }
      continue;
    }
    if (listed.endsWith('/')) throw new Error(`untracked entry is not a regular file: ${listed}`);
    visit('untracked', rel);
    if (inv.keepReason) return inv;
  }
  for (const listed of ignoredList) {
    const rel = listed.replace(/\/$/, '');
    const cls = ignoredPathClass(rel);
    if (cls === 'rebuildable') inv.rebuildableSkipped.push(rel);
    else if (cls === 'protected') keep(`kept-ignored-protected-path: ${rel}`);
    else visit('ignored', rel);
    if (inv.keepReason) return inv;
  }
  return inv;
}

// Salvage content beyond tracked edits: everything but shared top-level links.
function inventoryNeedsSalvage(inv) {
  return inv.ignored.length > 0 || inv.untracked.some((e) => !(e.type === 'symlink' && !e.rel.includes('/')));
}

// Identity of the inventory (names, types, sizes, link targets). Content is
// covered separately by re-hashing every saved file.
function inventoryKey(inv) {
  const rows = [];
  for (const kind of ['untracked', 'ignored']) {
    for (const e of inv[kind]) rows.push(`${kind}\t${e.type}\t${e.rel}\t${e.type === 'file' ? e.size : e.target}`);
  }
  for (const rel of inv.rebuildableSkipped) rows.push(`rebuildable\t${rel}`);
  return sha256(rows.sort().join('\n'));
}

// Live session markers in the session registry: a record whose cwd is inside
// the worktree and whose status is not terminal keeps it. An unreadable
// registry, or an unparseable record that names the worktree, keeps it too.
function liveSessionMarker(wt, ctx) {
  const dir = ctx.sessionRegistryDir;
  if (!dir) return null;
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return `session-registry-unreadable: ${error.code || error.message}`;
  }
  const base = path.basename(wt);
  for (const name of names) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      return `session-registry-unreadable: ${name} ${error.code || error.message}`;
    }
    if (!text.includes(base)) continue;
    let rec;
    try {
      rec = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      return `session-record-unparseable: ${name}`;
    }
    const cwd = (rec && rec.execution && rec.execution.cwd) || (rec && rec.cwd);
    if (typeof cwd !== 'string' || !isInside(path.resolve(cwd), wt)) continue;
    const status = String(rec.status || '');
    if (!TERMINAL_SESSION_STATUSES.has(status)) return `live-session-record: ${name} status=${status || 'missing'}`;
  }
  return null;
}

// Unique, exclusively created archive directory. mkdir without recursive on
// the leaf fails on EEXIST, so an earlier archive (and its SALVAGE_OK) is
// never reused, overwritten or deleted.
function createSalvageDir(salvageRoot, wt) {
  const nowMs = Date.now();
  const day = new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '');
  const parent = path.join(salvageRoot, day);
  fs.mkdirSync(parent, { recursive: true });
  const stamp = new Date(nowMs).toISOString().replace(/[-:.]/g, '');
  const dest = path.join(parent, `${path.basename(wt)}-${stamp}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dest);
  return dest;
}

function writeExclusive(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, { flag: 'wx' });
}

// Re-read the archive and its sources by content. Every recorded file's
// archive copy must hash to its manifest sha256, every untracked or ignored
// source must still hash to it, and every link must still name the same
// target. Throws on the first mismatch.
function verifySalvage(dest, manifest, wt) {
  const fail = (why) => {
    throw new Error(`salvage verification failed: ${why}`);
  };
  for (const f of manifest.files) {
    let buf;
    try {
      buf = fs.readFileSync(path.join(dest, f.archive));
    } catch {
      fail(`${f.archive} missing`);
    }
    if (buf.length !== f.bytes || sha256(buf) !== f.sha256) fail(`${f.archive} does not match its recorded sha256`);
  }
  const headText = (() => {
    try {
      return fs.readFileSync(path.join(dest, 'HEAD.txt'), 'utf8');
    } catch {
      return '';
    }
  })();
  if (!/^[0-9a-f]{40}\n$/.test(headText) || headText.trim() !== manifest.head) fail('HEAD.txt does not hold the 40-hex HEAD sha');
  for (const e of manifest.entries) {
    const src = path.join(wt, e.rel);
    if (e.type === 'symlink') {
      let target = null;
      try {
        target = fs.readlinkSync(src);
      } catch (error) {
        fail(`source link ${e.rel} vanished (${error.code || error.message})`);
      }
      if (target !== e.target || sha256(target) !== e.sha256) fail(`source link ${e.rel} now points elsewhere`);
      continue;
    }
    let copy;
    try {
      copy = fs.readFileSync(path.join(dest, e.archive));
    } catch {
      fail(`archive copy of ${e.rel} missing`);
    }
    if (sha256(copy) !== e.sha256) fail(`archive copy of ${e.rel} does not match its recorded sha256`);
    let st;
    try {
      st = fs.lstatSync(src);
    } catch (error) {
      fail(`source ${e.rel} vanished (${error.code || error.message})`);
    }
    if (!st.isFile()) fail(`source ${e.rel} changed type`);
    if (sha256File(src) !== e.sha256) fail(`source ${e.rel} changed after it was copied`);
  }
  return manifest;
}

// Write everything needed to rebuild a worktree's edits (HEAD, staged patch =
// index vs HEAD, unstaged patch = worktree vs index, every untracked and
// non-rebuildable ignored file, link targets), verify it by content, and only
// then write manifest.json and SALVAGE_OK. Any gap throws before the marker
// exists, and removeWorktree then keeps the tree.
function salvageWorktree(wt, ctx) {
  const head = gitIn(wt, ['rev-parse', 'HEAD']).trim();
  const status = gitIn(wt, ['status', '--porcelain']);
  // bytes: utf8 decoding mangles non-UTF-8 edits
  const staged = gitIn(wt, ['diff', '--cached', '--binary'], { raw: true });
  const unstaged = gitIn(wt, ['diff', '--binary'], { raw: true });
  const inv = inventoryWorktree(wt, ctx);
  if (inv.keepReason) throw new KeepWorktree(inv.keepReason);
  const dest = createSalvageDir(ctx.salvageRoot, wt);
  const files = [];
  const record = (archive, data, role) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    writeExclusive(path.join(dest, archive), buf);
    files.push({ role, archive, bytes: buf.length, sha256: sha256(buf) });
  };
  record('HEAD.txt', `${head}\n`, 'head');
  record('status.txt', status, 'status');
  record('staged.patch', staged, 'staged');
  record('unstaged.patch', unstaged, 'unstaged');
  const entries = [];
  for (const kind of ['untracked', 'ignored']) {
    for (const e of inv[kind]) {
      if (e.type === 'symlink') {
        entries.push({ kind, type: 'symlink', rel: e.rel, target: e.target, sha256: sha256(e.target) });
        continue;
      }
      const src = path.join(wt, e.rel);
      const archive = `${kind}/${e.rel}`;
      const to = path.join(dest, archive);
      const digest = sha256File(src);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(src, to);
      entries.push({ kind, type: 'file', rel: e.rel, archive, bytes: e.size, mode: e.mode, sha256: digest });
    }
  }
  record('untracked-list.txt', inv.untracked.map((e) => `${e.rel}\n`).join(''), 'untracked-list');
  record('ignored-list.txt', inv.ignored.map((e) => `${e.rel}\n`).join(''), 'ignored-list');
  record('rebuildable-skipped.txt', inv.rebuildableSkipped.map((r) => `${r}\n`).join(''), 'rebuildable-skipped');
  record('symlinks.txt', entries.filter((e) => e.type === 'symlink').map((e) => `${e.rel} -> ${e.target}\n`).join(''), 'symlinks');
  const savedBytes = entries.reduce((n, e) => n + (e.bytes || 0), 0);
  const manifest = {
    schema: 'amy.ec2-disk-janitor.salvage.v2',
    worktree: wt,
    head,
    createdAt: new Date().toISOString(),
    pid: process.pid,
    files,
    entries,
    rebuildableSkipped: inv.rebuildableSkipped,
    fingerprint: {
      head,
      statusSha: sha256(status),
      stagedSha: sha256(staged),
      unstagedSha: sha256(unstaged),
      inventorySha: inventoryKey(inv),
    },
    totals: {
      untrackedFiles: entries.filter((e) => e.kind === 'untracked' && e.type === 'file').length,
      ignoredFiles: entries.filter((e) => e.kind === 'ignored' && e.type === 'file').length,
      symlinks: entries.filter((e) => e.type === 'symlink').length,
      savedFileBytes: savedBytes,
      stagedPatchBytes: staged.length,
      unstagedPatchBytes: unstaged.length,
    },
  };
  verifySalvage(dest, manifest, wt);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeExclusive(path.join(dest, 'manifest.json'), manifestText);
  const manifestSha = sha256File(path.join(dest, 'manifest.json'));
  if (manifestSha !== sha256(manifestText)) throw new Error('salvage verification failed: manifest.json not written in full');
  writeExclusive(path.join(dest, 'SALVAGE_OK'), `${new Date().toISOString()}\nmanifest-sha256 ${manifestSha}\n`);
  return dest;
}

function readCertifiedManifest(dest) {
  const ok = fs.readFileSync(path.join(dest, 'SALVAGE_OK'), 'utf8');
  const m = ok.match(/manifest-sha256 ([0-9a-f]{64})/);
  const text = fs.readFileSync(path.join(dest, 'manifest.json'));
  if (!m || sha256(text) !== m[1]) throw new Error('manifest.json does not match SALVAGE_OK');
  return JSON.parse(text.toString('utf8'));
}

// Rebuild a salvaged worktree's edits into target, a checkout at the
// manifest's HEAD: staged patch into index and worktree, unstaged patch into
// the worktree, then every saved file and link. Every archive file is checked
// against its sha256 before use and every restored file after.
function restoreSalvage(dest, target) {
  const manifest = readCertifiedManifest(dest);
  for (const f of manifest.files) {
    if (sha256File(path.join(dest, f.archive)) !== f.sha256) throw new Error(`restore: ${f.archive} does not match its sha256`);
  }
  const head = gitIn(target, ['rev-parse', 'HEAD']).trim();
  if (head !== manifest.head) throw new Error(`restore: target HEAD ${head} is not ${manifest.head}`);
  const patch = (name, extra) => {
    const p = path.join(dest, name);
    if (fs.statSync(p).size > 0) gitIn(target, ['apply', '--binary', '--whitespace=nowarn', ...extra, p]);
  };
  patch('staged.patch', ['--index']);
  patch('unstaged.patch', []);
  let restored = 0;
  for (const e of manifest.entries) {
    const to = path.join(target, e.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (e.type === 'symlink') {
      fs.symlinkSync(e.target, to);
    } else {
      const src = path.join(dest, e.archive);
      if (sha256File(src) !== e.sha256) throw new Error(`restore: archive copy of ${e.rel} does not match its sha256`);
      fs.copyFileSync(src, to);
      if (Number.isInteger(e.mode)) fs.chmodSync(to, e.mode);
      if (sha256File(to) !== e.sha256) throw new Error(`restore: ${e.rel} restored with different content`);
    }
    restored += 1;
  }
  return { head, restored };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Exclusive lock file created with O_EXCL holding {pid, host, token}. A holder
// whose pid is dead on this host, or an unreadable file older than a minute,
// is stale and is renamed aside before one retry. A live holder refuses.
function acquireExclusiveFile(file, { label = 'lock', staleUnreadableMs = 60 * 1000 } = {}) {
  const token = crypto.randomBytes(8).toString('hex');
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), token, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
      return {
        file,
        release() {
          try {
            if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file);
          } catch {
            /* already gone or replaced */
          }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* unreadable or half-written */
    }
    let stale;
    if (holder && Number.isInteger(holder.pid)) stale = (!holder.host || holder.host === os.hostname()) && !pidAlive(holder.pid);
    else {
      let age = 0;
      try {
        age = Date.now() - fs.statSync(file).mtimeMs;
      } catch {
        age = Infinity;
      }
      stale = age > staleUnreadableMs;
    }
    if (!stale || attempt > 0) {
      throw new KeepWorktree(`${label} held: ${file}${holder && holder.pid ? ` (pid ${holder.pid})` : ''}`);
    }
    if (!recoverStaleLock(file, holder)) {
      throw new KeepWorktree(`${label} held: ${file} (stale recovery contended)`);
    }
  }
  throw new KeepWorktree(`${label} held: ${file}`);
}

// One recoverer at a time (mkdir is atomic). Under it the lock file is re-read:
// it is moved aside only if it is still the exact holder seen as stale (same
// token, or still unreadable), so a contender that observed the same dead owner
// can never evict the live lock another contender just took (Codex review
// 06ce55a4c306). Fails closed on an existing recovery dir, never expiring it
// (cfedf1f454b7). Returns true when the stale holder is gone.
function recoverStaleLock(file, observed) {
  const guard = `${file}.recover`;
  try {
    fs.mkdirSync(guard);
  } catch (error) {
    // An existing guard is never cleared here, however old: its owner may only
    // be paused (Codex review cfedf1f454b7). A guard left by a crashed recoverer
    // keeps the lock (and so the worktrees) until a person removes it.
    return false;
  }
  try {
    let current = null;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      return error.code === 'ENOENT';
    }
    try {
      current = JSON.parse(raw);
    } catch {
      current = null;
    }
    const same = observed && observed.token ? Boolean(current && current.token === observed.token) : !(current && current.token);
    if (!same) return false;
    fs.renameSync(file, `${file}.stale-${Date.now()}-${process.pid}`);
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.rmdirSync(guard);
    } catch {
      /* already cleared */
    }
  }
}

// The CLI's run lock. The cron line's flock holds the base path (flock never
// deletes it, so O_EXCL cannot reuse it); this O_EXCL pid file beside it
// excludes a manual run from the cron run and from another manual run.
function acquireRunLock(lockPath) {
  try {
    return acquireExclusiveFile(lockPath, { label: 'another ec2-disk-janitor run' });
  } catch (error) {
    throw new Error(error.message);
  }
}

// Everything that must still hold immediately before removal, under the
// per-worktree lock. Returns a keep reason, or null when removal may proceed.
function recheckBeforeRemoval(item, ctx, salvage) {
  const wt = item.path;
  const gitdir = worktreeGitDir(wt);
  if (!gitdir) return 'gitdir-unresolvable';
  if (fs.existsSync(path.join(gitdir, 'locked'))) return 'git-worktree-locked';
  let gitdirNames = [];
  try {
    gitdirNames = fs.readdirSync(gitdir);
  } catch (error) {
    return `gitdir-unreadable: ${error.code || error.message}`;
  }
  const busy = gitdirNames.find((n) => n.endsWith('.lock') && n !== WORKTREE_LOCK_NAME);
  if (busy) return `git-operation-in-progress: ${busy}`;
  const head = (gitIn(wt, ['rev-parse', 'HEAD'], { allowFail: true }) || '').trim();
  if (head !== item.head) return 'head-changed';
  if (gitIn(ctx.repo, ['merge-base', '--is-ancestor', head, ctx.baseRef], { allowFail: true }) === null) return 'no-longer-merged';
  const status = gitIn(wt, ['status', '--porcelain'], { allowFail: true });
  if (status === null) return 'status-failed';
  let inv;
  try {
    inv = inventoryWorktree(wt, ctx);
  } catch (error) {
    return `inventory-failed: ${error.message}`;
  }
  if (inv.keepReason) return inv.keepReason;
  if (salvage) {
    const fp = salvage.manifest.fingerprint;
    if (sha256(status) !== fp.statusSha) return 'status-changed-since-salvage';
    const staged = gitIn(wt, ['diff', '--cached', '--binary'], { raw: true, allowFail: true });
    if (staged === null || sha256(staged) !== fp.stagedSha) return 'staged-changes-changed-since-salvage';
    const unstaged = gitIn(wt, ['diff', '--binary'], { raw: true, allowFail: true });
    if (unstaged === null || sha256(unstaged) !== fp.unstagedSha) return 'unstaged-changes-changed-since-salvage';
    if (inventoryKey(inv) !== fp.inventorySha) return 'untracked-or-ignored-set-changed-since-salvage';
    try {
      verifySalvage(salvage.dest, salvage.manifest, wt);
    } catch (error) {
      return `content-changed-since-salvage: ${error.message}`;
    }
  } else {
    if (realStatusLines(wt, status).length > 0) return 'became-dirty';
    if (inventoryNeedsSalvage(inv)) return 'has-unsalvaged-untracked-or-ignored-files';
  }
  const own = processOwnership(wt, ctx.readProcessProof(), ownerUid(wt));
  if (own.state !== 'free') return own.state === 'in-use' ? 'in-use' : `process-ownership-unknown: ${own.why}`;
  const marker = liveSessionMarker(wt, ctx);
  if (marker) return marker;
  const act = newestActivity(wt);
  if (ctx.now - act.mtimeMs < ctx.minAgeHours * 3600 * 1000) return `recent-activity: ${act.rel}`;
  return null;
}

function ownerUid(p) {
  try {
    return fs.statSync(p).uid;
  } catch {
    return null;
  }
}

function planWorktrees(ctx) {
  const out = {
    category: 'worktrees',
    status: 'ok',
    items: [],
    skipped: [],
    note: '',
    counts: { registered: 0, merged: 0, mergedClean: 0, mergedDirty: 0, ignoredOnly: 0, kept: 0, unmerged: 0, prunable: 0 },
  };
  const root = realpathOrNull(ctx.sessionsRoot);
  if (!root || !fs.existsSync(ctx.repo)) return { ...out, status: 'absent', note: 'no sb-sessions worktrees on this host' };
  if (!ctx.processProof.known) return { ...out, status: 'blocked', note: 'process proof unavailable' };
  if (gitIn(ctx.repo, ['rev-parse', '--verify', '--quiet', `${ctx.baseRef}^{commit}`], { allowFail: true }) === null) {
    return { ...out, status: 'blocked', note: `base ref ${ctx.baseRef} not found (janitor never fetches)` };
  }
  const rows = parseWorktreeList(gitIn(ctx.repo, ['worktree', 'list', '--porcelain']));
  const minAgeMs = ctx.minAgeHours * 3600 * 1000;
  const keep = (p, reason) => {
    out.counts.kept += 1;
    out.skipped.push({ path: p, reason });
  };
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
    const own = processOwnership(real, ctx.processProof, ownerUid(real));
    if (own.state === 'in-use') {
      out.skipped.push({ path: real, reason: 'in-use' });
      continue;
    }
    if (own.state === 'unknown') {
      out.skipped.push({ path: real, reason: `process-ownership-unknown: ${own.why}` });
      continue;
    }
    const act = newestActivity(real);
    if (ctx.now - act.mtimeMs < minAgeMs) {
      out.skipped.push({ path: real, reason: 'recent', newest: act.rel });
      continue;
    }
    const marker = liveSessionMarker(real, ctx);
    if (marker) {
      out.skipped.push({ path: real, reason: marker });
      continue;
    }
    const status = gitIn(real, ['status', '--porcelain'], { allowFail: true });
    if (status === null) {
      out.skipped.push({ path: real, reason: 'status-failed' });
      continue;
    }
    const dirty = realStatusLines(real, status).length > 0;
    let inv = null;
    let invError = null;
    try {
      inv = inventoryWorktree(real, ctx);
    } catch (error) {
      invError = error.message;
    }
    if (inv && inv.keepReason) {
      keep(real, inv.keepReason);
      continue;
    }
    // An unreadable inventory is treated as needing salvage: salvage re-lists
    // and fails closed, so the tree is kept with the reason in failed[].
    const ignoredToSave = inv ? inv.ignored.length : 0;
    const needsSalvage = dirty || Boolean(invError) || (inv && inventoryNeedsSalvage(inv));
    if (dirty) out.counts.mergedDirty += 1;
    else if (needsSalvage) out.counts.ignoredOnly += 1;
    else out.counts.mergedClean += 1;
    if (needsSalvage && !ctx.salvageDirty) {
      out.skipped.push({ path: real, reason: invError ? `inventory-failed: ${invError}` : dirty ? 'dirty-needs-salvage-dirty' : 'ignored-files-need-salvage-dirty' });
      continue;
    }
    out.items.push({
      path: real,
      head: row.head,
      bytes: ctx.sizeOf(real),
      dirty: needsSalvage,
      ignoredToSave,
      reason: needsSalvage ? 'merged, uncommitted and ignored files salvaged first' : 'merged and clean',
    });
  }
  return out;
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

// Lock, salvage, recheck, remove. The per-worktree lock lives in the
// worktree's own git dir, so `git worktree remove` deletes it with the tree.
function removeWorktree(item, ctx) {
  const safe = guardTarget('worktrees', item.path, ctx);
  if (path.dirname(safe) !== realpathOrNull(ctx.sessionsRoot)) throw new Error(`janitor guard: ${safe} is outside the sessions root`);
  const gitdir = worktreeGitDir(safe);
  if (!gitdir) throw new KeepWorktree('gitdir-unresolvable');
  const lock = acquireExclusiveFile(path.join(gitdir, WORKTREE_LOCK_NAME), { label: 'janitor-worktree-lock' });
  try {
    let salvage = null;
    if (item.dirty) {
      try {
        const dest = salvageWorktree(safe, ctx);
        salvage = { dest, manifest: readCertifiedManifest(dest) };
      } catch (error) {
        if (error.code === 'KEEP') throw error;
        // Nothing unlinked, nothing removed; run() records this reason in failed[].
        throw new Error(`salvage incomplete, worktree kept: ${error.message}`);
      }
      if (ctx.afterSalvage) ctx.afterSalvage(safe, salvage.dest);
    }
    const why = recheckBeforeRemoval(item, ctx, salvage);
    if (why) throw new KeepWorktree(`changed before removal, worktree kept: ${why}`);
    unlinkTopLevelSymlinks(safe);
    gitIn(ctx.repo, ['worktree', 'remove', ...(item.dirty ? ['--force'] : []), safe]);
    return salvage ? salvage.dest : null;
  } finally {
    lock.release();
  }
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
  // Process proof is read once for planning and again, fresh, immediately
  // before each worktree removal.
  const readProcessProof = deps.readProcessProof || (deps.processProof ? () => deps.processProof : () => readProcessPaths());
  const processProof = readProcessProof();
  let releaseRefs = null;
  const ctx = {
    ...opts,
    sessionRegistryDir: opts.sessionRegistryDir || path.join(opts.dataDir, 'agent', 'desktop-session-registry'),
    now: deps.now ?? Date.now(),
    processProof,
    readProcessProof,
    sizeOf: deps.sizeOf || ((p) => dirBytes(p)),
    referencedReleases: deps.referencedReleases || (() => (releaseRefs ||= referencedReleaseNames({ ...opts, runCommand: deps.runCommand }))),
    spawnGit: deps.spawnGit,
    afterSalvage: deps.afterSalvage,
    notify: deps.notify,
  };
  const report = {
    ts: new Date(ctx.now).toISOString(),
    mode: opts.apply ? 'apply' : opts.alertOnly ? 'alert-only' : 'dry-run',
    salvageDirty: Boolean(opts.salvageDirty),
    diskBefore: diskUsage(opts.diskPath),
    categories: {},
    plannedBytes: 0,
    // Sum of the planned (du) size of every path actually removed.
    estimatedFreedBytes: 0,
    // Measured: free-space change on the disk across this run (null when
    // statfs is unavailable or nothing was applied). Salvage archives written
    // during the run count against it.
    actualFreedBytes: null,
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
      plan.estimatedFreedBytes = 0;
      // Only an 'ok' plan acts. blocked, absent and error plans delete nothing.
      if (opts.apply && plan.status === 'ok') {
        for (const item of plan.items) {
          try {
            if (category === 'worktrees') {
              const dest = removeWorktree(item, ctx);
              if (dest) (plan.salvaged ||= []).push({ path: item.path, archive: dest });
            } else removeTree(category, item.path, ctx);
            plan.removed.push(item.path);
            plan.estimatedFreedBytes += item.bytes || 0;
          } catch (error) {
            if (error.code === 'KEEP') plan.skipped.push({ path: item.path, reason: error.message });
            else plan.failed.push({ path: item.path, error: error.message });
          }
        }
        if (category === 'worktrees') gitIn(ctx.repo, ['worktree', 'prune'], { allowFail: true });
      }
      report.plannedBytes += plan.plannedBytes;
      report.estimatedFreedBytes += plan.estimatedFreedBytes;
      report.failed += plan.failed.length;
      report.categories[category] = plan;
    }
  }

  report.diskAfter = diskUsage(opts.diskPath);
  if (opts.apply && !opts.alertOnly && report.diskBefore && report.diskAfter) {
    report.actualFreedBytes = report.diskAfter.availBytes - report.diskBefore.availBytes;
  }
  const alertFreed = report.actualFreedBytes ?? report.estimatedFreedBytes;
  report.alert = await maybeAlert(ctx, report.diskAfter, alertFreed);
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
  if (report.mode === 'apply') {
    const actual = report.actualFreedBytes == null ? 'unknown' : fmtGb(report.actualFreedBytes);
    lines.push(`  freed: estimated ${fmtGb(report.estimatedFreedBytes)}, measured ${actual}${report.diskAfter ? `; disk after ${report.diskAfter.pct}%` : ''}`);
  } else lines.push(`  total planned: ${fmtGb(report.plannedBytes)}`);
  lines.push(`  alert: ${report.alert.sent ? 'sent' : `not sent (${report.alert.reason})`}`);
  return lines.join('\n');
}

if (require.main === module) {
  (async () => {
    let lock = null;
    try {
      const opts = parseArgs(process.argv.slice(2));
      // Only an acting run takes the run lock; a dry run changes nothing.
      if (opts.apply) lock = acquireRunLock(opts.runLock);
      const report = await run(opts);
      process.stdout.write(`${opts.json ? JSON.stringify(report) : formatReport(report)}\n`);
      if (!report.ok) process.exitCode = 2;
    } catch (error) {
      process.stderr.write(`[ec2-disk-janitor] ERROR: ${error.message}\n`);
      process.exitCode = 1;
    } finally {
      if (lock) lock.release();
    }
  })();
}

module.exports = {
  BACKUP_RESTORE_NAME,
  CATEGORIES,
  REBUILDABLE_DIRS,
  acquireExclusiveFile,
  acquireRunLock,
  recoverStaleLock,
  alertText,
  defaultOptions,
  diskUsage,
  formatReport,
  guardTarget,
  inventoryWorktree,
  parseArgs,
  parseWorktreeList,
  pathInUse,
  planBackupRestoreTemp,
  planHfCache,
  planReleases,
  planWorktrees,
  processOwnership,
  readProcessPaths,
  referencedReleaseNames,
  restoreSalvage,
  run,
  salvageWorktree,
  verifySalvage,
};
