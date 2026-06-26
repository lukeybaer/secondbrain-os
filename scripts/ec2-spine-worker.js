#!/usr/bin/env node
'use strict';

/**
 * EC2 Task Spine worker.
 *
 * Cloud-first Amy means EC2 owns always-on intake and execution. The desktop is
 * only a fallback. Each task claim ExampleCos a lease token; that lease token is
 * the fencing token. Every completion or retry write re-reads the task and
 * verifies that token before writing, so stale fallback workers cannot
 * overwrite a cloud result.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ensureCodexWorktree } = require('./lib/codex-worktree.js');

const {
  assertExecutiveText,
  containsRawOperationalLeak,
  internalFailureToExecutiveStatus,
  scrubExecutiveText,
} = require('./lib/executive-surface-policy.js');

const DATA_DIR =
  process.env.SECONDBRAIN_DATA_DIR ||
  (process.platform === 'linux'
    ? '/opt/secondbrain/data'
    : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'secondbrain', 'data'));
const TASKS_DIR = process.env.SECONDBRAIN_SPINE_TASKS_DIR || path.join(DATA_DIR, 'tasks');
const AGENT_DIR = path.join(DATA_DIR, 'agent');
const JOURNAL = process.env.SECONDBRAIN_SPINE_JOURNAL || path.join(AGENT_DIR, 'spine-journal.jsonl');
const RECEIPTS = path.join(AGENT_DIR, 'spine-worker-receipts.jsonl');
const COMMAND_QUEUE = path.join(AGENT_DIR, 'command-queue.json');
const HOLDER = process.env.SECONDBRAIN_WORKER_ID || `ec2:${os.hostname()}`;
const LEASE_TTL_MS = Number(process.env.SECONDBRAIN_SPINE_LEASE_TTL_MS || 5 * 60 * 1000);
const RETRY_DELAY_MS = Number(process.env.SECONDBRAIN_SPINE_RETRY_DELAY_MS || 5 * 60 * 1000);

function appendJsonl(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

function appendJournal(entry) {
  appendJsonl(JOURNAL, entry);
}

function appendReceipt(entry) {
  appendJsonl(RECEIPTS, entry);
}

function safeId(value) {
  return String(value || crypto.randomUUID())
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 120);
}

function taskFile(id) {
  return path.join(TASKS_DIR, `${safeId(id)}.json`);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function readTasks() {
  if (!fs.existsSync(TASKS_DIR)) return [];
  return fs
    .readdirSync(TASKS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => readJson(path.join(TASKS_DIR, file), null))
    .filter(Boolean);
}

function writeTask(task) {
  writeJsonAtomic(taskFile(task.id), task);
}

function readTask(id) {
  return readJson(taskFile(id), null);
}

function isLeaseActive(lease, nowMs = Date.now()) {
  return lease && lease.expiresAt && Date.parse(lease.expiresAt) > nowMs;
}

function taskReady(task, nowMs = Date.now()) {
  if (!task) return false;
  if (task.status === 'queued' && task.nextAttemptAt && Date.parse(task.nextAttemptAt) > nowMs) {
    return false;
  }
  if (task.status === 'queued') return true;
  return task.status === 'running' && !isLeaseActive(task.lease, nowMs);
}

function claim(task, nowMs = Date.now()) {
  if (!taskReady(task, nowMs)) return null;
  if (isLeaseActive(task.lease, nowMs)) return null;
  const token = crypto.randomUUID();
  const ts = new Date(nowMs).toISOString();
  return {
    ...task,
    status: 'running',
    startedAt: task.startedAt || ts,
    updatedAt: ts,
    lease: {
      holder: HOLDER,
      token,
      acquiredAt: ts,
      expiresAt: new Date(nowMs + LEASE_TTL_MS).toISOString(),
    },
    history: [...(task.history || []), { status: 'running', ts, note: `claimed by ${HOLDER}` }],
  };
}

function taskCreatedAtMs(task) {
  const value = Date.parse(task && (task.createdAt || task.updatedAt || task.startedAt || ''));
  return Number.isFinite(value) ? value : 0;
}

function taskPriority(task, nowMs = Date.now()) {
  const origin = String(task && task.origin ? task.origin : '').toLowerCase();
  const isUserFacing = ['telegram', 'voice', 'vapi'].includes(origin);
  const isBriefing = /\bbriefing\b/i.test(
    String((task && (task.kind || task.type || task.title || task.prompt)) || ''),
  );
  const ageMs = taskCreatedAtMs(task) ? nowMs - taskCreatedAtMs(task) : Infinity;
  const freshUserWindowMs = Number(
    process.env.SECONDBRAIN_SPINE_FRESH_USER_TASK_WINDOW_MS || 3 * 24 * 60 * 60 * 1000,
  );
  if (isUserFacing && ageMs <= freshUserWindowMs) return 0;
  if (isBriefing) return 1;
  if (isUserFacing) return 2;
  if (origin === 'otter') return 5;
  return task && task.approved === true ? 3 : 4;
}

function compareClaimableTasks(a, b, nowMs = Date.now()) {
  const priorityDelta = taskPriority(a, nowMs) - taskPriority(b, nowMs);
  if (priorityDelta !== 0) return priorityDelta;
  return taskCreatedAtMs(a) - taskCreatedAtMs(b);
}

function claimOne(nowMs = Date.now()) {
  const task = readTasks()
    .filter((row) => {
      const origin = String(row.origin || '').toLowerCase();
      if (row.requiresDesktop === true && process.env.SECONDBRAIN_ALLOW_DESKTOP_REQUIRED !== '1') {
        return false;
      }
      return (row.approved === true || ['telegram', 'voice', 'vapi'].includes(origin)) && taskReady(row, nowMs);
    })
    .sort((a, b) => compareClaimableTasks(a, b, nowMs))
    .map((row) => claim(row, nowMs))
    .find(Boolean);
  if (!task) return null;
  writeTask(task);
  appendJournal({ ts: new Date(nowMs).toISOString(), taskId: task.id, op: 'claimed', task });
  return task;
}

function verifyLease(taskId, token) {
  const current = readTask(taskId);
  if (!current || !current.lease || current.lease.token !== token) {
    throw new Error(`lease lost for ${taskId}`);
  }
  return current;
}

function isLeaseLostError(err) {
  return /\blease lost\b/i.test(String((err && err.message) || err || ''));
}

function normalizeSummary(text, fallback) {
  const clean = scrubExecutiveText(String(text || '').trim());
  const candidate =
    clean ||
    fallback ||
    'Request completed from the cloud worker. No action needed from ExampleCo.';
  const checked = assertExecutiveText(candidate, { surface: 'worker-summary' });
  if (checked.ok) return candidate;
  return fallback || 'Request completed from the cloud worker. No action needed from ExampleCo.';
}

function completeTask(claimedTask, result, nowMs = Date.now()) {
  const current = verifyLease(claimedTask.id, claimedTask.lease.token);
  const ts = new Date(nowMs).toISOString();
  const summary = normalizeSummary(
    result.summary || result.text || result.message,
    'Request completed from the cloud worker. No action needed from ExampleCo.',
  );
  const task = {
    ...current,
    status: 'done',
    updatedAt: ts,
    completedAt: ts,
    resultSummary: summary,
    resultRef: result.resultRef || current.resultRef || null,
    history: [...(current.history || []), { status: 'done', ts, note: 'completed by cloud worker' }],
  };
  writeTask(task);
  appendJournal({ ts, taskId: task.id, op: 'completed', leaseToken: claimedTask.lease.token });
  appendReceipt({
    ts,
    taskId: task.id,
    op: 'completed',
    origin: task.origin,
    summary,
    rawStoredInternally: false,
  });
  return task;
}

function removeTaskAsNonActionable(claimedTask, reason, nowMs = Date.now()) {
  const current = verifyLease(claimedTask.id, claimedTask.lease.token);
  const ts = new Date(nowMs).toISOString();
  const summary = normalizeSummary(
    reason,
    'Removed as non-actionable after inspection. No action needed from ExampleCo.',
  );
  const task = {
    ...current,
    status: 'removed_non_actionable',
    updatedAt: ts,
    completedAt: ts,
    resultSummary: summary,
    history: [
      ...(current.history || []),
      { status: 'removed_non_actionable', ts, note: summary },
    ],
  };
  writeTask(task);
  appendJournal({
    ts,
    taskId: task.id,
    op: 'removed_non_actionable',
    origin: task.origin,
    note: summary,
  });
  appendReceipt({
    ts,
    taskId: task.id,
    op: 'removed_non_actionable',
    origin: task.origin,
    summary,
    rawStoredInternally: false,
  });
  return task;
}

function retryTask(claimedTask, failure = {}, nowMs = Date.now()) {
  const current = verifyLease(claimedTask.id, claimedTask.lease.token);
  const ts = new Date(nowMs).toISOString();
  const raw = String(failure.raw || failure.error || failure.message || '').slice(0, 4000);
  const executiveStatus = normalizeSummary(
    failure.executiveStatus,
    internalFailureToExecutiveStatus(raw),
  );
  const attempts = Number(current.attempts || 0) + 1;
  const task = {
    ...current,
    status: failure.retryable === false ? 'blocked' : 'queued',
    retryable: failure.retryable !== false,
    attempts,
    updatedAt: ts,
    nextAttemptAt:
      failure.retryable === false ? null : new Date(nowMs + RETRY_DELAY_MS * attempts).toISOString(),
    lastExecutiveStatus: executiveStatus,
    lastFailureRef: `spine-worker-receipts:${current.id}:${ts}`,
    history: [
      ...(current.history || []),
      {
        status: failure.retryable === false ? 'blocked' : 'queued',
        ts,
        note: 'cloud worker will retry',
      },
    ],
  };
  writeTask(task);
  appendJournal({
    ts,
    taskId: task.id,
    op: failure.retryable === false ? 'blocked' : 'retry',
    leaseToken: claimedTask.lease.token,
  });
  appendReceipt({
    ts,
    taskId: task.id,
    op: failure.retryable === false ? 'blocked' : 'retry',
    origin: task.origin,
    executiveStatus,
    rawFailure: raw,
    rawStoredInternally: true,
  });
  return task;
}

function promptForTask(task) {
  const text =
    task.prompt ||
    task.text ||
    task.message ||
    task.transcript ||
    task.instructions ||
    task.title ||
    '';
  return String(text).trim();
}

function inspectionBodyForTask(task) {
  const prompt = promptForTask(task);
  const marker =
    'If inspection finds no actionable item, mark this task removed_non_actionable with the reason.';
  const markerIndex = prompt.indexOf(marker);
  if (markerIndex >= 0) {
    return prompt.slice(markerIndex + marker.length).trim();
  }
  return prompt;
}

function isInspectionOnlySpineRequirement(task) {
  const prompt = promptForTask(task);
  return (
    /open SecondBrain spine requirement/i.test(prompt) &&
    /Inspect it for follow-up/i.test(prompt) &&
    /removed_non_actionable/i.test(prompt)
  );
}

function hasFollowUpIntent(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return /\b(follow up|reply|respond|call|email|text|dm|schedule|remind|ask|send|draft|book|find|research|investigate|fix|build|change|update|create|add|remove|check|confirm|look into|make|do the fix)\b/i.test(
    t,
  );
}

function hasContactEnrichmentFact(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return (
    /#ppl|contact-enrichment/i.test(t) ||
    /\b(?:met|spoke with|talked to|introduced to|works at|email is|phone is|lives in|based in|wife|husband|partner|assistant|founder|ceo|vp|director)\b/i.test(
      t,
    )
  );
}

function inspectOpenSpineRequirement(task) {
  if (!isInspectionOnlySpineRequirement(task)) return null;
  const body = inspectionBodyForTask(task);
  if (!body) {
    return {
      actionable: false,
      reason:
        'Removed as non-actionable after inspection: the dispatch body was empty after the spine instructions.',
    };
  }
  const hasAmyDispatch = /#amy\b|hashtag\s+amy/i.test(body);
  if (hasFollowUpIntent(body) || hasContactEnrichmentFact(body) || hasAmyDispatch) {
    return { actionable: true, body };
  }
  const clipped = body.length > 120 ? `${body.slice(0, 117)}...` : body;
  return {
    actionable: false,
    reason: `Removed as non-actionable after inspection: the dispatch body only said "${clipped}". It contained no follow-up request, no #ppl/contact-enrichment fact, and no child #Amy dispatch intent.`,
  };
}

function runCodexAgent(prompt, task = {}) {
  const outFile = path.join(os.tmpdir(), `amy-ec2-worker-${process.pid}-${Date.now()}.txt`);
  let codexCwd;
  try {
    codexCwd = ensureCodexWorktree({
      repoRoot: process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..'),
      purpose: `spine-worker-${task.id || task.title || 'task'}`,
      branchPrefix: 'codex/spine-worker',
    }).cwd;
  } catch (err) {
    return {
      ok: false,
      retryable: true,
      raw: `Codex isolation failed: ${err.message}`,
    };
  }
  const isolatedPrompt = [
    'Branch cleanliness: you are running in an isolated Codex worktree for this task.',
    `Do not edit the shared checkout at ${process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..')}.`,
    '',
    prompt,
  ].join('\n');
  const args = [
    'exec',
    '--skip-git-repo-check',
    '-s',
    process.env.AMY_EC2_CODEX_SANDBOX || 'workspace-write',
    '--output-last-message',
    outFile,
  ];
  try {
    const res = spawnSync('codex', args, {
      cwd: codexCwd,
      input: isolatedPrompt,
      encoding: 'utf8',
      timeout: Number(process.env.AMY_EC2_CODEX_TIMEOUT_MS || 10 * 60 * 1000),
      shell: process.platform === 'win32',
      env: { ...process.env, CLAUDECODE: '' },
      maxBuffer: 10 * 1024 * 1024,
    });
    let finalText = '';
    try {
      finalText = fs.readFileSync(outFile, 'utf8').trim();
    } catch {
      finalText = String(res.stdout || '').trim();
    }
    if (res.error || res.status !== 0 || containsRawOperationalLeak(finalText)) {
      return {
        ok: false,
        retryable: true,
        raw: [res.error && res.error.message, res.stderr, finalText].filter(Boolean).join('\n'),
      };
    }
    return { ok: true, summary: finalText };
  } finally {
    try {
      fs.unlinkSync(outFile);
    } catch {
      /* already gone */
    }
  }
}

