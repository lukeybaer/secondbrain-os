'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createSpineTask, listSpineTasks } = require('./spine-ingress');
const { searchFacts } = require('./graphiti-mcp');
const { speechSafe } = require('./speech-safe');

const ACTIVE_STATUSES = new Set([
  'queued',
  'pending',
  'running',
  'in_progress',
  'forwarded',
  'awaiting-review',
  'awaiting_review',
  'needs-feedback',
  'needs_feedback',
  'blocked',
  'callback-due',
  'callback_due',
]);
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled', 'removed_non_actionable']);
const CALLBACK_DUE_STATUSES = new Set([
  'done',
  'failed',
  'blocked',
  'needs-feedback',
  'needs_feedback',
  'awaiting-feedback',
  'awaiting_feedback',
  'awaiting-input',
  'awaiting_input',
]);
const DEFAULT_CALLBACK_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_CALLBACK_RETRY_MS = 2 * 60 * 1000;
const DEFAULT_CALLBACK_MAX_ATTEMPTS = 3;

function defaultDataDir(opts = {}) {
  if (opts.dataDir) return opts.dataDir;
  if (process.env.SECONDBRAIN_DATA_DIR) return process.env.SECONDBRAIN_DATA_DIR;
  if (process.env.SB_DATA_DIR) return process.env.SB_DATA_DIR;
  if (process.platform === 'linux' && fs.existsSync('/opt/secondbrain')) {
    return '/opt/secondbrain/data';
  }
  return path.join(path.resolve(__dirname, '..', '..'), 'data');
}

function resolveTasksDir(opts = {}) {
  return (
    opts.tasksDir ||
    process.env.SB_SPINE_DIR ||
    process.env.SECONDBRAIN_SPINE_TASKS_DIR ||
    path.join(defaultDataDir(opts), 'tasks')
  );
}

function resolveProgressDir(opts = {}) {
  return opts.progressDir || path.join(defaultDataDir(opts), 'agent', 'voice-agent-progress');
}

function resolveCallbackLeaseDir(opts = {}) {
  return opts.callbackLeaseDir || path.join(defaultDataDir(opts), 'agent', 'callback-leases');
}

function nowIso(opts = {}) {
  return opts.nowIso ? opts.nowIso() : new Date().toISOString();
}

function currentMs(opts = {}) {
  if (opts.nowMs !== undefined) return opts.nowMs;
  const parsed = Date.parse(nowIso(opts));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function randomId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function taskPath(id, opts = {}) {
  return path.join(resolveTasksDir(opts), `${id}.json`);
}

function readTask(id, opts = {}) {
  if (!id) return null;
  try {
    return JSON.parse(fs.readFileSync(taskPath(id, opts), 'utf8'));
  } catch {
    return null;
  }
}

function callbackLockPath(taskId, opts = {}) {
  return path.join(resolveCallbackLeaseDir(opts), `${taskId}.lock.json`);
}

function parseIsoMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

function hasActiveCallbackLease(task, opts = {}) {
  const leaseUntil = task && task.callback && task.callback.leaseUntil;
  return !!leaseUntil && parseIsoMs(leaseUntil) > currentMs(opts);
}

function tryAcquireCallbackFileLock(taskId, reason = '', opts = {}) {
  const leaseMs = Number(opts.callbackLeaseMs || opts.leaseMs || DEFAULT_CALLBACK_LEASE_MS);
  const ts = nowIso(opts);
  const now = parseIsoMs(ts) || currentMs(opts);
  const leaseId = opts.leaseId || randomId('callback-lease');
  const leaseUntil = new Date(now + leaseMs).toISOString();
  const lockPath = callbackLockPath(taskId, opts);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const payload = { taskId, leaseId, reason, claimedAt: ts, leaseUntil, pid: process.pid };
  try {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    return { leaseId, leaseUntil, lockPath };
  } catch (e) {
    if (e && e.code !== 'EEXIST') throw e;
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      existing = null;
    }
    if (existing && parseIsoMs(existing.leaseUntil) > now) return null;
    try {
      fs.unlinkSync(lockPath);
    } catch {
      return null;
    }
    return tryAcquireCallbackFileLock(taskId, reason, { ...opts, leaseId });
  }
}

