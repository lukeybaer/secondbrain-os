'use strict';

// call-written-result.js
//
// D-4 (owner directive, 2026-10-18): an ask the owner or a
// declared caller made on a call reaches the owner in writing when it finishes, even when no
// callback was requested, and a stuck ask sends one "parked" line instead of
// going silent. Both respect quiet hours: nothing goes out 8 PM to 5 AM CT; the
// message waits for morning. Each Task gets at most one result line and one
// parked line, and a line settles only on a real owner-channel receipt.

const crypto = require('crypto');
const { listSpineTasks } = require('./spine-ingress');

// Awaiting review is not finished: it stays active and gets a parked line only
// when idle, so the owner never reads a review hold as a result.
const RESULT_STATUSES = new Set(['done', 'failed']);
const PARKED_STATUSES = new Set(['blocked', 'needs-feedback', 'needs_feedback', 'awaiting-input', 'awaiting_input']);
const ACTIVE_STATUSES = new Set(['queued', 'pending', 'running', 'in_progress', 'forwarded', 'awaiting-review', 'awaiting_review']);
const PARKED_IDLE_MS = 24 * 60 * 60 * 1000;
const QUIET_START_HOUR_CT = 20;
const QUIET_END_HOUR_CT = 5;
// Asks created before this path shipped are history (C-2 is the owner's open
// decision); they never flood owner-channel on the first tick.
const WRITTEN_RESULT_SINCE_MS = Date.parse('2026-10-18T17:00:00Z');

function centralHour(nowMs) {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(new Date(nowMs));
  return Number(hour);
}

function inQuietHours(nowMs = Date.now()) {
  const hour = centralHour(nowMs);
  return hour >= QUIET_START_HOUR_CT || hour < QUIET_END_HOUR_CT;
}

// An owner ask made on a call: a live-tool Task or a mined call directive,
// never the passive ingest record of the call itself, never self-test work.
function isInCallOwnerAsk(task) {
  if (!task || task.approved === false) return false;
  if (String(task.origin || '').toLowerCase() !== 'voice') return false;
  if (!String(task.meta?.callId || '').trim()) return false;
  if (task.meta?.explicitRequest !== true) return false;
  if (task.meta?.selfTest === true) return false;
  if (!(Date.parse(task.createdAt || '') >= WRITTEN_RESULT_SINCE_MS)) return false;
  return true;
}

// A result parked only because it was an explicit ask is the deliverable:
// it goes to the owner in writing and the Task closes itself (owner decision).
function closesOnDelivery(task) {
  return String(task?.status || '').toLowerCase() === 'awaiting-review' && task?.reviewReason === 'explicit-request';
}

function writtenLineDue(task, nowMs = Date.now()) {
  if (!isInCallOwnerAsk(task)) return null;
  // A requested callback owns delivery of the result (spoken or its own
  // written fallback); this path never doubles it.
  if (task.callback?.required === true) return null;
  const status = String(task.status || '').toLowerCase();
  const written = task.writtenResult || {};
  if (closesOnDelivery(task)) return !written.deliveredAt && String(task.resultSummary || '').trim() ? 'result' : null;
  if (RESULT_STATUSES.has(status)) {
    const summary = String(task.resultSummary || task.lastProgressNote || '').trim();
    if (!written.deliveredAt && (status === 'done' || status === 'failed' || summary)) return 'result';
    return null;
  }
  if (written.parkedNotifiedAt || written.deliveredAt) return null;
  if (PARKED_STATUSES.has(status)) return 'parked';
  const lastMs = Date.parse(task.lastProgressAt || task.updatedAt || task.createdAt || '');
  if (ACTIVE_STATUSES.has(status) && Number.isFinite(lastMs) && nowMs - lastMs >= PARKED_IDLE_MS) return 'parked';
  return null;
}

function clip(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function writtenLineText(task, kind) {
  const title = clip(task.title || task.prompt || 'your ask', 140);
  if (kind === 'parked') {
    const why = clip(task.blocker || task.lastProgressNote || '', 240);
    return [`Parked from your call: ${title}.`, why ? `Why: ${why}` : 'It has had no progress for a day.', 'Reply here to steer or cancel it.'].join(' ');
  }
  const status = closesOnDelivery(task) ? 'done' : String(task.status || '').replace(/_/g, ' ');
  const result = clip(task.resultSummary || task.lastProgressNote || '', 600);
  return [`From your call: ${title} is ${status}.`, result].filter(Boolean).join(' ');
}

function ownerChannelReceipt(sent) {
  if (sent && sent.suppressed && sent.reason === 'duplicate-within-window') return true;
  return Boolean(sent && sent.ok === true && sent.channel === 'owner-channel' && !sent.suppressed);
}

async function deliverCallWrittenResults(opts = {}) {
  const nowMs = typeof opts.nowMs === 'function' ? opts.nowMs() : opts.nowMs ?? Date.now();
  const tasksDir = opts.tasksDir || require('./voice-cloud-runtime').resolveTasksDir(opts);
  const tasks = listSpineTasks({ tasksDir });
  const due = tasks.map((task) => ({ task, kind: writtenLineDue(task, nowMs) })).filter((x) => x.kind);
  if (!due.length) return { checked: 0, results: [] };
  if (inQuietHours(nowMs)) {
    return { checked: due.length, held: 'quiet-hours', results: due.map((x) => ({ taskId: x.task.id, kind: x.kind, status: 'held_quiet_hours' })) };
  }
  const notify =
    opts.notifyWithFallback ||
    ((payload) => require('./notify-with-fallback').notifyWithFallback(payload));
  const patchTask = opts.patchTask || require('./voice-cloud-runtime').patchTask;
  const results = [];
  for (const { task, kind } of due) {
    if (opts.dryRun) {
      results.push({ taskId: task.id, kind, dryRun: true, text: writtenLineText(task, kind) });
      continue;
    }
    const text = writtenLineText(task, kind);
    let sent;
    try {
      sent = await notify({
        text,
        source: 'call-written-result',
        priority: 'normal',
        kind: 'voice-followup',
        dedupKey: `call-${kind}:${task.id}:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}`,
      });
    } catch (error) {
      sent = { ok: false, error: error.message || String(error) };
    }
    if (!ownerChannelReceipt(sent)) {
      results.push({ taskId: task.id, kind, status: 'not_delivered' });
      continue;
    }
    const ts = new Date(nowMs).toISOString();
    patchTask(
      task.id,
      (t) => {
        t.writtenResult = t.writtenResult || {};
        if (kind === 'result') t.writtenResult.deliveredAt = ts;
        else t.writtenResult.parkedNotifiedAt = ts;
        t.history = Array.isArray(t.history) ? t.history : [];
        t.history.push({ status: kind === 'result' ? 'written_result_delivered' : 'parked_line_delivered', ts, note: text.slice(0, 300) });
        if (kind === 'result' && closesOnDelivery(t)) {
          t.status = 'done';
          t.completedAt = ts;
          t.deliveredAt = ts;
          t.updatedAt = ts;
          t.history.push({ status: 'done', ts, note: 'result delivered to the owner in writing after the call' });
        }
        return t;
      },
      { tasksDir },
    );
    results.push({ taskId: task.id, kind, status: 'delivered' });
  }
  return { checked: due.length, results };
}

module.exports = {
  closesOnDelivery,
  deliverCallWrittenResults,
  inQuietHours,
  isInCallOwnerAsk,
  writtenLineDue,
  writtenLineText,
};
