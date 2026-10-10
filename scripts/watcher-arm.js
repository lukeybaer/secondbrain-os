#!/usr/bin/env node
'use strict';

// Deterministic acquisition for the temporary attended briefing watcher.
// Saying "you are the watcher" is only intent. ARMED exists only after the
// Codex heartbeat automation is present, active, exact, and bound to this task.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  WATCHER_AUTOMATION_ID,
  WATCHER_AUTOMATION_NAME,
  WATCHER_CHECKPOINTS_CT,
  WATCHER_EXPIRE_COMMAND,
  WATCHER_RESCUE_COMMAND,
  WATCHER_SCHEDULER_JITTER_MAX_MS,
  watcherInterventionState,
  currentBriefingDate,
  watcherCheckpointInstants,
  watcherSchedulerRrule,
  watcherAutomationPrompt,
  parseAutomationToml,
  verifyAutomationConfig,
} = require('./lib/briefing-watcher-control.js');
const { ctWallTimeToEpochMs } = require('./lib/briefing-run-window.js');

const DEFAULT_EC2_TARGET = 'ec2-user@ExampleCo';
// A fallback may cover at most half of the watcher's 20-minute proof window.
const TERMINAL_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_EXPIRATION_BLOCK_ATTEMPTS = 3;
const EXPIRATION_FAIL_SAFE_HOUR_CT = 6;

function watcherRoot(env = process.env) {
  return path.join(
    env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'secondbrain',
    'data',
    'agent',
    'watcher-acquisition',
  );
}

function automationFile(env = process.env) {
  const codexRoot = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexRoot, 'automations', WATCHER_AUTOMATION_ID, 'automation.toml');
}

function schedulerStateDbFile(env = process.env) {
  const codexRoot = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexRoot, 'sqlite', 'codex-dev.db');
}

function scheduledFireLedgerFile(date, env = process.env) {
  return path.join(watcherRoot(env), `${date}-scheduled-fires.jsonl`);
}

function receiptFile(date, env = process.env) {
  return path.join(watcherRoot(env), `${date}.json`);
}

function cloudCheckpointReceiptFile(date, env = process.env) {
  return path.join(watcherRoot(env), `${date}-latest-cloud-checkpoint.json`);
}

function cloudActionAttemptFile(date, env = process.env) {
  return path.join(watcherRoot(env), `${date}-latest-cloud-action-attempt.json`);
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function recordCloudCheckpoint({ date, env = process.env, nowMs = Date.now(), remoteReceipt } = {}) {
  const day = String(date || currentBriefingDate(nowMs)).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !remoteReceipt || typeof remoteReceipt !== 'object') {
    throw new Error('watcher cloud receipt recording requires a date and parsed remote receipt');
  }
  const file = cloudCheckpointReceiptFile(day, env);
  const intervention = watcherInterventionState(remoteReceipt);
  const surfacedRow = intervention.pendingRow || intervention.terminalRow || null;
  writeJsonAtomic(file, {
    schema: 'briefing-watcher-cloud-checkpoint-cache@1',
    date: day,
    recordedAt: new Date(nowMs).toISOString(),
    interventionKey: String(surfacedRow?.canonicalKey || surfacedRow?.key || ''),
    interventionStartedAt: surfacedRow?.startedAt || surfacedRow?.ts || null,
    remoteReceipt,
  });
  return file;
}

function recordCloudActionAttempt({
  date,
  env = process.env,
  nowMs = Date.now(),
  action = 'RESCUE_IF_NEEDED',
} = {}) {
  const day = String(date || currentBriefingDate(nowMs)).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error('watcher cloud action attempt requires a briefing date');
  }
  const file = cloudActionAttemptFile(day, env);
  writeJsonAtomic(file, {
    schema: 'briefing-watcher-cloud-action-attempt@1',
    date: day,
    action,
    startedAt: new Date(nowMs).toISOString(),
  });
  return file;
}

function readPersistedAutomationSchedule({ env = process.env } = {}) {
  const databaseFile = schedulerStateDbFile(env);
  if (!fs.existsSync(databaseFile)) {
    throw new Error('watcher acquisition failed: Codex scheduler SQLite state is missing');
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error('watcher acquisition failed: read-only SQLite support is unavailable');
  }
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT id, next_run_at FROM automations WHERE id = ?')
      .get(WATCHER_AUTOMATION_ID);
    if (!row || !Number.isFinite(Number(row.next_run_at))) {
      throw new Error('watcher acquisition failed: persisted scheduler next_run_at is unavailable');
    }
    return {
      databaseFile,
      nextRunAtMs: Number(row.next_run_at),
    };
  } finally {
    database.close();
  }
}