function releaseCallbackFileLock(taskId, leaseId, opts = {}) {
  const lockPath = callbackLockPath(taskId, opts);
  try {
    const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (existing.leaseId && leaseId && existing.leaseId !== leaseId) return false;
  } catch {
    return false;
  }
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function writeTask(task, opts = {}) {
  atomicWriteJson(taskPath(task.id, opts), task);
  return task;
}

function patchTask(id, updater, opts = {}) {
  const task = readTask(id, opts);
  if (!task) return null;
  const next = updater(task) || task;
  next.updatedAt = next.updatedAt || nowIso(opts);
  writeTask(next, opts);
  return next;
}

function callbackRequestedFromText(text) {
  return /\bcall (?:me|him|us) (?:back|when)\b|\bcall back\b|\bcall me (?:once|after|as soon as)\b|\bring me back\b|\bphone me (?:back|when)\b/i.test(
    String(text || ''),
  );
}

function createVoiceTask(input = {}, opts = {}) {
  const prompt = String(input.ownerIntent || input.prompt || input.task || '').trim();
  if (!prompt) throw new Error('createVoiceTask requires ownerIntent or prompt');
  const ts = nowIso(opts);
  const callbackInput = input.callback || {};
  const callbackRequired =
    callbackInput.required === true || callbackRequestedFromText(prompt) || input.callbackRequested === true;
  const id = input.id || randomId('spine-voice');
  const task = createSpineTask(
    {
      id,
      kind: input.kind || 'action',
      origin: input.origin || 'voice',
      source: {
        type: input.sourceType || 'vapi_live_tool',
        ref: input.sourceRef || `${input.callId || 'manual'}:${id}`,
      },
      title: input.title || String(prompt).replace(/\s+/g, ' ').slice(0, 100),
      prompt,
      approved: input.approved !== undefined ? input.approved : true,
      status: input.status || 'queued',
      execution: {
        mode: 'cloud',
        host: 'ec2',
        runner: input.runner || 'cloud-agent',
        status: input.status || 'queued',
        commandId: input.commandId || null,
      },
      callback: {
        required: callbackRequired,
        channel: callbackInput.channel || (callbackRequired ? 'voice_callback' : 'voice_if_live'),
        requestedAt: callbackRequired ? ts : null,
        triggerOn: callbackInput.triggerOn || ['done', 'failed', 'blocked', 'needs_feedback'],
        callId: input.callId || callbackInput.callId || null,
        attempts: [],
      },
      meta: {
        explicitRequest: true,
        cloudGuaranteed: true,
        pcOffSafe: true,
        host: 'ec2',
        callId: input.callId || null,
        ...(input.meta || {}),
      },
      historyNote: input.historyNote || 'Voice request captured in the cloud spine.',
    },
    { ...opts, tasksDir: resolveTasksDir(opts), nowIso: () => ts },
  );
  return readTask(task.id, opts) || task;
}

function progressLedgerPath(taskId, opts = {}) {
  return path.join(resolveProgressDir(opts), `${taskId}.jsonl`);
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + '\n', 'utf8');
}

function appendAgentProgress(taskId, event = {}, opts = {}) {
  const ts = event.ts || nowIso(opts);
  const row = {
    ts,
    status: event.status || event.state || 'progress',
    note: String(event.note || event.message || '').slice(0, 1000),
    sources: Array.isArray(event.sources) ? event.sources.slice(0, 20) : undefined,
    files: Array.isArray(event.files) ? event.files.slice(0, 20) : undefined,
    commands: Array.isArray(event.commands) ? event.commands.slice(0, 20) : undefined,
    blocker: event.blocker ? String(event.blocker).slice(0, 500) : undefined,
    nextAction: event.nextAction ? String(event.nextAction).slice(0, 500) : undefined,
  };
  Object.keys(row).forEach((k) => row[k] === undefined && delete row[k]);
  const ledger = progressLedgerPath(taskId, opts);
  appendJsonl(ledger, row);
  patchTask(
    taskId,
    (task) => {
      task.history = Array.isArray(task.history) ? task.history : [];
      task.history.push({ status: row.status, ts, ...(row.note ? { note: row.note } : {}) });
      if (event.status) task.status = event.status;
      task.execution = task.execution || {};
      task.execution.status = event.status || task.execution.status || 'running';
      task.execution.progressLedger = ledger;
      task.lastProgressAt = ts;
      task.updatedAt = ts;
      return task;
    },
    opts,
  );
  return { ok: true, ledger, row };
}

