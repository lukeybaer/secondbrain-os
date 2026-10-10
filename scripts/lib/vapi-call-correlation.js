'use strict';

const crypto = require('node:crypto');
const contract = require('./vapi-call-correlation-contract.json');

const VAPI_CALL_ID_HEADER = contract.callIdHeader;
const VAPI_CALL_ID_TEMPLATE = contract.callIdTemplate;
const VAPI_MODEL_AUTH_HEADER = contract.modelAuthHeader;
const VAPI_SUBSCRIPTION_VOICE_MODEL = contract.voiceModel;
const VAPI_SUBSCRIPTION_VOICE_PREFLIGHT_MODEL = contract.voicePreflightModel;
const VAPI_CALL_AUDIENCE_PREFIX = 'AMY_CALL_AUDIENCE=';
const VAPI_CALL_AUDIENCES = new Set(['principal', 'outside_world']);
const VAPI_CALL_TOOLS_PREFIX = 'AMY_CALL_TOOLS=';

function normalizeVapiCallId(value) {
  const candidate = String(value || '').trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidate,
    )
  ) {
    return '';
  }
  return candidate;
}

function callIdFromHeaders(headers = {}) {
  const key = Object.keys(headers || {}).find(
    (candidate) => candidate.toLowerCase() === VAPI_CALL_ID_HEADER,
  );
  return normalizeVapiCallId(key ? headers[key] : '');
}

