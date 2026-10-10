#!/usr/bin/env node
/**
 * Overnight heard-name resolver for Otter acoustic speaker arcs.
 *
 * Runs the whole-call marked-target LLM judge over:
 * 1. confirmed/enrolled known people, as QA calibration;
 * 2. remaining unresolved acoustic speaker arcs, as unlinked heard-name hypotheses.
 *
 * This intentionally does not link text-only names to people files. It only
 * produces durable name-judge artifacts that downstream Pareto/briefing code
 * can surface with confidence and evidence.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  fingerprintExactCallTarget,
  fingerprintTarget,
  normalizedMembers,
} = require('./lib/voice-name-judge-coverage.js');
const { readNameJudgeBackend } = require('./lib/name-judge-backend.js');
const { jevPreflight, nameJudgeArtifactCurrent } = require('./lib/jev-name-judge.js');
const { withReclusterPublishLock } = require('./lib/recluster-publish-lock.js');
const {
  recentUnknownTargetIdsFromArtifacts,
  resolverEligibleUnknownCluster,
} = require('./lib/otter-speaker-hypothesis-projection.js');

// A verdict from an older Jev question design does not count as judged: the
// first design (2026-09-18 22:19 CT) found 1 right name in 73 calibration calls,
// so voices it left unnamed must be judged again by the current design.
function outdatedJevArtifact(data) {
  return !nameJudgeArtifactCurrent(data);
}

const ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(ROOT, 'data'));
const VP_DIR = path.join(DATA_ROOT, 'life-archive', 'voiceprints');
const REGISTRY_PATH = path.join(DATA_ROOT, 'life-archive', 'voice-identity-registry.json');
const PARETO_PATH = path.join(VP_DIR, 'speaker-pareto-latest.json');
const INTEL_PATH = path.join(VP_DIR, 'otter-speaker-intelligence-latest.json');
const RECLUSTER_PATH = path.join(VP_DIR, 'recluster-latest.json');
const ENRICHED_DIR = path.join(DATA_ROOT, 'otter', 'enriched');
const ROSTER_PATH = path.join(VP_DIR, 'otter-call-speaker-rosters-latest.json');
const STATUS_PATH = path.join(VP_DIR, 'voice-identity-overnight-name-resolver-status.json');
const FAILURE_PATTERN_PATH = path.join(
  DATA_ROOT,
  'agent',
  'voice-name-resolver-failure-patterns.json',
);
const FAILURE_PATTERN_LOCK_PATH = `${FAILURE_PATTERN_PATH}.lock`;
const CANONICAL_RUN_LOCK_PATH = `${STATUS_PATH}.run-lock`;
const LOG_DIR = path.join(ROOT, 'logs', 'voice-name-resolver');
const LLM_NAME_JUDGE_DIR = path.join(VP_DIR, 'llm-name-judges');
let activeStatusContext = null;
let activeFailurePatternSnapshot = null;
let terminalFailure = false;

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function argvValue(argv, name, fallback = '') {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

/**
 * The singleton status file is the live System Health producer. Only a run over
 * its complete declared scope may replace it. Targeted orphan repair and
 * limited catch-up runs are useful, but their partial target sets are not the
 * current resolver-health denominator and therefore write scoped receipts.
 */
function resolverStatusContext(
  argv = process.argv,
  { dataRoot = DATA_ROOT, canonicalPath = STATUS_PATH } = {},
) {
  const explicitScope = String(argvValue(argv, '--status-scope', '')).trim().toLowerCase();
  const canonicalRequested = argv.includes('--canonical-health-status');
  let scope = explicitScope;
  if (scope && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(scope)) {
    throw new Error('--status-scope must contain only letters, numbers, underscores, or hyphens');
  }
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(scope)) {
    throw new Error('--status-scope cannot use a reserved Windows device name');
  }
  if (scope === 'canonical-health') {
    throw new Error('--status-scope canonical-health is reserved for canonical authority');
  }
  const targets = String(argvValue(argv, '--targets', '')).trim();
  const limit = Number(argvValue(argv, '--limit', '0')) || 0;
  if (canonicalRequested && scope) {
    throw new Error('--canonical-health-status and --status-scope are mutually exclusive');
  }
  if (canonicalRequested && (targets || limit > 0)) {
    throw new Error('--canonical-health-status requires a complete declared scope');
  }
  if (canonicalRequested) {
    return { path: canonicalPath, authority: 'canonical-health', scope: 'canonical-health' };
  }
  if (!scope && targets) {
    const targetIds = targets
      .split(/[,;]/)
      .map((value) => value.trim())
      .filter(Boolean)
      .sort();
    const digest = crypto
      .createHash('sha256')
      .update(JSON.stringify({ argv: argv.slice(2), targetIds }))
      .digest('hex')
      .slice(0, 16);
    scope = `partial-targets-${digest}`;
  } else if (!scope && limit > 0) {
    const digest = crypto
      .createHash('sha256')
      .update(JSON.stringify(argv.slice(2)))
      .digest('hex')
      .slice(0, 12);
    scope = `partial-limit-${Math.floor(limit)}-${digest}`;
  } else if (!scope) {
    const digest = crypto
      .createHash('sha256')
      .update(JSON.stringify(argv.slice(2)))
      .digest('hex')
      .slice(0, 16);
    scope = `adhoc-${digest}`;
  }
  return {
    path: path.join(dataRoot, 'agent', 'voice-name-resolver-status', `${scope}.json`),
    authority: 'scoped-job',
    scope,
  };
}

function resolverStatusPath(argv = process.argv, options = {}) {
  return resolverStatusContext(argv, options).path;
}

function authorityErrorStatusContext(
  argv = process.argv,
  { dataRoot = DATA_ROOT } = {},
) {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(argv.slice(2)))
    .digest('hex')
    .slice(0, 16);
  const scope = `authority-error-${digest}`;
  return {
    path: path.join(dataRoot, 'agent', 'voice-name-resolver-status', `${scope}.json`),
    authority: 'scoped-job',
    scope,
  };
}

function shouldRunCalibrationGate(statusContext) {
  return statusContext?.authority === 'canonical-health';
}

function setTerminalFailure(value) {
  terminalFailure = Boolean(value);
}

function hasArg(name) {
  return process.argv.includes(name);
}

