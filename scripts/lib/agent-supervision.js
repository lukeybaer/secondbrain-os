'use strict';

/**
 * agent-supervision.js -- spawned agents are supervised by the durable task
 * store, not by the conversation that spawned them.
 *
 * Measured defect (2026-08-24 token Pareto): one Codex session billed
 * 268,339,536 tokens across 2,180 turns while only ~2.2M tokens of unique
 * material ever entered its context, a 123x re-read amplification. 859 of those
 * turns (39%) did nothing but poll spawned agents with wait / wait_agent /
 * list_agents. Those polls alone cost 102,186,835 tokens (37.4% of the session)
 * because each one resent an average 118,901 tokens of context to emit 59
 * tokens of "still running". Compaction cannot fix this: the window refills on
 * the next poll.
 *
 * The fix is structural, not a smaller prompt. A session that spawns background
 * work REGISTERS the work here and ENDS ITS TURN. A model-free waiter (an
 * existing periodic runner, no new daemon) watches for a terminal receipt and
 * resumes the parent exactly once, handing it that agent's final receipt
 * instead of an accumulated poll transcript.
 *
 * Two seams, both in this file:
 *   1. Supervision: register / receipt / sweep / resume, all over the spine.
 *   2. Prevention telemetry: analyzePollAmplification() scores poll-only turns
 *      per session and FAILS above POLL_TURN_SHARE_LIMIT, so the regression is
 *      measured where the spend is measured rather than remembered.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  createSpineTask,
  listSpineTasks,
  readTask,
  writeTask,
  resolveTasksDir,
  defaultDataDir,
} = require('./spine-ingress.js');

const SUPERVISION_REL_DIR = path.join('agent', 'agent-supervision');
const SUPERVISION_SCHEMA = 'agent-supervision.v1';
// A spawned agent that never reports is not supervised forever. The default is
// generous because the point is to stop POLLING, not to cut work short.
const DEFAULT_AGENT_DEADLINE_MS = 90 * 60 * 1000;
// A receipt's atomic rename is not instantaneous. A deadline that fired inside
// that window used to deliver `timeout` permanently and ignore the real
// terminal receipt, so the deadline is only honored after this grace window and
// the receipt is re-read once more at delivery time.
const DEADLINE_GRACE_MS = 2 * 60 * 1000;
// A claim held by a sweep that died is reaped after this, which is what makes a
// crash between signal creation and the task update recoverable.
const CLAIM_STALE_MS = 10 * 60 * 1000;

// Supervision-only tools: they report an agent's status and change nothing.
// A turn whose entire tool use is drawn from this set produced no work, it only
// asked "are you done yet" at the cost of a full context resend. Matched as a
// CATEGORY (name shape), never as one literal tool, so a renamed or newly added
// waiter is caught without editing this list first.
const POLL_TOOL_PATTERN =
  /^(wait_?agents?|list_?agents?|agents?_?wait|agents?_?status|check_?agents?|poll_?agents?|get_?agent_?output|task_?output|agent_?result)$/i;
// A bare `wait` is ambiguous: it also means "sleep for a process that is not a
// supervised agent". It counts as polling ONLY when the same call names an
// agent this system is actually supervising, which is what CORRELATION means
// here. Over-counting generic waits was how a legitimate sleep turned green
// sessions red.
const AMBIGUOUS_POLL_TOOL_PATTERN = /^(wait|sleep|watch|monitor)$/i;
// Tools that change nothing and cost nothing. A polling turn that also fires
// one of these is still a polling turn: requiring EVERY call to be a poll let a
// trivial second tool call defeat the whole measurement.
const TRIVIAL_TOOL_PATTERN = /^(echo|noop|think|todo_?write|todo_?read|pwd|date)$/i;

// Above this share of a session's turns, poll-only turns are a defect, not
// noise. 5% of 2,180 turns is 109; the measured incident ran 859.
const POLL_TURN_SHARE_LIMIT = 0.05;
// Short sessions cannot be judged: three turns, one of them a status check, is
// 33% and means nothing.
const POLL_TURN_MIN_TURNS = 20;
// A share alone is not a defect. Two polls in twenty turns is 10% and is
// perfectly normal supervision; the measured incident was 859 polls. Red now
// requires BOTH the share and a meaningful absolute count.
const POLL_TURN_MIN_COUNT = 25;

function isPollTool(name) {
  const text = String(name || '').trim();
  if (!text) return false;
  return POLL_TOOL_PATTERN.test(text);
}

function isAmbiguousPollTool(name) {
  const text = String(name || '').trim();
  if (!text) return false;
  return AMBIGUOUS_POLL_TOOL_PATTERN.test(text);
}

function isTrivialTool(name) {
  const text = String(name || '').trim();
  if (!text) return false;
  return TRIVIAL_TOOL_PATTERN.test(text);
}

// Does this tool call name an agent we are actually supervising? Shell-based
// polling (`bash: codex agent status <id>`) and namespaced variants evade a
// name regex, but they cannot evade naming the id they are waiting on.
function callReferencesSupervisedAgent(rawInput, supervisedAgentIds) {
  if (!supervisedAgentIds || supervisedAgentIds.size === 0) return false;
  let text = '';
  try {
    text = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput || '');
  } catch {
    return false;
  }
  if (!text) return false;
  for (const id of supervisedAgentIds) {
    if (id && text.includes(id)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. Supervision over the spine
// ---------------------------------------------------------------------------

function supervisionDir(dataDir, ...segments) {
  return path.join(dataDir || defaultDataDir(), SUPERVISION_REL_DIR, ...segments);
}

function safeId(value, label) {
  const text = String(value || '').trim();
  if (!text || !/^[A-Za-z0-9._-]+$/.test(text) || text === '.' || text === '..') {
    throw new Error(`agent-supervision: invalid ${label || 'id'}`);
  }
  return text;
}

// EVERY artifact is keyed by the immutable spawnId, never by the reusable
// agentId. Keying by agentId let a re-registered id consume the PREVIOUS run's
// receipt, overwrite a live signal, and attach one run's completion to a
// different parent.
function agentReceiptPath({ dataDir, spawnId }) {
  return supervisionDir(dataDir, 'receipts', `${safeId(spawnId, 'spawnId')}.json`);
}

function claimPath({ dataDir, spawnId }) {
  return supervisionDir(dataDir, 'claims', `${safeId(spawnId, 'spawnId')}.json`);
}

function resumeSignalPath({ dataDir, parentSessionId, spawnId }) {
  return supervisionDir(
    dataDir,
    'resume',
    safeId(parentSessionId, 'parentSessionId'),
    `${safeId(spawnId, 'spawnId')}.json`,
  );
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
  return file;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function supervisionTaskId(spawnId) {
  return `spine-agent-${crypto.createHash('sha1').update(String(spawnId)).digest('hex').slice(0, 32)}`;
}

function newSpawnId(agentId) {
  const base = String(agentId || 'agent').replace(/[^A-Za-z0-9._-]/g, '') || 'agent';
  return `${base}-${crypto.randomBytes(8).toString('hex')}`;
}

const TERMINAL_OUTCOMES = new Set(['done', 'failed', 'error', 'cancelled', 'timeout']);

/**
 * A receipt is evidence, so it is VALIDATED before it is believed. A stale,
 * foreign, or malformed receipt must never terminate a task or resume a parent.
 */
