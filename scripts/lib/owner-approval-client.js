'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { desktopHttpHeaders } = require('./desktop-capability-http-auth.js');
const { originConsumer } = require('./owner-approval-store.js');

const APPROVAL_ROUTE = '/amy/desktop-capabilities/owner-approval';
const DEFAULT_REMOTE_URL =
  'https://your-api-id.execute-api.us-east-1.amazonaws.com/prod' + APPROVAL_ROUTE;

function readDesktopRelayEnv(env = process.env) {
  const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  try {
    const values = {};
    for (const line of fs
      .readFileSync(path.join(appData, 'secondbrain', 'desktop-capability-worker.env'), 'utf8')
      .split(/\r?\n/)) {
      const match = line.match(/^\s*([^#=]+)\s*=\s*(.*?)\s*$/);
      if (match) values[match[1]] = match[2];
    }
    return values;
  } catch {
    return {};
  }
}

function detectApprovalOrigin(env = process.env) {
  if (env.VAPI_CALL_ID) {
    return {
      surface: 'vapi',
      call_id: String(env.VAPI_CALL_ID),
      conversation_id: String(env.VAPI_CALL_ID),
    };
  }
  if (env.CODEX_THREAD_ID) {
    return {
      surface: 'codex',
      thread_id: String(env.CODEX_THREAD_ID),
      conversation_id: String(env.CODEX_THREAD_ID),
    };
  }
  const claudeId = env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID;
  if (claudeId) {
    return {
      surface: 'claude',
      session_id: String(claudeId),
      conversation_id: String(claudeId),
    };
  }
  const origin = { surface: String(env.AMY_SURFACE || 'prompt').toLowerCase() };
  const mappings = [
    ['AMY_CONVERSATION_ID', 'conversation_id'],
    ['AMY_SESSION_ID', 'session_id'],
    ['AMY_TASK_ID', 'task_id'],
    ['AMY_MESSAGE_ID', 'message_id'],
    ['GMAIL_THREAD_ID', 'gmail_thread_id'],
  ];
  for (const [envKey, originKey] of mappings) {
    if (env[envKey]) origin[originKey] = String(env[envKey]);
  }
  return origin;
}

function approvalClientConfig(opts = {}) {
  const env = opts.env || process.env;
  const relayEnv = opts.relayEnv || readDesktopRelayEnv(env);
  const explicitlyConfigured = Boolean(opts.remoteUrl || env.OWNER_APPROVAL_URL);
  const configured =
    opts.remoteUrl ||
    env.OWNER_APPROVAL_URL ||
    env.AMY_DESKTOP_RELAY_URL ||
    relayEnv.AMY_DESKTOP_RELAY_URL ||
    DEFAULT_REMOTE_URL;
  const url = configured.endsWith(APPROVAL_ROUTE)
    ? configured
    : `${configured.replace(/\/$/, '')}${APPROVAL_ROUTE}`;
  return {
    url,
    fallbackUrl: !explicitlyConfigured && url !== DEFAULT_REMOTE_URL ? DEFAULT_REMOTE_URL : null,
    secret:
      opts.relaySecret || env.AMY_DESKTOP_RELAY_SECRET || relayEnv.AMY_DESKTOP_RELAY_SECRET || '',
  };
}

async function postApprovalAction(body, opts = {}) {
  const { url, fallbackUrl, secret } = approvalClientConfig(opts);
  if (!secret) {
    const error = new Error('Owner approval signed relay credential is unavailable.');
    error.code = 'OWNER_APPROVAL_RELAY_UNAVAILABLE';
    throw error;
  }
  const bodyText = JSON.stringify(body);
  const urls = [...new Set([url, fallbackUrl].filter(Boolean))];
  let lastError = null;
  for (let index = 0; index < urls.length; index += 1) {
    const target = urls[index];
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(500, Number(opts.timeoutMs || 5000)),
    );
    timer.unref?.();
    try {
      const response = await (opts.fetchImpl || fetch)(target, {
        method: 'POST',
        headers: desktopHttpHeaders({ method: 'POST', path: APPROVAL_ROUTE, bodyText }, secret),
        body: bodyText,
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok || result?.ok === false) {
        const error = new Error(
          result?.error ||
            result?.reason ||
            `Owner approval endpoint returned HTTP ${response.status}.`,
        );
        error.retryable = response.status >= 500;
        throw error;
      }
      return result;
    } catch (error) {
      lastError = error;
      if (error.retryable === false || index === urls.length - 1) throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('Owner approval endpoint is unavailable.');
}

function consumerFor(origin = {}) {
  return originConsumer(origin);
}

async function requestRemoteOwnerApproval(input = {}, opts = {}) {
  const origin = input.origin || detectApprovalOrigin(opts.env || process.env);
  const approvalId = input.approval_id || `approval_${crypto.randomUUID()}`;
  const openBody = {
    action: 'open',
    ...input,
    approval_id: approvalId,
    origin,
  };
  let opened;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      opened = await postApprovalAction(openBody, opts);
      break;
    } catch (error) {
      if (attempt === 1 || error.retryable === false) throw error;
      await (opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(100);
    }
  }
  const approval = opened.approval;
  if (!opts.wait) return opened;
  const started = Date.now();
  const maxWaitMs = Math.max(1, Number(opts.maxWaitMs || 15 * 60 * 1000));
  const pollMs = Math.max(0, Number(opts.pollMs ?? 1000));
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    if (Date.now() - started > maxWaitMs) {
      return { ok: false, reason: 'approval_wait_timed_out', approval_id: approval.approval_id };
    }
    const status = await postApprovalAction(
      {
        action: 'status',
        approval_id: approval.approval_id,
      },
      opts,
    );
    if (['approved', 'denied'].includes(status.approval?.status)) {
      return postApprovalAction(
        {
          action: 'consume',
          approval_id: approval.approval_id,
          consumer: consumerFor(origin),
        },
        opts,
      );
    }
    if (status.approval?.status === 'expired') {
      return { ok: false, reason: 'approval_expired', approval_id: approval.approval_id };
    }
    await sleep(pollMs);
  }
}

module.exports = {
  APPROVAL_ROUTE,
  DEFAULT_REMOTE_URL,
  approvalClientConfig,
  consumerFor,
  detectApprovalOrigin,
  postApprovalAction,
  readDesktopRelayEnv,
  requestRemoteOwnerApproval,
};