function resumableResults(previousResults, currentTasks) {
  const currentByKey = new Map(currentTasks.map((task) => [`${task.kind}:${task.target}`, task]));
  return (previousResults || []).filter((row) => {
    if (!row?.ok) return false;
    const current = currentByKey.get(`${row.kind}:${row.target}`);
    if (!current) return false;
    if (row.kind !== 'unknown') return true;
    return Boolean(row.input_fingerprint) && row.input_fingerprint === current.input_fingerprint;
  });
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  let renamed = false;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        fs.unlinkSync(temp);
      } catch {}
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withFailurePatternLock(fn, lockPath = FAILURE_PATTERN_LOCK_PATH) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 2_000;
  let fd = null;
  while (fd == null) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lockPath).mtimeMs > 30_000;
      } catch {
        stale = true;
      }
      if (stale) {
        try {
          fs.unlinkSync(lockPath);
        } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error('voice-name-resolver-failure-pattern-lock-unavailable');
      }
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user; ESRCH means it
    // is gone. Any other error is treated as "not confirmed alive" so a
    // broken lock cannot wedge every future canonical run forever.
    return Boolean(error) && error.code === 'EPERM';
  }
}

/**
 * The singleton status file only has one canonical writer at a time. Without
 * this lock, an overnight canonical run already in flight and a second
 * canonical invocation (for example a coordinator-triggered targeted
 * refresh that reuses --canonical-health-status) independently resolve
 * targets against the same recluster/roster snapshot and each call
 * writeTerminalStatus; the run that finishes last silently overwrites the
 * other's completed targets and republishes stale provenance, matching the
 * observed "N selected target(s) failed" / "Pareto and roster provenance do
 * not match" flapping. Acquiring this lock makes a second concurrent
 * canonical run exit immediately without touching the singleton status
 * file, instead of racing the first run.
 */
function acquireCanonicalRunLock(lockPath = CANONICAL_RUN_LOCK_PATH) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    const existing = readJson(lockPath, null);
    const holderPid = existing && Number(existing.pid);
    if (isPidAlive(holderPid)) {
      return { acquired: false, holderPid, startedAt: (existing && existing.started_at) || null };
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {}
    fd = fs.openSync(lockPath, 'wx', 0o600);
  }
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  fs.closeSync(fd);
  return { acquired: true };
}

function releaseCanonicalRunLock(lockPath = CANONICAL_RUN_LOCK_PATH) {
  try {
    const existing = readJson(lockPath, null);
    if (existing && Number(existing.pid) === process.pid) fs.unlinkSync(lockPath);
  } catch {}
}