function validateAgentReceipt(receipt, supervision, task) {
  if (!receipt || typeof receipt !== 'object') return { ok: false, reason: 'missing' };
  if (receipt.schema !== SUPERVISION_SCHEMA) return { ok: false, reason: 'schema' };
  if (String(receipt.spawnId || '') !== String(supervision.spawnId || ''))
    return { ok: false, reason: 'spawn-id' };
  if (String(receipt.agentId || '') !== String(supervision.agentId || ''))
    return { ok: false, reason: 'agent-id' };
  if (task && String(receipt.taskId || '') !== String(task.id || ''))
    return { ok: false, reason: 'task-id' };
  if (!TERMINAL_OUTCOMES.has(String(receipt.outcome || '')))
    return { ok: false, reason: 'outcome' };
  const completedAt = Date.parse(String(receipt.completedAt || ''));
  if (!Number.isFinite(completedAt)) return { ok: false, reason: 'completed-at' };
  const registeredAt = Date.parse(String(supervision.registeredAt || ''));
  // A receipt that predates this registration belongs to an earlier run.
  if (Number.isFinite(registeredAt) && completedAt < registeredAt)
    return { ok: false, reason: 'stale' };
  return { ok: true, reason: null };
}

/**
 * Register a spawned background agent and RETURN A RECEIPT PATH.
 *
 * Deliberately no handle, no promise, no poll token. The caller cannot wait on
 * this; that is the point. The spawning turn ends here.
 */