function schedulerNextRunProof({ date, nowMs = Date.now(), schedulerStateFn = readPersistedAutomationSchedule, env = process.env } = {}) {
  const expected = watcherCheckpointInstants(date).find(
    ({ epochMs }) => epochMs + WATCHER_SCHEDULER_JITTER_MAX_MS >= nowMs,
  );
  if (!expected) {
    throw new Error('watcher acquisition failed: no briefing checkpoint remains tonight');
  }
  const persisted = schedulerStateFn({ env });
  const nextRunAtMs = Number(persisted?.nextRunAtMs);
  const driftMs = nextRunAtMs - expected.epochMs;
  const ok =
    Number.isFinite(nextRunAtMs) &&
    driftMs >= 0 &&
    driftMs <= WATCHER_SCHEDULER_JITTER_MAX_MS;
  if (!ok) {
    throw new Error(
      `watcher acquisition failed: scheduler-next-run-mismatch ` +
        `(expected ${expected.expectedAt} through ${new Date(expected.epochMs + WATCHER_SCHEDULER_JITTER_MAX_MS).toISOString()}, ` +
        `persisted ${Number.isFinite(nextRunAtMs) ? new Date(nextRunAtMs).toISOString() : 'missing'})`,
    );
  }
  return {
    ok: true,
    databaseFile: persisted.databaseFile || null,
    checkpointCt: expected.checkpointCt,
    expectedNextRunAt: expected.expectedAt,
    persistedNextRunAt: new Date(nextRunAtMs).toISOString(),
    driftMs,
    acceptedJitterMs: WATCHER_SCHEDULER_JITTER_MAX_MS,
  };
}

function recordScheduledFire({ date, env = process.env, nowMs = Date.now(), remoteReceipt } = {}) {
  const day = String(date || currentBriefingDate(nowMs)).slice(0, 10);
  const file = receiptFile(day, env);
  const prior = readJson(file);
  const taskId = env.CODEX_THREAD_ID;
  if (
    !['ARMED_PENDING_FIRE', 'ARMED'].includes(prior.status) ||
    !validThreadId(taskId) ||
    taskId !== prior.taskId
  ) {
    throw new Error('watcher fired canary failed: task is not the armed watcher');
  }
  if (!remoteReceipt || remoteReceipt.ok !== true) {
    throw new Error('watcher fired canary failed: cloud checkpoint did not succeed');
  }
  const checkpoint = watcherCheckpointInstants(day).find(
    ({ epochMs }) => nowMs >= epochMs && nowMs <= epochMs + WATCHER_SCHEDULER_JITTER_MAX_MS,
  );
  if (!checkpoint) {
    throw new Error('watcher fired canary failed: invocation was outside an intended checkpoint window');
  }
  const firedAt = new Date(nowMs).toISOString();
  const receipt = {
    schema: 'briefing-watcher-scheduled-fire@1',
    date: day,
    taskId,
    automationId: WATCHER_AUTOMATION_ID,
    checkpointCt: checkpoint.checkpointCt,
    expectedAt: checkpoint.expectedAt,
    firedAt,
    driftMs: nowMs - checkpoint.epochMs,
    remote: {
      ok: true,
      state: remoteReceipt.classification?.state || null,
      action: remoteReceipt.action || null,
    },
  };
  const ledgerFile = scheduledFireLedgerFile(day, env);
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.appendFileSync(ledgerFile, `${JSON.stringify(receipt)}\n`, 'utf8');
  const updated = {
    ...prior,
    status: 'ARMED',
    realFireCanary: {
      status: 'PROVEN',
      checkpointCt: checkpoint.checkpointCt,
      expectedAt: checkpoint.expectedAt,
      firedAt,
      driftMs: receipt.driftMs,
      receiptFile: ledgerFile,
    },
  };
  writeJsonAtomic(file, updated);
  return receipt;
}

function validThreadId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function sshKey(env = process.env) {
  return [
    env.SB_EC2_SSH_KEY,
    env.EC2_SSH_KEY,
    path.join(os.homedir(), '.ssh', 'sb-key.pem'),
    path.join(os.homedir(), '.ssh', 'secondbrain-backend-key.pem'),
  ]
    .filter(Boolean)
    .find((file) => fs.existsSync(file));
}

