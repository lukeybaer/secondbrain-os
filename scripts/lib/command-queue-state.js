'use strict';

// Command queue state machine (state machine audit finding #7, the owner,
// 2026-11-03). The /commands routes in ec2-server.js used to write seven
// states plus any string sent to /status, let /abort overwrite anything, let
// /complete overwrite `aborting` and deliver (including the callback dial), and
// never expire `in_progress`, so a desktop crash left a command stuck forever.
//
// This module is the pure transition logic: it mutates the command record it is
// given and returns an outcome. ec2-server.js owns the HTTP, the lock around the
// queue file, the persist, and the delivery; none of that lives here.
//
// Review fixes (Codex, 2026-11-03): the server re-reads the queue file under the
// lock before every transition and acknowledges only after an atomic write; the
// spine worker adopts through POST /commands/:id/adopt (pending -> adopted)
// instead of rewriting the file; a delivery is claimed durably (deliveryStatus
// 'delivering') before any contact, and a claim orphaned by a restart is parked
// as 'delivery_unknown', never re-sent or redialed.

const { defineStateMachine } = require('./ledger-state-machine');
const { forwardTransition } = require('./command-queue-forward');

const MINUTE = 60 * 1000;

// How long an in-flight command may go without a sign of life (claim, forward,
// heartbeat) before the queue stops trusting its worker.
//
// Chosen from the budgets the queue already grants:
//  - resolveDeadlineMs() in dispatch-delivery.js caps any command's run at
//    DEFAULT_CEILING_MS = 60 min ("never times out never means never dies").
//  - process-dispatches lands a change after the run, and its test gate
//    (AUTOLAND_TEST_TIMEOUT_MS) allows 10 more minutes with no heartbeat.
//  - The desktop worker sends no heartbeat at all, so its only sign of life is
//    the claim; a healthy long job must not be taken for a crash.
// 60 + 10 + 5 min of slack = 75 min. Shorter would re-run live work; longer only
// delays telling the owner about a real crash. A test pins this above the ceiling.
const IN_FLIGHT_TTL_MS = 75 * MINUTE;
// One attempt. A worker that went silent may have done part or all of the work
// before it died, and nothing proves otherwise, so the queue never re-runs a
// command on its own (same rule as the X and recruiter ledgers in this audit):
// it stops waiting and tells the owner instead.
const MAX_ATTEMPTS = 1;
// An abort request needs no long budget: nothing is being protected, the
// executor either saw the flag on a heartbeat or it never will.
const ABORT_GRACE_MS = 10 * MINUTE;

// Result delivery, tracked apart from the command status. 'delivering' is the
// durable claim written before any contact; 'retry' is a text send chat
// answered as not sent (safe to send again); 'delivery_unknown' is a claim whose
// outcome nobody saw (crash or thrown error) and is never re-sent; 'failed' is a
// callback the provider refused after the text fallback went out.
const DELIVERY_STATES = new Set([
  'pending', 'delivering', 'delivered', 'retry', 'failed', 'delivery_unknown', 'suppressed',
]);
// A definite chat refusal is retried by the sweep, text only, this many
// times in all, at least this far apart.
const MAX_DELIVERY_ATTEMPTS = 6;
const DELIVERY_RETRY_GAP_MS = 5 * MINUTE;
// A command silent this long has nobody waiting on its answer: it still goes
// stale (never re-run), but its notice is suppressed instead of texting the owner
// about a request from days or months ago.
const STALE_NOTICE_MAX_AGE_MS = 72 * 60 * MINUTE;
// An adopted command whose Task file is missing (the worker died between the
// adopt reply and the Task write) may be re-confirmed to the worker, which then
// creates the Task under the same id, while its last yes is younger than this
// and the answers fit the budget. After that the sweep parks it as stale with a
// "never started" notice; it is never left adopted without a Task.
const ADOPT_RECOVERY_TTL_MS = IN_FLIGHT_TTL_MS;
const MAX_ADOPT_ANSWERS = 5;