async function defaultExecuteTask(task) {
  if (/briefing/i.test(String(task.kind || task.type || task.title || task.prompt || ''))) {
    const { runCloudBriefing } = require('./cloud-morning-briefing.js');
    const date = task.date || new Date().toISOString().slice(0, 10);
    const result = await runCloudBriefing({
      dataDir: DATA_DIR,
      date,
      publish: true,
      notify: Boolean(task.notify),
      simulatePcOff: true,
    });
    if (!result.ok) return { ok: false, retryable: true, raw: result.qc.failures.join('; ') };
    return {
      ok: true,
      summary: `Morning briefing generated from the cloud for ${date}. No action needed from ExampleCo.`,
      resultRef: result.markdownPath,
    };
  }

  const taskPrompt = promptForTask(task);
  if (!taskPrompt) {
    return {
      ok: false,
      retryable: false,
      raw: 'Task had no prompt or transcript.',
      executiveStatus:
        'Amy saved the request but needs a clearer instruction. Please send a one-sentence yes/no decision or the exact task you want done.',
    };
  }

  const prompt = [
    'You are Amy running from the EC2 cloud worker. Complete this ExampleCo-initiated task as far as possible from the cloud environment.',
    'Return only a concise executive update for ExampleCo. Do not include logs, provider names, stack traces, HTTP codes, or raw tool output.',
    '',
    taskPrompt,
  ].join('\n');

  if (process.env.AMY_EC2_WORKER_DISABLE_CODEX !== '1') {
    const codexResult = runCodexAgent(prompt, task);
    if (codexResult.ok) return codexResult;
  }

  try {
    const { askAI } = require('./lib/ask-ai.js');
    const rungOrder = String(process.env.AMY_EC2_WORKER_RUNG_ORDER || 'codex,openai-api')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const answer = await askAI(prompt, {
      surface: 'ec2-spine-worker',
      rungOrder,
      silent: true,
      rungTimeoutMs: Number(process.env.AMY_EC2_ASK_TIMEOUT_MS || 120000),
    });
    if (answer && answer.text) return { ok: true, summary: answer.text };
  } catch (err) {
    return { ok: false, retryable: true, raw: err.message };
  }

  return {
    ok: false,
    retryable: true,
    raw: 'cloud executor unavailable',
    executiveStatus:
      'Amy saved the request but execution is temporarily delayed. The cloud retry loop will continue; no action needed from ExampleCo.',
  };
}

