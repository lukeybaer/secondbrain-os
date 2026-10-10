'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'amy.owner-approval.v1';
const EVENT_SCHEMA = 'amy.owner-approval.event.v1';
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_RESUME_LEASE_MS = 30 * 1000;
const ORIGIN_LOCATOR_KEYS = [
  'thread_id',
  'conversation_id',
  'session_id',
  'call_id',
  'gmail_thread_id',
  'task_id',
  'turn_id',
  'message_id',
];

function appendAndSync(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file);
    if (current.length > 0 && current[current.length - 1] !== 0x0a) {
      const lastNewline = current.lastIndexOf(0x0a);
      fs.truncateSync(file, lastNewline < 0 ? 0 : lastNewline + 1);
    }
  }
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(row)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const completeFinalLine = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      rows.push(JSON.parse(lines[index]));
    } catch (error) {
      if (index === lines.length - 1 && !completeFinalLine) break;
      throw error;
    }
  }
  return rows;
}

function normalizeOrigin(input = {}) {
  const surface = String(input.surface || '')
    .trim()
    .toLowerCase();
  if (!surface) throw new Error('owner approval origin.surface is required');
  const origin = { surface };
  for (const key of [
    'conversation_id',
    'thread_id',
    'session_id',
    'turn_id',
    'call_id',
    'message_id',
    'task_id',
    'gmail_thread_id',
  ]) {
    const value = input[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      origin[key] = String(value).trim().slice(0, 500);
    }
  }
  if (Object.keys(origin).length === 1) {
    throw new Error('owner approval origin locator is required');
  }
  return origin;
}

function originLocator(origin = {}) {
  for (const key of ORIGIN_LOCATOR_KEYS) {
    if (origin[key] !== undefined && origin[key] !== null && String(origin[key]).trim()) {
      return String(origin[key]).trim();
    }
  }
  return '';
}

function originConsumer(origin = {}) {
  return `${String(origin.surface || 'prompt').toLowerCase()}:${originLocator(origin) || 'unknown'}`;
}

function parseOwnerReply(text) {
  const match = String(text || '')
    .trim()
    .match(/^(YES|NO)(?:\s+([A-Za-z0-9_-]+))?$/i);
  if (!match) return null;
  return {
    answer: match[1].toUpperCase() === 'YES' ? 'approved' : 'denied',
    approval_id: match[2] || null,
  };
}