function relayVapiCorrelationHeaders(headers = {}) {
  const callId = callIdFromHeaders(headers);
  return callId ? { [VAPI_CALL_ID_HEADER]: callId } : {};
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function systemMessageCallIdStatus(openaiBody = {}) {
  const systemTexts = (Array.isArray(openaiBody?.messages) ? openaiBody.messages : [])
    .filter((message) => message?.role === 'system')
    .map(messageText);
  const markerCount = systemTexts.reduce(
    (count, text) => count + [...text.matchAll(/(?:^|\r?\n)AMY_CALL_ID=([^\r\n]*)/g)].length,
    0,
  );
  const markedMessages = systemTexts.filter((text) => text.startsWith('AMY_CALL_ID='));
  if (markerCount !== 1 || markedMessages.length !== 1) {
    return { callId: '', markerCount };
  }
  const firstLine = markedMessages[0].split(/\r?\n/, 1)[0];
  return {
    callId: normalizeVapiCallId(firstLine.slice('AMY_CALL_ID='.length)),
    markerCount,
  };
}

// The custom-LLM endpoint authenticates Vapi before it reaches this parser.
// Once the single correlation marker is valid, the one marked system message
// is the broker's call contract (purpose, IVR plan, audience, and tool policy),
// not caller transcript.  Keep that authority separate from the transcript
// when the isolated decision client is built.  Do not accept a second system
// message merely because it has the right role: it could be an interpolated
// caller field and it has no correlation binding.
function trustedSystemContext(openaiBody = {}, systemCallId = '') {
  const marker = `AMY_CALL_ID=${normalizeVapiCallId(systemCallId)}`;
  if (!marker || marker === 'AMY_CALL_ID=') return '';
  const marked = (Array.isArray(openaiBody?.messages) ? openaiBody.messages : [])
    .filter((message) => message?.role === 'system')
    .map(messageText)
    .filter((text) => text.startsWith(marker));
  return marked.length === 1 ? marked[0].slice(0, 24 * 1024) : '';
}

function callIdFromSystemMessage(openaiBody = {}) {
  return systemMessageCallIdStatus(openaiBody).callId;
}

function normalizeVapiCallAudience(value) {
  const candidate = String(value || '').trim().toLowerCase();
  return VAPI_CALL_AUDIENCES.has(candidate) ? candidate : 'outside_world';
}

// Audience is security-relevant because only a verified principal may hear
// the proxy's dead-air cover. Read exactly one fixed marker from system-role
// content. Caller/user text, duplicates, conflicts, and missing markers all
// fail safe to outside-world treatment.
function callAudienceFromSystemMessages(openaiBody = {}) {
  const matches = [];
  for (const message of Array.isArray(openaiBody?.messages) ? openaiBody.messages : []) {
    if (message?.role !== 'system') continue;
    const text = messageText(message);
    for (const match of text.matchAll(/(?:^|\r?\n)AMY_CALL_AUDIENCE=([^\r\n]*)/g)) {
      matches.push(String(match[1] || '').trim().toLowerCase());
    }
  }
  if (matches.length !== 1 || !VAPI_CALL_AUDIENCES.has(matches[0])) return 'outside_world';
  return matches[0];
}

function withVapiCallAudienceMarker(prompt = '', audience = 'outside_world') {
  const marker = `${VAPI_CALL_AUDIENCE_PREFIX}${normalizeVapiCallAudience(audience)}`;
  const lines = String(prompt || '').split(/\r?\n/);
  const alreadyMarked = lines[0]?.trim() === marker;
  const withoutMarkers = (alreadyMarked ? lines.slice(1) : lines)
    .map((line) =>
      /^\s*AMY_CALL_AUDIENCE=/.test(line)
        ? '[call-audience-like prompt line removed]'
        : line,
    )
    .join('\n')
    .replace(/^\n+/, '');
  return `${marker}${withoutMarkers ? `\n${withoutMarkers}` : ''}`;
}

// Vapi merges the persisted assistant's tools into a call even when
// assistantOverrides.model.tools narrows them, so a brokered outside-world
// call reached the model with twenty owner tools and the model went silent on
// a voicemail greeting (Vendor call 01a1118c, 2026-10-06). The broker
// therefore states its tool allowlist inside the authenticated call contract
// and the custom-LLM endpoint enforces it before inference.
function withVapiCallToolsMarker(prompt = '', toolNames = []) {
  const names = [...new Set(toolNames.map((name) => String(name || '').trim()))].filter((name) =>
    /^[A-Za-z0-9_-]+$/.test(name),
  );
  const body = String(prompt || '')
    .split(/\r?\n/)
    .map((line) =>
      /^\s*AMY_CALL_TOOLS=/.test(line) ? '[call-tools-like prompt line removed]' : line,
    )
    .join('\n');
  return `${VAPI_CALL_TOOLS_PREFIX}${names.join(',')}${body ? `\n${body}` : ''}`;
}

// null means the contract declares no allowlist (inbound assistant calls keep
// their configured tools). Duplicate or conflicting markers fail closed to no
// tools.
function callToolAllowlist(trustedContext = '') {
  const markers = [...String(trustedContext || '').matchAll(/(?:^|\r?\n)AMY_CALL_TOOLS=([^\r\n]*)/g)];
  if (!markers.length) return null;
  if (markers.length > 1) return new Set();
  return new Set(
    markers[0][1]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

function toolName(tool) {
  if (tool?.type === 'dtmf') return 'dtmf';
  return tool?.type === 'function' ? String(tool.function?.name || '') : '';
}

function restrictToolsToCallContract(openaiBody = {}, trustedContext = '') {
  const allowlist = callToolAllowlist(trustedContext);
  const tools = Array.isArray(openaiBody?.tools) ? openaiBody.tools : [];
  if (!allowlist) return { body: openaiBody, removed: 0 };
  const kept = tools.filter((tool) => allowlist.has(toolName(tool)));
  const removed = tools.length - kept.length;
  if (!removed) return { body: openaiBody, removed: 0 };
  const body = { ...openaiBody, tools: kept };
  const choice = openaiBody?.tool_choice?.function?.name;
  if (!kept.length || (choice && !allowlist.has(choice))) delete body.tool_choice;
  return { body, removed };
}

function authenticatedVapiCorrelation(openaiBody = {}, headers = {}, expectedSecret = '') {
  if (!isAuthorizedVapiModelRequest(headers, expectedSecret)) {
    return { callId: '', source: 'unauthorized', headers: {} };
  }
  const headerCallId = callIdFromHeaders(headers);
  const systemStatus = systemMessageCallIdStatus(openaiBody);
  const systemCallId = systemStatus.callId;
  if (!systemCallId) {
    return {
      callId: '',
      source: systemStatus.markerCount ? 'malformed-system' : 'missing',
      headers: {},
      headerCallId,
      systemCallId: '',
      markerCount: systemStatus.markerCount,
    };
  }
  if (headerCallId && systemCallId && headerCallId !== systemCallId) {
    return {
      callId: '',
      source: 'conflict',
      headers: {},
      headerCallId,
      systemCallId,
      markerCount: systemStatus.markerCount,
    };
  }
  const callId = headerCallId || systemCallId;
  const source = headerCallId ? 'header' : systemCallId ? 'authenticated-system' : 'missing';
  return {
    callId,
    source,
    headers: callId ? { [VAPI_CALL_ID_HEADER]: callId } : {},
    headerCallId,
    systemCallId,
    markerCount: systemStatus.markerCount,
    trustedSystemContext: trustedSystemContext(openaiBody, systemCallId),
  };
}

function markerValue(callId = '', { allowUnresolvedTemplate = false } = {}) {
  const normalized = normalizeVapiCallId(callId);
  if (normalized) return normalized;
  if (allowUnresolvedTemplate) return VAPI_CALL_ID_TEMPLATE;
  throw new Error('Vapi model configuration requires a literal call correlation UUID.');
}

function withVapiCallIdMarker(prompt = '', callId = '', options = {}) {
  const lines = String(prompt || '').split(/\r?\n/);
  const marker = markerValue(callId, options);
  const alreadyMarked = lines[0]?.trim() === `AMY_CALL_ID=${marker}`;
  const withoutTemplate = (alreadyMarked ? lines.slice(1) : lines)
    .map((line) =>
      /^\s*AMY_CALL_ID=/.test(line) ? '[correlation-like prompt line removed]' : line,
    )
    .join('\n')
    .replace(/^\n+/, '');
  return `AMY_CALL_ID=${marker}${withoutTemplate ? `\n${withoutTemplate}` : ''}`;
}

function buildVapiModelHeaders(authSecret = '', callId = '', options = {}) {
  return {
    [VAPI_CALL_ID_HEADER]: markerValue(callId, options),
    ...(String(authSecret || '').trim()
      ? { [VAPI_MODEL_AUTH_HEADER]: String(authSecret).trim() }
      : {}),
  };
}

function isAuthorizedVapiModelRequest(headers = {}, expectedSecret = '') {
  const expected = String(expectedSecret || '');
  if (!expected) return false;
  const key = Object.keys(headers || {}).find(
    (candidate) => candidate.toLowerCase() === VAPI_MODEL_AUTH_HEADER,
  );
  const actual = String(key ? headers[key] : '');
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return (
    expectedBytes.length === actualBytes.length &&
    expectedBytes.length > 0 &&
    crypto.timingSafeEqual(expectedBytes, actualBytes)
  );
}

function resolveVapiLlmSecret({ env = process.env, config = {} } = {}) {
  const dedicated = String(env.VAPI_LLM_SECRET || config.vapiLlmSecret || '').trim();
  if (dedicated) return dedicated;
  if (env.VAPI_LLM_SECRET_ALLOW_WEBHOOK_FALLBACK !== '1') return '';
  return String(env.VAPI_WEBHOOK_SECRET || config.vapiWebhookSecret || '').trim();
}

module.exports = {
  VAPI_CALL_ID_HEADER,
  VAPI_CALL_ID_TEMPLATE,
  VAPI_MODEL_AUTH_HEADER,
  VAPI_SUBSCRIPTION_VOICE_MODEL,
  VAPI_SUBSCRIPTION_VOICE_PREFLIGHT_MODEL,
  authenticatedVapiCorrelation,
  buildVapiModelHeaders,
  callAudienceFromSystemMessages,
  callToolAllowlist,
  callIdFromHeaders,
  callIdFromSystemMessage,
  isAuthorizedVapiModelRequest,
  normalizeVapiCallAudience,
  normalizeVapiCallId,
  restrictToolsToCallContract,
  trustedSystemContext,
  withVapiCallToolsMarker,
  relayVapiCorrelationHeaders,
  resolveVapiLlmSecret,
  withVapiCallAudienceMarker,
  withVapiCallIdMarker,
};
