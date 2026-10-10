#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// A restart that updates env copies this process env into the live service,
// and the card controller and healer coordinator require this module
// in-process. atomic-release.sh stages this file alone into /tmp, so the list
// is inlined (parity with scripts/lib/service-env-scrub.js is pinned by
// service-env-scrub.test.js) and the scrub never falls back to the raw env.
const RUN_SCOPED_ENV_PREFIXES = [
  'CARD_CONTROLLER_',
  'BRIEFING_CONTROLLER_',
  'BRIEFING_CARD_CONTROLLER_',
  'BRIEFING_NIGHT_',
  'CLAUDE_CODE_MESSAGING_',
  'CLAUDE_CODE_SESSION_',
];
const RUN_SCOPED_ENV_NAMES = [
  'BRIEFING_DATE',
  'BRIEFING_HUMAN_ACTION_TOKEN',
  'AMY_NIGHT_OWNER',
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  'CODEX_CI',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
];
function serviceEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (RUN_SCOPED_ENV_NAMES.includes(key)) continue;
    if (RUN_SCOPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    clean[key] = value;
  }
  return clean;
}

const SHA_RE = /^[0-9a-f]{40}$/i;
const ACTIVE_SCHEMA = 'atomic-release-transaction@1';
const DEFAULT_PM2_FOLLOWERS =
  'otter-ingest dispatch-processor ec2-spine-worker callback-watchdog gmail-amy-scan graphiti-subscription-gateway';
const DEFAULT_SYSTEMD_FOLLOWERS = 'signal-ingest-amy.service signal-flow-healer-amy.timer';

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
  return value;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ===========================================================================
// DEPLOY-OWNER LIVENESS (production defect 2026-08-24T21:07:36Z)
// ===========================================================================
// The standing deploy-owner timer sweeps this journal every 5 minutes. Before
// this guard recoverTransaction could not tell an IN-FLIGHT deploy from a
// CRASHED one: a swapped-and-proving journal ALWAYS looked like a crash. A
// sweep that landed inside a live deploy's proving window therefore rolled the
// healthy new release straight back out. That is exactly what happened to sha
// a6b7276d1: prepared 21:07:29.817Z, swapped .843Z, proving .867Z, then
// "crash-recovered-rollback" at 21:07:36.213Z, six seconds later, by its own
// housekeeping, while the deploy wrapper still printed success.
//
// Liveness is decided the way scripts/lib/controller-conflict-leases.js already
// decides it for controller leases: hostname + pid + the process START TIME, so
// a recycled pid cannot impersonate the original owner. Those helpers are
// DELIBERATELY duplicated here instead of imported, because atomic-release.sh
// scp's THIS FILE ALONE to /tmp on the release host for a remote deploy; it
// must depend on node builtins only or remote recovery breaks.
// Deliberately generous. It only ever applies to an owner whose liveness this
// host CANNOT probe (a cross-host deploy, or no /proc). The deploy shell beats
// before each long phase, but a beat can be lost to ssh transport, so the
// ceiling must comfortably exceed the longest legitimate restart plus health
// phase. Reclaiming late is cheap; reclaiming a live deploy is the defect.
const DEFAULT_MAX_PROVING_AGE_MS = 45 * 60 * 1000;

function processAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    // EPERM means the process EXISTS but is owned by another user: alive, not ours.
    return Boolean(error && error.code === 'EPERM');
  }
}

function linuxProcessStartTime(pid, { fsApi = fs, procRoot = '/proc' } = {}) {
  try {
    const stat = String(
      fsApi.readFileSync(path.join(procRoot, String(Number(pid)), 'stat'), 'utf8'),
    );
    // comm can contain spaces and parentheses; everything after the LAST ')'
    // is positional, so starttime is field 22 overall == index 19 after it.
    const close = stat.lastIndexOf(')');
    if (close < 0) return '';
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    return /^\d+$/.test(String(fields[19] || '')) ? String(fields[19]) : '';
  } catch {
    return '';
  }
}