function readProgress(taskId, opts = {}) {
  const file = progressLedgerPath(taskId, opts);
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function startAgentSession(input = {}, opts = {}) {
  const prompt = String(input.prompt || input.task || input.ownerIntent || '').trim();
  if (!prompt) throw new Error('startAgentSession requires prompt');
  const runner = String(input.runner || 'codex').toLowerCase() === 'claude' ? 'claude' : 'codex';
  const task = createVoiceTask(
    {
      ...input,
      ownerIntent: prompt,
      runner,
      kind: 'coding',
      sourceType: input.sourceType || 'voice_agent_session',
      title: input.title || `${runner} session: ${prompt.replace(/\s+/g, ' ').slice(0, 80)}`,
      callback: input.callback || {
        required: callbackRequestedFromText(prompt) || input.callbackRequested === true,
        channel: callbackRequestedFromText(prompt) || input.callbackRequested === true ? 'voice_callback' : 'voice_if_live',
      },
      historyNote: `${runner} cloud agent session queued before runner start.`,
    },
    opts,
  );
  appendAgentProgress(
    task.id,
    {
      status: 'queued',
      note: `${runner} cloud agent session queued.`,
      nextAction: 'Waiting for the cloud command worker to claim the task.',
    },
    opts,
  );
  return { task: readTask(task.id, opts), progressLedger: progressLedgerPath(task.id, opts) };
}

function attachCommandToSession(taskId, commandId, opts = {}) {
  return patchTask(
    taskId,
    (task) => {
      const ts = nowIso(opts);
      task.execution = task.execution || {};
      task.execution.commandId = commandId;
      task.execution.status = task.execution.status || 'queued';
      task.history = Array.isArray(task.history) ? task.history : [];
      task.history.push({ status: 'command_attached', ts, note: `EC2 command ${commandId} attached.` });
      task.updatedAt = ts;
      return task;
    },
    opts,
  );
}

function completeAgentSession(taskId, result = {}, opts = {}) {
  const status = result.success === false ? 'failed' : 'done';
  appendAgentProgress(
    taskId,
    {
      status,
      note: String(result.oneLiner || result.result || (status === 'done' ? 'Done.' : 'Failed.')).slice(0, 1000),
    },
    opts,
  );
  return patchTask(
    taskId,
    (task) => {
      const ts = nowIso(opts);
      task.status = status;
      task.completedAt = ts;
      task.resultSummary = String(result.oneLiner || result.result || '').slice(0, 1500);
      task.execution = task.execution || {};
      task.execution.status = status;
      task.execution.branch = result.branch || task.execution.branch || '';
      task.execution.prUrl = result.prUrl || task.execution.prUrl || '';
      task.updatedAt = ts;
      return task;
    },
    opts,
  );
}

function agentSessionStatus(taskId, opts = {}) {
  const task = readTask(taskId, opts);
  if (!task) {
    if (typeof opts.lookupByLabel === 'function') {
      const fallback = opts.lookupByLabel(taskId);
      if (fallback && fallback.summary) {
        return {
          ok: true,
          recoveredByLabel: true,
          summary: fallback.summary,
        };
      }
    }
    return { ok: false, summary: `I could not find agent session ${speechSafe(taskId || 'ExampleCo')}.` };
  }
  const progress = readProgress(taskId, opts);
  const last = progress[progress.length - 1] || null;
  const command = Array.isArray(opts.commands)
    ? opts.commands.find((c) => c && (c.id === task.execution?.commandId || c.spineTaskId === task.id))
    : null;
  const status = command?.status || task.status || task.execution?.status || 'ExampleCo';
  const lastText =
    (command && command.progressNote) ||
    (last && [last.note, last.blocker ? `Blocker: ${last.blocker}` : '', last.nextAction ? `Next: ${last.nextAction}` : '']
      .filter(Boolean)
      .join(' ')) ||
    task.resultSummary ||
    'No progress event yet.';
  const cb = task.callback && task.callback.required ? ' Callback is attached.' : '';
  return {
    ok: true,
    task,
    progress,
    command,
    summary: `${speechSafe(task.title || task.id)} is ${String(status).replace(/_/g, ' ')}. ${speechSafe(lastText).slice(0, 500)}${cb}`,
  };
}

function taskScore(task, query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return 1;
  const terms = q.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const text = [task.id, task.title, task.prompt, task.status, task.resultSummary]
    .join(' ')
    .toLowerCase();
  if (!terms.length) return text.includes(q) ? 1 : 0;
  return terms.filter((t) => text.includes(t)).length / terms.length;
}

function spineSnapshot(params = {}, opts = {}) {
  const limit = Math.max(1, Math.min(20, Number(params.limit || 8)));
  const query = String(params.query || '').trim();
  const commands = Array.isArray(params.commands) ? params.commands : [];
  const tasks = listSpineTasks({ tasksDir: resolveTasksDir(opts) })
    .map((task) => ({ task, score: taskScore(task, query) }))
    .filter((x) => !query || x.score >= 0.34)
    .sort((a, b) => {
      const aActive = ACTIVE_STATUSES.has(String(a.task.status || '').toLowerCase()) ? 1 : 0;
      const bActive = ACTIVE_STATUSES.has(String(b.task.status || '').toLowerCase()) ? 1 : 0;
      const aTs = Date.parse(a.task.updatedAt || a.task.createdAt || '') || 0;
      const bTs = Date.parse(b.task.updatedAt || b.task.createdAt || '') || 0;
      return bActive - aActive || b.score - a.score || bTs - aTs;
    })
    .slice(0, limit)
    .map((x) => x.task);
  const commandItems = commands
    .filter((c) => c && c.type === 'claude')
    .slice()
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || '') - Date.parse(a.updatedAt || a.createdAt || ''))
    .slice(0, Math.max(0, limit - tasks.length));
  if (!tasks.length && !commandItems.length) {
    const scope = query ? ` for ${speechSafe(query)}` : '';
    return {
      ok: true,
      source: 'cloud-spine',
      scope,
      tasks,
      commands: commandItems,
      summary: `I do not see an active cloud-spine match${scope}. That is only the active spine scope, not the whole archive.`,
    };
  }
  const lines = [];
  for (const task of tasks) {
    const title = speechSafe(task.title || task.prompt || task.id).slice(0, 100);
    const status = String(task.status || 'ExampleCo').replace(/_/g, ' ');
    const cb = task.callback && task.callback.required && !task.callback.deliveredAt ? ', callback attached' : '';
    lines.push(`${title}: ${status}${cb}`);
  }
  for (const cmd of commandItems) {
    const title = speechSafe(cmd.prompt || cmd.id).slice(0, 100);
    lines.push(`${title}: ${String(cmd.status || 'queued').replace(/_/g, ' ')}`);
  }
  return {
    ok: true,
    source: 'cloud-spine',
    scope: query ? `query:${query}` : 'active-and-recent',
    tasks,
    commands: commandItems,
    summary: lines.join('. ') + '.',
  };
}