function registerSpawnedAgent(
  {
    dataDir,
    agentId,
    spawnId = '',
    parentSessionId,
    label = '',
    prompt = '',
    origin = 'claude-code',
    surface = '',
    deadlineMs = DEFAULT_AGENT_DEADLINE_MS,
    now = new Date(),
  } = {},
  opts = {},
) {
  const id = safeId(agentId, 'agentId');
  const parent = safeId(parentSessionId, 'parentSessionId');
  const spawn = safeId(spawnId || newSpawnId(id), 'spawnId');
  const receiptPath = agentReceiptPath({ dataDir, spawnId: spawn });
  const registeredAt = now.toISOString();
  const task = createSpineTask(
    {
      id: supervisionTaskId(spawn),
      kind: 'action',
      origin,
      status: 'running',
      prompt: prompt || label || `background agent ${id}`,
      title: label || `background agent ${id}`,
      source: { type: 'agent-spawn', ref: spawn },
      meta: {
        supervision: {
          schema: SUPERVISION_SCHEMA,
          spawnId: spawn,
          agentId: id,
          parentSessionId: parent,
          surface: String(surface || ''),
          receiptPath,
          registeredAt,
          deadlineAt: new Date(now.getTime() + Number(deadlineMs || 0)).toISOString(),
          resumed: false,
          delivery: null,
        },
      },
    },
    opts,
  );
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  // The supervision contract, returned to the caller: an address to read later,
  // never a thing to sit on.
  return { taskId: task.id, receiptPath, spawnId: spawn, agentId: id, parentSessionId: parent };
}

/** The agent's own terminal write. Small by construction: an outcome, not a transcript. */
function writeAgentReceipt({
  dataDir,
  spawnId,
  agentId,
  taskId = '',
  outcome = 'done',
  summary = '',
  artifacts = [],
  tokens = null,
  now = new Date(),
} = {}) {
  const spawn = safeId(spawnId, 'spawnId');
  const file = agentReceiptPath({ dataDir, spawnId: spawn });
  const receipt = {
    schema: SUPERVISION_SCHEMA,
    spawnId: spawn,
    agentId: safeId(agentId || spawn, 'agentId'),
    taskId: String(taskId || supervisionTaskId(spawn)),
    outcome: String(outcome || 'done'),
    summary: String(summary || ''),
    artifacts: Array.isArray(artifacts) ? artifacts.map((a) => String(a)) : [],
    tokens: tokens && typeof tokens === 'object' ? tokens : null,
    completedAt: now.toISOString(),
  };
  writeJsonAtomic(file, receipt);
  return { receiptPath: file, receipt };
}

function readAgentReceipt({ dataDir, spawnId }) {
  return readJson(agentReceiptPath({ dataDir, spawnId }));
}

function supervisedTasks(opts = {}) {
  return listSpineTasks(opts).filter(
    (task) => task && task.meta && task.meta.supervision && task.meta.supervision.spawnId,
  );
}

/** Agent ids currently under supervision, used to CORRELATE poll telemetry. */
function supervisedAgentIds(opts = {}) {
  const ids = new Set();
  for (const task of supervisedTasks(opts)) {
    const sup = task.meta.supervision;
    if (sup.agentId) ids.add(String(sup.agentId));
    if (sup.spawnId) ids.add(String(sup.spawnId));
  }
  return ids;
}