// The DEPLOY that owns this transaction, NOT this helper process.
// WHY THIS IS NOT process.pid: atomic-release.sh runs this file as a SEPARATE
// short-lived node process per subcommand, so the pid recorded by `begin` has
// already exited by the time `begin` returns. A liveness guard reading it would
// call every deploy dead and change nothing. The owning deploy shell passes its
// own $$, its hostname, and its /proc start time.
function releaseOwner({ ownerPid, ownerHostname, ownerStartTime, hostname, processStart }) {
  const pid = Number(ownerPid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const host = String(ownerHostname || hostname || '');
  const startTime = String(
    ownerStartTime || (host === hostname ? processStart(pid) : '') || '',
  );
  return { pid, hostname: host, processStartTime: startTime };
}

// 'alive'   -- proven in-flight. NEVER recover; rolling this back IS the defect.
// 'dead'    -- proven gone: no such pid, or a live pid whose start time differs
//              from the recorded one, which means the NUMBER was recycled.
// 'unknown' -- no usable evidence: the owner runs on another host (remote
//              deploy) or /proc yielded no start time. Bounded by age below.
function deployOwnerLiveness(state, {
  hostname = os.hostname(),
  pidAlive = processAlive,
  processStart = linuxProcessStartTime,
} = {}) {
  const owner = (state && state.owner) || null;
  if (!owner) return 'unknown';
  if (String(owner.hostname || '') !== String(hostname || '')) return 'unknown';
  const pid = Number(owner.pid);
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  if (!pidAlive(pid)) return 'dead';
  const expected = String(owner.processStartTime || '');
  const actual = String(processStart(pid) || '');
  if (!expected || !actual) return 'unknown';
  return expected === actual ? 'alive' : 'dead';
}

// Freshest proof of life this transaction carries. Every phase mark refreshes
// heartbeatAt, so a deploy that is still walking its phases stays young even
// when its pid cannot be verified across hosts.
function transactionAgeMs(state, now) {
  const stamps = [state.heartbeatAt, state.provingAt, state.swappedAt, state.preparedAt]
    .map((value) => Date.parse(String(value || '')))
    .filter((value) => Number.isFinite(value));
  if (!stamps.length) return Number.POSITIVE_INFINITY;
  return Math.max(0, now() - Math.max(...stamps));
}

function directReleaseChild(candidate, releasesRoot) {
  const resolved = path.resolve(String(candidate || ''));
  return path.dirname(resolved) === path.resolve(releasesRoot) ? resolved : '';
}

function validateTransaction(state, releasesRoot, optLink) {
  if (!state || state.schema !== ACTIVE_SCHEMA) throw new Error('invalid release transaction schema');
  if (!SHA_RE.test(String(state.sha || ''))) throw new Error('invalid release transaction SHA');
  const nextTarget = directReleaseChild(state.nextTarget, releasesRoot);
  if (!nextTarget) throw new Error('release transaction next target is outside releases root');
  const sha = String(state.sha).toLowerCase();
  const nextName = path.basename(nextTarget).toLowerCase();
  if (!new RegExp(`^${sha}(?:\\.reland-[a-z0-9-]+)?$`).test(nextName)) {
    throw new Error('release transaction next target does not match its SHA');
  }
  const previousTarget = state.previousTarget
    ? directReleaseChild(state.previousTarget, releasesRoot)
    : '';
  if (state.previousTarget && !previousTarget) {
    throw new Error('release transaction previous target is outside releases root');
  }
  if (path.resolve(state.optLink) !== path.resolve(optLink)) {
    throw new Error('release transaction belongs to a different live link');
  }
  return { ...state, sha, nextTarget, previousTarget };
}

function beginTransaction({
  journal,
  history,
  sha,
  previousTarget,
  nextTarget,
  releasesRoot,
  optLink,
  ownerPid,
  ownerHostname,
  ownerStartTime,
  now = Date.now,
  hostname = os.hostname(),
  processStart = linuxProcessStartTime,
}) {
  if (!SHA_RE.test(String(sha || ''))) throw new Error('begin requires one full git SHA');
  if (fs.existsSync(journal)) {
    throw new Error(`unresolved atomic release transaction already exists at ${journal}`);
  }
  const state = validateTransaction(
    {
      schema: ACTIVE_SCHEMA,
      phase: 'prepared',
      sha: String(sha).toLowerCase(),
      previousTarget: String(previousTarget || ''),
      nextTarget: String(nextTarget || ''),
      releasesRoot: path.resolve(releasesRoot),
      optLink: path.resolve(optLink),
      history: String(history || ''),
      preparedAt: new Date(now()).toISOString(),
      heartbeatAt: new Date(now()).toISOString(),
      pid: process.pid,
      owner: releaseOwner({ ownerPid, ownerHostname, ownerStartTime, hostname, processStart }),
    },
    releasesRoot,
    optLink,
  );
  return writeJsonAtomic(journal, state);
}

function markTransaction({ journal, phase, now = Date.now }) {
  const state = readJson(journal);
  if (!state) throw new Error(`no active release transaction at ${journal}`);
  const allowed = new Set(['swapped', 'proving', 'rolled-back']);
  if (!allowed.has(String(phase))) throw new Error(`invalid release transaction phase ${phase}`);
  return writeJsonAtomic(journal, {
    ...state,
    phase,
    // Proof of life for a cross-host owner whose pid this box cannot inspect.
    heartbeatAt: new Date(now()).toISOString(),
    [`${String(phase).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())}At`]: new Date(now()).toISOString(),
  });
}

// Renewable proof of life. Phase marks are not periodic and the restart plus
// health phase can run for minutes, so a deploy whose pid this host cannot
// probe (a remote/ssh deploy owned by the operator box) would otherwise age
// past the ceiling while perfectly alive and be rolled back. The deploy shell
// beats before each long step, so only a genuinely stalled owner ages out.
function heartbeatTransaction({ journal, now = Date.now }) {
  const state = readJson(journal);
  if (!state) throw new Error(`no active release transaction at ${journal}`);
  return writeJsonAtomic(journal, {
    ...state,
    heartbeatAt: new Date(now()).toISOString(),
  });
}

function appendHistory(history, state) {
  if (!history) return;
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.appendFileSync(history, `${JSON.stringify(state)}\n`);
}

function closeTransaction({
  journal,
  outcome,
  expectSha = '',
  expectNextTarget = '',
  now = Date.now,
}) {
  const state = readJson(journal);
  if (!state) {
    // A deploy closing its OWN transaction must never find the journal gone.
    // If it is gone, something else resolved this release, which in production
    // means a sweeper rolled it back out. Silently returning null here is what
    // let a rolled-back deploy keep reporting DEPLOY_OK. A caller that names
    // what it expects to close gets a LOUD failure instead.
    if (expectSha || expectNextTarget) {
      throw new Error(
        `release transaction at ${journal} was already resolved by another process; this deploy cannot claim ${outcome}`,
      );
    }
    return null;
  }
  if (expectSha && String(state.sha || '').toLowerCase() !== String(expectSha).toLowerCase()) {
    throw new Error(
      `release transaction at ${journal} belongs to sha ${state.sha}, not ${expectSha}`,
    );
  }
  if (
    expectNextTarget &&
    path.resolve(String(state.nextTarget || '')) !== path.resolve(expectNextTarget)
  ) {
    throw new Error(
      `release transaction at ${journal} targets ${state.nextTarget}, not ${expectNextTarget}`,
    );
  }
  const closed = {
    ...state,
    phase: outcome === 'committed' ? 'committed' : 'rolled-back',
    outcome,
    closedAt: new Date(now()).toISOString(),
  };
  appendHistory(state.history, closed);
  fs.unlinkSync(journal);
  return closed;
}

// A committed receipt is appended and the journal unlinked BEFORE the release
// script re-reads the live link. If that post-close proof fails, durable
// history would otherwise still claim a release that is no longer live. This
// appends the correcting row so the receipt trail matches reality.
function appendCorrectiveReceipt({
  history,
  sha,
  nextTarget,
  optLink,
  outcome,
  observedTarget,
  now = Date.now,
}) {
  if (!history) return null;
  const row = {
    schema: ACTIVE_SCHEMA,
    phase: 'rolled-back',
    sha: String(sha || '').toLowerCase(),
    nextTarget: String(nextTarget || ''),
    optLink: String(optLink || ''),
    outcome: String(outcome || 'post-close-live-target-lost'),
    observedTarget: String(observedTarget || ''),
    corrects: 'committed',
    closedAt: new Date(now()).toISOString(),
  };
  appendHistory(history, row);
  return row;
}

function currentLinkTarget(optLink) {
  try {
    const target = fs.readlinkSync(optLink);
    return path.resolve(path.dirname(optLink), target);
  } catch {
    try {
      return fs.realpathSync(optLink);
    } catch {
      return '';
    }
  }
}

function atomicSwap(optLink, target) {
  const temp = `${optLink}.recovery-${process.pid}-${Date.now()}`;
  try {
    fs.symlinkSync(target, temp, 'dir');
    fs.renameSync(temp, optLink);
  } finally {
    try {
      if (fs.existsSync(temp) || fs.lstatSync(temp).isSymbolicLink()) fs.unlinkSync(temp);
    } catch {
      // rename normally consumed the temporary link
    }
  }
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: options.stdio || 'ignore',
    env: serviceEnv(),
  });
}