function slug(value) {
  return String(value || 'target')
    .replace(/^unknown:/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function confirmedPeopleTargets() {
  const registry = readJson(REGISTRY_PATH, {});
  const out = [];
  for (const [personId, person] of Object.entries(registry.people || {})) {
    const confirmed =
      String(person?.identity_confirmation_status || '').startsWith('confirmed') &&
      person?.voiceprint_status === 'enrolled';
    if (!confirmed) continue;
    const enrollmentCount = Number(person?.voiceprint_enrollments || 0);
    if (enrollmentCount <= 0) continue;
    out.push({
      kind: 'known',
      target: personId,
      display_name: person.display_name || personId,
      priority: 100000 + enrollmentCount,
    });
  }
  out.sort((a, b) => b.priority - a.priority || a.target.localeCompare(b.target));
  return out;
}

function unknownTargets(reclusterOverride = null) {
  const recluster = reclusterOverride || readJson(RECLUSTER_PATH, { clusters: [] });
  const currentClusterIds = new Set(
    (recluster.clusters || [])
      .map((cluster) => String(cluster?.cluster_id || ''))
      .filter(Boolean),
  );
  return (recluster.clusters || [])
    .filter((cluster) =>
      resolverEligibleUnknownCluster(cluster, {
        loadEnriched: (otid) => readJson(path.join(ENRICHED_DIR, `${otid}.json`), null),
        currentClusterIds,
      }),
    )
    .map((cluster) => {
      const calls = new Set(cluster.otids || []).size;
      const segments = Number(cluster.size || (cluster.members || []).length || 0);
      return {
        kind: 'unknown',
        target: cluster.cluster_id,
        display_name: cluster.cluster_id,
        calls,
        words: 0,
        segments,
        priority: calls * 1_000_000 + segments,
        input_fingerprint: fingerprintTarget(recluster, cluster.cluster_id),
        members: normalizedMembers(cluster),
      };
    })
    .sort((a, b) => b.priority - a.priority || a.target.localeCompare(b.target));
}

function existingJudgeTargetKeys(
  tasks = [],
  {
    judgeDir = LLM_NAME_JUDGE_DIR,
    loadEnriched = (otid) => readJson(path.join(ENRICHED_DIR, `${otid}.json`), null),
    // The orphan re-judge passes false: the orphan report counts a target as
    // resolved only under its CURRENT whole-cluster fingerprint, so an older
    // exact-call acceptance must not mark an orphan precompleted (2026-09-23,
    // unknown_voice_ecapa_df57514875189817 was skipped forever that way).
    exactCallTerminal = true,
  } = {},
) {
  const keys = new Set();
  const tasksByTarget = new Map(
    tasks
      .filter((task) => task.kind === 'unknown')
      .map((task) => [task.target, task]),
  );
  const exactCoverage = new Map();
  if (!fs.existsSync(judgeDir)) return keys;
  for (const name of fs.readdirSync(judgeDir)) {
    if (!/^name-judge-.*\.json$/i.test(name) || name === 'name-judge-latest.json') continue;
    const data = readJson(path.join(judgeDir, name), {});
    if (outdatedJevArtifact(data)) continue;
    const summaryByTarget = new Map(
      (data.target_summaries || []).map((row) => [row?.target, row || {}]),
    );
    for (const row of data.judged?.targets || []) {
      const task = tasksByTarget.get(row?.target);
      const fingerprint =
        row?.input_fingerprint || summaryByTarget.get(row?.target)?.input_fingerprint || '';
      const summary = summaryByTarget.get(row?.target) || {};
      const coverageComplete =
        row?.coverage_complete === true ||
        summary.coverage_complete === true;
      if (
        row?.target &&
        task?.input_fingerprint &&
        fingerprint === task.input_fingerprint &&
        coverageComplete
      ) {
        keys.add(`unknown:${row.target}`);
        continue;
      }
      if (
        !exactCallTerminal ||
        !row?.target ||
        !task ||
        !coverageComplete ||
        String(summary.coverage_scope || row.coverage_scope || '') !== 'exact_call'
      ) {
        continue;
      }
      const scopedOtids = [...new Set(summary.scoped_otids || [])]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .sort();
      const currentMembers = task.members || [];
      const scopedMembers = currentMembers.filter((member) => scopedOtids.includes(member.otid));
      if (!scopedOtids.length || !scopedMembers.length) continue;
      if (scopedOtids.some((otid) => !scopedMembers.some((member) => member.otid === otid))) {
        continue;
      }
      const sourceRevisionByOtid = {};
      let current = true;
      for (const otid of scopedOtids) {
        const revision = String(loadEnriched(otid)?.source_revision || '').toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(revision)) {
          current = false;
          break;
        }
        sourceRevisionByOtid[otid] = revision;
      }
      if (!current) continue;
      const trackKeys = scopedMembers.map(
        (member) => `${member.otid}|${member.speaker_model_label}`,
      );
      const expectedExactFingerprint = fingerprintExactCallTarget({
        target: row.target,
        sourceRevisionByOtid,
        trackKeys,
      });
      if (!expectedExactFingerprint || fingerprint !== expectedExactFingerprint) continue;
      const aggregate = exactCoverage.get(row.target) || { decisions: new Map() };
      const acceptedName = String(row.best_name || '').trim();
      const decisionKey = [...trackKeys].sort().join('||');
      const generatedAt = Date.parse(String(data.generated_at || '')) || 0;
      const priorDecision = aggregate.decisions.get(decisionKey);
      if (!priorDecision || generatedAt >= priorDecision.generatedAt) {
        aggregate.decisions.set(decisionKey, {
          acceptedName,
          generatedAt,
          trackKeys,
        });
      }
      exactCoverage.set(row.target, aggregate);
    }
    for (const row of data.calibration || []) {
      if (row?.target) keys.add(`known:${row.target}`);
    }
  }
  for (const [target, aggregate] of exactCoverage) {
    const task = tasksByTarget.get(target);
    const coveredMembers = new Set();
    const acceptedNames = new Map();
    for (const decision of aggregate.decisions.values()) {
      for (const trackKey of decision.trackKeys) coveredMembers.add(trackKey);
      if (decision.acceptedName) {
        const normalized = decision.acceptedName.toLowerCase().replace(/\s+/g, ' ');
        acceptedNames.set(normalized, decision.acceptedName);
      }
    }
    const expectedMembers = new Set(
      (task?.members || []).map((member) => `${member.otid}|${member.speaker_model_label}`),
    );
    const allCurrentMembersCovered =
      expectedMembers.size > 0 &&
      [...expectedMembers].every((member) => coveredMembers.has(member));
    // Owner override and the current core contract make an exact-call Jev
    // acceptance terminal at p>=0.70 plus margin. Remaining calls are not
    // re-paid after that precise accepted assignment; full current membership
    // is required only to seal abstention or a contested-name disposition.
    // A non-empty best_name is trusted only from the current Jev method; the
    // writer is the authority that enforces p>=0.70 and the 0.25 margin.
    const oneUncontestedAcceptedName = acceptedNames.size === 1;
    const terminalNoNameOrConflict =
      allCurrentMembersCovered && acceptedNames.size !== 1;
    if (oneUncontestedAcceptedName || terminalNoNameOrConflict) {
      keys.add(`unknown:${target}`);
    }
  }
  return keys;
}

// The rolling window must be computed ONCE per run and then shared by both the code that
// SELECTS targets and the code that SEALS the scope into the status artifact. Computing it
// twice lets the two disagree whenever the day key advances between the calls, which seals a
// scope the run never actually worked and leaves the health check permanently unsatisfiable.
function computeRecentScope(recentDays, reclusterOverride = null) {
  if (!(recentDays > 0)) return null;
  return recentUnknownTargetIdsFromArtifacts({
    recluster: reclusterOverride || readJson(RECLUSTER_PATH, { clusters: [] }),
    roster: readJson(ROSTER_PATH, { calls: [] }),
    loadEnriched: (otid) => readJson(path.join(ENRICHED_DIR, `${otid}.json`), null),
    days: recentDays,
  });
}

// A target is its id. The recluster can carry two clusters under one cluster_id (only one of
// them in the recent window); the recency filter keys on id, so both used to pass and the seal
// listed the id twice, which the health reader's exact set equality then rejected
// (2026-09-28: 35 sealed vs 34 current). Keep the first, highest-priority task per target.
function uniqueTargetTasks(tasks) {
  const seen = new Set();
  return tasks.filter((task) => {
    const key = `${task.kind}:${String(task.target || '')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function taskList(recentScope = null, reclusterOverride = null) {
  const includeKnown = !hasArg('--unknown-only');
  const includeUnknown = !hasArg('--known-only');
  const minCalls = Number(arg('--min-calls', '0')) || 0;
  const targetsArg = arg('--targets', '');
  let tasks = [
    ...(includeKnown ? confirmedPeopleTargets() : []),
    ...(includeUnknown
      ? unknownTargets(reclusterOverride).filter((row) => row.calls >= minCalls)
      : []),
  ];
  const recentDays = Number(arg('--recent-days', '0')) || 0;
  if (recentDays > 0) {
    // No silent recomputation fallback. If selection could compute its own window whenever a
    // caller forgot to pass one, the sealed frame and the worked frame could silently diverge
    // again, which is the exact defect this path was fixed for. Fail loud instead.
    if (!recentScope) {
      throw new Error(
        'taskList requires the run-scoped recent window when --recent-days is set, so selection and sealing share one computation.',
      );
    }
    const recentIds = new Set(recentScope.ids);
    // Recency is deliberately the ONLY scope here. Targets whose completed
    // judgment was orphaned by a recluster are NOT rescued in this filter: that
    // is owned by scripts/voice-name-judge-orphan-rejudge.js, which classifies
    // orphans, dispatches them in capped durable batches with artifact-verified
    // receipts, and runs from every path that publishes new cluster membership.
    // It invokes this resolver with --targets and no --recent-days, so it does
    // not pass through this branch at all. A second rescue path here would be an
    // uncapped competitor for the same nightly model budget, and two mechanisms
    // for one problem is how a card flips for reasons nobody can explain.
    tasks = tasks.filter((task) => task.kind !== 'unknown' || recentIds.has(task.target));
  }
  if (targetsArg) {
    const wanted = new Set(
      targetsArg
        .split(/[,;]/)
        .map((part) => part.trim())
        .filter(Boolean),
    );
    tasks = tasks.filter(
      (task) => wanted.has(task.target) || wanted.has(`${task.kind}:${task.target}`),
    );
  }
  return uniqueTargetTasks(tasks);
}

function childArgs(
  task,
  { progressFile = '', progressRunId = '', progressTaskFingerprint = '' } = {},
) {
  const maxWindows = task.kind === 'known' ? Number(arg('--known-max-windows', '16')) || 16 : 0;
  const batchSize = Number(arg('--batch-size', '3')) || 3;
  const targets =
    Array.isArray(task.targets) && task.targets.length
      ? task.targets.map((row) => row.target).join(',')
      : '';
  const args = [
    'scripts/voice-identity-llm-name-judge.js',
    task.kind === 'known' ? '--calibrate' : targets ? '--targets' : '--target',
    targets || task.target,
    '--max-windows',
    String(maxWindows),
    '--batch-size',
    String(batchSize),
    '--min-clear-evidence',
    arg('--min-clear-evidence', '2') || '2',
    '--write',
    '--llm-timeout-ms',
    arg('--llm-timeout-ms', '300000') || '300000',
  ];
  if (task.kind === 'unknown' || !targets) args.push('--adaptive');
  if (progressFile) {
    args.push('--progress-file', progressFile);
    if (progressRunId) args.push('--progress-run-id', progressRunId);
    if (progressTaskFingerprint) {
      args.push('--progress-task-fingerprint', progressTaskFingerprint);
    }
  }
  if (hasArg('--stop-early')) args.push('--stop-early');
  return args;
}

function childProgressFile(task, index, progressRunId = '') {
  return path.join(
    VP_DIR,
    'voice-name-resolver-progress',
    slug(progressRunId || 'unscoped'),
    `${String(index + 1).padStart(3, '0')}-${task.kind}-${slug(task.target)}.json`,
  );
}

function validateTaskProgress(
  progress,
  { progressRunId = '', taskFingerprint = '', targetCount = 1 } = {},
) {
  if (!progress || typeof progress !== 'object') return null;
  if (progressRunId && String(progress.run_id || '') !== String(progressRunId)) return null;
  if (taskFingerprint && String(progress.task_fingerprint || '') !== String(taskFingerprint)) {
    return null;
  }
  const expectedTargets = Math.max(1, Number(targetCount) || 1);
  const totalTargets = Number(progress.total_targets);
  const completedTargets = Number(progress.completed_targets);
  if (!Number.isFinite(totalTargets) || totalTargets !== expectedTargets) return null;
  if (
    !Number.isFinite(completedTargets) ||
    completedTargets < 0 ||
    completedTargets > expectedTargets
  ) {
    return null;
  }
  return progress;
}

function currentStatusContext() {
  return activeStatusContext || resolverStatusContext();
}

function loadExistingStatus({ statusContext = currentStatusContext() } = {}) {
  return readJson(statusContext.path, {});
}

function loadFailurePatterns({ failurePatternPath = FAILURE_PATTERN_PATH } = {}) {
  const shared = readJson(failurePatternPath, null);
  if (shared?.failure_patterns && typeof shared.failure_patterns === 'object') {
    return shared.failure_patterns;
  }
  return readJson(STATUS_PATH, {})?.failure_patterns || {};
}

function changedFailurePatternKeys(previous = {}, next = {}) {
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])].filter(
    (key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]),
  );
}

function updateSharedFailurePatterns(
  next,
  {
    previous = activeFailurePatternSnapshot || {},
    failurePatternPath = FAILURE_PATTERN_PATH,
    lockPath = FAILURE_PATTERN_LOCK_PATH,
  } = {},
) {
  const touched = changedFailurePatternKeys(previous, next);
  if (!touched.length) return;
  withFailurePatternLock(() => {
    const latest = readJson(failurePatternPath, {})?.failure_patterns || {};
    const merged = { ...latest };
    for (const key of touched) {
      if (Object.prototype.hasOwnProperty.call(next, key)) merged[key] = next[key];
      else delete merged[key];
    }
    saveJson(failurePatternPath, {
      schema: 'life_archive.voice_name_resolver_failure_patterns.v1',
      updated_at: new Date().toISOString(),
      failure_patterns: merged,
    });
  }, lockPath);
  activeFailurePatternSnapshot = JSON.parse(JSON.stringify(next));
}

function canonicalScopeInputFailure(
  {
    statusContext,
    recentDays,
    reclusterPath = RECLUSTER_PATH,
    rosterPath = ROSTER_PATH,
  } = {},
) {
  if (statusContext?.authority !== 'canonical-health') return null;
  const recluster = readJson(reclusterPath, null);
  if (!recluster || !Array.isArray(recluster.clusters)) {
    return `canonical resolver scope requires a readable recluster artifact: ${reclusterPath}`;
  }
  if (Number(recentDays || 0) > 0) {
    const roster = readJson(rosterPath, null);
    if (!roster || !Array.isArray(roster.calls) || roster.calls.length === 0) {
      return `canonical rolling resolver scope requires a readable non-empty roster: ${rosterPath}`;
    }
  }
  return null;
}

function selectPendingTasks(all, completedKeys, limit = 0) {
  const pending = all.filter((task) => !completedKeys.has(`${task.kind}:${task.target}`));
  return {
    pending,
    selected: limit > 0 ? pending.slice(0, limit) : pending,
  };
}

function normalizeFailureError(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\b/g, '<timestamp>')
    .replace(/\b(?:pid|process)\s*[:=]?\s*\d+\b/g, 'pid <n>')
    .replace(/\b[0-9a-f]{16,}\b/g, '<id>')
    .replace(/[a-z]:\\[^\r\n:]+/gi, '<path>')
    .replace(/\/[^\s:]+(?:\/[^\s:]+)+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

function effectiveTaskFingerprint(task) {
  const effective = {
    kind: task?.kind || '',
    target: task?.target || '',
    targets: (task?.targets || []).map((row) => row?.target || ''),
    input_fingerprints: [
      task?.input_fingerprint || '',
      ...(task?.targets || []).map((row) => row?.input_fingerprint || ''),
    ],
    child_args: childArgs(task || {}),
  };
  return crypto.createHash('sha256').update(JSON.stringify(effective)).digest('hex');
}

function failurePatternKey(task) {
  return `${task?.kind || 'unknown'}:${task?.target || ''}`;
}

function updateFailurePatterns(patterns, task, result) {
  const next = { ...(patterns || {}) };
  const key = failurePatternKey(task);
  if (result?.ok) {
    delete next[key];
    return next;
  }
  const effectiveArgs = effectiveTaskFingerprint(task);
  const normalizedError = normalizeFailureError(
    result?.normalized_error || result?.error || `exit code ${result?.exit_code ?? 'unknown'}`,
  );
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${effectiveArgs}\n${normalizedError}`)
    .digest('hex');
  const previous = next[key];
  next[key] = {
    effective_args_sha256: effectiveArgs,
    normalized_error: normalizedError,
    failure_fingerprint: fingerprint,
    consecutive_failures:
      previous?.failure_fingerprint === fingerprint
        ? Number(previous.consecutive_failures || 0) + 1
        : 1,
    last_failed_at: new Date().toISOString(),
  };
  return next;
}

function shouldPatternGuardTask(task, patterns) {
  const previous = patterns?.[failurePatternKey(task)];
  return Boolean(
    previous &&
    Number(previous.consecutive_failures || 0) >= 3 &&
    previous.effective_args_sha256 === effectiveTaskFingerprint(task),
  );
}

function completionPhase({ noRefreshRequested = false, refreshResults = [] } = {}) {
  if (noRefreshRequested) return 'completed_no_refresh_requested';
  return refreshResults.length && refreshResults.every((row) => row.ok)
    ? 'completed'
    : 'completed_with_refresh_warning';
}

function terminalInputStatus(
  finalState,
  {
    reclusterPath = RECLUSTER_PATH,
    noRefreshRequested = false,
    refreshResults = [],
  } = {},
) {
  let currentReclusterSha256 = '';
  try {
    currentReclusterSha256 = crypto
      .createHash('sha256')
      .update(fs.readFileSync(reclusterPath))
      .digest('hex');
  } catch {}
  const sealedReclusterSha256 = String(finalState?.target_scope?.recluster_sha256 || '');
  if (!currentReclusterSha256 || currentReclusterSha256 !== sealedReclusterSha256) {
    return {
      ...finalState,
      phase: 'inputs_advanced_retry_required',
      error:
        'Recluster input advanced while the canonical name resolver was running; retry against the current exact scope.',
      input_advanced: {
        sealed_recluster_sha256: sealedReclusterSha256,
        current_recluster_sha256: currentReclusterSha256,
      },
      refresh_results: refreshResults,
    };
  }
  return {
    ...finalState,
    phase: completionPhase({ noRefreshRequested, refreshResults }),
    refresh_results: refreshResults,
  };
}

function writeTerminalStatus(
  finalState,
  {
    statusContext = currentStatusContext(),
    reclusterPath = RECLUSTER_PATH,
    noRefreshRequested = false,
    refreshResults = [],
    writeStatusFn = writeStatus,
    withLockFn = withReclusterPublishLock,
  } = {},
) {
  const canonical = statusContext?.authority === 'canonical-health';
  const publish = () => {
    const state = canonical
      ? terminalInputStatus(finalState, {
          reclusterPath,
          noRefreshRequested,
          refreshResults,
        })
      : {
          ...finalState,
          phase: completionPhase({ noRefreshRequested, refreshResults }),
          refresh_results: refreshResults,
        };
    return writeStatusFn(state);
  };
  return canonical ? withLockFn(reclusterPath, publish) : publish();
}

function failedTargetCount(results = []) {
  return (results || [])
    .filter((row) => !row?.ok)
    .reduce((sum, row) => sum + Math.max(1, Number(row?.target_count || 1)), 0);
}

function completedTargetCount(results = []) {
  return (results || []).reduce((sum, row) => {
    const targetCount = Math.max(1, Number(row?.target_count || 1));
    if (row?.ok) return sum + targetCount;
    if (row?.progress_state !== 'current') return sum;
    const durableCount = Number(row?.progress?.completed_targets);
    if (!Number.isFinite(durableCount)) return sum;
    return sum + Math.max(0, Math.min(targetCount, durableCount));
  }, 0);
}

const NAME_RESOLVER_RUNG_ORDER = Object.freeze(['claude-cli', 'codex']);
// Kept equal to the judge's JUDGE_SCREEN_MODEL; a test pins the two together.
const JUDGE_SCREEN_MODEL = 'claude-haiku-4-5';

// ONE tiny probe through the briefing execution boundary before the overnight
// fan-out. briefingContext pins this work to subscription Codex and the briefing
// model ceiling, regardless of stale brain-switch or rung-order state. If that
// permitted rung is down, abort up front and stamp failed_preflight so the
// briefing can surface the outage honestly. deps is a test seam: { askAIFn }.
async function runLadderPreflight(deps = {}) {
  // auth-jev-speaker-naming (ExampleCo 2026-09-18): when the name judge runs on Jev,
  // the fan-out depends on Jev, not on Claude or Codex, so probe Jev instead.
  const backend = deps.backend || (deps.askAIFn ? 'ladder' : readNameJudgeBackend());
  if (backend === 'jev') {
    const probe = await jevPreflight(deps);
    if (probe.ok) return { ok: true, backend: 'jev' };
    return {
      ok: false,
      status: {
        phase: 'aborted_failed_preflight',
        failed_preflight: true,
        reason: `Jev name-judge preflight failed; aborting name-judge fan-out without falling back to Claude or Codex: ${probe.reason}`,
      },
    };
  }
  const ladder = deps.askAIFn || require('./lib/ask-ai.js').askAI;
  let ok = false;
  try {
    const out = await ladder('Reply with the single word: ok', {
      surface: 'voice-name-resolver-preflight',
      silent: true,
      maxTokens: 8,
      rungOrder: [...NAME_RESOLVER_RUNG_ORDER],
      briefingContext: true,
      // Same lean boundary as the judge's screen pass. Without it this one-word
      // liveness ping started a full Claude Code session on the ceiling model
      // with Amy's whole global context loaded.
      toolLess: true,
      claudeModel: JUDGE_SCREEN_MODEL,
      claudeSystemPrompt: 'Reply with the single word: ok',
    });
    // askAI returns the empty string when this exact briefing evidence already
    // has a current successful context receipt. A rapid supervised resume must
    // reuse that proof instead of converting no-repeat protection into a false
    // provider outage. Injected empty results remain failures in tests.
    if (out === '' && !deps.askAIFn) return { ok: true, reused: true };
    ok = Boolean(out && String(out.text || '').trim());
  } catch {
    ok = false;
  }
  if (ok) return { ok: true };
  return {
    ok: false,
    status: {
      phase: 'aborted_failed_preflight',
      failed_preflight: true,
      reason:
        'LLM ladder preflight failed on both permitted subscription rungs (Claude then Codex); aborting name-judge fan-out before burning the night; paid APIs are not permitted',
    },
  };
}

function summarizeResult(file) {
  const data = readJson(file, {});
  const targets = data?.judged?.targets || [];
  const calibration = data?.calibration || [];
  return {
    generated_at: data.generated_at || '',
    judged_targets: targets.map((row) => ({
      target: row.target,
      best_name: row.best_name || null,
      confidence: row.confidence || null,
      clear_evidence_count: row.clear_evidence_count || 0,
      counterevidence_count: row.counterevidence_count || 0,
    })),
    calibration: calibration.map((row) => ({
      target: row.target,
      expected: row.expected,
      actual: row.actual,
      pass: row.pass,
      outcome: row.outcome,
    })),
  };
}

function writeStatus(
  state,
  {
    statusContext = currentStatusContext(),
    dataRoot = DATA_ROOT,
    failurePatternPath = FAILURE_PATTERN_PATH,
    failurePatternLockPath = null,
    persistFailurePatterns = true,
    force = false,
  } = {},
) {
  if (terminalFailure && !force) return readJson(statusContext.path, {});
  const payload = {
    ...state,
    schema: 'life_archive.voice_identity_overnight_name_resolver.v1',
    updated_at: new Date().toISOString(),
    pid: process.pid,
    status_authority: statusContext.authority,
    status_scope: statusContext.scope,
    status_file: path.relative(dataRoot, statusContext.path).replace(/\\/g, '/'),
  };
  saveJson(statusContext.path, payload);
  if (
    persistFailurePatterns &&
    state?.failure_patterns &&
    typeof state.failure_patterns === 'object'
  ) {
    try {
      updateSharedFailurePatterns(state.failure_patterns, {
        failurePatternPath,
        lockPath: failurePatternLockPath || `${failurePatternPath}.lock`,
      });
    } catch (error) {
      payload.failure_pattern_sidecar_unavailable =
        error && error.message ? error.message : String(error);
      saveJson(statusContext.path, payload);
    }
  }
  return payload;
}

function resolverProgressState(stateBase, failurePatterns, fields = {}) {
  return { ...stateBase, ...fields, failure_patterns: failurePatterns };
}

function buildTargetScope(tasks, reclusterPath = RECLUSTER_PATH, options = {}) {
  // The sealed scope is a set: a duplicate id would never equal the reader's current set.
  const unknownTargetIds = [
    ...new Set(
      tasks
        .filter((task) => task.kind === 'unknown')
        .map((task) => String(task.target || ''))
        .filter(Boolean),
    ),
  ].sort();
  const knownTargetIds = [
    ...new Set(
      tasks
        .filter((task) => task.kind === 'known')
        .map((task) => String(task.target || ''))
        .filter(Boolean),
    ),
  ].sort();
  const recentDays = Math.max(0, Number(options.recentDays || 0));
  const lifetimeUnknownTargets = unknownTargets(options.reclusterData).length;
  return {
    schema: 'voice_identity_name_resolver_target_scope.v1',
    recluster_sha256: options.reclusterSha256 || (fs.existsSync(reclusterPath)
      ? crypto.createHash('sha256').update(fs.readFileSync(reclusterPath)).digest('hex')
      : ''),
    unknown_target_ids: unknownTargetIds,
    unknown_target_ids_sha256: crypto
      .createHash('sha256')
      .update(JSON.stringify(unknownTargetIds))
      .digest('hex'),
    known_target_ids: knownTargetIds,
    scope_kind: recentDays > 0 ? 'recent' : 'lifetime',
    recent_days: recentDays > 0 ? recentDays : null,
    // Seal the SAME cutoff the selection above actually used. Re-deriving it here would let the
    // sealed frame drift away from the worked frame whenever the day key advances mid-run.
    recent_cutoff_date: recentDays > 0 ? options.recentScope?.cutoffDate || null : null,
    // When the scope was computed, so a reader can verify the sealed cutoff is consistent with
    // it rather than trusting a self-reported date outright.
    scope_computed_at: recentDays > 0 ? new Date().toISOString() : null,
    lifetime_unknown_target_count: lifetimeUnknownTargets,
    lifetime_deferred_target_count: Math.max(0, lifetimeUnknownTargets - unknownTargetIds.length),
  };
}

function buildPreflightFailureState({ status, tasks, targetScope, failurePatterns }) {
  return {
    ...status,
    total_targets: tasks.length,
    selected_targets: 0,
    completed_targets: 0,
    failed_targets: 0,
    deferred_targets: tasks.length,
    pattern_guarded_targets: 0,
    target_scope: targetScope,
    failure_patterns: failurePatterns,
  };
}

function runOne(
  task,
  index,
  total,
  { progressRunId = '', taskFingerprint = effectiveTaskFingerprint(task) } = {},
) {
  return new Promise((resolve) => {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const outFile = path.join(
      LOG_DIR,
      `${String(index + 1).padStart(3, '0')}-${task.kind}-${slug(task.target)}.out.log`,
    );
    const errFile = path.join(
      LOG_DIR,
      `${String(index + 1).padStart(3, '0')}-${task.kind}-${slug(task.target)}.err.log`,
    );
    const out = fs.createWriteStream(outFile, { flags: 'w' });
    const err = fs.createWriteStream(errFile, { flags: 'w' });
    const progressFile = childProgressFile(task, index, progressRunId);
    fs.mkdirSync(path.dirname(progressFile), { recursive: true });
    try {
      fs.unlinkSync(progressFile);
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error;
    }
    const started = new Date().toISOString();
    let stderrText = '';
    let stdoutText = '';
    const judgeArgs = childArgs(task, {
      progressFile,
      progressRunId,
      progressTaskFingerprint: taskFingerprint,
    });
    const child = spawn(process.execPath, judgeArgs, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SKIP_EC2_PUBLISH: '1',
      },
    });
    child.stdout.pipe(out);
    child.stderr.pipe(err);
    child.stdout.on('data', (chunk) => {
      stdoutText = `${stdoutText}${chunk}`.slice(-16000);
    });
    child.stderr.on('data', (chunk) => {
      stderrText = `${stderrText}${chunk}`.slice(-16000);
    });
    child.on('close', (code) => {
      out.end();
      err.end();
      const progressRaw = readJson(progressFile, null);
      const progress = validateTaskProgress(progressRaw, {
        progressRunId,
        taskFingerprint,
        targetCount: Array.isArray(task.targets) ? task.targets.length : 1,
      });
      resolve({
        ...task,
        target_count: Array.isArray(task.targets) ? task.targets.length : 1,
        index,
        total,
        started_at: started,
        finished_at: new Date().toISOString(),
        exit_code: code,
        ok: code === 0,
        normalized_error:
          code === 0 ? '' : normalizeFailureError(stderrText || stdoutText || `exit code ${code}`),
        stdout_log: path.relative(ROOT, outFile).replace(/\\/g, '/'),
        stderr_log: path.relative(ROOT, errFile).replace(/\\/g, '/'),
        progress_file: path.relative(ROOT, progressFile).replace(/\\/g, '/'),
        progress_run_id: progressRunId || null,
        progress_task_fingerprint: taskFingerprint || null,
        progress_state: progress ? 'current' : progressRaw ? 'mismatched' : 'missing',
        progress,
      });
    });
  });
}