const commandMachine = defineStateMachine({
  name: 'command-queue',
  transitions: {
    '': ['pending', 'spine_owned'],
    // done/failed straight from pending: a command answered inline on a live
    // call (resolveInlineCommand) or completed by a worker that never claimed.
    // aborted straight from pending: nobody holds it, so there is nothing to wait for.
    // adopted: the EC2 spine worker turned it into a Task (POST /commands/:id/adopt).
    pending: ['in_progress', 'forwarded', 'adopted', 'done', 'failed', 'aborted'],
    // The spine Task owns execution of a spine_owned command; it is never
    // claimed or forwarded, only heartbeated, completed or aborted.
    spine_owned: ['running', 'done', 'failed', 'aborting', 'aborted'],
    in_progress: ['running', 'done', 'failed', 'aborting', 'pending', 'stale'],
    forwarded: ['running', 'done', 'failed', 'aborting', 'pending', 'stale'],
    running: ['done', 'failed', 'aborting', 'pending', 'stale'],
    // The spine Task owns execution of an adopted command; an abort must reach
    // that Task (applyAbort), not only this row. stale: its Task was never
    // created and recovery expired (sweepCommands).
    adopted: ['done', 'failed', 'aborting', 'aborted', 'stale'],
    aborting: ['aborted'],
  },
  terminal: ['done', 'failed', 'aborted', 'stale'],
  aliases: {
    queued: 'pending',
    'in-progress': 'in_progress',
    inprogress: 'in_progress',
    claimed: 'in_progress',
    processing: 'running',
    working: 'running',
    complete: 'done',
    completed: 'done',
    error: 'failed',
    cancelled: 'aborted',
    canceled: 'aborted',
  },
  inFlight: {
    in_progress: { ttlMs: IN_FLIGHT_TTL_MS, maxAttempts: MAX_ATTEMPTS },
    forwarded: { ttlMs: IN_FLIGHT_TTL_MS, maxAttempts: MAX_ATTEMPTS },
    running: { ttlMs: IN_FLIGHT_TTL_MS, maxAttempts: MAX_ATTEMPTS },
    aborting: { ttlMs: ABORT_GRACE_MS },
  },
});

// /status is a liveness heartbeat. It may report that work is running; it may
// not finish, fail, abort, or re-queue a command (that is /complete, /abort and
// the expiry sweep), so a typo or a stale client cannot end a command.
const HEARTBEAT_STATES = new Set(['running', 'in_progress']);

function toMs(value) {
  const t = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(t) ? t : NaN;
}

// Latest sign the worker holding the command is alive.
function lastSignOfLifeMs(cmd) {
  const marks = [toMs(cmd && cmd.updatedAt), toMs(cmd && cmd.lastProgressAt)].filter(Number.isFinite);
  return marks.length ? Math.max(...marks) : NaN;
}

// A record whose status is not a declared state (written by an older build) is
// treated as "in flight, owner unknown" by the routes, so a deploy never turns
// its completion into a refusal that loses the result. The sweep never touches
// it: re-queuing something that may have finished could run it twice.
function effectiveState(cmd) {
  const raw = cmd && cmd.status;
  if (raw == null || raw === '') return 'pending';
  const state = commandMachine.normalize(raw);
  return commandMachine.isKnown(state) ? state : 'running';
}

// Load-time: an old spelling becomes its canonical state; the original is kept.
function canonicalizeLoaded(cmd) {
  const raw = cmd && cmd.status;
  if (raw == null || raw === '') return false;
  const state = commandMachine.normalize(raw);
  if (state === raw || !commandMachine.isKnown(state)) return false;
  cmd.legacyStatus = raw;
  cmd.status = state;
  return true;
}

function noteAttemptStarted(cmd, nowIso) {
  cmd.attempts = (Number.isFinite(cmd.attempts) ? cmd.attempts : 0) + 1;
  cmd.attemptStartedAt = nowIso;
}

function refuse(code, error, cmd, extra = {}) {
  return { ok: false, code, error, status: cmd.status, ...extra };
}

/** pending -> in_progress. 409 for anything not claimable. */
function claim(cmd, nowIso) {
  if (!commandMachine.canTransition(cmd.status, 'in_progress')) {
    return { ok: false, code: 409, status: cmd.status };
  }
  cmd.status = 'in_progress';
  cmd.updatedAt = nowIso;
  cmd.claimedAt = nowIso;
  noteAttemptStarted(cmd, nowIso);
  return { ok: true, code: 200, status: 'in_progress' };
}

/** pending -> forwarded through the existing atomic gate, counted as an attempt. */
function forward(cmd, nowIso) {
  const result = forwardTransition(cmd, nowIso);
  if (result.ok) noteAttemptStarted(cmd, nowIso);
  return result;
}