/**
 * Model-free terminal detection. No model is invoked, no context is resent, and
 * a still-running agent produces NOTHING: an unfinished agent is silence, not a
 * turn.
 */
function scanTerminalAgents(
  { dataDir, nowMs = Date.now(), graceMs = DEADLINE_GRACE_MS } = {},
  opts = {},
) {
  const changes = [];
  for (const task of supervisedTasks(opts)) {
    const sup = task.meta.supervision;
    // Already acknowledged by the parent: finished, not a candidate.
    if (sup.delivery && sup.delivery.state === 'acknowledged') continue;
    const raw = readJson(sup.receiptPath || agentReceiptPath({ dataDir, spawnId: sup.spawnId }));
    const verdict = validateAgentReceipt(raw, sup, task);
    if (verdict.ok) {
      if (sup.resumed === true) continue;
      changes.push({ task, supervision: sup, receipt: raw, reason: 'receipt' });
      continue;
    }
    if (sup.resumed === true) continue;
    const deadlineAt = Date.parse(String(sup.deadlineAt || ''));
    // GRACE: a receipt's final rename is not instantaneous, and a deadline that
    // fired inside that window used to deliver `timeout` permanently while the
    // real terminal receipt was landing. The grace window plus the re-read at
    // delivery time is the liveness reconciliation.
    if (Number.isFinite(deadlineAt) && nowMs > deadlineAt + Number(graceMs || 0)) {
      changes.push({
        task,
        supervision: sup,
        reason: 'deadline',
        rejectedReceiptReason: raw ? verdict.reason : null,
        receipt: {
          schema: SUPERVISION_SCHEMA,
          spawnId: sup.spawnId,
          agentId: sup.agentId,
          taskId: task.id,
          outcome: 'timeout',
          summary: `no valid receipt by ${sup.deadlineAt}`,
          artifacts: [],
          tokens: null,
          completedAt: new Date(nowMs).toISOString(),
        },
      });
    }
  }
  return changes;
}

/**
 * Exactly-once claim. `wx` is an atomic create-or-fail, so two overlapping
 * sweeps cannot both win. The claim carries the supervision RUN id, so a crash
 * between claim and task update is reaped and finished by a later sweep instead
 * of silently redelivering to the parent.
 */
function claimDelivery({ dataDir, spawnId, runId, nowMs = Date.now(), staleMs = CLAIM_STALE_MS }) {
  const file = claimPath({ dataDir, spawnId });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify({ runId, spawnId, claimedAt: new Date(nowMs).toISOString() }, null, 2)}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, body, null, 'utf8');
      fs.fsyncSync(fd);
      return { ok: true, file };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') return { ok: false, file };
      const existing = readJson(file);
      const claimedAt = Date.parse(String((existing && existing.claimedAt) || ''));
      const age = Number.isFinite(claimedAt) ? nowMs - claimedAt : Infinity;
      // A claim older than the stale window belongs to a sweep that died. Its
      // signal, if any, is already on disk and the consumer keys on deliveryId,
      // so recovering the claim finishes the delivery instead of duplicating it.
      if (age > Number(staleMs || 0)) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* raced with another sweep */
        }
        continue;
      }
      return { ok: false, file };
    } finally {
      try {
        if (fd !== null) fs.closeSync(fd);
      } catch {
        /* best effort */
      }
    }
  }
  return { ok: false, file };
}

/**
 * Resume the parent with the agent's FINAL RECEIPT ONLY. The resume payload
 * never carries poll history, intermediate status, or the parent's own prior
 * context, because carrying those is the amplification this exists to remove.
 *
 * Exactly-once: claim, then signal (pending-delivery), then task update
 * (delivered), then the parent's acknowledgement. Every step is keyed by
 * deliveryId, so a repeat is a no-op rather than a second delivery.
 */