function cloudPreflight({ date, env = process.env, spawnSyncImpl = spawnSync } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error('watcher acquisition requires YYYY-MM-DD briefing date');
  }
  const key = sshKey(env);
  if (!key) throw new Error('watcher acquisition failed: EC2 SSH key is missing');
  const target = env.SB_EC2_TARGET || DEFAULT_EC2_TARGET;
  if (!/^[a-z0-9._-]+@[a-z0-9.-]+$/i.test(target)) {
    throw new Error('watcher acquisition failed: EC2 target is invalid');
  }
  const remoteCommand =
    `cd /opt/secondbrain && ` +
    `/usr/bin/node scripts/watcher-checkpoint.js --cloud --observe-only --date ${date}`;
  const result = spawnSyncImpl(
    'ssh',
    [
      '-i',
      key,
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      target,
      remoteCommand,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
  );
  if (!result || result.status !== 0) {
    throw new Error(
      `watcher acquisition failed: EC2 checkpoint unavailable (${String(result?.stderr || result?.stdout || 'unknown error').trim().slice(-500)})`,
    );
  }
  let checkpoint;
  try {
    checkpoint = JSON.parse(String(result.stdout || '').trim());
  } catch {
    throw new Error('watcher acquisition failed: EC2 checkpoint did not return JSON');
  }
  if (!checkpoint || checkpoint.ok !== true || checkpoint.mode !== 'observe') {
    throw new Error('watcher acquisition failed: EC2 checkpoint preflight was not healthy');
  }
  return checkpoint;
}

function intendedAutomation(threadId, { mode = 'create', date = currentBriefingDate() } = {}) {
  return {
    mode,
    id: WATCHER_AUTOMATION_ID,
    kind: 'heartbeat',
    name: WATCHER_AUTOMATION_NAME,
    prompt: watcherAutomationPrompt(date),
    rrule: watcherSchedulerRrule(date),
    status: 'ACTIVE',
    notificationPolicy: 'failed_runs_only',
    targetThreadId: threadId,
  };
}

function prepare({ date, threadId, env = process.env, cloudPreflightFn = cloudPreflight } = {}) {
  const day = date || currentBriefingDate();
  const task = threadId || env.CODEX_THREAD_ID;
  if (!validThreadId(task)) throw new Error('watcher acquisition failed: current Codex task UUID is missing');
  const preflight = cloudPreflightFn({ date: day, env });
  const automationTransition = fs.existsSync(automationFile(env))
    ? 'delete-then-create'
    : 'create';
  const receipt = {
    schema: 'briefing-watcher-acquisition@1',
    status: 'PREPARED',
    date: day,
    taskId: task,
    preparedAt: new Date().toISOString(),
    checkpointsCt: WATCHER_CHECKPOINTS_CT,
    automationTransition,
    automation: intendedAutomation(task, { mode: 'create', date: day }),
    cloudPreflight: {
      ok: preflight.ok,
      release: preflight.release || null,
      classification: preflight.classification || null,
    },
  };
  writeJsonAtomic(receiptFile(day, env), receipt);
  return { ...receipt, receiptFile: receiptFile(day, env) };
}

function confirm({
  date,
  threadId,
  env = process.env,
  expectPaused = false,
  cloudPreflightFn = cloudPreflight,
  schedulerStateFn = readPersistedAutomationSchedule,
  nowMs = Date.now(),
} = {}) {
  const day = date || currentBriefingDate();
  const file = receiptFile(day, env);
  const prior = readJson(file);
  const task = env.CODEX_THREAD_ID;
  if (!validThreadId(task) || (threadId && threadId !== task) || task !== prior.taskId) {
    throw new Error('watcher acquisition failed: confirmation task does not match prepared task');
  }
  if (expectPaused && prior.status !== 'PAUSE_PENDING') {
    throw new Error('watcher expiration failed: pause was not requested');
  }
  const source = fs.readFileSync(automationFile(env), 'utf8');
  const verification = verifyAutomationConfig(parseAutomationToml(source), {
    threadId: task,
    date: day,
    expectPaused,
  });
  if (!verification.ok) {
    throw new Error(`watcher acquisition failed: ${verification.failures.join(', ')}`);
  }
  const preflight = expectPaused ? prior.cloudPreflight : cloudPreflightFn({ date: day, env });
  const schedulerProof = expectPaused
    ? prior.schedulerProof || null
    : schedulerNextRunProof({ date: day, nowMs, schedulerStateFn, env });
  const canaryProven = prior.realFireCanary?.status === 'PROVEN';
  const expirationProofDefective =
    Array.isArray(prior.expirationDefects) && prior.expirationDefects.length > 0;
  const status = expectPaused
    ? canaryProven && !expirationProofDefective
      ? 'EXPIRED'
      : 'EXPIRED_UNPROVEN'
    : canaryProven
      ? 'ARMED'
      : 'ARMED_PENDING_FIRE';
  const receipt = {
    ...prior,
    status,
    confirmedAt: new Date().toISOString(),
    verification,
    schedulerProof,
    realFireCanary: prior.realFireCanary || {
      status: 'PENDING',
      requiredBy: watcherCheckpointInstants(day)[0]?.expectedAt || null,
      receiptFile: scheduledFireLedgerFile(day, env),
    },
    cloudPreflight: preflight
      ? {
          ok: preflight.ok,
          release: preflight.release || null,
          classification: preflight.classification || null,
        }
      : null,
  };
  writeJsonAtomic(file, receipt);
  return { ...receipt, receiptFile: file };
}