// The latest yes the backend gave the spine worker for this adoption.
function lastAdoptAnswerMs(cmd) {
  const marks = [toMs(cmd && cmd.adoptedAt), toMs(cmd && cmd.adoptConfirmedAt)].filter(Number.isFinite);
  return marks.length ? Math.max(...marks) : NaN;
}

/**
 * POST /commands/:id/adopt. pending -> adopted for the spine worker, which
 * creates the Task only after this succeeds. A repeat for the same Task means
 * the worker has no Task file yet (lost reply, or a crash before the write):
 * it is acknowledged, and recorded so the sweep and /abort wait for the Task
 * from this yes, while the recovery window and answer budget last. Every yes
 * returns `changed`: the caller persists it before answering.
 */
function adopt(cmd, taskId, nowIso) {
  const id = String(taskId || '').trim();
  if (!id) return refuse(400, 'task_id_required', cmd);
  if (cmd.status === 'adopted' && cmd.adoptedTaskId === id) {
    const answers = Number.isFinite(cmd.adoptAnswers) ? cmd.adoptAnswers : 1;
    const lastMs = lastAdoptAnswerMs(cmd);
    if (!Number.isFinite(lastMs) || toMs(nowIso) - lastMs > ADOPT_RECOVERY_TTL_MS) {
      return refuse(409, 'adopt_recovery_expired', cmd);
    }
    if (answers >= MAX_ADOPT_ANSWERS) return refuse(409, 'adopt_recovery_spent', cmd);
    cmd.adoptAnswers = answers + 1;
    cmd.adoptConfirmedAt = nowIso;
    cmd.updatedAt = nowIso;
    return { ok: true, code: 200, noop: true, changed: true, status: 'adopted', adoptedTaskId: id };
  }
  if (cmd.spineTaskId || cmd.repliedInline || cmd.adoptedTaskId) return refuse(409, 'not_adoptable', cmd);
  if (!commandMachine.canTransition(cmd.status, 'adopted')) return refuse(409, 'not_adoptable', cmd);
  cmd.status = 'adopted';
  cmd.adoptedTaskId = id;
  cmd.adoptedAt = nowIso;
  cmd.adoptAnswers = 1;
  cmd.updatedAt = nowIso;
  noteAttemptStarted(cmd, nowIso);
  return { ok: true, code: 200, changed: true, status: 'adopted', adoptedTaskId: id };
}

/**
 * POST /commands/:id/status. Only declared heartbeat states, only through legal
 * moves; a terminal command refuses; an aborting command keeps its status and
 * the reply carries `abort: true` so the executor stops.
 */
function applyStatus(cmd, body, nowIso) {
  const b = body && typeof body === 'object' ? body : {};
  const from = effectiveState(cmd);
  if (commandMachine.isTerminal(from)) return refuse(409, 'command_terminal', cmd);

  let requested = '';
  if (b.status !== undefined && b.status !== null && b.status !== '') {
    requested = typeof b.status === 'string' ? commandMachine.normalize(b.status) : '';
    if (!requested || !commandMachine.isKnown(requested)) {
      return refuse(400, 'unknown_status', cmd, { requested: String(b.status).slice(0, 40) });
    }
    if (!HEARTBEAT_STATES.has(requested)) {
      return refuse(409, 'status_not_settable', cmd, {
        requested,
        hint: 'use /complete to finish, /abort to cancel',
      });
    }
  }

  const aborting = from === 'aborting';
  if (!aborting && requested && requested !== from && !commandMachine.canTransition(from, requested)) {
    return refuse(409, 'illegal_transition', cmd, { from, to: requested });
  }

  if (!aborting && requested && requested !== from) cmd.status = requested;
  if (typeof b.note === 'string') cmd.progressNote = b.note.slice(0, 200);
  cmd.lastProgressAt = nowIso;
  cmd.updatedAt = nowIso;
  return { ok: true, code: 200, status: cmd.status, abort: aborting };
}

/**
 * POST /commands/:id/abort. A pending command nobody holds becomes `aborted` at
 * once; one a worker holds becomes `aborting` until the worker reports back or
 * the sweep gives up waiting. A finished command is refused, never overwritten.
 * An adopted command is a spine Task: `cancelAdoptedTask(cmd)` stops that Task
 * and answers { kind: 'cancelled' | 'interrupting' | 'finished' | 'busy' |
 * 'starting' | 'refused' | 'missing', status }. Only a stopped, stopping or
 * never-created Task moves the row; anything else is refused with a plain answer.
 */
