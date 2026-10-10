'use strict';

const { isAllowedTelegramUpdate } = require('./telegram-intake-gate.js');
const { createSessionStore } = require('./session-store.js');

function normalizeTelegramSendReceipt(result) {
  if (Array.isArray(result?.results) && result.results.length) {
    return normalizeTelegramSendReceipt(result.results[result.results.length - 1]);
  }
  const messageId = result?.messageId ?? result?.message_id ?? result?.result?.message_id;
  return {
    ok: result?.ok !== false && messageId != null,
    messageId,
    uncertain: Boolean(result?.uncertain || result?.timedOut),
    reason: result?.description || result?.reason || null,
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForForeground(store, turnId, sleep) {
  for (;;) {
    const claim = store.claimForeground(turnId);
    if (claim.ok) return claim;
    if (!['head-of-line', 'foreground_already_claimed'].includes(claim.reason)) {
      throw new Error(`Telegram foreground admission failed: ${claim.reason}`);
    }
    await sleep(250);
  }
}

function sendOptions(turnId, sessionId, kind = 'reply') {
  if (!String(sessionId || '').startsWith('telegram:')) {
    throw new Error('Telegram reply is missing authenticated session provenance');
  }
  return {
    raw: true,
    kind,
    extras: {
      reactive: true,
      reactiveOrigin: 'telegram',
      reactiveSessionId: sessionId,
      dedup_key: `telegram-turn:${turnId}:${kind}`,
      turn_id: turnId,
    },
  };
}

async function recoverUncertainEgress({ store, sessionId, currentTurnId, send }) {
  store.recordChannelRecovered(sessionId, {
    channel: 'telegram',
    proven_at: new Date().toISOString(),
    proof_turn_id: currentTurnId,
  });
  for (const candidate of store.listRecoveryCandidates(sessionId)) {
    if (candidate.turn.turn_id === currentTurnId) continue;
    const claim = store.claimRecoverySend(candidate.turn.turn_id);
    if (!claim.ok) continue;
    try {
      const raw = await send(
        candidate.outcome.text,
        sendOptions(candidate.turn.turn_id, candidate.turn.session_id, 'recovery-reply'),
      );
      const receipt = normalizeTelegramSendReceipt(raw);
      if (receipt.ok) {
        store.recordEgressDelivered(candidate.turn.turn_id, {
          channel: 'telegram',
          message_id: receipt.messageId,
          delivered_at: new Date().toISOString(),
          recovery_key: claim.recovery_key,
        });
      } else {
        store.recordRecoveryFailure(candidate.turn.turn_id, {
          uncertain: receipt.uncertain,
          reason: receipt.reason || 'Telegram recovery send did not return a message id',
        });
      }
    } catch (err) {
      store.recordRecoveryFailure(candidate.turn.turn_id, {
        uncertain: Boolean(err?.name === 'AbortError' || err?.code === 'ETIMEDOUT'),
        reason: err?.message || String(err),
      });
    }
  }
}

async function deliverOutcome({ store, turn, outcome, send, sleep, startingAttempt = 1 }) {
  let attempt = startingAttempt;
  for (;;) {
    let rawReceipt;
    try {
      rawReceipt = await send(outcome.text, sendOptions(turn.turn_id, turn.session_id));
    } catch (err) {
      const uncertain = Boolean(err?.name === 'AbortError' || err?.code === 'ETIMEDOUT');
      store.recordEgressFailure(turn.turn_id, {
        uncertain,
        reason: err?.message || String(err),
        attempt,
      });
      if (uncertain) return;
      const delay = store.retryDelayMs(attempt);
      if (delay == null) return;
      await sleep(delay);
      attempt += 1;
      continue;
    }

    const receipt = normalizeTelegramSendReceipt(rawReceipt);
    if (receipt.ok) {
      store.recordEgressDelivered(turn.turn_id, {
        channel: 'telegram',
        message_id: receipt.messageId,
        delivered_at: new Date().toISOString(),
      });
      await recoverUncertainEgress({
        store,
        sessionId: turn.session_id,
        currentTurnId: turn.turn_id,
        send,
      });
      return;
    }
    store.recordEgressFailure(turn.turn_id, {
      uncertain: receipt.uncertain,
      reason: receipt.reason || 'Telegram send did not return a message id',
      attempt,
    });
    if (receipt.uncertain) return;
    const delay = store.retryDelayMs(attempt);
    if (delay == null) return;
    await sleep(delay);
    attempt += 1;
  }
}

async function recoverTelegramSessionTurns({
  dataDir,
  runSession,
  send,
  sleep = defaultSleep,
  store = createSessionStore({ dataDir }),
  retryTerminalFailure = null,
}) {
  const results = [];
  for (const pending of store.listPendingWork({ retryTerminalFailure })) {
    let outcome = pending.outcome;
    if (pending.redriven_from_attempt > 0) {
      store.recordEgressRedrive(pending.turn.turn_id, {
        reason: 'saved reply accepted by current egress policy',
        previous_attempt: pending.redriven_from_attempt,
      });
    }
    if (pending.kind === 'execution') {
      await waitForForeground(store, pending.turn.turn_id, sleep);
      try {
        outcome = await runSession({
          turn: pending.turn,
          history: store.listTurns(pending.turn.session_id),
          store,
        });
      } catch (err) {
        outcome = {
          state: 'blocked',
          text: 'I recovered your saved turn after a restart, but the Amy session runtime is temporarily unavailable.',
          internalError: err?.message || String(err),
        };
      }
      store.recordOutcome(pending.turn.turn_id, outcome);
    } else if (pending.last_attempt > 0) {
      const delay = store.retryDelayMs(pending.last_attempt);
      if (delay != null) await sleep(delay);
    }
    await deliverOutcome({
      store,
      turn: pending.turn,
      outcome,
      send,
      sleep,
      startingAttempt: Number(pending.last_attempt || 0) + 1,
    });
    results.push({ turn_id: pending.turn.turn_id, state: store.projectTurn(pending.turn.turn_id).state });
  }
  return results;
}

async function handleTelegramOwnerTurn({
  update,
  ownerChatId,
  ownerUserId,
  dataDir,
  attachments = [],
  replyToText = '',
  runSession,
  send,
  fastResponseMs = Number(process.env.AMY_TELEGRAM_FAST_RESPONSE_MS || 3_000),
  progressAckEnabled = process.env.AMY_TELEGRAM_PROGRESS_ACK_ENABLED === '1',
  approvalStore = null,
  resumeApproval = null,
  sleep = defaultSleep,
  fastSleep = defaultSleep,
  store = createSessionStore({ dataDir }),
}) {
  const gate = isAllowedTelegramUpdate(update, ownerChatId, ownerUserId);
  if (!gate.allowed) throw new Error(`Telegram owner session admission refused: ${gate.reason}`);
  const message = update.message || update.edited_message || update.callback_query?.message;
  const text = String(update.callback_query?.data || message.text || message.caption || '').trim();
  if (!text && attachments.length === 0) throw new Error('Telegram owner turn had no text or attachment');
  const sessionId = `telegram:${gate.chatId}`;
  const turn = store.receiveTurn({
    sessionId,
    channel: 'telegram',
    actor: {
      principal: 'ExampleCo',
      auth_level: 'owner_verified',
      evidence: ['telegram_user_allowlist', 'private_chat_allowlist'],
    },
    source: {
      update_id: update.update_id,
      message_id: message.message_id,
      reply_to_message_id: message.reply_to_message?.message_id || null,
      reply_to_text: replyToText || null,
    },
    text,
    attachments,
    receivedAt: message.date ? new Date(message.date * 1000).toISOString() : undefined,
  });

  if (turn.duplicate) {
    return { duplicate: true, turn, projection: store.projectTurn(turn.turn_id) };
  }
  let approvalResolution = null;
  if (/^(?:yes|no)(?:\s+[A-Za-z0-9_-]+)?$/i.test(text)) {
    if (approvalStore && typeof approvalStore.resolveOwnerReply === 'function') {
      approvalResolution = approvalStore.resolveOwnerReply({
        text,
        actor: turn.actor,
        message_id: message.message_id,
        reply_to_message_id: message.reply_to_message?.message_id || null,
      });
      if (
        approvalResolution?.ok &&
        typeof resumeApproval === 'function'
      ) {
        try {
          approvalResolution.resume = await resumeApproval(approvalResolution);
        } catch (error) {
          approvalResolution.resume = {
            ok: false,
            reason: error?.message || String(error),
          };
        }
      }
    }
    // Legacy same-Telegram-session decisions remain supported only when the
    // global cross-surface store did not resolve a request. One owner reply may
    // never approve two different holds.
    if (!approvalResolution?.ok && /^(?:yes|no)$/i.test(text)) {
      store.resolvePendingDecision({
        session_id: sessionId,
        text,
        reply_to_message_id: message.reply_to_message?.message_id || null,
      });
    }
  }

  await waitForForeground(store, turn.turn_id, sleep);

  // The immutable owner turn was fsync'd by receiveTurn above. Record the
  // model-attempt boundary too, before starting either subscription rung, so a
  // model outage cannot make an authorized turn look like it never arrived.
  store.recordProgress(turn.turn_id, {
    status: 'model_attempt_started',
    durable_before_model: true,
  });

  const runPromise = Promise.resolve()
    .then(() => runSession({
      turn,
      history: store.listTurns(sessionId),
      store,
      approvalResolution,
    }))
    .catch((err) => ({
      state: 'blocked',
      text: 'I saved your turn, but the Amy session runtime is temporarily unavailable. I did not discard it.',
      toolReceipts: [],
      taskIds: [],
      internalError: err?.message || String(err),
    }));
  const first = await Promise.race([
    runPromise.then((outcome) => ({ outcome })),
    fastSleep(Math.max(0, Number(fastResponseMs))).then(() => ({ timedOut: true })),
  ]);
  if (first.timedOut && progressAckEnabled) {
    try {
      const rawProgressReceipt = await send(
        'I’m working on it.',
        sendOptions(turn.turn_id, turn.session_id, 'progress'),
      );
      const progressReceipt = normalizeTelegramSendReceipt(rawProgressReceipt);
      if (progressReceipt.ok) {
        store.recordProgressEgress(turn.turn_id, {
          channel: 'telegram',
          message_id: progressReceipt.messageId,
          delivered_at: new Date().toISOString(),
        });
      }
    } catch {
      // Progress delivery is best effort. The durable final outbox remains authoritative.
    }
  }
  const outcome = first.outcome || (await runPromise);
  store.recordOutcome(turn.turn_id, outcome);
  await deliverOutcome({ store, turn, outcome, send, sleep });
  return {
    turn,
    outcome,
    approvalResolution,
    projection: store.projectTurn(turn.turn_id),
  };
}

module.exports = {
  deliverOutcome,
  handleTelegramOwnerTurn,
  normalizeTelegramSendReceipt,
  recoverUncertainEgress,
  recoverTelegramSessionTurns,
  waitForForeground,
};
