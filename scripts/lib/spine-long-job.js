'use strict';

// Long jobs for supervised spine Tasks (owner decision, "fix it"). On Oct 25
// a STARTUP render needed about 95 minutes, but a spine attempt is killed with its
// whole process group at 45 minutes, so the render died mid-way, the worker
// backed off for six hours and a parallel session had to finish by hand.
//
// A long command now runs detached from the attempt, in its own session, under
// a small wrapper that enforces its own deadline and writes an exit receipt.
// The attempt ends after starting it; the worker parks the Task without
// spending an attempt and requeues it the moment every job has settled.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const repositoryAccess = require('./repository-access.js');
const ownerTaskPermissions = require('./owner-task-permissions.js');
const npmProvisioner = require('./trusted-npm-provisioner.js');
const { loggedStdio, copyOutputToDescriptors } = require('./windows-background-process.js');

const DEFAULT_DEADLINE_MS = 6 * 60 * 60 * 1000;
const MAX_DEADLINE_MS = 12 * 60 * 60 * 1000;
// A wrapper that outlives its own deadline by this much is treated as settled.
const OVERDUE_GRACE_MS = 10 * 60 * 1000;
// A job file with no wrapper pid this long after its start never started.
const START_GRACE_MS = 2 * 60 * 1000;
const JOB_LEASE_MS = 3 * 60 * 1000;
const CLI = path.join(__dirname, '..', 'spine-long-job.js');
const BROKER_JOB_RECIPES = Object.freeze({
  'npm:test': { command: 'npm', args: ['test'] },
  'npm:build': { command: 'npm', args: ['run', 'build'] },
  'npm:verify': { command: 'npm', args: ['run', 'verify'] },
  'npm:verify-audio': { command: 'npm', args: ['run', 'verify:audio'] },
  'npm:test-e2e': { command: 'npm', args: ['run', 'test:e2e'] },
});

function safe(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 120);
}

function jobsRoot(dataDir) {
  return path.join(dataDir, 'agent', 'spine-long-jobs');
}