function applyAbort(cmd, nowIso, { cancelAdoptedTask = null } = {}) {
  const from = effectiveState(cmd);
  if (from === 'aborting' || from === 'aborted') {
    return { ok: true, code: 200, noop: true, status: from };
  }
  if (commandMachine.isTerminal(from)) {
    return refuse(409, 'already_finished', cmd, {
      message: 'Command already ' + from + '; it cannot be aborted.',
    });
  }
  if (from === 'adopted') {
    const task = (cancelAdoptedTask && cancelAdoptedTask(cmd)) || { kind: 'refused' };
    const taskStatus = task.status || 'unknown';
    if (task.kind === 'busy' || task.kind === 'starting') {
      return refuse(503, 'task_busy', cmd, { message: 'The cloud task is busy for a moment; try the abort again.' });
    }
    if (task.kind === 'finished') {
      return refuse(409, 'already_finished', cmd, {
        taskStatus,
        message: 'That task already ran on the cloud worker (' + taskStatus + '); it cannot be aborted.',
      });
    }
    // 'missing': the worker never created the Task and will not, since it re-asks
    // /adopt first and an aborted row refuses it.
    if (!['cancelled', 'interrupting', 'missing'].includes(task.kind)) {
      return refuse(409, 'not_cancellable', cmd, {
        taskStatus,
        message: 'That task is with the cloud worker (' + taskStatus + ') and cannot be stopped from here.',
      });
    }
    const settled = task.kind === 'interrupting' ? 'aborting' : 'aborted';
    cmd.status = commandMachine.assertTransition(from, settled);
    if (settled === 'aborted') cmd.deliveryStatus = 'suppressed';
    cmd.updatedAt = nowIso;
    cmd.abortRequestedAt = nowIso;
    return { ok: true, code: 200, status: settled };
  }
  const to = commandMachine.assertTransition(from, from === 'pending' ? 'aborted' : 'aborting');
  cmd.status = to;
  cmd.updatedAt = nowIso;
  cmd.abortRequestedAt = nowIso;
  return { ok: true, code: 200, status: to };
}

/**
 * POST /commands/:id/complete. Returns what the route must do next:
 *  - deliver / redeliver : first result accepted (or delivery retried)
 *  - already_delivered / delivering : idempotent retry, nothing to do
 *  - aborted : the command was aborted; the result is recorded for audit only
 *  - stale : the queue already told the owner it did not run; result recorded only
 * `aborted` and `stale` never deliver and never dial.
 */
function applyComplete(cmd, body, nowIso) {
  const b = body && typeof body === 'object' ? body : {};
  const from = effectiveState(cmd);

  if (cmd.deliveryStatus === 'delivered') {
    return { ok: true, code: 200, action: 'already_delivered', status: cmd.status };
  }

  if (from === 'aborting' || from === 'aborted' || from === 'stale') {
    const reason = from === 'stale' ? 'stale' : 'aborted';
    if (!cmd.lateResult) {
      cmd.lateResult = {
        at: nowIso,
        reason,
        success: !!b.success,
        result: String(b.result || '').slice(0, 4000),
        ...(b.oneLiner ? { oneLiner: String(b.oneLiner).slice(0, 500) } : {}),
        ...(b.prUrl ? { prUrl: String(b.prUrl).slice(0, 500) } : {}),
        ...(b.branch ? { branch: String(b.branch).slice(0, 200) } : {}),
      };
    }
    if (from === 'aborting') {
      cmd.status = commandMachine.assertTransition(from, 'aborted');
      cmd.deliveryStatus = 'suppressed';
    }
    cmd.updatedAt = nowIso;
    return { ok: true, code: 200, action: reason, changed: true, status: cmd.status };
  }

  if (from === 'done' || from === 'failed') {
    if (cmd.deliveryStatus === 'delivering') {
      return { ok: true, code: 200, action: 'delivering', status: cmd.status };
    }
    // First result wins. A retry re-attempts only a delivery that never made
    // contact (pending) or that chat refused (retry). A claimed, unknown,
    // refused-callback or suppressed delivery is never sent again.
    const ds = cmd.deliveryStatus || 'pending';
    if (ds !== 'pending' && ds !== 'retry') {
      return { ok: true, code: 200, action: 'settled', deliveryStatus: ds, status: cmd.status };
    }
    return { ok: true, code: 200, action: 'redeliver', changed: false, status: cmd.status };
  }

  cmd.status = commandMachine.assertTransition(from, b.success ? 'done' : 'failed');
  cmd.success = !!b.success;
  cmd.result = b.result || '';
  // Structured result for channel-correct delivery (voice speaks oneLiner,
  // Chat gets oneLiner + PR link).
  if (b.oneLiner) cmd.oneLiner = b.oneLiner;
  if (b.prUrl) cmd.prUrl = b.prUrl;
  if (b.branch) cmd.branch = b.branch;
  cmd.updatedAt = nowIso;
  return { ok: true, code: 200, action: 'deliver', changed: true, status: cmd.status };
}