function terminalCheckpointDisposition(terminalCheckpoint) {
  const state = String(terminalCheckpoint?.classification?.state || '');
  const intervention = watcherInterventionState(terminalCheckpoint);
  const deliveryComplete = terminalCheckpoint?.snapshot?.delivery?.complete === true;
  let blockedReason = '';
  if (terminalCheckpoint?.ok !== true) {
    blockedReason = 'cloud-terminal-checkpoint-unhealthy';
  } else if (intervention.pending) {
    blockedReason = 'intervention-still-started-awaiting-proof';
  } else if (deliveryComplete) {
    blockedReason = '';
  } else if (!state) {
    blockedReason = 'cloud-terminal-classification-missing';
  } else if (state === 'COMPLETE' && !deliveryComplete) {
    blockedReason = 'complete-classification-without-delivery-proof';
  } else if (
    ['STALLED', 'DEADLINE_AT_RISK', 'MISSED'].includes(state) &&
    !intervention.terminal
  ) {
    blockedReason = 'unhealthy-terminal-checkpoint-without-exact-intervention-outcome';
  } else if (!['COMPLETE', 'STALLED', 'DEADLINE_AT_RISK', 'MISSED'].includes(state)) {
    blockedReason = 'nonterminal-checkpoint-without-delivery-or-exact-intervention-outcome';
  }
  return {
    blockedReason,
    summary: {
      ok: terminalCheckpoint?.ok === true,
      checkedAt: terminalCheckpoint?.checkedAt || null,
      state: state || null,
      stage: terminalCheckpoint?.classification?.stage || null,
      reason: terminalCheckpoint?.classification?.reason || null,
      interventionResult: intervention.result || null,
      deliveryComplete,
    },
  };
}