function restartStack({ pm2App, pm2Followers = [], systemdFollowers = [], runCommand = run }) {
  const main = runCommand('pm2', ['restart', pm2App, '--update-env']);
  if (main.error || main.status !== 0) throw new Error(`could not restart ${pm2App} during recovery`);
  for (const follower of pm2Followers) {
    const exists = runCommand('pm2', ['describe', follower]);
    if (!exists.error && exists.status === 0) {
      const restarted = runCommand('pm2', ['restart', follower, '--update-env']);
      if (restarted.error || restarted.status !== 0) {
        throw new Error(`could not restart ${follower} during recovery`);
      }
    }
  }
  for (const unit of systemdFollowers) {
    const exists = runCommand('systemctl', ['cat', unit]);
    if (!exists.error && exists.status === 0) {
      const restarted = runCommand('sudo', ['-n', 'systemctl', 'restart', unit]);
      if (restarted.error || restarted.status !== 0) {
        throw new Error(`could not restart ${unit} during recovery`);
      }
    }
  }
}

function proveHealth({ healthPort, attempts = 10, runCommand = run, wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }) {
  for (let index = 0; index < attempts; index += 1) {
    const result = runCommand('curl', [
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '-m',
      '8',
      `http://127.0.0.1:${healthPort}/health`,
    ], { stdio: 'pipe' });
    if (!result.error && result.status === 0 && String(result.stdout || '').trim() === '200') {
      return true;
    }
    if (index + 1 < attempts) wait(3000);
  }
  return false;
}