/**
 * The whole /complete flow, with the side effects injected so it can be tested
 * without a server. The state decision and its persist run under `lock`; the
 * slow work (spine update, inline voice provider answer, delivery) runs after it, and runs
 * ONLY for a result that was accepted. An aborted or stale command returns
 * before `deliver` is ever called, so nothing is sent, spoken or dialed.
 * A persist failure rejects, so the route never acknowledges an unsaved result.
 * `resolveInline(cmd)` returns true when the live call already heard the
 * answer; `deliver` then records it as delivered instead of sending again.
 *
 * @returns {Promise<{code:number, json:object}>}
 */
async function processComplete(cmd, body, deps) {
  const { lock, persist, now = () => new Date().toISOString(), completeSession, resolveInline, deliver } = deps;
  const outcome = await lock(() => {
    const decided = applyComplete(cmd, body, now());
    if (decided.changed) persist();
    return decided;
  });
  if (outcome.action === 'already_delivered') return { code: 200, json: { ok: true, alreadyDelivered: true } };
  if (outcome.action === 'delivering') return { code: 200, json: { ok: true, delivering: true } };
  if (outcome.action === 'settled') {
    return { code: 200, json: { ok: true, delivered: false, deliveryStatus: outcome.deliveryStatus } };
  }
  if (outcome.action === 'aborted' || outcome.action === 'stale') {
    return {
      code: 200,
      json: { ok: true, delivered: false, [outcome.action]: true, status: outcome.status },
    };
  }
  if (outcome.action === 'deliver' && cmd.spineTaskId) completeSession(cmd.spineTaskId, cmd);
  const repliedInline = resolveInline(cmd) === true;
  await deliver(cmd, repliedInline ? { repliedInline: true } : {});
  return { code: 200, json: { ok: true } };
}

/**
 * The durable delivery claim, run under the queue lock before any contact.
 * Returns { contact: true } only when this caller now owns the one attempt; the
 * caller persists when `changed`. Text-only notices (the stale notice and sweep
 * retries) may also claim a `retry` delivery while attempts remain.
 */
function claimDelivery(cmd, { telegramOnly = false, repliedInline = false, nowIso } = {}) {
  const ds = cmd.deliveryStatus || 'pending';
  if (repliedInline || cmd.repliedInline) {
    if (ds === 'delivered' && cmd.repliedInline) return { contact: false, changed: false, deliveryStatus: ds };
    cmd.repliedInline = true;
    cmd.deliveryStatus = 'delivered';
    cmd.deliveredAt = nowIso;
    return { contact: false, changed: true, deliveryStatus: 'delivered' };
  }
  const state = effectiveState(cmd);
  const deliverable = state === 'done' || state === 'failed' || (state === 'stale' && telegramOnly);
  if (!deliverable) return { contact: false, changed: false, deliveryStatus: ds, refused: 'state_' + state };
  const attempts = Number.isFinite(cmd.deliveryAttempts) ? cmd.deliveryAttempts : 0;
  const open = ds === 'pending' || (ds === 'retry' && attempts < MAX_DELIVERY_ATTEMPTS);
  if (!open) return { contact: false, changed: false, deliveryStatus: ds };
  cmd.deliveryStatus = 'delivering';
  cmd.deliveryAttempts = attempts + 1;
  cmd.deliveryAttemptAt = nowIso;
  cmd.updatedAt = nowIso;
  return { contact: true, changed: true, deliveryStatus: 'delivering' };
}

/** Records what the one attempt did. An unknown word is taken as 'delivery_unknown'. */
function settleDelivery(cmd, outcome, nowIso) {
  const to = ['delivered', 'retry', 'failed', 'delivery_unknown'].includes(outcome) ? outcome : 'delivery_unknown';
  cmd.deliveryStatus = to;
  if (to === 'delivered') cmd.deliveredAt = nowIso;
  else cmd.deliverySettledAt = nowIso;
  cmd.updatedAt = nowIso;
  return to;
}