function resumeParentWithReceipt(
  { dataDir, change, nowMs = Date.now(), runId = '' } = {},
  opts = {},
) {
  const sup = change.supervision;
  const run = String(runId || `sweep-${crypto.randomBytes(6).toString('hex')}`);
  const claim = claimDelivery({ dataDir, spawnId: sup.spawnId, runId: run, nowMs });
  if (!claim.ok) return null;
  // LIVENESS RECONCILIATION: re-read the receipt after winning the claim. A
  // real terminal receipt that landed during the deadline race beats the
  // synthesized timeout.
  let receipt = change.receipt;
  let reason = change.reason;
  if (reason === 'deadline') {
    const fresh = readJson(sup.receiptPath || agentReceiptPath({ dataDir, spawnId: sup.spawnId }));
    const verdict = validateAgentReceipt(fresh, sup, change.task);
    if (verdict.ok) {
      receipt = fresh;
      reason = 'receipt';
    }
  }
  const deliveryId = `${sup.spawnId}:${run}`;
  const file = resumeSignalPath({
    dataDir,
    parentSessionId: sup.parentSessionId,
    spawnId: sup.spawnId,
  });
  // Never clobber a signal the consumer already acknowledged.
  const existingSignal = readJson(file);
  if (existingSignal && existingSignal.acknowledgedAt) return null;
  const signal = {
    schema: SUPERVISION_SCHEMA,
    deliveryId,
    runId: run,
    spawnId: sup.spawnId,
    agentId: sup.agentId,
    parentSessionId: sup.parentSessionId,
    taskId: change.task.id,
    label: change.task.title,
    reason,
    receiptPath: sup.receiptPath,
    // The whole payload the parent gets back.
    outcome: receipt.outcome,
    summary: receipt.summary,
    artifacts: receipt.artifacts || [],
    state: 'pending-delivery',
    resumedAt: new Date(nowMs).toISOString(),
    acknowledgedAt: null,
  };
  writeJsonAtomic(file, signal);
  const fresh = readTask(change.task.id, opts) || change.task;
  const terminal = receipt.outcome === 'done' ? 'done' : 'failed';
  writeTask(
    {
      ...fresh,
      status: terminal,
      updatedAt: signal.resumedAt,
      completedAt: signal.resumedAt,
      resultSummary: receipt.summary || receipt.outcome,
      meta: {
        ...(fresh.meta || {}),
        supervision: {
          ...sup,
          resumed: true,
          resumedAt: signal.resumedAt,
          reason,
          delivery: {
            state: 'delivered',
            deliveryId,
            runId: run,
            deliveredAt: signal.resumedAt,
            acknowledgedAt: null,
          },
        },
      },
    },
    opts,
  );
  return { signalPath: file, signal };
}

/**
 * Append one sweep failure to a durable ledger AND stderr. A sweep that cannot
 * close finished agents used to swallow its error twice (here and in the
 * exporter that calls it), so 113 finished helper tasks stayed "running" for
 * weeks with nothing saying why. A failure is now always visible.
 */