function createOwnerApprovalStore({
  dataDir,
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
  ledgerPath,
} = {}) {
  if (!dataDir && !ledgerPath)
    throw new Error('createOwnerApprovalStore requires dataDir or ledgerPath');
  const file = ledgerPath || path.join(dataDir, 'agent', 'owner-approvals.jsonl');
  const lockFile = `${file}.lock`;
  const writerId = `${process.pid}:${crypto.randomUUID()}`;
  let inProcessLocked = false;

  function events() {
    return readJsonl(file);
  }

  function withLock(fn) {
    if (inProcessLocked) throw new Error('owner approval store re-entry');
    inProcessLocked = true;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let fd = null;
    try {
      for (let attempt = 0; attempt < 2 && fd == null; attempt += 1) {
        try {
          fd = fs.openSync(lockFile, 'wx', 0o600);
          fs.writeSync(fd, `${writerId}\n`, null, 'utf8');
          fs.fsyncSync(fd);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          let stale = false;
          try {
            stale = nowMs() - fs.statSync(lockFile).mtimeMs > 30_000;
            if (stale) fs.unlinkSync(lockFile);
          } catch {
            stale = true;
          }
          if (stale && attempt === 0) continue;
          const busy = new Error('owner approval store writer busy');
          busy.code = 'OWNER_APPROVAL_WRITER_BUSY';
          throw busy;
        }
      }
      return fn();
    } finally {
      if (fd != null) {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(lockFile);
        } catch {
          // Another recovery owner already removed a stale lease.
        }
      }
      inProcessLocked = false;
    }
  }

  function append(type, approvalId, payload = {}) {
    const row = {
      schema: EVENT_SCHEMA,
      event_id: `approval_event_${crypto.randomUUID()}`,
      approval_id: approvalId,
      type,
      ts: now(),
      writer_id: writerId,
      ...payload,
    };
    appendAndSync(file, row);
    return row;
  }

  function project(approvalId, allEvents = events()) {
    const rows = allEvents.filter((row) => row.approval_id === approvalId);
    const opened = rows.find((row) => row.type === 'approval_opened')?.approval;
    if (!opened) return null;
    const resolution =
      [...rows].reverse().find((row) => row.type === 'approval_resolved')?.resolution || null;
    const prompt = [...rows].reverse().find((row) => row.type === 'telegram_prompt_bound');
    const delivered = [...rows].reverse().find((row) => row.type === 'resume_delivered');
    const lastClaim = [...rows].reverse().find((row) => row.type === 'resume_claimed');
    const lastFailure = [...rows].reverse().find((row) => row.type === 'resume_failed');
    const expired = !resolution && Date.parse(opened.expires_at) <= nowMs();
    let resumeStatus = 'none';
    if (resolution) resumeStatus = 'queued';
    if (lastClaim && Date.parse(lastClaim.expires_at) > nowMs()) resumeStatus = 'claimed';
    if (lastFailure && (!lastClaim || rows.indexOf(lastFailure) > rows.indexOf(lastClaim)))
      resumeStatus = 'queued';
    if (delivered) resumeStatus = 'delivered';
    return {
      ...opened,
      telegram_prompt_message_id: prompt?.telegram_prompt_message_id ?? null,
      status: expired ? 'expired' : resolution?.answer || 'pending',
      resolution,
      resume_status: resumeStatus,
      resume_receipt: delivered?.receipt || null,
      events: rows,
    };
  }

  function open(input = {}) {
    return withLock(() => {
      const requestType = String(input.request_type || '').trim();
      const description = String(input.description || '').trim();
      if (!requestType) throw new Error('owner approval request_type is required');
      if (!description) throw new Error('owner approval description is required');
      const createdAt = now();
      const ttlMs = Math.max(1, Number(input.ttl_ms || DEFAULT_TTL_MS));
      const approval = {
        schema: SCHEMA,
        approval_id: input.approval_id || `approval_${crypto.randomUUID()}`,
        request_type: requestType,
        description: description.slice(0, 1000),
        data_category:
          String(input.data_category || '')
            .trim()
            .slice(0, 120) || null,
        origin: normalizeOrigin(input.origin),
        reply_surface: 'telegram',
        status: 'pending',
        created_at: createdAt,
        expires_at: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
      };
      const existing = project(approval.approval_id);
      if (existing) {
        const sameRequest =
          existing.request_type === approval.request_type &&
          existing.description === approval.description &&
          JSON.stringify(existing.origin) === JSON.stringify(approval.origin);
        if (!sameRequest) throw new Error(`owner approval id collision: ${approval.approval_id}`);
        return existing;
      }
      append('approval_opened', approval.approval_id, { approval });
      return approval;
    });
  }

  function bindTelegramPrompt(approvalId, messageId) {
    return withLock(() => {
      const approval = project(String(approvalId));
      if (!approval) return { ok: false, reason: 'approval_not_found' };
      if (messageId === undefined || messageId === null) {
        return { ok: false, reason: 'telegram_message_id_required' };
      }
      const prior = approval.events.find(
        (row) =>
          row.type === 'telegram_prompt_bound' &&
          String(row.telegram_prompt_message_id) === String(messageId),
      );
      if (prior) return { ok: true, duplicate: true, approval };
      append('telegram_prompt_bound', approval.approval_id, {
        telegram_prompt_message_id: messageId,
      });
      return { ok: true, approval: project(approval.approval_id) };
    });
  }

  function resolveOwnerReply({ text, actor, message_id = null, reply_to_message_id = null } = {}) {
    if (
      actor?.auth_level !== 'owner_verified' ||
      !['ExampleCo', 'PRIVATE_NAME'].includes(String(actor?.principal || '').toLowerCase())
    ) {
      return { ok: false, reason: 'owner_auth_required' };
    }
    const parsed = parseOwnerReply(text);
    if (!parsed) return { ok: false, reason: 'not_an_approval_reply' };
    return withLock(() => {
      const allEvents = events();
      const approvalIds = [
        ...new Set(
          allEvents.filter((row) => row.type === 'approval_opened').map((row) => row.approval_id),
        ),
      ];
      const projections = approvalIds.map((id) => project(id, allEvents)).filter(Boolean);

      if (parsed.approval_id) {
        const explicit = projections.find(
          (approval) => approval.approval_id === parsed.approval_id,
        );
        if (!explicit) return { ok: false, reason: 'approval_not_found' };
        if (explicit.status === 'expired')
          return { ok: false, reason: 'approval_expired', approval: explicit };
        if (['approved', 'denied'].includes(explicit.status)) {
          return {
            ok: true,
            duplicate: true,
            answer: explicit.status,
            approval: explicit,
            resolution: explicit.resolution,
          };
        }
      }

      let candidates = projections.filter((approval) => approval.status === 'pending');
      if (parsed.approval_id) {
        candidates = candidates.filter((approval) => approval.approval_id === parsed.approval_id);
      } else if (reply_to_message_id !== null && reply_to_message_id !== undefined) {
        candidates = candidates.filter(
          (approval) => String(approval.telegram_prompt_message_id) === String(reply_to_message_id),
        );
      } else {
        candidates = candidates.filter((approval) => approval.telegram_prompt_message_id !== null);
      }
      if (candidates.length === 0) return { ok: false, reason: 'no_pending_approval' };
      if (candidates.length > 1) return { ok: false, reason: 'ambiguous_pending_approval' };

      const approval = candidates[0];
      const resolution = {
        answer: parsed.answer,
        resolved_at: now(),
        owner: String(actor.principal).toLowerCase(),
        telegram_message_id: message_id,
        reply_to_message_id,
      };
      append('approval_resolved', approval.approval_id, { resolution });
      append('resume_queued', approval.approval_id, {
        origin: approval.origin,
        answer: parsed.answer,
      });
      return {
        ok: true,
        answer: parsed.answer,
        approval: project(approval.approval_id),
        resolution,
      };
    });
  }

  function claimResume(
    approvalId,
    { consumer = 'unknown', lease_ms = DEFAULT_RESUME_LEASE_MS } = {},
  ) {
    return withLock(() => {
      const approval = project(String(approvalId));
      if (!approval) return { ok: false, reason: 'approval_not_found' };
      if (!approval.resolution) return { ok: false, reason: 'approval_not_resolved' };
      if (approval.resume_status === 'delivered')
        return { ok: false, reason: 'resume_already_delivered' };
      if (approval.resume_status === 'claimed')
        return { ok: false, reason: 'resume_already_claimed' };
      const leaseToken = crypto.randomUUID();
      append('resume_claimed', approval.approval_id, {
        lease_token: leaseToken,
        consumer: String(consumer || 'unknown').slice(0, 300),
        expires_at: new Date(
          nowMs() + Math.max(1, Number(lease_ms || DEFAULT_RESUME_LEASE_MS)),
        ).toISOString(),
      });
      return {
        ok: true,
        lease_token: leaseToken,
        approval: project(approval.approval_id),
        resolution: approval.resolution,
      };
    });
  }

  function requireActiveLease(approval, leaseToken) {
    const claim = [...approval.events].reverse().find((row) => row.type === 'resume_claimed');
    if (!claim || claim.lease_token !== leaseToken || Date.parse(claim.expires_at) <= nowMs()) {
      return { ok: false, reason: 'resume_lease_invalid' };
    }
    if (approval.resume_status === 'delivered')
      return { ok: false, reason: 'resume_already_delivered' };
    return { ok: true, claim };
  }

  function completeResume(approvalId, leaseToken, receipt = {}) {
    return withLock(() => {
      const approval = project(String(approvalId));
      if (!approval) return { ok: false, reason: 'approval_not_found' };
      const lease = requireActiveLease(approval, leaseToken);
      if (!lease.ok) return lease;
      append('resume_delivered', approval.approval_id, {
        lease_token: leaseToken,
        receipt: { ...receipt, delivered_at: receipt.delivered_at || now() },
      });
      return { ok: true, approval: project(approval.approval_id) };
    });
  }

  function failResume(approvalId, leaseToken, failure = {}) {
    return withLock(() => {
      const approval = project(String(approvalId));
      if (!approval) return { ok: false, reason: 'approval_not_found' };
      const lease = requireActiveLease(approval, leaseToken);
      if (!lease.ok) return lease;
      append('resume_failed', approval.approval_id, {
        lease_token: leaseToken,
        failure: {
          reason: String(failure.reason || 'origin delivery failed').slice(0, 1000),
          retryable: failure.retryable !== false,
        },
      });
      return { ok: true, approval: project(approval.approval_id) };
    });
  }

  function listPendingResumes() {
    const allEvents = events();
    const ids = [
      ...new Set(
        allEvents.filter((row) => row.type === 'approval_opened').map((row) => row.approval_id),
      ),
    ];
    return ids
      .map((id) => project(id, allEvents))
      .filter((approval) => approval?.resolution && approval.resume_status === 'queued')
      .map((approval) => ({ approval, resolution: approval.resolution }));
  }

  function listPendingApprovals() {
    const allEvents = events();
    const ids = [
      ...new Set(
        allEvents.filter((row) => row.type === 'approval_opened').map((row) => row.approval_id),
      ),
    ];
    return ids
      .map((id) => project(id, allEvents))
      .filter((approval) => approval?.status === 'pending');
  }

  return {
    bindTelegramPrompt,
    claimResume,
    completeResume,
    failResume,
    file,
    get: (approvalId) => project(String(approvalId)),
    listPendingApprovals,
    listPendingResumes,
    open,
    parseOwnerReply,
    readEvents: events,
    resolveOwnerReply,
  };
}

module.exports = {
  DEFAULT_RESUME_LEASE_MS,
  DEFAULT_TTL_MS,
  EVENT_SCHEMA,
  SCHEMA,
  createOwnerApprovalStore,
  normalizeOrigin,
  originConsumer,
  originLocator,
  parseOwnerReply,
};