function recoverTransaction({
  journal,
  releasesRoot,
  optLink,
  pm2App,
  pm2Followers = [],
  systemdFollowers = [],
  healthPort,
  readTarget = currentLinkTarget,
  swap = atomicSwap,
  restart = restartStack,
  health = proveHealth,
  now = Date.now,
  hostname = os.hostname(),
  pidAlive = processAlive,
  processStart = linuxProcessStartTime,
  maxProvingAgeMs = DEFAULT_MAX_PROVING_AGE_MS,
} = {}) {
  const raw = readJson(journal);
  if (!raw) return { ok: true, action: 'none' };
  const state = validateTransaction(raw, releasesRoot, optLink);

  // ---- LIVENESS GATE: never recover a transaction that is still running ----
  // This runs BEFORE any read of the live link and before any mutation, so an
  // in-flight deploy is untouchable no matter which phase the sweep observes.
  // A proven-live owner is NEVER recovered and no age ceiling overrides that:
  // rolling back a healthy, running deploy is the exact defect being fixed, and
  // a live owner still owns its own rollback path. A wedged deploy surfaces as
  // this explicit receipt naming the pid rather than as silent damage.
  const liveness = deployOwnerLiveness(state, { hostname, pidAlive, processStart });
  if (liveness === 'alive') {
    return {
      ok: true,
      action: 'deploy-in-flight',
      sha: state.sha,
      ownerPid: state.owner.pid,
      reason: 'owner-process-alive',
    };
  }
  // No liveness evidence (cross-host owner, or /proc gave no start time): treat
  // a YOUNG transaction as in-flight, but let an OLD one recover. That ceiling
  // is what stops a recycled or unverifiable pid from masquerading as a live
  // deploy forever, which would wedge every future deploy on begin()'s
  // "unresolved transaction already exists" check.
  if (liveness === 'unknown') {
    const ageMs = transactionAgeMs(state, now);
    if (ageMs < maxProvingAgeMs) {
      return {
        ok: true,
        action: 'deploy-in-flight',
        sha: state.sha,
        ageMs,
        reason: 'owner-liveness-unknown-within-max-proving-age',
      };
    }
  }

  const liveTarget = readTarget(optLink);
  if (state.phase === 'committed') {
    closeTransaction({ journal, outcome: 'committed', now });
    return { ok: true, action: 'committed-cleanup', sha: state.sha };
  }
  if (liveTarget === state.previousTarget && state.phase !== 'prepared') {
    restart({ pm2App, pm2Followers, systemdFollowers });
    if (!health({ healthPort })) {
      throw new Error('previous release is live but its recovery health proof failed; transaction retained');
    }
    closeTransaction({ journal, outcome: 'interrupted-release-already-rolled-back', now });
    return { ok: true, action: 'proved-existing-rollback', sha: state.sha };
  }
  if (
    (liveTarget === state.previousTarget && state.phase === 'prepared') ||
    (state.phase === 'prepared' && !state.previousTarget && !liveTarget)
  ) {
    closeTransaction({ journal, outcome: 'rolled-back-before-swap', now });
    return { ok: true, action: 'already-previous', sha: state.sha };
  }
  if (liveTarget !== state.nextTarget) {
    throw new Error(
      `live target ${liveTarget || '<none>'} matches neither transaction target; manual recovery required`,
    );
  }
  if (!state.previousTarget || state.previousTarget === state.nextTarget) {
    throw new Error('interrupted release has no distinct previous target to restore');
  }
  swap(optLink, state.previousTarget);
  restart({ pm2App, pm2Followers, systemdFollowers });
  if (!health({ healthPort })) {
    throw new Error('previous release was restored but health proof failed; transaction retained');
  }
  closeTransaction({ journal, outcome: 'crash-recovered-rollback', now });
  return {
    ok: true,
    action: 'rolled-back-after-interrupted-swap',
    sha: state.sha,
    restoredTarget: state.previousTarget,
  };
}