function recordSweepError({ dataDir, runId, taskId = null, spawnId = null, stage, error }) {
  const row = {
    ts: new Date().toISOString(),
    runId,
    stage,
    taskId,
    spawnId,
    error: String((error && (error.stack || error.message)) || error || 'unknown').slice(0, 600),
  };
  console.error(
    `[agent-supervision] ${stage} failed task=${taskId || '-'}: ${row.error.split('\n')[0]}`,
  );
  try {
    const file = supervisionDir(dataDir, 'sweep-errors.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  } catch (ledgerError) {
    console.error(`[agent-supervision] could not write sweep-errors.jsonl: ${ledgerError.message}`);
  }
  return row;
}

/** One call for a periodic runner: detect terminal agents, resume once each. */
function sweepAgentSupervision({ dataDir, nowMs = Date.now(), runId = '' } = {}, opts = {}) {
  const run = String(runId || `sweep-${crypto.randomBytes(6).toString('hex')}`);
  const resumed = [];
  const errors = [];
  let skipped = 0;
  let changes = [];
  try {
    changes = scanTerminalAgents({ dataDir, nowMs }, opts);
  } catch (error) {
    errors.push(recordSweepError({ dataDir, runId: run, stage: 'scan', error }));
    return { resumed, count: 0, runId: run, errors, skipped, detected: 0 };
  }
  for (const change of changes) {
    try {
      const result = resumeParentWithReceipt({ dataDir, change, nowMs, runId: run }, opts);
      if (result) resumed.push(result);
      else skipped += 1;
    } catch (error) {
      // One bad task never stops the sweep, but it is never silent either.
      errors.push(
        recordSweepError({
          dataDir,
          runId: run,
          stage: 'resume',
          taskId: change.task && change.task.id,
          spawnId: change.supervision && change.supervision.spawnId,
          error,
        }),
      );
    }
  }
  return { resumed, count: resumed.length, runId: run, errors, skipped, detected: changes.length };
}

/**
 * THE CONSUMER. This is what makes the feature real rather than a file nobody
 * reads: a parent surface calls it on its next turn and RECEIVES the finished
 * agents' receipts, instead of having spent N turns asking. Delivery is only
 * complete once the parent acknowledges.
 */
function takePendingResumes({ dataDir, parentSessionId } = {}) {
  const dir = supervisionDir(dataDir, 'resume', safeId(parentSessionId, 'parentSessionId'));
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(dir, entry);
    const signal = readJson(file);
    if (!signal || signal.schema !== SUPERVISION_SCHEMA) continue;
    // Consumer-side idempotency: an acknowledged signal is never handed to the
    // parent a second time, however often it is redelivered.
    if (signal.acknowledgedAt) continue;
    out.push({ file, signal });
  }
  out.sort((a, b) => String(a.signal.resumedAt).localeCompare(String(b.signal.resumedAt)));
  return out;
}

/** The parent's acknowledgement. Idempotent and keyed by deliveryId. */
function acknowledgeResume(
  { dataDir, parentSessionId, spawnId, deliveryId = '', nowMs = Date.now() } = {},
  opts = {},
) {
  const file = resumeSignalPath({ dataDir, parentSessionId, spawnId });
  const signal = readJson(file);
  if (!signal) return null;
  if (deliveryId && signal.deliveryId !== deliveryId) return null;
  if (signal.acknowledgedAt) return { signalPath: file, signal, alreadyAcknowledged: true };
  const acknowledgedAt = new Date(nowMs).toISOString();
  const next = { ...signal, state: 'acknowledged', acknowledgedAt };
  writeJsonAtomic(file, next);
  const task = readTask(signal.taskId, opts);
  if (task && task.meta && task.meta.supervision) {
    writeTask(
      {
        ...task,
        updatedAt: acknowledgedAt,
        meta: {
          ...task.meta,
          supervision: {
            ...task.meta.supervision,
            delivery: {
              ...(task.meta.supervision.delivery || {}),
              state: 'acknowledged',
              deliveryId: signal.deliveryId,
              acknowledgedAt,
            },
          },
        },
      },
      opts,
    );
  }
  // The claim is released only after the parent confirmed receipt, so a crash
  // before acknowledgement is recoverable rather than lost.
  try {
    fs.rmSync(claimPath({ dataDir, spawnId: signal.spawnId }), { force: true });
  } catch {
    /* best effort */
  }
  return { signalPath: file, signal: next, alreadyAcknowledged: false };
}

// ---------------------------------------------------------------------------
// 2. Prevention telemetry: poll-only turn share per session
// ---------------------------------------------------------------------------

/**
 * Accumulates turn/tool structure while another pass is already reading the
 * rollout rows, so measuring costs no extra I/O. Keyed by file, relabelled to
 * the real session id once the collector resolves it.
 */
