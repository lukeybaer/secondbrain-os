'use strict';

/**
 * spine-reconcile.js -- make the task list tell the truth.
 *
 * The Task store is meant to be the one record of work, but most open rows were
 * never work: passive intake records that nothing ever closes, helper tasks
 * whose receipts landed weeks ago, and tasks whose process is long gone.
 * This module classifies every open row and, only on apply, changes its STATUS
 * through the same atomic writer the ingress uses. It never deletes a record
 * and never rewrites anything except status, completion fields, the history
 * journal, and a `meta.reconciled` marker.
 *
 * Rules (first match wins):
 *   1. helper-finished   supervised helper whose receipt (or deadline) is
 *                        terminal. Closed by the existing supervision sweep,
 *                        never by a second writer here.
 *   2. passive-intake    queued ingest row with no approval and no explicit
 *                        request -> removed_non_actionable.
 *   3. orphan            running row whose process is gone (no live pid, or
 *                        silent for 72h+) -> failed, with the reason, so it can
 *                        be re-queued. Operational session and outcome records
 *                        belong to the archive reconciler and are reported, not
 *                        touched.
 * Everything else stays open and is counted as real work.
 */

const {
  hasOwnerAuthoredAmySignal,
  listSpineTasks,
  readTask,
  writeTask,
  resolveTasksDir,
  PASSIVE_CLOSED_STATUS,
  PASSIVE_CLOSED_REASON,
} = require('./spine-ingress.js');
const { scanTerminalAgents, sweepAgentSupervision } = require('./agent-supervision.js');

const OPEN_STATUSES = new Set(['queued', 'running', 'awaiting-review', 'requires-feedback']);
// Not terminal in the store, so they are listed separately and never hidden.
const WAITING_STATUSES = new Set(['failed', 'archive_pending']);
const ORPHAN_QUIET_HOURS = 24;
const ORPHAN_DEAD_HOURS = 72;

function isOperationalRecord(task) {
  const id = String((task && task.id) || '');
  return id.startsWith('spine-session-') || id.startsWith('spine-outcome-');
}

function isSupervisedHelper(task) {
  return !!(task && task.meta && task.meta.supervision && task.meta.supervision.spawnId);
}

function defaultIsPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not ours: alive.
    return !!(error && error.code === 'EPERM');
  }
}

function hoursSince(task, nowMs) {
  const ts = Date.parse(task.updatedAt || task.createdAt || '');
  return Number.isFinite(ts) ? (nowMs - ts) / 3600000 : Infinity;
}

function isPassiveIntake(task) {
  if (task.kind !== 'ingest' || task.status !== 'queued') return false;
  if (task.approved === true) return false;
  const meta = task.meta || {};
  if (meta.explicitRequest === true || meta.hasAmy === true) return false;
  // Legacy rows carry no meta. The intake template ends at the first blank line;
  // anything after it is the source text, and an owner-authored #Amy there is a
  // real request that must stay open.
  const sourceText = String(task.prompt || '').split('\n\n').slice(1).join('\n\n');
  return !hasOwnerAuthoredAmySignal(sourceText);
}

function classifyOrphan(task, { nowMs, isPidAlive }) {
  if (task.status !== 'running') return null;
  if (isOperationalRecord(task) || isSupervisedHelper(task)) return null;
  const quiet = hoursSince(task, nowMs);
  if (quiet < ORPHAN_QUIET_HOURS) return null;
  const alive = task.pid ? isPidAlive(task.pid) : false;
  // A live pid only protects a row that is still reporting. After 72h of
  // silence the pid has almost certainly been reused by something else.
  if (alive && quiet < ORPHAN_DEAD_HOURS) return null;
  const since = task.updatedAt || task.createdAt || 'unknown time';
  return `no live process: marked running with ${
    task.pid ? `pid ${task.pid} gone` : 'no process id'
  } and no update since ${since} (${Math.round(quiet / 24)} days). Re-queue to retry.`;
}

/**
 * Pure classification of the whole store. Nothing is written.
 */