function defaultWait(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function expire({
  date,
  env = process.env,
  cloudPreflightFn,
  spawnSyncImpl = spawnSync,
  recordCloudCheckpointFn = recordCloudCheckpoint,
  waitFn = defaultWait,
  nowFn = Date.now,
  maxAttempts = 3,
} = {}) {
  const day = date || currentBriefingDate();
  const file = receiptFile(day, env);
  const prior = readJson(file);
  const expirationDefects = new Set();
  if (prior.realFireCanary?.status !== 'PROVEN') expirationDefects.add('missing-fired-canary');
  const probe = cloudPreflightFn || ((options) =>
    cloudPreflight({ ...options, spawnSyncImpl }));
  const attempts = Math.max(1, Math.min(3, Number(maxAttempts) || 3));
  let terminalCheckpoint = null;
  let disposition = null;
  let probeError = null;
  let cacheWriteError = null;
  let cacheFallbackRejected = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const observed = probe({ date: day, env });
      terminalCheckpoint = observed;
      disposition = terminalCheckpointDisposition(observed);
      probeError = null;
      try {
        recordCloudCheckpointFn({
          date: day,
          env,
          nowMs: Number(nowFn()),
          remoteReceipt: observed,
        });
      } catch (error) {
        cacheWriteError = String(error?.message || error);
      }
      if (!disposition.blockedReason) break;
    } catch (error) {
      probeError = error;
    }
    if (attempt < attempts) waitFn(2_000);
  }
  let terminalSource = 'live-cloud-probe';
  if (!terminalCheckpoint && probeError) {
    try {
      const cached = readJson(cloudCheckpointReceiptFile(day, env));
      const cachedDisposition = terminalCheckpointDisposition(cached.remoteReceipt);
      const cachedAtMs = Date.parse(String(cached.recordedAt || ''));
      const cachedIntervention = watcherInterventionState(cached.remoteReceipt);
      const cachedInterventionRow =
        cachedIntervention.pendingRow || cachedIntervention.terminalRow || null;
      const cachedInterventionKey = String(
        cachedInterventionRow?.canonicalKey || cachedInterventionRow?.key || '',
      );
      const actionAttemptRequired = Boolean(cachedInterventionRow);
      const actionAttemptFile = cloudActionAttemptFile(day, env);
      const actionAttemptPresent = fs.existsSync(actionAttemptFile);
      let actionAttemptValid = !actionAttemptPresent && !actionAttemptRequired;
      let latestActionStartedMs = Number.NEGATIVE_INFINITY;
      if (actionAttemptPresent) {
        try {
          const latestAction = readJson(actionAttemptFile);
          latestActionStartedMs = Date.parse(String(latestAction.startedAt || ''));
          actionAttemptValid = Number.isFinite(latestActionStartedMs);
        } catch {
          actionAttemptValid = false;
        }
      }
      const fallbackNowMs = Number(nowFn());
      const terminalInterventionBound =
        !cachedInterventionRow ||
        (Boolean(cachedInterventionKey) &&
          String(cached.interventionKey || '') === cachedInterventionKey);
      const fresh =
        Number.isFinite(cachedAtMs) &&
        fallbackNowMs - cachedAtMs >= 0 &&
        fallbackNowMs - cachedAtMs <= TERMINAL_CACHE_MAX_AGE_MS;
      const notSuperseded =
        !actionAttemptPresent || (actionAttemptValid && cachedAtMs >= latestActionStartedMs);
      if (
        !cachedDisposition.blockedReason &&
        fresh &&
        actionAttemptValid &&
        notSuperseded &&
        terminalInterventionBound
      ) {
        terminalCheckpoint = cached.remoteReceipt;
        disposition = cachedDisposition;
        terminalSource = 'locally-recorded-cloud-receipt';
      } else {
        cacheFallbackRejected = actionAttemptRequired && !actionAttemptPresent
          ? 'latest-rescue-attempt-missing'
          : !actionAttemptValid
          ? 'latest-rescue-attempt-unreadable'
          : !fresh
          ? 'stale-terminal-cache'
          : !notSuperseded
            ? 'terminal-cache-predates-latest-rescue-attempt'
            : !terminalInterventionBound
              ? 'terminal-cache-missing-intervention-key'
              : cachedDisposition.blockedReason;
      }
    } catch (error) {
      cacheFallbackRejected = String(error?.message || error);
      // The durable EXPIRE_BLOCKED receipt below remains the retry owner.
    }
  }
  const blockedReason = terminalCheckpoint
    ? disposition.blockedReason
    : 'cloud-terminal-checkpoint-failed';
  const terminalSummary = terminalCheckpoint
    ? {
        ...disposition.summary,
        source: terminalSource,
        cacheWriteError,
        lastProbeError: probeError ? String(probeError?.message || probeError) : null,
      }
    : {
        ok: false,
        checkedAt: null,
        state: null,
        stage: null,
        reason: null,
        interventionResult: null,
        deliveryComplete: false,
        source: 'live-cloud-probe',
        error: String(probeError?.message || probeError || 'cloud terminal checkpoint unavailable'),
        cacheWriteError,
        cacheFallbackRejected,
      };
  if (blockedReason) {
    expirationDefects.add(blockedReason);
    const blockedAtMs = Number(nowFn());
    const priorRetryAfterMs = Date.parse(String(prior.retryAfter || ''));
    const insidePriorRetryWindow =
      prior.status === 'EXPIRE_BLOCKED' &&
      Number.isFinite(priorRetryAfterMs) &&
      blockedAtMs < priorRetryAfterMs;
    const retryAfter = insidePriorRetryWindow
      ? new Date(priorRetryAfterMs).toISOString()
      : new Date(blockedAtMs + 60_000).toISOString();
    const rescueRetryReasons = new Set([
      'intervention-still-started-awaiting-proof',
      'unhealthy-terminal-checkpoint-without-exact-intervention-outcome',
      'complete-classification-without-delivery-proof',
    ]);
    const retryCommand = rescueRetryReasons.has(blockedReason)
      ? `${WATCHER_RESCUE_COMMAND} --date ${day} --await-outcome`
      : `${WATCHER_EXPIRE_COMMAND} --date ${day}`;
    const blockRecord = {
      at: new Date(blockedAtMs).toISOString(),
      reason: blockedReason,
      retryAfter,
      retryOwner: 'current-attended-watcher-task',
      retryCommand,
      nextProof: 'same-date delivery receipt or exact terminal intervention result',
    };
    // A retry before the durable retryAfter may still discover terminal proof,
    // but another blocked result cannot spend a second fail-safe strike.
    const expirationBlockHistory = insidePriorRetryWindow
      ? [...(prior.expirationBlockHistory || [])]
      : [...(prior.expirationBlockHistory || []), blockRecord];
    const failSafeDue =
      expirationBlockHistory.length >= MAX_EXPIRATION_BLOCK_ATTEMPTS ||
      blockedAtMs >= ctWallTimeToEpochMs(day, EXPIRATION_FAIL_SAFE_HOUR_CT, 0);
    if (failSafeDue) {
      expirationDefects.add('terminal-proof-unavailable');
      const {
        expirationBlockedAt: _expirationBlockedAt,
        retryAfter: _retryAfter,
        retryOwner: _retryOwner,
        retryCommand: _retryCommand,
        ...settledPrior
      } = prior;
      const failSafe = {
        ...settledPrior,
        status: 'PAUSE_PENDING',
        pauseRequestedAt: new Date(blockedAtMs).toISOString(),
        expirationDefects: [...expirationDefects],
        terminalCheckpoint: terminalSummary,
        expirationBlockHistory,
        failSafeClosure: {
          at: new Date(blockedAtMs).toISOString(),
          reason: 'terminal-proof-unavailable',
          blockedReason,
          blockAttempts: expirationBlockHistory.length,
          attemptCeiling: MAX_EXPIRATION_BLOCK_ATTEMPTS,
          backstopCt: `${day}T06:00:00 America/Chicago`,
          nextProof: blockRecord.nextProof,
        },
      };
      writeJsonAtomic(file, failSafe);
      return { ...failSafe, receiptFile: file };
    }
    const blocked = {
      ...prior,
      status: 'EXPIRE_BLOCKED',
      expirationBlockedAt: blockRecord.at,
      retryAfter,
      retryOwner: blockRecord.retryOwner,
      retryCommand: blockRecord.retryCommand,
      expirationDefects: [...expirationDefects],
      terminalCheckpoint: terminalSummary,
      expirationBlockHistory,
    };
    writeJsonAtomic(file, blocked);
    throw new Error(
      `watcher expiration refused: ${blockedReason}; durable receipt ${file}`,
    );
  }
  const {
    expirationBlockedAt: _expirationBlockedAt,
    retryAfter: _retryAfter,
    retryOwner: _retryOwner,
    retryCommand: _retryCommand,
    ...settledPrior
  } = prior;
  const receipt = {
    ...settledPrior,
    status: 'PAUSE_PENDING',
    pauseRequestedAt: new Date(Number(nowFn())).toISOString(),
    expirationDefects: [...expirationDefects],
    terminalCheckpoint: terminalSummary,
  };
  writeJsonAtomic(file, receipt);
  return { ...receipt, receiptFile: file };
}

function valueAfter(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : '';
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'verify';
  const options = {
    date: valueAfter(argv, '--date') || '',
    threadId: valueAfter(argv, '--thread-id') || '',
    expectPaused: argv.includes('--expect-paused'),
  };
  const result =
    command === 'prepare'
      ? prepare(options)
      : command === 'confirm' || command === 'verify'
        ? confirm(options)
        : command === 'expire'
          ? expire(options)
          : null;
  if (!result) throw new Error('use prepare, confirm, verify, or expire');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[watcher-arm] ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  watcherRoot,
  automationFile,
  schedulerStateDbFile,
  scheduledFireLedgerFile,
  receiptFile,
  cloudCheckpointReceiptFile,
  cloudActionAttemptFile,
  validThreadId,
  cloudPreflight,
  readPersistedAutomationSchedule,
  schedulerNextRunProof,
  recordScheduledFire,
  recordCloudCheckpoint,
  recordCloudActionAttempt,
  terminalCheckpointDisposition,
  MAX_EXPIRATION_BLOCK_ATTEMPTS,
  EXPIRATION_FAIL_SAFE_HOUR_CT,
  intendedAutomation,
  prepare,
  confirm,
  expire,
  main,
};