function createPollTurnAccumulator({ supervisedIds = null } = {}) {
  const byKey = new Map();
  const ids = supervisedIds instanceof Set ? supervisedIds : new Set(supervisedIds || []);

  function entry(key) {
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        label: key,
        platform: 'unknown',
        turns: 0,
        pollTurns: 0,
        pollToolCalls: 0,
        correlatedPollTurns: 0,
        pollTokens: 0,
        open: null,
      });
    }
    return byKey.get(key);
  }

  function closeTurn(state) {
    if (!state.open) return;
    const { toolCalls, pollCalls, otherCalls, correlated, tokens } = state.open;
    state.turns += 1;
    // A turn is poll-dominant when it polled and did nothing else that MATTERS.
    // Requiring every call to be a poll let one trivial second tool call (a
    // todo write, an echo) hide an 859-turn polling loop from the measurement.
    if (pollCalls > 0 && otherCalls === 0) {
      state.pollTurns += 1;
      state.pollToolCalls += pollCalls;
      state.pollTokens += Number(tokens) || 0;
      if (correlated) state.correlatedPollTurns += 1;
    }
    state.open = null;
  }

  function openTurn() {
    return { toolCalls: 0, pollCalls: 0, otherCalls: 0, correlated: false, tokens: 0 };
  }

  // One tool call, classified. `wait` and friends only count when the call
  // actually names an agent under supervision, which is what stops a generic
  // process wait from being scored as agent polling.
  function observeCall(open, name, rawInput) {
    open.toolCalls += 1;
    const references = callReferencesSupervisedAgent(rawInput, ids);
    if (isPollTool(name)) {
      open.pollCalls += 1;
      if (references) open.correlated = true;
      return;
    }
    if (isAmbiguousPollTool(name) && references) {
      open.pollCalls += 1;
      open.correlated = true;
      return;
    }
    // Shell-shaped polling (`bash: codex agent status <id>`) evades a tool-name
    // regex but cannot avoid naming the id it is waiting on.
    if (references) {
      open.pollCalls += 1;
      open.correlated = true;
      return;
    }
    if (isTrivialTool(name)) return;
    open.otherCalls += 1;
  }

  return {
    // Codex rollout rows: task_started opens a turn, tool calls land inside it.
    observeCodexRow(key, row) {
      const state = entry(key);
      state.platform = 'codex';
      const type = row && row.type;
      const payload = (row && row.payload) || {};
      if (type === 'event_msg' && payload.type === 'task_started') {
        closeTurn(state);
        state.open = openTurn();
        return;
      }
      if (type === 'event_msg' && payload.type === 'token_count' && state.open) {
        state.open.tokens = Number(payload.info?.last_token_usage?.total_tokens) || state.open.tokens;
        return;
      }
      if (type !== 'response_item') return;
      const itemType = String(payload.type || '');
      if (!/tool_call$|^function_call$|^local_shell_call$/.test(itemType)) return;
      if (!state.open) state.open = openTurn();
      observeCall(state.open, payload.name, payload.arguments ?? payload.action ?? payload.input);
    },
    // Claude session rows: one assistant message is one model turn.
    observeClaudeRow(key, row) {
      const state = entry(key);
      state.platform = 'claude';
      if (!row || row.type !== 'assistant' || !row.message) return;
      closeTurn(state);
      const content = Array.isArray(row.message.content) ? row.message.content : [];
      const open = openTurn();
      const usage = row.message.usage || {};
      open.tokens =
        Number(usage.input_tokens || 0) +
        Number(usage.cache_read_input_tokens || 0) +
        Number(usage.cache_creation_input_tokens || 0) +
        Number(usage.output_tokens || 0);
      for (const part of content) {
        if (!part || part.type !== 'tool_use') continue;
        observeCall(open, part.name, part.input);
      }
      state.open = open;
    },
    label(key, sessionId) {
      if (!byKey.has(key) || !sessionId) return;
      byKey.get(key).label = String(sessionId);
    },
    finalize() {
      for (const state of byKey.values()) closeTurn(state);
      const merged = new Map();
      for (const state of byKey.values()) {
        const row = merged.get(state.label) || {
          sessionId: state.label,
          platform: state.platform,
          turns: 0,
          pollTurns: 0,
          pollToolCalls: 0,
          correlatedPollTurns: 0,
          pollTokens: 0,
        };
        row.turns += state.turns;
        row.pollTurns += state.pollTurns;
        row.pollToolCalls += state.pollToolCalls;
        row.correlatedPollTurns += state.correlatedPollTurns;
        row.pollTokens += state.pollTokens;
        merged.set(state.label, row);
      }
      return [...merged.values()];
    },
  };
}