function planReconcile(opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const isPidAlive = opts.isPidAlive || defaultIsPidAlive;
  const tasks = opts.tasks || listSpineTasks(opts);
  const dataDir = opts.dataDir;
  const helperIds = new Set();
  if (dataDir) {
    for (const change of scanTerminalAgents({ dataDir, nowMs }, opts)) {
      helperIds.add(change.task.id);
    }
  }
  const plan = {
    helperFinished: [],
    passiveIntake: [],
    orphans: [],
    ownedElsewhere: [],
    waiting: [],
    realOpen: [],
  };
  for (const task of tasks) {
    if (!task) continue;
    const open = OPEN_STATUSES.has(task.status);
    if (!open && !WAITING_STATUSES.has(task.status)) continue;
    if (WAITING_STATUSES.has(task.status)) {
      plan.waiting.push(task.id);
      continue;
    }
    if (helperIds.has(task.id)) {
      plan.helperFinished.push(task.id);
      continue;
    }
    if (isPassiveIntake(task)) {
      plan.passiveIntake.push({ id: task.id, reason: PASSIVE_CLOSED_REASON });
      continue;
    }
    const orphanReason = classifyOrphan(task, { nowMs, isPidAlive });
    if (orphanReason) {
      plan.orphans.push({ id: task.id, reason: orphanReason });
      continue;
    }
    if (isOperationalRecord(task)) {
      plan.ownedElsewhere.push(task.id);
      continue;
    }
    plan.realOpen.push(task.id);
  }
  const closing = plan.helperFinished.length + plan.passiveIntake.length + plan.orphans.length;
  const openBefore = tasks.filter((t) => t && OPEN_STATUSES.has(t.status)).length;
  plan.counts = {
    openBefore,
    helperFinished: plan.helperFinished.length,
    passiveIntake: plan.passiveIntake.length,
    orphansToFail: plan.orphans.length,
    ownedElsewhere: plan.ownedElsewhere.length,
    realOpen: plan.realOpen.length,
    waitingFailedOrArchive: plan.waiting.length,
    // Rows still not closed after the plan runs: operational session records
    // and genuinely open work. Failed/archive_pending rows are listed above.
    openAfter: openBefore - closing,
  };
  return plan;
}

function closeRow(id, status, reason, rule, opts) {
  const task = readTask(id, opts);
  if (!task) return { id, ok: false, reason: 'missing' };
  if (!OPEN_STATUSES.has(task.status)) return { id, ok: false, reason: `already ${task.status}` };
  const ts = new Date(opts.nowMs || Date.now()).toISOString();
  const next = {
    ...task,
    status,
    updatedAt: ts,
    completedAt: ts,
    ...(status === 'failed' ? { error: reason } : { resultSummary: reason }),
    history: [...(Array.isArray(task.history) ? task.history : []), { status, ts, note: reason }],
    meta: { ...(task.meta || {}), reconciled: { at: ts, rule, from: task.status } },
  };
  writeTask(next, opts);
  return { id, ok: true };
}

/**
 * Apply the plan. Helper tasks go through the supervision sweep (the one
 * existing closer); passive and orphan rows change status in place.
 */
function applyReconcile(opts = {}) {
  const plan = planReconcile(opts);
  const result = { closedPassive: 0, failedOrphans: 0, helper: null, errors: [] };
  if (opts.dataDir) {
    result.helper = sweepAgentSupervision(
      { dataDir: opts.dataDir, nowMs: opts.nowMs || Date.now() },
      opts,
    );
    for (const e of result.helper.errors || []) result.errors.push(e);
  }
  for (const row of plan.passiveIntake) {
    const r = closeRow(row.id, PASSIVE_CLOSED_STATUS, row.reason, 'passive-intake', opts);
    if (r.ok) result.closedPassive += 1;
    else result.errors.push(r);
  }
  for (const row of plan.orphans) {
    const r = closeRow(row.id, 'failed', row.reason, 'orphan-process-gone', opts);
    if (r.ok) result.failedOrphans += 1;
    else result.errors.push(r);
  }
  return { plan, result };
}

module.exports = {
  OPEN_STATUSES,
  ORPHAN_QUIET_HOURS,
  ORPHAN_DEAD_HOURS,
  isOperationalRecord,
  isPassiveIntake,
  planReconcile,
  applyReconcile,
  resolveTasksDir,
};