async function notifyTaskResult(task, completedTask, notify) {
  if (!['telegram', 'voice', 'vapi'].includes(String(task.origin || ''))) return null;
  const text = normalizeSummary(
    completedTask.resultSummary,
    'Request completed from the cloud worker. No action needed from ExampleCo.',
  );
  return notify({
    text,
    kind: 'reply',
    source: 'ec2-spine-worker',
    taskId: task.id,
    origin: task.origin,
  });
}

async function runOne({
  execute = defaultExecuteTask,
  notify = null,
  nowMs = Date.now(),
} = {}) {
  const task = claimOne(nowMs);
  if (!task) return { ok: true, idle: true };
  const notifier =
    notify ||
    (async (message) => {
      const { notifyWithFallback } = require('./lib/notify-with-fallback.js');
      return notifyWithFallback(message);
    });
  try {
    const inspection = inspectOpenSpineRequirement(task);
    if (inspection && inspection.actionable === false) {
      const removed = removeTaskAsNonActionable(task, inspection.reason, nowMs);
      return { ok: true, task: removed, removedNonActionable: true };
    }
    const result = await execute(task);
    if (!result || result.ok === false) {
      const retried = retryTask(task, result || { retryable: true }, nowMs);
      return {
        ok: false,
        retryable: retried.retryable,
        task: retried,
        executiveStatus: retried.lastExecutiveStatus,
      };
    }
    const completed = completeTask(task, result, nowMs);
    const notifyResult = await notifyTaskResult(task, completed, notifier);
    return { ok: true, task: completed, notifyResult };
  } catch (err) {
    if (isLeaseLostError(err)) {
      appendReceipt({
        ts: new Date().toISOString(),
        taskId: task.id,
        op: 'lease-lost',
        origin: task.origin,
        rawStoredInternally: false,
      });
      return { ok: false, lostLease: true, taskId: task.id };
    }
    try {
      const retried = retryTask(
        task,
        {
          retryable: true,
          raw: err && err.stack ? err.stack : err.message,
        },
        nowMs,
      );
      return { ok: false, retryable: true, task: retried, executiveStatus: retried.lastExecutiveStatus };
    } catch (retryErr) {
      if (isLeaseLostError(retryErr)) {
        appendReceipt({
          ts: new Date().toISOString(),
          taskId: task.id,
          op: 'lease-lost',
          origin: task.origin,
          rawStoredInternally: false,
        });
        return { ok: false, lostLease: true, taskId: task.id };
      }
      throw retryErr;
    }
  }
}