/**
 * The check. FAILS (verdict red) when a judgeable session spends more than
 * POLL_TURN_SHARE_LIMIT of its turns polling supervised agents AND does so at
 * least POLL_TURN_MIN_COUNT times. A share alone is not a defect: two polls in
 * twenty turns is 10% and is ordinary supervision, while the measured incident
 * was 859 polls costing 102M tokens.
 */
function analyzePollAmplification({
  sessions = [],
  limit = POLL_TURN_SHARE_LIMIT,
  minTurns = POLL_TURN_MIN_TURNS,
  minPollTurns = POLL_TURN_MIN_COUNT,
} = {}) {
  const rows = (Array.isArray(sessions) ? sessions : [])
    .map((session) => {
      const turns = Number(session && session.turns) || 0;
      const pollTurns = Number(session && session.pollTurns) || 0;
      const pollTokens = Number(session && session.pollTokens) || 0;
      const share = turns > 0 ? pollTurns / turns : 0;
      const judgeable = turns >= minTurns;
      const overShare = share > limit;
      const overCount = pollTurns >= minPollTurns;
      return {
        sessionId: String((session && session.sessionId) || 'unknown'),
        platform: String((session && session.platform) || 'unknown'),
        turns,
        pollTurns,
        pollToolCalls: Number(session && session.pollToolCalls) || 0,
        correlatedPollTurns: Number(session && session.correlatedPollTurns) || 0,
        pollTokens,
        pollShare: Number(share.toFixed(6)),
        judgeable,
        verdict: !judgeable ? 'unjudged' : overShare && overCount ? 'red' : 'green',
      };
    })
    .sort((a, b) => b.pollTurns - a.pollTurns);
  const breaches = rows.filter((row) => row.verdict === 'red');
  return {
    schema: 'agent-poll-amplification.v1',
    limit,
    minTurns,
    minPollTurns,
    sessions: rows,
    breaches,
    verdict: breaches.length ? 'red' : 'green',
    detail: breaches.length
      ? `${breaches.length} session(s) above ${(limit * 100).toFixed(0)}% poll-only turns: ${breaches
          .slice(0, 3)
          .map(
            (row) =>
              `${row.sessionId} ${(row.pollShare * 100).toFixed(1)}% (${row.pollTurns}/${row.turns}, ${row.pollTokens.toLocaleString('en-US')} tokens)`,
          )
          .join(', ')}`
      : 'no session exceeded the poll-only turn share limit',
  };
}

module.exports = {
  SUPERVISION_SCHEMA,
  SUPERVISION_REL_DIR,
  DEFAULT_AGENT_DEADLINE_MS,
  DEADLINE_GRACE_MS,
  CLAIM_STALE_MS,
  POLL_TOOL_PATTERN,
  AMBIGUOUS_POLL_TOOL_PATTERN,
  TRIVIAL_TOOL_PATTERN,
  POLL_TURN_SHARE_LIMIT,
  POLL_TURN_MIN_TURNS,
  POLL_TURN_MIN_COUNT,
  isPollTool,
  agentReceiptPath,
  claimPath,
  resumeSignalPath,
  supervisionTaskId,
  newSpawnId,
  validateAgentReceipt,
  registerSpawnedAgent,
  writeAgentReceipt,
  readAgentReceipt,
  supervisedAgentIds,
  scanTerminalAgents,
  resumeParentWithReceipt,
  sweepAgentSupervision,
  takePendingResumes,
  acknowledgeResume,
  createPollTurnAccumulator,
  analyzePollAmplification,
  resolveTasksDir,
};
