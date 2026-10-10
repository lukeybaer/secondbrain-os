'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TERMINAL_OUTCOMES = new Set(['answered', 'acting', 'awaiting_input', 'blocked', 'failed']);

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function validateEvent(event) {
  if (
    !event ||
    typeof event !== 'object' ||
    !String(event.event_id || '').startsWith('evt_') ||
    !event.session_id ||
    !event.type ||
    !event.ts ||
    !event.writer_id
  ) {
    throw new Error('session-store event schema violation: ledger contains a non-authoritative row');
  }
  return event;
}

function appendAndSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(value)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function normalizeSessionId(value) {
  const sessionId = String(value || '').trim();
  if (!sessionId) throw new Error('sessionId is required');
  return sessionId;
}

function defaultIsProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return true;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function createSessionStore({
  dataDir,
  now = () => new Date().toISOString(),
  isProcessAlive = defaultIsProcessAlive,
} = {}) {
  if (!dataDir) throw new Error('createSessionStore requires dataDir');
  const sessionsRoot = path.join(dataDir, 'amy-sessions');
  const writerId = `${process.pid}:${crypto.randomUUID()}`;
  const openSessions = new Set();
  const turnIndex = new Map();

  function sessionDir(sessionId) {
    return path.join(sessionsRoot, stableHash(normalizeSessionId(sessionId)));
  }

  function ledgerPath(sessionId) {
    return path.join(sessionDir(sessionId), 'events.jsonl');
  }

  function readEvents(sessionId) {
    return readJsonl(ledgerPath(sessionId)).map(validateEvent);
  }

  function withSessionLock(sessionId, fn) {
    const id = normalizeSessionId(sessionId);
    if (openSessions.has(id)) throw new Error(`session-store single writer re-entry for ${id}`);
    openSessions.add(id);
    const lockFile = path.join(sessionDir(id), 'writer.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    let fd = null;
    try {
      for (let attempt = 0; attempt < 2 && fd == null; attempt += 1) {
        try {
          fd = fs.openSync(lockFile, 'wx', 0o600);
          fs.writeSync(fd, `${writerId}\n`, null, 'utf8');
          fs.fsyncSync(fd);
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
          let removedStaleLock = false;
          try {
            if (Date.now() - fs.statSync(lockFile).mtimeMs > 30_000) {
              fs.unlinkSync(lockFile);
              removedStaleLock = true;
            }
          } catch {
            // Another writer released it between the checks.
            removedStaleLock = true;
          }
          if (removedStaleLock && attempt === 0) continue;
          const busy = new Error(`session-store writer busy for ${id}`);
          busy.code = 'SESSION_WRITER_BUSY';
          throw busy;
        }
      }
      if (fd == null) throw new Error(`session-store could not acquire writer lock for ${id}`);
      return fn(id);
    } finally {
      if (fd != null) {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(lockFile);
        } catch {
          // Already released.
        }
      }
      openSessions.delete(id);
    }
  }

  function appendUnlocked(sessionId, type, payload) {
    const event = {
      event_id: `evt_${crypto.randomUUID()}`,
      session_id: sessionId,
      type,
      ts: now(),
      writer_id: writerId,
      ...payload,
    };
    appendAndSync(ledgerPath(sessionId), event);
    return event;
  }

  function append(sessionId, type, payload) {
    return withSessionLock(sessionId, (id) => appendUnlocked(id, type, payload));
  }

  function findTurnBySource(sessionId, source = {}) {
    const updateId = source.update_id == null ? null : String(source.update_id);
    const messageId = source.message_id == null ? null : String(source.message_id);
    return readEvents(sessionId)
      .filter((event) => event.type === 'turn_received')
      .map((event) => event.turn)
      .find(
        (turn) =>
          (updateId && String(turn.source.update_id) === updateId) ||
          (messageId && String(turn.source.message_id) === messageId),
      );
  }

  function receiveTurn(input) {
    const sessionId = normalizeSessionId(input.sessionId);
    if (input.turnId != null) {
      throw new Error('session-store owns turn_id generation; caller-supplied turnId is forbidden');
    }
    if (input.actor?.auth_level !== 'owner_verified') {
      throw new Error('session-store refuses a turn without owner_verified actor evidence');
    }
    return withSessionLock(sessionId, (id) => {
      const duplicate = findTurnBySource(id, input.source);
      if (duplicate) {
        turnIndex.set(duplicate.turn_id, id);
        return { ...duplicate, duplicate: true };
      }
      const sequence = readEvents(id).filter((event) => event.type === 'turn_received').length + 1;
      const turn = Object.freeze({
        turn_id: `turn_${crypto.randomUUID()}`,
        session_id: id,
        channel: input.channel,
        actor: input.actor,
        source: input.source,
        text: String(input.text || ''),
        attachments: Array.isArray(input.attachments) ? input.attachments : [],
        received_at: input.receivedAt || now(),
        sequence,
      });
      appendUnlocked(id, 'turn_received', { turn });
      turnIndex.set(turn.turn_id, id);
      return turn;
    });
  }

  function turnSessionId(turnId) {
    if (turnIndex.has(turnId)) return turnIndex.get(turnId);
    if (!fs.existsSync(sessionsRoot)) return null;
    for (const dir of fs.readdirSync(sessionsRoot)) {
      const file = path.join(sessionsRoot, dir, 'events.jsonl');
      for (const event of readJsonl(file)) {
        if (event.type === 'turn_received' && event.turn.turn_id === turnId) {
          turnIndex.set(turnId, event.session_id);
          return event.session_id;
        }
      }
    }
    return null;
  }

  function requireTurn(turnId) {
    const sessionId = turnSessionId(turnId);
    if (!sessionId) throw new Error(`turn not found: ${turnId}`);
    return sessionId;
  }

  function getTurn(turnId) {
    const sessionId = requireTurn(turnId);
    return readEvents(sessionId).find(
      (event) => event.type === 'turn_received' && event.turn.turn_id === turnId,
    ).turn;
  }

  function recordToolEvent(turnId, type, payload = {}) {
    if (!['tool_requested', 'tool_succeeded', 'tool_failed', 'tool_denied'].includes(type)) {
      throw new Error(`invalid tool event type: ${type}`);
    }
    const sessionId = requireTurn(turnId);
    return append(sessionId, type, { turn_id: turnId, ...payload });
  }

  function recordOutcome(turnId, outcome) {
    const sessionId = requireTurn(turnId);
    const state = String(outcome?.state || 'failed');
    if (!TERMINAL_OUTCOMES.has(state)) throw new Error(`invalid turn outcome state: ${state}`);
    const existing = readEvents(sessionId).find(
      (event) => event.type === 'outcome_ready' && event.turn_id === turnId,
    );
    if (existing) return existing;
    const event = append(sessionId, 'outcome_ready', {
      turn_id: turnId,
      outcome: {
        state,
        text: String(outcome.text || ''),
        tool_receipts: outcome.toolReceipts || outcome.tool_receipts || [],
        task_ids: outcome.taskIds || outcome.task_ids || [],
      },
    });
    append(sessionId, 'egress_queued', {
      turn_id: turnId,
      outbox_key: `telegram:${turnId}`,
      attempt: 0,
    });
    return event;
  }

  function recordEgressDelivered(turnId, receipt) {
    const sessionId = requireTurn(turnId);
    if (!receipt || receipt.channel !== 'telegram' || receipt.message_id == null) {
      throw new Error('Telegram egress receipt requires channel and message_id');
    }
    const delivered = append(sessionId, 'egress_delivered', { turn_id: turnId, receipt });
    const events = readEvents(sessionId);
    const resolved = new Set(
      events.filter((event) => event.type === 'decision_resolved').map((event) => event.decision_id),
    );
    const alreadyBound = new Set(
      events.filter((event) => event.type === 'decision_prompt_bound').map((event) => event.decision_id),
    );
    for (const opened of events.filter(
      (event) =>
        event.type === 'decision_opened' &&
        event.decision.source_turn_id === turnId &&
        !resolved.has(event.decision_id) &&
        !alreadyBound.has(event.decision_id),
    )) {
      append(sessionId, 'decision_prompt_bound', {
        turn_id: turnId,
        decision_id: opened.decision_id,
        telegram_prompt_message_id: receipt.message_id,
      });
    }
    return delivered;
  }

  function recordEgressFailure(turnId, failure) {
    const sessionId = requireTurn(turnId);
    return append(sessionId, failure?.uncertain ? 'egress_uncertain' : 'egress_failed', {
      turn_id: turnId,
      failure: {
        reason: String(failure?.reason || 'telegram delivery failed'),
        attempt: Number(failure?.attempt || 1),
      },
    });
  }

  function recordEgressRedrive(turnId, redrive) {
    const sessionId = requireTurn(turnId);
    return append(sessionId, 'egress_redrive_started', {
      turn_id: turnId,
      redrive: {
        reason: String(redrive?.reason || 'terminal egress policy changed'),
        previous_attempt: Number(redrive?.previous_attempt || 0),
      },
    });
  }

  function claimForeground(turnId, { leaseTtlMs = 10 * 60 * 1000, nowMs = Date.now() } = {}) {
    const sessionId = requireTurn(turnId);
    return withSessionLock(sessionId, (id) => {
      const events = readEvents(id);
      const turns = events
        .filter((event) => event.type === 'turn_received')
        .map((event) => event.turn)
        .sort((a, b) => a.sequence - b.sequence);
      const target = turns.find((turn) => turn.turn_id === turnId);
      if (!target) return { ok: false, reason: 'turn_not_found' };
      const completed = (candidate) =>
        events.some(
          (event) =>
            event.turn_id === candidate.turn_id &&
            ['outcome_ready', 'child_task_detached'].includes(event.type),
        );
      const priorOpen = turns.find(
        (candidate) => candidate.sequence < target.sequence && !completed(candidate),
      );
      if (priorOpen) {
        return { ok: false, reason: 'head-of-line', blocking_turn_id: priorOpen.turn_id };
      }
      const claims = events.filter(
        (event) => event.type === 'foreground_claimed' && event.turn_id === turnId,
      );
      const lastClaim = claims.at(-1);
      const lastClaimPid = Number(String(lastClaim?.writer_id || '').split(':', 1)[0]);
      const lastClaimWriterAlive = lastClaim ? isProcessAlive(lastClaimPid) : false;
      if (
        lastClaim &&
        Date.parse(lastClaim.expires_at) > nowMs &&
        !completed(target) &&
        lastClaimWriterAlive
      ) {
        return { ok: false, reason: 'foreground_already_claimed', lease_token: lastClaim.lease_token };
      }
      const leaseToken = crypto.randomUUID();
      appendUnlocked(id, 'foreground_claimed', {
        turn_id: turnId,
        lease_token: leaseToken,
        expires_at: new Date(nowMs + leaseTtlMs).toISOString(),
        ...(lastClaim && !lastClaimWriterAlive && !completed(target)
          ? {
              supersedes_lease_token: lastClaim.lease_token,
              reclaim_reason: 'local_writer_process_absent',
            }
          : {}),
      });
      return { ok: true, lease_token: leaseToken };
    });
  }

  function recordChildTaskDetached(turnId, child) {
    const sessionId = requireTurn(turnId);
    if (!child?.task_id) throw new Error('recordChildTaskDetached requires task_id');
    return append(sessionId, 'child_task_detached', { turn_id: turnId, child });
  }

  function recordProgress(turnId, progress) {
    const sessionId = requireTurn(turnId);
    return append(sessionId, 'progress', { turn_id: turnId, progress });
  }

  function recordProgressEgress(turnId, receipt) {
    const sessionId = requireTurn(turnId);
    if (!receipt || receipt.channel !== 'telegram' || receipt.message_id == null) {
      throw new Error('Telegram progress receipt requires channel and message_id');
    }
    return append(sessionId, 'progress_egress_delivered', { turn_id: turnId, receipt });
  }

  function createPendingDecision(input) {
    const sessionId = normalizeSessionId(input.session_id);
    const decision = {
      decision_id: input.decision_id || `decision_${crypto.randomUUID()}`,
      session_id: sessionId,
      source_turn_id: input.source_turn_id || null,
      source_task_id: input.source_task_id || null,
      telegram_prompt_message_id: input.telegram_prompt_message_id ?? null,
      kind: input.kind,
      subject_ref: input.subject_ref || null,
      allowed_responses: (input.allowed_responses || ['yes', 'no']).map((value) =>
        String(value).trim().toLowerCase(),
      ),
    };
    append(sessionId, 'decision_opened', { decision_id: decision.decision_id, decision });
    return decision;
  }

  function resolvePendingDecision({ session_id, text, reply_to_message_id = null }) {
    const sessionId = normalizeSessionId(session_id);
    const answer = String(text || '').trim().toLowerCase();
    const events = readEvents(sessionId);
    const resolved = new Set(
      events.filter((event) => event.type === 'decision_resolved').map((event) => event.decision_id),
    );
    let candidates = events
      .filter((event) => event.type === 'decision_opened' && !resolved.has(event.decision_id))
      .map((event) => {
        const binding = [...events]
          .reverse()
          .find(
            (candidate) =>
              candidate.type === 'decision_prompt_bound' &&
              candidate.decision_id === event.decision_id,
          );
        return binding
          ? { ...event.decision, telegram_prompt_message_id: binding.telegram_prompt_message_id }
          : event.decision;
      })
      .filter((decision) => decision.allowed_responses.includes(answer));
    if (reply_to_message_id != null) {
      candidates = candidates.filter(
        (decision) =>
          String(decision.telegram_prompt_message_id) === String(reply_to_message_id),
      );
    }
    if (candidates.length === 0) return { ok: false, reason: 'no_compatible_pending_decision' };
    if (candidates.length > 1) return { ok: false, reason: 'ambiguous_pending_decision' };
    const decision = candidates[0];
    append(sessionId, 'decision_resolved', {
      decision_id: decision.decision_id,
      answer,
      subject_ref: decision.subject_ref,
      kind: decision.kind,
    });
    return { ok: true, decision_id: decision.decision_id, answer, decision };
  }

  function findResolvedDecision(decisionId) {
    const wanted = String(decisionId || '');
    if (!wanted) return null;
    for (const sessionId of listSessionIds()) {
      const events = readEvents(sessionId);
      const opened = events.find(
        (event) => event.type === 'decision_opened' && event.decision_id === wanted,
      )?.decision;
      const resolved = [...events]
        .reverse()
        .find((event) => event.type === 'decision_resolved' && event.decision_id === wanted);
      if (opened && resolved) return { ...opened, ...resolved, decision_id: wanted };
    }
    return null;
  }

  function retryDelayMs(attempt) {
    return [2_000, 8_000, 30_000][Number(attempt) - 1] ?? null;
  }

  function recordChannelRecovered(sessionId, recovery) {
    return append(sessionId, 'channel_recovered', { recovery: recovery || {} });
  }

  function claimRecoverySend(turnId) {
    const sessionId = requireTurn(turnId);
    return withSessionLock(sessionId, (id) => {
      const events = readEvents(id);
      const uncertainIndex = events.findLastIndex(
        (event) => event.type === 'egress_uncertain' && event.turn_id === turnId,
      );
      if (uncertainIndex < 0) return { ok: false, reason: 'turn_not_uncertain' };
      if (
        events.some(
          (event, index) =>
            index > uncertainIndex && event.type === 'egress_recovery_claimed' && event.turn_id === turnId,
        )
      ) {
        return { ok: false, reason: 'recovery_already_claimed' };
      }
      const recovered = events.some(
        (event, index) => index > uncertainIndex && event.type === 'channel_recovered',
      );
      if (!recovered) return { ok: false, reason: 'channel_not_recovered' };
      const event = appendUnlocked(id, 'egress_recovery_claimed', {
        turn_id: turnId,
        recovery_key: `telegram-recovery:${turnId}`,
      });
      return { ok: true, recovery_key: event.recovery_key };
    });
  }

  function recordRecoveryFailure(turnId, failure) {
    const sessionId = requireTurn(turnId);
    return append(sessionId, 'egress_recovery_failed', {
      turn_id: turnId,
      failure: {
        reason: String(failure?.reason || 'Telegram recovery delivery failed'),
        uncertain: Boolean(failure?.uncertain),
      },
    });
  }

  function listRecoveryCandidates(sessionId) {
    const id = normalizeSessionId(sessionId);
    const events = readEvents(id);
    const turns = events.filter((event) => event.type === 'turn_received').map((event) => event.turn);
    return turns.flatMap((turn) => {
      const rows = events.filter((event) => event.turn_id === turn.turn_id);
      const uncertainAt = rows.findLastIndex((event) => event.type === 'egress_uncertain');
      if (uncertainAt < 0) return [];
      if (
        rows.some(
          (event, index) =>
            index > uncertainAt &&
            ['egress_delivered', 'egress_recovery_claimed', 'egress_recovery_failed'].includes(
              event.type,
            ),
        )
      ) {
        return [];
      }
      const outcome = [...rows].reverse().find((event) => event.type === 'outcome_ready')?.outcome;
      return outcome ? [{ turn, outcome }] : [];
    });
  }

  function projectTurn(turnId) {
    const sessionId = requireTurn(turnId);
    const events = readEvents(sessionId).filter(
      (event) => event.turn_id === turnId || event.turn?.turn_id === turnId,
    );
    const turn = events.find((event) => event.type === 'turn_received')?.turn;
    const outcome = [...events].reverse().find((event) => event.type === 'outcome_ready')?.outcome;
    const egress = [...events].reverse().find((event) => event.type === 'egress_delivered')?.receipt;
    const uncertain = events.some((event) => event.type === 'egress_uncertain');
    const failed = events.some((event) => event.type === 'egress_failed');
    return {
      turn,
      state: egress && outcome ? outcome.state : uncertain ? 'delivery_uncertain' : failed ? 'delivery_failed' : outcome ? 'awaiting_egress' : 'received',
      outcome: outcome || null,
      egress: egress || null,
      events,
    };
  }

  function listTurns(sessionId) {
    return readEvents(sessionId)
      .filter((event) => event.type === 'turn_received')
      .map((event) => event.turn);
  }

  function listSessionIds() {
    if (!fs.existsSync(sessionsRoot)) return [];
    return fs.readdirSync(sessionsRoot).flatMap((dir) => {
      const events = readJsonl(path.join(sessionsRoot, dir, 'events.jsonl'));
      return events[0]?.session_id ? [events[0].session_id] : [];
    });
  }

  function listPendingWork({ retryTerminalFailure = null } = {}) {
    return listSessionIds().flatMap((sessionId) => {
      const events = readEvents(sessionId);
      return events
        .filter((event) => event.type === 'turn_received')
        .map((event) => event.turn)
        .flatMap((turn) => {
          const rows = events.filter((event) => event.turn_id === turn.turn_id);
          if (rows.some((event) => event.type === 'egress_delivered')) return [];
          const outcome = [...rows].reverse().find((event) => event.type === 'outcome_ready')?.outcome;
          if (!outcome) return [{ kind: 'execution', turn, outcome: null }];
          if (rows.some((event) => event.type === 'egress_uncertain')) return [];
          const redriveAt = rows.findLastIndex((event) => event.type === 'egress_redrive_started');
          const failures = rows.filter(
            (event, index) => index > redriveAt && event.type === 'egress_failed',
          );
          const attempts = failures
            .map((event) => Number(event.failure?.attempt || 0));
          const lastAttempt = attempts.length ? Math.max(...attempts) : 0;
          if (lastAttempt >= 4) {
            const lastFailure = failures.at(-1)?.failure || null;
            let retry = false;
            try {
              retry = Boolean(
                typeof retryTerminalFailure === 'function' &&
                  retryTerminalFailure({ turn, outcome, last_failure: lastFailure }),
              );
            } catch {
              retry = false;
            }
            if (!retry) return [];
            return [{
              kind: 'egress',
              turn,
              outcome,
              last_attempt: 0,
              redriven_from_attempt: lastAttempt,
            }];
          }
          return [{ kind: 'egress', turn, outcome, last_attempt: lastAttempt }];
        });
    });
  }

  return {
    claimForeground,
    claimRecoverySend,
    createPendingDecision,
    findResolvedDecision,
    getTurn,
    ledgerPath,
    listTurns,
    listRecoveryCandidates,
    listPendingWork,
    listSessionIds,
    projectTurn,
    readEvents,
    receiveTurn,
    recordChannelRecovered,
    recordChildTaskDetached,
    recordEgressDelivered,
    recordEgressFailure,
    recordEgressRedrive,
    recordOutcome,
    recordProgress,
    recordProgressEgress,
    recordRecoveryFailure,
    recordToolEvent,
    resolvePendingDecision,
    retryDelayMs,
  };
}

module.exports = { createSessionStore, stableHash };