async function runRefreshSteps(state) {
  const steps = [
    ['speaker_pareto', ['scripts/otter-speaker-pareto-report.js']],
    ['voice_queue', ['scripts/voice-confirmation-queue-build.js', '--write']],
    [
      'speaker_people_sync',
      ['scripts/sync-otter-speaker-intelligence-to-people-files.js', '--write'],
    ],
    [
      'voiceprint_people_sync',
      ['scripts/sync-voiceprints-to-people-files.js', '--write', '--all-contacts', '--json'],
    ],
    ['briefing_refresh', ['scripts/refresh-briefing-generated-sections.js', '--skip-gate']],
  ];
  const results = [];
  for (const [label, args] of steps) {
    writeStatus({ ...state, phase: `refresh_${label}`, refresh_results: results });
    const result = await new Promise((resolve) => {
      const outFile = path.join(LOG_DIR, `refresh-${label}.out.log`);
      const errFile = path.join(LOG_DIR, `refresh-${label}.err.log`);
      const out = fs.createWriteStream(outFile, { flags: 'w' });
      const err = fs.createWriteStream(errFile, { flags: 'w' });
      const child = spawn(process.execPath, args, {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SKIP_EC2_PUBLISH: hasArg('--no-publish') ? '1' : process.env.SKIP_EC2_PUBLISH || '0',
        },
      });
      child.stdout.pipe(out);
      child.stderr.pipe(err);
      child.on('close', (code) => {
        out.end();
        err.end();
        resolve({
          label,
          ok: code === 0,
          exit_code: code,
          stdout_log: path.relative(ROOT, outFile).replace(/\\/g, '/'),
          stderr_log: path.relative(ROOT, errFile).replace(/\\/g, '/'),
        });
      });
    });
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}