/**
 * A 'delivering' claim nobody in this process holds was orphaned by a restart
 * (or its final write failed). Its contact may have happened, so it is parked as
 * 'delivery_unknown' where the owner can see it; it is never re-sent or redialed.
 */
function parkOrphanedDeliveries(commands, isDeliveryInFlight, nowIso) {
  const parked = [];
  for (const cmd of commands) {
    if (!cmd || cmd.deliveryStatus !== 'delivering') continue;
    if (isDeliveryInFlight && isDeliveryInFlight(cmd.id)) continue;
    cmd.deliveryStatus = 'delivery_unknown';
    cmd.deliveryParkedAt = nowIso;
    cmd.updatedAt = nowIso;
    parked.push(cmd);
  }
  return parked;
}

/**
 * Text notices the sweep still owes the owner: a stale command whose notice was never
 * claimed (a crash right after it went stale), or a stale notice or result text
 * Chat refused. Never a 'pending' result (older rows hold results that were
 * never meant to be re-sent), never an unknown outcome.
 */
function dueTextDeliveries(commands, nowMs) {
  const due = [];
  for (const cmd of commands) {
    if (!cmd) continue;
    const ds = cmd.deliveryStatus || 'pending';
    const state = effectiveState(cmd);
    if (state === 'stale' && ds === 'pending') {
      due.push(cmd);
      continue;
    }
    const attempts = Number.isFinite(cmd.deliveryAttempts) ? cmd.deliveryAttempts : 0;
    if (ds !== 'retry' || attempts >= MAX_DELIVERY_ATTEMPTS) continue;
    if (state !== 'stale' && state !== 'done' && state !== 'failed') continue;
    const last = toMs(cmd.deliveryAttemptAt);
    if (Number.isFinite(last) && nowMs - last < DELIVERY_RETRY_GAP_MS) continue;
    due.push(cmd);
  }
  return due;
}

/**
 * One expiry pass: sweep under `lock`, persist once, then (outside the lock) send
 * every text notice still owed: new stale notices, stale notices a crash or a
 * Chat refusal left unsent, and refused result texts. Each goes through
 * `deliver(cmd, { telegramOnly: true })`: text only, never a voice line or dial;
 * deliver claims it durably first, so a notice is never sent twice. `commands`
 * may be a function so the list is read after the lock refreshed it.
 */
async function runSweep(commands, deps) {
  const { lock, persist, deliver, isDeliveryInFlight = () => false, adoptedTaskExists, nowMs = Date.now() } = deps;
  const list = () => (typeof commands === 'function' ? commands() : commands);
  const swept = await lock(() => {
    const moved = sweepCommands(list(), nowMs, { adoptedTaskExists });
    moved.parked = parkOrphanedDeliveries(list(), isDeliveryInFlight, new Date(nowMs).toISOString());
    if (moved.requeued.length || moved.stale.length || moved.aborted.length || moved.parked.length) persist();
    return moved;
  });
  swept.notified = [];
  for (const cmd of dueTextDeliveries(list(), nowMs)) {
    await deliver(cmd, { telegramOnly: true });
    swept.notified.push(cmd);
  }
  return swept;
}

function staleNotice(cmd) {
  const what = String(cmd.prompt || 'a task').replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    oneLiner:
      'That task never reported back: "' + what + '". I stopped waiting after over an hour and did not re-run it, in case part of it already happened.',
    result: 'never reported back: stopped waiting, not re-run',
  };
}

// An adopted command whose Task was never written: nothing ran.
function neverStartedNotice(cmd) {
  const what = String(cmd.prompt || 'a task').replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    oneLiner:
      'That task never started: "' + what + '". The cloud worker took it but never created its task, so nothing ran. Ask again if you still want it.',
    result: 'never started: the cloud worker took it but never created its task',
  };
}

/**
 * Expiry sweep over the whole queue. Mutates the commands it moves and returns
 * them by outcome; the caller persists once and notifies for `stale`.
 *  - in-flight past the TTL with attempts left : back to `pending` (re-forward;
 *    unreachable while MAX_ATTEMPTS is 1)
 *  - in-flight past the TTL, budget spent       : `stale` (The owner is told)
 *  - aborting past its grace                    : `aborted`
 *  - adopted, no Task file, recovery expired    : `stale`, never started (The owner
 *    is told). `adoptedTaskExists(cmd)` answers true, false, or null when it
 *    cannot tell; only a definite false parks the row.
 * A command a spine Task owns is never re-queued; the Task has its own lifecycle.
 */