function recoverProductionAtomicRelease({
  dataDir = process.env.SB_SHARED_DATA || '/opt/secondbrain-shared/data',
  journal = path.join(dataDir, 'agent', 'atomic-release-transaction.json'),
  releasesRoot = process.env.SB_RELEASES_ROOT || '/opt/secondbrain-releases',
  optLink = process.env.SB_OPT_LINK || '/opt/secondbrain',
  pm2App = process.env.SB_PM2_APP || 'secondbrain-backend',
  pm2Followers = list(process.env.SB_PM2_FOLLOWER_APPS || DEFAULT_PM2_FOLLOWERS),
  systemdFollowers = list(
    process.env.SB_SYSTEMD_FOLLOWER_UNITS || DEFAULT_SYSTEMD_FOLLOWERS,
  ),
  healthPort = process.env.SB_HEALTH_PORT || 3001,
  ...injected
} = {}) {
  return recoverTransaction({
    journal,
    releasesRoot,
    optLink,
    pm2App,
    pm2Followers,
    systemdFollowers,
    healthPort,
    ...injected,
  });
}

function parseArgs(argv) {
  const command = argv[0] || '';
  const args = {};
  for (let index = 1; index < argv.length; index += 1) {
    const key = String(argv[index] || '');
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    args[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return { command, args };
}

function list(value) {
  return String(value || '').split(/[\s,]+/).filter(Boolean);
}

function cli(argv = process.argv.slice(2)) {
  const { command, args } = parseArgs(argv);
  if (command === 'begin') {
    return beginTransaction({
      journal: args.journal,
      history: args.history,
      sha: args.sha,
      previousTarget: args.previous,
      nextTarget: args.next,
      releasesRoot: args['releases-root'],
      optLink: args['opt-link'],
      ownerPid: args['owner-pid'],
      ownerHostname: args['owner-host'],
      ownerStartTime: args['owner-start-time'],
    });
  }
  if (command === 'mark') return markTransaction({ journal: args.journal, phase: args.phase });
  if (command === 'heartbeat') return heartbeatTransaction({ journal: args.journal });
  if (command === 'close') {
    return closeTransaction({
      journal: args.journal,
      outcome: args.outcome,
      expectSha: args['expect-sha'],
      expectNextTarget: args['expect-next'],
    });
  }
  if (command === 'receipt') {
    return appendCorrectiveReceipt({
      history: args.history,
      sha: args.sha,
      nextTarget: args.next,
      optLink: args['opt-link'],
      outcome: args.outcome,
      observedTarget: args.observed,
    });
  }
  if (command === 'recover') {
    return recoverTransaction({
      journal: args.journal,
      releasesRoot: args['releases-root'],
      optLink: args['opt-link'],
      pm2App: args['pm2-app'],
      pm2Followers: list(args['pm2-followers']),
      systemdFollowers: list(args['systemd-followers']),
      healthPort: args['health-port'],
      ...(args['max-proving-age-ms']
        ? { maxProvingAgeMs: Number(args['max-proving-age-ms']) }
        : {}),
    });
  }
  throw new Error(`unknown command ${command || '<none>'}`);
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(cli())}\n`);
  } catch (error) {
    process.stderr.write(`[atomic-release-transaction] ${String(error.message || error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_PM2_FOLLOWERS,
  ACTIVE_SCHEMA,
  DEFAULT_MAX_PROVING_AGE_MS,
  processAlive,
  linuxProcessStartTime,
  releaseOwner,
  deployOwnerLiveness,
  transactionAgeMs,
  directReleaseChild,
  validateTransaction,
  beginTransaction,
  markTransaction,
  heartbeatTransaction,
  closeTransaction,
  appendCorrectiveReceipt,
  currentLinkTarget,
  atomicSwap,
  restartStack,
  proveHealth,
  recoverTransaction,
  recoverProductionAtomicRelease,
  cli,
};