function runCalibrationGate(state) {
  writeStatus({ ...state, phase: 'calibration_gate' });
  // A fully resumable run can have zero selected workers because every target
  // already has accepted progress. In that path runOne() never creates LOG_DIR,
  // but the mandatory calibration gate still writes its own logs.
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const outFile = path.join(LOG_DIR, 'calibration-gate.out.log');
  const errFile = path.join(LOG_DIR, 'calibration-gate.err.log');
  const out = fs.openSync(outFile, 'w');
  const err = fs.openSync(errFile, 'w');
  const child = spawn(
    process.execPath,
    ['scripts/voice-name-calibration-gate.js', '--write-quarantine'],
    {
      cwd: ROOT,
      stdio: ['ignore', out, err],
      env: {
        ...process.env,
        SECONDBRAIN_DATA_DIR: process.env.SECONDBRAIN_DATA_DIR || DATA_ROOT,
        VOICE_NAME_RESOLVER_STATUS_PATH: currentStatusContext().path,
      },
    },
  );
  return new Promise((resolve) => {
    child.on('close', (code) => {
      fs.closeSync(out);
      fs.closeSync(err);
      const gate = readJson(path.join(VP_DIR, 'voice-name-calibration-gate-latest.json'), {});
      resolve({
        ok: code === 0 && !Number(gate.blocker_count || 0),
        exit_code: code,
        blocker_count: Number(gate.blocker_count || 0),
        warning_count: Number(gate.warning_count || 0),
        automatic_identity_acceptance: gate.automatic_identity_acceptance || 'unknown',
        quarantined_enrollment_ids: gate.quarantined_enrollment_ids || [],
        stdout_log: path.relative(ROOT, outFile).replace(/\\/g, '/'),
        stderr_log: path.relative(ROOT, errFile).replace(/\\/g, '/'),
      });
    });
  });
}