async function graphitiQueryLive(params = {}, opts = {}) {
  const query = String(params.query || params.question || '').trim();
  if (!query) return { ok: false, source: 'graphiti', scope: 'owner-ea', facts: [], error: 'query required' };
  const maxFacts = Math.max(1, Math.min(20, Number(params.maxFacts || params.max_facts || params.limit || 15)));
  const search = opts.searchFacts || searchFacts;
  try {
    const facts = await search(query, {
      maxFacts,
      groupId: params.groupId || 'owner-ea',
      timeoutMs: Number(params.timeoutMs || opts.timeoutMs || 5000),
    });
    return {
      ok: true,
      source: 'graphiti',
      scope: params.groupId || 'owner-ea',
      order: 'graphiti_return_order',
      facts: Array.isArray(facts) ? facts : [],
      noMatchScope: facts && facts.length ? null : `Graphiti facts in group ${params.groupId || 'owner-ea'}`,
    };
  } catch (e) {
    return {
      ok: false,
      source: 'graphiti',
      scope: params.groupId || 'owner-ea',
      order: 'graphiti_return_order',
      facts: [],
      error: String(e.message || e).slice(0, 300),
    };
  }
}

function formatGraphitiLiveResult(result) {
  if (!result || !result.ok) {
    return `Graphiti query failed in scope ${result?.scope || 'owner-ea'}: ${speechSafe(result?.error || 'ExampleCo error')}.`;
  }
  if (!result.facts || result.facts.length === 0) {
    return `No Graphiti facts found in scope ${result.scope}. That is a scoped no-match, not proof the thing does not exist.`;
  }
  const lines = result.facts.slice(0, 8).map((fact) => {
    const text = fact.fact || fact.content || fact.name || JSON.stringify(fact);
    const date = fact.valid_at || fact.created_at || fact.reference_time || fact.source_date || '';
    return '- ' + speechSafe(String(text).slice(0, 300)) + (date ? ` (${String(date).slice(0, 10)})` : '');
  });
  return `Graphiti scope ${result.scope}, preserving Graphiti order:\n` + lines.join('\n');
}