function sweepCommands(commands, nowMs = Date.now(), { adoptedTaskExists = null } = {}) {
  const out = { requeued: [], stale: [], aborted: [] };
  const nowIso = new Date(nowMs).toISOString();
  for (const cmd of commands) {
    if (!cmd) continue;
    const state = commandMachine.normalize(cmd.status);
    if (state === 'adopted') {
      if (!adoptedTaskExists) continue;
      const answeredMs = lastAdoptAnswerMs(cmd);
      if (Number.isFinite(answeredMs) && nowMs - answeredMs <= ADOPT_RECOVERY_TTL_MS) continue;
      if (adoptedTaskExists(cmd) !== false) continue;
      cmd.status = commandMachine.assertTransition(state, 'stale');
      cmd.staleAt = nowIso;
      cmd.staleReason = 'task_never_created';
      cmd.success = false;
      const notice = neverStartedNotice(cmd);
      cmd.result = notice.result;
      cmd.oneLiner = notice.oneLiner;
      if (!Number.isFinite(answeredMs) || nowMs - answeredMs > STALE_NOTICE_MAX_AGE_MS) {
        cmd.deliveryStatus = 'suppressed';
        cmd.staleNoticeSuppressed = 'silent over 72 hours';
      }
      cmd.updatedAt = nowIso;
      out.stale.push(cmd);
      continue;
    }
    if (!commandMachine.isInFlight(state)) continue;
    if (state !== 'aborting' && cmd.spineTaskId) continue;
    const lastLifeMs = lastSignOfLifeMs(cmd);
    if (!commandMachine.isExpired(state, lastLifeMs, nowMs)) continue;

    if (state === 'aborting') {
      cmd.status = commandMachine.assertTransition(state, 'aborted');
      cmd.deliveryStatus = 'suppressed';
      cmd.updatedAt = nowIso;
      out.aborted.push(cmd);
      continue;
    }

    // A record written before attempts were counted has one attempt in flight.
    const attempts = Number.isFinite(cmd.attempts) ? cmd.attempts : 1;
    if (commandMachine.attemptsExhausted(state, attempts)) {
      cmd.status = commandMachine.assertTransition(state, 'stale');
      cmd.attempts = attempts;
      cmd.staleAt = nowIso;
      cmd.success = false;
      const notice = staleNotice(cmd);
      cmd.result = notice.result;
      cmd.oneLiner = notice.oneLiner;
      if (!Number.isFinite(lastLifeMs) || nowMs - lastLifeMs > STALE_NOTICE_MAX_AGE_MS) {
        cmd.deliveryStatus = 'suppressed';
        cmd.staleNoticeSuppressed = 'silent over 72 hours';
      }
      cmd.updatedAt = nowIso;
      out.stale.push(cmd);
      continue;
    }

    cmd.status = commandMachine.assertTransition(state, 'pending');
    cmd.attempts = attempts;
    cmd.requeuedAt = nowIso;
    cmd.requeuedFrom = state;
    cmd.requeueCount = (Number.isFinite(cmd.requeueCount) ? cmd.requeueCount : 0) + 1;
    cmd.progressNote = '';
    cmd.updatedAt = nowIso;
    out.requeued.push(cmd);
  }
  return out;
}

module.exports = {
  ABORT_GRACE_MS,
  ADOPT_RECOVERY_TTL_MS,
  DELIVERY_RETRY_GAP_MS,
  DELIVERY_STATES,
  HEARTBEAT_STATES,
  IN_FLIGHT_TTL_MS,
  MAX_ADOPT_ANSWERS,
  MAX_ATTEMPTS,
  MAX_DELIVERY_ATTEMPTS,
  STALE_NOTICE_MAX_AGE_MS,
  adopt,
  applyAbort,
  applyComplete,
  applyStatus,
  canonicalizeLoaded,
  claim,
  claimDelivery,
  commandMachine,
  dueTextDeliveries,
  effectiveState,
  forward,
  lastAdoptAnswerMs,
  lastSignOfLifeMs,
  noteAttemptStarted,
  parkOrphanedDeliveries,
  processComplete,
  runSweep,
  settleDelivery,
  staleNotice,
  sweepCommands,
};
