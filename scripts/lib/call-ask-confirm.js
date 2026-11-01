'use strict';

// D-2 (owner decision): asks heard on a call from a declared owner
// phone with no spoken hashtag Amy are held until the owner confirms the one
// list on the owner channel. This is the only path that releases or cancels them.

const { listSpineTasks, readTask, writeTask } = require('./spine-ingress.js');

function isHeldCallAsk(task) {
  return Boolean(
    task &&
      task.origin === 'voice' &&
      task.status === 'requires-feedback' &&
      task.meta &&
      task.meta.awaitingOwnerConfirmation === true &&
      task.meta.callId,
  );
}

function confirmCallAsks({ action, callId, taskIds, ownerVerified, sourceRef } = {}, opts = {}) {
  if (ownerVerified !== true) {
    return { ok: false, status: 'owner_not_verified', reason: 'Only the owner can confirm or cancel call asks.' };
  }
  const verb = String(action || '').toLowerCase();
  if (!['confirm', 'cancel'].includes(verb)) {
    return { ok: false, status: 'bad_action', reason: 'Action must be confirm or cancel.' };
  }
  const ids = Array.isArray(taskIds) ? taskIds.map(String).filter(Boolean) : [];
  const call = String(callId || '').trim();
  if (!ids.length && !call) {
    return { ok: false, status: 'needs_target', reason: 'Name the call or the asks to act on.' };
  }
  const held = (ids.length ? ids.map((id) => readTask(id, opts)) : listSpineTasks(opts))
    .filter(isHeldCallAsk)
    .filter((task) => !call || task.meta.callId === call);
  if (!held.length) {
    return { ok: false, status: 'no_held_asks', reason: 'No held call asks match; nothing was changed.' };
  }
  const ts = typeof opts.nowIso === 'function' ? opts.nowIso() : new Date().toISOString();
  const changed = [];
  for (const task of held) {
    const status = verb === 'confirm' ? 'queued' : 'cancelled';
    const next = {
      ...task,
      approved: verb === 'confirm',
      status,
      updatedAt: ts,
      meta: { ...task.meta, awaitingOwnerConfirmation: false, ownerConfirmation: { action: verb, ts, sourceRef: sourceRef || null } },
      history: [...(task.history || []), { status, ts, note: `The owner ${verb === 'confirm' ? 'confirmed' : 'cancelled'} this call ask on the owner channel.` }],
    };
    if (verb === 'cancel') next.completedAt = ts;
    writeTask(next, opts);
    changed.push({ task_id: task.id, title: task.title, status });
  }
  return { ok: true, status: verb === 'confirm' ? 'confirmed' : 'cancelled', tasks: changed };
}

module.exports = { confirmCallAsks, isHeldCallAsk };