function normalizeQueue(raw) {
  if (Array.isArray(raw)) return { kind: 'array', rows: raw };
  if (raw && Array.isArray(raw.commands)) return { kind: 'commands-array', rows: raw.commands, raw };
  if (raw && raw.commands && typeof raw.commands === 'object') {
    return { kind: 'commands-object', rows: Object.values(raw.commands), raw };
  }
  if (raw && typeof raw === 'object') return { kind: 'object', rows: Object.values(raw), raw };
  return { kind: 'empty', rows: [], raw: null };
}

function commandOrigin(command) {
  const raw = String(command.source || command.origin || command.channel || command.kind || '').toLowerCase();
  if (raw.includes('vapi') || raw.includes('phone') || raw.includes('call')) return 'vapi';
  if (raw.includes('voice')) return 'voice';
  return 'telegram';
}

function commandPrompt(command) {
  return String(
    command.prompt ||
      command.text ||
      command.message ||
      command.transcript ||
      command.summary ||
      command.title ||
      '',
  ).trim();
}

function shouldAdoptCommand(command) {
  const status = String(command.status || 'pending').toLowerCase();
  if (command.adoptedTaskId) return false;
  return ['pending', 'queued', 'forwarded', 'failed', 'retry'].includes(status);
}

function writeCommandQueue(normalized, adoptedByCommandId) {
  if (!normalized.raw) return;
  if (normalized.kind === 'commands-object') {
    for (const [id, taskId] of adoptedByCommandId.entries()) {
      if (normalized.raw.commands[id]) {
        normalized.raw.commands[id] = {
          ...normalized.raw.commands[id],
          status: 'adopted',
          adoptedTaskId: taskId,
          adoptedAt: new Date().toISOString(),
        };
      }
    }
    writeJsonAtomic(COMMAND_QUEUE, normalized.raw);
  } else if (normalized.kind === 'commands-array') {
    normalized.raw.commands = normalized.raw.commands.map((row) =>
      adoptedByCommandId.has(row.id)
        ? { ...row, status: 'adopted', adoptedTaskId: adoptedByCommandId.get(row.id), adoptedAt: new Date().toISOString() }
        : row,
    );
    writeJsonAtomic(COMMAND_QUEUE, normalized.raw);
  } else if (normalized.kind === 'array') {
    const rows = normalized.rows.map((row) =>
      adoptedByCommandId.has(row.id)
        ? { ...row, status: 'adopted', adoptedTaskId: adoptedByCommandId.get(row.id), adoptedAt: new Date().toISOString() }
        : row,
    );
    writeJsonAtomic(COMMAND_QUEUE, rows);
  }
}