function taskJobsDir(dataDir, taskId) {
  return path.join(jobsRoot(dataDir), safe(taskId));
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function clampDeadline(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DEADLINE_MS;
  return Math.min(n, MAX_DEADLINE_MS);
}

function sanitizedJobEnv(baseEnv = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (
      /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASS|API_KEY|PRIVATE_KEY|CREDENTIALS?)(?:_|$)/i.test(key) ||
      ['GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_HTTP_EXTRAHEADER', 'GH_TOKEN', 'GITHUB_TOKEN'].includes(key)
    ) {
      continue;
    }
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

function trustedJobWorkspace(args, context) {
  const requested = path.resolve(String(args.workspace || ''));
  const primary = context.primaryWorkspace ? fs.realpathSync(context.primaryWorkspace) : '';
  if (primary && path.resolve(primary) === requested) return requested;
  const registration = repositoryAccess.findRepositoryRegistrationForWorkspace(context, requested);
  const real = fs.realpathSync(requested);
  if (path.resolve(registration.record.workspace_real) !== path.resolve(real)) {
    throw new Error('long job workspace no longer matches its trusted registration');
  }
  return real;
}

function startBrokerJob(args = {}, context = {}, options = {}) {
  if (!context.dataDir || !context.detachedTaskId || !context.detachedLeaseToken) {
    throw new Error('long job requires a live detached task binding');
  }
  const recipeName = String(args.recipe || '');
  const recipe = (options.recipes || BROKER_JOB_RECIPES)[recipeName];
  if (!recipe) throw new Error('long job recipe is not registered');
  const workspace = trustedJobWorkspace(args, context);
  const registeredApp = !context.primaryWorkspace || path.resolve(context.primaryWorkspace) !== path.resolve(workspace);
  const deadlineMs = clampDeadline(Number(args.deadline_minutes || 0) * 60_000);
  const executable = process.platform === 'win32' && recipe.command === 'npm' ? 'npm.cmd' : recipe.command;
  const job = startJob({
    dataDir: context.dataDir,
    taskId: context.detachedTaskId,
    name: String(args.name || recipeName),
    command: executable,
    args: recipe.args,
    cwd: workspace,
    deadlineMs,
    env: sanitizedJobEnv(options.env || process.env),
    spawnFn: options.spawnFn || spawn,
    sandboxProfile: {
      name: ownerTaskPermissions.PROFILE_NAME,
      protectedPaths: ownerTaskPermissions.protectedCredentialPaths({
        env: options.env || process.env,
        workspace,
        repoRoot: context.repoRoot,
        sourceRoot: context.sourceRoot,
        liveRoot: context.liveRoot,
        extraPaths: [path.join(context.dataDir, 'youtube')],
        spawnSyncFn: options.spawnSyncFn,
        denyWorkspaceGitConfig:
          !context.primaryWorkspace || path.resolve(context.primaryWorkspace) === path.resolve(workspace),
      }),
    },
    ...(recipeName === 'npm:test-e2e'
      ? { browserJob: { type: 'playwright-container' } }
      : registeredApp && recipe.command === 'npm'
        ? { dependencyProvisioning: { type: 'npm-ci', lockfile: path.join(workspace, 'package-lock.json') } }
        : {}),
  });
  return {
    ok: true,
    job_id: job.id,
    name: job.name,
    recipe: recipeName,
    workspace,
    state: 'running',
    host_pid: job.wrapperPid,
    receipt_pending: true,
  };
}

function brokerJobStatus(args = {}, context = {}) {
  const id = safe(args.job_id);
  if (!id || id !== String(args.job_id || '')) throw new Error('long job identity is malformed');
  const job = listJobs(context.dataDir, context.detachedTaskId).find((row) => row.id === id);
  if (!job) throw new Error('long job is not registered to this task');
  const state = jobState(job);
  return {
    ok: true,
    job_id: job.id,
    name: job.name,
    state: state.state,
    receipt: state.receipt
      ? {
          exit_code: state.receipt.exitCode,
          signal: state.receipt.signal,
          timed_out: state.receipt.timedOut === true,
          started_at: state.receipt.startedAt,
          finished_at: state.receipt.finishedAt,
          duration_ms: state.receipt.durationMs,
          ...(state.receipt.error ? { error: String(state.receipt.error).slice(0, 500) } : {}),
          ...(state.receipt.browserJob
            ? {
                browser_job: {
                  ok: state.receipt.browserJob.ok === true,
                  playwright_version: state.receipt.browserJob.playwright_version,
                  image_digest: state.receipt.browserJob.image?.digest,
                  network: state.receipt.browserJob.isolation?.network,
                  payload_timeout_seconds: state.receipt.browserJob.payload_timeout_seconds,
                  container_id: state.receipt.browserJob.container_id,
                  job_identity: state.receipt.browserJob.job_identity,
                  deadline_watchdog: state.receipt.browserJob.deadline_watchdog,
                  cleanup: state.receipt.browserJob.cleanup,
                },
              }
            : {}),
        }
      : null,
    log_tail: scrubLogTail(logTail(job.logFile, 20)),
  };
}

/**
 * Start `command` detached for `taskId`. With no `args`, `command` runs through
 * the shell so a pipeline works; with `args`, it runs directly.
 */
function startJob({
  dataDir,
  taskId,
  name = 'job',
  command,
  args = [],
  cwd = process.cwd(),
  deadlineMs,
  nowMs = Date.now(),
  spawnFn = spawn,
  env = process.env,
  sandboxProfile = null,
  dependencyProvisioning = null,
  browserJob = null,
  repositoryReleaseBatch = null,
} = {}) {
  if (!dataDir) throw new Error('startJob needs dataDir');
  if (!taskId) throw new Error('startJob needs the spine Task id (AMY_SPINE_TASK_ID)');
  if (!command) throw new Error('startJob needs a command');
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`long job cwd is not a directory: ${cwd}`);
  const dir = taskJobsDir(dataDir, taskId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = `${safe(name) || 'job'}-${nowMs.toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const deadline = clampDeadline(deadlineMs);
  const job = {
    id,
    taskId,
    name: String(name),
    command: String(command),
    args: args.map(String),
    cwd: path.resolve(cwd),
    startedAt: new Date(nowMs).toISOString(),
    deadlineAt: new Date(nowMs + deadline).toISOString(),
    file: path.join(dir, `${id}.json`),
    logFile: path.join(dir, `${id}.log`),
    receiptFile: path.join(dir, `${id}.receipt.json`),
    lease: {
      ownerPid: null,
      expiresAt: new Date(nowMs + JOB_LEASE_MS).toISOString(),
    },
    // Its own temp dir: the attempt's temp dir is deleted when the Task parks.
    tmpDir: path.join(dir, `${id}.tmp`),
    ...(sandboxProfile ? { sandboxProfile } : {}),
    ...(dependencyProvisioning ? { dependencyProvisioning } : {}),
    ...(browserJob
      ? { browserJob: { ...browserJob, artifactDir: path.join(dir, `${id}.artifacts`) } }
      : {}),
    ...(repositoryReleaseBatch ? { repositoryReleaseBatch } : {}),
  };
  fs.mkdirSync(job.tmpDir, { recursive: true, mode: 0o700 });
  writeJsonAtomic(job.file, job);
  const out = fs.openSync(job.logFile, 'a', 0o600);
  let child;
  try {
    // detached gives the wrapper its own session, so the attempt runner's
    // process-group kill at its deadline cannot reach the job.
    child = spawnFn(process.execPath, [CLI, 'run', job.file], {
      cwd: job.cwd,
      // The broker process is scoped to one model attempt. The wrapper must
      // own a host session on every platform so attempt teardown cannot reap
      // the job before it writes its receipt.
      detached: true,
      stdio: ['ignore', out, out],
      env: {
        ...env,
        TMPDIR: job.tmpDir,
        TMP: job.tmpDir,
        TEMP: job.tmpDir,
        // Only the trusted host publisher needs subscription CLI identity.
        // Every model/build payload still uses its isolated temporary home.
        HOME: repositoryReleaseBatch ? String(env.HOME || os.homedir()) : job.tmpDir,
        USERPROFILE: repositoryReleaseBatch ? String(env.USERPROFILE || env.HOME || os.homedir()) : job.tmpDir,
        XDG_CONFIG_HOME: job.tmpDir,
        AWS_CONFIG_FILE: path.join(job.tmpDir, 'no-aws-config'),
        AWS_SHARED_CREDENTIALS_FILE: path.join(job.tmpDir, 'no-aws-credentials'),
        npm_config_cache: path.join(job.tmpDir, 'npm-cache'),
      },
      windowsHide: true,
    });
  } catch (err) {
    failedStart(job, err);
    throw err;
  } finally {
    fs.closeSync(out);
  }
  if (!child.pid) {
    failedStart(job, new Error('wrapper did not start'));
    throw new Error(`long job ${id} did not start`);
  }
  child.on?.('error', (err) => failedStart(job, err));
  child.unref?.();
  job.wrapperPid = child.pid;
  writeJsonAtomic(job.file, job);
  return job;
}

// A wrapper that never started still settles, so nothing waits on it.
function failedStart(job, err) {
  if (fs.existsSync(job.receiptFile)) return;
  writeJsonAtomic(job.receiptFile, {
    id: job.id,
    taskId: job.taskId,
    name: job.name,
    exitCode: null,
    signal: null,
    stoppedBy: null,
    timedOut: false,
    error: `failed to start: ${String(err?.message || err)}`,
    startedAt: job.startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: 0,
  });
}

// The wrapper: run the job, enforce its deadline, always leave a receipt.
function runJob(jobFile, { spawnFn = spawn, provisionFn = null } = {}) {
  const job = readJson(jobFile);
  if (!job) throw new Error(`no long job at ${jobFile}`);
  const started = Date.now();
  return new Promise((resolve) => {
    let dependencyProvisioning = null;
    let browserJob = null;
    if (job.dependencyProvisioning?.type === 'npm-ci' && provisionFn) {
      try {
        dependencyProvisioning = provisionFn(job.cwd, { env: process.env });
      } catch (error) {
        const receipt = {
          id: job.id, taskId: job.taskId, name: job.name,
          exitCode: null, signal: null, stoppedBy: null, timedOut: false,
          error: `dependency provisioning failed: ${String(error.message || error)}`,
          dependencyProvisioning: { ok: false, type: 'npm-ci' },
          startedAt: job.startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - started,
        };
        writeJsonAtomic(job.receiptFile, receipt);
        resolve(receipt);
        return;
      }
    }
    const trustedDependencyRunner = job.dependencyProvisioning?.type === 'npm-ci' && !provisionFn;
    const trustedBrowserRunner = job.browserJob?.type === 'playwright-container';
    const launch = trustedBrowserRunner
      ? { command: process.execPath, args: [require.resolve('./trusted-browser-job.js'), 'run-job', jobFile] }
      : trustedDependencyRunner
      ? { command: process.execPath, args: [require.resolve('./trusted-npm-provisioner.js'), 'run-job', jobFile] }
      : job.sandboxProfile
      ? ownerTaskPermissions.sandboxedPayload(job.command, job.args, {
          cwd: job.cwd,
          workspace: job.cwd,
          protectedPaths: job.sandboxProfile.protectedPaths,
        })
      : { command: job.command, args: job.args };
    const child = spawnFn(launch.command, launch.args, {
      cwd: job.cwd,
      env: process.env,
      shell: job.sandboxProfile ? false : job.args.length === 0,
      // Windows: pipes copied into the wrapper's log keep a hidden console the
      // whole payload tree shares; detaching would leave it none.
      detached: process.platform !== 'win32',
      stdio: loggedStdio([1, 2]),
      windowsHide: true,
    });
    if (process.platform === 'win32') copyOutputToDescriptors(child, [1, 2]);
    let timedOut = false;
    let stopSignal = null;
    const killGroup = (signal) => {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        /* already gone */
      }
    };
    const stop = (signal) => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 10_000).unref();
      stopSignal = stopSignal || signal;
    };
    const remaining = Math.max(0, Date.parse(job.deadlineAt) - Date.now());
    const renew = () => {
      const current = readJson(jobFile);
      if (!current || current.id !== job.id || current.taskId !== job.taskId) return;
      current.lease = {
        ownerPid: process.pid,
        expiresAt: new Date(Date.now() + JOB_LEASE_MS).toISOString(),
      };
      current.heartbeatAt = new Date().toISOString();
      writeJsonAtomic(jobFile, current);
    };
    renew();
    const leaseTimer = setInterval(renew, Math.floor(JOB_LEASE_MS / 3));
    leaseTimer.unref?.();
    const timer = setTimeout(() => {
      timedOut = true;
      stop('deadline');
    }, remaining);
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => stop(sig));
    let settled = false;
    const finish = (exitCode, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(leaseTimer);
      // Nothing of the job may outlive its receipt: clear its whole group.
      killGroup('SIGKILL');
      if (trustedDependencyRunner) {
        try { dependencyProvisioning = readJson(jobFile + '.dependencies.proof'); } catch { /* child failed before proof */ }
      }
      if (trustedBrowserRunner) {
        try { browserJob = readJson(jobFile + '.browser.proof'); } catch { /* child failed before proof */ }
      }
      if (job.tmpDir) fs.rmSync(job.tmpDir, { recursive: true, force: true });
      const receipt = {
        id: job.id,
        taskId: job.taskId,
        name: job.name,
        exitCode: exitCode == null ? null : exitCode,
        signal: signal || null,
        stoppedBy: stopSignal,
        timedOut,
        ...(error ? { error: String(error.message || error) } : {}),
        ...(dependencyProvisioning ? { dependencyProvisioning } : {}),
        ...(browserJob ? { browserJob } : {}),
        startedAt: job.startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      };
      writeJsonAtomic(job.receiptFile, receipt);
      resolve(receipt);
    };
    child.on('error', (err) => finish(null, null, err));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

function listJobs(dataDir, taskId) {
  const dir = taskJobsDir(dataDir, taskId);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json') && !n.endsWith('.receipt.json'))
    .map((n) => {
      const file = path.join(dir, n);
      const job = readJson(file);
      return job && { ...job, file };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

/** running | finished | lost (wrapper gone without a receipt) | overdue */
function jobState(job, { nowMs = Date.now(), alive = isAlive } = {}) {
  const receipt = readJson(job.receiptFile);
  if (receipt) return { state: 'finished', receipt };
  // A wrapper pid is recorded right after spawn; a job seen before that is live.
  if (job.wrapperPid && !alive(job.wrapperPid)) return { state: 'lost', receipt: null };
  if (!job.wrapperPid && nowMs - Date.parse(job.startedAt) > START_GRACE_MS) return { state: 'lost', receipt: null };
  if (nowMs > Date.parse(job.deadlineAt) + OVERDUE_GRACE_MS) return { state: 'overdue', receipt: null };
  return { state: 'running', receipt: null };
}

function runningJobs(dataDir, taskId, opts = {}) {
  return listJobs(dataDir, taskId).filter((job) => jobState(job, opts).state === 'running');
}

// A settled job's result is consumed once, when a resumed attempt is told it.
// Until then the worker parks (or resumes) the Task rather than releasing it.
function consumedFile(job) {
  return job.file.replace(/.json$/, '.consumed');
}

function unconsumedJobs(dataDir, taskId) {
  return listJobs(dataDir, taskId).filter((job) => !fs.existsSync(consumedFile(job)));
}

// A job may carry `seen`, the state snapshot the attempt prompt reported:
// only a result the attempt was actually told is consumed.
function snapshotJobs(jobs, opts = {}) {
  return jobs.map((job) => ({ ...job, seen: jobState(job, opts) }));
}

function markConsumed(jobs, opts = {}) {
  for (const job of jobs) {
    if ((job.seen || jobState(job, opts)).state !== 'running') {
      fs.writeFileSync(consumedFile(job), new Date().toISOString(), { mode: 0o600 });
    }
  }
}

// True while a Task the worker parked on its long jobs still has one running.
// Stall detectors use it so a parked Task is never reported as stuck.
function parkedOnRunningJob(task, opts = {}) {
  const wait = task?.execution?.longJobWait || null;
  if (!wait || !Array.isArray(wait.jobFiles)) return false;
  return wait.jobFiles.some((file) => {
    const job = readJson(file);
    return Boolean(job) && jobState(job, opts).state === 'running';
  });
}

// Stop every running job of a Task (owner cancel). The wrapper forwards the
// signal to the job's group and still writes its receipt.
function stopJobs(dataDir, taskId) {
  const stopped = [];
  for (const job of runningJobs(dataDir, taskId)) {
    try {
      process.kill(job.wrapperPid, 'SIGTERM');
      stopped.push(job.id);
    } catch {
      /* already gone */
    }
  }
  return stopped;
}

function stopJob(job) {
  if (!job || !job.wrapperPid || !isAlive(job.wrapperPid)) return false;
  try {
    process.kill(job.wrapperPid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

function logTail(file, lines = 15) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function scrubLogTail(value) {
  return String(value || '')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[credential redacted]')
    .replace(/\b(?:bearer|authorization|token|password|secret)\s*[:=]\s*\S+/gi, '$1=[credential redacted]')
    .replace(/\b[A-Za-z0-9/+_-]{40,}={0,2}\b/g, '[long value redacted]')
    .replace(/\/var\/lib\/agent\/credentials\/github\/owner-token/gi, '[protected credential path]');
}

// What the resumed attempt is told about the jobs it was waiting on.
function resumePromptBlock(dataDir, taskId, jobIds = [], opts = {}) {
  const wanted = new Set(jobIds);
  const jobs = opts.jobs || listJobs(dataDir, taskId).filter((j) => !wanted.size || wanted.has(j.id));
  if (!jobs.length) return '';
  const lines = [
    'LONG JOBS SETTLED: this attempt resumes after the long jobs below. Verify their outputs before relying on them, then continue the task from here.',
  ];
  for (const job of jobs) {
    const { state, receipt } = job.seen || jobState(job, opts);
    const result =
      state === 'finished'
        ? receipt.timedOut
          ? `stopped at its deadline after ${Math.round(receipt.durationMs / 60000)} min`
          : `exit ${receipt.exitCode}${receipt.signal ? ` (${receipt.signal})` : ''} after ${Math.round(receipt.durationMs / 60000)} min`
        : state === 'lost'
          ? 'its wrapper died without a receipt (host restart or kill); rerun it if the output is incomplete'
          : state;
    lines.push(`- ${job.name} [${job.id}]: ${result}. Command: ${[job.command, ...job.args].join(' ')} in ${job.cwd}. Log: ${job.logFile}`);
    const tail = scrubLogTail(logTail(job.logFile));
    if (tail) lines.push(tail.replace(/^/gm, '    '));
  }
  return lines.join('\n');
}

// The brief every supervised attempt gets.
function longJobBrief() {
  return [
    `Long commands: anything that can run longer than about 10 minutes (video renders, large encodes, bulk copies, long test suites) must never run in the foreground, because the attempt deadline kills the attempt's whole process group.`,
    'Start it only through the registered task_long_job_start broker capability, then end the attempt. Never invoke the host wrapper or write its ledger directly.',
    'The worker resumes this same task in this same worktree as soon as every job you started has finished, and gives you each exit code and log tail. Start independent long jobs together so they run in parallel.',
  ].join(' ');
}

module.exports = {
  BROKER_JOB_RECIPES,
  CLI,
  DEFAULT_DEADLINE_MS,
  MAX_DEADLINE_MS,
  JOB_LEASE_MS,
  OVERDUE_GRACE_MS,
  isAlive,
  brokerJobStatus,
  consumedFile,
  markConsumed,
  jobState,
  jobsRoot,
  listJobs,
  longJobBrief,
  parkedOnRunningJob,
  resumePromptBlock,
  runJob,
  runningJobs,
  snapshotJobs,
  startJob,
  startBrokerJob,
  sanitizedJobEnv,
  scrubLogTail,
  stopJobs,
  stopJob,
  taskJobsDir,
  unconsumedJobs,
};