function registerCallbackCommitment(input = {}, opts = {}) {
  const taskId = input.taskId || input.task_id || '';
  const ts = nowIso(opts);
  let task = taskId ? readTask(taskId, opts) : null;
  if (!task) {
    task = createVoiceTask(
      {
        ownerIntent: input.ownerIntent || input.prompt || input.reason || 'Call ExampleCo back with the requested update.',
        callId: input.callId || input.call_id || null,
        callback: { required: true, channel: 'voice_callback' },
        title: input.title || 'Voice callback commitment',
      },
      opts,
    );
  }
  return patchTask(
    task.id,
    (t) => {
      t.callback = t.callback || {};
      t.callback.required = true;
      t.callback.channel = input.channel || 'voice_callback';
      t.callback.requestedAt = t.callback.requestedAt || ts;
      t.callback.triggerOn = t.callback.triggerOn || ['done', 'failed', 'blocked', 'needs_feedback'];
      t.callback.callId = input.callId || input.call_id || t.callback.callId || null;
      t.callback.reason = input.reason || t.callback.reason || 'ExampleCo asked for a callback.';
      t.callback.attempts = Array.isArray(t.callback.attempts) ? t.callback.attempts : [];
      t.history = Array.isArray(t.history) ? t.history : [];
      t.history.push({ status: 'callback_committed', ts, note: t.callback.reason });
      t.updatedAt = ts;
      return t;
    },
    opts,
  );
}

function isCallbackDue(task, opts = {}) {
  if (!task || !task.callback || task.callback.required !== true) return null;
  if (task.callback.deliveredAt || task.callback.deadLetterAt) return null;
  if (hasActiveCallbackLease(task, opts)) return null;
  const nowMs = currentMs(opts);
  if (task.callback.nextAttemptAt && parseIsoMs(task.callback.nextAttemptAt) > nowMs) return null;
  const status = String(task.status || '').toLowerCase();
  if (CALLBACK_DUE_STATUSES.has(status)) return 'status:' + status;
  if (TERMINAL_STATUSES.has(status)) return 'terminal:' + status;
  const staleMs = opts.staleMs || 10 * 60 * 1000;
  const lastMs = Date.parse(task.lastProgressAt || task.updatedAt || task.createdAt || '');
  if (Number.isFinite(lastMs) && nowMs - lastMs >= staleMs && ACTIVE_STATUSES.has(status)) {
    return 'stalled:' + status;
  }
  return null;
}

function scanCallbackDueTasks(opts = {}) {
  const tasks = listSpineTasks({ tasksDir: resolveTasksDir(opts) });
  return tasks
    .map((task) => ({ task, reason: isCallbackDue(task, opts) }))
    .filter((x) => x.reason)
    .sort((a, b) => Date.parse(a.task.updatedAt || '') - Date.parse(b.task.updatedAt || ''));
}

function claimCallback(taskId, reason = '', opts = {}) {
  const fileLock = tryAcquireCallbackFileLock(taskId, reason, opts);
  if (!fileLock) return null;
  const task = readTask(taskId, opts);
  const dueReason = isCallbackDue(task, opts);
  if (!task || !dueReason) {
    releaseCallbackFileLock(taskId, fileLock.leaseId, opts);
    return null;
  }
  const ts = nowIso(opts);
  const claimed = patchTask(
    taskId,
    (t) => {
      t.callback = t.callback || {};
      t.callback.leaseId = fileLock.leaseId;
      t.callback.leasedAt = ts;
      t.callback.leaseUntil = fileLock.leaseUntil;
      t.callback.leaseReason = reason || dueReason;
      t.history = Array.isArray(t.history) ? t.history : [];
      t.history.push({
        status: 'callback_claimed',
        ts,
        note: `Callback lease ${fileLock.leaseId} claimed for ${reason || dueReason}.`,
      });
      t.updatedAt = ts;
      return t;
    },
    opts,
  );
  return { task: claimed, reason: reason || dueReason, leaseId: fileLock.leaseId, leaseUntil: fileLock.leaseUntil };
}