function adoptCommandQueueToTasks({ nowMs = Date.now() } = {}) {
  const normalized = normalizeQueue(readJson(COMMAND_QUEUE, null));
  const adopted = [];
  const adoptedByCommandId = new Map();
  const ts = new Date(nowMs).toISOString();
  for (const command of normalized.rows) {
    if (!command || !shouldAdoptCommand(command)) continue;
    const commandId = command.id || command.commandId || crypto.randomUUID();
    const id = safeId(commandId);
    if (!id) continue;
    const file = taskFile(id);
    if (fs.existsSync(file)) continue;
    const task = {
      id,
      status: 'queued',
      approved: true,
      requiresDesktop: false,
      origin: commandOrigin(command),
      prompt: commandPrompt(command),
      sourceCommandId: commandId,
      createdAt: command.createdAt || command.ts || ts,
      updatedAt: ts,
      createdBy: 'ec2-command-adopter',
      history: [{ status: 'queued', ts, note: 'adopted from EC2 command queue' }],
    };
    writeTask(task);
    appendJournal({ ts, taskId: task.id, op: 'adopted', sourceCommandId: commandId });
    appendReceipt({
      ts,
      taskId: task.id,
      op: 'adopted',
      origin: task.origin,
      rawStoredInternally: false,
    });
    adopted.push(task);
    adoptedByCommandId.set(commandId, task.id);
  }
  writeCommandQueue(normalized, adoptedByCommandId);
  return adopted;
}

async function runLoop({ once = false, intervalMs = 15000 } = {}) {
  do {
    adoptCommandQueueToTasks();
    await runOne();
    if (!once) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (!once);
}

function parseArgs(argv) {
  return {
    once: argv.includes('--once'),
    adoptOnly: argv.includes('--adopt-only'),
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.adoptOnly) {
    const adopted = adoptCommandQueueToTasks();
    console.log(`[ec2-spine-worker] adopted ${adopted.length} command(s)`);
  } else {
    runLoop({ once: args.once }).catch((err) => {
      console.error('[ec2-spine-worker] failed:', err.message);
      process.exit(1);
    });
  }
}

module.exports = {
  adoptCommandQueueToTasks,
  appendJournal,
  claim,
  claimOne,
  completeTask,
  defaultExecuteTask,
  inspectOpenSpineRequirement,
  promptForTask,
  readTasks,
  removeTaskAsNonActionable,
  retryTask,
  runOne,
  runLoop,
  safeId,
  isLeaseLostError,
  writeTask,
};