async function main() {
  // Resolve and validate receipt authority once. Every read, progress write,
  // terminal write, and stdout receipt in this process uses this exact path.
  activeStatusContext = resolverStatusContext();
  if (activeStatusContext.authority === 'canonical-health') {
    const lock = acquireCanonicalRunLock();
    if (!lock.acquired) {
      const existingStatus = readJson(activeStatusContext.path, {});
      process.stdout.write(
        `${JSON.stringify(
          {
            ...existingStatus,
            skipped_concurrent_canonical_run: true,
            concurrent_holder_pid: lock.holderPid,
            concurrent_holder_started_at: lock.startedAt,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    process.on('exit', () => releaseCanonicalRunLock());
  }
  const previous = loadExistingStatus();
  const recentDays = Number(arg('--recent-days', '0')) || 0;
  let failurePatterns = loadFailurePatterns();
  activeFailurePatternSnapshot = JSON.parse(JSON.stringify(failurePatterns));
  const scopeInputFailure = canonicalScopeInputFailure({
    statusContext: activeStatusContext,
    recentDays,
  });
  if (scopeInputFailure) {
    writeStatus(
      {
        ...previous,
        phase: 'aborted_missing_scope_input',
        error: scopeInputFailure,
      },
      { persistFailurePatterns: false },
    );
    process.stdout.write(
      `${JSON.stringify(readJson(activeStatusContext.path, {}), null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  // One computation, shared by selection and sealing, so the sealed frame is the worked frame.
  // Keep selection and sealing on one immutable source snapshot. A recluster publisher may
  // replace the live file while the resolver is working; re-reading it here could make the
  // resolver work one target set and seal another (2026-09-28 producer-evidence defect).
  const reclusterRaw = fs.existsSync(RECLUSTER_PATH) ? fs.readFileSync(RECLUSTER_PATH) : '';
  const reclusterSnapshot = reclusterRaw
    ? JSON.parse(reclusterRaw)
    : { clusters: [] };
  const reclusterSnapshotSha256 = crypto.createHash('sha256').update(reclusterRaw).digest('hex');
  const recentScope = computeRecentScope(recentDays, reclusterSnapshot);
  const all = taskList(recentScope, reclusterSnapshot);
  const targetScope = buildTargetScope(all, RECLUSTER_PATH, {
    recentDays,
    recentScope,
    reclusterData: reclusterSnapshot,
    reclusterSha256: reclusterSnapshotSha256,
  });
  if (all.length === 0) {
    writeStatus({
      phase: hasArg('--no-refresh') ? 'completed_no_refresh_requested' : 'completed',
      total_targets: 0,
      pending_targets: 0,
      selected_targets: 0,
      deferred_targets: 0,
      pattern_guarded_targets: 0,
      precompleted_targets: 0,
      completed_targets: 0,
      failed_targets: 0,
      target_scope: targetScope,
      results: [],
    });
    process.stdout.write(
      `${JSON.stringify(readJson(activeStatusContext.path, {}), null, 2)}\n`,
    );
    return;
  }
  // Abort the whole fan-out when no LLM rung is reachable; every judge
  // child would fail anyway. Snapshot the exact current input scope first so
  // the failure receipt remains attributable to the recluster it attempted.
  const preflight = await runLadderPreflight();
  if (!preflight.ok) {
    writeStatus(
      buildPreflightFailureState({
        status: preflight.status,
        tasks: all,
        targetScope,
        failurePatterns,
      }),
    );
    console.error(
      '[name-resolver] Claude and Codex subscription preflight failed; aborting fan-out without a paid API',
    );
    process.exit(1);
  }
  const resumedResults = hasArg('--resume') ? resumableResults(previous.results, all) : [];
  const completedKeys = new Set(resumedResults.map((row) => `${row.kind}:${row.target}`));
  if (hasArg('--resume') || hasArg('--resume-existing')) {
    const exactCallTerminal = !hasArg('--resume-current-fingerprint-only');
    for (const key of existingJudgeTargetKeys(all, { exactCallTerminal })) completedKeys.add(key);
  }
  const limit = Number(arg('--limit', '0')) || 0;
  const selection = selectPendingTasks(all, completedKeys, 0);
  const allPendingTasks = selection.pending;
  const rawTasks = limit > 0 ? allPendingTasks.slice(0, limit) : allPendingTasks;
  const precompletedTargets = all.length - allPendingTasks.length;
  const deferredTargets = allPendingTasks.length - rawTasks.length;
  const groupSize = Math.max(1, Number(arg('--group-size', '1')) || 1);
  const candidateTaskGroups = [];
  for (let i = 0; i < rawTasks.length;) {
    const task = rawTasks[i];
    if (groupSize > 1 && task.kind === 'unknown') {
      const group = rawTasks.slice(i, i + groupSize).filter((row) => row.kind === 'unknown');
      candidateTaskGroups.push({
        kind: 'unknown',
        target: group.map((row) => row.target).join(','),
        display_name: `${group.length} unknown acoustic identities`,
        calls: group.reduce((sum, row) => sum + Number(row.calls || 0), 0),
        words: group.reduce((sum, row) => sum + Number(row.words || 0), 0),
        segments: group.reduce((sum, row) => sum + Number(row.segments || 0), 0),
        priority: group[0]?.priority || 0,
        targets: group,
      });
      i += group.length;
      continue;
    }
    candidateTaskGroups.push(task);
    i += 1;
  }
  const patternGuardedTasks = candidateTaskGroups.filter((task) =>
    shouldPatternGuardTask(task, failurePatterns),
  );
  const tasks = candidateTaskGroups.filter(
    (task) => !shouldPatternGuardTask(task, failurePatterns),
  );
  const concurrency = Math.max(1, Number(arg('--concurrency', '2')) || 2);
  const results = resumedResults.slice();
  const progressRunId = `${new Date()
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 17)}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const taskProgressFiles = tasks.map((task, index) => {
    const taskFingerprint = effectiveTaskFingerprint(task);
    return {
      index,
      target_count: Array.isArray(task.targets) ? task.targets.length : 1,
      run_id: progressRunId,
      task_fingerprint: taskFingerprint,
      file: path.relative(ROOT, childProgressFile(task, index, progressRunId)).replace(/\\/g, '/'),
    };
  });
  const stateBase = {
    phase: 'running_name_judges',
    started_at: previous.started_at || new Date().toISOString(),
    total_targets: all.length,
    pending_targets: allPendingTasks.length,
    selected_targets: tasks.reduce(
      (sum, task) => sum + (Array.isArray(task.targets) ? task.targets.length : 1),
      0,
    ),
    deferred_targets: deferredTargets,
    pending_task_groups: tasks.length,
    pattern_guarded_targets: patternGuardedTasks.reduce(
      (sum, task) => sum + (Array.isArray(task.targets) ? task.targets.length : 1),
      0,
    ),
    pattern_guarded_target_ids: patternGuardedTasks.map((task) => `${task.kind}:${task.target}`),
    precompleted_targets: precompletedTargets,
    completed_targets: precompletedTargets + completedTargetCount(results),
    concurrency,
    progress_run_id: progressRunId,
    task_progress_files: taskProgressFiles,
    target_scope: targetScope,
    policy: {
      grouping:
        'acoustic target identity only; every complete call is sent with every target turn marked',
      naming:
        'only the whole-call marked-target LLM judge may publish a heard-name hypothesis; transcript heuristics may only nominate calls for review',
    },
  };
  writeStatus(resolverProgressState(stateBase, failurePatterns, { results }));
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (!terminalFailure && cursor < tasks.length) {
      const taskIndex = cursor;
      const task = tasks[cursor++];
      writeStatus(
        resolverProgressState(stateBase, failurePatterns, {
          phase: 'running_name_judges',
          active_target: task,
          completed_targets: precompletedTargets + completedTargetCount(results),
          results,
        }),
      );
      const result = await runOne(task, taskIndex, tasks.length, {
        progressRunId,
        taskFingerprint: taskProgressFiles[taskIndex].task_fingerprint,
      });
      results.push(result);
      failurePatterns = updateFailurePatterns(failurePatterns, task, result);
      writeStatus(
        resolverProgressState(stateBase, failurePatterns, {
          phase: 'running_name_judges',
          completed_targets: precompletedTargets + completedTargetCount(results),
          last_result: result,
          results,
        }),
      );
    }
  });
  await Promise.all(workers);
  const finalState = {
    ...stateBase,
    phase: 'name_judges_completed',
    completed_targets: precompletedTargets + completedTargetCount(results),
    failed_targets: failedTargetCount(results),
    failed_task_groups: results.filter((row) => !row.ok).length,
    failure_patterns: failurePatterns,
    results,
  };
  writeStatus(finalState);
  const calibrationGate =
    shouldRunCalibrationGate(activeStatusContext)
      ? await runCalibrationGate(finalState)
      : {
          ok: null,
          skipped: true,
          reason: 'scoped resolver work cannot publish shared calibration authority',
        };
  const noRefreshRequested = hasArg('--no-refresh');
  const refreshResults = noRefreshRequested ? [] : await runRefreshSteps(finalState);
  writeTerminalStatus(
    {
      ...finalState,
      calibration_gate: calibrationGate,
    },
    { noRefreshRequested, refreshResults },
  );
  process.stdout.write(
    `${JSON.stringify(readJson(activeStatusContext.path, {}), null, 2)}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    // Authority errors cannot overwrite canonical health, but still receive a
    // scoped receipt. Mid-run failures preserve the last sealed denominator.
    const statusContext = activeStatusContext || authorityErrorStatusContext();
    setTerminalFailure(true);
    try {
      const last = readJson(statusContext.path, {});
      writeStatus(
        {
          ...last,
          phase: activeStatusContext ? 'failed' : 'aborted_invalid_status_authority',
          error: error && error.stack ? error.stack : String(error),
        },
        {
          statusContext,
          persistFailurePatterns: false,
          force: true,
        },
      );
    } catch (statusError) {
      console.error(
        `[name-resolver] failed to write failure receipt: ${statusError?.stack || statusError}`,
      );
    }
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = {
  runLadderPreflight,
  _test: {
    resolverStatusContext,
    resolverStatusPath,
    authorityErrorStatusContext,
    canonicalScopeInputFailure,
    changedFailurePatternKeys,
    shouldRunCalibrationGate,
    setTerminalFailure,
    loadFailurePatterns,
    updateSharedFailurePatterns,
    resolverProgressState,
    writeStatus,
    buildTargetScope,
    computeRecentScope,
    buildPreflightFailureState,
    unknownTargets,
    existingJudgeTargetKeys,
    outdatedJevArtifact,
    taskList,
    uniqueTargetTasks,
    selectPendingTasks,
    completionPhase,
    terminalInputStatus,
    writeTerminalStatus,
    effectiveTaskFingerprint,
    failedTargetCount,
    completedTargetCount,
    normalizeFailureError,
    childArgs,
    childProgressFile,
    validateTaskProgress,
    shouldPatternGuardTask,
    updateFailurePatterns,
    resumableResults,
    isPidAlive,
    acquireCanonicalRunLock,
    releaseCanonicalRunLock,
  },
};