function buildCallbackMessage(task, reason = '') {
  const title = speechSafe(task.title || task.prompt || 'your task').slice(0, 140);
  const status = String(task.status || 'ExampleCo').replace(/_/g, ' ');
  const result = speechSafe(task.resultSummary || '').slice(0, 500);
  const progress = speechSafe(task.lastProgressNote || '').slice(0, 300);
  const tail = result || progress || (reason.startsWith('stalled:') ? 'I have not seen fresh progress, so I am calling instead of letting it disappear.' : '');
  return ['Hey ExampleCo, Amy here with the callback you asked for.', `${title} is ${status}.`, tail]
    .filter(Boolean)
    .join(' ');
}

function recordCallbackAttempt(taskId, attempt = {}, opts = {}) {
  const ts = nowIso(opts);
  const retryMs = Number(opts.callbackRetryMs || DEFAULT_CALLBACK_RETRY_MS);
  const maxAttempts = Number(opts.maxCallbackAttempts || DEFAULT_CALLBACK_MAX_ATTEMPTS);
  let updated = null;
  try {
    updated = patchTask(
      taskId,
      (task) => {
        task.callback = task.callback || {};
        task.callback.attempts = Array.isArray(task.callback.attempts) ? task.callback.attempts : [];
        task.callback.attempts.push({
          ts,
          status: attempt.status || 'attempted',
          channel: attempt.channel || 'voice_callback',
          providerCallId: attempt.providerCallId || attempt.callId || null,
          message: attempt.message ? String(attempt.message).slice(0, 500) : undefined,
          error: attempt.error ? String(attempt.error).slice(0, 500) : undefined,
        });
        delete task.callback.leaseId;
        delete task.callback.leasedAt;
        delete task.callback.leaseUntil;
        delete task.callback.leaseReason;
        if (attempt.status === 'delivered') task.callback.deliveredAt = ts;
        if (attempt.status === 'failed' && task.callback.attempts.length < maxAttempts) {
          task.callback.nextAttemptAt = new Date((parseIsoMs(ts) || Date.now()) + retryMs).toISOString();
        } else {
          delete task.callback.nextAttemptAt;
        }
        if (attempt.status === 'dead-letter' || (attempt.status === 'failed' && task.callback.attempts.length >= maxAttempts)) {
          task.callback.deadLetterAt = ts;
          task.status = 'callback-dead-letter';
          task.execution = task.execution || {};
          task.execution.status = 'callback-dead-letter';
        }
        task.history = Array.isArray(task.history) ? task.history : [];
        task.history.push({
          status:
            task.callback.deadLetterAt && attempt.status !== 'delivered'
              ? 'callback_dead_lettered'
              : attempt.status === 'delivered'
                ? 'callback_delivered'
                : 'callback_attempted',
          ts,
          note: attempt.error || attempt.message || 'Callback attempt recorded.',
        });
        task.updatedAt = ts;
        return task;
      },
      opts,
    );
  } finally {
    if (attempt.leaseId) releaseCallbackFileLock(taskId, attempt.leaseId, opts);
  }
  return updated;
}

module.exports = {
  ACTIVE_STATUSES,
  CALLBACK_DUE_STATUSES,
  TERMINAL_STATUSES,
  agentSessionStatus,
  appendAgentProgress,
  buildCallbackMessage,
  callbackRequestedFromText,
  claimCallback,
  completeAgentSession,
  createVoiceTask,
  defaultDataDir,
  formatGraphitiLiveResult,
  graphitiQueryLive,
  isCallbackDue,
  progressLedgerPath,
  readProgress,
  readTask,
  recordCallbackAttempt,
  releaseCallbackFileLock,
  registerCallbackCommitment,
  resolveCallbackLeaseDir,
  resolveProgressDir,
  resolveTasksDir,
  scanCallbackDueTasks,
  spineSnapshot,
  startAgentSession,
  attachCommandToSession,
};
